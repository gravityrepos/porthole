// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { isYours } from "./spans";
import { bounds } from "../timeline/geometry";
import type { DeviceEvent, ViewWindow } from "../types";
import { num, str, strings } from "../types";

export interface Metric {
  label: string;
  value: string;
  color: string;
}

export interface Cause {
  key: string;
  /** Where it fired, as far as the probe can honestly say: the node, not a line. */
  where: string;
  count: number;
  named: boolean;
}

export interface FrameBar {
  height: number;
  level: "clear" | "warn" | "bad";
}

export interface WindowSummary {
  from: number;
  to: number;
  label: string;
  metrics: Metric[];
  causes: Cause[];
  frames: { bars: FrameBar[]; missed: number; worstMs: number };
  observation: string | null;
}

/**
 * Describes the window currently on screen.
 *
 * Everything here is counted from events the device actually sent. Where the
 * design called for a source location, the honest answer is the composable the
 * recomposition happened in — the probe knows call sites, not line numbers.
 */
export function summariseWindow(events: DeviceEvent[], view: ViewWindow): WindowSummary {
  const from = Math.round(view.start);
  const to = Math.round(view.end);
  const origin = bounds(events).min;
  const visible = events.filter((event) => event.t >= from && event.t <= to);

  const recomposes = visible.filter((event) => event.event === "recompose");
  const writes = visible.filter((event) => event.event === "state_write");
  const frames = visible.filter((event) => event.event === "frame");

  const perFrame = new Map<number, number>();
  for (const event of recomposes) {
    const bucket = Math.floor(event.t / 16);
    perFrame.set(bucket, (perFrame.get(bucket) ?? 0) + 1);
  }
  const peak = perFrame.size ? Math.max(...perFrame.values()) : 0;

  const namedWrites = writes.reduce((sum, event) => sum + strings(event.data.named).length, 0);

  const metrics: Metric[] = [
    {
      label: "RECOMPOSES",
      value: recomposes.length.toLocaleString(),
      color: "var(--recompose)",
    },
    { label: "PEAK / FRAME", value: String(peak), color: "var(--recompose)" },
    { label: "STATE WRITES", value: namedWrites.toLocaleString(), color: "var(--write)" },
    {
      label: "DURATION",
      value: ((to - from) / 1000).toFixed(1) + "s",
      color: "var(--color-text)",
    },
  ];

  // What preceded the recompositions, aggregated. triggeredBy rides along on
  // every recompose event, so this is the same correlation the recompositions
  // tool reports, narrowed to what is on screen.
  const byKey = new Map<string, { count: number; nodes: Set<string> }>();
  for (const event of recomposes) {
    const node = str(event.data.name);
    for (const key of strings(event.data.triggeredBy)) {
      const entry = byKey.get(key) ?? { count: 0, nodes: new Set<string>() };
      entry.count += 1;
      if (node) entry.nodes.add(node);
      byKey.set(key, entry);
    }
  }

  const causes: Cause[] = [...byKey.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6)
    .map(([key, entry]) => ({
      key,
      where: [...entry.nodes].slice(0, 2).join(", ") || "—",
      count: entry.count,
      named: !key.startsWith("unnamed#"),
    }));

  return {
    from,
    to,
    label: `${((from - origin) / 1000).toFixed(1)}s — ${((to - origin) / 1000).toFixed(1)}s`,
    metrics,
    causes,
    frames: summariseFrames(frames),
    observation: observe(recomposes.length, causes, writes),
  };
}

function summariseFrames(frames: DeviceEvent[]): WindowSummary["frames"] {
  const missed = frames.reduce((sum, event) => sum + num(event.data.missedFrames, 1), 0);
  const worstMs = frames.reduce((worst, event) => Math.max(worst, num(event.data.totalMs)), 0);

  // Twenty-six columns, as in the design. With no frames the row is empty
  // rather than a flat line pretending to be data.
  const COLUMNS = 26;
  if (frames.length === 0) return { bars: [], missed: 0, worstMs: 0 };

  const first = frames[0].t;
  const last = frames[frames.length - 1].t;
  const span = Math.max(last - first, 1);
  const buckets = new Array<number>(COLUMNS).fill(0);

  for (const event of frames) {
    const index = Math.min(COLUMNS - 1, Math.floor(((event.t - first) / span) * COLUMNS));
    buckets[index] = Math.max(buckets[index], num(event.data.missedFrames, 1));
  }

  const peak = Math.max(...buckets, 1);
  const bars = buckets.map((value) => {
    const share = value / peak;
    return {
      height: Math.round(Math.max(value ? 14 : 6, Math.sqrt(share) * 100)),
      level: value === 0 ? "clear" : share > 0.6 ? "bad" : share > 0.25 ? "warn" : "clear",
    } as FrameBar;
  });

  return { bars, missed, worstMs };
}

/**
 * A statement of what the numbers say, not advice about what to do.
 *
 * The tool can see that one key preceded most of a burst. It cannot see whether
 * hoisting it or wrapping it in derivedStateOf is the right fix, so it does not
 * say — that is the question to hand to an agent that can read the code.
 */
function observe(recomposes: number, causes: Cause[], writes: DeviceEvent[]): string | null {
  if (recomposes === 0) return null;

  const top = causes[0];
  if (top && top.named && top.count >= Math.max(8, recomposes * 0.4)) {
    return `${top.key} preceded ${top.count} of ${recomposes} recompositions here, mostly in ${top.where}.`;
  }

  const anonymous = writes.filter((event) => !isYours(event)).length;
  if (anonymous > writes.length * 0.8 && writes.length > 20) {
    return `${anonymous} of ${writes.length} state writes are anonymous — mostly framework internals. Register the owner of anything here that is yours.`;
  }

  if (top) {
    return `${recomposes} recompositions, most often after ${top.key}.`;
  }
  return `${recomposes} recompositions, none attributable to a named state write.`;
}
