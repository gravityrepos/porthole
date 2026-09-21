// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  cacheKey,
  fetchAskTrace,
  floorWindow,
  HIT_WINDOW_FLOOR_MS,
  hitWindow,
  isAskable,
  QUESTION_TEXT,
  ruledOut,
  selectTrace,
  type Window,
} from "./askTrace";
import { LANES } from "../timeline/lanes";
import type { Hit } from "./laneData";
import type { DeviceEvent, Finding, FindingsPayload, Span, TraceListing } from "../types";

const jankLane = LANES.find((l) => l.key === "frame")!;
const blockedLane = LANES.find((l) => l.key === "blocked")!;
const httpLane = LANES.find((l) => l.key === "http")!;
const findingsLane = LANES.find((l) => l.key === "findings")!;

function event(overrides: Partial<DeviceEvent> = {}): DeviceEvent {
  return { event: "frame", t: 1000, seq: 1, data: {}, ...overrides };
}

function span(overrides: Partial<Span> = {}): Span {
  return { id: "s1", start: 100, end: 300, open: false, data: {}, ...overrides };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    severity: "warning",
    confidence: "observed",
    title: "t",
    source: "porthole",
    ...overrides,
  };
}

function trace(overrides: Partial<TraceListing> = {}): TraceListing {
  return {
    id: "t1",
    bytes: 100,
    recordedAt: "2026-09-15T10:00:00.000Z",
    coverage: { from: 0, to: 10_000 },
    ...overrides,
  };
}

describe("HIT_WINDOW_FLOOR_MS", () => {
  it("is 200ms, checked against a real capture rather than picked from taste (ruling 2)", () => {
    // See this file's own comment on the export: 242 main-thread thread_state
    // rows in a 200ms window around the worst frame in
    // porthole-1789157940493.pftrace. This assertion is deliberately just the
    // constant -- the real evidence lives in the code comment because it is a
    // one-off measurement, not something this suite can re-derive without the
    // real binary and a real capture on disk.
    expect(HIT_WINDOW_FLOOR_MS).toBe(200);
  });
});

describe("hitWindow", () => {
  it("uses a span's own start/end", () => {
    expect(hitWindow({ kind: "span", lane: httpLane, span: span({ start: 500, end: 650 }) }, null)).toEqual({
      from: 500,
      to: 650,
    });
  });

  it("places a frame event's window from t to t+totalMs (t is the frame's vsync, its start)", () => {
    const hit: Hit = { kind: "event", lane: jankLane, event: event({ t: 2000, data: { totalMs: 34 } }) };
    expect(hitWindow(hit, null)).toEqual({ from: 2000, to: 2034 });
  });

  it("places a blocked event's window from t to t+durationMs (t is when the unanswered ping was posted)", () => {
    const hit: Hit = {
      kind: "event",
      lane: blockedLane,
      event: event({ event: "blocked", t: 5000, data: { durationMs: 400 } }),
    };
    expect(hitWindow(hit, null)).toEqual({ from: 5000, to: 5400 });
  });

  it("places a db_end-on-main-thread event's window from t-elapsedMs to t", () => {
    const hit: Hit = {
      kind: "event",
      lane: blockedLane,
      event: event({ event: "db_end", t: 900, data: { elapsedMs: 50, onMainThread: true } }),
    };
    expect(hitWindow(hit, null)).toEqual({ from: 850, to: 900 });
  });

  it("uses a finding's own window when it has one", () => {
    const hit: Hit = { kind: "finding", lane: findingsLane, finding: finding({ window: { from: 10, to: 40 } }) };
    expect(hitWindow(hit, { from: 0, to: 99999 })).toEqual({ from: 10, to: 40 });
  });

  it("falls back to the context window for a spanning finding", () => {
    const hit: Hit = { kind: "finding", lane: findingsLane, finding: finding({ spanning: true }) };
    expect(hitWindow(hit, { from: 200, to: 800 })).toEqual({ from: 200, to: 800 });
  });

  it("falls back to the context window for a finding with neither window nor spanning (defensive, wire boundary)", () => {
    const hit: Hit = { kind: "finding", lane: findingsLane, finding: finding({ window: undefined, spanning: undefined }) };
    expect(hitWindow(hit, { from: 5, to: 6 })).toEqual({ from: 5, to: 6 });
  });

  it("returns null when a finding has no window/spanning and there is no context either", () => {
    const hit: Hit = { kind: "finding", lane: findingsLane, finding: finding({ window: undefined, spanning: undefined }) };
    expect(hitWindow(hit, null)).toBeNull();
  });
});

