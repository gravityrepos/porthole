// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
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

/** Exported so tests can build a marker line without duplicating the format. */
export const MARKER_PREFIX = "porthole:";

/**
 * How long one trace_processor invocation gets before it is presumed wedged.
 *
 * 60s is generous against the numbers actually observed: the real pinned
 * v58.2 binary loaded a 10.96MB capture in 0.27s (about 40MB/s), so even a
 * 150MB capture — the "order of magnitude bigger than 10-16MB" a 120s
 * recording was said to produce — should load in a handful of seconds.
 * Overridable per call, and by PORTHOLE_TRACE_TIMEOUT_MS for whoever needs a
 * shorter fuse without recompiling.
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.PORTHOLE_TRACE_TIMEOUT_MS) || 60_000;

export interface HoistedQuestion {
  id: string;
  asks: string;
  /** The question's SELECT, with its own `INCLUDE PERFETTO MODULE` lines removed. */
  sql: string;
}

export interface Hoisted {
  /** Deduplicated module names, in first-seen order across the question set. */
  modules: string[];
  questions: HoistedQuestion[];
}

/** A fresh copy each call: `.replace` on a shared `g` regex leaves `lastIndex` behind it. */
function includeModulePattern(): RegExp {
  return /^\s*INCLUDE\s+PERFETTO\s+MODULE\s+([\w.]+)\s*;\s*$/gim;
}

/**
 * Pulls every `INCLUDE PERFETTO MODULE` out of the questions and deduplicates
 * them, so a batched script declares each module once no matter how many
 * questions need it — today that is `slices.with_context`, wanted by both
 * `render` and `slices`.
 *
 * This is its own named, tested function rather than a side effect of
 * building the batch script because it is not incidental cleanup: GRA-61
 * (five more trace questions) and GRA-85 (a project's own question) both add
 * to the question set, and both need this exact hoisting to keep working.
 * Get it wrong here — say, by hoisting only the first module a question
 * declares — and the failure will not show up until one of those tickets
 * adds a question with two.
 */
export function hoistModules(questions: Question[]): Hoisted {
  const modules: string[] = [];
  const seen = new Set<string>();
  const hoisted = questions.map((question): HoistedQuestion => {
    let match: RegExpExecArray | null;
    const finder = includeModulePattern();
    while ((match = finder.exec(question.sql))) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        modules.push(match[1]);
      }
    }
    return { id: question.id, asks: question.asks, sql: question.sql.replace(includeModulePattern(), "").trim() };
  });
  return { modules, questions: hoisted };
}

/** `$from`/`$to`/`$package` substitution, factored out so batching and a single question share it. */
function substitute(sql: string, packageName: string, fromNs: number, toNs: number): string {
  return sql
    .replace(/\$from/g, String(Math.round(fromNs)))
    .replace(/\$to/g, String(Math.round(toNs)))
    .replace(/\$package/g, `'${packageName.replace(/'/g, "''")}'`);
}

/**
 * One script: the hoisted modules, then every question preceded by a marker
 * that names it.
 *
 * The marker is its own statement — `SELECT 'porthole:<id>' AS marker` — not
 * an extra column tacked onto the question's own SELECT. Tacking it on was
 * the tempting shortcut and the one the sentinel-row approach is named for
 * gone wrong: a column of literal values sits in the same CSV stream as
 * whatever the question actually returns, and trace_processor's CSV neither
 * escapes an embedded quote nor distinguishes a NULL from the literal text
 * `[NULL]`. A slice name containing a quote, or a row that is `[NULL]` in
 * every selected column, is indistinguishable from the marker under that
 * scheme. Giving the marker its own statement instead means it is always its
 * own block — one column literally named `marker`, one row, nothing a real
 * question could produce by accident.
 */
function buildScript(
  modules: string[],
  questions: HoistedQuestion[],
  packageName: string,
  fromNs: number,
  toNs: number,
): string {
  const lines: string[] = [];
  for (const module of modules) lines.push(`INCLUDE PERFETTO MODULE ${module};`);
  for (const question of questions) {
    lines.push(`SELECT '${MARKER_PREFIX}${question.id}' AS marker;`);
    lines.push(`${substitute(question.sql, packageName, fromNs, toNs)};`);
  }
  return lines.join("\n");
}

interface BatchMatch {
  rows: Map<string, Array<Record<string, unknown>>>;
  /** How many leading ids, in order, got a complete marker-then-data pair. */
  answered: number;
}

