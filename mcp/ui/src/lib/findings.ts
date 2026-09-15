// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { MAX_FINDING_ROWS } from "../timeline/lanes";
import { toX } from "../timeline/geometry";
import type { Finding, ViewWindow } from "../types";

/**
 * Placement maths for the findings lane (GRA-114), kept free of the DOM and
 * of canvas the same way `timeline/geometry.ts` is: a finding's `window` is
 * only ever a fact about the device's uptime clock, and turning that into a
 * pixel rectangle for a given view is arithmetic, not rendering. `draw.ts`
 * paints whatever this returns; it does not recompute any of it.
 *
 * A finding is placed one of two ways:
 *  - a `window` finding gets a rectangle spanning `from`..`to` (a point
 *    becomes a thin mark, `MIN_MARK_PX` wide, never truly zero-width — a
 *    0px rectangle is unclickable and invisible, and a finding that fired is
 *    neither);
 *  - a `spanning` finding (GRA-113: a property of the whole window asked
 *    about, not a moment inside it) gets a rectangle covering `queryWindow`
 *    itself — the window `/api/findings` was actually asked about, which is
 *    usually but not always the same as the current `view` (the view can
 *    have moved a little since the request that produced this payload was
 *    sent). It is drawn as a dim band by `draw.ts`, never as a point.
 *
 * A finding with neither `window` nor `spanning` is a defect in whatever
 * produced it (GRA-113 AC1 says every finding carries exactly one), but this
 * is the wire boundary and nothing here is entitled to assume the server
 * upheld that. Such a finding is silently not placed — skipped, not thrown —
 * so one bad finding cannot blank the rest of the lane or crash the tab.
 */

export const MIN_MARK_PX = 3;

export interface PlacedFinding {
  finding: Finding;
  /** Left edge in pixels, already clamped to `[0, width]`. */
  x: number;
  /** Pixel width, already clamped so `x + width <= width`. At least `MIN_MARK_PX`. */
  width: number;
  /** Which of up to `MAX_FINDING_ROWS` stacked rows this occupies. */
  row: number;
  /** True for a `spanning` finding — drawn as a dim band, not a mark. */
  band: boolean;
}

export interface FindingsLayout {
  placed: PlacedFinding[];
  /** Findings that overlapped past `MAX_FINDING_ROWS` and were not placed. */
  overflow: number;
}

interface Candidate {
  finding: Finding;
  start: number;
  end: number;
  band: boolean;
}

/**
 * `finding.window`/`spanning` → a pixel rectangle for `view` at `width`, and
 * an assignment to one of `MAX_FINDING_ROWS` rows so that findings whose
 * windows overlap on screen stack instead of painting over one another.
 *
 * Row assignment is greedy first-fit over candidates sorted by their left
 * edge: a finding goes in the first row whose most recently placed item ends
 * at or before this one's start, or opens a fresh row if fewer than
 * `MAX_FINDING_ROWS` are in use yet. A finding that fits nowhere is counted
 * in `overflow`, not placed — this is what lets the lane show a `+N` glyph
 * instead of either hiding findings or growing without bound (GRA-114 open
 * question 1).
 */
export function placeFindings(
  findings: Finding[],
  queryWindow: { from: number; to: number },
  view: ViewWindow,
  width: number,
): FindingsLayout {
  if (width <= 0 || view.end <= view.start) return { placed: [], overflow: 0 };

  const candidates: Candidate[] = [];

  for (const finding of findings) {
    if (finding.spanning) {
      const rect = clip(toX(queryWindow.from, view, width), toX(queryWindow.to, view, width), width);
      if (rect) candidates.push({ finding, start: rect.x, end: rect.x + rect.width, band: true });
      continue;
    }
    if (!finding.window) continue; // neither window nor spanning: a defect upstream, not drawn here.
    const rect = clip(toX(finding.window.from, view, width), toX(finding.window.to, view, width), width);
    if (rect) candidates.push({ finding, start: rect.x, end: rect.x + rect.width, band: false });
  }

  // Left-to-right so row assignment reads the same order the eye does.
  candidates.sort((a, b) => a.start - b.start);

  const rowEnds: number[] = [];
  const placed: PlacedFinding[] = [];
  let overflow = 0;

  for (const candidate of candidates) {
    let row = rowEnds.findIndex((end) => candidate.start >= end);
    if (row === -1) {
      if (rowEnds.length >= MAX_FINDING_ROWS) {
        overflow += 1;
        continue;
      }
      row = rowEnds.length;
      rowEnds.push(candidate.end);
    } else {
      rowEnds[row] = candidate.end;
    }
    placed.push({
      finding: candidate.finding,
      x: candidate.start,
      width: candidate.end - candidate.start,
      row,
      band: candidate.band,
    });
  }

  return { placed, overflow };
}

/**
 * `x1`..`x2` (raw, unclamped screen coordinates) → a rectangle clamped to
 * `[0, width]`, or null when it falls entirely outside — the two open
 * questions the ticket names directly: a window that starts before the view
 * clamps its left edge to 0 rather than drawing off-canvas or being dropped,
 * and one that ends after the view clamps its right edge to `width` the same
 * way. `MIN_MARK_PX` is enforced on the raw span before clamping, so a point
 * finding sitting just inside one edge of the view still gets a visible,
 * clickable width rather than being squeezed to nothing by the clamp.
 */
function clip(x1: number, x2: number, width: number): { x: number; width: number } | null {
  const rawEnd = Math.max(x2, x1 + MIN_MARK_PX);
  if (rawEnd < 0 || x1 > width) return null;
  const left = Math.max(x1, 0);
  const right = Math.min(rawEnd, width);
  return { x: left, width: right - left };
}
