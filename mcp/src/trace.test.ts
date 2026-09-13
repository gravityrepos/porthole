// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { DeviceEvent } from "./device.js";
import { compareMetrics } from "./report.js";
import { findingsOf, frameBudgetMs, metricsOf } from "./trace.js";

function event(name: string, t: number, data: Record<string, unknown> = {}): DeviceEvent {
  return { event: name, t, seq: t, data };
}

/** A start/end pair, the way the device emits one. */
function span(
  prefix: string,
  id: string,
  from: number,
  to: number,
  data: Record<string, unknown> = {},
) {
  return [event(`${prefix}_start`, from, { id }), event(`${prefix}_end`, to, { id, ...data })];
}

describe("frameBudgetMs", () => {
  it("derives the budget from the refresh rate", () => {
    expect(frameBudgetMs(60)).toBe(16.7);
    expect(frameBudgetMs(120)).toBe(8.3);
    expect(frameBudgetMs(90)).toBe(11.1);
  });

  it("assumes 60 when the display will not say", () => {
    // Calling a 10ms frame fine on a 120Hz panel is wrong, so the fallback has
    // to be the conservative one rather than whatever arrived.
    expect(frameBudgetMs(0)).toBe(16.7);
  });
});

describe("metricsOf", () => {
  it("counts missed frames in refreshes, not in events", () => {
    const events = [
      event("frame", 10, { missedFrames: 1, totalMs: 20 }),
      event("frame", 40, { missedFrames: 23, totalMs: 398 }),
    ];
    expect(metricsOf(events)["frames.missed"]).toBe(24);
    expect(metricsOf(events)["frames.worstMs"]).toBe(398);
  });

  it("reports a percentile rather than a mean", () => {
    // Nine fast frames and one terrible one. A mean would say 25ms and hide it.
    const events = [
      ...Array.from({ length: 9 }, (_, i) => event("frame", i, { totalMs: 8 })),
      event("frame", 10, { totalMs: 200 }),
    ];
    expect(metricsOf(events)["frames.p95Ms"]).toBe(200);
  });

  it("separates queries that ran on the main thread", () => {
    const events = [
      ...span("db", "a", 0, 5, { onMainThread: "true" }),
      ...span("db", "b", 10, 15, {}),
    ];
    const metrics = metricsOf(events);
    expect(metrics["db.queries"]).toBe(2);
    expect(metrics["db.onMainThread"]).toBe(1);
  });

  it("counts a call failed by status or by error", () => {
    const events = [
      ...span("http", "a", 0, 10, { status: 200 }),
      ...span("http", "b", 0, 10, { status: 500 }),
      ...span("http", "c", 0, 10, { error: "timeout" }),
    ];
    expect(metricsOf(events)["http.failed"]).toBe(2);
  });

  it("measures a span from its own start and end", () => {
    expect(metricsOf(span("http", "a", 100, 400))["http.p95Ms"]).toBe(300);
  });

  it("falls back to elapsedMs when the start was never seen", () => {
    // A capture that attached mid-call has the end and not the beginning.
    const events = [event("http_end", 500, { id: "orphan", elapsedMs: 120 })];
    expect(metricsOf(events)["http.p95Ms"]).toBe(120);
  });

  it("counts a call that never came back", () => {
    // The whole point of the ticket: a request that hangs used to contribute
    // nothing at all, so the one run worth investigating read as the quietest.
    const events = [
      event("http_start", 10, { id: "hang", method: "POST", url: "https://api/checkout" }),
      event("nav", 5000, { route: "cart" }),
    ];
    const metrics = metricsOf(events);
    expect(metrics["http.calls"]).toBe(1);
    expect(metrics["http.stillOpen"]).toBe(1);
  });

  it("keeps percentiles over completed spans only", () => {
    // The open span outlasts every completion. If its floor were folded in, the
    // longest wait in the run would drag the p95 to 4990 — or, with a shorter
    // hang, quietly *improve* it. Neither is a thing a percentile may say.
    const events = [
      ...span("http", "done-1", 0, 100),
      ...span("http", "done-2", 0, 300),
      event("http_start", 10, { id: "hang", method: "POST", url: "https://api/checkout" }),
      ...span("db", "q-1", 0, 40),
      event("db_start", 20, { id: "db-hang", sql: "SELECT 1" }),
      event("nav", 5000, { route: "cart" }),
    ];
    const metrics = metricsOf(events);

    expect(metrics["http.p95Ms"]).toBe(300);
    expect(metrics["db.p95Ms"]).toBe(40);
    expect(metrics["http.calls"]).toBe(3);
    expect(metrics["db.queries"]).toBe(2);
    expect(metrics["http.stillOpen"]).toBe(1);
    expect(metrics["db.stillOpen"]).toBe(1);
  });

  it("does not call an end with no start open", () => {
    // The mirror case, and not a hang: the call finished, the capture just
    // attached after it began. Both shapes in one run, because both happen.
    const events = [
      event("http_end", 500, { id: "orphan", elapsedMs: 120, status: 200 }),
      event("http_start", 600, { id: "hang", method: "GET", url: "https://api/sync" }),
      event("nav", 900, { route: "cart" }),
    ];
    const metrics = metricsOf(events);
    expect(metrics["http.calls"]).toBe(2);
    expect(metrics["http.stillOpen"]).toBe(1);
  });

  it("gives a zero percentile rather than a floor when everything is open", () => {
    const events = [
      event("http_start", 10, { id: "a", method: "GET", url: "https://api/a" }),
      event("http_start", 20, { id: "b", method: "GET", url: "https://api/b" }),
      event("nav", 3000, { route: "cart" }),
    ];
    const metrics = metricsOf(events);
    expect(metrics["http.calls"]).toBe(2);
    expect(metrics["http.stillOpen"]).toBe(2);
    // No completion means no distribution. Zero says "nothing measured"; the
    // stillOpen count and the finding are what carry the run.
    expect(metrics["http.p95Ms"]).toBe(0);
  });

  it("keeps the earlier start when an id is reused", () => {
    // Two starts sharing an id is the device contradicting itself. Overwriting
    // would silently lose the first, which is the defect this ticket is about;
    // the earlier start is also the conservative floor.
    const events = [
      event("http_start", 100, { id: "dup", method: "GET", url: "https://api/first" }),
      event("http_start", 400, { id: "dup", method: "GET", url: "https://api/second" }),
      event("nav", 1100, { route: "cart" }),
    ];
    expect(metricsOf(events)["http.stillOpen"]).toBe(1);
    const finding = findingsOf(events, [], 60).find((f) => f.id === "http-still-open");
    expect(finding?.evidence).toMatchObject({ oldestAtLeastMs: 1000, url: "https://api/first" });
  });

  it("counts a background job that never finished", () => {
    const events = [
      event("work_start", 50, { id: "w", name: "SyncCartWorker" }),
      event("nav", 950, { route: "cart" }),
    ];
    const metrics = metricsOf(events);
    expect(metrics["work.runs"]).toBe(1);
    expect(metrics["work.stillOpen"]).toBe(1);
  });

  it("reports the peak recompositions in any one frame", () => {
    const events = [
      event("recompose", 0),
      event("recompose", 1),
      event("recompose", 2),
      event("recompose", 500),
    ];
    const metrics = metricsOf(events);
    expect(metrics["recompose.total"]).toBe(4);
    expect(metrics["recompose.peakPerFrame"]).toBe(3);
  });

  it("gives zero rather than NaN for a run with nothing in it", () => {
    const metrics = metricsOf([]);
    for (const [key, value] of Object.entries(metrics)) {
      expect(Number.isFinite(value), `${key} was ${value}`).toBe(true);
    }
  });
});

