// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DeviceEvent } from "./device.js";
import { compareMetrics } from "./report.js";
import { resetSourceIndexForTests } from "./sources.js";
import { currentSourceFingerprint, resetComposeReportCacheForTests } from "./composeReport.js";
import {
  alsoInWindowOf,
  alsoInWindowSentence,
  buildTrace,
  describeBudget,
  findingsOf,
  frameBudgetMs,
  metricsOf,
  resolveProfile,
} from "./trace.js";

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

describe("describeBudget", () => {
  it("names the Hz when the profile was actually observed", () => {
    expect(describeBudget({ refreshHz: 120, assumed: false })).toBe("8.3ms at 120Hz");
  });

  it("flags a guess as a guess rather than printing it as fact (GRA-185)", () => {
    expect(describeBudget({ refreshHz: 60, assumed: true })).toBe(
      "16.7ms (assumed 60Hz; no display profile seen)",
    );
  });
});

// GRA-185: `findings` used to derive the device profile from a `device`
// event found *inside the window being asked about*, which silently fell
// back to 60Hz the moment a window started after `DeviceCollector`'s one
// startup profile event — exactly the device pass's own reproduction (a
// 120Hz panel reporting "budget 16.7ms at 60Hz" for a window minutes into
// the session). `resolveProfile` is the one place this is decided now, and
// every caller resolves it through this function rather than its own copy.
describe("resolveProfile", () => {
  const profileEvent = (t: number, over: Record<string, unknown> = {}): DeviceEvent =>
    event("device", t, {
      kind: "profile",
      model: "Pixel 9 Pro Fold",
      sdkInt: 37,
      abi: "arm64-v8a",
      cores: 8,
      deviceRamMb: 12_288,
      refreshHz: 120,
      lowRamDevice: "false",
      ...over,
    });

  it("falls back to assumed 60Hz when no profile is seen anywhere (missing-input case)", () => {
    const resolved = resolveProfile({ liveEvents: [], windowTo: 10_000, sessionProfile: null, hello: null });
    expect(resolved).toEqual({ assumed: true, refreshHz: 60 });
  });

  it("finds a live-buffer profile at or before the window's end regardless of the window's start — the GRA-185 bug", () => {
    // The startup profile fired at t=0; the window being asked about starts
    // long after it. The old code searched only the *windowed* events and
    // missed this; `liveEvents` here is the whole ring, unfiltered by `from`.
    const resolved = resolveProfile({
      liveEvents: [profileEvent(0)],
      windowTo: 400_300,
      sessionProfile: null,
      hello: null,
    });
    expect(resolved).toMatchObject({ assumed: false, refreshHz: 120 });
  });

  it("ignores a profile event after the window's end and falls through instead of using it", () => {
    const resolved = resolveProfile({
      liveEvents: [profileEvent(9_000)],
      windowTo: 5_000,
      sessionProfile: null,
      hello: null,
    });
    expect(resolved).toEqual({ assumed: true, refreshHz: 60 });
  });

  it("falls back to the session's own meta.json profile when the live buffer has none (profile only on disk)", () => {
    const sessionProfile = {
      model: "Pixel 9 Pro Fold",
      sdkInt: 37,
      abi: "arm64-v8a",
      cores: 8,
      deviceRamMb: 12_288,
      refreshHz: 120,
      lowRamDevice: false,
    };
    const resolved = resolveProfile({ liveEvents: [], windowTo: 10_000, sessionProfile, hello: null });
    expect(resolved).toEqual({ assumed: false, refreshHz: 120, full: sessionProfile });
  });

  it("prefers the live buffer's profile over the session's disk one when both exist", () => {
    const onDisk = {
      model: "old",
      sdkInt: 30,
      abi: "x",
      cores: 4,
      deviceRamMb: 4_096,
      refreshHz: 60,
      lowRamDevice: false,
    };
    const resolved = resolveProfile({
      liveEvents: [profileEvent(0)],
      windowTo: 10_000,
      sessionProfile: onDisk,
      hello: null,
    });
    expect(resolved.refreshHz).toBe(120);
  });

  it("takes the most recent of several live profile events at or before the window's end", () => {
    const resolved = resolveProfile({
      liveEvents: [profileEvent(0, { refreshHz: 60 }), profileEvent(1_000, { refreshHz: 90 })],
      windowTo: 5_000,
      sessionProfile: null,
      hello: null,
    });
    expect(resolved.refreshHz).toBe(90);
  });
});

