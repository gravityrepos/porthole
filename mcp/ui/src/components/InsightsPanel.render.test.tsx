// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom -- see App.render.test.tsx's top comment for
// why happy-dom over jsdom, and why it is opted into per-file rather than as
// the package default.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { InsightsPanel } from "./InsightsPanel";

/**
 * GRA-173: the founder reported the right pane "flashing over and over"
 * before the cart was ever opened. InsightsPanel.test.tsx already proves
 * `FindingsLoader`'s fetch/debounce/cancellation logic in isolation; it says
 * nothing about what the DOM does while that loader is running, and that
 * gap is exactly where this bug lived.
 *
 * The mechanism, confirmed here rather than assumed: the empty-state
 * paragraph used to be gated on `payload && findings.length === 0 &&
 * !loading`, and `loading` is set true at the start of *every* fetch --
 * including the ones `following` mode fires every `DEBOUNCE_MS` with no
 * user action at all. So once a window with zero findings had rendered the
 * paragraph once, the very next debounce cycle flipped `loading` true and
 * unmounted it, then flipped it back false and remounted it, forever, for
 * as long as the window kept moving and stayed empty of findings. That
 * "empty of findings" detail is why opening the cart made it stop: once
 * `findings` has entries, the `<ul>` that renders them carries no such gate
 * and never unmounts on a refresh.
 *
 * This test drives two consecutive fetches by hand (the same `deferredFetch`
 * technique InsightsPanel.test.tsx uses for `FindingsLoader`, applied here
 * to the global `fetch` InsightsPanel itself binds) and inspects the DOM at
 * the moment the second one is in flight -- after its `onStart` has fired
 * but before its response has landed, which is precisely the window the
 * old gate emptied.
 */

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const emptyPayload = {
  window: { from: 0, to: 1000, ms: 1000 },
  eventsExamined: 0,
  findings: [] as unknown[],
  notes: [] as string[],
};

/** Same shape as InsightsPanel.test.tsx's helper, but for the global `fetch`
 * InsightsPanel binds itself -- the component takes no `fetchImpl` prop, so
 * this is the only lever a render test has on when a response arrives. */
function deferredFetch() {
  const pending: Array<{
    resolve: (response: Response) => void;
    reject: (reason: unknown) => void;
  }> = [];

  const fetchMock = vi.fn((_url: unknown, _init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  });

  return { fetchMock: fetchMock as unknown as typeof fetch, pending };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("InsightsPanel's empty state across a refresh (GRA-173)", () => {
  it("is not unmounted while a second, in-flight fetch is still empty of findings", async () => {
    const { fetchMock, pending } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<InsightsPanel from={0} to={1000} />);

    // First debounce cycle: the loader's timer fires 300ms after mount and
    // issues the first request.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(pending).toHaveLength(1);

    // Resolve it with a payload that has zero findings -- the state that
    // puts the empty-state paragraph on screen in the first place.
    await act(async () => {
      pending[0].resolve(okResponse(emptyPayload));
      await vi.advanceTimersByTimeAsync(0);
    });
    const beforeSecondFetch = screen.getByText(/Nothing crossed a threshold/i);

    // A second window arrives -- exactly what `following` mode does every
    // DEBOUNCE_MS while nobody has touched the cart. This starts a second
    // fetch, which flips `loading` true before its response lands.
    rerender(<InsightsPanel from={100} to={1100} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(pending).toHaveLength(2);

    // The second request is in flight right now: onStart has fired and
    // onSuccess has not. The empty-state paragraph must still be the exact
    // node it was before this fetch started -- not merely present again
    // after a fresh mount, which `getByText` alone cannot distinguish from
    // "was unmounted and remounted in between."
    const duringSecondFetch = screen.getByText(/Nothing crossed a threshold/i);
    expect(duringSecondFetch).toBe(beforeSecondFetch);

    // Finish the second fetch so the check covers "still correct after",
    // not only "never disappeared".
    await act(async () => {
      pending[1].resolve(okResponse(emptyPayload));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/Nothing crossed a threshold/i)).toBe(beforeSecondFetch);
  });
});
