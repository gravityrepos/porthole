// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askTrace, findTraceProcessor, interpret, matchBatch, parseRows, type Rows } from "./perfetto.js";

/**
 * The other fixtures are JSON exported from the trace viewer. These are the
 * bytes trace_processor writes to stdout when the same questions are put to
 * the same trace from the command line — which is the only path any user takes.
 *
 * They are not the same shape, and for a while nothing noticed. The parser
 * split on tabs against comma-separated output, so every row came back as one
 * column keyed by the whole header line and every number read as zero. The
 * suite was green throughout: it tested a shape that is never received.
 *
 * So these are captured, unedited, from a real 16MB capture of the sample app
 * on a Pixel — the same trace behind the JSON fixtures, containing a frame
 * that missed its deadline by 117ms.
 */
const stdout = (name: string): string =>
  readFileSync(new URL(`./fixtures/stdout/${name}.csv`, import.meta.url), "utf8");

const rows = (name: string) => parseRows(stdout(name));

describe("parseRows, on what trace_processor prints", () => {
  it("reads columns, not one column named after the header", () => {
    const first = rows("jank")[0];
    expect(Object.keys(first)).toEqual([
      "jank_type",
      "COUNT",
      "MIN(dur)",
      "MAX(dur)",
      "AVG(dur)",
    ]);
    expect(first.jank_type).toBe("App Deadline Missed");
    expect(Number(first["MAX(dur)"])).toBe(117264766);
  });

  it("strips the quotes from quoted values and leaves bare numbers alone", () => {
    const first = rows("thread_states")[0];
    expect(first.thread_name).toBe("porthole-recomp");
    expect(first.is_main_thread).toBe("0");
    expect(Number(first["SUM(dur)"])).toBe(11709113557);
  });

  it("turns [NULL] into null rather than the string", () => {
    const row = rows("thread_states").find((r) => r.state === "S");
    expect(row?.io_wait).toBeNull();
  });

  it("keeps a value that contains spaces and digits intact", () => {
    // "Drawing  0.00  0.00 1080.00 2404.00" is a real slice name and the kind
    // of value a naive split mangles.
    const row = rows("render")[0];
    expect(row.name).toBe("Drawing  0.00  0.00 1080.00 2404.00");
    expect(row.thread_name).toBe("RenderThread");
  });

  it("reads every row of every question", () => {
    expect(rows("jank")).toHaveLength(3);
    expect(rows("thread_states")).toHaveLength(112);
    expect(rows("binder")).toHaveLength(3);
    expect(rows("render")).toHaveLength(30);
    expect(rows("slices")).toHaveLength(200);
  });
});

describe("parseRows, on quoting trace_processor gets wrong", () => {
  it("keeps an embedded comma inside its quotes", () => {
    expect(parseRows('"x","y"\n"a,b","c"')[0]).toEqual({ x: "a,b", y: "c" });
  });

  it("keeps an embedded quote, which the writer does not escape", () => {
    // trace_processor emits `he said "hi"` as `"he said "hi""` — not doubled,
    // so a strict CSV reader stops early and loses the rest of the row.
    expect(parseRows('"x","y"\n"he said "hi"","c"')[0]).toEqual({
      x: 'he said "hi"',
      y: "c",
    });
  });

  it("returns nothing for a header with no rows under it", () => {
    expect(parseRows('"x","y"\n')).toEqual([]);
    expect(parseRows("")).toEqual([]);
  });
});

describe("interpret, on what trace_processor prints", () => {
  const all: Rows = {
    jank: rows("jank"),
    thread_states: rows("thread_states"),
    binder: rows("binder"),
    render: rows("render"),
    slices: rows("slices"),
  };
  const findings = interpret(all);
  const byId = (id: string) => findings.find((f) => f.id === id);

  it("finds the missed deadline Android itself recorded", () => {
    const jank = byId("trace-frame-deadline");
    expect(jank?.severity).toBe("error");
    expect(jank?.evidence?.worstMs).toBe(117.3);
  });

  it("sees the main thread waiting for a CPU", () => {
    // The reading that was silently 0ms: isMainThread read a column the query
    // never selected, and the state codes are letters, not words. Both faults
    // produced the same confident sentence — that the scheduler was not
    // involved — about a window where it plainly was.
    const contention = byId("trace-main-thread-contention");
    expect(contention?.evidence?.runnableMs).toBeCloseTo(58.9, 1);
    expect(contention?.severity).toBe("warning");
    expect(contention?.title).toContain("runnable but not scheduled");
  });

  it("counts only real I/O waits as I/O", () => {
    // D with io_wait=1 is I/O; D with io_wait=0 is 0.4ms of something else and
    // must not be added to it.
    expect(byId("trace-main-thread-contention")?.evidence?.ioMs).toBeCloseTo(4.4, 1);
  });

  it("names the process the app was blocked calling into", () => {
    const binder = byId("trace-binder");
    expect(binder?.evidence?.worstTarget).toBe("system_server");
    expect(binder?.evidence?.worstMs).toBeCloseTo(9.4, 1);
  });

  it("attributes the render path to the render thread", () => {
    expect(byId("trace-render")?.evidence?.totalMs).toBeGreaterThan(0);
  });

  it("separates work the app did not write from work it did", () => {
    // 145ms of the window is ART compiling a cold process, which no amount of
    // reading the app's own code would explain.
    const art = findings.find((f) => f.title.includes("ART compiling bytecode"));
    expect(art).toBeDefined();
  });

  it("answers every question without one falling over", () => {
    // Five questions, five interpretations: a regression in any single query
    // shows up here as a missing finding rather than as silence.
    expect(findings.length).toBeGreaterThanOrEqual(5);
  });
});

