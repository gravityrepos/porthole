// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { Lane } from "../timeline/lanes";
import { toTime, toX } from "../timeline/geometry";
import { buildSpans, isYours } from "./spans";
import type { DeviceEvent, Span, ViewWindow } from "../types";
import { num, str } from "../types";

export type Hit =
  { kind: "span"; lane: Lane; span: Span } | { kind: "event"; lane: Lane; event: DeviceEvent };

/** One frame at 60Hz, which is the unit "peak per frame" is counted in. */
const FRAME_MS = 16;

export function spansForLane(lane: Lane, events: DeviceEvent[]): Span[] {
  return lane.kind === "spans" ? buildSpans(events, lane.key) : [];
}

function inView(events: DeviceEvent[], view: ViewWindow): DeviceEvent[] {
  return events.filter((event) => event.t >= view.start && event.t <= view.end);
}

/**
 * The second line of the lane gutter: whatever this lane's number actually is.
 *
 * Counted over the visible window rather than the whole session, so it answers
 * a question about what is on screen — the same window Ask agent hands over.
 */
export function laneStat(
  lane: Lane,
  events: DeviceEvent[],
  view: ViewWindow,
  showFramework: boolean,
): string {
  const visible = inView(events, view);

  switch (lane.kind) {
    case "density": {
      const mine = visible.filter((event) => event.event === lane.key);
      if (mine.length === 0) return "quiet";
      const frames = new Map<number, number>();
      for (const event of mine) {
        const bucket = Math.floor(event.t / FRAME_MS);
        frames.set(bucket, (frames.get(bucket) ?? 0) + 1);
      }
      const peak = Math.max(...frames.values());
      return `peak ${peak} / frame · ${mine.length.toLocaleString()} in view`;
    }

    case "writes": {
      const mine = visible.filter((event) => event.event === lane.key);
      const named = mine.filter(isYours).length;
      const anonymous = mine.length - named;
      if (mine.length === 0) return "quiet";
      return showFramework
        ? `${named} yours · ${anonymous} anonymous`
        : `${named} yours · ${anonymous} hidden`;
    }

    case "jank": {
      const mine = visible.filter((event) => event.event === lane.key);
      if (mine.length === 0) return "no frames dropped";
      const worst = Math.max(...mine.map((event) => num(event.data.missedFrames, 1)));
      return `${mine.length} janky · worst ${worst} missed`;
    }

    case "blocked": {
      const stalls = visible.filter((event) => event.event === "blocked");
      const onMain = visible.filter(
        (event) => event.event === "db_end" && event.data.onMainThread,
      ).length;
      if (stalls.length === 0 && onMain === 0) return "clear";
      const parts: string[] = [];
      if (stalls.length) {
        const worst = Math.max(...stalls.map((event) => num(event.data.durationMs)));
        parts.push(`${stalls.length} stall${stalls.length === 1 ? "" : "s"} · worst ${worst}ms`);
      }
      if (onMain) parts.push(`${onMain} db on main`);
      return parts.join(" · ");
    }

    case "markers": {
      const marks = visible.filter((event) => event.event === lane.key);

      if (lane.key === "device") {
        if (marks.length === 0) return "no changes";
        const profile = marks.find((event) => str(event.data.kind) === "profile");
        const changes = marks.filter((event) => str(event.data.kind) !== "profile").length;
        const parts: string[] = [];
        if (profile) {
          const ram = num(profile.data.deviceRamMb);
          parts.push(`${num(profile.data.cores)} cores`);
          if (ram > 0) parts.push(`${Math.round(ram / 1024)} GB`);
        }
        parts.push(`${changes} change${changes === 1 ? "" : "s"}`);
        return parts.join(" · ");
      }

      const routes = new Set(marks.map((event) => str(event.data.route)));
      return routes.size === 0
        ? "no navigation"
        : `${routes.size} destination${routes.size === 1 ? "" : "s"}`;
    }

    case "spans": {
      const spans = spansForLane(lane, events).filter(
        (span) => span.end >= view.start && span.start <= view.end,
      );
      if (spans.length === 0) return "idle";
      const failed = spans.filter(
        (span) => span.data.error !== undefined || num(span.data.status) >= 400,
      ).length;
      const label =
        lane.key === "http"
          ? `${spans.length} call${spans.length === 1 ? "" : "s"}`
          : lane.key === "work"
            ? `${spans.length} run${spans.length === 1 ? "" : "s"}`
            : `${spans.length} quer${spans.length === 1 ? "y" : "ies"}`;
      const retries = spans.filter((span) => span.data.retrying === "true").length;
      if (retries) return `${label} · ${retries} retried`;
      return failed ? `${label} · ${failed} failed` : label;
    }

    case "area": {
      const samples = visible.filter((event) => event.event === lane.key);
      if (samples.length === 0) return "no samples";
      const used = samples.map((event) => num(event.data.heapUsedMb));
      const latest = used[used.length - 1];
      const peak = Math.max(...used);
      const gc = samples.reduce((sum, event) => sum + num(event.data.gcSinceLast), 0);
      const max = num(samples[samples.length - 1].data.heapMaxMb);
      // Growth across the window, which is a hint to go looking rather than a
      // finding: a heap that climbs and never returns is worth a heap dump,
      // and a heap dump is what would actually name the leak.
      const climb = latest - used[0];
      const ram = num(samples[samples.length - 1].data.totalRamMb);
      const blockingMs = samples.reduce((sum, event) => sum + num(event.data.blockingGcMs), 0);

      const alloc = samples.map((event) => num(event.data.allocKbPerSec));
      const peakAlloc = alloc.length ? Math.max(...alloc) : 0;

      const parts = [`${latest}/${max} MB`];
      if (ram > 0) parts.push(`${ram} MB ram`);
      parts.push(`peak ${peak}`);
      if (gc > 0) parts.push(`${gc} GC`);
      if (blockingMs > 0) parts.push(`${blockingMs}ms paused`);
      if (peakAlloc > 0) {
        parts.push(
          peakAlloc >= 1024
            ? `${(peakAlloc / 1024).toFixed(1)} MB/s peak`
            : `${peakAlloc} KB/s peak`,
        );
      }
      if (climb > 8) parts.push(`+${climb} MB`);
      return parts.join(" · ");
    }

    case "levels": {
      const warnings = visible.filter(
        (event) => event.event === "log" && ["W", "E", "F"].includes(str(event.data.level)),
      );
      if (warnings.length === 0) return "none in view";
      const errors = warnings.filter((event) => str(event.data.level) !== "W").length;
      return errors
        ? `${warnings.length} · ${errors} error${errors === 1 ? "" : "s"}`
        : `${warnings.length} warnings`;
    }
  }
}