// GRA-185: the same reproduction end to end — `buildTrace` fed a windowed
// event list that does not itself contain the startup profile, exactly what
// `findings` hands it once a window starts after startup, must still report
// the real refresh rate once the profile is resolved through the live
// buffer rather than through `events` alone.
describe("buildTrace resolves the profile it is handed, not one it goes looking for", () => {
  it("keeps the observed refresh rate when the window misses the profile event but the live buffer has it", () => {
    const profile = event("device", 0, {
      kind: "profile",
      model: "Pixel 9 Pro Fold",
      sdkInt: 37,
      refreshHz: 120,
      lowRamDevice: "false",
    });
    const windowed = [event("frame", 400_300, { missedFrames: 1, totalMs: 20 })];
    const resolved = resolveProfile({
      liveEvents: [profile, ...windowed],
      windowTo: 400_300,
      sessionProfile: null,
      hello: null,
    });

    const trace = buildTrace({
      scenario: "live",
      events: windowed, // the merged/windowed view findings hands buildTrace — no profile event in it
      hello: null,
      durationMs: 300,
      withEvents: false,
      profile: resolved,
    });

    expect(trace.device.refreshHz).toBe(120);
    expect(trace.findings[0].title).toContain("8.3ms at 120Hz");
    expect(trace.findings[0].confidence).toBe("observed");
  });

  it("marks the budget assumed, not observed, when nothing resolved a real profile", () => {
    const windowed = [event("frame", 5, { missedFrames: 1, totalMs: 20 })];
    const resolved = resolveProfile({ liveEvents: [], windowTo: 5, sessionProfile: null, hello: null });

    const trace = buildTrace({
      scenario: "live",
      events: windowed,
      hello: null,
      durationMs: 5,
      withEvents: false,
      profile: resolved,
    });

    expect(trace.findings[0].confidence).toBe("correlated");
    expect(trace.findings[0].title).toContain("assumed 60Hz; no display profile seen");
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

  // GRA-185: `assumed` defaults to false, so every call above (a bare
  // refresh rate, no opinion on how it was derived) keeps reading as
  // observed — this pins the default itself, not merely the true/false
  // branches, so a signature change that silently flipped the default
  // would fail here.
  it("defaults `assumed` to false — a bare refreshHz still reads as observed", () => {
    const events = [event("frame", 5, { missedFrames: 1, totalMs: 20 })];
    expect(findingsOf(events, [], 60)[0].confidence).toBe("observed");
  });

  it("reports the frame budget as a guess, correlated not observed, when the refresh rate is assumed", () => {
    const events = [event("frame", 5, { missedFrames: 1, totalMs: 20 })];
    const findings = findingsOf(events, [], 60, true);
    expect(findings[0].confidence).toBe("correlated");
    expect(findings[0].title).toContain("assumed 60Hz; no display profile seen");
    expect(findings[0].title).not.toContain("at 60Hz)");
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

  // exit-findings (GRA-58): one finding per reason class, matching the
  // ticket's own severity table.
  describe("exit events", () => {
    const exitEvent = (reason: string, extra: Record<string, unknown> = {}) =>
      event("exit", 1000, { reason, timestamp: 1_700_000_000_000, ...extra });

    it.each([
      "REASON_ANR",
      "REASON_CRASH",
      "REASON_CRASH_NATIVE",
      "REASON_LOW_MEMORY",
      "REASON_EXCESSIVE_RESOURCE_USAGE",
    ])("calls %s an error, observed", (reason) => {
      const findings = find([exitEvent(reason)]);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: "error", confidence: "observed" });
      expect(findings[0].title).toContain(reason);
    });

    it("calls a user-requested exit a note", () => {
      const findings = find([exitEvent("REASON_USER_REQUESTED")]);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("note");
    });

    // GRA-113: exit.t is stamped in the *next* process's uptime clock, not
    // the dead one's — so unlike every other finding here, this is spanning
    // rather than windowed, and says so in the detail rather than silently.
    it("is spanning, not windowed — exit.t belongs to the process reporting the death, not the one that died", () => {
      const findings = find([exitEvent("REASON_ANR")]);
      expect(findings[0].spanning).toBe(true);
      expect(findings[0].window).toBeUndefined();
      expect(findings[0].detail).toContain("predates this process's uptime clock");
    });

    it("keeps a real description alongside the predates-uptime-clock note, rather than replacing it", () => {
      const findings = find([exitEvent("REASON_CRASH", { description: "NullPointerException: cart was null" })]);
      expect(findings[0].detail).toContain("NullPointerException: cart was null");
      expect(findings[0].detail).toContain("predates this process's uptime clock");
    });

    it.each(["REASON_OTHER", "REASON_SIGNALED"])(
      "produces no finding at all for %s",
      (reason) => {
        expect(find([exitEvent(reason)])).toEqual([]);
      },
    );

    it("names the reason, the build, and the top app frame", () => {
      const findings = find([
        exitEvent("REASON_ANR", {
          versionName: "1.2.3",
          versionAssumed: false,
          mainStack: "com.example.shop.Cart.load(Cart.kt:9)\nandroid.app.Activity.performCreate(Activity.java:1)",
        }),
      ]);
      expect(findings[0].title).toContain("REASON_ANR");
      expect(findings[0].title).toContain("1.2.3");
      expect(findings[0].title).toContain("com.example.shop.Cart.load(Cart.kt:9)");
      expect(findings[0].title).not.toContain("(assumed)");
    });

    it("marks an assumed version rather than presenting it as certain", () => {
      const findings = find([exitEvent("REASON_CRASH", { versionName: "9.9.9", versionAssumed: true })]);
      expect(findings[0].title).toContain("9.9.9 (assumed)");
    });

    it("says an unknown build rather than omitting the clause", () => {
      const findings = find([exitEvent("REASON_CRASH")]);
      expect(findings[0].title).toContain("an unknown build");
    });

    it("still sorts an exit error before a note", () => {
      const findings = find([
        exitEvent("REASON_USER_REQUESTED", { timestamp: 1 }),
        exitEvent("REASON_ANR", { timestamp: 2 }),
      ]);
      expect(findings.map((f) => f.severity)).toEqual(["error", "note"]);
    });
  });

  // GRA-59: StrictModeCollector already did the filtering (only a violation
  // whose stack touched the app's own package became an event at all) and
  // the counting (a flood at one site is a handful of events, not one per
  // violation). findingsOf's own job is picking the highest-count event per
  // site and mapping its category to a severity — a fixture event in, a
  // finding with the right severity out.
  describe("strict-mode violations (GRA-59)", () => {
    function strictEvent(overrides: Record<string, unknown> = {}, t = 100) {
      return event("strict_violation", t, {
        category: "main_thread_disk",
        type: "DiskWriteViolation",
        thread: "main",
        site: "com.example.shop.CartAdapter.onBindViewHolder:88",
        count: 1,
        stack: "com.example.shop.CartAdapter.onBindViewHolder(CartAdapter.kt:88)\nandroid.os.StrictMode.foo",
        ...overrides,
      });
    }

    it("calls a main-thread disk violation an error", () => {
      const findings = find([strictEvent({ category: "main_thread_disk" })]);
      expect(findings[0]).toMatchObject({ severity: "error", confidence: "observed" });
    });

    it("calls a main-thread network violation an error", () => {
      const findings = find([strictEvent({ category: "main_thread_network", type: "NetworkViolation" })]);
      expect(findings[0].severity).toBe("error");
    });

    it("calls a leak a warning", () => {
      const findings = find([strictEvent({ category: "leak", type: "LeakedClosableViolation" })]);
      expect(findings[0].severity).toBe("warning");
    });

    it("calls everything else a note", () => {
      const findings = find([strictEvent({ category: "other", type: "UntaggedSocketViolation" })]);
      expect(findings[0].severity).toBe("note");
    });

    it("names the call site and the violation type in the title", () => {
      const findings = find([strictEvent()]);
      expect(findings[0].title).toContain("DiskWriteViolation");
      expect(findings[0].title).toContain("com.example.shop.CartAdapter.onBindViewHolder:88");
    });

    it("collapses repeated updates for the same site into one finding, keeping the highest count", () => {
      const findings = find([
        strictEvent({ count: 1 }, 100),
        strictEvent({ count: 50 }, 150),
        strictEvent({ count: 200 }, 400),
      ]);
      const strict = findings.filter((f) => f.id.startsWith("strict-"));
      expect(strict).toHaveLength(1);
      expect(strict[0].count).toBe(200);
      expect(strict[0].title).toContain("200×");
    });

    it("keeps two different call sites as two separate findings", () => {
      const findings = find([
        strictEvent({ site: "a.B.c:1" }),
        strictEvent({ site: "a.B.d:2" }),
      ]);
      const strict = findings.filter((f) => f.id.startsWith("strict-"));
      expect(strict).toHaveLength(2);
    });

    it("says nothing when there is no strict-mode event at all", () => {
      expect(find([event("recompose", 0)]).some((f) => f.id.startsWith("strict-"))).toBe(false);
    });
  });
});

describe("findingsOf: http-call-slow (GRA-66)", () => {
  const find = (events: DeviceEvent[]) => findingsOf(events, [], 60);

  /** A completed http span carrying OkHttpPorthole's own `http_end` shape. */
  function slowCall(
    ms: number,
    over: Record<string, unknown> = {},
  ): DeviceEvent[] {
    return span("http", "a", 0, ms, {
      method: "GET",
      url: "https://api.example.com/cart",
      status: 200,
      ...over,
    });
  }

  it("says nothing for a call under the threshold", () => {
    expect(find(slowCall(2_999)).some((f) => f.id === "http-call-slow")).toBe(false);
  });

  it("fires at the threshold and above, at warning, observed", () => {
    const finding = find(slowCall(3_000)).find((f) => f.id === "http-call-slow");
    expect(finding).toMatchObject({ severity: "warning", confidence: "observed" });
  });

  it("attributes to the phase with the largest duration", () => {
    const events = slowCall(4_000, {
      phases: { dns: 20, connect: 30, requestHeaders: 5, responseHeaders: 3_900, responseBody: 45 },
    });
    const finding = find(events).find((f) => f.id === "http-call-slow");
    expect(finding?.title).toContain("mostly responseHeaders");
    expect(finding?.title).not.toContain("largest phase");
    expect(finding?.detail).toContain("3900ms of 4000ms was responseHeaders");
    expect(finding?.evidence?.dominantPhase).toBe("responseHeaders");
    expect(finding?.evidence?.phases).toEqual({
      dns: 20,
      connect: 30,
      requestHeaders: 5,
      responseHeaders: 3_900,
      responseBody: 45,
    });
  });

  // H1 QA nit: phases need not sum to elapsedMs at all -- queueing
  // (dispatcher contention, a connection-pool wait) is real time the
  // EventListener has no callback for, so a "dominant" phase can be the
  // largest of several small numbers without explaining the call at all.
  // "mostly" is reserved for when it actually is most of the call.
  describe("'mostly' vs 'largest phase' -- H1 QA nit (trace.ts:650)", () => {
    it("says 'mostly' when the dominant phase is at least half of elapsedMs", () => {
      // 2000 of 4000ms -- exactly half, the boundary itself, not just comfortably over it.
      const events = slowCall(4_000, { phases: { connect: 100, responseHeaders: 2_000 } });
      const finding = find(events).find((f) => f.id === "http-call-slow");
      expect(finding?.title).toContain("mostly responseHeaders");
      expect(finding?.title).not.toContain("largest phase");
    });

    it("says 'largest phase: X (N of M ms)' when the dominant phase is under half, most of the call is unattributed queueing", () => {
      // 900 of 4000ms (22.5%) -- the largest of several small phases, but
      // nowhere near "mostly" the call: the other ~3100ms is unattributed.
      const events = slowCall(4_000, {
        phases: { dns: 400, connect: 600, requestHeaders: 100, responseHeaders: 900, responseBody: 200 },
      });
      const finding = find(events).find((f) => f.id === "http-call-slow");
      expect(finding?.title).not.toContain("mostly");
      expect(finding?.title).toContain("largest phase: responseHeaders (900 of 4000ms)");
      // The detail's own "N ms of M ms" wording is untouched by this nit --
      // still honest about the dominant phase's own share either way.
      expect(finding?.detail).toContain("900ms of 4000ms was responseHeaders");
    });
  });

  it("says so honestly when there is no phase breakdown at all -- a Ktor call, say", () => {
    const finding = find(slowCall(3_500)).find((f) => f.id === "http-call-slow");
    expect(finding?.title).not.toContain("mostly");
    expect(finding?.detail).toContain("No single phase dominated");
    expect(finding?.evidence?.phases).toBeUndefined();
    expect(finding?.evidence?.dominantPhase).toBeUndefined();
  });

  it("reports only the single slowest call as the representative, but counts every slow one", () => {
    const events = [
      ...span("http", "a", 0, 3_100, { method: "GET", url: "https://api.example.com/a", status: 200 }),
      ...span("http", "b", 5_000, 9_000, { method: "GET", url: "https://api.example.com/b", status: 200 }),
    ];
    const finding = find(events).find((f) => f.id === "http-call-slow");
    expect(finding?.count).toBe(2);
    expect(finding?.title).toContain("took 4000ms"); // the worse of the two (b, 4000ms)
    expect(finding?.evidence?.url).toBe("https://api.example.com/b");
  });

  it("names a fast call's connection reuse and protocol in the evidence when present", () => {
    const events = slowCall(3_200, { reused: "true", protocol: "h2" });
    const finding = find(events).find((f) => f.id === "http-call-slow");
    expect(finding?.evidence?.reused).toBe(true);
    expect(finding?.evidence?.protocol).toBe("h2");
  });

  // -- joining the device's own network events --------------------------------

  it("says the call ran on cellular when the device's own network event names it, in force before the call", () => {
    const events = [
      event("device", 0, { kind: "network", transport: "cellular", metered: "true", validated: "true" }),
      ...slowCall(3_100),
    ];
    const finding = find(events).find((f) => f.id === "http-call-slow");
    expect(finding?.title).toContain("(on cellular)");
    expect(finding?.detail).toContain("metered cellular connection");
    expect(finding?.evidence?.network).toEqual({ transport: "cellular", metered: true, validated: true });
  });

  it("does not claim cellular when the device's own network event says wifi", () => {
    const events = [
      event("device", 0, { kind: "network", transport: "wifi", metered: "false", validated: "true" }),
      ...slowCall(3_100),
    ];
    const finding = find(events).find((f) => f.id === "http-call-slow");
    expect(finding?.title).not.toContain("cellular");
    expect(finding?.evidence?.network).toEqual({ transport: "wifi", metered: false, validated: true });
  });

  it("ignores a network event that arrives after the call started -- not in force yet", () => {
    const events = [
      ...slowCall(3_100),
      event("device", 100_000, { kind: "network", transport: "cellular", metered: "true", validated: "true" }),
    ];
    const finding = find(events).find((f) => f.id === "http-call-slow");
    expect(finding?.evidence?.network).toBeUndefined();
  });

  it("says nothing about the network at all when the session never saw one", () => {
    const finding = find(slowCall(3_100)).find((f) => f.id === "http-call-slow");
    expect(finding?.evidence?.network).toBeUndefined();
    expect(finding?.title).not.toContain("cellular");
  });
});

// GRA-200: findingsOf is deliberately selective (see its own comment on
// exit reasons) -- alsoInWindowOf is the other half, an inventory of the
// same events rather than a second judgement about them.
describe("alsoInWindowOf / alsoInWindowSentence", () => {
  const exitEvent = (reason: string, extra: Record<string, unknown> = {}) =>
    event("exit", 1000, { reason, timestamp: 1_700_000_000_000, ...extra });

  const deviceEvent = (kind: string, t = 1000) => event("device", t, { kind });

  it("finds nothing in an empty run", () => {
    expect(alsoInWindowOf([])).toBeUndefined();
    expect(alsoInWindowSentence(undefined)).toBe("");
  });

  it("is absent (not an empty object) for a window with none of these -- the common case's payload stays byte-identical", () => {
    // recompose/state_write/frame/nav/http/db/log are the "nine UI-facing
    // kinds" this ticket does not touch at all; none of them should ever
    // put anything into alsoInWindow.
    const events = [
      event("recompose", 1000),
      event("nav", 1000, { route: "cart" }),
      event("frame", 1000, { totalMs: "8" }),
    ];
    expect(alsoInWindowOf(events)).toBeUndefined();
  });

  describe("exits: an inventory, not a second opinion", () => {
    it("lists a REASON_SIGNALED exit even though findingsOf produces no finding for it at all", () => {
      const events = [exitEvent("REASON_SIGNALED")];
      expect(findingsOf(events, [], 60)).toEqual([]);

      const also = alsoInWindowOf(events);
      expect(also?.exits).toEqual([
        { reason: "REASON_SIGNALED", timestamp: 1_700_000_000_000, at: "2023-11-14T22:13:20.000Z" },
      ]);
      expect(alsoInWindowSentence(also)).toBe(
        "Also in this window: 1 process exit (REASON_SIGNALED, full record via " +
          "`porthole_status { exitTrace: 1700000000000 }`).",
      );
      expect(alsoInWindowSentence(also)).toContain("porthole_status");
    });

    it("still lists an exit that DID already produce a finding -- the finding is the judgement, this is the inventory", () => {
      const events = [exitEvent("REASON_ANR")];
      expect(findingsOf(events, [], 60)).toHaveLength(1); // the judgement
      expect(alsoInWindowOf(events)?.exits).toHaveLength(1); // the inventory, same event
    });

    it("(missing-input case) a reason-less exit does not throw and reports an empty reason", () => {
      const events = [event("exit", 1000, { timestamp: 1_700_000_000_000 })];
      expect(() => alsoInWindowOf(events)).not.toThrow();
      expect(alsoInWindowOf(events)?.exits?.[0].reason).toBe("");
    });

    it("names more than one exit without pretending each has its own paragraph", () => {
      const events = [
        exitEvent("REASON_SIGNALED", { timestamp: 1 }),
        exitEvent("REASON_CRASH", { timestamp: 2 }),
      ];
      const also = alsoInWindowOf(events);
      expect(also?.exits).toHaveLength(2);
      expect(alsoInWindowSentence(also)).toContain("2 process exits");
      expect(alsoInWindowSentence(also)).toContain("REASON_CRASH"); // the most recent
    });
  });

  describe("device / memory / gc / trim: raw counts, pointed at timeline", () => {
    it("counts device and memory events under any threshold, and says where the raw detail is", () => {
      const events = [
        deviceEvent("rotation", 1000),
        deviceEvent("theme", 1001),
        deviceEvent("power", 1002),
        deviceEvent("network", 1003),
        event("memory", 1000, { heapUsedMb: "40" }),
      ];
      const also = alsoInWindowOf(events);
      expect(also).toEqual({ device: 4, memory: 1 });
      const sentence = alsoInWindowSentence(also);
      expect(sentence).toContain("4 device events");
      expect(sentence).toContain("1 memory event");
      expect(sentence).toContain("raw detail via `timeline`");
    });

    it("counts every gc event, not only the blocking ones findingsOf turns into a finding", () => {
      const events = [
        event("gc", 1000, { count: "1" }), // not blocking: no finding
        event("gc", 1001, { count: "1", blocking: "1", pausedMs: "40" }), // blocking: a finding too
      ];
      expect(findingsOf(events, [], 60)).toHaveLength(1);
      expect(alsoInWindowOf(events)?.gc).toBe(2);
    });

    it("splits trimMemory out of the plain device count instead of double-labelling it", () => {
      const events = [deviceEvent("rotation"), deviceEvent("trimMemory", 1001)];
      const also = alsoInWindowOf(events);
      expect(also).toEqual({ device: 1, trim: 1 });
    });

    it("(missing-input case) a device event with no data.kind at all counts as a plain device event, not a trim", () => {
      const also = alsoInWindowOf([event("device", 1000, {})]);
      expect(also).toEqual({ device: 1 });
    });
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

describe("GRA-113: every finding carries a window, taken from the events that produced it", () => {
  const find = (events: DeviceEvent[], marks: Array<{ at: number; label: string }> = []) =>
    findingsOf(events, marks, 60);

  it("places db-on-main-thread at the worst query's own start and end", () => {
    const findings = find(span("db", "a", 100, 147, { onMainThread: "true", sql: "SELECT 1" }));
    expect(findings[0]).toMatchObject({ id: "db-on-main-thread", window: { from: 100, to: 147 } });
    expect(findings[0].spanning).toBeUndefined();
  });

  it("places main-thread-stall by backdating the reporting event with its own duration", () => {
    const events = [event("blocked", 500, { durationMs: 400, top: "a.B.c(B.kt:1)" })];
    expect(find(events)[0].window).toEqual({ from: 100, to: 500 });
  });

  it("places http-failed at the failed call's own start and end", () => {
    const events = span("http", "a", 200, 260, { status: 500 });
    const finding = find(events).find((f) => f.id === "http-failed");
    expect(finding?.window).toEqual({ from: 200, to: 260 });
  });

  it("places a still-open finding from its start to the last moment it was known open, not an invented 'now'", () => {
    const events = [
      event("http_start", 10, { id: "a", method: "GET", url: "https://api/a" }),
      event("nav", 510, { route: "cart" }),
    ];
    const finding = find(events).find((f) => f.id === "http-still-open");
    // atLeastMs is 500 (510 - 10); the window's `to` is exactly startedAt + that.
    expect(finding?.window).toEqual({ from: 10, to: 510 });
  });

  it("places frames-dropped by backdating the worst frame with its own totalMs", () => {
    const events = [event("frame", 300, { missedFrames: 1, totalMs: 50 })];
    expect(find(events)[0].window).toEqual({ from: 250, to: 300 });
  });

  it("places blocking-gc across the earliest and latest blocking collection, not a single invented instant", () => {
    const events = [
      event("gc", 100, { blocking: 1, pausedMs: 10 }),
      event("gc", 900, { blocking: 1, pausedMs: 15 }),
      event("gc", 500, { count: 1 }), // concurrent — must not widen the window
    ];
    const finding = find(events).find((f) => f.id === "blocking-gc");
    expect(finding?.window).toEqual({ from: 100, to: 900 });
  });

  it("places trim-memory across every trim, not just the last one the title quotes", () => {
    const events = [
      event("device", 50, { kind: "trimMemory", level: "moderate" }),
      event("device", 700, { kind: "trimMemory", level: "running critical" }),
    ];
    const finding = find(events).find((f) => f.id === "trim-memory");
    expect(finding?.window).toEqual({ from: 50, to: 700 });
  });

  it("places recompose-hotspot across only the hottest component's own recompositions, not every recompose in the run", () => {
    const events = [
      ...Array.from({ length: 150 }, (_, i) => event("recompose", i, { name: "Cart.ItemRow" })),
      // A different, unrelated component recomposing much later must not
      // widen the hotspot's window — it is not part of what made this hot.
      event("recompose", 9000, { name: "Unrelated.Thing" }),
    ];
    const finding = find(events).find((f) => f.id === "recompose-hotspot");
    expect(finding?.window).toEqual({ from: 0, to: 149 });
  });

  it("walks every finding from a rig exercising every finding type and fails on any with neither window nor spanning", () => {
    const events: DeviceEvent[] = [
      ...span("db", "main-db", 0, 50, { onMainThread: "true", sql: "SELECT 1" }),
      event("blocked", 500, { durationMs: 100, top: "a.B.c(B.kt:1)" }),
      ...span("http", "failed-call", 600, 650, { status: 500 }),
      event("http_start", 700, { id: "open-call", method: "GET", url: "https://api/x" }),
      event("db_start", 710, { id: "open-db", sql: "SELECT 2" }),
      event("work_start", 720, { id: "open-work", name: "SyncWorker" }),
      event("frame", 800, { missedFrames: 1, totalMs: 30 }),
      event("gc", 850, { blocking: 1, pausedMs: 5 }),
      event("device", 860, { kind: "trimMemory", level: "moderate" }),
      ...span("work", "retried", 870, 900, { retrying: "true" }),
      ...Array.from({ length: 150 }, (_, i) => event("recompose", 1000 + i, { name: "Cart.ItemRow" })),
      event("exit", 2000, { reason: "REASON_CRASH", timestamp: 1_700_000_000_000 }),
      event("nav", 3000, { route: "cart" }),
    ];
    const findings = find(events);
    // Positive control: a rig producing no findings would pass the loop below
    // vacuously. This exercises twelve of findingsOf's distinct finding ids.
    expect(findings.length).toBeGreaterThanOrEqual(9);

    for (const finding of findings) {
      const hasWindow =
        finding.window !== undefined &&
        typeof finding.window.from === "number" &&
        typeof finding.window.to === "number";
      const hasSpanning = finding.spanning === true;
      expect(
        hasWindow !== hasSpanning,
        `finding ${finding.id} must carry exactly one of window/spanning, got ${JSON.stringify({ window: finding.window, spanning: finding.spanning })}`,
      ).toBe(true);
    }

    // And exit — the one finding here that is spanning by design (GRA-58's
    // death predates this process's clock) — is the only one that is.
    const spanningIds = findings.filter((f) => f.spanning).map((f) => f.id);
    expect(spanningIds).toEqual([expect.stringMatching(/^exit-/)]);
  });
});

describe("GRA-201: findings carry where when source resolution is on", () => {
  const find = (events: DeviceEvent[]) => findingsOf(events, [], 60);

  let root: string;
  let savedProjectRoot: string | undefined;

  beforeEach(() => {
    savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
    resetSourceIndexForTests();
    root = mkdtempSync(path.join(tmpdir(), "porthole-trace-where-"));
    const cartViewModel = path.join(root, "app/src/main/kotlin/CartViewModel.kt");
    mkdirSync(path.dirname(cartViewModel), { recursive: true });
    writeFileSync(cartViewModel, "class CartViewModel\n");
    process.env.PORTHOLE_PROJECT_ROOT = root;
  });

  afterEach(() => {
    if (savedProjectRoot === undefined) delete process.env.PORTHOLE_PROJECT_ROOT;
    else process.env.PORTHOLE_PROJECT_ROOT = savedProjectRoot;
    resetSourceIndexForTests();
    rmSync(root, { recursive: true, force: true });
  });

  it("attaches where to main-thread-stall when the top frame's file exists exactly once (AC1)", () => {
    const events = [
      event("blocked", 500, {
        durationMs: 400,
        top: "x.CartViewModel.blockTheMainThread(CartViewModel.kt:1)",
      }),
    ];
    const finding = find(events).find((f) => f.id === "main-thread-stall");
    // Mutation quoted (final report): deleting the `...(where ? { where } :
    // {})` spread on this finding's object literal in trace.ts is the
    // one-line change that makes this assertion fail (`where` reads
    // `undefined` instead).
    expect(finding?.where).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/CartViewModel.kt",
      line: 1,
    });
  });

  it("says ambiguous when the top frame's file exists twice under the root (AC1)", () => {
    const duplicate = path.join(root, "legacy/src/main/kotlin/CartViewModel.kt");
    mkdirSync(path.dirname(duplicate), { recursive: true });
    writeFileSync(duplicate, "class CartViewModel\n");

    const events = [
      event("blocked", 500, {
        durationMs: 400,
        top: "x.CartViewModel.blockTheMainThread(CartViewModel.kt:1)",
      }),
    ];
    const finding = find(events).find((f) => f.id === "main-thread-stall");
    expect(finding?.where).toEqual({ resolved: false, reason: "ambiguous" });
  });

  it("says not found when the top frame's file exists nowhere under the root (AC1)", () => {
    const events = [event("blocked", 500, { durationMs: 400, top: "x.Ghost.method(Ghost.kt:1)" })];
    const finding = find(events).find((f) => f.id === "main-thread-stall");
    expect(finding?.where).toEqual({ resolved: false, reason: "not found" });
  });

  it("attaches where to an ANR exit finding via topAppFrame", () => {
    const events = [
      event("exit", 100, {
        reason: "REASON_ANR",
        mainStack: "x.CartViewModel.blockTheMainThread(CartViewModel.kt:1)",
      }),
    ];
    const finding = find(events).find((f) => f.id.startsWith("exit-"));
    expect(finding?.where).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/CartViewModel.kt",
      line: 1,
    });
  });

  it("attaches where to recompose-hotspot via the composable's portholeNode label, and carries the bare name in evidence", () => {
    const screens = path.join(root, "app/src/main/kotlin/Screens.kt");
    writeFileSync(screens, '@Composable\nfun X() { Modifier.portholeNode("Cart.ItemRow") }\n');

    const events = Array.from({ length: 150 }, (_, i) =>
      event("recompose", i, { name: "Cart.ItemRow" }),
    );
    const finding = find(events).find((f) => f.id === "recompose-hotspot");
    expect(finding?.evidence).toMatchObject({ composable: "Cart.ItemRow" });
    expect(finding?.where).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/Screens.kt",
      line: 2,
    });
  });

  it("attaches no where at all when PORTHOLE_PROJECT_ROOT is unset — the off switch (AC5)", () => {
    delete process.env.PORTHOLE_PROJECT_ROOT;
    const events = [
      event("blocked", 500, {
        durationMs: 400,
        top: "x.CartViewModel.blockTheMainThread(CartViewModel.kt:1)",
      }),
    ];
    const finding = find(events).find((f) => f.id === "main-thread-stall");
    expect(finding?.where).toBeUndefined();
  });

  it("changes nothing about a finding except where — resolution on vs off is otherwise byte-identical (AC3)", () => {
    const events = [
      event("blocked", 500, {
        durationMs: 400,
        top: "x.CartViewModel.blockTheMainThread(CartViewModel.kt:1)",
      }),
    ];
    const on = find(events).find((f) => f.id === "main-thread-stall")!;

    delete process.env.PORTHOLE_PROJECT_ROOT;
    resetSourceIndexForTests();
    const off = find(events).find((f) => f.id === "main-thread-stall")!;

    const { where: onWhere, ...onRest } = on;
    const { where: offWhere, ...offRest } = off;
    expect(onWhere).toBeDefined();
    expect(offWhere).toBeUndefined();
    expect(onRest).toEqual(offRest);
  });

  /**
   * 201-C: the AC3 proof above covers only main-thread-stall. Every other
   * finding `findingsOf` attaches `where` to goes through the exact same
   * `...(where ? { where } : {})` spread (trace.ts), but that is an
   * implementation detail this suite should not have to trust by
   * resemblance — each finding kind gets its own byte-identical-minus-where
   * proof, the same way AC3 itself demands one.
   */
  it("recompose-hotspot: on vs off is byte-identical except where", () => {
    const screens = path.join(root, "app/src/main/kotlin/Screens.kt");
    writeFileSync(screens, '@Composable\nfun X() { Modifier.portholeNode("Cart.ItemRow") }\n');
    const events = Array.from({ length: 150 }, (_, i) => event("recompose", i, { name: "Cart.ItemRow" }));

    const on = find(events).find((f) => f.id === "recompose-hotspot")!;

    delete process.env.PORTHOLE_PROJECT_ROOT;
    resetSourceIndexForTests();
    const off = find(events).find((f) => f.id === "recompose-hotspot")!;

    const { where: onWhere, ...onRest } = on;
    const { where: offWhere, ...offRest } = off;
    expect(onWhere).toBeDefined();
    expect(offWhere).toBeUndefined();
    expect(onRest).toEqual(offRest);
  });

  it("the exit finding: on vs off is byte-identical except where", () => {
    const events = [
      event("exit", 100, {
        reason: "REASON_ANR",
        timestamp: 12345,
        mainStack: "x.CartViewModel.blockTheMainThread(CartViewModel.kt:1)",
      }),
    ];

    const on = find(events).find((f) => f.id.startsWith("exit-"))!;

    delete process.env.PORTHOLE_PROJECT_ROOT;
    resetSourceIndexForTests();
    const off = find(events).find((f) => f.id.startsWith("exit-"))!;

    const { where: onWhere, ...onRest } = on;
    const { where: offWhere, ...offRest } = off;
    expect(onWhere).toBeDefined();
    expect(offWhere).toBeUndefined();
    expect(onRest).toEqual(offRest);
  });
});

