// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
export type LaneKind =
  "density" | "writes" | "jank" | "blocked" | "markers" | "spans" | "levels" | "area" | "findings";

export interface Lane {
  /** Event name this lane draws, and the key hit-testing matches on. */
  key: string;
  label: string;
  /** CSS custom property holding the lane's colour. */
  color: string;
  /** Row height in pixels. The gutter and the plot share it. */
  height: number;
  kind: LaneKind;
}

export const LANES: Lane[] = [
  // GRA-114: the one lane whose data is a server answer rather than the
  // event buffer, so it goes first — above recompose, which is the ticket's
  // ruling on open question 2 (inside the scrolling list, not pinned above
  // the ruler, for 0.2.0). Its own colour is only the gutter accent; the
  // marks it draws are coloured per finding by severity (see draw.ts).
  { key: "findings", label: "findings", color: "--color-muted", height: 92, kind: "findings" },
  { key: "recompose", label: "recompositions", color: "--recompose", height: 144, kind: "density" },
  { key: "state_write", label: "state writes", color: "--write", height: 76, kind: "writes" },
  // Directly under recompositions on purpose: the question this tool exists to
  // answer is whether the churn above is costing frames below.
  { key: "frame", label: "dropped frames", color: "--danger", height: 88, kind: "jank" },
  { key: "blocked", label: "main thread", color: "--danger", height: 76, kind: "blocked" },
  { key: "nav", label: "navigation", color: "--nav", height: 76, kind: "markers" },
  { key: "http", label: "http", color: "--http", height: 60, kind: "spans" },
  { key: "db", label: "db", color: "--db", height: 60, kind: "spans" },
  { key: "work", label: "work", color: "--work", height: 60, kind: "spans" },
  { key: "memory", label: "memory", color: "--memory", height: 88, kind: "area" },
  { key: "device", label: "device", color: "--device", height: 76, kind: "markers" },
  // Only warnings and worse. A tick per debug line would be a solid bar and say
  // nothing; a cluster of red next to a recomposition burst says a great deal.
  { key: "log", label: "warnings", color: "--db", height: 60, kind: "levels" },
];

/** Legend chips in the header. Two lanes share --danger, so it is shown once. */
export const LEGEND = [
  { name: "recompose", color: "--recompose" },
  { name: "state", color: "--write" },
  { name: "frames", color: "--danger" },
  { name: "nav", color: "--nav" },
  { name: "http", color: "--http" },
  { name: "db", color: "--db" },
  { name: "work", color: "--work" },
  { name: "memory", color: "--memory" },
  { name: "device", color: "--device" },
];

export const MIN_SPAN_MS = 50;
export const BUCKET_PX = 3;
/** Vertical guides every eighth of the plot, matching the ruler's ticks. */
export const TICK_COUNT = 8;

/**
 * Findings-lane layout (GRA-114). Shared by `lib/findings.ts` (row
 * assignment), `timeline/draw.ts` (painting the rows it assigns) and
 * `lib/laneData.ts` (hit-testing the same rows back from a pointer
 * position) — one set of numbers rather than three that could drift apart.
 * Ruling 1: fixed height, overlap resolved by stacking up to three rows,
 * a count glyph beyond that.
 */
export const MAX_FINDING_ROWS = 3;
export const FINDINGS_ROW_HEIGHT = 20;
export const FINDINGS_ROW_GAP = 4;
export const FINDINGS_CEILING = 10;
