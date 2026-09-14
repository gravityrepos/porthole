// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";

/**
 * What is wrong, from both halves, in one list.
 *
 * Porthole sees inside one process: it can say a frame was late and that
 * composition dominated it. A system trace sees everything else, and is mostly
 * useful for what it rules out — that the device was not starving the app of
 * CPU, not blocking it on disk, and that a chunk of the time belonged to ART
 * rather than to any code the developer wrote.
 *
 * They share a list because they already share a shape: the same severities,
 * and the same distinction between what was observed and what merely happened
 * nearby. Each row says which tool is making the claim, because "Android's
 * frame timeline recorded this" and "Porthole counted this" are not the same
 * kind of statement and should not read as though they were.
 */

interface Finding {
  id: string;
  severity: "error" | "warning" | "note";
  confidence: "observed" | "correlated";
  title: string;
  detail?: string;
  count?: number;
  source: "porthole" | "trace";
}

interface Payload {
  window: { from: number; to: number; ms: number };
  eventsExamined: number;
  findings: Finding[];
  notes: string[];
}

/** How long a burst of `schedule` calls waits for the view to settle, and the
 * longest a continuously-moving view is ever allowed to go unasked. */
const DEBOUNCE_MS = 300;

interface FindingsCallbacks {
  onStart: () => void;
  onSuccess: (payload: Payload) => void;
  onError: (message: string) => void;
}

/**
 * Turns a stream of `schedule` calls -- one per animation frame while the
 * user pans the timeline, or once a tick while `following` is on -- into at
 * most one outstanding `/api/findings` request every `debounceMs`.
 *
 * That "every", not "after", matters and was not obvious until this was
 * tried against a live device: `following` mode calls `schedule` on every
 * animation frame for as long as traffic keeps arriving, which is
 * indefinitely. A plain trailing debounce -- reset the timer on every call,
 * fire when the calls stop -- never fires at all under that load, because
 * the calls never stop; the panel would go stale the moment `following` was
 * turned on and stay that way. So a batch, once started, has a deadline
 * fixed at `debounceMs` from its first call, not from its most recent one:
 * further calls before the deadline still update which window gets asked
 * for, but they no longer push the deadline itself back. Panning briefly and
 * releasing still settles onto one request, `debounceMs` after the pan
 * began; continuous motion gets serviced roughly every `debounceMs` instead
 * of not at all.
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
 * Kept free of React so it can be constructed once per component instance
 * and unit-tested directly, the way the rest of this codebase tests plain
 * classes rather than rendering components.
 */
export class FindingsLoader {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the current batch's deadline falls; null between batches. */
  private batchDeadline: number | null = null;
  private pendingFrom: number | undefined;
  private pendingTo: number | undefined;
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

