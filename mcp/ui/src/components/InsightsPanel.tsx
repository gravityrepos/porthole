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

/** How long a burst of `schedule` calls waits for the view to settle. */
const DEBOUNCE_MS = 300;

interface FindingsCallbacks {
  onStart: () => void;
  onSuccess: (payload: Payload) => void;
  onError: (message: string) => void;
}

/**
 * Turns a stream of `schedule` calls -- one per animation frame while the
 * user pans the timeline, or once a tick while `following` is on -- into at
 * most one outstanding `/api/findings` request.
 *
 * Three separate guards, because any one alone leaves a gap:
 *  - debounced: a burst of `schedule` calls before `DEBOUNCE_MS` elapses
 *    collapses to a single fetch, fired once the view stops moving;
 *  - cancelled: a fetch still in flight when a newer one starts is aborted,
 *    so the server is not left computing an answer nobody wants any more;
 *  - ordered: an aborted fetch's promise can still settle (a test's fake
 *    fetch, or a runtime that does not wire the signal all the way through),
 *    so a request id is checked again on the way out -- only the most recent
 *    `run` is allowed to report its result.
 *
 * Kept free of React so it can be constructed once per component instance
 * and unit-tested directly, the way the rest of this codebase tests plain
 * classes rather than rendering components.
 */
export class FindingsLoader {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private requestId = 0;
  private readonly debounceMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly callbacks: FindingsCallbacks,
    options?: { debounceMs?: number; fetchImpl?: typeof fetch },
  ) {
    this.debounceMs = options?.debounceMs ?? DEBOUNCE_MS;
    this.fetchImpl = options?.fetchImpl ?? fetch;
  }

  /** Queue a request for this window; a call already waiting is replaced. */
  schedule(from?: number, to?: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(from, to), this.debounceMs);
  }

  /** Run immediately, for the manual refresh button. */
  runNow(from?: number, to?: number): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.run(from, to);
  }

  /** Stop anything pending; the component is going away. */
  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
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

      {payload && findings.length === 0 && !loading && (
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
          Only the app's own view so far. Record a system trace and pass it to see what the rest
          of the device was doing — which is mostly how a cause gets ruled out.
        </p>
      )}
    </section>
  );
}
