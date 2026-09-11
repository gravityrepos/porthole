// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
/**
 * The wire format, as it actually arrives.
 *
 * Event payloads are loosely typed on purpose. They come from Kotlin as plain
 * JSON objects whose shape depends on the event name, and pretending otherwise
 * with a big discriminated union would mean maintaining a second copy of the
 * protocol here that could silently drift from the device. The accessors below
 * are the honest alternative: narrow at the point of use, tolerate anything.
 */
export interface DeviceEvent {
  event: string;
  /** Device uptime in ms. Every event and report shares this clock. */
  t: number;
  seq: number;
  data: Record<string, unknown>;
  /** Client-side marker: a log_append already folded into its parent entry. */
  applied?: boolean;
}

export interface Hello {
  protocol: number;
  packageName: string;
  processName: string;
  versionName: string | null;
  device: string;
  sdkInt: number;
  startedAt: number;
  collectors: string[];
}

export type ConnectionState = "connecting" | "connected" | "disconnected";

export type ServerMessage =
  | {
      type: "init" | "reset";
      events?: DeviceEvent[];
      state?: ConnectionState;
      hello?: Hello | null;
    }
  | { type: "event"; event: DeviceEvent }
  | { type: "state"; state: ConnectionState }
  | { type: "hello"; hello: Hello | null };

/** A start/end pair, or a single event with a duration, drawn as a bar. */
export interface Span {
  id: string;
  start: number;
  end: number;
  open: boolean;
  data: Record<string, unknown>;
}

export interface ViewWindow {
  start: number;
  end: number;
}

// --- accessors --------------------------------------------------------------
// Everything below takes `unknown` because that is what JSON gives you.

export function num(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  return value == null ? fallback : String(value);
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function strings(value: unknown): string[] {
  return list(value).map((entry) => str(entry));
}
