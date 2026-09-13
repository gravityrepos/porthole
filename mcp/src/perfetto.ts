// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Finding } from "./trace.js";

/**
 * A small set of questions asked of a system trace, and what the answers mean.
 *
 * Deliberately questions rather than a query interface. Handing an agent SQL
 * over trace_processor recreates the problem `findings` exists to solve: a
 * hundred tables, no idea which to reach for, and an answer assembled from
 * whichever guess came back non-empty. These are the questions worth asking
 * about a window Porthole has already said is interesting.
 *
 * The real value is not what they confirm but what they rule out. Porthole can
 * say a frame was late and that composition dominated it; it cannot say whether
 * the device was also starving the app of CPU, blocking it on I/O, or busy
 * compiling its own bytecode. A trace can answer all three, and an answer of
 * "no" to each is what turns a suspicion into a conclusion.
 */

/** Rows come back from trace_processor as strings, including the numbers. */
const n = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const ms = (nanos: number): number => Math.round(nanos / 1e5) / 10;

export interface Question {
  id: string;
  /** What it answers, in the words someone would use to ask it. */
  asks: string;
  /**
   * `$from`, `$to` and `$package` are substituted before the query runs.
   *
   * All three are the manual steps someone otherwise performs in the trace
   * viewer — find the bad moment, drag out the window, pick your process out
   * of the list. Porthole already knows every one of them: the window comes
   * from a finding, the package from the handshake with the device.
   */
  sql: string;
}

export const QUESTIONS: Question[] = [
  {
    id: "jank",
    asks: "which frames missed their deadline, and by how much",
    sql: `SELECT jank_type, COUNT(*) AS COUNT, MIN(dur) AS "MIN(dur)",
                 MAX(dur) AS "MAX(dur)", AVG(dur) AS "AVG(dur)"
          FROM actual_frame_timeline_slice
          JOIN process USING(upid)
          WHERE ts >= $from AND ts <= $to AND process.name = $package
          GROUP BY jank_type ORDER BY MAX(dur) DESC`,
  },
  {
    id: "thread_states",
    asks: "whether the app was running, waiting for a CPU, or blocked",
    sql: `SELECT thread.name AS thread_name, thread.is_main_thread AS is_main_thread,
                 thread_state.state AS state, thread_state.io_wait AS io_wait,
                 COUNT(*) AS COUNT, SUM(thread_state.dur) AS "SUM(dur)"
          FROM thread_state
          JOIN thread USING(utid)
          JOIN process USING(upid)
          WHERE thread_state.ts >= $from AND thread_state.ts <= $to
            AND process.name = $package
          GROUP BY 1, 2, 3, 4 ORDER BY SUM(thread_state.dur) DESC`,
  },
  {
    id: "binder",
    asks: "which other processes the app called into, and for how long",
    // android_binder_txns lives in the standard library, not the base schema,
    // so the module has to be pulled in or the query fails to compile.
    sql: `INCLUDE PERFETTO MODULE android.binder;
          SELECT COALESCE(server_process, 'unknown') AS target,
                 COUNT(*) AS COUNT, SUM(client_dur) AS "SUM(dur)",
                 MAX(client_dur) AS "MAX(dur)"
          FROM android_binder_txns
          WHERE client_ts >= $from AND client_ts <= $to
            AND client_process = $package
          GROUP BY target ORDER BY SUM(client_dur) DESC LIMIT 20`,
  },
  {
    id: "render",
    asks: "what the render thread and the GPU were doing",
    sql: `INCLUDE PERFETTO MODULE slices.with_context;
          SELECT name, thread_name, COUNT(*) AS COUNT, SUM(dur) AS "SUM(dur)"
          FROM thread_slice
          WHERE ts >= $from AND ts <= $to
            AND process_name = $package
            AND thread_name IN ('RenderThread', 'GPU completion', 'hwuiTask0', 'hwuiTask1')
          GROUP BY 1, 2 ORDER BY SUM(dur) DESC LIMIT 30`,
  },
  {
    id: "slices",
    asks: "what the app was actually doing, by total time",
    // self_dur is not a column, though the trace viewer shows it as one: it
    // is dur minus whatever the slice's children took. Without it a parent
    // that did nothing but call two slow children looks like the slow thing.
    sql: `INCLUDE PERFETTO MODULE slices.with_context;
          SELECT s.name AS name, COUNT(*) AS COUNT, SUM(s.dur) AS "SUM(dur)",
                 SUM(
                   s.dur - COALESCE(
                     (SELECT SUM(child.dur) FROM slice AS child WHERE child.parent_id = s.id), 0
                   )
                 ) AS "SUM(self_dur)"
          FROM thread_slice AS s
          WHERE s.ts >= $from AND s.ts <= $to AND s.process_name = $package
          GROUP BY 1 ORDER BY SUM(s.dur) DESC LIMIT 200`,
  },
];

