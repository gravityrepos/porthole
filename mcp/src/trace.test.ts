// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { DeviceEvent } from "./device.js";
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
});
