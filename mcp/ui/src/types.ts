// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
/**
 * GRA-161 AC1: `ConnectionState` re-exported, not redeclared. It used to be
 * `"connecting" | "connected" | "disconnected"` here — a second, hand-typed
 * copy of `mcp/src/device.ts`'s union — and that copy not knowing about
 * GRA-157's "handshaking" member is exactly what produced the red pill this
 * ticket exists to remove: the UI's type could not represent the state the
 * server was actually sending, so `Header.tsx` fell through to its
 * "anything else" branch, which was "disconnected".
 *
 * This is a plain `import type`, fully erased at build time — verified by
 * building the UI (`npx vite build`) after adding it, which produced the
 * same output as before with no Node code pulled into the bundle. It works
 * because this workspace hoists a single `node_modules` (`ui/` has none of
 * its own), so `@types/node` is visible here the same way it is from
 * `mcp/src`, and `moduleResolution: "bundler"` follows the relative path
 * outside `ui/src` without needing a package boundary. Unlike `DeviceEvent`
 * and `Hello` below, which stay independently declared on purpose (see their
 * own comment), `ConnectionState` is a closed union with nothing
 * device-specific to narrow at the point of use — there is no honest
 * "tolerate anything" version of it, so drift is only a cost here, never a
 * flexibility.
 */
import type { ConnectionState } from "../../src/device.ts";
export type { ConnectionState };

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

/**
 * A finding as `/api/findings` sends it (`mcp/src/trace.ts`'s `Finding`,
 * carrying `source` — GRA-113's window/spanning split, mirrored here rather
 * than imported for the same reason `DeviceEvent`/`Hello` above are: the
 * server type pulls in `node:*` at module scope.
 *
 * Every finding carries exactly one of `window` or `spanning`, never both and
 * never neither (GRA-113 AC1) — but this is the wire format, produced by a
 * server that could in principle drift from that rule or be a build ahead of
 * this bundle, so nothing that reads this type is entitled to assume it. See
 * `lib/findings.ts`'s `placeFindings`, which is the one place that has to
 * survive a finding carrying neither.
 */
export interface Finding {
  id: string;
  severity: "error" | "warning" | "note";
  confidence: "observed" | "correlated";
  title: string;
  detail?: string;
  count?: number;
  source: "porthole" | "trace";
  window?: { from: number; to: number };
  spanning?: true;
}

/** `/api/findings`'s whole response body.
 *
 * `asked` (GRA-115 ruling 4) is present only when a `trace=` was resolved and
 * actually queried: one entry per question `mcp/src/perfetto.ts`'s
 * `QUESTIONS` asks, saying whether trace_processor answered it at all. It
 * says nothing about whether the answer became a finding -- a question can
 * be answered and still produce nothing, which is the negative-answer case
 * `lib/askTrace.ts`'s `ruledOut` exists to surface. Optional so a caller that
 * asked with no `trace=`, or an older server, is a real state to render
 * rather than a shape violation. */
export interface FindingsPayload {
  window: { from: number; to: number; ms: number };
  eventsExamined: number;
  findings: Finding[];
  notes: string[];
  asked?: Array<{ id: string; answered: boolean }>;
}

/** One entry of `/api/traces`'s `traces` array (`mcp/src/timeline.ts`'s
 *  `TraceListing`). `coverage` is null when trace_processor could not read
 *  the file's bounds — `reason` says why, and such a trace cannot be chosen. */
export interface TraceListing {
  id: string;
  bytes: number;
  recordedAt: string;
  coverage: { from: number; to: number } | null;
  reason?: string;
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
