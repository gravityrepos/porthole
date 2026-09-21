// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { Hit } from "./laneData";
import type { Finding, FindingsPayload, TraceListing } from "../types";
import { num } from "../types";

/**
 * GRA-115: what "ask the trace" means for one clicked hit -- the window it
 * asks about, which capture (if any) can answer it, and what changed once it
 * does. Kept free of React for the same reason `findingsLoader.ts`'s own top
 * comment gives: plain functions are constructible and testable without a
 * DOM, and `SelectionPanel` is thin glue over this rather than where any of
 * this logic actually lives.
 *
 * Ruling 1: no second implementation of `ask_system_trace` and no SQL in the
 * browser under any circumstances -- everything here either computes a
 * window/selection from data the UI already has, or calls the existing
 * `/api/findings?trace=<id>&from=<ms>&to=<ms>`.
 */

export interface Window {
  from: number;
  to: number;
}

/**
 * Ruling 2's open question: is 200ms the right floor? Checked against a real
 * capture rather than picked from taste --
 * `porthole-1789157940493.pftrace` (`com.example.shop`), its worst frame
 * (jank_type "App Deadline Missed", ts 542877086996129, dur 108.58ms): a
 * 200ms window centred on that frame holds 242 main-thread `thread_state`
 * rows totalling 152.50ms of accounted time. That is a real scheduling
 * history to show, not a handful of samples either side of the click, so
 * 200ms stands.
 */
export const HIT_WINDOW_FLOOR_MS = 200;

/**
 * Duration lookup per event kind -- the "own duration" ruling 1 means, not
 * the width of whatever the user happens to have panned into view. Which way
 * the duration runs from `t` depends on where the runtime stamped the event,
 * not on when it emitted it: a `frame` is stamped at its vsync
 * (`FrameCollector.vsyncUptimeMs`, the frame's *start*) and a `blocked` stall
 * at the unanswered ping's post time (`MainThreadWatchdog.record`'s
 * `at = startedAt`, again the *start*), so both run forward -- the same
 * direction `draw.ts`'s `drawBlocked` already paints them and the same
 * windows the server's `findingsOf` places `frames-dropped` and
 * `main-thread-stall` on. A `db_end` is stamped when the query finished, so
 * it alone runs backward. The fields themselves are the ones
 * `SelectionPanel`'s `headingFor` reads (`totalMs`, `durationMs`,
 * `elapsedMs`) for its subtitle. Anything else (a point event, like a
 * finding-less click this function is never actually asked about) is a
 * zero-width point at `t`, which `floorWindow` below turns into 200ms of
 * context around it anyway.
 */
function eventWindow(event: { event: string; t: number; data: Record<string, unknown> }): Window {
  switch (event.event) {
    case "frame":
      return { from: event.t, to: event.t + num(event.data.totalMs) };
    case "blocked":
      return { from: event.t, to: event.t + num(event.data.durationMs) };
    case "db_end":
      return { from: event.t - num(event.data.elapsedMs), to: event.t };
    default:
      return { from: event.t, to: event.t };
  }
}

/**
 * Ruling 1: which hits get the gesture at all -- "a dropped frame, a
 * main-thread stall, or a finding." Read off the lane's own classification
 * rather than re-deriving it from event names: `lanes.ts` already groups the
 * frame lane as `kind: "jank"` and the stall lane (both `blocked` events and
 * an on-main-thread `db_end`) as `kind: "blocked"`, and `hitLane` in
 * `laneData.ts` is what decided a click landed on one of those lanes in the
 * first place. A span (http/db/work) or any other event lane is out of
 * scope, same as the ticket's own "out of scope" list implies by omission.
 */
export function isAskable(hit: Hit): boolean {
  if (hit.kind === "finding") return true;
  if (hit.kind === "event") return hit.lane.kind === "jank" || hit.lane.kind === "blocked";
  return false;
}

/**
 * The hit's own window, before the 200ms floor -- ruling 1: "that hit's
 * window... never the visible view." `context` is what a `spanning` finding
 * (or one obeying neither half of GRA-113 AC1's contract -- the wire
 * boundary `types.ts` already warns never to trust) falls back to: such a
 * finding describes whatever window was asked to produce it, not a moment
 * inside it, and the request window that produced the current findings batch
 * is the only thing this codebase has to offer in its place. `null` only
 * when even that is unavailable.
 */
export function hitWindow(hit: Hit, context: Window | null): Window | null {
  if (hit.kind === "span") return { from: hit.span.start, to: hit.span.end };
  if (hit.kind === "event") return eventWindow(hit.event);
  return hit.finding.window ?? context;
}

/**
 * Ruling 1's floor, expanding symmetrically around the hit's own centre so a
 * narrow hit keeps its centre and gains 200ms of context either side, rather
 * than having its start preserved and its end pushed out to some arbitrary
 * later moment. Clamped so the floor never asks about negative uptime -- the
 * one case where that would otherwise happen is a hit within the first 100ms
 * of a session, which shifts the centre rather than going negative.
 */
export function floorWindow(window: Window, floorMs = HIT_WINDOW_FLOOR_MS): Window {
  const lo = Math.min(window.from, window.to);
  const hi = Math.max(window.from, window.to);
  const width = hi - lo;
  if (width >= floorMs) return { from: lo, to: hi };
  const center = (lo + hi) / 2;
  const from = Math.max(0, center - floorMs / 2);
  return { from, to: from + floorMs };
}

/** Whether a trace's coverage fully contains a window -- inclusive at both
 *  edges, so a window that lands exactly on a trace's own start or end still
 *  counts as covered. `coverage: null` (an unreadable trace, GRA-113) never
 *  covers anything. */
