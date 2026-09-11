// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { MIN_SPAN_MS } from "./lanes";
import type { DeviceEvent, ViewWindow } from "../types";

/*
 * The plot column starts at x = 0 now. Lane labels live in a real DOM gutter
 * beside it, so the old label offset is gone and every lane canvas shares one
 * simple mapping.
 */

export function toX(t: number, view: ViewWindow, width: number): number {
  return ((t - view.start) / (view.end - view.start)) * width;
}

export function toTime(x: number, view: ViewWindow, width: number): number {
  return view.start + (x / width) * (view.end - view.start);
}

export function bounds(events: DeviceEvent[]): { min: number; max: number } {
  if (events.length === 0) return { min: 0, max: 1000 };
  const min = events[0].t;
  const max = events[events.length - 1].t;
  return { min, max: Math.max(max, min + MIN_SPAN_MS) };
}

export function fitView(events: DeviceEvent[]): ViewWindow {
  const { min, max } = bounds(events);
  const pad = Math.max((max - min) * 0.02, 20);
  return { start: min - pad, end: max + pad };
}

/** Keeps the newest event pinned near the right edge without changing zoom. */
export function followNewest(view: ViewWindow, events: DeviceEvent[]): ViewWindow {
  if (events.length === 0) return view;
  const span = view.end - view.start;
  const newest = events[events.length - 1].t;
  return { start: newest - span * 0.92, end: newest + span * 0.08 };
}

export function zoomAt(view: ViewWindow, anchor: number, factor: number): ViewWindow {
  const span = Math.max((view.end - view.start) * factor, MIN_SPAN_MS);
  const ratio = (anchor - view.start) / (view.end - view.start);
  return { start: anchor - span * ratio, end: anchor + span * (1 - ratio) };
}

export function panBy(view: ViewWindow, deltaMs: number): ViewWindow {
  return { start: view.start + deltaMs, end: view.end + deltaMs };
}

export function centreOn(view: ViewWindow, t: number): ViewWindow {
  const span = view.end - view.start;
  return { start: t - span / 2, end: t + span / 2 };
}

/** Seconds since the first event, which is what the ruler counts in. */
export function relativeSeconds(t: number, events: DeviceEvent[]): number {
  return (t - bounds(events).min) / 1000;
}
