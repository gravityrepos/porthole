// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkTracePath,
  findTraceProcessor,
  hoistModules,
  interpret,
  MARKER_PREFIX,
  markerText,
  nearestTraceCandidate,
  newNonce,
  matchBatch,
  QUESTIONS,
  QUESTION_IDS,
  questionsDescription,
  runBatch,
  runScript,
  selectQuestions,
  type HoistedQuestion,
  type Question,
  type Rows,
  type RunFn,
} from "./perfetto.js";

/**
 * The fixtures are real: three exports taken from Perfetto's own UI against a
 * capture of the sample app on a Pixel, covering a frame that missed its
 * deadline by 117ms. They are the answers trace_processor gives to the three
 * questions in this module, which makes them the right thing to interpret
 * against — the alternative is inventing rows in the shape I expect, and every
 * time I have done that today the device has disagreed.
 */

const load = (name: string): Array<Record<string, unknown>> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const rows: Rows = {
  jank: load("jank"),
  thread_states: load("thread-states"),
  slices: load("slices"),
};

describe("the questions", () => {
  it("are a fixed set, not an interface for arbitrary SQL", () => {
    // The moment this grows a `query` parameter it stops being a tool and
    // becomes a worse Perfetto, with an agent guessing at a hundred tables.
    // Six was the ceiling set when this was designed and five were in; GRA-61
    // (startup attribution, lock contention, and CPU placement + who-else-
    // wanted-the-cores, the last two merged into one) raised the ceiling to
    // ten and filled three of the new four. GRA-85 (a project's own
    // question) is expected to use the last one.
    expect(QUESTIONS.length).toBeLessThanOrEqual(10);
    expect(QUESTIONS.length).toBe(8);
    for (const q of QUESTIONS) {
      expect(q.sql).toContain("$from");
      expect(q.sql).toContain("$to");
      // Narrowed to one process, which is the step a person otherwise performs
      // by picking their app out of the list before exporting anything.
      expect(q.sql, `${q.id} would answer for the whole device`).toContain("$package");
    }
  });
});

/**
 * GRA-61's `ask` parameter. `selectQuestions` is what `askTrace` calls to
 * decide which questions to put to trace_processor at all — tested directly
 * here so the selection logic does not need a spawned process (or even a
 * fake one) to prove correct.
 */
describe("selectQuestions (GRA-61)", () => {
  it("selects every question when ask is omitted", () => {
    const { selected, skipped, unknownIds } = selectQuestions();
    expect(selected).toEqual(QUESTIONS);
    expect(skipped).toEqual([]);
    expect(unknownIds).toEqual([]);
  });

  it("selects every question when ask is an empty array, the same as omitted", () => {
    // Deliberately the same case as omitted, not "asked for nothing" — see
    // selectQuestions' own doc comment.
    const { selected } = selectQuestions([]);
    expect(selected).toEqual(QUESTIONS);
  });

  it("runs exactly one question and reports the rest skipped", () => {
    const { selected, skipped } = selectQuestions(["startup"]);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("startup");
    expect(skipped).toHaveLength(QUESTIONS.length - 1);
    const startupAsks = QUESTIONS.find((q) => q.id === "startup")!.asks;
    expect(skipped).not.toContain(startupAsks);
  });

  it("keeps QUESTIONS' own order, not the caller's ask order", () => {
    const { selected } = selectQuestions(["slices", "jank"]);
    expect(selected.map((q) => q.id)).toEqual(["jank", "slices"]);
  });

  it("reports an id that is not a real question rather than silently dropping it", () => {
    const { selected, unknownIds } = selectQuestions(["startup", "bogus"]);
    expect(selected.map((q) => q.id)).toEqual(["startup"]);
    expect(unknownIds).toEqual(["bogus"]);
  });

  it("QUESTION_IDS is exactly QUESTIONS' own ids, in order", () => {
    expect(QUESTION_IDS).toEqual(QUESTIONS.map((q) => q.id));
  });

  it("questionsDescription names every question by id, without drifting from QUESTIONS", () => {
    const description = questionsDescription();
    for (const q of QUESTIONS) {
      expect(description, `${q.id} missing from questionsDescription()`).toContain(`\`${q.id}\``);
    }
  });
});