function covers(trace: TraceListing, window: Window): boolean {
  return trace.coverage !== null && trace.coverage.from <= window.from && trace.coverage.to >= window.to;
}

/**
 * Ruling 3: the currently chosen trace if its coverage contains the window;
 * otherwise the first listed trace whose coverage does; otherwise none.
 * Never "the best" or "the newest that covers it" -- `/api/traces` already
 * lists newest first, so "first" already means newest, and this needs no
 * tiebreaking logic of its own.
 */
export function selectTrace(
  traces: TraceListing[],
  selectedTraceId: string | null,
  window: Window,
): TraceListing | null {
  const selected = selectedTraceId ? traces.find((t) => t.id === selectedTraceId) : undefined;
  if (selected && covers(selected, window)) return selected;
  return traces.find((t) => covers(t, window)) ?? null;
}

/**
 * Ruling 5: per `(trace id, from, to)` for the session. Rounded so a hit
 * clicked twice -- which recomputes its window from scratch each time --
 * lands on the exact same key even if floating-point arithmetic differed in
 * the last bit; the server's own `window.ms` in the response is built from
 * these same rounded bounds, so nothing is lost by rounding here first.
 */
export function cacheKey(traceId: string, window: Window): string {
  return `${traceId}|${Math.round(window.from)}|${Math.round(window.to)}`;
}

/**
 * Ruling 4: the same five sentences `perfetto.ts`'s `QUESTIONS` asks,
 * duplicated here by value rather than imported. `perfetto.ts` is
 * server-only code -- it spawns a subprocess and imports `node:child_process`
 * -- the same reason `types.ts`'s own `DeviceEvent`/`Hello` comment gives for
 * not importing the server's shapes into this bundle. Five short English
 * sentences carry none of that risk, and nothing here needs the SQL beside
 * them. Search this project for `asks:` when changing either copy.
 */
export const QUESTION_TEXT: Record<string, string> = {
  jank: "which frames missed their deadline, and by how much",
  thread_states: "whether the app was running, waiting for a CPU, or blocked",
  binder: "which other processes the app called into, and for how long",
  render: "what the render thread and the GPU were doing",
  slices: "what the app was actually doing, by total time",
};

/**
 * Which finding id a question is credited with, so "answered but nothing
 * came of it" can be told apart from "answered, and here is what it found"
 * without a second field threaded out of the server -- ruling 4 keeps that
 * field minimal (`id` + `answered`, nothing else). `interpret()` in
 * perfetto.ts names four of its findings after their question directly;
 * the fifth question, `slices`, feeds `NOT_YOUR_CODE`, whose finding ids are
 * named after whichever rule matched (`trace-work-manager`, `trace-gc`, ...)
 * rather than after the question itself, so `slices` is recognised as "any
 * trace finding id none of the other four claim" instead of by a list that
 * would drift the moment that rule table grows.
 */
const FIXED_QUESTION_FINDING_ID: Record<string, string> = {
  jank: "trace-frame-deadline",
  thread_states: "trace-main-thread-contention",
  binder: "trace-binder",
  render: "trace-render",
};

function questionProducedAFinding(questionId: string, traceFindingIds: Set<string>): boolean {
  if (questionId === "slices") {
    const claimed = new Set(Object.values(FIXED_QUESTION_FINDING_ID));
    for (const id of traceFindingIds) if (!claimed.has(id)) return true;
    return false;
  }
  const wanted = FIXED_QUESTION_FINDING_ID[questionId];
  return wanted !== undefined && traceFindingIds.has(wanted);
}

/**
 * Ruling 4's negative answers: one line per question the server actually
 * answered that did not turn into a finding, in the question's own words.
 * `payload.asked` is optional on the wire (an older server, or a request
 * that never reached a trace at all) -- absent or empty, this returns no
 * lines rather than guessing, which is what self-check (a)'s "`asked`
 * missing or empty" case exercises.
 */
export function ruledOut(payload: Pick<FindingsPayload, "asked" | "findings">): string[] {
  const asked = payload.asked ?? [];
  const traceFindingIds = new Set(payload.findings.filter((f) => f.source === "trace").map((f) => f.id));
  return asked
    .filter((q) => q.answered && !questionProducedAFinding(q.id, traceFindingIds))
    .map((q) => QUESTION_TEXT[q.id] ?? q.id);
}

export type AskTraceResult =
  | { kind: "error"; window: Window; message: string }
  | { kind: "answer"; window: Window; traceId: string; findings: Finding[]; ruledOut: string[] };

/**
 * Ruling 1: the existing `/api/findings?trace=<id>&from=<ms>&to=<ms>`, and
 * nothing else. Ruling 5's cache lives in the component that calls this, not
 * here -- this function has no memory of its own, so a caller choosing not
 * to call it twice for the same `(traceId, window)` is the entire cache.
 * A missing trace (ruling 3's "none covers it") is never passed here at all
 * -- that case renders the no-coverage message and the capture prompt
 * without ever reaching this function, so an empty answer and a missing
 * capture cannot end up looking alike.
 */
export async function fetchAskTrace(
  traceId: string,
  window: Window,
  fetchImpl: typeof fetch = fetch,
): Promise<AskTraceResult> {
  const params = new URLSearchParams({
    trace: traceId,
    from: String(Math.round(window.from)),
    to: String(Math.round(window.to)),
  });
  try {
    const response = await fetchImpl(`/api/findings?${params}`);
    if (!response.ok) {
      return { kind: "error", window, message: `the server answered ${response.status}` };
    }
    const payload = (await response.json()) as FindingsPayload;
    return {
      kind: "answer",
      window,
      traceId,
      findings: payload.findings,
      ruledOut: ruledOut(payload),
    };
  } catch (cause) {
    return { kind: "error", window, message: cause instanceof Error ? cause.message : String(cause) };
  }
}
