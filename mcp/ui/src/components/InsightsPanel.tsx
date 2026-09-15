// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { Finding, FindingsPayload, TraceListing } from "../types";

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
 *
 * GRA-114 hoisted the fetch itself (`FindingsLoader`, `lib/findingsLoader.ts`)
 * and its debounce out of this component and into `App`: the findings lane
 * (`TimelinePanel`) draws the same `payload` this panel lists, from the same
 * request, so there is exactly one `/api/findings` in flight per settled
 * view rather than one per consumer. This component is now purely
 * presentational — everything below is what it does with the state `App`
 * hands it, not how that state gets fetched.
 */

const SEVERITY: Record<Finding["severity"], { label: string; className: string }> = {
  error: { label: "ERROR", className: "text-[var(--color-danger)]" },
  warning: { label: "WARN", className: "text-[var(--color-recompose)]" },
  note: { label: "NOTE", className: "text-[var(--color-muted)]" },
};

interface Props {
  payload: FindingsPayload | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  /** GRA-114 ruling 4: what `/api/traces` currently lists, for the chooser below. */
  traces: TraceListing[];
  selectedTraceId: string | null;
  onSelectTrace: (id: string | null) => void;
}

/** `recordedAt` first, since that is what a developer scans by; `id` as the
 *  tiebreak so two captures in the same second still sort deterministically. */
function sortedTraces(traces: TraceListing[]): TraceListing[] {
  return [...traces].sort(
    (a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id),
  );
}

/** A small, native `<select>` — ruling 4 says "keep it small", and this is
 *  the smallest thing that lists captures by recorded-at with their
 *  coverage and refuses to let an unreadable one (`coverage: null`) be
 *  chosen. Rendered even with an empty `traces` list, so "no captures yet"
 *  is a real, visible state rather than the control silently vanishing. */
function TraceChooser({ traces, selectedTraceId, onSelectTrace }: Omit<Props, "payload" | "loading" | "error" | "onRefresh">) {
  return (
    <select
      aria-label="trace capture"
      className="min-w-0 max-w-[132px] rounded-sm border border-[var(--color-line)] bg-[var(--color-control)] px-1 py-0.5 font-mono text-[9.5px] text-[var(--color-muted)]"
      value={selectedTraceId ?? ""}
      onChange={(event) => onSelectTrace(event.target.value || null)}
    >
      <option value="">no trace</option>
      {sortedTraces(traces).map((trace) => (
        <option key={trace.id} value={trace.id} disabled={trace.coverage === null} title={trace.reason}>
          {new Date(trace.recordedAt).toLocaleTimeString()}
          {trace.coverage === null ? " — unreadable" : ""}
        </option>
      ))}
    </select>
  );
}

export function InsightsPanel({
  payload,
  loading,
  error,
  onRefresh,
  traces,
  selectedTraceId,
  onSelectTrace,
}: Props) {
  const findings = payload?.findings ?? [];
  const fromTrace = findings.filter((f) => f.source === "trace").length;

  return (
    <section className="flex min-h-0 flex-col gap-2 overflow-hidden">
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-[11px] tracking-[0.12em] text-[var(--color-muted)]">
          INSIGHTS
        </h2>
        <div className="flex items-center gap-2">
          <TraceChooser traces={traces} selectedTraceId={selectedTraceId} onSelectTrace={onSelectTrace} />
          <button
            type="button"
            onClick={onRefresh}
            className="font-mono text-[10px] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          >
            {loading ? "reading…" : "refresh"}
          </button>
        </div>
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
          swap in the header button above, which changes no layout. GRA-114
          moved `payload`/`loading` from this component's own state to props,
          but the gate itself is unchanged: it is still `payload` (not
          `loading`) that decides whether this paragraph is on screen. */}
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
          Only the app's own view so far. {selectedTraceId
            ? "Ask the agent to correlate the chosen capture against this window to see what the rest of the device was doing."
            : "Choose a capture above, or ask the agent to take one, to see what the rest of the device was doing"}
          {" "}— which is mostly how a cause gets ruled out.
        </p>
      )}
    </section>
  );
}