/**
 * GRA-82 stopped running the five questions as five separate invocations and
 * started running them as one script, each preceded by a `SELECT
 * 'porthole:<id>' AS marker`. This is the same real stdout used above — real
 * trace_processor output for a real 16MB capture, not invented rows — but
 * wrapped in the marker shape a batched script actually produces, and
 * concatenated in question order the way `buildScript` emits them.
 *
 * The property this pins is the one the ticket called out as most at risk
 * from batching: that the five results still land keyed onto the right id in
 * `Rows`, not shifted onto their neighbour, and that `interpret` produces the
 * identical findings from the batched shape as from the five separate ones
 * tested above.
 */
describe("matchBatch, on the five real fixtures concatenated in question order", () => {
  const ids = ["jank", "thread_states", "binder", "render", "slices"];
  const batched = ids.map((id) => `"marker"\n"porthole:${id}"\n\n${stdout(id).trimEnd()}`).join("\n\n");
  const { rows: matched, answered } = matchBatch(batched, ids);

  it("answers all five from one concatenated script", () => {
    expect(answered).toBe(5);
  });

  it("keys every question's real rows onto its own id, not a neighbour's", () => {
    for (const id of ids) {
      expect(matched.get(id)).toEqual(rows(id));
    }
  });

  it("produces the same findings batched as it does unbatched", () => {
    const batchedRows = Object.fromEntries(matched) as Rows;
    const batchedFindings = interpret(batchedRows);
    const unbatchedFindings = interpret({
      jank: rows("jank"),
      thread_states: rows("thread_states"),
      binder: rows("binder"),
      render: rows("render"),
      slices: rows("slices"),
    });
    expect(batchedFindings).toEqual(unbatchedFindings);
  });
});

/**
 * Nothing else in this suite exercises `hoistModules -> runBatch -> runScript`
 * end to end: `perfetto.test.ts` proves `hoistModules` and `runBatch` in
 * isolation, against a fake `run`, and the `matchBatch` test above replays
 * real stdout but never asks `askTrace` to build that script and run it
 * itself. That gap is exactly why M17 (deleting the `INCLUDE` emission) and
 * M19 (passing empty `modules` from `askTrace`) both survived the first pass
 * of mutation testing — a fake `run` never notices that the modules it never
 * needed were also never sent.
 *
 * This is BRIEFING's recurring lesson applied to `askTrace` itself: a
 * self-written fixture tests the format assumed, not the one that arrives, so
 * this runs the real wiring against the real pinned binary and a real
 * capture rather than another hand-built stand-in. It is gated on both being
 * present and skips cleanly otherwise — this machine has both today
 * (`findTraceProcessor()` finds the plugin's cached v58.2, and a real
 * 10.96MB capture sits in `.porthole/traces/` from a prior device session),
 * but neither is guaranteed on a fresh checkout or CI runner.
 */
describe("askTrace, end to end against the real binary and a real capture", () => {
  const binary = findTraceProcessor();
  const trace = join(process.cwd(), ".porthole", "traces", "porthole-1789157802606.pftrace");
  const ready = binary !== null && existsSync(trace);

  it.skipIf(!ready)("answers every question in one call against a real trace", async () => {
    // The window and package below are this specific capture's own bounds
    // and its one app process (`com.example.shop`, upid 53) — found by
    // querying the trace directly with `SELECT MIN(ts), MAX(ts) FROM slice`
    // and `SELECT name FROM process`, not guessed.
    const result = await askTrace({
      binary: binary as string,
      trace,
      packageName: "com.example.shop",
      fromNs: 542738294836466,
      toNs: 542749153837178,
    });
    expect(result.unanswered).toEqual([]);
    expect(result.findings.length).toBeGreaterThan(0);
  });
});