export interface Rows {
  jank?: Array<Record<string, unknown>>;
  thread_states?: Array<Record<string, unknown>>;
  binder?: Array<Record<string, unknown>>;
  render?: Array<Record<string, unknown>>;
  slices?: Array<Record<string, unknown>>;
}

/**
 * Work in the app's process that the app did not write.
 *
 * These are the ones worth naming because a developer reading their own trace
 * attributes everything in their process to their own code. ART compiling
 * bytecode is not the app being slow; it is the app being new.
 */
const NOT_YOUR_CODE: Array<{ match: RegExp; what: string; note: string }> = [
  {
    match: /^Compiling baseline|^JIT compiling|^Compile /i,
    what: "ART compiling bytecode",
    note:
      "This is a cold process compiling as it runs. It goes away once the profile is warm, " +
      "so a first run after install is not representative of what users see.",
  },
  {
    match: /^GC:|concurrent copying|^HeapTaskDaemon/i,
    what: "garbage collection",
    note: "Time here is a consequence of allocation rate, which `memory` reports.",
  },
  {
    match: /^binder transaction/i,
    what: "waiting on another process",
    note: "The time was spent in whatever was called, not in the app.",
  },
];

/**
 * Turns the rows into findings, in the same vocabulary the rest of the tools
 * use — including declining to claim causation from adjacency.
 */
export function interpret(rows: Rows): Finding[] {
  const findings: Finding[] = [];

  // --- what the frame timeline says --------------------------------------
  const missed = (rows.jank ?? []).filter((r) => /missed|jank/i.test(String(r.jank_type ?? "")));
  const worstMiss = missed.reduce((worst, r) => Math.max(worst, n(r["MAX(dur)"])), 0);
  if (missed.length > 0) {
    findings.push({
      id: "trace-frame-deadline",
      severity: "error",
      confidence: "observed",
      title: `the frame timeline recorded ${missed
        .map((r) => `${r.COUNT}× ${r.jank_type}`)
        .join(", ")}`,
      detail: `Worst frame ${ms(worstMiss)}ms. This is Android's own classification, not an inference.`,
      evidence: { worstMs: ms(worstMiss) },
    });
  }

  // --- what the scheduler says, which is mostly used to rule things out ---
  const states = rows.thread_states ?? [];
  const mainRunnable = states.filter((r) => isMainThread(r) && isRunnable(r.state));
  const mainIo = states.filter((r) => isMainThread(r) && isIoWait(r));
  const runnableMs = ms(mainRunnable.reduce((sum, r) => sum + n(r["SUM(dur)"]), 0));
  const ioMs = ms(mainIo.reduce((sum, r) => sum + n(r["SUM(dur)"]), 0));

  if (states.length > 0) {
    const starved = worstMiss > 0 && runnableMs > ms(worstMiss) * 0.2;
    findings.push({
      id: "trace-main-thread-contention",
      severity: starved ? "warning" : "note",
      confidence: "observed",
      title: starved
        ? `the main thread spent ${runnableMs}ms runnable but not scheduled`
        : `the main thread was not waiting for a CPU (${runnableMs}ms runnable)`,
      detail: starved
        ? "Something else on the device was holding the cores. The app's own work is not the whole story."
        : `And not blocked on I/O (${ioMs}ms). Whatever made it late, it was work the app itself was doing.`,
      evidence: { runnableMs, ioMs },
    });
  }

  // --- what was running, and how much of it the app did not write --------
  const slices = rows.slices ?? [];
  for (const rule of NOT_YOUR_CODE) {
    const matched = slices.filter((r) => rule.match.test(String(r.name ?? "")));
    if (matched.length === 0) continue;
    const total = ms(matched.reduce((sum, r) => sum + n(r["SUM(dur)"]), 0));
    if (total < 5) continue;
    findings.push({
      id: `trace-${rule.what.replace(/\s+/g, "-")}`,
      severity: "note",
      confidence: "observed",
      title: `${total}ms of ${rule.what} in this window`,
      detail: rule.note,
      count: matched.reduce((sum, r) => sum + n(r.COUNT), 0),
      evidence: { totalMs: total },
    });
  }

  // --- who else the app was waiting on ------------------------------------
  const binder = rows.binder ?? [];
  if (binder.length > 0) {
    const total = ms(binder.reduce((sum, r) => sum + n(r["SUM(dur)"]), 0));
    const worst = binder.reduce((a, b) => (n(b["MAX(dur)"]) > n(a["MAX(dur)"]) ? b : a));
    const worstMs = ms(n(worst["MAX(dur)"]));
    // A long single transaction is a stall in someone else's process wearing
    // the app's name; many short ones are chatter, which is a different fix.
    const blocking = worstMs >= 8;
    if (total >= 5) {
      findings.push({
        id: "trace-binder",
        severity: blocking ? "warning" : "note",
        confidence: "observed",
        title: blocking
          ? `a ${worstMs}ms call into ${worst.target} blocked the app`
          : `${total}ms across ${binder.length} process(es) the app called into`,
        detail: blocking
          ? "The time was spent in the other process, not in this one. Nothing in the app's own " +
            "code will make it faster; the call has to move off the critical path."
          : `Busiest: ${worst.target}. Short and frequent rather than blocking.`,
        count: binder.reduce((sum, r) => sum + n(r.COUNT), 0),
        evidence: { totalMs: total, worstMs, worstTarget: String(worst.target ?? "") },
      });
    }
  }

  // --- the half of the frame that is not the main thread -------------------
  const render = rows.render ?? [];
  if (render.length > 0) {
    const total = ms(render.reduce((sum, r) => sum + n(r["SUM(dur)"]), 0));
    const worst = render.reduce((a, b) => (n(b["SUM(dur)"]) > n(a["SUM(dur)"]) ? b : a));
    findings.push({
      id: "trace-render",
      severity: "note",
      confidence: "observed",
      title: `${total}ms on the render path, mostly ${worst.name}`,
      detail:
        "Work after the main thread has handed the frame over. Large numbers here point at " +
        "overdraw, an expensive shader or a big texture upload rather than at composition — " +
        "and `recompositions` will have nothing to say about any of them.",
      count: render.reduce((sum, r) => sum + n(r.COUNT), 0),
      evidence: { totalMs: total, worst: String(worst.name ?? "") },
    });
  }

  return findings.sort((a, b) => rank(b.severity) - rank(a.severity));
}