describe("findingsOf", () => {
  const find = (events: DeviceEvent[], marks: Array<{ at: number; label: string }> = []) =>
    findingsOf(events, marks, 60);

  it("calls a main-thread query an error, observed", () => {
    const findings = find(span("db", "a", 0, 47, { onMainThread: "true", sql: "SELECT 1" }));
    expect(findings[0]).toMatchObject({
      id: "db-on-main-thread",
      severity: "error",
      confidence: "observed",
    });
  });

  it("says nothing when nothing is wrong", () => {
    expect(find(span("db", "a", 0, 5))).toEqual([]);
  });

  it("orders errors before warnings before notes", () => {
    const events = [
      ...Array.from({ length: 200 }, (_, i) =>
        event("recompose", i, {
          name: "Cart.ItemRow",
          triggeredBy: ["vm.tick"],
        }),
      ),
      event("frame", 5, { missedFrames: 4, totalMs: 80, worstPhase: "layout" }),
      ...span("db", "a", 0, 9, { onMainThread: "true", sql: "SELECT 1" }),
    ];
    expect(find(events).map((f) => f.severity)).toEqual(["error", "warning", "note"]);
  });

  it("only ever calls the recomposition hotspot correlated", () => {
    const events = Array.from({ length: 200 }, (_, i) =>
      event("recompose", i, { name: "Cart.ItemRow", triggeredBy: ["vm.tick"] }),
    );
    const hotspot = find(events).find((f) => f.id === "recompose-hotspot");

    expect(hotspot).toMatchObject({
      severity: "note",
      confidence: "correlated",
    });
    // The wording has to stop short of claiming cause.
    expect(hotspot?.detail).toContain("ordering, not proof");
  });

  it("does not report a hotspot for a handful of recompositions", () => {
    const events = Array.from({ length: 10 }, (_, i) => event("recompose", i, { name: "A" }));
    expect(find(events).some((f) => f.id === "recompose-hotspot")).toBe(false);
  });

  it("names the mark a stall happened under", () => {
    const events = [event("blocked", 500, { durationMs: 400, top: "a.B.c(B.kt:1)" })];
    const marks = [
      { at: 0, label: "open cart" },
      { at: 400, label: "checkout" },
      { at: 900, label: "go back" },
    ];
    expect(find(events, marks)[0].during).toBe("checkout");
  });

  it("leaves the mark off when the run was never marked", () => {
    const events = [event("blocked", 500, { durationMs: 400 })];
    expect(find(events)[0].during).toBeUndefined();
  });

  it("scales the frame budget it quotes to the device", () => {
    const events = [event("frame", 5, { missedFrames: 1, totalMs: 20 })];
    expect(findingsOf(events, [], 120)[0].title).toContain("8.3ms at 120Hz");
    expect(findingsOf(events, [], 60)[0].title).toContain("16.7ms at 60Hz");
  });

  it("reports a blocking collection but not a concurrent one", () => {
    const blocking = [event("gc", 10, { blocking: 1, pausedMs: 30 })];
    const concurrent = [event("gc", 10, { count: 1 })];

    expect(find(blocking).some((f) => f.id === "blocking-gc")).toBe(true);
    expect(find(concurrent).some((f) => f.id === "blocking-gc")).toBe(false);
  });

  it("treats the system asking for memory back as a warning", () => {
    const events = [event("device", 10, { kind: "trimMemory", level: "running critical" })];
    expect(find(events)[0]).toMatchObject({
      id: "trim-memory",
      severity: "warning",
    });
  });

  it("names the calls that were still open, and identifies the oldest", () => {
    const events = [
      event("http_start", 10, { id: "a", method: "POST", url: "https://api.example.com/checkout" }),
      event("http_start", 900, { id: "b", method: "GET", url: "https://api.example.com/sync" }),
      ...span("http", "fine", 0, 50, { status: 200 }),
      event("nav", 5000, { route: "cart" }),
    ];
    const finding = find(events).find((f) => f.id === "http-still-open");

    expect(finding).toMatchObject({ severity: "warning", confidence: "observed", count: 2 });
    expect(finding?.title).toContain("2 HTTP calls were still open when the capture ended");
    expect(finding?.title).toContain("at least 4990ms");
    expect(finding?.detail).toContain("POST https://api.example.com/checkout");
    expect(finding?.evidence).toMatchObject({
      oldestAtLeastMs: 4990,
      method: "POST",
      url: "https://api.example.com/checkout",
    });
  });

  it("says at least, everywhere the number appears", () => {
    // A lower bound presented as a duration is the same defect as clippedMs.
    // Someone copies the number into a bug report; the qualifier has to travel.
    const events = [
      event("http_start", 10, { id: "a", method: "POST", url: "https://api/checkout" }),
      event("nav", 2010, { route: "cart" }),
    ];
    const finding = find(events).find((f) => f.id === "http-still-open");

    expect(finding?.title).toContain("at least 2000ms");
    expect(finding?.detail).toContain("at least, not exactly");
    expect(finding?.detail).toContain("floor under the wait");
  });

  it("agrees in number for a single open call", () => {
    const events = [
      event("http_start", 10, { id: "a", method: "GET", url: "https://api/a" }),
      event("nav", 510, { route: "cart" }),
    ];
    expect(find(events).find((f) => f.id === "http-still-open")?.title).toContain(
      "1 HTTP call was still open",
    );
  });

  it("reports an unfinished query and an unfinished job in their own lanes", () => {
    const events = [
      event("db_start", 10, { id: "q", sql: "SELECT `code` FROM promo_codes WHERE code = ?" }),
      event("work_start", 20, { id: "w", name: "SyncCartWorker" }),
      event("nav", 3010, { route: "cart" }),
    ];
    const findings = find(events);

    expect(findings.find((f) => f.id === "db-still-open")?.detail).toContain("FROM promo_codes");
    expect(findings.find((f) => f.id === "work-still-open")?.detail).toContain("SyncCartWorker");
  });

  it("names the mark the oldest open call started under", () => {
    const events = [
      event("http_start", 500, { id: "a", method: "POST", url: "https://api/checkout" }),
      event("nav", 1200, { route: "cart" }),
    ];
    const marks = [
      { at: 0, label: "open cart" },
      { at: 400, label: "checkout" },
    ];
    expect(find(events, marks).find((f) => f.id === "http-still-open")?.during).toBe("checkout");
  });

  it("says nothing about open spans when everything finished", () => {
    const events = [...span("http", "a", 0, 50, { status: 200 }), ...span("db", "q", 0, 10)];
    expect(find(events).some((f) => f.id.endsWith("-still-open"))).toBe(false);
  });

  it("finds nothing in an empty run", () => {
    expect(find([])).toEqual([]);
  });

  it("still puts errors before the open-span warnings", () => {
    const events = [
      ...span("db", "a", 0, 9, { onMainThread: "true", sql: "SELECT 1" }),
      event("http_start", 10, { id: "hang", method: "POST", url: "https://api/checkout" }),
      event("nav", 900, { route: "cart" }),
    ];
    expect(find(events).map((f) => f.id)).toEqual(["db-on-main-thread", "http-still-open"]);
  });
});