/**
 * Hit testing is per lane now, which is most of why the DOM gutter was worth
 * it: the lane is known before the pointer is, so there is no layout to search.
 */
export function hitLane(
  lane: Lane,
  events: DeviceEvent[],
  spans: Span[],
  view: ViewWindow,
  width: number,
  x: number,
  showFramework: boolean,
): Hit | null {
  const time = toTime(x, view, width);
  const tolerance = ((view.end - view.start) / Math.max(width, 1)) * 4;

  if (lane.kind === "spans") {
    const span = spans.find(
      (item) => time >= item.start - tolerance && time <= item.end + tolerance,
    );
    return span ? { kind: "span", lane, span } : null;
  }

  const matches = (event: DeviceEvent): boolean => {
    if (lane.kind === "blocked") {
      return event.event === "blocked" || (event.event === "db_end" && !!event.data.onMainThread);
    }
    // The memory lane carries its samples and the collections between them.
    if (lane.kind === "area") return event.event === lane.key || event.event === "gc";
    if (event.event !== lane.key) return false;
    // A hidden write must not be selectable, or you can click something that is
    // not on screen and wonder what you selected.
    if (lane.kind === "writes" && !showFramework && !isYours(event)) return false;
    if (lane.kind === "levels") return ["W", "E", "F"].includes(str(event.data.level));
    return true;
  };

  let best: DeviceEvent | null = null;
  let bestDistance = Infinity;
  for (const event of events) {
    if (!matches(event)) continue;
    const distance = Math.abs(event.t - time);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = event;
    }
  }

  return best && bestDistance <= tolerance * 3 ? { kind: "event", lane, event: best } : null;
}

