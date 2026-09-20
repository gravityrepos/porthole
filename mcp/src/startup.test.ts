// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { DeviceEvent } from "./device.js";
import type { Finding } from "./trace.js";
import { findingsOf } from "./trace.js";
import { startupFindingsOf } from "./startup.js";

function event(name: string, t: number, data: Record<string, unknown> = {}): DeviceEvent {
  return { event: name, t, seq: t, data };
}

/** A `startup` event shaped the way `StartupAssembly.toEvent` on the runtime side builds one. */
function startupEvent(over: Record<string, unknown> = {}): DeviceEvent {
  return event("startup", over.firstFrameMs != null ? Number(over.firstFrameMs) : 1_260, {
    classification: "cold",
    originMs: 1_000,
    originAssumed: false,
    onCreateEntryMs: 1_005,
    onCreateExitMs: 1_040,
    activityOnCreateMs: 1_120,
    activityOnStartMs: 1_150,
    activityOnResumeMs: 1_170,
    firstFrameMs: 1_260,
    totalMs: 260,
    dominantPhase: "activityOnResume->firstFrame",
    // A default fixture is a launch that did everything right; each test
    // below overrides only the field its own scenario is about, so a
    // `startup-not-fully-drawn` note never sneaks into an assertion that
    // is not testing for it.
    reportFullyDrawnMs: 1_300,
    ...over,
  });
}

describe("startupFindingsOf: no startup event", () => {
  it("returns nothing when the window carries no startup event at all", () => {
    expect(startupFindingsOf([event("mark", 10, { label: "x" })], [])).toEqual([]);
  });
});

describe("startupFindingsOf: startup-slow", () => {
  it("says nothing for a launch under its own classification's threshold", () => {
    // 260ms total, cold threshold is 5000ms.
    expect(startupFindingsOf([startupEvent()], [])).toEqual([]);
  });

  it("fires for a cold launch over 5000ms — Android vitals' own line", () => {
    const findings = startupFindingsOf(
      [startupEvent({ originMs: 0, firstFrameMs: 5_500, totalMs: 5_500 })],
      [],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "startup-slow",
      severity: "warning",
      confidence: "observed",
      window: { from: 0, to: 5_500 },
    });
    expect(findings[0].title).toContain("cold startup took 5500ms");
  });

  it("uses the warm threshold (2000ms), not the cold one, for a warm launch", () => {
    const warm = startupEvent({
      classification: "warm",
      originMs: 0,
      onCreateEntryMs: undefined,
      onCreateExitMs: undefined,
      firstFrameMs: 2_500,
      totalMs: 2_500,
    });
    // 2500ms is under cold's 5000ms threshold but over warm's 2000ms one —
    // the whole point of per-classification thresholds.
    const findings = startupFindingsOf([warm], []);
    expect(findings.map((f) => f.id)).toContain("startup-slow");
  });

  it("uses the hot threshold (1500ms) for a hot launch", () => {
    const hot = startupEvent({
      classification: "hot",
      originMs: 0,
      onCreateEntryMs: undefined,
      onCreateExitMs: undefined,
      activityOnCreateMs: undefined,
      activityOnStartMs: undefined,
      firstFrameMs: 1_600,
      totalMs: 1_600,
    });
    const findings = startupFindingsOf([hot], []);
    expect(findings.map((f) => f.id)).toContain("startup-slow");
  });

  // EM's own note: "keep the cross-reference of db-on-main and main-thread
  // findings inside the startup window — the cheapest and most valuable
  // bullet in the ticket."
  it("cross-references a db-on-main-thread finding that falls inside the startup window", () => {
    const slow = startupEvent({ originMs: 0, firstFrameMs: 6_000, totalMs: 6_000 });
    const dbFinding: Finding = {
      id: "db-on-main-thread",
      severity: "error",
      confidence: "observed",
      title: "1 database query ran on the main thread",
      window: { from: 3_000, to: 3_200 },
    };
    const findings = startupFindingsOf([slow], [dbFinding]);
    const startupSlow = findings.find((f) => f.id === "startup-slow")!;
    expect(startupSlow.detail).toContain("1 database query ran on the main thread");
    expect(startupSlow.evidence?.crossReferenced).toEqual(["db-on-main-thread"]);
  });

  it("cross-references a main-thread-stall finding the same way", () => {
    const slow = startupEvent({ originMs: 0, firstFrameMs: 6_000, totalMs: 6_000 });
    const stall: Finding = {
      id: "main-thread-stall",
      severity: "error",
      confidence: "observed",
      title: "main thread blocked for 400ms",
      window: { from: 5_000, to: 5_400 },
    };
    const findings = startupFindingsOf([slow], [stall]);
    expect(findings.find((f) => f.id === "startup-slow")?.evidence?.crossReferenced).toEqual([
      "main-thread-stall",
    ]);
  });

  it("does not cross-reference a finding outside the startup window", () => {
    const slow = startupEvent({ originMs: 0, firstFrameMs: 6_000, totalMs: 6_000 });
    const laterStall: Finding = {
      id: "main-thread-stall",
      severity: "error",
      confidence: "observed",
      title: "main thread blocked for 400ms",
      window: { from: 9_000, to: 9_400 },
    };
    const findings = startupFindingsOf([slow], [laterStall]);
    expect(findings.find((f) => f.id === "startup-slow")?.evidence?.crossReferenced).toEqual([]);
  });

  it("does not cross-reference a finding of some other id, even inside the window", () => {
    const slow = startupEvent({ originMs: 0, firstFrameMs: 6_000, totalMs: 6_000 });
    const frameDrop: Finding = {
      id: "frames-dropped",
      severity: "warning",
      confidence: "observed",
      title: "3 frames missed their deadline",
      window: { from: 3_000, to: 3_200 },
    };
    const findings = startupFindingsOf([slow], [frameDrop]);
    expect(findings.find((f) => f.id === "startup-slow")?.evidence?.crossReferenced).toEqual([]);
  });
});