describe("floorWindow", () => {
  it("expands a window narrower than 200ms symmetrically around its centre", () => {
    // A 34ms frame: [1966, 2000], centre 1983.
    expect(floorWindow({ from: 1966, to: 2000 })).toEqual({ from: 1883, to: 2083 });
  });

  it("leaves a window at or wider than 200ms untouched", () => {
    expect(floorWindow({ from: 100, to: 300 })).toEqual({ from: 100, to: 300 });
    expect(floorWindow({ from: 100, to: 700 })).toEqual({ from: 100, to: 700 });
  });

  it("expands a zero-width window to 200ms centred on the point", () => {
    expect(floorWindow({ from: 500, to: 500 })).toEqual({ from: 400, to: 600 });
  });

  it("clamps to 0 rather than asking about negative uptime, near session start", () => {
    // Centre 30 -> naive from would be -70; clamp keeps the width at exactly 200.
    const result = floorWindow({ from: 20, to: 40 });
    expect(result.from).toBe(0);
    expect(result.to - result.from).toBe(HIT_WINDOW_FLOOR_MS);
  });
});

describe("isAskable (ruling 1)", () => {
  it("is true for any finding", () => {
    expect(isAskable({ kind: "finding", lane: findingsLane, finding: finding() })).toBe(true);
  });

  it("is true for a dropped-frame lane event", () => {
    expect(isAskable({ kind: "event", lane: jankLane, event: event() })).toBe(true);
  });

  it("is true for a main-thread-stall lane event", () => {
    expect(isAskable({ kind: "event", lane: blockedLane, event: event({ event: "blocked" }) })).toBe(true);
  });

  it("is false for a span (http/db/work)", () => {
    expect(isAskable({ kind: "span", lane: httpLane, span: span() })).toBe(false);
  });

  it("is false for an event on an unrelated lane", () => {
    const navLane = LANES.find((l) => l.key === "nav")!;
    expect(isAskable({ kind: "event", lane: navLane, event: event({ event: "nav" }) })).toBe(false);
  });
});

describe("selectTrace (ruling 3)", () => {
  const window: Window = { from: 1000, to: 1200 };

  it("chooses the currently-selected trace when its coverage contains the window", () => {
    const covering = trace({ id: "chosen", coverage: { from: 0, to: 5000 } });
    const other = trace({ id: "other", coverage: { from: 0, to: 5000 } });
    expect(selectTrace([other, covering], "chosen", window)).toBe(covering);
  });

  it("falls back to the first listed trace that covers the window when the selected one does not", () => {
    const selectedButNotCovering = trace({ id: "chosen", coverage: { from: 0, to: 500 } });
    const firstCovering = trace({ id: "first", coverage: { from: 900, to: 1300 } });
    const alsoCovering = trace({ id: "second", coverage: { from: 0, to: 5000 } });
    expect(selectTrace([selectedButNotCovering, firstCovering, alsoCovering], "chosen", window)).toBe(firstCovering);
  });

  it("returns null when nothing covers the window", () => {
    const tooEarly = trace({ id: "a", coverage: { from: 0, to: 500 } });
    expect(selectTrace([tooEarly], "a", window)).toBeNull();
  });

  it("returns null for an empty trace list", () => {
    expect(selectTrace([], null, window)).toBeNull();
  });

  it("never selects a trace with coverage: null", () => {
    const unreadable = trace({ id: "bad", coverage: null, reason: "no clock snapshot" });
    expect(selectTrace([unreadable], "bad", window)).toBeNull();
    expect(selectTrace([unreadable], null, window)).toBeNull();
  });

  it("treats coverage that exactly matches the window's bounds as covering it (inclusive edges)", () => {
    const exact = trace({ id: "exact", coverage: { from: 1000, to: 1200 } });
    expect(selectTrace([exact], null, window)).toBe(exact);
  });

  it("does not select a trace whose coverage is one millisecond short of the window", () => {
    const short = trace({ id: "short", coverage: { from: 1000, to: 1199 } });
    expect(selectTrace([short], null, window)).toBeNull();
  });
});

describe("cacheKey (ruling 5)", () => {
  it("is the same for the same trace and window", () => {
    expect(cacheKey("t1", { from: 100, to: 300 })).toBe(cacheKey("t1", { from: 100, to: 300 }));
  });

  it("differs when the trace id differs", () => {
    expect(cacheKey("t1", { from: 100, to: 300 })).not.toBe(cacheKey("t2", { from: 100, to: 300 }));
  });

  it("differs when the window differs", () => {
    expect(cacheKey("t1", { from: 100, to: 300 })).not.toBe(cacheKey("t1", { from: 100, to: 301 }));
  });

  it("rounds sub-millisecond differences to the same key", () => {
    expect(cacheKey("t1", { from: 100.2, to: 300.4 })).toBe(cacheKey("t1", { from: 100.49, to: 300.49 }));
  });
});

