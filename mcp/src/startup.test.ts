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
    originKind: "fork",
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

/** A warm/hot-shaped fixture: no `onCreate*`, `originKind: "activity"` — see StartupCollector.kt's `onPendingLaunchFrame`. */
function relaunchEvent(over: Record<string, unknown> = {}): DeviceEvent {
  return startupEvent({
    classification: "hot",
    originKind: "activity",
    originAssumed: true,
    onCreateEntryMs: undefined,
    onCreateExitMs: undefined,
    activityOnCreateMs: undefined,
    reportFullyDrawnMs: undefined,
    ...over,
  });
}

describe("startupFindingsOf: no startup event", () => {
  it("returns nothing when the window carries no startup event at all", () => {
    expect(startupFindingsOf([event("mark", 10, { label: "x" })], [])).toEqual([]);
  });
});

describe("startupFindingsOf: startup-slow (cold only — QA 60-C)", () => {
  it("says nothing for a launch under the cold threshold", () => {
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
      id: "startup-slow-0",
      severity: "warning",
      confidence: "observed",
      window: { from: 0, to: 5_500 },
    });
    expect(findings[0].title).toContain("cold startup took 5500ms");
  });

  // QA 60-C: applying vitals' warm/hot lines to an activity-origin span
  // compares two different spans as if they were the same one — the
  // emulator's own HOT TotalTime 207 vs totalMs 3 for the identical
  // relaunch. No startup-slow for warm/hot at all, regardless of totalMs.
  it("never fires for a warm launch, no matter how large totalMs is", () => {
    const warm = relaunchEvent({
      classification: "warm",
      activityOnCreateMs: 1_120,
      originMs: 0,
      firstFrameMs: 999_999,
      totalMs: 999_999,
    });
    expect(startupFindingsOf([warm], [])).toEqual([]);
  });

  it("never fires for a hot launch, no matter how large totalMs is", () => {
    const hot = relaunchEvent({ originMs: 0, firstFrameMs: 999_999, totalMs: 999_999 });
    expect(startupFindingsOf([hot], [])).toEqual([]);
  });

  it("an event with no originKind at all (pre-60-C schema) still defaults to fork and gets judged cold", () => {
    const legacy = startupEvent({ originMs: 0, firstFrameMs: 5_500, totalMs: 5_500, originKind: undefined });
    expect(startupFindingsOf([legacy], []).map((f) => f.id)).toEqual(["startup-slow-0"]);
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
    const startupSlow = findings.find((f) => f.id.startsWith("startup-slow"))!;
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
    expect(findings.find((f) => f.id.startsWith("startup-slow"))?.evidence?.crossReferenced).toEqual([
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
    expect(findings.find((f) => f.id.startsWith("startup-slow"))?.evidence?.crossReferenced).toEqual([]);
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
    expect(findings.find((f) => f.id.startsWith("startup-slow"))?.evidence?.crossReferenced).toEqual([]);
  });
});

describe("startupFindingsOf: startup-not-fully-drawn (cold only — QA 60-B)", () => {
  it("notes it once when reportFullyDrawn was never observed on the cold launch", () => {
    const findings = startupFindingsOf([startupEvent({ reportFullyDrawnMs: undefined })], []);
    const note = findings.find((f) => f.id === "startup-not-fully-drawn");
    expect(note).toMatchObject({ severity: "note", confidence: "observed" });
  });

  it("says nothing when reportFullyDrawn was observed on the cold launch", () => {
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

  it("says nothing for a warm/hot launch that never carries reportFullyDrawnMs — QA 60-B's own regression", () => {
    // Before the fix, a hot event with no reportFullyDrawnMs (which it
    // structurally never carries unless the app reports inside the very
    // short window before its ending frame) produced this note on its own,
    // which is exactly the false accusation QA caught.
    const hot = relaunchEvent();
    expect(startupFindingsOf([hot], [])).toEqual([]);
  });
});

// QA 60-A: the bug itself — a slow cold launch's finding must survive any
// number of later relaunches, not just be visible when it happens to be the
// newest `startup` event.
describe("startupFindingsOf: every launch in the window is judged, not only the newest — QA 60-A", () => {
  it("a slow cold launch alone produces startup-slow", () => {
    const cold = startupEvent({ originMs: 0, firstFrameMs: 8_000, totalMs: 8_000 });
    expect(startupFindingsOf([cold], []).map((f) => f.id)).toEqual(["startup-slow-0"]);
  });

  it("QA's own repro: cold (8000ms, slow) + a later 3ms hot event must still report startup-slow, not just startup-not-fully-drawn", () => {
    const cold = startupEvent({ originMs: 0, firstFrameMs: 8_000, totalMs: 8_000 });
    const hot = relaunchEvent({ originMs: 20_000, firstFrameMs: 20_003, totalMs: 3 });
    const findings = startupFindingsOf([cold, hot], []);
    const ids = findings.map((f) => f.id);
    expect(ids).toContain("startup-slow-0");
    // The hot launch contributes nothing here — no slow (60-C, not a fork
    // origin) and no not-fully-drawn note (60-B, not the cold launch).
    expect(ids).not.toContain("startup-not-fully-drawn");
    expect(ids).toEqual(["startup-slow-0"]);
  });

  it("two slow cold launches in one window (a reinstall between them, say) produce two distinct findings, not a collision", () => {
    const first = startupEvent({ originMs: 0, firstFrameMs: 6_000, totalMs: 6_000 });
    const second = startupEvent({ originMs: 100_000, firstFrameMs: 107_000, totalMs: 7_000 });
    const findings = startupFindingsOf([first, second], []);
    expect(findings.map((f) => f.id).sort()).toEqual(["startup-slow-0", "startup-slow-100000"]);
  });

  it("cold with reportFullyDrawnMs, then a later hot event — no not-fully-drawn note (QA 60-B's exact test)", () => {
    const cold = startupEvent({ reportFullyDrawnMs: 1_300 });
    const hot = relaunchEvent({ originMs: 20_000, firstFrameMs: 20_003, totalMs: 3 });
    const findings = startupFindingsOf([cold, hot], []);
    expect(findings.find((f) => f.id === "startup-not-fully-drawn")).toBeUndefined();
  });

  it("each launch's cross-reference is scoped to its own window, not the whole event list", () => {
    const cold = startupEvent({ originMs: 0, firstFrameMs: 6_000, totalMs: 6_000 });
    const laterCold = startupEvent({ originMs: 100_000, firstFrameMs: 107_000, totalMs: 7_000 });
    // Falls inside `cold`'s window only.
    const dbFinding: Finding = {
      id: "db-on-main-thread",
      severity: "error",
      confidence: "observed",
      title: "1 database query ran on the main thread",
      window: { from: 3_000, to: 3_200 },
    };
    const findings = startupFindingsOf([cold, laterCold], [dbFinding]);
    const firstFinding = findings.find((f) => f.id === "startup-slow-0")!;
    const secondFinding = findings.find((f) => f.id === "startup-slow-100000")!;
    expect(firstFinding.evidence?.crossReferenced).toEqual(["db-on-main-thread"]);
    expect(secondFinding.evidence?.crossReferenced).toEqual([]);
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
    expect(ids).toContain("startup-slow-0");
    const startupSlow = findings.find((f) => f.id === "startup-slow-0")!;
    expect(startupSlow.evidence?.crossReferenced).toEqual(["db-on-main-thread"]);
  });
});
