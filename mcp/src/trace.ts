// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { DeviceEvent } from "./device.js";
import { whereForFrame, whereForName, type Where } from "./sources.js";

/**
 * Turning a recorded run into something worth reading.
 *
 * A dump of events serves only a machine, and badly. What a person wants back
 * from a capture is a short list of what is worth looking at; what CI wants is
 * a number it can compare. Both come from here.
 */

/**
 * The shape of the trace file.
 *
 * Nothing validates against it on read, so it is a label rather than a gate.
 * Adding an optional field or a new metric key is therefore compatible by
 * construction — `compare` fills a key the other side lacks with zero — and does
 * not move this number. Removing or repurposing one would.
 */
export const TRACE_VERSION = 1;

export type Severity = "error" | "warning" | "note";

/**
 * How strongly a finding can be claimed.
 *
 * Load-bearing, not decoration. "observed" means the device said so — a query
 * ran on the main thread, a frame missed its deadline. "correlated" means two
 * things happened near each other, which is ordering and not causation. A
 * report that blurs the two teaches people to distrust all of it.
 */
export type Confidence = "observed" | "correlated";

export interface Finding {
  id: string;
  severity: Severity;
  confidence: Confidence;
  title: string;
  detail?: string;
  count?: number;
  /** The mark this fell under, when the run was marked. */
  during?: string;
  evidence?: Record<string, unknown>;
  /**
   * Where this finding sits on the device's uptime clock (GRA-113) — the same
   * clock every Porthole event and `momentOf` already speak in. Every finding
   * `/api/findings` returns carries exactly one of `window` or `spanning`,
   * never both and never neither: a finding that cannot say where it belongs
   * is a defect in the code that produced it, not a legitimate third state.
   *
   * `from`/`to` may be equal — a single instant is a zero-width window, not a
   * special case — and, for a trace-derived finding, arrives already
   * converted through `moment.ts`'s `fromBootMs`, never as the raw
   * boot-clock ns a query answered in.
   */
  window?: { from: number; to: number };
  /**
   * Set instead of `window` for a finding that is a property of the whole
   * window it was asked about rather than of a moment inside it — a
   * thread-state aggregate summed across however many disjoint stretches the
   * scheduler happened to visit that state, say, or GRA-58's exit findings,
   * whose `exit.t` is stamped in the *next* process's uptime clock and so
   * cannot be honestly placed on this session's axis at all. Drawing either
   * as a point under one frame would invent a precision neither one has.
   */
  spanning?: true;
  /**
   * GRA-201: where the evidence above lives in the project's own source —
   * resolved by `sources.ts` from a stack frame or a composable/owner name
   * already on this finding, never the other way around. A fact about the
   * project on disk, not a judgement: it never changes `title`, `severity`
   * or `detail`. Absent (not merely unresolved) when source resolution is
   * off — see `sources.ts`'s own doc comment for exactly when.
   */
  where?: Where;
}

export interface Trace {
  porthole: number;
  scenario: string;
  capturedAt: string;
  durationMs: number;
  driver?: string;
  app: Record<string, unknown>;
  device: Record<string, unknown>;
  marks: Array<{ at: number; label: string; detail?: string }>;
  metrics: Record<string, number>;
  findings: Finding[];
  events?: DeviceEvent[];
}

/** Exported for `index.ts`'s `exits` section (GRA-58): the same loose coercion every event field here already gets, so a device's numeric fields don't need retyping at a second call site. */
export const num = (value: unknown, fallback = 0): number => {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : value == null ? fallback : String(value);

/**
 * The value below which `share` of the samples fall.
 *
 * Percentiles rather than means throughout: a mean frame time is the one number
 * guaranteed to hide the problem, because the frames anyone cares about are the
 * tail.
 *
 * Only ever fed completed work. A span that was still open has a floor under
 * its duration and not a duration, and a floor mixed into a distribution of
 * completions drags the tail *down* — the longest wait in the run would make
 * the p95 look better. Open spans are counted and named separately instead.
 */
function percentile(values: number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(share * sorted.length));
  return Math.round(sorted[index]);
}

/** A span whose end arrived: `ms` is how long it took. */
export interface CompletedSpan {
  open: false;
  ms: number;
  data: Record<string, unknown>;
  /** When it ended — always known, since only a closed span reaches here. */
  endedAt: number;
  /**
   * When it started, if this capture saw the start; null for an end with no
   * start (a capture that attached mid-call, not a hang — see `spans`).
   */
  startedAt: number | null;
}

/** A span that was still running when the events ran out. */
export interface OpenSpan {
  open: true;
  /**
   * A floor under how long it ran, in ms — it had lasted at least this when the
   * last event arrived, and the real figure is larger and unknowable from here.
   *
   * Named for what it is rather than `ms`, because a number that is silently a
   * lower bound gets averaged, plotted and regression-gated as though it were a
   * measurement, and no caller ever finds out.
   */
  atLeastMs: number;
  /** When it started, which is the only timestamp it has. */
  startedAt: number;
  data: Record<string, unknown>;
}

