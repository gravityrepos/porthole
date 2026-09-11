// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from "react";

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

const SEVERITY: Record<Finding["severity"], { label: string; className: string }> = {
  error: { label: "ERROR", className: "text-[var(--color-danger)]" },
  warning: { label: "WARN", className: "text-[var(--color-recompose)]" },
  note: { label: "NOTE", className: "text-[var(--color-muted)]" },
};

export function InsightsPanel({
  from,
  to,
  tracePath,
}: {
  from?: number;
  to?: number;
  tracePath?: string;
}) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (from !== undefined) params.set("from", String(Math.round(from)));
      if (to !== undefined) params.set("to", String(Math.round(to)));
      if (tracePath) params.set("trace", tracePath);
      const response = await fetch(`/api/findings?${params}`);
      if (!response.ok) throw new Error(`the server answered ${response.status}`);
      setPayload((await response.json()) as Payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [from, to, tracePath]);

  useEffect(() => {
    void load();
  }, [load]);

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
          onClick={() => void load()}
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
