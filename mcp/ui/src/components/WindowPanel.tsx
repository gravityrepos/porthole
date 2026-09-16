// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { WindowSummary } from "../lib/analysis";

interface Props {
  summary: WindowSummary;
  onAsk: () => void;
}

/**
 * The window pane: everything true of the visible range, regardless of what is
 * selected. It lives apart from the selection because it answers a different
 * question — reading "caused by" under a selected HTTP call implied those
 * writes caused that call, which is not what the counts mean.
 */
export function WindowPanel({ summary, onAsk }: Props) {
  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-3.5 py-2.5">
        <span className="font-mono text-[10px] tracking-[0.12em] text-[var(--color-dim)]">
          IN VIEW
        </span>
        <span className="font-mono text-[10px] text-[var(--color-muted)]">{summary.label}</span>
      </div>

      <div className="flex min-w-0 flex-col gap-4 overflow-y-auto px-3.5 pt-3 pb-4.5">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(88px,1fr))] gap-2">
          {summary.metrics.map((metric) => (
            <div
              key={metric.label}
              className="rounded-lg border border-[#242c3a] bg-[var(--color-tile)] px-2.5 py-[9px]"
            >
              <div className="font-mono text-[9.5px] tracking-[0.1em] text-[var(--color-dim)]">
                {metric.label}
              </div>
              <div className="mt-1.5 font-mono text-[17px]" style={{ color: metric.color }}>
                {metric.value}
              </div>
            </div>
          ))}
        </div>

        {summary.causes.length > 0 && (
          <Section
            title="PRECEDED RECOMPOSITIONS"
            hint="State writes that landed just before a recomposition in this window. Ordering, not proof."
          >
            <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-[#242c3a] bg-[#242c3a]">
              {summary.causes.map((cause) => (
                <div
                  key={cause.key}
                  className="flex items-center justify-between gap-2.5 bg-[var(--color-tile)] px-2.5 py-2 hover:bg-[#1d2532]"
                >
                  <div className="min-w-0">
                    <div
                      className="truncate font-mono text-[11.5px]"
                      style={{ color: cause.named ? "#d5dde9" : "var(--color-muted)" }}
                      title={cause.key}
                    >
                      {cause.key}
                    </div>
                    <div
                      className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-dim)]"
                      title={cause.where}
                    >
                      {cause.where}
                    </div>
                  </div>
                  <span className="rounded-full bg-[color-mix(in_srgb,var(--write)_12%,transparent)] px-[7px] py-0.5 font-mono text-[10.5px] whitespace-nowrap text-[var(--write)]">
                    {cause.count}×
                  </span>
                </div>
              ))}
            </div>
          </Section>
        )}

        <Section title="FRAME IMPACT">
          <div className="rounded-lg border border-[#242c3a] bg-[var(--color-tile)] p-[11px]">
            {summary.frames.bars.length > 0 ? (
              <div className="flex h-[46px] items-end gap-[3px]">
                {summary.frames.bars.map((bar, index) => (
                  <div
                    key={index}
                    className="min-w-[2px] flex-1 rounded-[1px]"
                    style={{
                      height: `${bar.height}%`,
                      background:
                        bar.level === "bad"
                          ? "var(--danger)"
                          : bar.level === "warn"
                            ? "var(--recompose)"
                            : "#2f3a4c",
                    }}
                  />
                ))}
              </div>
            ) : (
              <div className="flex h-[46px] items-center font-mono text-[11px] text-[var(--color-muted)]">
                no dropped frames in view
              </div>
            )}
            <div className="mt-2 flex justify-between font-mono text-[10px] text-[var(--color-dim)]">
              <span>{summary.frames.missed} frames missed</span>
              {summary.frames.worstMs > 0 && (
                <span className="text-[var(--danger)]">worst {summary.frames.worstMs}ms</span>
              )}
            </div>
          </div>
        </Section>

        {summary.observation && (
          <div className="rounded-lg border border-[color-mix(in_srgb,var(--accent)_22%,transparent)] bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] p-[11px]">
            <div className="mb-1.5 font-mono text-[9.5px] tracking-[0.1em] text-[var(--accent)]">
              OBSERVED
            </div>
            <div className="text-[12px] leading-[1.55] text-pretty text-[#a6b3c4]">
              {summary.observation}
            </div>
            <div className="mt-2.5 flex gap-1.5">
              <button
                onClick={onAsk}
                title="Copy a prompt describing this window"
                className="cursor-pointer rounded-[5px] bg-[var(--accent)] px-2.5 py-1 font-mono text-[10.5px] text-[#0f1620] hover:brightness-110"
              >
                ask agent
              </button>
            </div>
          </div>
        )}

        <div className="font-mono text-[10.5px] leading-[1.7] text-[var(--color-muted)]">
          pinch or ctrl/⌘ + scroll to zoom
          <br />
          swipe sideways, shift + scroll, or drag to pan
          <br />
          follow pins the newest event
        </div>
      </div>
    </section>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="mb-2 font-mono text-[9.5px] tracking-[0.1em] text-[var(--color-dim)]"
        title={hint}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
