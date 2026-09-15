// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DeviceEvent } from "./device.js";
import { buildTrace, type Trace } from "./trace.js";
import {
  clippedMsOf,
  fillWindowFromDisk,
  listAllSessions,
  sessionSizeBytes,
  type ClippedMs,
  type SessionMetaWithDir,
} from "./sessions.js";

/**
 * GRA-54: turning a slice of what already happened into a named artifact,
 * after the fact.
 *
 * Every other way Porthole produces a durable trace requires deciding to
 * record in advance — `capture` wraps a command, `capture_system_trace`
 * blocks for a fixed duration. Once GRA-53 put sessions on disk, the
 * material for "something bad just happened, keep it" already exists; this
 * module is the one place that turns a window someone already asked about
 * (through `findings`, say) into a trace file, called from both the MCP tool
 * `save_moment` (index.ts, which already has a live device's identity and a
 * merged view to hand in) and the CLI's `porthole save` (which has neither,
 * and resolves both from disk alone — see `saveFromSessions` below).
 *
 * Deliberately thin, on purpose, twice over:
 *
 *  - `buildTrace` (trace.ts) is the exact analyser `capture` and the live
 *    `findings` tool both call. Byte-compatibility with `capture`'s output
 *    is therefore a consequence of calling the same function, not a goal
 *    pursued separately here — nothing in this module reimplements a
 *    metric, a finding, or a percentile.
 *  - The events handed to `buildSavedTrace` always already come from
 *    `fillWindowFromDisk` (sessions.ts) — the same merge `findings`,
 *    `what_was_happening` and `timeline` all use. This module does not read
 *    `events.ndjson` itself and does not merge live and disk data a second
 *    way; `saveFromSessions`'s own disk-only use of that same function is
 *    the CLI's one exception to "always has a live device", not a new
 *    mechanism.
 */

/** Recorded on every trace this module builds, so a reader can tell it apart from a live `capture`. Ruling 3. */
export const SAVE_DRIVER = "session";

export interface SaveWindow {
  from: number;
  to: number;
}

/** `Trace`, plus the one field `capture`'s own output never carries: how much of the requested window was actually recorded. */
export interface SavedTrace extends Trace {
  clippedMs: ClippedMs;
}

/**
 * Ruling 1 / EM's open-question-2, ratified by the coordinator: a saved
 * moment gets a name even when nobody gave it one, because a required
 * `--scenario`/`scenario` is friction the ticket exists to remove. On the
 * uptime clock the window itself is already expressed in, so two saves of
 * the same window land on the same default name rather than one that
 * depends on wall-clock time nobody asked about.
 */
export function defaultScenarioName(from: number, to: number): string {
  return `moment-${from}-${to}`;
}

/**
 * Ruling 1: the default output path — the same `.porthole/traces/`
 * directory `capture_system_trace` already writes under, so a saved moment
 * and a system trace from the same investigation land next to each other.
 */
export function defaultOutPath(projectRoot: string, scenario: string): string {
  return path.join(projectRoot, ".porthole", "traces", `${scenario}.json`);
}

export interface BuildSavedTraceOptions {
  events: DeviceEvent[];
  hello: Record<string, unknown> | null;
  window: SaveWindow;
  /** From the same merged view's `coveredFrom`/`coveredTo` — see `fillWindowFromDisk`. */
  coveredFrom: number | null;
  coveredTo: number | null;
  scenario: string;
}

/**
 * Ruling 3: calls `buildTrace` exactly as `capture` does, with
 * `driver: "session"` and `withEvents: false` always — `--with-events` is
 * cut from this ticket (the EM's own recommendation, taken): a saved moment
 * sits right next to the session file it came from on disk, so embedding a
 * copy of the same events inside the trace would only double the bytes to
 * hand back something already there.
 *
 * Ruling 4: `clippedMs` is computed by the exact function `findings` uses
 * (`clippedMsOf`, sessions.ts) — not a second, hand-rolled copy of the same
 * formula.
 */
export function buildSavedTrace(options: BuildSavedTraceOptions): SavedTrace {
  const trace = buildTrace({
    scenario: options.scenario,
    driver: SAVE_DRIVER,
    events: options.events,
    hello: options.hello,
    durationMs: Math.max(0, options.window.to - options.window.from),
    withEvents: false,
  });
  return {
    ...trace,
    clippedMs: clippedMsOf(options.window.from, options.window.to, options.coveredFrom, options.coveredTo),
  };
}

/** Writes the trace to `outPath`, creating the directory if it does not exist yet. */
export async function writeSavedTrace(trace: SavedTrace, outPath: string): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(trace, null, 2));
}

/**
 * Ruling 4: "the tool's summary line states the coverage in words when it
 * is not complete." One sentence, or "" when the window was fully covered
 * — left off entirely rather than a hollow "0.0s was not recorded", the
 * same convention `findings`' own `missing` string in index.ts already
 * uses.
 */
