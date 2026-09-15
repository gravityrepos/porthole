// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { FindingsPayload } from "../types";

/** How long a burst of `schedule` calls waits for the view to settle, and the
 * longest a continuously-moving view is ever allowed to go unasked. */
const DEBOUNCE_MS = 300;

interface FindingsCallbacks {
  onStart: () => void;
  onSuccess: (payload: FindingsPayload) => void;
  onError: (message: string) => void;
}

/**
 * Turns a stream of `schedule` calls -- one per animation frame while the
 * user pans the timeline, or once a tick while `following` is on -- into at
 * most one outstanding `/api/findings` request every `debounceMs`.
 *
 * GRA-114 hoisted this out of `InsightsPanel` into `App`: the findings lane
 * (`TimelinePanel`) and the panel now read the same fetch, the same debounce
 * and the same in-flight/stale/error state, rather than each running its own
 * copy of this class and doubling the request rate the way GRA-80 first
 * fixed for the panel alone. `App` is the only place that constructs one.
 *
 * That "every", not "after", matters and was not obvious until this was
 * tried against a live device: `following` mode calls `schedule` on every
 * animation frame for as long as traffic keeps arriving, which is
 * indefinitely. A plain trailing debounce -- reset the timer on every call,
 * fire when the calls stop -- never fires at all under that load, because
 * the calls never stop; the panel would go stale the moment `following` was
 * turned on and stay that way. So a batch, once started, has a deadline
 * fixed at `debounceMs` from its first call, not from its most recent one:
 * further calls before the deadline still update which window (and which
 * trace) gets asked for, but they no longer push the deadline itself back.
 * Panning briefly and releasing still settles onto one request, `debounceMs`
 * after the pan began; continuous motion gets serviced roughly every
 * `debounceMs` instead of not at all.
 *
 * Three further guards, because any one alone leaves a gap:
 *  - cancelled: a fetch still in flight when a newer one starts is aborted,
 *    so the server is not left computing an answer nobody wants any more;
 *  - ordered: an aborted fetch's promise can still settle (a test's fake
 *    fetch, or a runtime that does not wire the signal all the way through),
 *    so a request id is checked again on the way out -- only the most recent
 *    `run` is allowed to report its result;
 *  - bound to the right `this`: `fetch` is a Window method, not a free
 *    function, and browsers check that it is invoked with `this === window`.
 *    Storing the bare reference and calling it as `this.fetchImpl(...)`
 *    rebinds `this` to the loader, which a live device's browser caught
 *    immediately as "Failed to execute 'fetch' on 'Window': Illegal
 *    invocation" -- Node's fetch does not enforce this, so no unit test
 *    here would have. Bound to `globalThis` once, in the constructor.
 *
 * Kept free of React so it can be constructed once (by `App`) and
 * unit-tested directly, the way the rest of this codebase tests plain
 * classes rather than rendering components.
 */
export class FindingsLoader {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the current batch's deadline falls; null between batches. */
  private batchDeadline: number | null = null;
  private pendingFrom: number | undefined;
  private pendingTo: number | undefined;
  /** GRA-114: which capture, if any, `/api/findings?trace=` should ask trace_processor to score this window against. */
  private pendingTrace: string | undefined;
  private controller: AbortController | null = null;
  private requestId = 0;
  private readonly debounceMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly callbacks: FindingsCallbacks,
    options?: { debounceMs?: number; fetchImpl?: typeof fetch },
  ) {
    this.debounceMs = options?.debounceMs ?? DEBOUNCE_MS;
    this.fetchImpl = options?.fetchImpl ?? fetch.bind(globalThis);
  }

  /** Queue a request for this window (and trace); a call already waiting is
   * replaced, but the batch's deadline is only ever brought closer, never
   * pushed out. */
  schedule(from?: number, to?: number, trace?: string): void {
    this.pendingFrom = from;
    this.pendingTo = to;
    this.pendingTrace = trace;

    const now = Date.now();
    if (this.batchDeadline === null) this.batchDeadline = now + this.debounceMs;

    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.batchDeadline = null;
        void this.run(this.pendingFrom, this.pendingTo, this.pendingTrace);
      },
      Math.max(0, this.batchDeadline - now),
    );
  }

  /** Run immediately, for the manual refresh button. */
  runNow(from?: number, to?: number, trace?: string): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.batchDeadline = null;
    void this.run(from, to, trace);
  }

  /** Stop anything pending; the component is going away. */
  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.batchDeadline = null;
    this.controller?.abort();
  }

  private async run(from?: number, to?: number, trace?: string): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const requestId = ++this.requestId;

    this.callbacks.onStart();
    try {
      const params = new URLSearchParams();
      if (from !== undefined) params.set("from", String(from));
      if (to !== undefined) params.set("to", String(to));
      if (trace !== undefined) params.set("trace", trace);
      const response = await this.fetchImpl(`/api/findings?${params}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`the server answered ${response.status}`);
      const body = (await response.json()) as FindingsPayload;
      if (this.requestId !== requestId) return; // superseded while we waited
      this.callbacks.onSuccess(body);
    } catch (cause) {
      if (this.requestId !== requestId) return;
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      this.callbacks.onError(cause instanceof Error ? cause.message : String(cause));
    }
  }
}
