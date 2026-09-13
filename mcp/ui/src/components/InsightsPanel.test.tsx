// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindingsLoader } from "./InsightsPanel";

/**
 * `FindingsLoader` is the part of InsightsPanel that used to be a bare
 * `useEffect(() => { void load(); }, [load])`: no debounce, no cancellation,
 * no defence against a slow response landing after a fast one. These tests
 * exercise it directly rather than rendering the component, the same way
 * `TimelineStore.test.ts` tests that store directly -- this workspace has no
 * DOM-rendering test setup, and the loader has no React dependency of its own.
 */

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** A fetch stand-in whose promises this test resolves by hand, so a test can
 * make a *later* request's response arrive *before* an *earlier* request's --
 * the exact ordering a debounced, cancellable fetch is not otherwise
 * guaranteed to avoid. */
function deferredFetch() {
  const pending: Array<{
    url: string;
    signal: AbortSignal;
    resolve: (response: Response) => void;
    reject: (reason: unknown) => void;
  }> = [];

  const fetchImpl = vi.fn((url: unknown, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      pending.push({ url: String(url), signal: init!.signal!, resolve, reject });
    });
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, pending };
}

function callbacks() {
  return {
    onStart: vi.fn(),
    onSuccess: vi.fn(),
    onError: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FindingsLoader.schedule", () => {
  it("collapses a burst of calls into a single fetch, fired debounceMs after the burst began", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      okResponse({ findings: [] }),
    );
    const loader = new FindingsLoader(callbacks(), { fetchImpl });

    // Three view updates in quick succession -- one animation frame apart,
    // the way `following` mode or a fast pan produces them. All three land
    // inside the same debounce window, so this is one batch: its deadline
    // is fixed relative to the first call (see the class doc comment for
    // why it cannot instead be relative to the last), not to whichever call
    // happened to be most recent when a test author looked at the clock.
    loader.schedule(0, 100);
    await vi.advanceTimersByTimeAsync(100);
    loader.schedule(0, 150);
    await vi.advanceTimersByTimeAsync(100);
    loader.schedule(0, 200);

    // Not yet: 300ms have not yet passed since the first call in the batch.
    await vi.advanceTimersByTimeAsync(99);
    expect(fetchImpl).not.toHaveBeenCalled();

    // Now they have, and only the final window is asked for.
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("to=200");
  });

  it("keeps servicing a view that never stops moving, rather than starving", async () => {
    // This is what `following` mode actually does against a live device: a
    // new `schedule` call on every animation frame, indefinitely, for as
    // long as traffic keeps arriving. A plain trailing debounce -- restart
    // the timer on every call -- would never fire at all here, because the
    // calls never stop. Caught by running exactly this against a live
    // device's browser: the panel went stale the moment `following` was
    // turned on and stayed that way, with zero further requests, not "a few
    // a second".
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      okResponse({ findings: [] }),
    );
    const loader = new FindingsLoader(callbacks(), { fetchImpl, debounceMs: 300 });

    // One `schedule` call every 50ms for a full second -- twenty of them,
    // none of them ever 300ms apart.
    for (let i = 0; i < 20; i++) {
      loader.schedule(0, i);
      await vi.advanceTimersByTimeAsync(50);
    }

    // Three requests in that second, not zero and not twenty: each batch's
    // deadline is fixed when the batch starts, so continuous scheduling
    // still gets serviced roughly every debounceMs, each one carrying
    // whichever window was most recently asked for for when its deadline
    // arrived.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("to=5"),
      expect.stringContaining("to=11"),
      expect.stringContaining("to=17"),
    ]);
  });

  it("cancels the in-flight request when a newer one is scheduled", async () => {
    const { fetchImpl, pending } = deferredFetch();
    const loader = new FindingsLoader(callbacks(), { fetchImpl, debounceMs: 10 });

    loader.schedule(0, 100);
    await vi.advanceTimersByTimeAsync(10);
    expect(pending).toHaveLength(1);
    const first = pending[0];
    expect(first.signal.aborted).toBe(false);

    loader.schedule(0, 200);
    await vi.advanceTimersByTimeAsync(10);
    expect(pending).toHaveLength(2);

    // Starting the second request aborts the first one's controller,
    // regardless of whether the first has resolved yet.
    expect(first.signal.aborted).toBe(true);
  });

  it("never lets a superseded response overwrite a newer one", async () => {
    const { fetchImpl, pending } = deferredFetch();
    const cb = callbacks();
    const loader = new FindingsLoader(cb, { fetchImpl, debounceMs: 10 });

    loader.schedule(0, 100);
    await vi.advanceTimersByTimeAsync(10);
    loader.schedule(0, 200);
    await vi.advanceTimersByTimeAsync(10);
    expect(pending).toHaveLength(2);
    const [older, newer] = pending;

    // The newer request answers first...
    newer.resolve(okResponse({ findings: [{ id: "b", source: "porthole" }] }));
    await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledTimes(1));
    expect(cb.onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ findings: [{ id: "b", source: "porthole" }] }),
    );

    // ...and the older, slower request answers after it. Even though its
    // controller was aborted, this stand-in fetch (deliberately, like a real
    // one sometimes does) still resolves instead of rejecting -- the ordering
    // guard, not the AbortController, is what has to catch this.
    older.resolve(okResponse({ findings: [{ id: "a", source: "porthole" }] }));
    await vi.advanceTimersByTimeAsync(0);

    expect(cb.onSuccess).toHaveBeenCalledTimes(1);
  });

  it("ignores a rejection from a request that has since been superseded", async () => {
    const { fetchImpl, pending } = deferredFetch();
    const cb = callbacks();
    const loader = new FindingsLoader(cb, { fetchImpl, debounceMs: 10 });

    loader.schedule(0, 100);
    await vi.advanceTimersByTimeAsync(10);
    loader.schedule(0, 200);
    await vi.advanceTimersByTimeAsync(10);
    const [older, newer] = pending;

    older.reject(new DOMException("Aborted", "AbortError"));
    await vi.advanceTimersByTimeAsync(0);
    expect(cb.onError).not.toHaveBeenCalled();

    newer.resolve(okResponse({ findings: [] }));
    await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledTimes(1));
  });
});

describe("FindingsLoader.runNow", () => {
  it("bypasses the debounce and cancels whatever was pending", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      okResponse({ findings: [] }),
    );
    const loader = new FindingsLoader(callbacks(), { fetchImpl, debounceMs: 300 });

    loader.schedule(0, 100);
    loader.runNow(0, 200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("to=200");

    // The timer `schedule` started should have been cleared by `runNow`, so
    // waiting it out must not produce a second, stale request.
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("FindingsLoader.dispose", () => {
  it("cancels a pending debounce timer", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ findings: [] }));
    const loader = new FindingsLoader(callbacks(), { fetchImpl, debounceMs: 50 });

    loader.schedule(0, 100);
    loader.dispose();
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts a request already in flight", async () => {
    const { fetchImpl, pending } = deferredFetch();
    const loader = new FindingsLoader(callbacks(), { fetchImpl, debounceMs: 10 });

    loader.schedule(0, 100);
    await vi.advanceTimersByTimeAsync(10);
    loader.dispose();

    expect(pending[0].signal.aborted).toBe(true);
  });
});