export function coverageNote(clipped: ClippedMs): string {
  const shortfallMs = clipped.start + clipped.end;
  if (shortfallMs <= 0) return "";
  const seconds = Math.round(shortfallMs / 100) / 10;
  return ` ${seconds}s of the requested window was never recorded and is not in this trace.`;
}

// ---------------------------------------------------------------------------
// the CLI's disk-only path — no live device, so both "which session" and
// "what does --since count back from" have to come from what is on disk
// ---------------------------------------------------------------------------

export interface SaveFromSessionsOptions {
  root: string;
  projectRoot: string;
  scenario?: string;
  sinceMs?: number;
  from?: number;
  to?: number;
  out?: string;
}

export interface CommandResult {
  /** Process exit code: 0 success, 1 nothing to act on, 2 bad input. */
  code: number;
  message: string;
}

/**
 * `porthole save`'s implementation. Unlike `save_moment` (index.ts), a
 * fresh CLI invocation has no live device and no live buffer to ask "what
 * does --since count back from" of — so both the identity to search and,
 * for `--since`, the anchor the lookback counts from, are resolved from
 * whichever session on disk was most recently written to. That is a real
 * limitation worth naming plainly: with more than one app or device
 * recording into the same sessions root, this picks the busiest one, not
 * necessarily the one the caller meant. `--from`/`--to` (quoted from an
 * earlier `findings` result) sidestep the ambiguity for the window itself,
 * but still use the same most-recently-active session to decide *whose*
 * sessions to search — there is no `--package`/`--device` flag on this
 * command to disambiguate further (not asked for by the ticket, and adding
 * one is a decision, not a bug fix).
 */
export async function saveFromSessions(options: SaveFromSessionsOptions): Promise<CommandResult> {
  const sessions = await listAllSessions(options.root);
  const withData = sessions.filter(
    (session): session is SessionMetaWithDir & { firstT: number; lastT: number } =>
      session.firstT !== null && session.lastT !== null,
  );
  if (withData.length === 0) {
    return {
      code: 1,
      message: "No sessions recorded on disk yet. Run `porthole ui` or `porthole mcp` against the app first.",
    };
  }

  // Most recently *active*, not most recently *started* — a session open
  // for hours with a fresh event just now is the one worth calling "now",
  // regardless of when it began.
  const latest = withData.reduce((a, b) => (b.lastT > a.lastT ? b : a));
  const identity = { packageName: latest.packageName, deviceId: latest.deviceId };

  const to = options.to ?? latest.lastT;
  const from = options.from ?? (options.sinceMs !== undefined ? to - options.sinceMs : latest.firstT);

  const merged = await fillWindowFromDisk({
    root: options.root,
    identity,
    buffered: [],
    currentSessionDir: null,
    from,
    to,
  });

  const scenario = options.scenario ?? defaultScenarioName(from, to);
  const outPath = options.out ?? defaultOutPath(options.projectRoot, scenario);
  const hello: Record<string, unknown> = {
    packageName: latest.packageName,
    versionName: latest.versionName,
    device: latest.device,
    sdkInt: latest.sdkInt,
  };
  const trace = buildSavedTrace({
    events: merged.events as unknown as DeviceEvent[],
    hello,
    window: { from, to },
    coveredFrom: merged.coveredFrom,
    coveredTo: merged.coveredTo,
    scenario,
  });
  await writeSavedTrace(trace, outPath);

  return {
    code: 0,
    message: `saved "${scenario}" (${trace.findings.length} finding(s)) to ${outPath}.${coverageNote(trace.clippedMs)}`,
  };
}

// ---------------------------------------------------------------------------
// `porthole sessions`
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function eventCount(session: SessionMetaWithDir): number {
  return Object.values(session.eventCounts).reduce((sum, n) => sum + n, 0);
}

/**
 * `porthole sessions`'s implementation. "current" is whichever session was
 * most recently written to (greatest `updatedAt`) — purely a fact about
 * what is on disk, deliberately not "is a device connected right now": a
 * one-shot CLI invocation with no live `DeviceClient` has no cheap, honest
 * way to answer that question without opening a socket and waiting on a
 * device that may not even be plugged in, which is a different (and
 * heavier) command than "list what is already recorded".
 */
export async function listSessionsText(root: string): Promise<CommandResult> {
  const sessions = await listAllSessions(root);
  if (sessions.length === 0) {
    return { code: 0, message: "No sessions recorded on disk yet." };
  }

  const current = sessions.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));

  const lines: string[] = [];
  for (const session of sessions) {
    const marker = session.dir === current.dir ? "*" : " ";
    const started = new Date(session.createdAt).toISOString();
    const firstT = session.firstT ?? "-";
    const lastT = session.lastT ?? "-";
    const bytes = await sessionSizeBytes(session.dir);
    lines.push(
      `${marker} ${session.packageName} ${session.deviceId} started ${started} ` +
        `t=[${firstT},${lastT}] events=${eventCount(session)} ${formatBytes(bytes)} ${session.dir}`,
    );
  }
  return { code: 0, message: lines.join("\n") };
}