/**
 * Walks stdout line by line looking for marker pairs, rather than
 * pre-splitting the whole stream on blank lines.
 *
 * This used to split stdout on `/\r?\n\r?\n/` on the assumption that a blank
 * line is always a statement boundary. It usually is, but trace_processor
 * writes a field's embedded newline literally, inside the quotes, and
 * `slices`' `s.name` is a developer's own atrace section name — arbitrary
 * text reachable through `Trace.beginSection`. A value containing two
 * consecutive newlines therefore contains what looks exactly like a block
 * boundary, splitting that value's own data block in half: confirmed end to
 * end against the real binary, where it silently truncated one question's row
 * and then reported the next question as unanswered, because the leftover
 * half of the corrupted block was mistaken for its marker.
 *
 * Scanning for the literal pair — a line that is exactly `"marker"`
 * immediately followed by a line that is exactly `"porthole:<id>"` — finds
 * the next boundary correctly no matter how many blank lines (or garbled
 * pieces of a multi-line value) sit inside the block before it, because no
 * match is accepted unless both lines match exactly. That keeps the property the
 * design comment on `buildScript` argues for: the marker is its own
 * statement, so nothing a question returns can forge it, provided both the
 * header token and the id are checked — checking only one of them re-opens
 * exactly this hole (see the `matchBatch` tests guarding each check on its
 * own).
 */
export function matchBatch(stdout: string, ids: string[]): BatchMatch {
  const lines = stdout.split(/\r?\n/);
  const rows = new Map<string, Array<Record<string, unknown>>>();

  const isMarkerFor = (i: number, id: string): boolean => {
    if (lines[i] !== '"marker"') return false;
    return lines[i + 1] === `"${MARKER_PREFIX}${id}"`;
  };

  let cursor = 0;
  let questionIndex = 0;
  while (questionIndex < ids.length) {
    let markerAt = -1;
    for (let i = cursor; i < lines.length - 1; i++) {
      if (isMarkerFor(i, ids[questionIndex])) {
        markerAt = i;
        break;
      }
    }
    if (markerAt === -1) break;

    const dataStart = markerAt + 2;
    const nextId = ids[questionIndex + 1];
    let dataEnd = lines.length;
    if (nextId !== undefined) {
      for (let i = dataStart; i < lines.length - 1; i++) {
        if (isMarkerFor(i, nextId)) {
          dataEnd = i;
          break;
        }
      }
    }

    const block = lines.slice(dataStart, dataEnd).join("\n").trim();
    // A marker with nothing after it — the data block is empty — is what a
    // mid-script failure or a killed process both look like from here;
    // telling those apart is `askTrace`'s job, not this function's.
    if (block.length === 0) break;

    rows.set(ids[questionIndex], parseRows(block));
    cursor = dataEnd;
    questionIndex += 1;
  }

  return { rows, answered: questionIndex };
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
  spawnError?: Error;
}

/**
 * One trace_processor_shell invocation, run asynchronously so it cannot
 * freeze the rest of the server while the trace loads.
 *
 * `spawn`, not the `spawnSync` this replaced: the old code blocked Node's one
 * thread for the entire run, which meant nothing read the device socket,
 * nothing answered MCP, and the timeline WebSocket went silent for as long as
 * loading took — five times, once per question, with no way back from a
 * wedged binary except killing the server. The timeout below is that way
 * back: no output within `timeoutMs` and the child is killed and the caller
 * is told how long it waited and against which trace, rather than left to
 * keep waiting on something that will never answer.
 *
 * Takes `args` rather than assuming `["query", "-f", "-", trace]` itself so
 * this function can be exercised directly, against a real process, without
 * needing a trace_processor-shaped binary to do it: the tests drive it with
 * plain `cmd.exe`, which Windows will spawn directly the way `askTrace`
 * spawns the real binary, and which can be told to succeed, fail or hang on
 * demand. `askTrace` is still the only caller that decides what those args
 * actually are for a real trace.
 */
/**
 * The `maxBuffer` the `spawnSync` this replaced enforced, carried forward:
 * `spawn`'s streams have no such limit on their own, and a wedged or
 * mistaken query that never stops producing rows would otherwise grow
 * `stdout` without bound instead of failing loudly.
 */
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;

export function runScript(binary: string, args: string[], sql: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const start = Date.now();
    const child = spawn(binary, args);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const finish = (result: Omit<RunResult, "elapsedMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...result, elapsedMs: Date.now() - start });
    };

    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      if (stdout.length > MAX_STDOUT_BYTES) {
        child.kill();
        finish({
          code: null,
          stdout,
          stderr,
          timedOut: false,
          spawnError: new Error(
            `trace_processor produced more than ${MAX_STDOUT_BYTES} bytes of stdout without finishing; ` +
              "killed rather than let it grow without bound",
          ),
        });
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (!settled) stderr += chunk;
    });
    // Writing to a child that never started, or that the timer above has
    // already killed, throws EPIPE on the stream itself rather than through
    // the promise this function returns — unhandled, that crashes the whole
    // process over a condition 'close'/'error' below already report. This
    // listener's only job is to stop node treating the write as a second,
    // uncaught failure.
    child.stdin.on("error", () => {});
    child.stdin.write(sql);
    child.stdin.end();

    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
    child.on("error", (error) => finish({ code: null, stdout, stderr, timedOut, spawnError: error }));
  });
}