/**
 * Whether a row is the app's main thread.
 *
 * `is_main_thread` is the trace's own answer and needs no guessing, but rows
 * exported from the trace viewer carry a process name instead, so both are
 * accepted. Asking neither — which is what this did, by reading a column the
 * query never selected — makes every main-thread reading come back 0ms, and
 * 0ms runnable reads as "the scheduler was not the problem".
 */
function isMainThread(row: Record<string, unknown>): boolean {
  const flag = row.is_main_thread;
  if (flag !== undefined && flag !== null) return String(flag) === "1" || flag === true;

  const thread = String(row.thread_name ?? "");
  const process = String(row["ANY(process_name)"] ?? row.process_name ?? "");
  if (!thread || !process) return false;
  // "com.example.shop" arrives as "om.example.shop": comm is 16 bytes with a
  // terminator, so a long package name loses its leading characters.
  return process.endsWith(thread) || thread.endsWith(process);
}

/**
 * Ready to run, and not running.
 *
 * trace_processor returns the kernel's letters — R, R+ — while the trace viewer
 * spells them out. Matching only the spelled-out form meant the letters never
 * matched anything, so contention was invisible on every real trace and visible
 * only in the fixtures.
 */
function isRunnable(state: unknown): boolean {
  const value = String(state ?? "");
  return value === "R" || value === "R+" || value.startsWith("Runnable");
}

/** Blocked in the kernel on I/O: D with the io_wait flag, or the long name. */
function isIoWait(row: Record<string, unknown>): boolean {
  const state = String(row.state ?? "");
  if (/Uninterruptible Sleep \(IO\)/i.test(state)) return true;
  return state.startsWith("D") && String(row.io_wait ?? "") === "1";
}

const rank = (severity: Finding["severity"]): number =>
  severity === "error" ? 3 : severity === "warning" ? 2 : 1;


// ---------------------------------------------------------------------------
// running them
// ---------------------------------------------------------------------------

