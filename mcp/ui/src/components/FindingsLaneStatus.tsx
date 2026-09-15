// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0

export type FindingsState = "loading" | "stale" | "empty" | "ready";

interface Props {
  state: FindingsState;
  count: number;
  traceLoaded: boolean;
}

/**
 * The findings lane's own gutter text, pulled out of `TimelinePanel`/
 * `LaneRow` the same way `FindingsLoader` was pulled out of `InsightsPanel`
 * and `protocolBanner` out of `App`: this workspace's happy-dom render tests
 * have no canvas or `ResizeObserver`, and `TimelinePanel` owns both, so
 * nothing that lives inside it can be mounted directly in a DOM test. This
 * component owns neither — it is pure text driven by props — so it can be
 * rendered on its own and its states asserted directly.
 *
 * GRA-114 ruling 1: the findings lane owns three states, drawn distinctly —
 * "loading" (a request is in flight and nothing has ever landed), "stale" (a
 * previous answer is on screen while a newer request is in flight) and
 * "empty" (an answer landed and it named nothing). The ticket's own
 * requirement is specific: empty must not *look like* loading, the way
 * GRA-173 found InsightsPanel's old empty-state paragraph flickering in and
 * out on every refresh because "loading" and "nothing to report" shared one
 * gate. Here the three read as different sentences, not different timings
 * of the same one, and each carries a `data-findings-state` attribute so a
 * test (or a human skimming markup) does not have to parse English to tell
 * them apart.
 */
export function FindingsLaneStatus({ state, count, traceLoaded }: Props) {
  const label =
    state === "loading"
      ? "reading…"
      : state === "stale"
        ? "stale — refreshing…"
        : state === "empty"
          ? "no findings in view"
          : `${count} finding${count === 1 ? "" : "s"}`;

  return (
    <>
      <span
        data-findings-state={state}
        className="truncate pl-2.5 font-mono text-[10px]"
        style={{ color: state === "empty" ? "var(--color-dim)" : "var(--color-muted)" }}
      >
        {label}
      </span>
      {/* Ruling 6: with no trace loaded, one line says so, and names the
          chooser (InsightsPanel's header) as the way out — this is that one
          line, not the chooser itself. */}
      {!traceLoaded && (
        <span
          data-findings-trace-missing=""
          className="truncate pl-2.5 font-mono text-[9.5px] text-[var(--color-faint)]"
        >
          trace half not loaded — choose a capture above
        </span>
      )}
    </>
  );
}
