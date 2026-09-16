// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { DeviceEvent } from "./device.js";
import { alsoInWindowOf, alsoInWindowSentence, type AlsoInWindow } from "./trace.js";

/**
 * What the app was doing at one moment.
 *
 * This exists for a specific experience: staring at a slice in a Perfetto
 * capture and trying to remember what you did at that exact time. Perfetto can
 * say which threads ran and for how long. It cannot say that you had just
 * navigated to the cart, that a checkout call was open, or that the query on
 * the main thread was the one behind the stall — and those are the things a
 * person actually needs in order to recognise the moment.
 *
 * Deliberately a narrative rather than a dump. The tools that return everything
 * in a window already exist; what was missing was an answer shaped like the
 * question, which is "where was I and what was happening".
 */

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : value == null ? fallback : String(value);

const num = (value: unknown, fallback = 0): number => {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export interface OpenSpan {
  kind: "http" | "db" | "work";
  label: string;
  startedAt: number;
  /** Elapsed at the moment asked about, not the span's full duration. */
  openForMs: number;
  endedAt: number | null;
  data: Record<string, unknown>;
}

export interface Moment {
  at: number;
  window: { from: number; to: number };
  /** How `at` was arrived at, when it came from another clock. */
  clock: { bootMs: number; sleepMs: number; sampledAt: number } | null;
  screen: { route: string; args: string; enteredAt: number; agoMs: number } | null;
  inFlight: OpenSpan[];
  stateWrites: Array<{ key: string; at: number }>;
  recompositions: number;
  stalls: Array<{ durationMs: number; top: string; at: number }>;
  frames: { missed: number; worstMs: number };
  logs: Array<{ level: string; tag: string; message: string; at: number }>;
  /**
   * GRA-200: the same inventory `findings`' payload carries, scoped to this
   * moment's own `window` rather than to whatever span `findings` was asked
   * about — so a process exit that lands inside the few seconds either side
   * of `at` is visible here even when nobody has called `findings` for this
   * window at all. Absent, not empty, when there is nothing to add — see
   * `alsoInWindowOf`'s own comment in trace.ts.
   */
  alsoInWindow?: AlsoInWindow;
}

/**
 * A CLOCK_BOOTTIME reading — what a Perfetto trace stamps with — in the clock
 * every Porthole event carries.
 *
 * Uses the most recent `clocks` sample at or before the moment asked about,
 * because the gap between the two clocks is accumulated deep sleep and grows
 * whenever the device dozes. Taking the newest sample instead would apply a
 * later device's sleep total to an earlier moment.
 */
export function fromBootMs(
  events: DeviceEvent[],
  bootMs: number,
): { at: number; sleepMs: number; sampledAt: number } | null {
  const samples = events.filter((e) => e.event === "clocks");
  if (samples.length === 0) return null;

  // Pick by boot time, since that is the axis the caller is speaking in.
  let chosen = samples[0];
  for (const sample of samples) {
    if (num(sample.data.bootMs) <= bootMs) chosen = sample;
  }
  const sleepMs = num(chosen.data.sleepMs);
  return { at: bootMs - sleepMs, sleepMs, sampledAt: chosen.t };
}

/**
 * The reverse of fromBootMs: a Porthole uptime-ms moment, converted to the
 * CLOCK_BOOTTIME ns a trace stamps with — what a caller scoping a
 * trace_processor query to a window named in Porthole's own clock needs.
 * `timeline.ts`'s `/api/findings?trace=` and `index.ts`'s `ask_system_trace`
 * both do exactly this, and both used to open-code it separately, each
 * picking whichever `clocks` sample the search happened to find first
 * rather than the one in force at `atMs` — the same bug `fromBootMs` was
 * written to avoid on the other leg of the trip. Mirroring `fromBootMs`'s
 * own selection (the most recent sample at or before the moment, by
 * Porthole's own clock this time: `sample.t`, not a boot-time field) is what
 * fixes it, and living here rather than at either call site is what keeps it
 * fixed: every place that needs the offset between the two clocks reads it
 * the same way, once.
 *
 * Never refuses. A caller scoping a query needs *a* bound to hand
 * trace_processor even before the run has sampled the offset at all, and
 * assuming no accumulated sleep — the same default both open-coded versions
 * used — is the conservative placeholder: it is wrong only by however long
 * the device has actually slept, and only until a real sample arrives.
 *
 * Returns the offset alongside the answer, not just the ns: `ask_system_trace`
 * reports `sleepMs` back to whoever asked, the same way `fromBootMs`'s own
 * `{at, sleepMs, sampledAt}` already does for the reverse trip — and doing
 * that by re-deriving it at the call site is exactly the duplication this
 * function exists to close off. `toBootNs` below is this, minus the
 * bookkeeping, for the caller (`timeline.ts`) that only ever wants the number.
 */
export function toBoot(
  events: DeviceEvent[],
  atMs: number,
): { ns: number; sleepMs: number; sampledAt: number | null } {
  const samples = events.filter((e) => e.event === "clocks" && e.t <= atMs);
  const chosen = samples.length ? samples[samples.length - 1] : undefined;
  const sleepMs = chosen ? num(chosen.data.sleepMs) : 0;
  return { ns: (atMs + sleepMs) * 1e6, sleepMs, sampledAt: chosen ? chosen.t : null };
}

/** `toBoot(events, atMs).ns` — see `toBoot` for the full story. */
export function toBootNs(events: DeviceEvent[], atMs: number): number {
  return toBoot(events, atMs).ns;
}

/**
 * Coverage's variant of fromBootMs: `GET /api/traces` has no live device
 * session, so there is no Porthole-recorded `clocks` sample to read an offset
 * from. A trace's own `clock_snapshot` carries the same information anyway —
 * CLOCK_BOOTTIME (Perfetto's clock_id 6) and CLOCK_MONOTONIC (clock_id 3, the
 * same clock `SystemClock.uptimeMillis()` reads) sampled at the same instant
 * — so the offset can be read directly out of the trace instead of out of a
 * session that may not exist. This is that same {bootMs, sleepMs} pair
 * `fromBootMs` already knows how to apply, computed from a different source;
 * it stays in this file rather than at its call site for the same reason
 * `toBootNs` does.
 *
 * One snapshot is enough for the same reason `fromBootMs` only needs the
 * nearest one: the offset changes only across a stretch of deep sleep, and an
 * 11-second capture window is far too short for that to move it (verified on
 * hardware: 183ns of drift across nine minutes).
 */
export function fromTraceClockSnapshot(
  snapshot: { bootNs: number; monotonicNs: number },
  atNs: number,
): number {
  const sleepNs = snapshot.bootNs - snapshot.monotonicNs;
  return Math.round((atNs - sleepNs) / 1e6);
}

/** Spans open across `at`, plus those that closed inside the window. */
function spansAcross(
  events: DeviceEvent[],
  prefix: "http" | "db" | "work",
  at: number,
  from: number,
  to: number,
): OpenSpan[] {
  const open = new Map<string, DeviceEvent>();
  const out: OpenSpan[] = [];

  for (const event of events) {
    const id = str(event.data.id);
    if (event.event === `${prefix}_start`) {
      open.set(id, event);
      continue;
    }
    if (event.event !== `${prefix}_end`) continue;

    const start = open.get(id);
    open.delete(id);
    if (!start) continue;

    // Open across the moment, or finished within the window either side of it.
    const straddles = start.t <= at && event.t >= at;
    const nearby = event.t >= from && event.t <= to;
    if (!straddles && !nearby) continue;

    out.push({
      kind: prefix,
      label: labelOf(prefix, start.data, event.data),
      startedAt: start.t,
      openForMs: Math.max(0, Math.min(at, event.t) - start.t),
      endedAt: event.t,
      data: { ...start.data, ...event.data },
    });
  }

  // Anything still open never got an end event, which is itself the finding:
  // a call that was in flight and stayed that way.
  for (const start of open.values()) {
    if (start.t > at) continue;
    out.push({
      kind: prefix,
      label: labelOf(prefix, start.data, {}),
      startedAt: start.t,
      openForMs: at - start.t,
      endedAt: null,
      data: start.data,
    });
  }

  return out.sort((a, b) => b.openForMs - a.openForMs);
}

function labelOf(
  prefix: string,
  start: Record<string, unknown>,
  end: Record<string, unknown>,
): string {
  if (prefix === "http") {
    const status = end.status !== undefined ? ` → ${str(end.status)}` : "";
    return `${str(start.method)} ${str(start.url)}${status}`.trim();
  }
  if (prefix === "db") {
    const main = start.onMainThread === "true" || start.onMainThread === true ? " (main thread)" : "";
    return `${str(start.sql)}${main}`;
  }
  return str(start.name) || str(start.id);
}

/**
 * @param at the moment, in Porthole's clock
 * @param spreadMs how far either side to look for context. Small on purpose:
 *   the question is "what was happening here", and widening it turns the answer
 *   back into the dump the other tools already provide.
 */
export function momentOf(events: DeviceEvent[], at: number, spreadMs = 2_000): Moment {
  const from = at - spreadMs;
  const to = at + spreadMs;
  const within = (e: DeviceEvent) => e.t >= from && e.t <= to;

  // The screen is the last navigation at or before the moment — not one within
  // the window, since you can sit on a screen far longer than the spread.
  const navs = events.filter((e) => e.event === "nav" && e.t <= at);
  const lastNav = navs.length ? navs[navs.length - 1] : null;

  const frames = events.filter((e) => e.event === "frame" && within(e));

  // GRA-200: scoped to this moment's own window, not the whole buffer — the
  // same function `findings` calls, on a different slice of the same
  // `events`, which is what keeps the two tools' wording identical for the
  // same underlying fact instead of two hand-written descriptions of it.
  const alsoInWindow = alsoInWindowOf(events.filter(within));

  return {
    at,
    window: { from, to },
    clock: null,
    screen: lastNav
      ? {
          route: str(lastNav.data.route),
          args: str(lastNav.data.args),
          enteredAt: lastNav.t,
          agoMs: at - lastNav.t,
        }
      : null,
    inFlight: [
      ...spansAcross(events, "http", at, from, to),
      ...spansAcross(events, "db", at, from, to),
      ...spansAcross(events, "work", at, from, to),
    ],
    stateWrites: events
      .filter((e) => e.event === "state_write" && e.t <= at && e.t >= at - spreadMs)
      .map((e) => ({ key: str(e.data.key), at: e.t })),
    recompositions: events.filter((e) => e.event === "recompose" && within(e)).length,
    stalls: events
      .filter((e) => e.event === "blocked" && within(e))
      .map((e) => ({ durationMs: num(e.data.durationMs), top: str(e.data.top), at: e.t })),
    frames: {
      missed: frames.reduce((sum, e) => sum + num(e.data.missedFrames), 0),
      worstMs: frames.reduce((worst, e) => Math.max(worst, num(e.data.totalMs)), 0),
    },
    logs: events
      .filter((e) => e.event === "log" && within(e))
      .map((e) => ({
        level: str(e.data.level),
        tag: str(e.data.tag),
        message: str(e.data.message).slice(0, 300),
        at: e.t,
      })),
    ...(alsoInWindow ? { alsoInWindow } : {}),
  };
}

/** One sentence, because the summary is usually the whole answer. */
export function describe(moment: Moment): string {
  const parts: string[] = [];

  parts.push(
    moment.screen
      ? `On ${moment.screen.route}${moment.screen.args ? ` ${moment.screen.args}` : ""}` +
          ` (entered ${Math.round(moment.screen.agoMs / 100) / 10}s earlier).`
      : "No navigation recorded before this moment.",
  );

  if (moment.inFlight.length) {
    const worst = moment.inFlight[0];
    parts.push(
      `${moment.inFlight.length} in flight, longest ${worst.label} ` +
        `open ${worst.openForMs}ms${worst.endedAt === null ? " and never finished" : ""}.`,
    );
  }
  if (moment.stalls.length) {
    const worst = moment.stalls.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
    parts.push(`Main thread blocked ${worst.durationMs}ms in ${worst.top}.`);
  }
  if (moment.frames.missed) {
    parts.push(`${moment.frames.missed} refreshes missed, worst frame ${moment.frames.worstMs}ms.`);
  }
  if (moment.recompositions) parts.push(`${moment.recompositions} recompositions.`);
  if (moment.stateWrites.length) {
    const keys = [...new Set(moment.stateWrites.map((w) => w.key))].slice(0, 3);
    parts.push(`State written just before: ${keys.join(", ")}.`);
  }

  // GRA-200: the same sentence findings' own summary appends for the same
  // underlying fact (see alsoInWindowOf/alsoInWindowSentence in trace.ts) —
  // most often an exit that falls inside this moment's window, which
  // otherwise had no way to surface here at all.
  const alsoSentence = alsoInWindowSentence(moment.alsoInWindow);
  if (alsoSentence) parts.push(alsoSentence);

  return parts.join(" ");
}
