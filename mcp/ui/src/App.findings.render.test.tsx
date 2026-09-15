// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom -- see App.render.test.tsx's top comment for
// why happy-dom over jsdom, and why it is opted into per-file rather than as
// the package default.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { App } from "./App";
import type { FindingsPayload, Hello, TraceListing } from "./types";

/**
 * GRA-114's own required regression test, in the spirit of GRA-80: before
 * this ticket, `InsightsPanel` owned the only `/api/findings` fetch. This
 * ticket adds a second consumer -- the findings lane, inside `TimelinePanel`
 * -- and the whole point of hoisting `FindingsLoader` out of `InsightsPanel`
 * and into `App` (rather than giving `TimelinePanel` its own copy) is that
 * the two consumers share one fetch instead of doubling the request rate the
 * way two independent `FindingsLoader`s would. This test proves that by
 * counting real `/api/findings` calls after the view settles, and by
 * checking `TimelinePanel` and `InsightsPanel` were both handed the same
 * payload object -- not two components that each happen to end up correct.
 *
 * `TimelinePanel` is mocked the same way `App.render.test.tsx` mocks it
 * (canvas/ResizeObserver, not implemented by happy-dom) -- but as a
 * prop-capturing mock rather than `() => null`, so this file can also assert
 * `TimelinePanel` and `InsightsPanel` were handed the same `payload`.
 *
 * State the boundary plainly, the way `App.render.test.tsx` does for its own
 * mocks: because `TimelinePanel` is mocked, this file proves App's own
 * wiring constructs and schedules exactly one `FindingsLoader` (confirmed by
 * mutation: duplicating that construction in `App.tsx` turns the "exactly
 * one fetch" assertions below red) -- it says nothing about whether the
 * *real* `TimelinePanel`'s internals could grow a fetch of their own, since
 * the real component's body never runs here. Catching that would need an
 * un-mocked `TimelinePanel`, which this workspace's render tests avoid for
 * the canvas/ResizeObserver reason above.
 */

vi.mock("./components/LogPane", () => ({ LogPane: () => null }));
vi.mock("./components/SelectionPanel", () => ({ SelectionPanel: () => null }));
vi.mock("./components/WindowPanel", () => ({ WindowPanel: () => null }));

const timelinePanelProps: unknown[] = [];
vi.mock("./components/TimelinePanel", () => ({
  TimelinePanel: (props: unknown) => {
    timelinePanelProps.push(props);
    return null;
  },
}));

const insightsPanelProps: unknown[] = [];
vi.mock("./components/InsightsPanel", () => ({
  InsightsPanel: (props: unknown) => {
    insightsPanelProps.push(props);
    return null;
  },
}));

vi.mock("./lib/setup", () => ({ useSetup: () => [] }));

const mockStore = {
  events: [] as unknown[],
  hello: null as Hello | null,
  connection: "connected" as const,
  clear: vi.fn(),
};
vi.mock("./store/useDeviceStream", () => ({
  useDeviceStream: () => ({ store: mockStore, version: 0 }),
}));

const emptyFindings: FindingsPayload = {
  window: { from: 0, to: 1000, ms: 1000 },
  eventsExamined: 0,
  findings: [],
  notes: [],
};
const emptyTraces: TraceListing[] = [];

function stubFetch() {
  return vi.fn(async (url: unknown) => {
    const body = String(url).includes("/api/traces") ? { traces: emptyTraces } : emptyFindings;
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  timelinePanelProps.length = 0;
  insightsPanelProps.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("App issues one /api/findings request per settled view (GRA-114, in the spirit of GRA-80)", () => {
  it("fires exactly one findings fetch after the debounce settles, not one per consumer", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    // The findings debounce is 300ms (FindingsLoader's default); settle past it.
    await vi.advanceTimersByTimeAsync(300);

    const findingsCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/findings"));
    expect(findingsCalls).toHaveLength(1);
  });

  it("hands TimelinePanel and InsightsPanel the same findings payload from that one request", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await vi.advanceTimersByTimeAsync(300);
    // Let the resolved fetch's .then/state updates flush.
    await vi.advanceTimersByTimeAsync(0);

    const latestTimelineProps = timelinePanelProps[timelinePanelProps.length - 1] as {
      findings: unknown[];
      hasFindingsPayload: boolean;
    };
    const latestInsightsProps = insightsPanelProps[insightsPanelProps.length - 1] as {
      payload: FindingsPayload | null;
    };

    expect(latestTimelineProps.hasFindingsPayload).toBe(true);
    expect(latestInsightsProps.payload).not.toBeNull();
    expect(latestTimelineProps.findings).toBe(latestInsightsProps.payload!.findings);
  });

  it("does not fire a second request merely because more time passes with the view unchanged", async () => {
    // The regression this guards: two independent FindingsLoaders (one per
    // consumer) would each debounce on their own and each fire once the
    // view settles -- two /api/findings calls for one settled view, not
    // one. A single shared loader fires once and then falls silent.
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(2000);

    const findingsCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/findings"));
    expect(findingsCalls).toHaveLength(1);
  });
});
