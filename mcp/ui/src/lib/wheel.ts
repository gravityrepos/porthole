// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * GRA-194: what one wheel event means to the timeline.
 *
 * Before this, every wheel event zoomed, by a fixed 25% per event, keyed on
 * the sign of `deltaY` alone. On a mouse wheel that was one axis and one
 * gesture, so it worked by accident. On a trackpad it made the timeline
 * unusable: a two-finger vertical scroll zoomed *and* scrolled the lane list
 * (React's `onWheel` is passive, so nothing was prevented), a sideways swipe
 * had `deltaY === 0`, which the ternary read as "zoom in", and a pinch was
 * indistinguishable from either.
 *
 * The convention here is the one Perfetto and every trace viewer share:
 *
 *  - **ctrl/cmd + wheel, or a pinch** (browsers deliver a trackpad pinch as
 *    a wheel with `ctrlKey`): zoom at the cursor, by an amount that scales
 *    with the delta's magnitude and is clamped so one wild event cannot
 *    throw the view across the whole recording.
 *  - **shift + wheel, or a wheel whose horizontal delta dominates** (a
 *    sideways swipe, a tilt wheel): pan by that delta.
 *  - **a plain vertical wheel**: not the timeline's business. The lane list
 *    scrolls, as any list does.
 *
 * Pure: the row that owns the canvas feeds it the event's fields and acts
 * on the answer, and prevents the browser's default only for `zoom` and
 * `pan`. `deltaMode` lines and pages are converted to pixels first so the
 * dominant-axis and magnitude judgements see one unit.
 */
export interface WheelInput {
  deltaX: number;
  deltaY: number;
  /** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export type WheelIntent =
  | { kind: "zoom"; factor: number }
  | { kind: "pan"; deltaPx: number }
  | { kind: "scroll" };

/** One `deltaMode` line, in pixels. Browsers use about this for a wheel notch. */
export const LINE_PX = 16;
/** One `deltaMode` page, in pixels. */
export const PAGE_PX = 800;
/**
 * Zoom per pixel of wheel delta, as an exponent: 100px of ctrl-wheel is a
 * factor of e^0.2, about ×1.22, roughly the old fixed step for one notch.
 */
export const ZOOM_PER_PX = 0.002;
/** No single event zooms by more than this, in or out. */
export const MAX_ZOOM_FACTOR = 2;

export function interpretWheel(input: WheelInput): WheelIntent {
  const scale = input.deltaMode === 1 ? LINE_PX : input.deltaMode === 2 ? PAGE_PX : 1;
  const dx = input.deltaX * scale;
  const dy = input.deltaY * scale;
  // A pinch and a modifier-wheel both arrive on deltaY; fall back to deltaX
  // only when there is nothing vertical to read.
  const dominant = dy !== 0 ? dy : dx;

  if (input.ctrlKey || input.metaKey) {
    if (dominant === 0) return { kind: "scroll" };
    // Positive delta (wheel down, fingers together) zooms out, as before.
    const raw = Math.exp(dominant * ZOOM_PER_PX);
    const factor = Math.min(MAX_ZOOM_FACTOR, Math.max(1 / MAX_ZOOM_FACTOR, raw));
    return { kind: "zoom", factor };
  }

  if (input.shiftKey) {
    return dominant === 0 ? { kind: "scroll" } : { kind: "pan", deltaPx: dominant };
  }

  // A tie goes to vertical: a diagonal gesture with no clear direction is
  // read as the list scroll it most likely was, never as a pan.
  if (Math.abs(dx) > Math.abs(dy)) return { kind: "pan", deltaPx: dx };
  return { kind: "scroll" };
}