export interface AskTraceOptions {
  binary: string;
  trace: string;
  packageName: string;
  fromNs: number;
  toNs: number;
  /** Overrides the 60s default. A retry after a failing question gets a fresh budget, not a shared one. */
  timeoutMs?: number;
}

/** Whatever runs one script and reports back — real for production, fake in tests. */
export type RunFn = (binary: string, args: string[], sql: string, timeoutMs: number) => Promise<RunResult>;

/**
 * The batching loop itself, taking `run` as a parameter rather than calling
 * `runScript` directly.
 *
 * Everything this loop needs to prove — that a batch answers everything in
 * one call when it can, that a failing question does not take the other four
 * with it, that a timeout stops the whole call instead of retrying into the
 * same hang — is a property of this loop, not of `spawn` or of
 * trace_processor_shell. Testing it against the real binary is what caught
 * the mid-script-abort behaviour in the first place, and a couple of tests
 * still do that against a real capture. But a suite that can only prove
 * "the other four still answer" by shipping a broken query at a 77MB
 * platform-specific download is not a suite that runs everywhere the code
 * does, so `run` is swappable: production wires up the real `runScript`,
 * tests wire up a plain async function that speaks the same marker protocol
 * without spawning anything trace_processor-shaped at all.
 */
export async function runBatch(
  questions: HoistedQuestion[],
  modules: string[],
  options: { binary: string; trace: string; packageName: string; fromNs: number; toNs: number; timeoutMs: number },
  run: RunFn,
): Promise<{ rows: Rows; unanswered: string[] }> {
  let pending = questions;
  const rows: Rows = {};
  const unanswered: string[] = [];

  while (pending.length > 0) {
    const script = buildScript(modules, pending, options.packageName, options.fromNs, options.toNs);
    const result = await run(options.binary, ["query", "-f", "-", options.trace], script, options.timeoutMs);

    if (result.spawnError) {
      // The binary itself did not run — a bad path, not a bad question.
      // Every question in this batch is equally unanswered and retrying
      // would fail the same way, so say so once each and stop.
      for (const question of pending) {
        unanswered.push(`${question.asks} — could not run trace_processor: ${result.spawnError.message}`);
      }
      break;
    }

    const { rows: batchRows, answered } = matchBatch(result.stdout, pending.map((q) => q.id));
    for (const [id, questionRows] of batchRows) {
      (rows as Record<string, unknown>)[id] = questionRows;
    }

    if (answered >= pending.length) break;

    if (result.timedOut) {
      for (const question of pending.slice(answered)) {
        unanswered.push(
          `${question.asks} — trace_processor did not answer within ${result.elapsedMs}ms querying ` +
            `${options.trace}; it may be wedged, so nothing after it was retried`,
        );
      }
      break;
    }

    const failed = pending[answered];
    unanswered.push(`${failed.asks} — ${why(result.stderr, undefined)}`);
    pending = pending.slice(answered + 1);
  }

  return { rows, unanswered };
}

/**
 * Puts the five questions to a trace, scoped to one window and one process,
 * in one trace_processor_shell invocation rather than five.
 *
 * Trace loading, not querying, is what a real capture costs — the fixtures
 * in this repo are 10-16MB and the ticket that prompted this said a 120s
 * capture runs an order of magnitude bigger. The code this replaced paid
 * that load five times, once per question, synchronously, which is the
 * compounding version of the same mistake: it also froze the one thread the
 * rest of the MCP server runs on for as long as each load took.
 *
 * Substitution rather than bound parameters, as before: trace_processor's
 * shell takes a file of SQL and no bindings. The package name is the only
 * string that reaches it and it is quoted; the window bounds are numbers by
 * the time they arrive.
 *
 * One script cannot isolate a failure by itself — confirmed against the real
 * binary, not assumed: it aborts the entire run on the first statement that
 * errors, so a naive concatenation answers zero of the four questions after
 * a failing one, not four. That is why `runBatch` is a loop rather than one
 * spawn: a failure removes the failed question from the batch, keeps
 * whatever already answered, and reruns only the remainder. The trace
 * reloads again, but only once per failure — the common case, all five
 * compile, is still one load, and a bad question costs one extra load for
 * the rest rather than four lost answers.
 *
 * A timeout is a different kind of event and is handled differently on
 * purpose: it does not mean one question was bad, it means trace_processor
 * itself is wedged, and rerunning the remainder would just wedge again. So a
 * timeout ends the whole call — everything still pending is reported
 * unanswered with one shared reason naming the trace and how long it
 * waited — rather than retrying into the same hang one question at a time.
 */
export async function askTrace(options: AskTraceOptions): Promise<AskResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { modules, questions } = hoistModules(QUESTIONS);
  const { rows, unanswered } = await runBatch(questions, modules, { ...options, timeoutMs }, runScript);
  return { findings: interpret(rows), unanswered };
}