describe("startupFindingsOf: startup-not-fully-drawn", () => {
  it("notes it once when reportFullyDrawn was never observed", () => {
    const findings = startupFindingsOf([startupEvent({ reportFullyDrawnMs: undefined })], []);
    const note = findings.find((f) => f.id === "startup-not-fully-drawn");
    expect(note).toMatchObject({ severity: "note", confidence: "observed" });
  });

  it("says nothing when reportFullyDrawn was observed", () => {
    const findings = startupFindingsOf([startupEvent({ reportFullyDrawnMs: 1_900 })], []);
    expect(findings.find((f) => f.id === "startup-not-fully-drawn")).toBeUndefined();
  });

  it("says nothing before the first frame has even happened — too early to call it a note", () => {
    const findings = startupFindingsOf(
      [event("startup", 1_040, { classification: "cold", originMs: 1_000, onCreateEntryMs: 1_005, onCreateExitMs: 1_040 })],
      [],
    );
    expect(findings).toEqual([]);
  });
});

// findingsOf itself: proves the wiring in trace.ts actually calls startupFindingsOf,
// not only that startup.ts's own function is correct in isolation.
describe("findingsOf includes startup findings (trace.ts wiring)", () => {
  it("a slow cold startup event alongside a db-on-main-thread query produces both findings, cross-referenced", () => {
    const dbSpan = [
      event("db_start", 3_000, { id: "a" }),
      event("db_end", 3_200, { id: "a", onMainThread: "true", sql: "SELECT 1" }),
    ];
    const events = [...dbSpan, startupEvent({ originMs: 0, firstFrameMs: 6_000, totalMs: 6_000 })];
    const findings = findingsOf(events, [], 60);
    const ids = findings.map((f) => f.id);
    expect(ids).toContain("db-on-main-thread");
    expect(ids).toContain("startup-slow");
    const startupSlow = findings.find((f) => f.id === "startup-slow")!;
    expect(startupSlow.evidence?.crossReferenced).toEqual(["db-on-main-thread"]);
  });
});
