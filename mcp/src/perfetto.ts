// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { resolveProjectRoot } from "./adb.js";
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

/**
 * GRA-113: which of these questions can carry a `window` on the findings they
 * produce, versus which can only ever be `spanning`.
 *
 * `jank`, `binder`, `render`, `slices`, `startup` and `monitor_contention`
 * group real, individually-timestamped occurrences — a slice, a binder
 * transaction, a frame's own deadline record, a startup, a lock contention
 * event — so `MIN(ts)`/`MAX(ts)` alongside their existing `GROUP BY` is the
 * envelope those occurrences actually happened in, not an invented one. They
 * are **point-placeable**, and their SQL below carries those two columns
 * through to `interpret()`.
 *
 * `thread_states` and `cpu` (GRA-61's merged 8+9) are different in kind, not
 * just missing a column: both answer "how much of the window did [the main
 * thread / some core] spend doing X", which is a duration summed across
 * however many disjoint stretches the scheduler visited that state — there is
 * no `ts` a single row could add that would mean anything, because the row is
 * not about one occurrence. This is the ticket's own example of a finding
 * that must never be drawn as a point, and every finding `interpret()`
 * derives from either one (`trace-main-thread-contention`, `trace-cpu-placement`)
 * is unconditionally **spanning**.
 */