export type Span = CompletedSpan | OpenSpan;

// Predicates rather than inline `!s.open`, so the narrowing survives `filter`
// and the compiler is the thing that stops `atLeastMs` reaching a percentile.
const isCompleted = (span: Span): span is CompletedSpan => !span.open;
const isOpen = (span: Span): span is OpenSpan => span.open;

/**
 * Start/end pairs recovered from the event stream — including the ones with no
 * end.
 *
 * A span still open when the recording stops is the shape of a hang: a request
 * that never returns, a query that never completes, a job wedged on a lock. It
 * used to be dropped here, which meant the trace reported fewer calls than were
 * made, no percentile influence, and no finding about the one that mattered —
 * the run that most needed investigating came back looking like the quietest on
 * record. They are emitted instead, marked `open`, carrying a floor under their
 * duration measured to the last event seen.
 *
 * An end with no start is the mirror case and is not a hang: that is a capture
 * that attached mid-call. It keeps the device's own `elapsedMs`.
 */
function spans(events: DeviceEvent[], prefix: string): Span[] {
  const open = new Map<string, { at: number; data: Record<string, unknown> }>();
  const out: Span[] = [];
  let lastAt = 0;

  for (const event of events) {
    lastAt = Math.max(lastAt, event.t);
    const id = str(event.data.id);
    if (event.event === `${prefix}_start`) {
      // Not an unconditional `set`. A repeated id is the device contradicting
      // itself, and overwriting would silently discard the earlier start — the
      // same class of defect as dropping open spans. Keeping the first start
      // keeps the floor conservative and invents nothing.
      if (!open.has(id)) open.set(id, { at: event.t, data: event.data });
    } else if (event.event === `${prefix}_end`) {
      const started = open.get(id);
      open.delete(id);
      const ms = started === undefined ? num(event.data.elapsedMs) : event.t - started.at;
      out.push({
        open: false,
        ms,
        data: event.data,
        endedAt: event.t,
        startedAt: started ? started.at : null,
      });
    }
  }

  // Insertion order, so these come out oldest first.
  for (const started of open.values()) {
    out.push({
      open: true,
      atLeastMs: lastAt - started.at,
      startedAt: started.at,
      data: started.data,
    });
  }
  return out;
}

export function metricsOf(events: DeviceEvent[]): Record<string, number> {
  const frames = events.filter((e) => e.event === "frame");
  const stalls = events.filter((e) => e.event === "blocked");
  const db = spans(events, "db");
  const http = spans(events, "http");
  const work = spans(events, "work");
  const recompose = events.filter((e) => e.event === "recompose");
  const memory = events.filter((e) => e.event === "memory");
  const gc = events.filter((e) => e.event === "gc");

  const perFrame = new Map<number, number>();
  for (const event of recompose) {
    const bucket = Math.floor(event.t / 16);
    perFrame.set(bucket, (perFrame.get(bucket) ?? 0) + 1);
  }

  return {
    "frames.missed": frames.reduce((sum, e) => sum + num(e.data.missedFrames, 1), 0),
    "frames.worstMs": frames.reduce((worst, e) => Math.max(worst, num(e.data.totalMs)), 0),
    "frames.p95Ms": percentile(
      frames.map((e) => num(e.data.totalMs)),
      0.95,
    ),

    "mainThread.stalls": stalls.length,
    "mainThread.worstMs": stalls.reduce((worst, e) => Math.max(worst, num(e.data.durationMs)), 0),
    "mainThread.blockedMs": stalls.reduce((sum, e) => sum + num(e.data.durationMs), 0),

    // Counts are over everything that started, percentiles over what finished.
    // A query that never came back still happened, and still cost the user the
    // wait; it just has no duration to put in a distribution.
    "db.queries": db.length,
    "db.stillOpen": db.filter(isOpen).length,
    "db.onMainThread": db.filter(
      (q) => q.data.onMainThread === "true" || q.data.onMainThread === true,
    ).length,
    // Over completed queries only — see `percentile`.
    "db.p95Ms": percentile(
      db.filter(isCompleted).map((q) => q.ms),
      0.95,
    ),

    "http.calls": http.length,
    "http.stillOpen": http.filter(isOpen).length,
    "http.failed": http.filter((c) => num(c.data.status) >= 400 || c.data.error !== undefined)
      .length,
    // Over completed calls only — see `percentile`.
    "http.p95Ms": percentile(
      http.filter(isCompleted).map((c) => c.ms),
      0.95,
    ),

    "recompose.total": recompose.length,
    "recompose.peakPerFrame": perFrame.size ? Math.max(...perFrame.values()) : 0,

    "memory.peakHeapMb": memory.reduce((peak, e) => Math.max(peak, num(e.data.heapUsedMb)), 0),
    "memory.peakRamMb": memory.reduce((peak, e) => Math.max(peak, num(e.data.totalRamMb)), 0),
    "memory.blockingGcMs": gc.reduce((sum, e) => sum + num(e.data.pausedMs), 0),

    "work.runs": work.length,
    "work.stillOpen": work.filter(isOpen).length,
    "work.retries": work.filter((w) => w.data.retrying === "true").length,
    "work.failures": work.filter((w) => str(w.data.state) === "FAILED").length,
  };
}