  /** Queue a request for this window; a call already waiting is replaced,
   * but the batch's deadline is only ever brought closer, never pushed out. */
  schedule(from?: number, to?: number): void {
    this.pendingFrom = from;
    this.pendingTo = to;

    const now = Date.now();
    if (this.batchDeadline === null) this.batchDeadline = now + this.debounceMs;

    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.batchDeadline = null;
        void this.run(this.pendingFrom, this.pendingTo);
      },
      Math.max(0, this.batchDeadline - now),
    );
  }

  /** Run immediately, for the manual refresh button. */
  runNow(from?: number, to?: number): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.batchDeadline = null;
    void this.run(from, to);
  }

  /** Stop anything pending; the component is going away. */
  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.batchDeadline = null;
    this.controller?.abort();
  }

  private async run(from?: number, to?: number): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const requestId = ++this.requestId;

    this.callbacks.onStart();
    try {
      const params = new URLSearchParams();
      if (from !== undefined) params.set("from", String(from));
      if (to !== undefined) params.set("to", String(to));
      const response = await this.fetchImpl(`/api/findings?${params}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`the server answered ${response.status}`);
      const body = (await response.json()) as Payload;
      if (this.requestId !== requestId) return; // superseded while we waited
      this.callbacks.onSuccess(body);
    } catch (cause) {
      if (this.requestId !== requestId) return;
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      this.callbacks.onError(cause instanceof Error ? cause.message : String(cause));
    }
  }
}

const SEVERITY: Record<Finding["severity"], { label: string; className: string }> = {
  error: { label: "ERROR", className: "text-[var(--color-danger)]" },
  warning: { label: "WARN", className: "text-[var(--color-recompose)]" },
  note: { label: "NOTE", className: "text-[var(--color-muted)]" },
};

// This panel used to also take a `tracePath` prop and forward it to
// `/api/findings?trace=...`, but nothing in the UI ever named a trace file to
// put there -- no picker, no setup state, nothing -- so the prop was always
// undefined and the trace half of `findings` was unreachable from here. It
// was removed rather than wired up: building a trace-file picker was not
// part of this fix and has no design. The server-side `trace` query
// parameter this fed is untouched; an agent still populates it by calling
// `capture_system_trace` then `ask_system_trace` (or hitting
// `/api/findings?trace=<path>` directly), and this component renders
// whatever `findings` comes back either way. If `tracePath` reappears here,
// it needs an actual source for the path first.
export function InsightsPanel({ from, to }: { from?: number; to?: number }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // One loader per component instance, not per render -- it carries its own
  // timer and AbortController across renders. A ref, not state, since
  // creating it must never itself trigger a render.
  const loaderRef = useRef<FindingsLoader | null>(null);
  if (loaderRef.current === null) {
    loaderRef.current = new FindingsLoader({
      onStart: () => {
        setLoading(true);
        setError(null);
      },
      onSuccess: (body) => {
        setPayload(body);
        setLoading(false);
      },
      onError: (message) => {
        setError(message);
        setLoading(false);
      },
    });
  }

  useEffect(() => {
    return () => loaderRef.current?.dispose();
  }, []);

  // `from`/`to` move by fractions of a millisecond on every animation frame
  // while the timeline is being panned or is following live traffic.
  // Rounding first means those sub-pixel changes never reach the effect
  // below at all, rather than reaching it and being debounced away --
  // fewer timers started and cancelled for the same end result.
  const roundedFrom = from === undefined ? undefined : Math.round(from);
  const roundedTo = to === undefined ? undefined : Math.round(to);

  useEffect(() => {
    loaderRef.current?.schedule(roundedFrom, roundedTo);
  }, [roundedFrom, roundedTo]);

  const refresh = () => loaderRef.current?.runNow(roundedFrom, roundedTo);

  const findings = payload?.findings ?? [];
  const fromTrace = findings.filter((f) => f.source === "trace").length;

  return (
    <section className="flex min-h-0 flex-col gap-2 overflow-hidden">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="font-mono text-[11px] tracking-[0.12em] text-[var(--color-muted)]">
          INSIGHTS
        </h2>
        <button
          type="button"
          onClick={refresh}
          className="font-mono text-[10px] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          {loading ? "reading…" : "refresh"}
        </button>
      </header>

      {error && <p className="font-mono text-[11px] text-[var(--color-danger)]">{error}</p>}

      {/* GRA-173: this used to also require `!loading`, which reads as "don't
          show a stale empty-state while refreshing" but actually means "take
          it down and put it back up every refresh cycle" -- `following` mode
          calls this component's loader every DEBOUNCE_MS with no user action
          at all, so as long as a window kept coming back empty this paragraph
          unmounted and remounted on every one of those cycles: the founder's
          "right pane flashing over and over" before the cart, which has
          findings and so hits the always-mounted `<ul>` below instead. A
          refresh must not be able to empty a pane that already has something
          to say -- this text is that pane's content, same as a finding is --
          so it now stays keyed to the last-known `payload`, exactly like the
          list does, and the in-flight state reads only from the "reading…"
          swap in the header button above, which changes no layout. */}
      {payload && findings.length === 0 && (
        <p className="text-[12px] leading-relaxed text-[var(--color-muted)]">
          Nothing crossed a threshold in the {Math.round(payload.window.ms / 1000)}s examined.
          That is not the same as the app being fast.
        </p>
      )}

      <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        {findings.map((finding, index) => {
          const severity = SEVERITY[finding.severity];
          return (
            <li
              key={`${finding.id}-${index}`}
              className="rounded border border-[var(--color-line)] bg-[var(--color-panel)] p-2"
            >
              <div className="flex items-center gap-2">
                <span className={`font-mono text-[10px] ${severity.className}`}>
                  {severity.label}
                </span>
                <span
                  className="rounded-sm px-1 font-mono text-[9px] text-[var(--color-muted)] ring-1 ring-[var(--color-line)]"
                  title={
                    finding.source === "trace"
                      ? "from the system trace, which sees the whole device"
                      : "from Porthole, which sees inside the app"
                  }
                >
                  {finding.source}
                </span>
                {/* Load-bearing, so it is on the row and not in a tooltip. */}
                <span className="ml-auto font-mono text-[9px] text-[var(--color-dim)]">
                  {finding.confidence}
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-snug text-[var(--color-fg)]">
                {finding.title}
              </p>
              {finding.detail && (
                <p className="mt-1 text-[11px] leading-snug text-[var(--color-muted)]">
                  {finding.detail}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {payload?.notes.map((note) => (
        <p key={note} className="text-[11px] leading-snug text-[var(--color-dim)]">
          {note}
        </p>
      ))}

      {payload && fromTrace === 0 && !payload.notes.length && (
        <p className="text-[11px] leading-snug text-[var(--color-dim)]">
          Only the app's own view so far. Ask the agent to capture a system trace and correlate
          it against this window to see what the rest of the device was doing — which is mostly
          how a cause gets ruled out.
        </p>
      )}
    </section>
  );
}