export const QUESTIONS: Question[] = [
  {
    id: "jank",
    asks: "which frames missed their deadline, and by how much",
    sql: `SELECT jank_type, COUNT(*) AS COUNT, MIN(dur) AS "MIN(dur)",
                 MAX(dur) AS "MAX(dur)", AVG(dur) AS "AVG(dur)",
                 MIN(ts) AS "MIN(ts)", MAX(ts) AS "MAX(ts)"
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
                 MAX(client_dur) AS "MAX(dur)",
                 MIN(client_ts) AS "MIN(ts)", MAX(client_ts) AS "MAX(ts)"
          FROM android_binder_txns
          WHERE client_ts >= $from AND client_ts <= $to
            AND client_process = $package
          GROUP BY target ORDER BY SUM(client_dur) DESC LIMIT 20`,
  },
  {
    id: "render",
    asks: "what the render thread and the GPU were doing",
    sql: `INCLUDE PERFETTO MODULE slices.with_context;
          SELECT name, thread_name, COUNT(*) AS COUNT, SUM(dur) AS "SUM(dur)",
                 MIN(ts) AS "MIN(ts)", MAX(ts) AS "MAX(ts)"
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
                 ) AS "SUM(self_dur)",
                 MIN(s.ts) AS "MIN(ts)", MAX(s.ts) AS "MAX(ts)"
          FROM thread_slice AS s
          WHERE s.ts >= $from AND s.ts <= $to AND s.process_name = $package
          GROUP BY 1 ORDER BY SUM(s.dur) DESC LIMIT 200`,
  },
  {
    id: "startup",
    asks: "what slowed the app's own startup, and by how much",
    // android.startup.startups gives launch type and duration;
    // android.startup.startup_breakdowns adds android_startup_opinionated_breakdown,
    // the platform's own attribution of a startup's time to a reason — binder,
    // monitor contention, GC, dex opening, bindApplication and the rest — so this
    // question does not have to reinvent that classification from raw slices.
    // Both modules exist at v58.2 (checked directly against the pinned binary
    // and the stdlib source for this tag before writing this query); no pin
    // bump needed.
    //
    // Window filter is overlap, not containment: a startup can run for
    // seconds, well past a window drawn tight around the one slow phase of
    // it (a bindApplication stall, say), so `ts >= $from AND ts <= $to` —
    // every other question's convention — would miss the startup whose
    // reason is exactly what the window was drawn around.
    sql: `INCLUDE PERFETTO MODULE android.startup.startups;
          INCLUDE PERFETTO MODULE android.startup.startup_breakdowns;
          SELECT startup.startup_id AS startup_id, startup.startup_type AS startup_type,
                 startup.dur AS dur, startup.ts AS "MIN(ts)", startup.ts + startup.dur AS "MAX(ts)",
                 b.reason AS reason, SUM(b.dur) AS reason_dur
          FROM android_startups AS startup
          LEFT JOIN android_startup_opinionated_breakdown AS b USING(startup_id)
          WHERE startup.ts <= $to AND (startup.ts + startup.dur) >= $from
            AND startup.package = $package
          GROUP BY startup.startup_id, startup.startup_type, startup.dur, startup.ts, reason
          ORDER BY startup.ts, reason_dur DESC`,
  },
  {
    id: "monitor_contention",
    asks: "which lock contention blocked the main thread, and who was holding it",
    // android_monitor_contention needs the `dalvik` category, which
    // systrace.ts's DEFAULT_CATEGORIES already enables — nothing to change
    // there for this question to have data to read.
    sql: `INCLUDE PERFETTO MODULE android.monitor_contention;
          SELECT blocking_method, short_blocking_method, blocked_method, short_blocked_method,
                 blocking_thread_name, blocked_thread_name, is_blocking_thread_main,
                 is_blocked_thread_main, waiter_count, dur AS dur,
                 ts AS "MIN(ts)", ts + dur AS "MAX(ts)"
          FROM android_monitor_contention
          WHERE process_name = $package AND ts >= $from AND ts <= $to
          ORDER BY dur DESC LIMIT 20`,
  },
  {
    id: "cpu",
    asks: "where the main thread actually ran, and who else wanted the same cores",
    // GRA-61's questions 8 and 9, merged by the EM into one query over the
    // same sched window rather than two: where the main thread ran (core,
    // cluster, frequency) and who else was using those same cores are the
    // same evidence read two ways, and a merged answer is what lets
    // `interpret()` gate the whole thing on one property instead of two
    // findings that can disagree.
    //
    // No MIN(ts)/MAX(ts): like `thread_states`, every row here is a sum
    // across however many disjoint scheduler intervals the main thread (or
    // someone else) visited a core in this window, not one occurrence — so
    // it is unconditionally `spanning`, never point-placed.
    //
    // `kind` discriminates the two halves inside one result set rather than
    // running two queries: 'main_thread' rows (one per core the main thread
    // actually ran on, with its cluster type and a duration-weighted average
    // frequency alongside that core's own max) and 'other' rows (sched time
    // other processes spent on exactly those same cores, the cores the app
    // itself wanted). A row's unused columns come back NULL rather than the
    // shape splitting into two questions with their own ids.
    //
    // The frequency reading is deliberately approximate: it takes the
    // frequency sample in force at the *start* of each Running interval
    // (the most recent cpu_frequency_counters row at or before it, on the
    // same ucpu) rather than a true interval intersection, which needs
    // machinery (`intervals.intersect`'s macros) this query does not pull
    // in. A core does not change frequency inside a single scheduler
    // timeslice often enough for the difference to matter at the
    // millisecond durations these windows cover.
    sql: `INCLUDE PERFETTO MODULE linux.cpu.frequency;
          INCLUDE PERFETTO MODULE android.cpu.cluster_type;
          WITH main_utid AS (
            SELECT thread.utid AS utid
            FROM thread JOIN process USING(upid)
            WHERE process.name = $package AND thread.is_main_thread
          ),
          main_running AS (
            SELECT thread_state.ts AS ts, thread_state.dur AS dur,
                   thread_state.ucpu AS ucpu, thread_state.cpu AS cpu
            FROM thread_state
            JOIN main_utid USING(utid)
            WHERE thread_state.state = 'Running'
              AND thread_state.ts >= $from AND thread_state.ts <= $to
          ),
          main_running_freq AS (
            SELECT mr.cpu AS cpu, mr.ucpu AS ucpu, mr.dur AS dur,
                   (SELECT freq FROM cpu_frequency_counters AS f
                    WHERE f.ucpu = mr.ucpu AND f.ts <= mr.ts
                    ORDER BY f.ts DESC LIMIT 1) AS freq
            FROM main_running AS mr
          ),
          cpu_max_freq AS (
            SELECT ucpu, MAX(freq) AS max_freq FROM cpu_frequency_counters GROUP BY ucpu
          ),
          main_by_cpu AS (
            SELECT mrf.cpu AS core, cm.cluster_type AS cluster_type,
                   SUM(mrf.dur) AS dur,
                   -- 61-A: an interval with no frequency sample in force at its
                   -- start is unknown, not 0Hz. CASE with no ELSE is NULL when
                   -- unmatched, and SUM ignores NULL inputs, so an unsampled
                   -- interval's dur drops out of both the numerator and the
                   -- denominator together rather than surviving in the
                   -- denominator against a zeroed numerator (which is what
                   -- COALESCE(mrf.freq, 0) did, and how a 200ms interval with
                   -- no sample read as "0% of max frequency" instead of unknown).
                   -- A core with zero sampled intervals gets NULL/NULL — SQL
                   -- NULL, same as the pre-existing all-null case.
                   SUM(CASE WHEN mrf.freq IS NOT NULL THEN mrf.dur * mrf.freq END)
                     / NULLIF(SUM(CASE WHEN mrf.freq IS NOT NULL THEN mrf.dur END), 0) AS avg_freq,
                   mf.max_freq AS max_freq
            FROM main_running_freq AS mrf
            LEFT JOIN android_cpu_cluster_mapping AS cm ON cm.ucpu = mrf.ucpu
            LEFT JOIN cpu_max_freq AS mf ON mf.ucpu = mrf.ucpu
            GROUP BY mrf.cpu, cm.cluster_type, mf.max_freq
          ),
          wanted_cpus AS (SELECT DISTINCT cpu FROM main_running),
          other AS (
            SELECT process.name AS process_name, SUM(sched.dur) AS dur, COUNT(*) AS COUNT
            FROM sched
            JOIN thread USING(utid)
            LEFT JOIN process USING(upid)
            WHERE sched.cpu IN (SELECT cpu FROM wanted_cpus)
              AND sched.ts >= $from AND sched.ts <= $to
              AND (process.name IS NULL OR process.name != $package)
              AND NOT COALESCE(thread.is_idle, 0)
            GROUP BY process.name
            ORDER BY dur DESC LIMIT 10
          )
          SELECT 'main_thread' AS kind, core, cluster_type, dur, avg_freq, max_freq,
                 NULL AS process_name, NULL AS COUNT
          FROM main_by_cpu
          UNION ALL
          SELECT 'other' AS kind, NULL AS core, NULL AS cluster_type, dur,
                 NULL AS avg_freq, NULL AS max_freq, process_name, COUNT
          FROM other
          ORDER BY kind, dur DESC`,
  },
];

/** Every valid [Question] id, for validating an `ask` filter against. */
export const QUESTION_IDS: string[] = QUESTIONS.map((q) => q.id);

