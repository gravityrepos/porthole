// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { DeviceEvent } from "./device.js";
import type { Finding } from "./trace.js";
import { findingsOf } from "./trace.js";
import { reconcileStartupWithTrace, startupFindingsOf } from "./startup.js";

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

// GRA-231: reconcileStartupWithTrace — the two independent measurements of
// the same launch (Perfetto's own `trace-startup`, perfetto.ts#interpret,
// and the runtime's `startup` event above) told about each other.
describe("reconcileStartupWithTrace", () => {
  /** Shaped the way `interpret()`'s own `trace-startup` block (perfetto.ts) builds one. */
  function traceStartupFinding(over: Partial<Finding> & { durMs: number }): Finding {
    const { durMs, ...rest } = over;
    return {
      id: "trace-startup",
      severity: durMs >= 500 ? "warning" : "note",
      confidence: "observed",
      title: `cold start took ${durMs}ms`,
      detail: "No single reason dominated the platform's own breakdown of it.",
      count: 1,
      evidence: { durMs, startupType: "cold", reasons: {} },
      window: { from: 1_000, to: 1_000 + durMs },
      ...rest,
    };
  }

  it("no trace-startup finding at all: returns the findings untouched", () => {
    const other: Finding = { id: "trace-jank", severity: "warning", confidence: "observed", title: "x", spanning: true };
    const result = reconcileStartupWithTrace([other], [startupEvent()]);
    expect(result).toEqual([other]);
  });

  it("a trace-startup finding but no runtime startup event at all: unchanged, no note", () => {
    const finding = traceStartupFinding({ durMs: 900 });
    const result = reconcileStartupWithTrace([finding], [event("mark", 10, { label: "x" })]);
    expect(result).toEqual([finding]);
  });

  it("a runtime startup event exists but its window does not overlap the trace finding's: unchanged, no note", () => {
    const finding = traceStartupFinding({ durMs: 900, window: { from: 1_000, to: 1_900 } });
    const runtime = startupEvent({ originMs: 50_000, firstFrameMs: 51_000, totalMs: 1_000 });
    const result = reconcileStartupWithTrace([finding], [runtime]);
    expect(result).toEqual([finding]);
  });

  it("overlapping match, plausible gap: attaches runtime evidence and phases, no note added", () => {
    // Trace times from the launch request (earlier), runtime from the fork —
    // gap of 40ms, well inside the 5000ms bound.
    const finding = traceStartupFinding({ durMs: 1_300, window: { from: 1_000, to: 2_300 } });
    const runtime = startupEvent({
      originMs: 1_000,
      onCreateEntryMs: 1_005,
      onCreateExitMs: 1_040,
      activityOnCreateMs: 1_120,
      activityOnStartMs: 1_150,
      activityOnResumeMs: 1_170,
      firstFrameMs: 2_260,
      totalMs: 1_260,
    });
    const result = reconcileStartupWithTrace([finding], [runtime]);
    expect(result).toHaveLength(1);
    const reconciled = result[0];
    expect(reconciled.evidence?.runtimeTotalMs).toBe(1_260);
    expect(reconciled.evidence?.runtimeOriginKind).toBe("fork");
    expect(reconciled.evidence?.gapMs).toBe(40); // 1300 - 1260
    // Original evidence (durMs, startupType, reasons) survives the merge.
    expect(reconciled.evidence?.durMs).toBe(1_300);
    expect(reconciled.evidence?.runtimePhases).toEqual([
      { name: "fork", atMs: 1_000 },
      { name: "onCreateEntry", atMs: 1_005 },
      { name: "onCreateExit", atMs: 1_040 },
      { name: "activityOnCreate", atMs: 1_120 },
      { name: "activityOnStart", atMs: 1_150 },
      { name: "activityOnResume", atMs: 1_170 },
      { name: "firstFrame", atMs: 2_260 },
      { name: "reportFullyDrawn", atMs: 1_300 }, // default fixture value, see startupEvent()
    ]);
    // Mutation check: no reconciliation note fires for a plausible gap.
    expect(result.some((f) => f.id.startsWith("startup-reconciliation-"))).toBe(false);
  });

  it("a warm/hot runtime event labels its origin phase activityOrigin, not fork", () => {
    const finding = traceStartupFinding({ durMs: 30, window: { from: 20_000, to: 20_030 } });
    const runtime = relaunchEvent({ originMs: 20_000, firstFrameMs: 20_003, totalMs: 3 });
    const result = reconcileStartupWithTrace([finding], [runtime]);
    const phases = result[0].evidence?.runtimePhases as Array<{ name: string; atMs: number }>;
    expect(phases[0]).toEqual({ name: "activityOrigin", atMs: 20_000 });
  });

  it("negative gap (runtime claims more time than the trace): implausible, emits one note naming both numbers", () => {
    // Trace says 200ms; runtime, for the "same" launch, says 900ms — the
    // later-origin runtime total can never legitimately exceed the
    // earlier-origin trace total.
    const finding = traceStartupFinding({ durMs: 200, window: { from: 1_000, to: 1_200 } });
    const runtime = startupEvent({ originMs: 1_000, firstFrameMs: 1_900, totalMs: 900 });
    const result = reconcileStartupWithTrace([finding], [runtime]);
    expect(result).toHaveLength(2);
    const note = result.find((f) => f.id === "startup-reconciliation-1000")!;
    expect(note.severity).toBe("note");
    expect(note.title).toContain("200ms");
    expect(note.title).toContain("900ms");
    expect(note.evidence?.gapMs).toBe(-700);
  });

  it("gap past the bound (5000ms, reused from the cold-slow threshold): implausible, emits one note", () => {
    const finding = traceStartupFinding({ durMs: 6_500, window: { from: 0, to: 6_500 } });
    const runtime = startupEvent({ originMs: 0, firstFrameMs: 1_000, totalMs: 1_000 });
    const result = reconcileStartupWithTrace([finding], [runtime]);
    const note = result.find((f) => f.id === "startup-reconciliation-0")!;
    expect(note.evidence?.gapMs).toBe(5_500);
    expect(note.detail).toContain("5500ms");
    expect(note.window).toEqual(finding.window);
  });

  it("gap right at the bound is still plausible: no note (boundary, not strictly-past)", () => {
    const finding = traceStartupFinding({ durMs: 6_000, window: { from: 0, to: 6_000 } });
    const runtime = startupEvent({ originMs: 0, firstFrameMs: 1_000, totalMs: 1_000 });
    const result = reconcileStartupWithTrace([finding], [runtime]);
    expect(result).toHaveLength(1); // gapMs === 5000, not > 5000
    expect(result[0].evidence?.gapMs).toBe(5_000);
  });

  it("two separate launches in the window: each trace-startup finding reconciles against its own runtime event only", () => {
    const first = traceStartupFinding({ durMs: 300, window: { from: 0, to: 300 } });
    const second = traceStartupFinding({ durMs: 5, window: { from: 20_000, to: 20_005 } });
    const runtimeFirst = startupEvent({ originMs: 0, firstFrameMs: 260, totalMs: 260 });
    const runtimeSecond = relaunchEvent({ originMs: 20_000, firstFrameMs: 20_003, totalMs: 3 });
    const result = reconcileStartupWithTrace([first, second], [runtimeFirst, runtimeSecond]);
    expect(result).toHaveLength(2);
    expect(result[0].evidence?.runtimeTotalMs).toBe(260);
    expect(result[1].evidence?.runtimeTotalMs).toBe(3);
  });
});
