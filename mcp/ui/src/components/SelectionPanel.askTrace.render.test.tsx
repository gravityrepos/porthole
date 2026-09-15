// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom -- see App.render.test.tsx's top comment for
// why happy-dom over jsdom, and why it is opted into per-file rather than as
// the package default.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SelectionPanel } from "./SelectionPanel";
import { LANES } from "../timeline/lanes";
import type { Hit } from "../lib/laneData";
import type { DeviceEvent, Finding, FindingsPayload, Span, TraceListing } from "../types";

/**
 * GRA-115 ruling 7: SelectionPanel render tests for the ask-the-trace
 * action, the no-coverage message, an answer with findings, and an answer
 * with only negatives -- plus a test that the actual outgoing fetch carries
 * the clicked hit's own window, not the visible view (which this component
 * is never even handed -- see the last describe block below for why that is
 * a structural guarantee here, not just an assertion).
 *
 * `lib/askTrace.test.ts` already covers the window/floor/selection/cache-key
 * arithmetic DOM-free; this file is about the wiring: does the right button
 * appear for the right hit, does clicking it render what the server sent
 * back, and does a second click skip the network the way ruling 5 requires.
 */

const jankLane = LANES.find((l) => l.key === "frame")!;
const httpLane = LANES.find((l) => l.key === "http")!;

function frameHit(t = 5000, totalMs = 34): Hit {
  const deviceEvent: DeviceEvent = { event: "frame", t, seq: 1, data: { totalMs, missedFrames: 2 } };
  return { kind: "event", lane: jankLane, event: deviceEvent };
}

function httpSpanHit(): Hit {
  const span: Span = { id: "s1", start: 100, end: 300, open: false, data: { method: "GET", url: "/cart" } };
  return { kind: "span", lane: httpLane, span };
}

function covering(id = "trace-1", from = 0, to = 100_000): TraceListing {
  return { id, bytes: 100, recordedAt: "2026-09-15T10:00:00.000Z", coverage: { from, to } };
}

function findingsPayload(overrides: Partial<FindingsPayload> = {}): FindingsPayload {
  return { window: { from: 0, to: 1000, ms: 1000 }, eventsExamined: 0, findings: [], notes: [], ...overrides };
}

function stubFetch(payload: FindingsPayload) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(payload), { status: 200 }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SelectionPanel's ask-the-trace action (GRA-115 ruling 1)", () => {
  it("shows the action for a dropped-frame hit", () => {
    render(<SelectionPanel hit={frameHit()} traces={[]} selectedTraceId={null} contextWindow={null} />);
    expect(screen.getByText("ASK THE TRACE")).toBeTruthy();
  });

  it("does not show the action for a span hit (http/db/work are out of scope)", () => {
    render(<SelectionPanel hit={httpSpanHit()} traces={[]} selectedTraceId={null} contextWindow={null} />);
    expect(screen.queryByText("ASK THE TRACE")).toBeNull();
  });
});

describe("SelectionPanel's no-coverage message (ruling 3)", () => {
  it("says plainly that no capture covers the moment, naming it, and offers a copy control instead of an ask button", () => {
    render(<SelectionPanel hit={frameHit(5000, 34)} traces={[]} selectedTraceId={null} contextWindow={null} />);
    // Frame at t=5000, totalMs=34 -> raw [4966, 5000] -> floored to [4883, 5083].
    expect(screen.getByText("No capture on file covers device uptime 4883–5083ms.")).toBeTruthy();
    expect(screen.queryByText("ask the trace")).toBeNull();
    expect(screen.getByText("copy prompt")).toBeTruthy();
  });

  it("still shows the no-coverage message when every listed trace has coverage: null (self-check (a))", () => {
    const unreadable: TraceListing = {
      id: "bad",
      bytes: 1,
      recordedAt: "2026-09-15T10:00:00.000Z",
      coverage: null,
      reason: "no clock snapshot",
    };
    render(<SelectionPanel hit={frameHit()} traces={[unreadable]} selectedTraceId="bad" contextWindow={null} />);
    expect(screen.getByText(/No capture on file covers/)).toBeTruthy();
  });

  it("still shows the no-coverage message when /api/traces listed nothing at all (self-check (a))", () => {
    render(<SelectionPanel hit={frameHit()} traces={[]} selectedTraceId={null} contextWindow={null} />);
    expect(screen.getByText(/No capture on file covers/)).toBeTruthy();
  });

  it("does not crash on a hit whose own window is zero-width, and still floors it to 200ms (self-check (a))", () => {
    // totalMs: 0 -> raw window [5000, 5000], a single point in time.
    render(<SelectionPanel hit={frameHit(5000, 0)} traces={[]} selectedTraceId={null} contextWindow={null} />);
    expect(screen.getByText("No capture on file covers device uptime 4900–5100ms.")).toBeTruthy();
  });
});