export interface Rows {
  jank?: Array<Record<string, unknown>>;
  thread_states?: Array<Record<string, unknown>>;
  binder?: Array<Record<string, unknown>>;
  render?: Array<Record<string, unknown>>;
  slices?: Array<Record<string, unknown>>;
  startup?: Array<Record<string, unknown>>;
  monitor_contention?: Array<Record<string, unknown>>;
  cpu?: Array<Record<string, unknown>>;
}

/** One line per question, `id — asks`, for a tool description that cannot drift from QUESTIONS. */
export function questionsDescription(): string {
  return QUESTIONS.map((q) => `\`${q.id}\` (${q.asks})`).join(", ");
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
 * `android_startup_opinionated_breakdown`'s own reason vocabulary
 * (`_startup_breakdown_reason` in the stdlib, android/startup/startup_breakdowns.sql
 * at v58.2), turned into the words a person would use — the ticket's own
 * list: binder blocking, lock contention, GC, monitor contention, dex
 * opening, bindApplication cost. A reason this map does not know about is
 * passed through unchanged rather than dropped, so a stdlib update that adds
 * one is still readable, just not yet translated.
 */
const STARTUP_REASONS: Record<string, string> = {
  binder: "binder blocking",
  monitor_contention: "monitor contention",
  art_lock_contention: "ART lock contention",
  userspace_memory_reclaim: "garbage collection",
  kernel_memory_reclaim: "kernel memory reclaim",
  mutex_contention: "mutex contention",
  dlopen: "dlopen",
  verify_class: "class verification",
  open_dex_files_from_oat: "opening dex files",
  bind_application: "bindApplication",
  activity_start: "activityStart",
  activity_resume: "activityResume",
  activity_restart: "activityRestart",
  client_transaction_executed: "client transaction dispatch",
  choreographer_do_frame: "Choreographer#doFrame",
  inflate: "layout inflation",
  resources_manager_get_resources: "resource loading",
  io: "I/O wait",
  irq: "interrupt handling",
  launch_delay: "a delay before the app's main thread picked up startup at all",
};

const describeStartupReason = (reason: string): string => STARTUP_REASONS[reason] ?? reason;

/**
 * Gates for `trace-cpu-placement` (GRA-61 questions 8+9, merged).
 *
 * All four are deliberately conservative — the acceptance criterion this
 * exists to satisfy is silence on a trace from an idle device on a desk,
 * plugged into power, not sensitivity on a busy one. Tuned against
 * hand-built fixture rows (see `perfetto.test.ts`'s "trace-cpu-placement"
 * describe block) standing in for both cases; no real device measurement of
 * an idle trace's own numbers was available when these were chosen (see
 * GRA-61's own final report), so treat them as a starting point a real
 * capture may need to move.
 */
// The primary "was this material" gate: an absolute floor is a fixed budget
// that means something different in a 2s window than a 60s one (QA's own
// reproduction: 40ms of little-core housekeeping is nothing in a 10s
// window, but the same 40ms was originally read as "material" regardless of
// how long the window was). Running time has to clear this share of the
// window it was asked about before anything else is even considered.
const WINDOW_FRACTION = 0.05;
// Kept as a secondary minimum once WINDOW_FRACTION is met, not the primary
// gate any more: a tiny window (a jank finding's own few hundred ms, say)
// can clear 5% with well under a millisecond of running time, which is
// still noise no matter what fraction of the window it is.
const MATERIAL_RUNNING_MS = 15;
// A core is "little" enough of the story to mention once the main thread
// spent at least this share of its running time in this window there.
const LITTLE_CORE_FRACTION = 0.3;
// Running, duration-weighted, at or below this fraction of a core's own max
// frequency counts as throttled enough to mention — little and non-little
// cores get different thresholds because they run at different fractions of
// their own max under perfectly ordinary load. A big/medium core's governor
// routinely sits around 50-60% of max under moderate, healthy work, so 0.6
// there would flag normal operation; a little core, already the low-power
// tier, has much less headroom below its own max before it is genuinely
// throttled rather than just not maxed out.
const LOW_FREQ_FRACTION_LITTLE = 0.6;
const LOW_FREQ_FRACTION_BIG = 0.4;

/**
 * boot-clock ns → device uptime ms, the direction `moment.ts`'s `fromBootMs`
 * converts in. `interpret` is pure and knows nothing about a device session
 * on its own — this is how a caller that does (`askTrace`, via `timeline.ts`,
 * which holds the live event buffer `fromBootMs` reads its `clocks` samples
 * from) hands that knowledge in. Returns null for a moment it cannot place,
 * same as `fromBootMs` itself.
 */
export type ToUptimeMs = (bootNs: number) => number | null;

/**
 * The envelope of a set of rows' own `MIN(ts)`/`MAX(ts)`, converted through
 * `toUptimeMs` — or undefined when there is nothing to place a window with:
 * no rows, rows from a question that never selected `ts` at all (the
 * `thread_states` case QUESTIONS' own comment explains), or a caller that
 * gave `interpret` no way to convert boot-clock ns in the first place. Any of
 * those is `place` below's cue to fall back to `spanning: true` — never a
 * finding with neither.
 */
function rowsWindow(
  rows: Array<Record<string, unknown>>,
  toUptimeMs: ToUptimeMs | undefined,
): Finding["window"] {
  if (!toUptimeMs || rows.length === 0) return undefined;
  const mins = rows.map((r) => r["MIN(ts)"]).filter((v) => v !== undefined && v !== null);
  const maxs = rows.map((r) => r["MAX(ts)"]).filter((v) => v !== undefined && v !== null);
  if (mins.length === 0 || maxs.length === 0) return undefined;

  const from = toUptimeMs(Math.min(...mins.map(n)));
  const to = toUptimeMs(Math.max(...maxs.map(n)));
  return from === null || to === null ? undefined : { from, to };
}

/** `window` when one could be placed, `spanning: true` when it could not — the two states GRA-113 AC1 allows, and the only two a finding may ever carry. */
function place(window: Finding["window"]): Pick<Finding, "window" | "spanning"> {
  return window ? { window } : { spanning: true };
}

/**
 * Turns the rows into findings, in the same vocabulary the rest of the tools
 * use — including declining to claim causation from adjacency.
 *
 * `toUptimeMs` is optional and, when omitted, every finding below still comes
 * out `spanning: true` rather than lacking a placement entirely: a caller
 * that has not wired up a converter (an older test fixture, `interpret`
 * exercised directly) gets an honest "cannot be placed", never a silently
 * missing field.
 *
 * `windowMs` — the width, in milliseconds, of the window `askTrace` was
 * actually asked about (`(toNs - fromNs) / 1e6`) — is likewise optional, and
 * feeds only `trace-cpu-placement`'s own gate (WINDOW_FRACTION). Omitted, on
 * the same "cannot be placed, so say nothing" principle as `toUptimeMs`: a
 * caller that cannot say how big the window was cannot say whether running
 * time was a material share of it, so that finding never fires rather than
 * guessing. `askTrace` always has this number and always passes it; only a
 * caller exercising `interpret` directly (every test in this file that
 * predates GRA-61's QA fixes) can omit it.
 */
export function interpret(rows: Rows, toUptimeMs?: ToUptimeMs, windowMs?: number): Finding[] {
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
      ...place(rowsWindow(missed, toUptimeMs)),
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
      // Always spanning — see QUESTIONS' own comment on `thread_states`.
      spanning: true,
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
      ...place(rowsWindow(matched, toUptimeMs)),
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
        // The blocking case names one target's own group of calls; chatter
        // summarises every target, so its window is the envelope of all of them.
        ...place(rowsWindow(blocking ? [worst] : binder, toUptimeMs)),
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
      ...place(rowsWindow(render, toUptimeMs)),
    });
  }

  // --- what the platform itself blames the app's startup on ----------------
  //
  // GRA-60 hook: the runtime's own startup collector places its own finding
  // (from `device`/`profile`-style events, not from a trace) in the same
  // uptime window this one is placed in. Neither knows about the other yet —
  // GRA-60 is being built in parallel and this ticket does not depend on
  // it — but both describe the same real startup, so a future change here is
  // reconciling them: at minimum, the two should never assign different
  // durations to what turns out to be the same launch, and a caller seeing
  // both should be told they agree rather than left to notice on their own.
  // `trace-startup`'s own `id` and its `evidence.durMs` are the two fields
  // that reconciliation needs to compare against.
  const startups = rows.startup ?? [];
  if (startups.length > 0) {
    const byStartup = new Map<string, Array<Record<string, unknown>>>();
    for (const row of startups) {
      const id = String(row.startup_id);
      const group = byStartup.get(id) ?? [];
      group.push(row);
      byStartup.set(id, group);
    }
    for (const group of byStartup.values()) {
      const first = group[0];
      const durMs = ms(n(first.dur));
      const reasons = group
        .filter((r) => r.reason !== null && r.reason !== undefined)
        .map((r) => ({ reason: String(r.reason), ms: ms(n(r.reason_dur)) }))
        .filter((r) => r.ms > 0)
        .sort((a, b) => b.ms - a.ms);
      const top = reasons.slice(0, 3);
      findings.push({
        id: "trace-startup",
        // A pragmatic threshold, not a platform-defined one: half a second is
        // noticeable on current hardware for any launch type. Open to
        // adjustment once GRA-60's own collector gives a second, independent
        // reading to compare it against.
        severity: durMs >= 500 ? "warning" : "note",
        confidence: "observed",
        title: `${String(first.startup_type ?? "app")} start took ${durMs}ms`,
        detail: top.length
          ? `Slowest contributors, by the platform's own attribution: ${top
              .map((r) => `${describeStartupReason(r.reason)} (${r.ms}ms)`)
              .join(", ")}.`
          : "No single reason dominated the platform's own breakdown of it.",
        count: group.length,
        evidence: {
          durMs,
          startupType: String(first.startup_type ?? ""),
          reasons: Object.fromEntries(top.map((r) => [r.reason, r.ms])),
        },
        ...place(rowsWindow(group, toUptimeMs)),
      });
    }
  }

  // --- java monitor contention that blocked the main thread -----------------
  const monitor = (rows.monitor_contention ?? []).filter(
    (r) => String(r.is_blocked_thread_main) === "1",
  );
  if (monitor.length > 0) {
    const worst = monitor.reduce((a, b) => (n(b.dur) > n(a.dur) ? b : a));
    const worstMs = ms(n(worst.dur));
    // Sub-millisecond contention on the main thread is common and not
    // actionable; the same noise floor jank's own reading tolerates.
    if (worstMs >= 1) {
      findings.push({
        id: "trace-lock-contention",
        // Matches `trace-binder`'s own 8ms threshold for "this is the story,
        // not a footnote" — both are the app's own thread waiting on
        // something else to let go of a lock or a call.
        severity: worstMs >= 8 ? "warning" : "note",
        confidence: "observed",
        title: `${monitor.length} lock contention event(s) blocked the main thread, worst ${worstMs}ms in ${
          worst.short_blocking_method ?? worst.blocking_method
        }`,
        detail:
          `${worst.short_blocked_method ?? worst.blocked_method ?? "the main thread"} waited on ` +
          `${worst.blocking_thread_name} holding the lock in ${worst.blocking_method}. The fix is ` +
          "moving the lock off the main thread's path, not making the held work faster.",
        count: monitor.length,
        evidence: {
          worstMs,
          blockingMethod: String(worst.blocking_method ?? ""),
          blockedMethod: String(worst.blocked_method ?? ""),
          blockingThread: String(worst.blocking_thread_name ?? ""),
        },
        ...place(rowsWindow(monitor, toUptimeMs)),
      });
    }
  }

  // --- where the main thread ran, and who else wanted the same cores -------
  //
  // GRA-61 questions 8+9, merged. Gated hard on purpose: an idle device on a
  // desk, plugged into power, still schedules the main thread onto a little
  // core briefly now and then, and reporting that as a finding would make
  // this noisy on the one trace it most needs to stay silent on.
  const cpu = rows.cpu ?? [];
  if (cpu.length > 0) {
    const mainRows = cpu.filter((r) => String(r.kind) === "main_thread");
    const otherRows = cpu.filter((r) => String(r.kind) === "other");
    const totalMs = ms(mainRows.reduce((sum, r) => sum + n(r.dur), 0));
    const littleRows = mainRows.filter((r) => String(r.cluster_type) === "little");
    const nonLittleRows = mainRows.filter((r) => String(r.cluster_type) !== "little");
    const littleMs = ms(littleRows.reduce((sum, r) => sum + n(r.dur), 0));
    const littleFraction = totalMs > 0 ? littleMs / totalMs : 0;

    // 61-A: a row with no frequency sample for its whole core-group
    // (`avg_freq` NULL — the SQL's own answer to "no sample was in force")
    // is unknown, not 0Hz. Folding it into the weighted average via `n()`,
    // which reads a missing value as 0, is what collapsed a 200ms reading
    // with no data at all into "ran at 0% of max frequency": the row's dur
    // still counted in the denominator against a numerator of zero. The fix
    // is exclusion, not substitution — a row with nothing to say about
    // frequency says nothing, in either the numerator or the denominator.
    const freqFractionOf = (group: Array<Record<string, unknown>>): number | null => {
      const sampled = group.filter((r) => r.avg_freq !== null && r.avg_freq !== undefined);
      if (sampled.length === 0) return null;
      const num = sampled.reduce((sum, r) => sum + n(r.dur) * n(r.avg_freq), 0);
      const denom = sampled.reduce((sum, r) => sum + n(r.dur) * n(r.max_freq), 0);
      return denom > 0 ? num / denom : null;
    };
    // 61-C: separate thresholds per core class, computed from each class's
    // own rows rather than one blended average across both — a main thread
    // split between a fast big core and a throttled little core would
    // otherwise average to a number that describes neither.
    const littleFreqFraction = freqFractionOf(littleRows);
    const nonLittleFreqFraction = freqFractionOf(nonLittleRows);
    const littleLowFreq = littleFreqFraction !== null && littleFreqFraction <= LOW_FREQ_FRACTION_LITTLE;
    const nonLittleLowFreq = nonLittleFreqFraction !== null && nonLittleFreqFraction <= LOW_FREQ_FRACTION_BIG;

    const onLittleCore = littleFraction >= LITTLE_CORE_FRACTION;
    const atLowFreq = littleLowFreq || nonLittleLowFreq;

    // 61-B: materiality is a share of the *window*, not an absolute number
    // of milliseconds — 40ms reads very differently in a 2s window than a
    // 60s one, and the absolute floor this replaced could not tell the two
    // apart. `windowMs` omitted (a caller exercising `interpret` directly,
    // without going through `askTrace`) means this cannot be assessed, so it
    // is treated the same as failing it: this finding stays silent rather
    // than falling back to a guess. MATERIAL_RUNNING_MS survives as a
    // secondary floor once the fraction is cleared, for the degenerate case
    // of a window small enough that a few hundred microseconds clears 5%.
    const windowFraction = windowMs !== undefined && windowMs > 0 ? totalMs / windowMs : null;
    const material =
      windowFraction !== null && windowFraction >= WINDOW_FRACTION && totalMs >= MATERIAL_RUNNING_MS;

    if (material && (onLittleCore || atLowFreq)) {
      const pct = (fraction: number | null) => (fraction === null ? null : Math.round(fraction * 100));
      const littlePct = Math.round(littleFraction * 100);
      // Whichever frequency reading actually triggered the gate is the one
      // worth naming; a fraction that never crossed its own threshold is not
      // why this finding exists, whatever number it happens to hold.
      const freqPct = nonLittleLowFreq ? pct(nonLittleFreqFraction) : littleLowFreq ? pct(littleFreqFraction) : null;
      const title =
        onLittleCore && atLowFreq
          ? `the main thread ran on a little core for ${littleMs}ms of this window, averaging ${freqPct}% of max frequency`
          : onLittleCore
            ? `the main thread spent ${littleMs}ms (${littlePct}%) of this window on a little core`
            : `the main thread ran at ${freqPct}% of max frequency for ${totalMs}ms of this window`;

      const worstOther =
        otherRows.length > 0 ? otherRows.reduce((a, b) => (n(b.dur) > n(a.dur) ? b : a)) : undefined;
      const otherTotalMs = ms(otherRows.reduce((sum, r) => sum + n(r.dur), 0));

      findings.push({
        id: "trace-cpu-placement",
        severity: "note",
        // Co-occurrence, not causation: this says where the main thread ran
        // during a window Porthole already flagged, not that the placement
        // is why. `confidence` says so structurally so a report cannot blur
        // the two the way a plain "observed" would.
        confidence: "correlated",
        title,
        detail: worstOther
          ? `This does not by itself explain the window's own finding — offered as another candidate, ` +
            `not a conclusion. Busiest other process on the same cores: ${worstOther.process_name} ` +
            `(${ms(n(worstOther.dur))}ms across ${n(worstOther.COUNT)} slice(s)).`
          : "This does not by itself explain the window's own finding — offered as another candidate, " +
            "not a conclusion. Nothing else was contending for the same cores in this window.",
        count: otherRows.reduce((sum, r) => sum + n(r.COUNT), 0),
        evidence: {
          totalMs,
          littleMs,
          littleFraction,
          littleFreqFraction,
          nonLittleFreqFraction,
          windowFraction,
          otherTotalMs,
          worstOtherProcess: worstOther ? String(worstOther.process_name ?? "") : undefined,
        },
        // Aggregate across the window's own scheduler intervals, not one
        // occurrence — same reasoning as `thread_states`. See QUESTIONS'
        // own comment.
        spanning: true,
      });
    }
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
export function why(stderr: string | undefined, error: Error | undefined): string {
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
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const rows: Array<Record<string, unknown>> = [];

  // A row is not a line. trace_processor writes an embedded newline inside
  // a quoted value literally, so a slice named across two lines arrives as
  // two lines, and reading each as its own row produced one truncated row
  // and one garbage row where there should have been one. Lines are joined
  // until the row has as many cells as the header — the one fact the stream
  // does give reliably, since every statement prints every column. That
  // leaves the single-column case ambiguous by construction (a one-cell row
  // is complete after one line whatever it contains), which is the price of
  // a writer that neither escapes quotes nor terminates rows.
  let pending: string | null = null;
  const emit = (text: string) => {
    const cells = parseCsvLine(text);
    rows.push(Object.fromEntries(header.map((key, i) => [key, cells[i] ?? null])));
  };
  for (const line of lines.slice(1)) {
    if (pending === null) {
      if (line.length === 0) continue;
      pending = line;
    } else {
      pending += "\n" + line;
    }
    if (parseCsvLine(pending).length >= header.length) {
      emit(pending);
      pending = null;
    }
  }
  if (pending !== null) emit(pending);
  return rows;
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
  /** `asks` text of every question actually put to trace_processor this call. */
  asked: string[];
  /** `asks` text of every question `ask` left out — never asked, not a failure. */
  skipped: string[];
  /**
   * How long the invocation that answered each question took, keyed by
   * question id.
   *
   * Not a per-question figure in the sense the ticket's open question
   * imagined: `trace_processor_shell` reports one "Query execution time" for
   * an entire `-q` script, not one per statement inside it (checked directly
   * against the real v58.2 binary — see GRA-61's own final report), so a
   * batch of several questions that all compile shares one number, the whole
   * invocation's wall time. What is still true and still worth reporting is
   * that every id here got its number from a real invocation that answered
   * it — a single-question `ask` (or a question that only answered after a
   * retry split it into its own smaller batch) gets an exact reading; a
   * question that answered as part of a larger batch gets that batch's own
   * total. Never fabricated by dividing one number across questions that
   * happened to share an invocation.
   */
  wallTimeMs: Record<string, number>;
}

/** Exported so tests can build a marker line without duplicating the format. */
export const MARKER_PREFIX = "porthole:";

/**
 * The text a marker statement selects: the prefix, a nonce, the question id.
 *
 * The nonce is what makes a marker unforgeable. trace_processor's CSV neither
 * escapes an embedded quote nor terminates a row, so a slice name can contain
 * a quote followed by a newline and put whatever it likes on a line of its
 * own — including the exact two lines a marker prints. A fixed marker text is
 * therefore reachable from `Trace.beginSection`: shown against the real
 * binary, where a forged pair inside one question's data re-keyed its rows as
 * the next question's answer and nothing said so. A slice name captured
 * before this process started cannot contain sixteen hex characters chosen
 * after it, which closes the whole class rather than the one shape tested.
 */
export function markerText(nonce: string, id: string): string {
  return `${MARKER_PREFIX}${nonce}:${id}`;
}

/** Sixteen hex characters, fresh per script. */
export function newNonce(): string {
  return randomBytes(8).toString("hex");
}

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
 * own block — one column literally named `marker`, one row.
 *
 * "Nothing a real question could produce by accident" turned out to be true
 * only of accidents. A value can put the marker's two lines into the stream
 * on purpose, or by the misfortune of a name containing a quote and a
 * newline, because the writer escapes neither. So the marker also carries a
 * nonce — see [markerText] — which no value in a trace recorded before this
 * call can contain.
 */
function buildScript(
  modules: string[],
  questions: HoistedQuestion[],
  packageName: string,
  fromNs: number,
  toNs: number,
  nonce: string,
): string {
  const lines: string[] = [];
  for (const module of modules) lines.push(`INCLUDE PERFETTO MODULE ${module};`);
  for (const question of questions) {
    lines.push(`SELECT '${markerText(nonce, question.id).replace(/'/g, "''")}' AS marker;`);
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
 * immediately followed by a line that is exactly the marker text for the
 * expected id — finds the next boundary correctly no matter how many blank
 * lines (or garbled pieces of a multi-line value) sit inside the block before
 * it, because no match is accepted unless both lines match exactly.
 *
 * Exact is not the same as unforgeable. Scanning every line, rather than only
 * block boundaries, means a value that contains the pair on lines of its own
 * would be accepted mid-block — and a value can, since the writer escapes
 * nothing. What stops it is the nonce in the marker text, not the scan: the
 * expected id line includes sixteen characters chosen after the trace was
 * recorded. Both the header token and the nonce-bearing id are checked;
 * dropping either check is what the `matchBatch` tests guard against.
 */
export function matchBatch(stdout: string, ids: string[], nonce: string): BatchMatch {
  const lines = stdout.split(/\r?\n/);
  const rows = new Map<string, Array<Record<string, unknown>>>();

  const isMarkerFor = (i: number, id: string): boolean => {
    if (lines[i] !== '"marker"') return false;
    return lines[i + 1] === `"${markerText(nonce, id)}"`;
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
  /**
   * How a point-placeable finding's boot-clock ns gets onto the caller's
   * uptime clock (GRA-113). Omitted, every finding `interpret` produces comes
   * back `spanning: true` instead of `window` — never neither.
   */
  toUptimeMs?: ToUptimeMs;
  /**
   * Which [QUESTIONS] to put to the trace, by id. Omitted or empty runs
   * every question, the pre-GRA-61 default — this is additive, not a
   * required narrowing. An id that is not one of [QUESTION_IDS] is reported
   * back through `unanswered`, the same place a question that failed to
   * compile lands, rather than thrown: a caller building this list from a
   * stale copy of the id set should get a readable reason, not an exception.
   */
  ask?: string[];
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
): Promise<{ rows: Rows; unanswered: string[]; wallTimeMs: Record<string, number> }> {
  let pending = questions;
  const rows: Rows = {};
  const unanswered: string[] = [];
  const wallTimeMs: Record<string, number> = {};

  while (pending.length > 0) {
    const nonce = newNonce();
    const script = buildScript(modules, pending, options.packageName, options.fromNs, options.toNs, nonce);
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

    const { rows: batchRows, answered } = matchBatch(result.stdout, pending.map((q) => q.id), nonce);
    for (const [id, questionRows] of batchRows) {
      (rows as Record<string, unknown>)[id] = questionRows;
      // See AskResult.wallTimeMs's own doc comment: every question this
      // specific invocation answered shares its one elapsedMs reading,
      // because trace_processor_shell reports one timing for the whole `-q`
      // script, not one per statement inside it.
      wallTimeMs[id] = result.elapsedMs;
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

  return { rows, unanswered, wallTimeMs };
}

/**
 * GRA-234: whether `tracePath` is actually there and readable, checked with
 * a plain `stat` before anything spends a trace_processor invocation trying
 * to load it. A path that does not exist — a typo, a trace that was since
 * deleted, a path copied from the wrong session — used to reach `askTrace`
 * anyway, where trace_processor_shell fails to load it once per question and
 * every one of [QUESTIONS] came back "unanswered" with its own copy of the
 * same underlying reason: "ask_system_trace on a path that does not exist
 * reports '8 questions failed' instead of 'no such file'". This is the check
 * that lets a caller say the one true thing instead.
 *
 * An existing, empty file is deliberately not this function's concern — it
 * still goes through the questions, and "there is nothing in it" is
 * trace_processor's own honest answer to give, not something to pre-empt
 * here.
 */
export interface TracePathCheck {
  ok: boolean;
  /** Set only when `ok` is false — one plain sentence naming the path, plus the nearest candidate under the same directory when one exists. */
  message?: string;
}

export function checkTracePath(tracePath: string): TracePathCheck {
  let stat;
  try {
    stat = statSync(tracePath);
  } catch {
    return { ok: false, message: `No such trace file: ${tracePath}.${candidateSuffix(tracePath)}` };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      message: `${tracePath} is not a file (it is a directory).${candidateSuffix(tracePath)}`,
    };
  }
  try {
    accessSync(tracePath, fsConstants.R_OK);
  } catch {
    return { ok: false, message: `${tracePath} exists but could not be read (a permissions problem).` };
  }
  return { ok: true };
}

function candidateSuffix(tracePath: string): string {
  const candidate = nearestTraceCandidate(tracePath);
  return candidate ? ` Did you mean ${candidate}?` : "";
}

/**
 * The closest `.pftrace` to `target` (a basename, not a path) sitting
 * directly in `dir`. Prefers a file whose basename shares the longest
 * leading run of characters with the one asked for, which is enough to
 * catch a stale or mistyped timestamp in either `capture_system_trace`'s or
 * `system_trace_snapshot`'s own naming family (`porthole-<stamp>.pftrace`,
 * `porthole-ring-<stamp>.pftrace`, `porthole-ring-auto-<stamp>.pftrace`)
 * without matching two files from different, unrelated captures just
 * because both end in `.pftrace`. GRA-234 QA F18: the comparison is
 * case-insensitive, same as the `.pftrace` filter just below it — a
 * mismatched case on either side used to leave a same-prefix candidate
 * unscored and fall all the way through to the mtime tiebreak instead. With
 * nothing sharing any prefix at all, falls back to the newest `.pftrace`
 * file in the directory — still a more useful answer than naming nothing.
 * Null when `dir` cannot even be listed, or holds no `.pftrace` file to
 * suggest.
 */
function nearestInDir(dir: string, target: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = entries.filter((name) => name.toLowerCase().endsWith(".pftrace"));
  if (candidates.length === 0) return null;

  const targetLower = target.toLowerCase();
  let best: { name: string; score: number } | null = null;
  for (const name of candidates) {
    const score = commonPrefixLength(targetLower, name.toLowerCase());
    if (score > 0 && (!best || score > best.score)) best = { name, score };
  }
  if (best) return join(dir, best.name);

  // Nothing shares even one leading character — the newest file is still a
  // more useful guess than none, since it is the one most likely to be what
  // a caller quoting a slightly-stale path actually meant.
  const withMtime = candidates.map((name) => {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(join(dir, name)).mtimeMs;
    } catch {
      // Removed between readdirSync and here — sorts last, not fatal.
    }
    return { name, mtimeMs };
  });
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return join(dir, withMtime[0].name);
}

/**
 * The closest thing to `tracePath` worth suggesting — [nearestInDir] over
 * `tracePath`'s own directory first, and (GRA-234 QA F17) `.porthole/traces`
 * under the project root when that directory has nothing to offer. The
 * ticket's own words are "under `.porthole/traces/`", not "wherever the
 * caller's path happened to point": a bare filename with no directory of
 * its own, or an `outputDir` that is not actually where captures land,
 * would otherwise search the wrong place (or `process.cwd()` itself) and
 * miss two real candidates sitting in the project's default trace
 * directory. Skips the second search entirely when the two directories are
 * already the same, rather than scanning it twice for the same nothing.
 */
export function nearestTraceCandidate(tracePath: string): string | null {
  const target = basename(tracePath);
  const requestedDir = dirname(resolve(tracePath));
  const direct = nearestInDir(requestedDir, target);
  if (direct) return direct;

  const fallbackDir = resolve(join(resolveProjectRoot().directory, ".porthole", "traces"));
  if (fallbackDir === requestedDir) return null;
  return nearestInDir(fallbackDir, target);
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Puts the questions to a trace — every one of [QUESTIONS], or the subset
 * `ask` names — scoped to one window and one process, in one
 * trace_processor_shell invocation rather than one per question.
 *
 * Trace loading, not querying, is what a real capture costs — the fixtures
 * in this repo are 10-16MB and the ticket that prompted this said a 120s
 * capture runs an order of magnitude bigger. The code this replaced paid
 * that load once per question, synchronously, which is the compounding
 * version of the same mistake: it also froze the one thread the rest of the
 * MCP server runs on for as long as each load took.
 *
 * Substitution rather than bound parameters, as before: trace_processor's
 * shell takes a file of SQL and no bindings. The package name is the only
 * string that reaches it and it is quoted; the window bounds are numbers by
 * the time they arrive.
 *
 * One script cannot isolate a failure by itself — confirmed against the real
 * binary, not assumed: it aborts the entire run on the first statement that
 * errors, so a naive concatenation answers zero of the questions after a
 * failing one, however many that is. That is why `runBatch` is a loop rather
 * than one spawn: a failure removes the failed question from the batch,
 * keeps whatever already answered, and reruns only the remainder. The trace
 * reloads again, but only once per failure — the common case, everything
 * asked for compiles, is still one load, and a bad question costs one extra
 * load for the rest rather than every question after it going unanswered.
 *
 * A timeout is a different kind of event and is handled differently on
 * purpose: it does not mean one question was bad, it means trace_processor
 * itself is wedged, and rerunning the remainder would just wedge again. So a
 * timeout ends the whole call — everything still pending is reported
 * unanswered with one shared reason naming the trace and how long it
 * waited — rather than retrying into the same hang one question at a time.
 */
export interface Selection {
  /** The questions to actually put to trace_processor, in QUESTIONS' own order. */
  selected: Question[];
  /** `asks` text of every question left out by the filter — never asked, not a failure. */
  skipped: string[];
  /** Any id in `ask` that is not one of QUESTION_IDS — a typo or a stale copy of the list, not a crash. */
  unknownIds: string[];
}

/**
 * GRA-61's `ask` filter, factored out of `askTrace` so it can be tested
 * without spawning trace_processor: everything about *which* questions get
 * asked is a property of this function, not of the process underneath it.
 *
 * Empty or omitted keeps the pre-GRA-61 behaviour — every question — rather
 * than reading "asked for nothing" as "asked for none of them", which would
 * make the empty-array and omitted cases behave differently for no reason a
 * caller could predict.
 */
export function selectQuestions(ask?: string[]): Selection {
  const requested = ask?.length ? ask : QUESTION_IDS;
  return {
    selected: QUESTIONS.filter((q) => requested.includes(q.id)),
    skipped: QUESTIONS.filter((q) => !requested.includes(q.id)).map((q) => q.asks),
    unknownIds: requested.filter((id) => !QUESTION_IDS.includes(id)),
  };
}

export async function askTrace(options: AskTraceOptions): Promise<AskResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { selected, skipped, unknownIds } = selectQuestions(options.ask);

  const { modules, questions } = hoistModules(selected);
  const { rows, unanswered, wallTimeMs } = await runBatch(questions, modules, { ...options, timeoutMs }, runScript);

  const unknownReasons = unknownIds.map(
    (id) => `unknown question id "${id}" — not one of: ${QUESTION_IDS.join(", ")}`,
  );

  return {
    // 61-B: askTrace is the one caller that always knows the window it
    // queried — the whole reason `trace-cpu-placement`'s own materiality
    // gate can be a share of it rather than an absolute floor.
    findings: interpret(rows, options.toUptimeMs, (options.toNs - options.fromNs) / 1e6),
    unanswered: [...unknownReasons, ...unanswered],
    asked: selected.map((q) => q.asks),
    skipped,
    wallTimeMs,
  };
}
