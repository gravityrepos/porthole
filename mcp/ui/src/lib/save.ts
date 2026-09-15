// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { ViewWindow } from "../types";

/**
 * GRA-116: "keep the last N seconds, from where you are already looking" --
 * the header's own gesture for GRA-54's save path, computed from state App
 * already holds (`view`, `following`, the newest event's own clock) rather
 * than reimplemented against a second source of truth.
 *
 * Open question 1, answered: the window a "keep" click saves depends on
 * whether the view is pinned to the live edge.
 *
 *  - **Zoomed or panned away** (`following` false): exactly what the ruler
 *    shows, rounded to the millisecond -- the same rounding
 *    `summariseWindow` (lib/analysis.ts) already applies to a `ViewWindow`,
 *    mirrored here rather than imported so this module stays independent of
 *    that one's other computation. Two callers rounding a view the same way
 *    independently is a real risk (this project's own GRA-163 history), but
 *    the alternative -- importing `summariseWindow` just for its rounding --
 *    would pull WindowSummary's whole metrics computation in for one line.
 *  - **Following the live edge** (`following` true): NOT the view. App's own
 *    following effect (App.tsx) keeps `view.end` a few percent of the span
 *    *ahead* of the newest event on purpose, so freshly arriving events do
 *    not draw flush against the panel's right edge -- saving that would ask
 *    the server for events that do not exist yet. Instead this is a fixed
 *    `lookbackSeconds`-wide window ending at `newestEventT`, the device
 *    uptime of the newest event actually seen, which is the honest "now".
 */

/** Ruling 1: the small input's default. */
export const DEFAULT_LOOKBACK_SECONDS = 30;

export interface SaveWindowInput {
  following: boolean;
  view: ViewWindow;
  /** Whole seconds, as the header's own number input carries it. */
  lookbackSeconds: number;
  /** Device uptime `t` of the newest event seen so far, or null before anything has arrived. */
  newestEventT: number | null;
}

export interface SaveWindowResult {
  from: number;
  to: number;
}

/**
 * The window a "keep" click would save right now, or null when there is
 * nothing to save -- following, with nothing buffered yet, has no "now" to
 * count back from. `from` is clamped to 0 rather than going negative: device
 * uptime never has, and a negative `from` would ask the server for a window
 * that starts before the device itself did.
 */
export function saveWindow(input: SaveWindowInput): SaveWindowResult | null {
  if (!input.following) {
    return { from: Math.round(input.view.start), to: Math.round(input.view.end) };
  }
  if (input.newestEventT === null) return null;
  const to = Math.round(input.newestEventT);
  const lookbackMs = Math.round(input.lookbackSeconds * 1000);
  return { from: Math.max(0, to - lookbackMs), to };
}

/** `POST /api/save`'s body, ruling 2. */
export interface SaveRequestBody {
  from: number;
  to: number;
  scenario?: string;
}

/**
 * `scenario` is omitted rather than sent as `""`/`undefined` for an unnamed
 * save -- the server's own default (`defaultScenarioName`) only applies when
 * the key is absent, and sending an empty string would ask it to name a
 * moment `moment--` instead.
 */
export function saveRequestBody(window: SaveWindowResult, scenario?: string): SaveRequestBody {
  const trimmed = scenario?.trim();
  return trimmed ? { from: window.from, to: window.to, scenario: trimmed } : { from: window.from, to: window.to };
}
