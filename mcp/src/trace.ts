// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { DeviceEvent } from "./device.js";

/**
 * Turning a recorded run into something worth reading.
 *
 * A dump of events serves only a machine, and badly. What a person wants back
 * from a capture is a short list of what is worth looking at; what CI wants is
 * a number it can compare. Both come from here.
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

const num = (value: unknown, fallback = 0): number => {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : value == null ? fallback : String(value);

/**
 * The value below which `share` of the samples fall.
 *
 * Percentiles rather than means throughout: a mean frame time is the one number
 * guaranteed to hide the problem, because the frames anyone cares about are the
 * tail.
 */
function percentile(values: number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(share * sorted.length));
  return Math.round(sorted[index]);
}

function spans(
  events: DeviceEvent[],
  prefix: string,
): Array<{ ms: number; data: Record<string, unknown> }> {
  const open = new Map<string, number>();
  const out: Array<{ ms: number; data: Record<string, unknown> }> = [];
  for (const event of events) {
    const id = str(event.data.id);
    if (event.event === `${prefix}_start`) open.set(id, event.t);
    else if (event.event === `${prefix}_end`) {
      const started = open.get(id);
      open.delete(id);
      const ms = started === undefined ? num(event.data.elapsedMs) : event.t - started;
      out.push({ ms, data: event.data });
    }
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

    "db.queries": db.length,
    "db.onMainThread": db.filter(
      (q) => q.data.onMainThread === "true" || q.data.onMainThread === true,
    ).length,
    "db.p95Ms": percentile(
      db.map((q) => q.ms),
      0.95,
    ),

    "http.calls": http.length,
    "http.failed": http.filter((c) => num(c.data.status) >= 400 || c.data.error !== undefined)
      .length,
    "http.p95Ms": percentile(
      http.map((c) => c.ms),
      0.95,
    ),

    "recompose.total": recompose.length,
    "recompose.peakPerFrame": perFrame.size ? Math.max(...perFrame.values()) : 0,

    "memory.peakHeapMb": memory.reduce((peak, e) => Math.max(peak, num(e.data.heapUsedMb)), 0),
    "memory.peakRamMb": memory.reduce((peak, e) => Math.max(peak, num(e.data.totalRamMb)), 0),
    "memory.blockingGcMs": gc.reduce((sum, e) => sum + num(e.data.pausedMs), 0),

    "work.runs": work.length,
    "work.retries": work.filter((w) => w.data.retrying === "true").length,
    "work.failures": work.filter((w) => str(w.data.state) === "FAILED").length,
  };
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

export function findingsOf(
  events: DeviceEvent[],
  marks: Trace["marks"],
  refreshHz: number,
): Finding[] {
  const findings: Finding[] = [];
  const db = spans(events, "db");
  const http = spans(events, "http");
  const work = spans(events, "work");

  const onMain = db.filter((q) => q.data.onMainThread === "true" || q.data.onMainThread === true);
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
    });
  }

  const stalls = events.filter((e) => e.event === "blocked");
  if (stalls.length > 0) {
    const worst = stalls.reduce((a, b) =>
      num(a.data.durationMs) >= num(b.data.durationMs) ? a : b,
    );
    findings.push({
      id: "main-thread-stall",
      severity: "error",
      confidence: "observed",
      title: `main thread blocked for ${num(worst.data.durationMs)}ms`,
      detail: str(worst.data.top).split("\n")[0] || undefined,
      count: stalls.length,
      during: markAt(marks, worst.t),
      evidence: {
        at: worst.t,
        stack: str(worst.data.stack).split("\n").slice(0, 6),
      },
    });
  }

  const failed = http.filter((c) => num(c.data.status) >= 400 || c.data.error !== undefined);
  if (failed.length > 0) {
    const first = failed[0];
    findings.push({
      id: "http-failed",
      severity: "error",
      confidence: "observed",
      title: `${failed.length} HTTP ${failed.length === 1 ? "call" : "calls"} failed`,
      detail: `${str(first.data.method)} ${str(first.data.url)} → ${str(first.data.status) || str(first.data.error)}`,
      count: failed.length,
    });
  }

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
      confidence: "observed",
      title: `${missed} frames missed their deadline (budget ${frameBudgetMs(refreshHz)}ms at ${Math.round(refreshHz)}Hz)`,
      detail: commonest
        ? `worst ${num(worst.data.totalMs)}ms · most often in ${commonest[0]}`
        : undefined,
      count: missed,
      during: markAt(marks, worst.t),
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
    });
  }

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
      findings.push({
        id: "recompose-hotspot",
        severity: "note",
        confidence: "correlated",
        title: `${hottest[0]} recomposed ${hottest[1]} times`,
        detail: trigger
          ? `most often within a frame of ${trigger[0]} — ordering, not proof`
          : undefined,
        count: hottest[1],
      });
    }
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, note: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

export function buildTrace(options: {
  scenario: string;
  driver?: string;
  events: DeviceEvent[];
  hello: Record<string, unknown> | null;
  durationMs: number;
  withEvents: boolean;
}): Trace {
  const { events, hello } = options;

  const profile = events.find((e) => e.event === "device" && str(e.data.kind) === "profile");
  const device = profile
    ? {
        model: str(profile.data.model),
        sdkInt: num(profile.data.sdkInt),
        abi: str(profile.data.abi),
        cores: num(profile.data.cores),
        deviceRamMb: num(profile.data.deviceRamMb),
        refreshHz: num(profile.data.refreshHz, 60),
        lowRamDevice: profile.data.lowRamDevice === "true",
      }
    : { model: str(hello?.device), sdkInt: num(hello?.sdkInt), refreshHz: 60 };

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
    findings: findingsOf(events, marks, num(device.refreshHz, 60)),
    events: options.withEvents ? events : undefined,
  };
}