describe("GRA-69: recompose-hotspot joins the compose compiler report", () => {
  const find = (events: DeviceEvent[]) => findingsOf(events, [], 60);
  const hot = (label: string) =>
    Array.from({ length: 150 }, (_, i) => event("recompose", i, { name: label }));

  let root: string;
  let savedProjectRoot: string | undefined;

  function writeReport(modulePath: string, report: Record<string, unknown>): void {
    const file = path.join(root, modulePath, "build/porthole/compose-report.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(report));
  }

  beforeEach(() => {
    savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
    resetSourceIndexForTests();
    resetComposeReportCacheForTests();
    root = mkdtempSync(path.join(tmpdir(), "porthole-trace-compose-report-"));
    process.env.PORTHOLE_PROJECT_ROOT = root;
  });

  afterEach(() => {
    if (savedProjectRoot === undefined) delete process.env.PORTHOLE_PROJECT_ROOT;
    else process.env.PORTHOLE_PROJECT_ROOT = savedProjectRoot;
    resetSourceIndexForTests();
    resetComposeReportCacheForTests();
    rmSync(root, { recursive: true, force: true });
  });

  it("promotes a not-skippable hotspot to a warning, above the bare-count note it would otherwise be", () => {
    mkdirSync(path.join(root, "app/src/main/kotlin"), { recursive: true });
    writeFileSync(
      path.join(root, "app/src/main/kotlin/Screens.kt"),
      "package com.example.shop.ui\n" +
        "@Composable\n" +
        "fun LeakyRow(highlight: RowHighlight) {\n" +
        '  Modifier.portholeNode("Cart.ItemRow")\n' +
        "}\n",
    );
    writeReport("app", {
      generatedAt: "now",
      variant: "debug",
      module: "app",
      kotlinVersion: "2.1.0",
      gitHead: "abc",
      sourceFingerprint: currentSourceFingerprint(path.join(root, "app")),
      composables: [
        {
          name: "LeakyRow",
          packageName: "com.example.shop.ui",
          restartable: true,
          skippable: false,
          parameters: [{ name: "highlight", type: "RowHighlight", stable: false, unused: false }],
        },
      ],
      classes: [
        {
          name: "RowHighlight",
          stable: false,
          runtimeStability: "Unstable",
          properties: [{ name: "tappedAt", mutable: true, stable: true, type: "Long" }],
        },
      ],
    });

    const finding = find(hot("Cart.ItemRow")).find((f) => f.id === "recompose-not-skippable");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
    expect(finding?.confidence).toBe("correlated");
    expect(finding?.detail).toContain("`LeakyRow` is restartable but not skippable");
    expect(finding?.detail).toContain("`RowHighlight` is unstable because it has a `var` property (`tappedAt`)");
    expect(finding?.evidence).toMatchObject({
      composable: "Cart.ItemRow",
      composeReport: { enclosingFunction: "LeakyRow", module: "app", skippable: false, stale: false },
    });

    // The promotion, proven by sort order rather than by severity alone:
    // a not-skippable hotspot has to sort ahead of an ordinary warning-free
    // note, which `findingsOf`'s severity ordering already guarantees for
    // `error`/`warning`/`note` — this just confirms `recompose-not-skippable`
    // actually lands in the `warning` bucket that promotion relies on.
    const order = find(hot("Cart.ItemRow")).map((f) => f.severity);
    expect(order[0]).toBe("warning");

    // No "recompose-hotspot" note alongside it — the join replaces the
    // finding's id/severity rather than adding a second finding.
    expect(find(hot("Cart.ItemRow")).some((f) => f.id === "recompose-hotspot")).toBe(false);
  });

  it("reports a skippable-but-unstable hotspot differently from a not-skippable one — same note severity, different id and text", () => {
    mkdirSync(path.join(root, "app/src/main/kotlin"), { recursive: true });
    writeFileSync(
      path.join(root, "app/src/main/kotlin/Screens.kt"),
      '@Composable\nfun Busy(items: List<String>) { Modifier.portholeNode("Cart.ItemRow") }\n',
    );
    writeReport("app", {
      generatedAt: "now",
      variant: "debug",
      module: "app",
      kotlinVersion: "2.1.0",
      gitHead: "abc",
      sourceFingerprint: currentSourceFingerprint(path.join(root, "app")),
      composables: [
        {
          name: "Busy",
          packageName: null,
          restartable: true,
          skippable: true,
          parameters: [{ name: "items", type: "List<String>", stable: false, unused: false }],
        },
      ],
      classes: [],
    });

    const findings = find(hot("Cart.ItemRow"));
    const finding = findings.find((f) => f.id === "recompose-skippable-but-unstable");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("note"); // never promoted above a genuine not-skippable finding
    expect(finding?.detail).toContain("is skippable, but parameter `items: List<String>` is unstable");
    expect(findings.some((f) => f.id === "recompose-not-skippable")).toBe(false);
    expect(findings.some((f) => f.id === "recompose-hotspot")).toBe(false);
  });

  it("leaves the finding exactly as it was before this ticket when nothing joins", () => {
    // No report anywhere under root, and no Screens.kt to resolve `where`
    // against either — the ordinary "no compose report, no source root
    // resolution" case most repos are in most of the time.
    const finding = find(hot("Cart.ItemRow")).find((f) => f.id === "recompose-hotspot");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("note");
    expect(finding?.evidence).toEqual({ composable: "Cart.ItemRow" });
  });

  it("refuses to promote a hotspot against a stale report — same as no join at all", () => {
    mkdirSync(path.join(root, "app/src/main/kotlin"), { recursive: true });
    writeFileSync(
      path.join(root, "app/src/main/kotlin/Screens.kt"),
      '@Composable\nfun LeakyRow() { Modifier.portholeNode("Cart.ItemRow") }\n',
    );
    writeReport("app", {
      generatedAt: "now",
      variant: "debug",
      module: "app",
      kotlinVersion: "2.1.0",
      gitHead: "abc",
      sourceFingerprint: "stale-fingerprint-that-never-matches",
      composables: [{ name: "LeakyRow", packageName: null, restartable: true, skippable: false, parameters: [] }],
      classes: [],
    });

    const finding = find(hot("Cart.ItemRow")).find((f) => f.id === "recompose-hotspot");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("note");
    // Never promoted, and never built into prose (see explainNotSkippable's
    // own guard in composeReport.ts) — but a stale match is still worth
    // saying so about, transparently, rather than reading identically to
    // "there is no report at all": `generatedAt`/`gitHead` are the fact
    // that answers "say how old and against which source state" (GRA-69's
    // own wording), and `skippable` is deliberately ABSENT (D6, QA) — a
    // stale report's own verdict may no longer be true of the current
    // source, so it is never quoted as fact.
    expect(finding?.evidence).toEqual({
      composable: "Cart.ItemRow",
      composeReport: {
        enclosingFunction: "LeakyRow",
        module: "app",
        stale: true,
        generatedAt: "now",
        gitHead: "abc",
      },
    });
  });

  it("proves the join changes when the report changes — fixture-driven, in place of a live emulator loop (GRA-69 AC)", () => {
    mkdirSync(path.join(root, "app/src/main/kotlin"), { recursive: true });
    writeFileSync(
      path.join(root, "app/src/main/kotlin/Screens.kt"),
      "@Composable\n" +
        "fun LeakyRow(highlight: RowHighlight) {\n" +
        '  Modifier.portholeNode("Cart.ItemRow")\n' +
        "}\n",
    );
    const write = (highlightStable: boolean) =>
      writeReport("app", {
        generatedAt: "now",
        variant: "debug",
        module: "app",
        kotlinVersion: "2.1.0",
        gitHead: "abc",
        sourceFingerprint: currentSourceFingerprint(path.join(root, "app")),
        composables: [
          {
            name: "LeakyRow",
            packageName: null,
            restartable: true,
            // A composable's skippability follows from its parameters'
            // stability (see ComposeCompilerWiring.kt's own KDoc on why
            // classic skipping is what the report forces); this fixture
            // models that dependency explicitly rather than setting
            // `skippable` and `stable` independently of one another, which
            // the real compiler would never produce.
            skippable: highlightStable,
            parameters: [{ name: "highlight", type: "RowHighlight", stable: highlightStable, unused: false }],
          },
        ],
        classes: [],
      });

    // Before the fix: RowHighlight is still an unstable var-holder, so
    // LeakyRow is restartable but not skippable.
    write(false);
    const before = find(hot("Cart.ItemRow")).find((f) => f.id.startsWith("recompose-"));
    expect(before?.id).toBe("recompose-not-skippable");
    expect(before?.severity).toBe("warning");

    // After the fix (@Immutable, or wrapping the mutable field in
    // MutableState the compiler can see — out of this ticket's scope to
    // actually apply, per GRA-69's own "out of scope" list, but its EFFECT
    // on the join is exactly what this proves): `highlight` reports stable,
    // LeakyRow reports skippable, and rebuilding the report changes the
    // finding with no change to the recompose events themselves at all —
    // the fixture-driven substitute for a live emulator before/after this
    // ticket accepts in place of one (see GRA-69's Build section).
    resetComposeReportCacheForTests();
    write(true);
    const after = find(hot("Cart.ItemRow")).find((f) => f.id.startsWith("recompose-"));
    expect(after?.id).toBe("recompose-hotspot");
    expect(after?.severity).toBe("note");
    expect(after?.evidence).toMatchObject({ composeReport: { skippable: true } });
  });
});