/**
 * The envelope from the earliest to the latest of a set of real, timestamped
 * events — for a finding that aggregates several occurrences (a run of
 * blocking GCs, every `trimMemory` call) rather than naming one. Unlike a
 * trace-side aggregate summed with no timestamp at all, each contributor here
 * has a real `t`, so the envelope is read off the events that produced the
 * finding, not invented for it. Undefined only for an empty list, which no
 * caller should ever pass — every call site already checked `.length > 0`.
 */
function eventWindow(events: DeviceEvent[]): { from: number; to: number } | undefined {
  if (events.length === 0) return undefined;
  const ts = events.map((e) => e.t);
  return { from: Math.min(...ts), to: Math.max(...ts) };
}

/** `eventWindow`'s counterpart for a list of spans rather than raw events. */
function spanWindow(spans: Span[]): { from: number; to: number } | undefined {
  if (spans.length === 0) return undefined;
  const starts = spans.map((s) => (s.open ? s.startedAt : (s.startedAt ?? s.endedAt)));
  const ends = spans.map((s) => (s.open ? s.startedAt : s.endedAt));
  return { from: Math.min(...starts), to: Math.max(...ends) };
}

/** The mark in force at a moment, or undefined if the run was not marked. */
function markAt(marks: Trace["marks"], at: number): string | undefined {
  let current: string | undefined;
  for (const mark of marks) {
    if (mark.at <= at) current = mark.label;
    else break;
  }
  return current;
}

/**
 * The frame budget for this device, in ms.
 *
 * Derived from the refresh rate rather than assuming 60: a budget is 8.3ms on a
 * 120Hz panel, and calling a 10ms frame fine there is wrong.
 */
export function frameBudgetMs(refreshHz: number): number {
  const hz = refreshHz > 1 ? refreshHz : 60;
  return Math.round((1000 / hz) * 10) / 10;
}

/**
 * The budget clause every place that names a frame budget in prose shares
 * (GRA-185's "second, smaller thing": `frames` and `findings` used to print
 * the same quantity two different ways on the same panel). `findingsOf`'s
 * own `frames-dropped` title and `frames`' tool text (index.ts) both call
 * this, so the two cannot drift apart again the way GRA-185 found them.
 *
 * When `assumed` is true this is a guess dressed as one, not printed as an
 * observed fact — `resolveProfile`'s own doc comment explains why the
 * fallback matters enough to say so in the sentence itself.
 */
export function describeBudget(profile: { refreshHz: number; assumed: boolean }): string {
  const ms = frameBudgetMs(profile.refreshHz);
  return profile.assumed
    ? `${ms}ms (assumed ${Math.round(profile.refreshHz)}Hz; no display profile seen)`
    : `${ms}ms at ${Math.round(profile.refreshHz)}Hz`;
}

/** The fields a `device`/`profile` event, or a session's `meta.json`, carries about the device. Structurally what `sessions.ts`'s `SessionMeta.profile` stores. */
export interface ProfileData {
  model: string;
  sdkInt: number;
  abi: string;
  cores: number;
  deviceRamMb: number;
  refreshHz: number;
  lowRamDevice: boolean;
}

/**
 * `null` unless `event` is a `device`/`profile` event — the one place that
 * shape is read off the wire, shared by `resolveProfile` below (the live-
 * buffer scan) and `sessions.ts`'s `SessionWriter.append` (capturing it into
 * `meta.json` as it flows past), so the two readings can never disagree
 * about what a profile event means.
 */
export function profileFromEvent(event: DeviceEvent): ProfileData | null {
  if (event.event !== "device" || str(event.data.kind) !== "profile") return null;
  return {
    model: str(event.data.model),
    sdkInt: num(event.data.sdkInt),
    abi: str(event.data.abi),
    cores: num(event.data.cores),
    deviceRamMb: num(event.data.deviceRamMb),
    refreshHz: num(event.data.refreshHz, 60),
    lowRamDevice: event.data.lowRamDevice === "true" || event.data.lowRamDevice === true,
  };
}

/** What `buildTrace` needs to know about the device: the resolved refresh rate, and whether that number is something the device actually reported (`assumed: false`, `full` carries the rest) or a guess (`assumed: true`, `full` absent). */
export type ResolvedProfile = { assumed: false; refreshHz: number; full: ProfileData } | { assumed: true; refreshHz: number };