describe("reading a real capture", () => {
  const findings = interpret(rows);

  it("reports the deadline miss as Android classified it", () => {
    const frame = findings.find((f) => f.id === "trace-frame-deadline");
    expect(frame?.title).toContain("App Deadline Missed");
    expect(frame?.evidence?.worstMs).toBe(117.3);
    // Android's own label, so it is observed rather than inferred.
    expect(frame?.confidence).toBe("observed");
  });

  it("rules out CPU starvation, which is the half Porthole cannot see", () => {
    const contention = findings.find((f) => f.id === "trace-main-thread-contention");
    // 3.08ms runnable against a 117ms miss: the app was scheduled when it
    // wanted to run, so the time went on work it chose to do.
    expect(contention?.title).toContain("not waiting for a CPU");
    expect(contention?.severity).toBe("note");
    expect(Number(contention?.evidence?.runnableMs)).toBeLessThan(5);
  });

  it("finds the main thread despite the kernel truncating its name", () => {
    // comm is 16 bytes, so "com.example.shop" arrives as "om.example.shop".
    // Matching on equality finds nothing and the tool silently concludes the
    // main thread never waited for anything.
    const contention = findings.find((f) => f.id === "trace-main-thread-contention");
    expect(contention).toBeDefined();
    expect(Number(contention?.evidence?.runnableMs)).toBeGreaterThan(0);
  });

  it("names work in the process that the app did not write", () => {
    // 86ms of ART compiling, which reads as the app being slow unless someone
    // says otherwise. It is the app being new.
    const art = findings.find((f) => f.id.includes("ART-compiling"));
    expect(art?.title).toMatch(/ART compiling bytecode/);
    expect(Number(art?.evidence?.totalMs)).toBeGreaterThan(80);
    expect(art?.detail).toMatch(/not representative/);
  });

  it("puts the error above the notes", () => {
    expect(findings[0].severity).toBe("error");
  });

  /**
   * Unlike everything above, these rows are constructed rather than exported:
   * answering them needs trace_processor, which is not installed here. The
   * shapes follow the columns the queries select, and the interpretation is
   * what is being pinned — but the SQL itself has not been run against a real
   * trace, and today has repeatedly shown that is where the surprises live.
   */
  it("separates one blocking call into another process from chatter", () => {
    const blocking = interpret({
      binder: [
        { target: "system_server", COUNT: "2", "SUM(dur)": "41000000", "MAX(dur)": "38000000" },
      ],
    });
    const found = blocking.find((f) => f.id === "trace-binder");
    expect(found?.severity).toBe("warning");
    expect(found?.title).toContain("system_server");
    expect(found?.detail).toMatch(/not in this one/);

    const chatter = interpret({
      binder: [
        { target: "system_server", COUNT: "60", "SUM(dur)": "30000000", "MAX(dur)": "900000" },
      ],
    });
    expect(chatter.find((f) => f.id === "trace-binder")?.severity).toBe("note");
  });

  it("says the render path is not something recompositions can explain", () => {
    const found = interpret({
      render: [
        { name: "flush commands", thread_name: "RenderThread", COUNT: "40", "SUM(dur)": "62000000" },
      ],
    }).find((f) => f.id === "trace-render");
    expect(found?.title).toContain("flush commands");
    expect(found?.detail).toMatch(/recompositions` will have nothing to say/);
  });

  it("stays quiet about binder chatter too small to matter", () => {
    const tiny = interpret({
      binder: [{ target: "x", COUNT: "1", "SUM(dur)": "100000", "MAX(dur)": "100000" }],
    });
    expect(tiny.find((f) => f.id === "trace-binder")).toBeUndefined();
  });

  it("claims nothing when asked about nothing", () => {
    expect(interpret({})).toEqual([]);
  });

  it("does not invent a cause from adjacency", () => {
    // Everything here is a direct reading. If a finding is ever derived by
    // putting two things next to each other it must say `correlated`.
    for (const f of findings) expect(f.confidence).toBe("observed");
  });

  // GRA-113: these fixtures are UI exports, not trace_processor's own stdout
  // (perfetto-stdout.test.ts's are), so they carry no MIN(ts)/MAX(ts) at
  // all — and interpret() here is called with no converter either. Both are
  // legitimate reasons a finding cannot be placed, and the ticket's own rule
  // is that either one degrades to `spanning: true`, never to a finding with
  // neither field.
  it("falls back to spanning when it has no ts data and no converter to place a window with", () => {
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.spanning, `${f.id} should be spanning (no ts, no converter)`).toBe(true);
      expect(f.window, `${f.id} should carry no window alongside spanning`).toBeUndefined();
    }
  });
});

describe("interpret + toUptimeMs: placing a window (GRA-113)", () => {
  // A converter that mimics fromBootMs's own arithmetic exactly (uptime =
  // bootNs/1e6 - offsetMs), so the numbers below are easy to hand-check —
  // moment.test.ts is what actually proves fromBootMs/toBootNs correct.
  const offsetMs = 5_000;
  const toUptimeMs = (bootNs: number) => bootNs / 1e6 - offsetMs;

  it("places trace-frame-deadline from the missed rows' own MIN(ts)/MAX(ts)", () => {
    const findings = interpret(
      {
        jank: [
          { jank_type: "App Deadline Missed", COUNT: "1", "MIN(dur)": "1", "MAX(dur)": "1", "AVG(dur)": "1", "MIN(ts)": "10000000", "MAX(ts)": "20000000" },
        ],
      },
      toUptimeMs,
    );
    const finding = findings.find((f) => f.id === "trace-frame-deadline");
    expect(finding?.window).toEqual({ from: 10 - offsetMs, to: 20 - offsetMs });
    expect(finding?.spanning).toBeUndefined();
  });

  it("thread_states stays spanning even with a converter available — it has no ts to place with", () => {
    const findings = interpret(
      {
        thread_states: [
          { thread_name: "main", is_main_thread: "1", state: "R", io_wait: "[NULL]", COUNT: "1", "SUM(dur)": "1000000" },
        ],
      },
      toUptimeMs,
    );
    const finding = findings.find((f) => f.id === "trace-main-thread-contention");
    expect(finding?.spanning).toBe(true);
    expect(finding?.window).toBeUndefined();
  });

  it("places the blocking-binder finding from only the blocking target's own group, not every target's", () => {
    const findings = interpret(
      {
        binder: [
          { target: "system_server", COUNT: "1", "SUM(dur)": "9000000", "MAX(dur)": "9000000", "MIN(ts)": "100000000", "MAX(ts)": "100000000" },
          { target: "chatty_process", COUNT: "50", "SUM(dur)": "5000000", "MAX(dur)": "100000", "MIN(ts)": "1000000000", "MAX(ts)": "9000000000" },
        ],
      },
      toUptimeMs,
    );
    const finding = findings.find((f) => f.id === "trace-binder");
    expect(finding?.title).toContain("system_server");
    // Only the blocking target's own instant — not widened by the chatty
    // target's much larger MIN(ts)/MAX(ts) spread.
    expect(finding?.window).toEqual({ from: 100 - offsetMs, to: 100 - offsetMs });
  });

  it("places the chatter-binder finding across every target's envelope", () => {
    const findings = interpret(
      {
        binder: [
          { target: "a", COUNT: "10", "SUM(dur)": "3000000", "MAX(dur)": "100000", "MIN(ts)": "100000000", "MAX(ts)": "200000000" },
          { target: "b", COUNT: "10", "SUM(dur)": "3000000", "MAX(dur)": "100000", "MIN(ts)": "300000000", "MAX(ts)": "400000000" },
        ],
      },
      toUptimeMs,
    );
    const finding = findings.find((f) => f.id === "trace-binder");
    expect(finding?.severity).toBe("note"); // chatter, not blocking
    expect(finding?.window).toEqual({ from: 100 - offsetMs, to: 400 - offsetMs });
  });

  it("places trace-render across every render row's envelope", () => {
    const findings = interpret(
      {
        render: [
          { name: "flush commands", thread_name: "RenderThread", COUNT: "5", "SUM(dur)": "6000000", "MIN(ts)": "50000000", "MAX(ts)": "150000000" },
        ],
      },
      toUptimeMs,
    );
    const finding = findings.find((f) => f.id === "trace-render");
    expect(finding?.window).toEqual({ from: 50 - offsetMs, to: 150 - offsetMs });
  });

  it("falls back to spanning when the converter cannot place a moment, even with real ts data present", () => {
    const cannotPlace = () => null;
    const findings = interpret(
      {
        jank: [
          { jank_type: "App Deadline Missed", COUNT: "1", "MIN(dur)": "1", "MAX(dur)": "1", "AVG(dur)": "1", "MIN(ts)": "10000000", "MAX(ts)": "20000000" },
        ],
      },
      cannotPlace,
    );
    const finding = findings.find((f) => f.id === "trace-frame-deadline");
    expect(finding?.spanning).toBe(true);
    expect(finding?.window).toBeUndefined();
  });
});

/**
 * GRA-61's `trace-startup`: hand-built rows following the columns the real
 * SQL selects (see fixtures/stdout/PROVENANCE.md for why these are
 * hand-built rather than captured — no real trace was available). What is
 * being pinned here is `interpret()`'s own logic, same as the binder/render
 * synthetic cases above.
 */
describe("interpret: trace-startup (GRA-61)", () => {
  it("names the platform's own top reasons, worst first", () => {
    const findings = interpret({
      startup: [
        { startup_id: "1", startup_type: "cold", dur: "900000000", "MIN(ts)": "1000000", "MAX(ts)": "901000000", reason: "bind_application", reason_dur: "300000000" },
        { startup_id: "1", startup_type: "cold", dur: "900000000", "MIN(ts)": "1000000", "MAX(ts)": "901000000", reason: "open_dex_files_from_oat", reason_dur: "150000000" },
      ],
    });
    const startup = findings.find((f) => f.id === "trace-startup");
    expect(startup?.title).toBe("cold start took 900ms");
    expect(startup?.severity).toBe("warning"); // >= 500ms
    expect(startup?.confidence).toBe("observed");
    expect(startup?.detail).toContain("bindApplication (300ms)");
    expect(startup?.detail).toContain("opening dex files (150ms)");
  });

  it("does not read a null reason (no breakdown data) as a zero-ms top contributor", () => {
    const findings = interpret({
      startup: [
        { startup_id: "2", startup_type: "warm", dur: "200000000", "MIN(ts)": "1000000", "MAX(ts)": "201000000", reason: null, reason_dur: null },
      ],
    });
    const startup = findings.find((f) => f.id === "trace-startup");
    expect(startup?.title).toBe("warm start took 200ms");
    expect(startup?.severity).toBe("note"); // < 500ms
    expect(startup?.detail).toBe("No single reason dominated the platform's own breakdown of it.");
  });

  it("keeps two different startups in the same window as two separate findings", () => {
    const findings = interpret({
      startup: [
        { startup_id: "1", startup_type: "cold", dur: "600000000", "MIN(ts)": "0", "MAX(ts)": "600000000", reason: null, reason_dur: null },
        { startup_id: "2", startup_type: "hot", dur: "100000000", "MIN(ts)": "1000000000", "MAX(ts)": "1100000000", reason: null, reason_dur: null },
      ],
    });
    expect(findings.filter((f) => f.id === "trace-startup")).toHaveLength(2);
  });

  it("claims nothing when asked about nothing", () => {
    expect(interpret({ startup: [] }).find((f) => f.id === "trace-startup")).toBeUndefined();
  });
});

/**
 * GRA-61's `trace-lock-contention`.
 */
describe("interpret: trace-lock-contention (GRA-61)", () => {
  const row = (overrides: Record<string, unknown>) => ({
    blocking_method: "void Foo.bar()",
    short_blocking_method: "bar",
    blocked_method: "void Baz.qux()",
    short_blocked_method: "qux",
    blocking_thread_name: "Binder:123_1",
    blocked_thread_name: "main",
    is_blocking_thread_main: "0",
    is_blocked_thread_main: "1",
    waiter_count: "1",
    dur: "9000000",
    "MIN(ts)": "1000000",
    "MAX(ts)": "10000000",
    ...overrides,
  });

  it("reports a main-thread block and names who was holding the lock", () => {
    const findings = interpret({ monitor_contention: [row({})] });
    const found = findings.find((f) => f.id === "trace-lock-contention");
    expect(found?.severity).toBe("warning"); // 9ms >= 8ms
    expect(found?.title).toContain("bar");
    expect(found?.detail).toContain("Binder:123_1");
    expect(found?.confidence).toBe("observed");
  });

  it("ignores contention that never touches the main thread", () => {
    const findings = interpret({
      monitor_contention: [row({ is_blocked_thread_main: "0" })],
    });
    expect(findings.find((f) => f.id === "trace-lock-contention")).toBeUndefined();
  });

  it("stays quiet about sub-millisecond main-thread contention", () => {
    const findings = interpret({
      monitor_contention: [row({ dur: "400000" })], // 0.4ms
    });
    expect(findings.find((f) => f.id === "trace-lock-contention")).toBeUndefined();
  });

  it("drops to a note under the 8ms blocking threshold", () => {
    const findings = interpret({
      monitor_contention: [row({ dur: "5000000" })], // 5ms
    });
    expect(findings.find((f) => f.id === "trace-lock-contention")?.severity).toBe("note");
  });
});

/**
 * GRA-61's merged `trace-cpu-placement` (questions 8+9). The acceptance
 * criterion this exists to satisfy: no finding on a trace from an idle
 * device on a desk, plugged into power. These rows stand in for that case
 * and for a busy one, both hand-built (see fixtures/stdout/PROVENANCE.md).
 *
 * QA's wave-merge pass found three defects the fixtures above did not catch,
 * all now covered directly: 61-A (a null frequency sample read as 0Hz),
 * 61-B (the materiality floor was absolute ms, not a share of the window),
 * 61-C (one frequency threshold for every core class, when big and little
 * cores run at very different fractions of their own max under ordinary
 * load).
 */
describe("interpret: trace-cpu-placement, the gate (GRA-61)", () => {
  it("stays quiet on an idle device: brief, low-duty-cycle running time on a little core", () => {
    // QA's own reproducer: 40ms of housekeeping in a 10s window — the
    // absolute floor this replaced (15ms) would have fired on this, because
    // 40ms clears an absolute floor regardless of how long the window was.
    const idle: Rows = {
      cpu: [
        { kind: "main_thread", core: "0", cluster_type: "little", dur: "40000000", avg_freq: "700000", max_freq: "1800000", process_name: null, COUNT: null },
        { kind: "other", core: null, cluster_type: null, dur: "500000", avg_freq: null, max_freq: null, process_name: "system_server", COUNT: "3" },
      ],
    };
    expect(interpret(idle, undefined, 10_000).find((f) => f.id === "trace-cpu-placement")).toBeUndefined();
  });

  it("fires on the same shape of running time once it is a material share of a shorter window", () => {
    // QA's paired case: the same kind of little-core running time, 400ms in
    // a 2s window — 20% of the window, well past WINDOW_FRACTION.
    const busy: Rows = {
      cpu: [
        { kind: "main_thread", core: "0", cluster_type: "little", dur: "400000000", avg_freq: "1500000", max_freq: "1800000", process_name: null, COUNT: null },
      ],
    };
    const finding = interpret(busy, undefined, 2_000).find((f) => f.id === "trace-cpu-placement");
    expect(finding).toBeDefined();
    expect(finding?.title).toContain("little core");
  });

  it("stays quiet without windowMs, even for rows that would otherwise clearly qualify (61-B)", () => {
    // A caller exercising interpret() directly, without going through
    // askTrace — the one place windowMs comes from. Cannot assess
    // materiality, so this must not guess.
    const wouldFire: Rows = {
      cpu: [
        { kind: "main_thread", core: "0", cluster_type: "little", dur: "500000000", avg_freq: "900000", max_freq: "1800000", process_name: null, COUNT: null },
      ],
    };
    expect(interpret(wouldFire).find((f) => f.id === "trace-cpu-placement")).toBeUndefined();
  });

  it("keeps MATERIAL_RUNNING_MS as a secondary floor once the window fraction is cleared", () => {
    // 10ms of 100ms clears WINDOW_FRACTION (10%) easily, but 10ms of actual
    // running time is still noise on its own — the floor this replaced
    // survives as a secondary check for exactly this degenerate case.
    const tinyWindow: Rows = {
      cpu: [
        { kind: "main_thread", core: "0", cluster_type: "little", dur: "10000000", avg_freq: "900000", max_freq: "1800000", process_name: null, COUNT: null },
      ],
    };
    expect(interpret(tinyWindow, undefined, 100).find((f) => f.id === "trace-cpu-placement")).toBeUndefined();
  });

  it("stays quiet when running time is material but neither on a little core nor throttled", () => {
    // A busy main thread, but on a big core near its own max frequency —
    // the gate's other half: material time alone is not sufficient.
    const fine: Rows = {
      cpu: [
        { kind: "main_thread", core: "4", cluster_type: "big", dur: "150000000", avg_freq: "2700000", max_freq: "2800000", process_name: null, COUNT: null },
      ],
    };
    expect(interpret(fine, undefined, 1_000).find((f) => f.id === "trace-cpu-placement")).toBeUndefined();
  });

  it("fires when the main thread spent a material share of the window on a little core", () => {
    const busy: Rows = {
      cpu: [
        { kind: "main_thread", core: "0", cluster_type: "little", dur: "140000000", avg_freq: "900000", max_freq: "1800000", process_name: null, COUNT: null },
        { kind: "main_thread", core: "2", cluster_type: "big", dur: "40000000", avg_freq: "2400000", max_freq: "2800000", process_name: null, COUNT: null },
        { kind: "other", core: null, cluster_type: null, dur: "95000000", avg_freq: null, max_freq: null, process_name: "system_server", COUNT: "42" },
      ],
    };
    const finding = interpret(busy, undefined, 1_000).find((f) => f.id === "trace-cpu-placement");
    expect(finding).toBeDefined();
    expect(finding?.confidence).toBe("correlated");
    expect(finding?.spanning).toBe(true);
    expect(finding?.severity).toBe("note");
    // Must not assert causation.
    expect(finding?.detail).not.toMatch(/because|caused|due to/i);
    expect(finding?.detail).toContain("does not by itself explain");
    expect(finding?.evidence?.worstOtherProcess).toBe("system_server");
  });

  it("fires when the main thread ran throttled, even on a big core", () => {
    const throttled: Rows = {
      cpu: [
        { kind: "main_thread", core: "4", cluster_type: "big", dur: "100000000", avg_freq: "800000", max_freq: "2800000", process_name: null, COUNT: null },
      ],
    };
    const finding = interpret(throttled, undefined, 1_000).find((f) => f.id === "trace-cpu-placement");
    expect(finding).toBeDefined();
    expect(finding?.title).toContain("% of max frequency");
  });

  /**
   * 61-A. Reproduces QA's exact row shape: a main_thread row with a
   * substantial dur and no frequency sample at all (avg_freq null, the
   * correct SQL answer to "nothing in cpu_frequency_counters was in force
   * before this interval started" — see main_by_cpu's own comment). Before
   * the fix, `n(null)` read as 0 and the weighted average collapsed to
   * "ran at 0% of max frequency for 200ms", which both fabricates a reading
   * nothing in the trace supports and fires the gate on it.
   */
  it("treats a fully-unsampled core as unknown frequency, not 0Hz (61-A)", () => {
    const unsampled: Rows = {
      cpu: [
        { kind: "main_thread", core: "4", cluster_type: "big", dur: "200000000", avg_freq: null, max_freq: "2800000", process_name: null, COUNT: null },
      ],
    };
    const finding = interpret(unsampled, undefined, 1_000).find((f) => f.id === "trace-cpu-placement");
    expect(finding).toBeUndefined();
  });

  /**
   * 61-C. A big core sitting at 55% of its own max is a governor doing
   * perfectly ordinary work, not a throttle reading — QA's own example of
   * the false positive the single 0.6 threshold produced. A little core at
   * the same 55% is a real throttle reading for that core class.
   */
  it("does not flag a big core at a moderate, healthy 55% of max frequency (61-C)", () => {
    const moderateBigCore: Rows = {
      cpu: [
        { kind: "main_thread", core: "4", cluster_type: "big", dur: "200000000", avg_freq: "1540000", max_freq: "2800000", process_name: null, COUNT: null },
      ],
    };
    expect(interpret(moderateBigCore, undefined, 1_000).find((f) => f.id === "trace-cpu-placement")).toBeUndefined();
  });

  it("flags a little core at the same 55% of its own max, and only via the frequency reading", () => {
    const throttledLittleCore: Rows = {
      cpu: [
        // The majority of running time on a fast big core keeps onLittleCore
        // false, so a finding here can only come from the little core's own
        // low-frequency reading — proving the per-class threshold fires
        // independently of the little-core-share gate, not alongside it.
        { kind: "main_thread", core: "4", cluster_type: "big", dur: "800000000", avg_freq: "2700000", max_freq: "2800000", process_name: null, COUNT: null },
        { kind: "main_thread", core: "0", cluster_type: "little", dur: "200000000", avg_freq: "990000", max_freq: "1800000", process_name: null, COUNT: null },
      ],
    };
    const finding = interpret(throttledLittleCore, undefined, 2_000).find((f) => f.id === "trace-cpu-placement");
    expect(finding).toBeDefined();
    expect(finding?.title).toContain("% of max frequency");
    expect(finding?.title).not.toContain("little core for"); // not the onLittleCore branch
  });

  it("names nothing else when nothing else was contending, without inventing a process", () => {
    const busyAlone: Rows = {
      cpu: [
        { kind: "main_thread", core: "0", cluster_type: "little", dur: "100000000", avg_freq: "900000", max_freq: "1800000", process_name: null, COUNT: null },
      ],
    };
    const finding = interpret(busyAlone, undefined, 1_000).find((f) => f.id === "trace-cpu-placement");
    expect(finding?.detail).toContain("Nothing else was contending");
    expect(finding?.evidence?.worstOtherProcess).toBeUndefined();
  });

  it("claims nothing when asked about nothing", () => {
    expect(interpret({ cpu: [] }, undefined, 1_000).find((f) => f.id === "trace-cpu-placement")).toBeUndefined();
  });
});

/**
 * `portholeTraceProcessor` puts the binary somewhere specific and then says
 * nothing further is needed. That promise is only kept if this function looks
 * where the task actually wrote.
 */
describe("findTraceProcessor", () => {
  let home: string;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "porthole-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.PORTHOLE_TRACE_PROCESSOR;
  });

  afterEach(() => {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  });

  const cache = (version: string, name: string) => {
    const dir = join(home, ".porthole", "trace-processor", version);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, "");
    return file;
  };

  it("finds what the Gradle task cached", () => {
    const file = cache("v58.2", "trace_processor_shell");
    expect(findTraceProcessor()).toBe(file);
  });

  it("finds the Windows binary too", () => {
    const file = cache("v58.2", "trace_processor_shell.exe");
    expect(findTraceProcessor()).toBe(file);
  });

  it("prefers the newest version numerically, not alphabetically", () => {
    // "v9.0" sorts above "v58.2" as a string, which would quietly pin every
    // session to whichever version was released first.
    cache("v9.0", "trace_processor_shell");
    const newer = cache("v58.2", "trace_processor_shell");
    expect(findTraceProcessor()).toBe(newer);
  });

  it("lets an explicit path win over the cache", () => {
    cache("v58.2", "trace_processor_shell");
    const mine = join(home, "my_trace_processor");
    writeFileSync(mine, "");
    process.env.PORTHOLE_TRACE_PROCESSOR = mine;
    expect(findTraceProcessor()).toBe(mine);
  });

  it("returns null rather than a path that is not there", () => {
    // An empty cache directory is the state right after a failed download.
    mkdirSync(join(home, ".porthole", "trace-processor", "v58.2"), { recursive: true });
    expect(findTraceProcessor()).toBeNull();
  });

  it("survives there being no cache at all", () => {
    expect(findTraceProcessor()).toBeNull();
  });
});

/**
 * GRA-234: `ask_system_trace` on a path that does not exist used to reach
 * trace_processor_shell anyway, where every one of QUESTIONS failed to load
 * it independently and came back "unanswered" — "8 question(s) failed"
 * instead of the one sentence a caller actually needed. `checkTracePath` is
 * the stat-before-load check `index.ts` now runs first; `nearestTraceCandidate`
 * is what it uses to suggest a fix rather than just naming the miss.
 */
describe("checkTracePath / nearestTraceCandidate (GRA-234)", () => {
  let dir: string;
  const savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "porthole-traces-"));
    // GRA-234 QA F17: nearestTraceCandidate now falls back to
    // `<projectRoot>/.porthole/traces` when the requested path's own
    // directory has nothing to offer. Pinning PORTHOLE_PROJECT_ROOT to this
    // test's own throwaway `dir` (whose own `.porthole/traces` subdirectory
    // is never created below, so the fallback search finds nothing there
    // either) keeps every "no candidate"/"this exact candidate" assertion
    // in this file deterministic — without it, the fallback would read
    // *this developer's own* `.porthole/traces` (this repo's own real
    // capture output, gitignored but often present in a working checkout),
    // silently flipping any of them.
    process.env.PORTHOLE_PROJECT_ROOT = dir;
  });

  afterEach(() => {
    if (savedProjectRoot === undefined) delete process.env.PORTHOLE_PROJECT_ROOT;
    else process.env.PORTHOLE_PROJECT_ROOT = savedProjectRoot;
    rmSync(dir, { recursive: true, force: true });
  });

  it("ok:true for an existing, non-empty file", () => {
    const file = join(dir, "porthole-ring-2026-09-10T00-00-00.pftrace");
    writeFileSync(file, "not really a trace, but present");
    expect(checkTracePath(file)).toEqual({ ok: true });
  });

  it("ok:true for an existing but EMPTY file — still goes through the questions, not pre-empted here", () => {
    const file = join(dir, "porthole-empty.pftrace");
    writeFileSync(file, "");
    expect(checkTracePath(file)).toEqual({ ok: true });
  });

  it("names the missing path in a plain sentence, with no candidate to suggest in an empty directory", () => {
    const missing = join(dir, "porthole-2026-09-19T12-00-00.pftrace");
    const result = checkTracePath(missing);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(missing);
    expect(result.message).not.toContain("Did you mean");
  });

  it("suggests the file sharing the longest basename prefix, not just any .pftrace in the directory", () => {
    // Two unrelated naming families in the same directory — a mutant that
    // picked the first (or newest) candidate rather than the best-matching
    // prefix would pick the ring file here instead.
    const decoy = join(dir, "porthole-ring-auto-2026-09-01T00-00-00.pftrace");
    writeFileSync(decoy, "");
    const wanted = join(dir, "porthole-2026-09-19T12-00-00.pftrace");
    const sibling = join(dir, "porthole-2026-09-19T11-59-00.pftrace");
    writeFileSync(sibling, "");

    const result = checkTracePath(wanted);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(sibling);
    expect(result.message).not.toContain(decoy);
  });

  it("falls back to the newest .pftrace file when nothing shares any basename prefix at all", async () => {
    // Named so alphabetical (and typical readdir) order is the OPPOSITE of
    // mtime order — "zzz" is older but sorts last, "aaa" is newer but sorts
    // first. A mutant that picked by iteration/sort order instead of a real
    // mtime comparison (or one that let a zero-length shared prefix count
    // as a "best" match at all) would pick "zzz", not "aaa", and fail this;
    // it passed a same-order first draft of this fixture undetected.
    const older = join(dir, "zzz-capture.pftrace");
    writeFileSync(older, "");
    // Ensure a real mtime gap — same file-timestamp granularity concern as
    // elsewhere in this codebase's mtime-ordering tests.
    await new Promise((r) => setTimeout(r, 20));
    const newer = join(dir, "aaa-capture.pftrace");
    writeFileSync(newer, "");

    const missing = join(dir, "totally-different-name.pftrace");
    const result = checkTracePath(missing);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(newer);
    expect(result.message).not.toContain(older);
  });

  it("ignores a non-.pftrace file in the same directory as a candidate", () => {
    writeFileSync(join(dir, "notes.txt"), "");
    const missing = join(dir, "porthole-2026-09-19T12-00-00.pftrace");
    expect(nearestTraceCandidate(missing)).toBeNull();
  });

  it("is not a file (a directory) — reported distinctly from 'no such file'", () => {
    const asADirectory = join(dir, "oops-a-directory.pftrace");
    mkdirSync(asADirectory);
    const result = checkTracePath(asADirectory);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("is not a file");
  });

  it("names a path under a directory that does not exist at all the same way as a plain missing file", () => {
    const result = checkTracePath(join(dir, "no-such-subdir", "trace.pftrace"));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No such trace file");
  });

  it.skipIf(process.platform === "win32")("reports an existing-but-unreadable file distinctly, not as 'no such file'", () => {
    const file = join(dir, "unreadable.pftrace");
    writeFileSync(file, "some bytes");
    try {
      chmodSync(file, 0o000);
    } catch {
      return; // No permission to chmod on this machine — nothing to assert.
    }
    try {
      const result = checkTracePath(file);
      if (result.ok) return; // Running as root: chmod 0 does not block root's own read — nothing to assert.
      expect(result.message).toContain("could not be read");
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it("GRA-234 QA F17: falls back to <projectRoot>/.porthole/traces when the requested path's own directory has nothing to offer", () => {
    // The requested path's own directory (a throwaway temp dir, separate
    // from `dir`/PORTHOLE_PROJECT_ROOT) is empty — nothing for the direct
    // search to find at all.
    const requestedDir = mkdtempSync(join(tmpdir(), "porthole-elsewhere-"));
    try {
      const tracesDir = join(dir, ".porthole", "traces");
      mkdirSync(tracesDir, { recursive: true });
      const sibling = join(tracesDir, "porthole-ring-2026-09-19T11-59-00.pftrace");
      writeFileSync(sibling, "");
      // A decoy that should lose the prefix match, same as the direct-search test.
      writeFileSync(join(tracesDir, "porthole-ring-auto-2026-09-01T00-00-00.pftrace"), "");

      const missing = join(requestedDir, "porthole-ring-2026-09-19T12-00-00.pftrace");
      const result = checkTracePath(missing);
      expect(result.ok).toBe(false);
      expect(result.message).toContain(`Did you mean ${sibling}`);
    } finally {
      rmSync(requestedDir, { recursive: true, force: true });
    }
  });

  it("GRA-234 QA F17: the direct search still wins when the requested directory itself has a candidate — no fallback needed", () => {
    const tracesDir = join(dir, ".porthole", "traces");
    mkdirSync(tracesDir, { recursive: true });
    writeFileSync(join(tracesDir, "porthole-ring-2026-09-19T00-00-00.pftrace"), "");

    const localSibling = join(dir, "porthole-ring-2026-09-19T11-59-00.pftrace");
    writeFileSync(localSibling, "");
    const missing = join(dir, "porthole-ring-2026-09-19T12-00-00.pftrace");

    const result = checkTracePath(missing);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(`Did you mean ${localSibling}`);
  });

  it("GRA-234 QA F18: the basename-prefix match is case-insensitive, same as the .pftrace filter beside it", async () => {
    // A mutant that compares case-sensitively scores this candidate 0 (the
    // very first character disagrees) — same as the totally-unrelated
    // decoy below, so both would fall through to the mtime tiebreak
    // together. Writing the decoy AFTER (so it is the newer file) means a
    // case-sensitive mutant picks the decoy, not this candidate, making the
    // two outcomes actually distinguishable rather than both landing on
    // the sole file present.
    const upperCaseSibling = join(dir, "PORTHOLE-ring-2026-09-19T11-59-00.PFTRACE");
    writeFileSync(upperCaseSibling, "");
    await new Promise((r) => setTimeout(r, 20));
    const decoy = join(dir, "zzz-totally-unrelated.pftrace");
    writeFileSync(decoy, "");

    const missing = join(dir, "porthole-ring-2026-09-19T12-00-00.pftrace");
    const result = checkTracePath(missing);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(`Did you mean ${upperCaseSibling}`);
    expect(result.message).not.toContain(decoy);
  });
});

/**
 * `hoistModules` is what GRA-61 (five more trace questions) and GRA-85 (a
 * project's own question) will both extend, so it is tested against the
 * real `QUESTIONS` array rather than a hand-built stand-in: a test against a
 * toy input would keep passing even if a future question's module stopped
 * being pulled out correctly, which is precisely the failure this exists to
 * catch.
 */
describe("hoistModules", () => {
  const { modules, questions } = hoistModules(QUESTIONS);

  it("declares a module shared by two questions once, not twice", () => {
    // render and slices both need slices.with_context.
    expect(modules.filter((m) => m === "slices.with_context")).toHaveLength(1);
  });

  it("still declares a module only one question needs", () => {
    expect(modules).toContain("android.binder");
  });

  it("strips every question's own INCLUDE line, module or not", () => {
    for (const q of questions) {
      expect(q.sql).not.toMatch(/INCLUDE\s+PERFETTO\s+MODULE/i);
    }
  });

  it("leaves a question with nothing to hoist otherwise unchanged", () => {
    const jank = questions.find((q) => q.id === "jank");
    expect(jank?.sql).toContain("actual_frame_timeline_slice");
  });

  it("carries every question's id and asks text through unchanged", () => {
    expect(questions.map((q) => q.id)).toEqual(QUESTIONS.map((q) => q.id));
    expect(questions.map((q) => q.asks)).toEqual(QUESTIONS.map((q) => q.asks));
  });

  /**
   * Every test above iterates the real `QUESTIONS`, where no single question
   * declares two modules — `render` and `slices` each declare one, and they
   * happen to be the same one. That makes the loop inside `hoistModules`
   * (`while ((match = finder.exec(...)))`) structurally untested: swap it for
   * an `if` and every existing assertion still passes, because taking only
   * the first match of a question that only ever has one match is
   * indistinguishable from taking all of them. This is the exact failure the
   * code comment on `hoistModules` names as the thing to guard against, so it
   * needs a question that actually declares two.
   */
  it("hoists every module a single question declares, not just its first", () => {
    const synthetic: Question[] = [
      {
        id: "synthetic",
        asks: "a question that needs two modules at once",
        sql: `INCLUDE PERFETTO MODULE android.binder;
              INCLUDE PERFETTO MODULE slices.with_context;
              SELECT 1 AS one`,
      },
    ];
    const { modules, questions: hoisted } = hoistModules(synthetic);
    expect(modules).toEqual(["android.binder", "slices.with_context"]);
    expect(hoisted[0].sql).not.toMatch(/INCLUDE\s+PERFETTO\s+MODULE/i);
    expect(hoisted[0].sql).toContain("SELECT 1 AS one");
  });
});

describe("matchBatch", () => {
  // A fixed nonce here; production draws a fresh one per script.
  const NONCE = "0123456789abcdef";
  const markerBlock = (id: string) => `"marker"\n"${markerText(NONCE, id)}"`;

  it("pairs each marker with the data block that follows it, in order", () => {
    const stdout = [
      `${markerBlock("a")}\n\n"x"\n"1"`,
      `${markerBlock("b")}\n\n"y"\n"2"`,
    ].join("\n\n");
    const { rows, answered } = matchBatch(stdout, ["a", "b"], NONCE);
    expect(answered).toBe(2);
    expect(rows.get("a")).toEqual([{ x: "1" }]);
    expect(rows.get("b")).toEqual([{ y: "2" }]);
  });

  it("does not mistake a data row with an embedded quote for a marker", () => {
    // trace_processor does not escape a quote inside a quoted field, so a
    // slice name like `he said "hi"` prints as `"he said "hi""`. That is
    // exactly the shape that breaks a split which goes looking for a magic
    // string anywhere in the byte stream; here the marker is a whole separate
    // statement; this row is just data, whatever it contains.
    const stdout = [
      `${markerBlock("a")}\n\n"name"\n"he said "hi""`,
      `${markerBlock("b")}\n\n"y"\n"2"`,
    ].join("\n\n");
    const { rows, answered } = matchBatch(stdout, ["a", "b"], NONCE);
    expect(answered).toBe(2);
    expect(rows.get("a")).toEqual([{ name: 'he said "hi"' }]);
    expect(rows.get("b")).toEqual([{ y: "2" }]);
  });

  it("does not mistake an all-[NULL] row for a missing block", () => {
    // trace_processor writes NULL as the literal, quoted "[NULL]". A row that
    // is [NULL] in its one column is still a real, present data block — the
    // risk named on the ticket for this work was confusing that with "no
    // block at all", which is what a failed or killed question looks like.
    const stdout = [
      `${markerBlock("a")}\n\n"io_wait"\n"[NULL]"`,
      `${markerBlock("b")}\n\n"y"\n"2"`,
    ].join("\n\n");
    const { rows, answered } = matchBatch(stdout, ["a", "b"], NONCE);
    expect(answered).toBe(2);
    expect(rows.get("a")).toEqual([{ io_wait: null }]);
  });

  it("stops at the first id whose marker has no data block after it", () => {
    // What a mid-script failure and a killed process both look like: the
    // marker for the next question printed, and then nothing.
    const stdout = `${markerBlock("a")}\n\n"x"\n"1"\n\n${markerBlock("b")}`;
    const { rows, answered } = matchBatch(stdout, ["a", "b"], NONCE);
    expect(answered).toBe(1);
    expect(rows.get("a")).toEqual([{ x: "1" }]);
    expect(rows.has("b")).toBe(false);
  });

  /**
   * QA's reproducer for the FAIL this shipped with: a value containing two
   * consecutive newlines used to be indistinguishable from the blank line
   * that separated one statement's CSV block from the next, because the old
   * `splitBlocks` split on `/\r?\n\r?\n/` rather than looking for the marker
   * itself. Reachable through `slices`, whose `s.name` is a developer's own
   * atrace section name — arbitrary text via `Trace.beginSection`.
   *
   * Scanning for the literal next marker instead of a blank line means the
   * whole multi-line block — the corrupted row and all — is now captured and
   * handed to the *following* question correctly, rather than the corrupted
   * remainder being mistaken for that question's marker. What is left over is
   * the pre-existing, separate `parseRows` limitation this ticket is not
   * responsible for: a single embedded newline still splits one CSV row into
   * two garbage rows. That is the known, inherited shape asserted below —
   * `{"name":"a","k":null}` and `{"name":'b"',"k":"99"}` — not a new failure.
   * The property this test actually pins is that "two" and "three" are
   * answered cleanly and never reported as unanswered.
   */
  it("does not lose the next question when a value contains a blank line (FAIL 1 reproducer)", () => {
    const corrupted = `"name","k"\n"a\n\nb","99"`;
    const stdout = [
      `${markerBlock("one")}\n\n${corrupted}`,
      `${markerBlock("two")}\n\n"z"\n"2"`,
      `${markerBlock("three")}\n\n"z"\n"3"`,
    ].join("\n\n");

    const { rows, answered } = matchBatch(stdout, ["one", "two", "three"], NONCE);

    expect(answered).toBe(3);
    // The inherited (not introduced) garbage: a single embedded newline still
    // splits this row into two, which is a separate, pre-existing bug and not
    // this ticket's to fix.
    // The row comes back whole: parseRows joins the two physical lines the
    // embedded newline made of it, because the header says two cells and the
    // first line alone parses to one.
    expect(rows.get("one")).toEqual([{ name: "a\n\nb", k: "99" }]);
    // The property that actually matters: the next two questions are neither
    // corrupted nor swallowed by question one's broken block.
    expect(rows.get("two")).toEqual([{ z: "2" }]);
    expect(rows.get("three")).toEqual([{ z: "3" }]);
  });

  /**
   * M5 (delete the marker *id* check, keep only the `"marker"` header check)
   * survived the first pass because the shipped "keys every question's real
   * rows onto its own id" test builds its fixture already in order — a batch
   * that never actually arrives out of order cannot exercise a guard whose
   * whole job is noticing when it does.
   */
  it("refuses a marker block for the wrong id, even though the header token is right (kills M5)", () => {
    const stdout = markerBlock("b") + `\n\n"y"\n"2"`;
    const { rows, answered } = matchBatch(stdout, ["a", "b"], NONCE);
    expect(answered).toBe(0);
    expect(rows.has("a")).toBe(false);
  });

  /**
   * M4 (delete the `"marker"` header-token check, keep only the id check).
   * Without it, a data block whose header is `"name"` and whose row happens
   * to be the literal string `"porthole:a"` — nothing today selects a column
   * named `name` that returns exactly that string, but GRA-85 lets a project
   * supply its own SQL — is consumed as if it were the real marker for `a`.
   * This is the same forgery hole QA flagged for GRA-85's benefit.
   */
  it("refuses a data block whose row merely looks like the next marker (kills M4)", () => {
    const stdout = `"name"\n"${MARKER_PREFIX}a"\n\n"y"\n"2"`;
    const { answered } = matchBatch(stdout, ["a"], NONCE);
    expect(answered).toBe(0);
  });

  /**
   * The forgery the M4 test above does not cover: a question's own data
   * putting the marker's exact two lines into the stream. Reachable today —
   * `render` and `thread_states` select names that are arbitrary
   * `Trace.beginSection` text, the writer escapes neither quotes nor
   * newlines, and a name of `marker"` + newline + `"porthole:slices"` + newline
   * + `"junk` prints those as whole lines. Against the real binary that
   * re-keyed `render`'s rows as `slices`' answer with nothing reported. The
   * old-shape pair below (no nonce) is what such a name produces; a name
   * cannot contain the nonce because it was chosen after the trace was
   * recorded, so the forged pair is data and the real pair still matches.
   */
  it("keeps a forged marker pair inside a question's data as data, because it lacks the nonce", () => {
    const forged = `"marker"\n"porthole:b"`;
    const stdout = [
      `${markerBlock("a")}\n\n"name","n"\n${forged}\n"junk",42`,
      `${markerBlock("b")}\n\n"name","n"\n"real-b",7`,
    ].join("\n\n");
    const { rows, answered } = matchBatch(stdout, ["a", "b"], NONCE);
    expect(answered).toBe(2);
    // `a`'s one row survives whole: the forged lines are its own name.
    expect(rows.get("a")).toEqual([{ name: `marker"\n"porthole:b"\n"junk`, n: "42" }]);
    expect(rows.get("b")).toEqual([{ name: "real-b", n: "7" }]);
  });

  it("does not accept the nonce-bearing pair for a different nonce", () => {
    const other = `"marker"\n"${markerText("fedcba9876543210", "b")}"`;
    const stdout = [`${markerBlock("a")}\n\n"x"\n"1"`, `${other}\n\n"y"\n"2"`].join("\n\n");
    const { rows, answered } = matchBatch(stdout, ["a", "b"], NONCE);
    expect(answered).toBe(1);
    expect(rows.has("b")).toBe(false);
  });
});

/**
 * A hand-written stand-in for `runScript` that speaks the same marker
 * protocol a real trace_processor_shell batch does, without spawning
 * anything. `runBatch`'s job — answer everything in one call when it can,
 * isolate a failing question instead of losing the rest, stop rather than
 * retry on a timeout — is a property of this loop, not of the OS process
 * underneath it, so this is what lets that job be tested on every machine
 * this suite runs on rather than only where a 77MB binary has been fetched.
 */
function fakeRun(
  plan: Record<string, { rows?: Array<Record<string, string | number | null>>; fail?: string }>,
): { run: RunFn; callCount: () => number; scripts: string[] } {
  let calls = 0;
  const scripts: string[] = [];
  const run: RunFn = async (_binary, _args, sql) => {
    calls++;
    scripts.push(sql);
    const markers = [...sql.matchAll(/SELECT 'porthole:([0-9a-f]{16}):([\w.]+)' AS marker;/g)];
    let stdout = "";
    for (const [, nonce, id] of markers) {
      stdout += `"marker"\n"${markerText(nonce, id)}"\n\n`;
      const spec = plan[id] ?? { rows: [] };
      if (spec.fail) {
        return { code: 1, stdout, stderr: spec.fail, timedOut: false, elapsedMs: 1 };
      }
      const rows = spec.rows ?? [];
      const columns = rows.length > 0 ? Object.keys(rows[0]) : ["value"];
      stdout += columns.map((c) => `"${c}"`).join(",") + "\n";
      for (const row of rows) {
        stdout += columns.map((c) => (row[c] === null ? '"[NULL]"' : `"${row[c]}"`)).join(",") + "\n";
      }
      stdout += "\n";
    }
    return { code: 0, stdout, stderr: "", timedOut: false, elapsedMs: 1 };
  };
  return { run, callCount: () => calls, scripts };
}

/**
 * The whole marker argument rests on one property: a value recorded in the
 * trace before this call cannot contain the nonce. That is only true if the
 * nonce is unpredictable and drawn fresh, and neither was pinned by a test —
 * a `newNonce` that returned a constant left the suite green while restoring
 * the forgery the nonce exists to stop, verbatim, against the real binary.
 */
describe("newNonce", () => {
  it("is sixteen hex characters", () => {
    expect(newNonce()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs from call to call", () => {
    const seen = new Set(Array.from({ length: 32 }, () => newNonce()));
    expect(seen.size).toBe(32);
  });
});

describe("runBatch", () => {
  const question = (id: string): HoistedQuestion => ({ id, asks: `asks about ${id}`, sql: "SELECT 1" });
  const questions = [question("a"), question("b"), question("c")];
  const options = {
    binary: "unused",
    trace: "some.pftrace",
    packageName: "com.example.shop",
    fromNs: 0,
    toNs: 1,
    timeoutMs: 5_000,
  };

  it("draws a fresh nonce for every script, including a retry", async () => {
    const { run, scripts } = fakeRun({
      a: { rows: [{ x: "1" }] },
      b: { fail: "no such table: bogus" },
      c: { rows: [{ x: "3" }] },
    });
    await runBatch(questions, [], options, run);
    expect(scripts).toHaveLength(2);
    const nonceOf = (script: string) => /SELECT 'porthole:([0-9a-f]{16}):/.exec(script)?.[1];
    const [first, second] = scripts.map(nonceOf);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(second).toMatch(/^[0-9a-f]{16}$/);
    expect(second).not.toBe(first);
  });

  it("answers everything in one call when nothing fails", async () => {
    const { run, callCount } = fakeRun({
      a: { rows: [{ x: "1" }] },
      b: { rows: [{ x: "2" }] },
      c: { rows: [{ x: "3" }] },
    });
    const { rows, unanswered } = await runBatch(questions, [], options, run);
    expect(callCount()).toBe(1);
    expect(unanswered).toEqual([]);
    expect((rows as Record<string, unknown>).a).toEqual([{ x: "1" }]);
    expect((rows as Record<string, unknown>).c).toEqual([{ x: "3" }]);
  });

  /**
   * GRA-61's wallTimeMs. AskResult's own doc comment explains why this is a
   * per-invocation number rather than a true per-statement one:
   * trace_processor_shell reports one "Query execution time" for an entire
   * `-q` script, not one per statement — so what `runBatch` can honestly
   * report is which invocation answered each question and how long that
   * invocation took, not a fabricated share of it.
   */
  it("attributes one invocation's wall time to every question it answered together", async () => {
    const run: RunFn = async (_binary, _args, sql) => {
      const markers = [...sql.matchAll(/SELECT 'porthole:([0-9a-f]{16}):([\w.]+)' AS marker;/g)];
      let stdout = "";
      for (const [, nonce, id] of markers) stdout += `"marker"\n"${markerText(nonce, id)}"\n\n"x"\n"1"\n\n`;
      return { code: 0, stdout, stderr: "", timedOut: false, elapsedMs: 42 };
    };
    const { wallTimeMs } = await runBatch(questions, [], options, run);
    expect(wallTimeMs).toEqual({ a: 42, b: 42, c: 42 });
  });

  it("gives a retried question its own call's wall time, not the failed first call's", async () => {
    let call = 0;
    const run: RunFn = async (_binary, _args, sql) => {
      call++;
      const markers = [...sql.matchAll(/SELECT 'porthole:([0-9a-f]{16}):([\w.]+)' AS marker;/g)];
      let stdout = "";
      for (const [, nonce, id] of markers) {
        if (call === 1 && id === "b") {
          return { code: 1, stdout, stderr: "no such table: bogus", timedOut: false, elapsedMs: 10 };
        }
        stdout += `"marker"\n"${markerText(nonce, id)}"\n\n"x"\n"1"\n\n`;
      }
      return { code: 0, stdout, stderr: "", timedOut: false, elapsedMs: call === 1 ? 10 : 5 };
    };
    const { wallTimeMs } = await runBatch(questions, [], options, run);
    expect(wallTimeMs.a).toBe(10); // answered on the first, slower call
    expect(wallTimeMs.c).toBe(5); // answered only after b was dropped and the rest retried
    expect(wallTimeMs.b).toBeUndefined(); // never answered at all
  });

  it("keeps the other two when one fails, at the cost of one extra call", async () => {
    const { run, callCount } = fakeRun({
      a: { rows: [{ x: "1" }] },
      b: { fail: "no such table: bogus" },
      c: { rows: [{ x: "3" }] },
    });
    const { rows, unanswered } = await runBatch(questions, [], options, run);
    expect(callCount()).toBe(2);
    expect(unanswered).toHaveLength(1);
    expect(unanswered[0]).toContain("asks about b");
    expect(unanswered[0]).toContain("no such table: bogus");
    expect((rows as Record<string, unknown>).a).toEqual([{ x: "1" }]);
    expect((rows as Record<string, unknown>).c).toEqual([{ x: "3" }]);
    expect((rows as Record<string, unknown>).b).toBeUndefined();
  });

  it("keeps whatever answered before two failures in a row, at the cost of one extra call each", async () => {
    // Three questions, both b and c broken: the first call answers a and
    // fails on b; the second call (just [c], since b is dropped rather than
    // retried) fails again. Two calls in total, not three — the point of
    // dropping the failed question rather than reattempting it.
    const { run, callCount } = fakeRun({
      a: { rows: [{ x: "1" }] },
      b: { fail: "first failure" },
      c: { fail: "second failure" },
    });
    const { rows, unanswered } = await runBatch(questions, [], options, run);
    expect(callCount()).toBe(2);
    expect(unanswered).toHaveLength(2);
    expect(unanswered[0]).toContain("first failure");
    expect(unanswered[1]).toContain("second failure");
    expect((rows as Record<string, unknown>).a).toEqual([{ x: "1" }]);
  });

  it("stops entirely on a timeout rather than retrying into the same hang", async () => {
    let calls = 0;
    const run: RunFn = async () => {
      calls++;
      return { code: null, stdout: "", stderr: "", timedOut: true, elapsedMs: 5_000 };
    };
    const { unanswered } = await runBatch(questions, [], options, run);
    expect(calls).toBe(1);
    expect(unanswered).toHaveLength(3);
    for (const u of unanswered) {
      expect(u).toContain("5000ms");
      expect(u).toContain(options.trace);
    }
  });

  it("stops entirely when the binary itself cannot be run", async () => {
    let calls = 0;
    const run: RunFn = async () => {
      calls++;
      return {
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        elapsedMs: 1,
        spawnError: new Error("ENOENT: no such file"),
      };
    };
    const { unanswered } = await runBatch(questions, [], options, run);
    expect(calls).toBe(1);
    expect(unanswered).toHaveLength(3);
    for (const u of unanswered) expect(u).toContain("ENOENT");
  });

  /**
   * The suite stayed green while M17 deleted the `INCLUDE` emission from the
   * built script entirely: nothing in the existing tests looks at the SQL
   * `run` actually receives. Confirmed against the real binary and a real
   * capture that this is not equivalent-mutant territory — with the
   * emission gone, three of five questions failed with "no such table" and
   * `newFindings` dropped from 6 to 2. This captures the sql `runBatch` sends
   * and checks the hoisted modules are actually in it, ahead of the first
   * marker (an `INCLUDE` after the marker it belongs before would still
   * compile-fail the question that needed it).
   */
  it("puts every hoisted module into the script, ahead of the first marker (kills M17)", async () => {
    const calls: string[] = [];
    const run: RunFn = async (_binary, _args, sql) => {
      calls.push(sql);
      // Stop after one call — spawnError short-circuits runBatch's retry
      // loop, and this test only cares what the first call sent.
      return { code: null, stdout: "", stderr: "", timedOut: false, elapsedMs: 1, spawnError: new Error("stop") };
    };
    const modules = ["android.binder", "slices.with_context"];
    await runBatch(questions, modules, options, run);

    expect(calls).toHaveLength(1);
    const sql = calls[0];
    const firstMarker = sql.indexOf(`SELECT '${MARKER_PREFIX}`);
    expect(firstMarker).toBeGreaterThan(-1);
    for (const module of modules) {
      const includeLine = `INCLUDE PERFETTO MODULE ${module};`;
      const at = sql.indexOf(includeLine);
      expect(at, `${includeLine} missing from the built script`).toBeGreaterThan(-1);
      expect(at).toBeLessThan(firstMarker);
    }
  });

  /**
   * M18 (stop escaping `'` in the package name inside `substitute()`). Low
   * risk — pre-existing behaviour just moved when batching was built — but
   * now untested, and a package name containing an apostrophe (an unlikely
   * but real Android application id character) would otherwise close the SQL
   * string early and corrupt the whole batch rather than one question.
   */
  it("escapes an apostrophe in the package name so the batch stays valid SQL (kills M18)", async () => {
    const calls: string[] = [];
    const run: RunFn = async (_binary, _args, sql) => {
      calls.push(sql);
      return { code: null, stdout: "", stderr: "", timedOut: false, elapsedMs: 1, spawnError: new Error("stop") };
    };
    // Needs a question whose SQL actually references $package — the shared
    // `questions` fixture above does not, so the substitution would have
    // nothing to replace and the escaped name would never show up either way.
    const withPackage: HoistedQuestion[] = [{ id: "a", asks: "asks about a", sql: "SELECT * FROM x WHERE p = $package" }];
    await runBatch(withPackage, [], { ...options, packageName: "o'brien" }, run);
    expect(calls[0]).toContain("'o''brien'");
  });
});

/**
 * `runScript` itself, against a real spawned process rather than a fake —
 * proving the timeout actually kills something, and that the event loop
 * stays free while it waits, needs an OS process on the other end, not a
 * hand-written stand-in that could just declare victory. `cmd.exe` fills
 * that role: it is a real, always-present executable Windows will spawn
 * directly (unlike a `.cmd`/`.bat` file, which needs `shell: true` and is
 * not what production ever passes), and it can be told to succeed, fail or
 * hang on demand.
 */
describe("runScript, against a real process", () => {
  const isWindows = process.platform === "win32";
  const binary = isWindows ? "cmd.exe" : "/bin/sh";
  const args = (command: string) => (isWindows ? ["/d", "/s", "/c", command] : ["-c", command]);
  // An infinite loop cmd.exe runs itself, not one it hands to a child
  // process: `ping` was tried first and did not work for this — killing
  // cmd.exe left the ping.exe it had started still holding the output pipe
  // open, so the pipe never closed and the test hung for the real 30s
  // regardless of the timeout. TerminateProcess only ever reaches the one
  // process handle Node holds, which is exactly the situation trace_processor_
  // shell is in (a single process, nothing it spawns further) but is not what
  // `cmd.exe /c ping` is.
  //
  // The same trap on POSIX, found by the Ubuntu leg of CI: `sh -c "sleep 30"`
  // is one process under bash and macOS's sh, which exec a lone command, but
  // dash — Ubuntu's /bin/sh — forks it, so killing the shell left `sleep`
  // holding the pipe and the test waited the full 30s. `exec` makes the shell
  // become the command on every sh, which is the shape the test needs.
  const hang = isWindows ? "for /l %i in () do @rem" : "exec sleep 30";
  const short = isWindows ? "ping -n 2 127.0.0.1 >nul" : "exec sleep 1";

  it("captures a real process's stdout and a clean exit", async () => {
    const result = await runScript(binary, args("echo hello"), "", 5_000);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.timedOut).toBe(false);
  });

  it("reports a nonzero exit without treating it as a timeout", async () => {
    const result = await runScript(binary, args("exit 7"), "", 5_000);
    expect(result.code).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it("kills a wedged process and says how long it waited", async () => {
    const started = Date.now();
    const result = await runScript(binary, args(hang), "", 200);
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    // The real proof this was killed rather than left running: the test
    // returns in a small fraction of the 30s the command asked to hang for.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it("keeps the event loop free while the child runs", async () => {
    const order: string[] = [];
    const running = runScript(binary, args(short), "", 10_000).then(() => order.push("run"));
    const timer = new Promise<void>((resolve) => setTimeout(resolve, 30)).then(() => order.push("timer"));
    await Promise.all([running, timer]);
    // `short` runs for roughly a second; a 30ms timer that fires first is
    // only possible if the child is not blocking the thread it runs on.
    expect(order[0]).toBe("timer");
  }, 15_000);
});