/** trace_processor_shell, if the machine happens to have one. */
export function findTraceProcessor(): string | null {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates = [
    process.env.PORTHOLE_TRACE_PROCESSOR,
    ...portholeCached(home),
    join(home, ".perfetto", "trace_processor_shell"),
    join(home, ".perfetto", "trace_processor_shell.exe"),
    "/usr/local/bin/trace_processor_shell",
  ].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * Copies `portholeTraceProcessor` put in ~/.porthole, newest version first.
 *
 * Read rather than hardcoded so the MCP server does not have to be republished
 * in lockstep with the plugin's pinned version — whatever the plugin fetched
 * last is what gets used. An explicitly set PORTHOLE_TRACE_PROCESSOR still wins,
 * and so does nothing at all: an empty or missing directory yields no candidates.
 */
function portholeCached(home: string): string[] {
  const root = join(home, ".porthole", "trace-processor");
  let versions: string[];
  try {
    versions = readdirSync(root);
  } catch {
    return [];
  }
  return versions
    .sort(byVersionDescending)
    .flatMap((v) => [
      join(root, v, "trace_processor_shell"),
      join(root, v, "trace_processor_shell.exe"),
    ]);
}

/** v58.2 above v58.1 above v9.0 — numerically, so v10 does not sort under v9. */
function byVersionDescending(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [ax, bx] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const diff = (bx[i] ?? 0) - (ax[i] ?? 0);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
  }
  return b.localeCompare(a);
}

/**
 * The one line of trace_processor's stderr worth repeating.
 *
 * Everything it says goes to stderr, most of it progress — load percentages and
 * timestamped `file.cc:NN` chatter. Taking the first line reported "Loading
 * trace: 0.00 MB" as the reason a question failed, which is not a reason.
 */
function why(stderr: string | undefined, error: Error | undefined): string {
  const lines = (stderr ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[\d.]+\]\s+\S+?\.cc:\d+\s*/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("Loading trace:"));
  const complaint = lines.find((l) => /error|unable|no such|syntax|failed/i.test(l));
  return (complaint ?? lines[lines.length - 1] ?? error?.message ?? "failed").slice(0, 200);
}

/**
 * trace_processor prints CSV, not TSV.
 *
 * Splitting on tabs produced exactly one column per row whose key was the
 * entire header line, and every reading of it came back zero — which looked
 * like a quiet app rather than a parser that had never worked. The unit tests
 * did not catch it because they run on JSON exported from the trace viewer,
 * which is the right data in the wrong shape.
 */
export function parseRows(stdout: string): Array<Record<string, unknown>> {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(header.map((key, i) => [key, cells[i] ?? null]));
  });
}

/**
 * One CSV row, tolerating trace_processor's quoting.
 *
 * It does not double the quotes inside a quoted field — `he said "hi"` comes
 * out as `"he said "hi""` — so a strict reader either fails or truncates. What
 * is unambiguous is where a field ends: at a quote followed by a comma, or a
 * quote at the end of the line. Everything between is the value.
 */
function parseCsvLine(line: string): Array<string | null> {
  const cells: Array<string | null> = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let end = i + 1;
      while (end < line.length && !(line[end] === '"' && (end === line.length - 1 || line[end + 1] === ","))) {
        end++;
      }
      const value = line.slice(i + 1, end);
      // trace_processor writes SQL NULL as the literal [NULL].
      cells.push(value === "[NULL]" ? null : value);
      i = end + 2;
    } else {
      const comma = line.indexOf(",", i);
      const end = comma === -1 ? line.length : comma;
      cells.push(line.slice(i, end));
      i = end + 1;
    }
    if (i > line.length) break;
  }
  return cells;
}

export interface AskResult {
  findings: Finding[];
  /** Questions that could not be answered, and why. Never silently dropped. */
  unanswered: string[];
}

/**
 * Puts the three questions to a trace, scoped to one window and one process.
 *
 * Substitution rather than bound parameters because trace_processor's shell
 * takes a file of SQL and no bindings. The package is the only string that
 * reaches it and it is quoted here; the bounds are numbers by the time they
 * arrive.
 */
export function askTrace(options: {
  binary: string;
  trace: string;
  packageName: string;
  fromNs: number;
  toNs: number;
}): AskResult {
  const rows: Rows = {};
  const unanswered: string[] = [];

  for (const question of QUESTIONS) {
    const sql = question.sql
      .replace(/\$from/g, String(Math.round(options.fromNs)))
      .replace(/\$to/g, String(Math.round(options.toNs)))
      .replace(/\$package/g, `'${options.packageName.replace(/'/g, "''")}'`);

    // `query -f -` and not `-q /dev/stdin`: the latter is read by reopening
    // /proc/self/fd/0, which does not exist on Windows, so every question came
    // back unanswered there while looking like a problem with the SQL.
    const result = spawnSync(options.binary, ["query", "-f", "-", options.trace], {
      input: sql,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });

    if (result.status !== 0) {
      unanswered.push(`${question.asks} — ${why(result.stderr, result.error)}`);
      continue;
    }
    (rows as Record<string, unknown>)[question.id] = parseRows(result.stdout);
  }

  return { findings: interpret(rows), unanswered };
}