/**
 * GRA-185 ruling 1: the device profile used for the frame budget must not
 * depend on whether the requested window happens to contain the one
 * `device`/`profile` event `DeviceCollector` emits at startup — a window
 * that starts after startup used to silently fall back to 60Hz and print it
 * as though it were observed. Resolved in one order, everywhere:
 *
 *  1. The most recent profile event in the *live* buffer at or before the
 *     window's end, **regardless of the window's start** — `liveEvents`
 *     here must be the whole ring (or run), never pre-filtered to `from`.
 *  2. Else the profile recorded in the current session's `meta.json`
 *     (`SessionWriter.append` captures it as it flows past — see that
 *     function's own comment) — covers a window the live ring has already
 *     rolled the startup event out of, or a disk-only read
 *     (`saveFromSessions`) with no live ring at all.
 *  3. Else the fallback: assumed 60Hz, `assumed: true`. Every caller
 *     (`findings`, `save_moment`, `porthole save`, `/api/findings`,
 *     `/api/save`, and `frames`' own prose) resolves through this one
 *     function — no second copy of the search order to drift from it.
 */
export function resolveProfile(params: {
  /** The full live buffer/run, unfiltered by the window's own `from` — see point 1 above. Pass `[]` when there is no live buffer to search (the CLI's disk-only path). */
  liveEvents: DeviceEvent[];
  /** Only a profile at or before this counts — never one from later than what is being described. */
  windowTo: number;
  /** `meta.json`'s own `profile` field for the session in force, if any is on disk. */
  sessionProfile?: ProfileData | null;
  hello: Record<string, unknown> | null;
}): ResolvedProfile {
  const { liveEvents, windowTo, sessionProfile } = params;

  let latest: { t: number; data: ProfileData } | null = null;
  for (const event of liveEvents) {
    if (event.t > windowTo) continue;
    const data = profileFromEvent(event);
    if (!data) continue;
    if (!latest || event.t > latest.t) latest = { t: event.t, data };
  }
  if (latest) return { assumed: false, refreshHz: latest.data.refreshHz, full: latest.data };

  if (sessionProfile) return { assumed: false, refreshHz: sessionProfile.refreshHz, full: sessionProfile };

  return { assumed: true, refreshHz: 60 };
}

/**
 * What was still running when the recording stopped.
 *
 * Its own finding rather than a line folded into the counts, because an
 * unfinished call is not a slow call and the two want different responses. The
 * wording carries "at least" into the title and the detail on purpose: the
 * number is a floor, and a reader who copies it into a bug report should copy
 * that qualifier with it.
 */
function stillOpenFinding(
  lane: Span[],
  id: string,
  noun: { one: string; many: string },
  describe: (data: Record<string, unknown>) => { label: string; evidence: Record<string, unknown> },
  marks: Trace["marks"],
): Finding | undefined {
  const open = lane.filter(isOpen);
  if (open.length === 0) return undefined;

  const oldest = open.reduce((a, b) => (a.atLeastMs >= b.atLeastMs ? a : b));
  const { label, evidence } = describe(oldest.data);
  const count = open.length;

  return {
    id,
    severity: "warning",
    confidence: "observed",
    title:
      `${count} ${count === 1 ? noun.one : noun.many} ${count === 1 ? "was" : "were"} ` +
      `still open when the capture ended, the oldest for at least ${oldest.atLeastMs}ms`,
    detail: `oldest: ${label} — at least, not exactly: it had not finished, so that is a floor under the wait`,
    count,
    during: markAt(marks, oldest.startedAt),
    evidence: { oldestAtLeastMs: oldest.atLeastMs, ...evidence },
    // `to` is the last moment we know it was still open — the capture's own
    // last event, which is exactly what `atLeastMs` is already measured
    // against — not an invented "now". A window that stopped narrating
    // wherever the run happened to end would be lying about how sure it is.
    window: { from: oldest.startedAt, to: oldest.startedAt + oldest.atLeastMs },
  };
}