describe("the new metric keys against an older baseline", () => {
  // Lives here rather than in report.test.ts because it is these keys that are
  // on trial: nothing validates TRACE_VERSION on read, so a trace written before
  // this change is compared against one written after, and the pair has to line
  // up rather than reading as a wall of regressions.
  const before = {
    "http.calls": 3,
    "http.failed": 0,
    "http.p95Ms": 300,
    "db.queries": 1,
    "db.p95Ms": 60,
  };
  const after = {
    "http.calls": 7,
    "http.stillOpen": 2,
    "http.failed": 0,
    "http.p95Ms": 300,
    "db.queries": 2,
    "db.stillOpen": 1,
    "db.p95Ms": 60,
    "work.stillOpen": 0,
  };

  it("matches the keys both traces have", () => {
    const changes = compareMetrics(before, after);
    const by = (key: string) => changes.find((c) => c.key === key);

    expect(by("http.p95Ms")).toMatchObject({ before: 300, after: 300, kind: "unchanged" });
    // Counting the hangs moves the call count, and it should: the baseline's 3
    // was an undercount, not a better run.
    expect(by("http.calls")).toMatchObject({ before: 3, after: 7, kind: "regressed" });
  });

  it("treats a key the baseline never had as absent, not as zero noise", () => {
    const changes = compareMetrics(before, after);
    const by = (key: string) => changes.find((c) => c.key === key);

    // A first hang is categorical, and "new" is exactly how compare reports one.
    expect(by("http.stillOpen")).toMatchObject({ before: 0, after: 2, kind: "new" });
    // And a lane with no hang stays quiet rather than inventing a row.
    expect(by("work.stillOpen")).toMatchObject({ kind: "unchanged" });
  });
});