export interface NavRule {
  seq: number;
  left: number;
}

export interface NavChip {
  seq: number;
  left: number;
  label: string;
}

/**
 * IBM Plex Mono advances 0.6em, so at 10.5px every glyph is this wide. The
 * chrome is the rule, the gap after it, and the chip's own padding.
 */
const CHAR_PX = 6.3;
const CHIP_CHROME = 26;

const labelWidth = (route: string, counted: boolean): number =>
  route.length * CHAR_PX + CHIP_CHROME + (counted ? 4 * CHAR_PX : 0);

/**
 * Nav markers, with the labels thinned until they stop colliding.
 *
 * Every navigation keeps its rule, so the lane still shows how often you
 * moved. Only the labels collapse, and a label that swallowed its neighbours
 * says how many — otherwise a burst of five reads as a single navigation.
 */
export function navChips(
  events: DeviceEvent[],
  view: ViewWindow,
  width: number,
  key = "nav",
): { rules: NavRule[]; chips: NavChip[] } {
  const marks = events
    .filter((event) => event.event === key)
    .map((event) => ({
      seq: event.seq,
      left: toX(event.t, view, 100),
      route: key === "device" ? deviceLabel(event) : str(event.data.route),
    }))
    .filter((mark) => mark.left >= -2 && mark.left <= 102);

  const rules: NavRule[] = marks.map(({ seq, left }) => ({ seq, left }));
  const chips: NavChip[] = [];
  if (width <= 0) return { rules, chips };

  let cluster: { seq: number; left: number; route: string; count: number; mixed: boolean } | null =
    null;

  const flush = () => {
    if (!cluster) return;
    const { seq, left, route, count, mixed } = cluster;
    chips.push({
      seq,
      left,
      label: count === 1 ? route : mixed ? `${route} +${count - 1}` : `${route} ×${count}`,
    });
    cluster = null;
  };

  for (const mark of marks) {
    if (cluster) {
      const anchorX = (cluster.left / 100) * width;
      if ((mark.left / 100) * width < anchorX + labelWidth(cluster.route, cluster.count > 1)) {
        cluster.count += 1;
        if (mark.route !== cluster.route) cluster.mixed = true;
        continue;
      }
    }
    flush();
    cluster = { ...mark, count: 1, mixed: false };
  }
  flush();

  return { rules, chips };
}

/**
 * What a device event says in one chip.
 *
 * Short on purpose: the lane is a strip of context, and the detail is one click
 * away in the selection pane.
 */
export function deviceLabel(event: DeviceEvent): string {
  const data = event.data;
  switch (str(data.kind)) {
    case "profile":
      return str(data.model);
    case "foreground":
      return "foreground";
    case "background":
      return "background";
    case "rotation":
      return str(data.orientation) || `rotated ${str(data.rotation)}\u00b0`;
    case "theme":
      return data.darkMode === "true" ? "dark mode" : "light mode";
    case "fontScale":
      return `font ${str(data.fontScale)}x`;
    case "trimMemory":
      return `trim: ${str(data.level)}`;
    case "lowMemory":
      return "low memory";
    case "network":
      return str(data.transport) === "none" ? "offline" : str(data.transport);
    case "power": {
      const parts: string[] = [];
      if (data.dozing === "true") parts.push("dozing");
      if (data.powerSaver === "true") parts.push("power saver");
      const battery = num(data.batteryPercent, -1);
      if (battery >= 0) parts.push(`${battery}%`);
      return parts.join(" · ") || str(data.change);
    }
    default:
      return str(data.kind);
  }
}