describe("ruledOut (ruling 4)", () => {
  it("is empty when asked is missing (self-check (a): asked missing)", () => {
    expect(ruledOut({ findings: [] })).toEqual([]);
  });

  it("is empty when asked is an empty array (self-check (a): asked empty)", () => {
    expect(ruledOut({ asked: [], findings: [] })).toEqual([]);
  });

  it("excludes a question that was not answered", () => {
    const result = ruledOut({ asked: [{ id: "jank", answered: false }], findings: [] });
    expect(result).toEqual([]);
  });

  it("excludes an answered question that did produce a finding", () => {
    const result = ruledOut({
      asked: [{ id: "jank", answered: true }],
      findings: [finding({ id: "trace-frame-deadline", source: "trace" })],
    });
    expect(result).toEqual([]);
  });

  it("includes an answered question that produced no finding, in the question's own words", () => {
    const result = ruledOut({ asked: [{ id: "jank", answered: true }], findings: [] });
    expect(result).toEqual([QUESTION_TEXT.jank]);
  });

  it("does not rule out thread_states as long as its own finding is present", () => {
    const result = ruledOut({
      asked: [{ id: "thread_states", answered: true }],
      findings: [finding({ id: "trace-main-thread-contention", source: "trace", spanning: true })],
    });
    expect(result).toEqual([]);
  });

  it("treats slices as answered-with-a-finding when a non-fixed trace finding id is present (NOT_YOUR_CODE catch-all)", () => {
    const result = ruledOut({
      asked: [{ id: "slices", answered: true }],
      findings: [finding({ id: "trace-work-manager", source: "trace" })],
    });
    expect(result).toEqual([]);
  });

  it("rules out slices when only the other four questions' fixed finding ids are present", () => {
    const result = ruledOut({
      asked: [{ id: "slices", answered: true }],
      findings: [finding({ id: "trace-frame-deadline", source: "trace" })],
    });
    expect(result).toEqual([QUESTION_TEXT.slices]);
  });

  it("ignores a porthole-sourced finding when deciding whether a trace question was answered", () => {
    // A porthole finding named the same as a trace finding id must not count
    // as evidence the trace answered anything -- it did not run.
    const result = ruledOut({
      asked: [{ id: "jank", answered: true }],
      findings: [finding({ id: "trace-frame-deadline", source: "porthole" })],
    });
    expect(result).toEqual([QUESTION_TEXT.jank]);
  });
});

describe("fetchAskTrace", () => {
  const window: Window = { from: 1234.4, to: 1500.6 };

  it("carries the given trace id and the window's rounded from/to, not any other window (ruling 7)", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(emptyPayload()), { status: 200 }));
    await fetchAskTrace("trace-abc", window, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("/api/findings?");
    expect(url).toContain("trace=trace-abc");
    expect(url).toContain("from=1234");
    expect(url).toContain("to=1501");
  });

  it("returns an answer with the payload's findings and computed ruledOut", async () => {
    const payload: FindingsPayload = {
      ...emptyPayload(),
      asked: [{ id: "jank", answered: true }],
      findings: [finding({ id: "x", source: "trace" })],
    };
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(payload), { status: 200 }));
    const result = await fetchAskTrace("t1", window, fetchImpl as unknown as typeof fetch);

    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") throw new Error("expected answer");
    expect(result.findings).toEqual(payload.findings);
    expect(result.ruledOut).toEqual([QUESTION_TEXT.jank]);
    expect(result.traceId).toBe("t1");
  });

  it("returns an error result when the server answers non-200 (self-check (a): /api/findings failing)", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("boom", { status: 500 }));
    const result = await fetchAskTrace("t1", window, fetchImpl as unknown as typeof fetch);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toContain("500");
  });

  it("returns an error result rather than throwing when fetch itself rejects", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new Error("network down");
    });
    const result = await fetchAskTrace("t1", window, fetchImpl as unknown as typeof fetch);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toBe("network down");
  });

  it("returns an answer with empty findings and empty ruledOut for an empty findings list and no asked (self-check (a))", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(emptyPayload()), { status: 200 }));
    const result = await fetchAskTrace("t1", window, fetchImpl as unknown as typeof fetch);
    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") throw new Error("expected answer");
    expect(result.findings).toEqual([]);
    expect(result.ruledOut).toEqual([]);
  });
});

function emptyPayload(): FindingsPayload {
  return { window: { from: 0, to: 1000, ms: 1000 }, eventsExamined: 0, findings: [], notes: [] };
}