describe("SelectionPanel's answer, once a covering trace is chosen", () => {
  it("renders an answer with findings after clicking ask the trace", async () => {
    const finding: Finding = {
      id: "trace-frame-deadline",
      severity: "error",
      confidence: "observed",
      title: "the frame timeline recorded a miss",
      source: "trace",
      window: { from: 4883, to: 5083 },
    };
    const fetchMock = stubFetch(findingsPayload({ findings: [finding] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SelectionPanel hit={frameHit()} traces={[covering()]} selectedTraceId="trace-1" contextWindow={null} />);
    fireEvent.click(screen.getByText("ask the trace"));

    expect(await screen.findByText("the frame timeline recorded a miss")).toBeTruthy();
    // Same vocabulary as the findings panel: severity, source and confidence shown.
    expect(screen.getByText("ERROR")).toBeTruthy();
    expect(screen.getByText("trace")).toBeTruthy();
    expect(screen.getByText("observed")).toBeTruthy();
  });

  it("renders only negatives -- ruled-out lines -- when the trace answered but nothing came of it (ruling 4)", async () => {
    const fetchMock = stubFetch(
      findingsPayload({
        asked: [
          { id: "jank", answered: true },
          { id: "binder", answered: true },
          { id: "thread_states", answered: false },
        ],
        findings: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<SelectionPanel hit={frameHit()} traces={[covering()]} selectedTraceId="trace-1" contextWindow={null} />);
    fireEvent.click(screen.getByText("ask the trace"));

    expect(await screen.findByText(/Ruled out: which frames missed their deadline/)).toBeTruthy();
    expect(screen.getByText(/Ruled out: which other processes the app called into/)).toBeTruthy();
    // thread_states was not answered at all, so it gets no ruled-out line.
    expect(screen.queryByText(/whether the app was running/)).toBeNull();
  });

  it("says nothing came back when findings is empty and asked is missing, rather than an empty list (self-check (a))", async () => {
    const fetchMock = stubFetch(findingsPayload());
    vi.stubGlobal("fetch", fetchMock);

    render(<SelectionPanel hit={frameHit()} traces={[covering()]} selectedTraceId="trace-1" contextWindow={null} />);
    fireEvent.click(screen.getByText("ask the trace"));

    expect(await screen.findByText("Nothing came back for this window.")).toBeTruthy();
  });

  it("shows the server's error rather than throwing when /api/findings answers 500 (self-check (a))", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SelectionPanel hit={frameHit()} traces={[covering()]} selectedTraceId="trace-1" contextWindow={null} />);
    fireEvent.click(screen.getByText("ask the trace"));

    expect(await screen.findByText(/the server answered 500/)).toBeTruthy();
  });
});

describe("SelectionPanel's cache (ruling 5)", () => {
  it("issues exactly one fetch across two clicks of ask the trace for the same hit", async () => {
    const fetchMock = stubFetch(findingsPayload({ findings: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SelectionPanel hit={frameHit()} traces={[covering()]} selectedTraceId="trace-1" contextWindow={null} />);
    fireEvent.click(screen.getByText("ask the trace"));
    await screen.findByText("Nothing came back for this window.");

    fireEvent.click(screen.getByText("ask the trace"));
    // Give any (wrongly issued) second fetch a turn of the microtask queue.
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("issues no fetch when re-rendered with a fresh hit object for the same underlying frame (re-selecting the same hit)", async () => {
    const fetchMock = stubFetch(findingsPayload({ findings: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <SelectionPanel hit={frameHit()} traces={[covering()]} selectedTraceId="trace-1" contextWindow={null} />,
    );
    fireEvent.click(screen.getByText("ask the trace"));
    await screen.findByText("Nothing came back for this window.");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A new object, same window/trace -- exactly what clicking the same mark
    // on the timeline a second time produces (hitLane/hitFindings never
    // return the same object twice).
    rerender(<SelectionPanel hit={frameHit()} traces={[covering()]} selectedTraceId="trace-1" contextWindow={null} />);
    expect(await screen.findByText("Nothing came back for this window.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the outgoing request carries the hit's own window, never a view (ruling 7)", () => {
  it("requests exactly the floored hit window, not the arbitrary large window a caller could pass as context", async () => {
    const fetchMock = stubFetch(findingsPayload());
    vi.stubGlobal("fetch", fetchMock);

    // A context window standing in for "the visible view" -- wildly different
    // bounds, so if the component ever leaked it into the request instead of
    // the hit's own window, this test would see it in the URL.
    const viewLikeContext = { from: -50_000, to: 500_000 };

    render(
      <SelectionPanel
        hit={frameHit(5000, 34)}
        traces={[covering()]}
        selectedTraceId="trace-1"
        contextWindow={viewLikeContext}
      />,
    );
    fireEvent.click(screen.getByText("ask the trace"));
    await screen.findByText("Nothing came back for this window.");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    // Frame at t=5000, totalMs=34 -> raw [4966, 5000] -> floored to [4883, 5083].
    expect(url).toContain("from=4883");
    expect(url).toContain("to=5083");
    expect(url).not.toContain("from=-50000");
    expect(url).not.toContain("to=500000");
  });
});