export function findingsOf(
  events: DeviceEvent[],
  marks: Trace["marks"],
  refreshHz: number,
  /** GRA-185: true when `refreshHz` is the 60Hz fallback rather than something the device reported — flips `frames-dropped` from `observed` to `correlated` and says so in the title, instead of stating a guess as fact. Defaults to false so every existing caller (a bare refresh rate, no opinion on how it was derived) keeps behaving exactly as before. */
  assumed = false,
): Finding[] {
  const findings: Finding[] = [];
  const db = spans(events, "db");
  const http = spans(events, "http");
  const work = spans(events, "work");

  // Completed queries only, and not merely to have an `ms` to sort on: which
  // thread a query ran on is reported by the *end* event, so an open span has
  // nothing to answer the question with. A query still running on the main
  // thread when the capture stopped is reported by `db-still-open` instead,
  // which is the more alarming finding of the two anyway.
  const onMain = db
    .filter(isCompleted)
    .filter((q) => q.data.onMainThread === "true" || q.data.onMainThread === true);
  if (onMain.length > 0) {
    const worst = onMain.reduce((a, b) => (a.ms >= b.ms ? a : b));
    findings.push({
      id: "db-on-main-thread",
      severity: "error",
      confidence: "observed",
      title: `${onMain.length} database ${onMain.length === 1 ? "query" : "queries"} ran on the main thread`,
      detail: `Worst was ${worst.ms}ms: ${str(worst.data.sql).slice(0, 80)}`,
      count: onMain.length,
      evidence: { worstMs: worst.ms, sql: str(worst.data.sql) },
      window: { from: worst.startedAt ?? worst.endedAt, to: worst.endedAt },
    });
  }

  const stalls = events.filter((e) => e.event === "blocked");
  if (stalls.length > 0) {
    const worst = stalls.reduce((a, b) =>
      num(a.data.durationMs) >= num(b.data.durationMs) ? a : b,
    );
    // GRA-201: the same top-frame text `detail` already carries, resolved to
    // where it lives under the project root — `where` is a fact about that
    // frame, so it is derived from `detail`'s own source rather than
    // reparsing `detail` after the `|| undefined` above has thrown the
    // empty-string case away.
    const topFrame = str(worst.data.top).split("\n")[0] || undefined;
    const where = whereForFrame(topFrame);
    findings.push({
      id: "main-thread-stall",
      severity: "error",
      confidence: "observed",
      title: `main thread blocked for ${num(worst.data.durationMs)}ms`,
      detail: topFrame,
      count: stalls.length,
      during: markAt(marks, worst.t),
      evidence: {
        at: worst.t,
        stack: str(worst.data.stack).split("\n").slice(0, 6),
      },
      // `blocked` is reported when the stall ends, so `worst.t` is its end and
      // the start is however long before that its own duration says.
      window: { from: worst.t - num(worst.data.durationMs), to: worst.t },
      ...(where ? { where } : {}),
    });
  }

  // Completed only — see the same reasoning as `onMain` above: a status or an
  // error is reported by the *end* event, so an open span cannot be a failure
  // yet, only a hang (`http-still-open` already covers that). Filtering here
  // also gives `first` a real `endedAt`/`startedAt` to place a window with.
  const failed = http.filter(isCompleted).filter((c) => num(c.data.status) >= 400 || c.data.error !== undefined);
  if (failed.length > 0) {
    const first = failed[0];
    findings.push({
      id: "http-failed",
      severity: "error",
      confidence: "observed",
      title: `${failed.length} HTTP ${failed.length === 1 ? "call" : "calls"} failed`,
      detail: `${str(first.data.method)} ${str(first.data.url)} → ${str(first.data.status) || str(first.data.error)}`,
      count: failed.length,
      window: { from: first.startedAt ?? first.endedAt, to: first.endedAt },
    });
  }

  // The hang lanes. A capture is most often run *because* something hung, so
  // these are the findings least able to afford being absent.
  const open = [
    stillOpenFinding(
      http,
      "http-still-open",
      { one: "HTTP call", many: "HTTP calls" },
      (data) => ({
        label: `${str(data.method)} ${str(data.url)}`.trim() || "unidentified call",
        evidence: { method: str(data.method), url: str(data.url) },
      }),
      marks,
    ),
    stillOpenFinding(
      db,
      "db-still-open",
      { one: "database query", many: "database queries" },
      (data) => ({
        label: str(data.sql).slice(0, 80) || "unidentified query",
        evidence: { sql: str(data.sql) },
      }),
      marks,
    ),
    stillOpenFinding(
      work,
      "work-still-open",
      { one: "background job", many: "background jobs" },
      (data) => ({
        label: str(data.name) || str(data.id) || "unidentified job",
        evidence: { name: str(data.name), id: str(data.id) },
      }),
      marks,
    ),
  ].filter((finding): finding is Finding => finding !== undefined);
  findings.push(...open);

  const frames = events.filter((e) => e.event === "frame");
  if (frames.length > 0) {
    const missed = frames.reduce((sum, e) => sum + num(e.data.missedFrames, 1), 0);
    const worst = frames.reduce((a, b) => (num(a.data.totalMs) >= num(b.data.totalMs) ? a : b));
    const phases = new Map<string, number>();
    for (const frame of frames) {
      const phase = str(frame.data.worstPhase);
      if (phase) phases.set(phase, (phases.get(phase) ?? 0) + 1);
    }
    const commonest = [...phases.entries()].sort((a, b) => b[1] - a[1])[0];
    findings.push({
      id: "frames-dropped",
      severity: "warning",
      confidence: assumed ? "correlated" : "observed",
      title: `${missed} frames missed their deadline (budget ${describeBudget({ refreshHz, assumed })})`,
      detail: commonest
        ? `worst ${num(worst.data.totalMs)}ms · most often in ${commonest[0]}`
        : undefined,
      count: missed,
      during: markAt(marks, worst.t),
      // A `frame` event is posted when the frame finishes, so `worst.t` is its
      // end and its own totalMs backdates the start — the same reasoning as
      // `main-thread-stall`.
      window: { from: worst.t - num(worst.data.totalMs), to: worst.t },
    });
  }

  const gc = events.filter((e) => e.event === "gc" && num(e.data.blocking) > 0);
  if (gc.length > 0) {
    const paused = gc.reduce((sum, e) => sum + num(e.data.pausedMs), 0);
    findings.push({
      id: "blocking-gc",
      severity: "warning",
      confidence: "observed",
      title: `${gc.length} blocking collections paused the app for ${paused}ms`,
      count: gc.length,
      // Not `spanning`: unlike a trace-side aggregate that sums duration with
      // no timestamp of its own, every contributing collection here is a real
      // event with a real `t`, so a window from the earliest to the latest is
      // exactly where the count came from, not an invented range.
      window: eventWindow(gc),
    });
  }

  const trims = events.filter((e) => e.event === "device" && str(e.data.kind) === "trimMemory");
  if (trims.length > 0) {
    findings.push({
      id: "trim-memory",
      severity: "warning",
      confidence: "observed",
      title: `the system asked for memory back ${trims.length} ${trims.length === 1 ? "time" : "times"}`,
      detail: `worst level: ${str(trims[trims.length - 1].data.level)}`,
      count: trims.length,
      window: eventWindow(trims),
    });
  }

  const retried = work.filter((w) => w.data.retrying === "true");
  if (retried.length > 0) {
    findings.push({
      id: "work-retried",
      severity: "warning",
      confidence: "observed",
      title: `${retried.length} background ${retried.length === 1 ? "job" : "jobs"} retried`,
      count: retried.length,
      window: spanWindow(retried),
    });
  }

  // -- GRA-59: strict-mode violations --------------------------------------
  //
  // StrictModeCollector already did the filtering (a violation whose stack
  // never touches the app's own package never becomes an event at all) and
  // the counting (a flood at one call site is a handful of events, not one
  // per violation, each carrying the running total — see that collector's
  // own comment for the exact cap). What is left here is picking, per call
  // site, the event with the highest count — the collector may emit more
  // than one update for a site that kept going, and `findings` wants one
  // entry per site, not one per update.
  const strictBySite = new Map<string, DeviceEvent>();
  for (const violation of events.filter((e) => e.event === "strict_violation")) {
    const site = str(violation.data.site);
    const prior = strictBySite.get(site);
    if (!prior || num(violation.data.count) >= num(prior.data.count)) strictBySite.set(site, violation);
  }
  for (const violation of strictBySite.values()) {
    const category = str(violation.data.category);
    const severity: Severity =
      category === "main_thread_disk" || category === "main_thread_network"
        ? "error"
        : category === "leak"
          ? "warning"
          : "note";
    const count = num(violation.data.count, 1);
    const type = str(violation.data.type);
    const site = str(violation.data.site);
    findings.push({
      id: `strict-${site}`,
      severity,
      confidence: "observed",
      title: `${type} at ${site}` + (count > 1 ? ` (${count}×)` : ""),
      detail: str(violation.data.stack).split("\n").slice(0, 3).join("\n") || undefined,
      count,
      during: markAt(marks, violation.t),
      evidence: { site, thread: str(violation.data.thread), category },
      window: { from: violation.t, to: violation.t },
    });
  }
  // -- end GRA-59 -----------------------------------------------------------

  // The only correlated one, and a note for that reason.
  const recompose = events.filter((e) => e.event === "recompose");
  if (recompose.length > 0) {
    const byName = new Map<string, number>();
    const triggers = new Map<string, number>();
    for (const event of recompose) {
      const name = str(event.data.name);
      if (name) byName.set(name, (byName.get(name) ?? 0) + 1);
      for (const key of (event.data.triggeredBy as string[] | undefined) ?? []) {
        triggers.set(key, (triggers.get(key) ?? 0) + 1);
      }
    }
    const hottest = [...byName.entries()].sort((a, b) => b[1] - a[1])[0];
    const trigger = [...triggers.entries()].sort((a, b) => b[1] - a[1])[0];
    if (hottest && hottest[1] >= 100) {
      // GRA-201: the composable's own name, previously carried only inside
      // `title`'s prose — `evidence.composable` gives `whereForName` (and
      // any other reader) the bare name without reparsing the sentence.
      const where = whereForName(hottest[0]);
      findings.push({
        id: "recompose-hotspot",
        severity: "note",
        confidence: "correlated",
        title: `${hottest[0]} recomposed ${hottest[1]} times`,
        detail: trigger
          ? `most often within a frame of ${trigger[0]} — ordering, not proof`
          : undefined,
        count: hottest[1],
        evidence: { composable: hottest[0] },
        // Scoped to the hottest component's own recompositions, not every
        // recompose in the run, so the window is as tight as the count it
        // labels rather than as wide as the whole capture.
        window: eventWindow(recompose.filter((e) => str(e.data.name) === hottest[0])),
        ...(where ? { where } : {}),
      });
    }
  }

  // exit-findings (GRA-58): a death the device reported, at the severity the
  // ticket named explicitly — ANR, crash, native crash, low memory and
  // excessive resource usage are `error` (each means the system killed the
  // app, for a reason worth an agent's attention); a user-requested exit is
  // a `note` (informational: the app is not running, but nothing is wrong).
  // Everything else — REASON_OTHER, a signal, a background kill — produces
  // no finding at all: those are the normal shape of an app's process being
  // recycled, not evidence of anything.
  const exits = events.filter((e) => e.event === "exit");
  for (const exit of exits) {
    const reason = str(exit.data.reason);
    const severity: Severity | undefined = EXIT_ERROR_REASONS.has(reason)
      ? "error"
      : reason === "REASON_USER_REQUESTED"
        ? "note"
        : undefined;
    if (!severity) continue;

    const versionName = exit.data.versionName != null ? str(exit.data.versionName) : null;
    const versionAssumed = exit.data.versionAssumed === true;
    const build = versionName ? `${versionName}${versionAssumed ? " (assumed)" : ""}` : "an unknown build";
    const topFrame = str(exit.data.mainStack).split("\n")[0] || undefined;

    // GRA-113: `spanning`, not `window`. `exit.t` is a timestamp in *this*
    // process's uptime clock — the one reporting the death, at its next
    // check-in — not the dead process's, whose own uptime clock reset with
    // it and is gone. Placing the finding at `exit.t` would draw the death as
    // though it happened just now, in the wrong process's session.
    const predates = "the death predates this process's uptime clock, so it cannot be placed on this session's timeline";
    const description = str(exit.data.description) || undefined;
    const where = whereForFrame(topFrame);

    findings.push({
      id: `exit-${num(exit.data.timestamp)}`,
      severity,
      confidence: "observed",
      title: `${reason} — ${build}` + (topFrame ? ` — ${topFrame}` : ""),
      detail: description ? `${description} (${predates})` : predates,
      during: markAt(marks, exit.t),
      evidence: {
        reason,
        versionName,
        versionAssumed,
        timestamp: num(exit.data.timestamp),
        ...(topFrame ? { topFrame } : {}),
      },
      spanning: true,
      ...(where ? { where } : {}),
    });
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, note: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** `error`-severity exit reasons (GRA-58#exit-findings) — see `findingsOf`'s own comment for the rest of the mapping. */
const EXIT_ERROR_REASONS = new Set([
  "REASON_ANR",
  "REASON_CRASH",
  "REASON_CRASH_NATIVE",
  "REASON_LOW_MEMORY",
  "REASON_EXCESSIVE_RESOURCE_USAGE",
]);

// ---------------------------------------------------------------------------
// GRA-200: alsoInWindow — an inventory, not a second opinion
// ---------------------------------------------------------------------------
//
// findingsOf above answers "what is wrong" and is deliberately selective: a
// REASON_SIGNALED exit, a non-blocking gc, a plain memory sample produce no
// finding at all, because none of them is evidence of anything on their own.
// That selectivity is correct for `findings`' own job and was never the
// problem — the problem is that it left no OTHER way for an agent reading
// just `findings` to learn those events happened at all. `alsoInWindow` is
// that other way: a plain count (or, for exits, a full list) of what the
// window contained, built from the exact same `events` findingsOf was given,
// so the two can never disagree about which window they describe.
//
// "Also in this window" therefore intentionally overlaps `findings` rather
// than complementing it — an exit that already produced a finding still
// appears in `alsoInWindow.exits`, and a blocking gc still counts toward
// `alsoInWindow.gc`. The finding is the judgement; this is the inventory.
// Collapsing the two into "only show what findings missed" would silently
// reintroduce the exact bug this ticket exists to close the moment a second
// exit arrived in the same window as a first one that did get a finding.

export interface AlsoInWindowExit {
  reason: string;
  /** Epoch ms — `ApplicationExitInfo.getTimestamp()`'s own unit, exactly what `porthole_status`'s `exitTrace` param accepts (GRA-188). */
  timestamp: number;
  /** The same instant as `timestamp`, ISO-8601 — the same spelling `porthole_status`'s `exits.recent[].at` uses. */
  at: string;
}

export interface AlsoInWindow {
  /** Every exit event in the window, including ones that already produced a finding. Absent (not `[]`) when there were none. */
  exits?: AlsoInWindowExit[];
  /**
   * `device` events other than a `trimMemory` sub-kind — profile, lifecycle,
   * rotation, theme, power, network. Counted separately from [trim] so a
   * reader is not left guessing whether a "4 device events" count already
   * includes the memory-pressure signal named right next to it.
   */
  device?: number;
  /** Periodic memory samples — never their own finding, always worth knowing they exist. */
  memory?: number;
  /** All `gc` events, blocking or not — `findingsOf` only turns the blocking ones into a finding. */
  gc?: number;
  /** `device` events whose `data.kind` is `trimMemory` — always already a finding when present (`findingsOf`'s `trim-memory`), counted again here for the same reason an exit is. */
  trim?: number;
}

/**
 * Builds the block above from the same `events` `findingsOf` was given.
 * Returns `undefined` — not an object with every field absent — when there
 * is nothing to list, which is what keeps a `findings` payload with none of
 * this in its window byte-identical to what it returned before this ticket.
 */
export function alsoInWindowOf(events: DeviceEvent[]): AlsoInWindow | undefined {
  const exits = events
    .filter((e) => e.event === "exit")
    .map((e): AlsoInWindowExit => {
      const timestamp = num(e.data.timestamp);
      return { reason: str(e.data.reason), timestamp, at: new Date(timestamp).toISOString() };
    });

  const deviceEvents = events.filter((e) => e.event === "device");
  const trimEvents = deviceEvents.filter((e) => str(e.data.kind) === "trimMemory");
  const device = deviceEvents.length - trimEvents.length;
  const trim = trimEvents.length;
  const memory = events.filter((e) => e.event === "memory").length;
  const gc = events.filter((e) => e.event === "gc").length;

  const also: AlsoInWindow = {
    ...(exits.length > 0 ? { exits } : {}),
    ...(device > 0 ? { device } : {}),
    ...(memory > 0 ? { memory } : {}),
    ...(gc > 0 ? { gc } : {}),
    ...(trim > 0 ? { trim } : {}),
  };
  return Object.keys(also).length > 0 ? also : undefined;
}

/**
 * One sentence naming what [alsoInWindowOf] found, or `""` when it found
 * nothing. `findings`' own summary and `what_was_happening`'s `describe()`
 * both append exactly this — one function, not two hand-written near-copies
 * that would drift the way this codebase's own history (see BRIEFING.md's
 * "GRA-53: the third consumer") warns two independent copies always do.
 */
export function alsoInWindowSentence(also: AlsoInWindow | undefined): string {
  if (!also) return "";
  const parts: string[] = [];

  if (also.exits?.length) {
    const n = also.exits.length;
    if (n === 1) {
      const exit = also.exits[0];
      parts.push(
        `${n} process exit (${exit.reason}, full record via ` +
          `\`porthole_status { exitTrace: ${exit.timestamp} }\`)`,
      );
    } else {
      const latest = also.exits[also.exits.length - 1];
      parts.push(
        `${n} process exits (most recent ${latest.reason}, full records via \`porthole_status\`)`,
      );
    }
  }
  // Unlike an exit, none of these four carries a pointer of its own — a
  // count with nowhere to go for the detail is a dead end, so one shared
  // pointer to `timeline` (where every one of them is a raw, inspectable
  // event) covers all four rather than repeating the same clause four times.
  const rawCounts: string[] = [];
  if (also.device) rawCounts.push(`${also.device} device event${also.device === 1 ? "" : "s"}`);
  if (also.memory) rawCounts.push(`${also.memory} memory event${also.memory === 1 ? "" : "s"}`);
  if (also.gc) rawCounts.push(`${also.gc} GC event${also.gc === 1 ? "" : "s"}`);
  if (also.trim) rawCounts.push(`${also.trim} memory-trim event${also.trim === 1 ? "" : "s"}`);
  if (rawCounts.length > 0) {
    parts.push(`${rawCounts.join(", ")} (raw detail via \`timeline\`)`);
  }

  return parts.length > 0 ? `Also in this window: ${parts.join(", ")}.` : "";
}

export function buildTrace(options: {
  scenario: string;
  driver?: string;
  events: DeviceEvent[];
  hello: Record<string, unknown> | null;
  durationMs: number;
  withEvents: boolean;
  /** GRA-185: resolved once, by `resolveProfile` below, and handed in rather than re-derived here — see that function's own doc comment for why every caller must resolve it the same way. */
  profile: ResolvedProfile;
}): Trace {
  const { events, hello, profile } = options;

  const device = profile.assumed
    ? { model: str(hello?.device), sdkInt: num(hello?.sdkInt), refreshHz: profile.refreshHz }
    : { ...profile.full, refreshHz: profile.refreshHz };

  const marks = events
    .filter((e) => e.event === "mark")
    .map((e) => ({
      at: e.t,
      label: str(e.data.label),
      detail: str(e.data.detail) || undefined,
    }));

  return {
    porthole: TRACE_VERSION,
    scenario: options.scenario,
    capturedAt: new Date().toISOString(),
    durationMs: Math.round(options.durationMs),
    driver: options.driver,
    app: {
      packageName: str(hello?.packageName),
      versionName: hello?.versionName ?? null,
    },
    device,
    marks,
    metrics: metricsOf(events),
    findings: findingsOf(events, marks, profile.refreshHz, profile.assumed),
    events: options.withEvents ? events : undefined,
  };
}
