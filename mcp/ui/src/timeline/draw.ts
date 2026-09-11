// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { BUCKET_PX, TICK_COUNT, type Lane } from "./lanes";
import { toX } from "./geometry";
import { isYours } from "../lib/spans";
import type { DeviceEvent, Span, ViewWindow } from "../types";
import { num } from "../types";

export interface LaneScene {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  view: ViewWindow;
  events: DeviceEvent[];
  spans: Span[];
  color: string;
  showFramework: boolean;
}

export function readCss(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Marks sit on a baseline a few pixels off the floor, as in the design. */
const FLOOR = 6;
const CEILING = 10;

export function drawLane(lane: Lane, scene: LaneScene): void {
  const { ctx, width, height } = scene;
  ctx.clearRect(0, 0, width, height);
  drawGuides(scene);

  switch (lane.kind) {
    case "density":
      drawDensity(lane, scene);
      break;
    case "writes":
      drawWrites(lane, scene);
      break;
    case "jank":
      drawJank(lane, scene);
      break;
    case "blocked":
      drawBlocked(scene);
      break;
    case "spans":
      drawSpans(scene);
      break;
    case "levels":
      drawLevels(scene);
      break;
    case "area":
      drawArea(scene);
      break;
    case "markers":
      // Navigation markers are DOM: the route chip wants real text, with real
      // ellipsis and a real hover target, not glyphs painted into a bitmap.
      break;
  }
}

function drawGuides(scene: LaneScene): void {
  const { ctx, width, height } = scene;
  ctx.strokeStyle = readCss("--grid");
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < TICK_COUNT; i++) {
    const x = Math.round((width / TICK_COUNT) * i) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  ctx.stroke();
}

function usable(height: number): number {
  return Math.max(height - FLOOR - CEILING, 4);
}

/**
 * Counts matching events into fixed-width columns of screen space.
 *
 * Ticks stop carrying information once they overlap: three hundred in one frame
 * look exactly like three. A column whose height is the count does not have
 * that problem, and it is the only honest way to draw something that fires
 * faster than the display can resolve.
 */
function bucketEvents(
  scene: LaneScene,
  matches: (event: DeviceEvent) => boolean,
): { buckets: Map<number, number>; peak: number } {
  const buckets = new Map<number, number>();
  let peak = 0;

  for (const event of scene.events) {
    if (!matches(event)) continue;
    const x = toX(event.t, scene.view, scene.width);
    if (x < -BUCKET_PX || x > scene.width + BUCKET_PX) continue;
    const bucket = Math.floor(x / BUCKET_PX);
    const next = (buckets.get(bucket) ?? 0) + 1;
    buckets.set(bucket, next);
    if (next > peak) peak = next;
  }

  return { buckets, peak };
}

function drawBuckets(
  scene: LaneScene,
  buckets: Map<number, number>,
  peak: number,
  baseline: number,
  span: number,
  maxAlpha: number,
): void {
  const { ctx, color } = scene;
  ctx.fillStyle = color;
  for (const [bucket, count] of buckets) {
    const share = count / Math.max(peak, 1);
    const barHeight = Math.max(2, share * span);
    ctx.globalAlpha = maxAlpha * (0.62 + 0.38 * share);
    ctx.fillRect(bucket * BUCKET_PX, baseline - barHeight, BUCKET_PX - 1, barHeight);
  }
  ctx.globalAlpha = 1;
}

function drawDensity(lane: Lane, scene: LaneScene): void {
  const { buckets, peak } = bucketEvents(scene, (e) => e.event === lane.key);
  drawBuckets(scene, buckets, peak, scene.height - FLOOR, usable(scene.height), 1);
}

/**
 * Splits the lane in two: writes the tool can name as full-height marks, and
 * anonymous ones as a low density band. A named write is your state and tells
 * you what changed; an anonymous one is almost always Compose going about its
 * business, and mixing the two buries the half you can act on.
 */
function drawWrites(lane: Lane, scene: LaneScene): void {
  const { ctx, width, height, view, color } = scene;
  const baseline = height - FLOOR;
  const span = usable(height);

  if (scene.showFramework) {
    const { buckets, peak } = bucketEvents(scene, (e) => e.event === lane.key && !isYours(e));
    drawBuckets(scene, buckets, peak, baseline, span * 0.42, 0.4);
  }

  // Named writes stay individual marks: there are few of them, each one is
  // something you might click, and losing one to a neighbour would matter.
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.95;
  for (const event of scene.events) {
    if (event.event !== lane.key || !isYours(event)) continue;
    const x = Math.round(toX(event.t, view, width));
    if (x < 0 || x > width) continue;
    ctx.fillRect(x, baseline - span, 2, span);
  }
  ctx.globalAlpha = 1;
}

/** Bar height is refreshes missed, so a stutter and a freeze look different. */
function drawJank(lane: Lane, scene: LaneScene): void {
  const { ctx, width, height, view, color } = scene;
  const baseline = height - FLOOR;
  const span = usable(height);

  let worst = 1;
  for (const event of scene.events) {
    if (event.event === lane.key) worst = Math.max(worst, num(event.data.missedFrames, 1));
  }

  for (const event of scene.events) {
    if (event.event !== lane.key) continue;
    const x = Math.round(toX(event.t, view, width));
    if (x < 0 || x > width) continue;
    const missed = num(event.data.missedFrames, 1);
    // Square root, not linear: one outlier of fifty missed frames flattens
    // every single-frame drop into the baseline, and single-frame drops are
    // most of what you are looking for.
    const barHeight = Math.max(3, Math.sqrt(missed / worst) * span);
    const firstDraw = event.data.firstDraw === true;
    ctx.fillStyle = firstDraw ? readCss("--faint") : color;
    ctx.globalAlpha = firstDraw ? 0.6 : 0.9;
    ctx.fillRect(x, baseline - barHeight, 2, barHeight);
  }
  ctx.globalAlpha = 1;
}

/**
 * Everything that held the main thread: watchdog stalls and any database work
 * that ran there. Width is duration, because duration is the point.
 */
function drawBlocked(scene: LaneScene): void {
  const { ctx, width, height, view, color } = scene;
  const baseline = height - FLOOR;
  const span = usable(height);

  ctx.fillStyle = color;
  ctx.globalAlpha = 0.82;
  for (const event of scene.events) {
    let start: number;
    let duration: number;
    if (event.event === "blocked") {
      start = event.t;
      duration = num(event.data.durationMs);
    } else if (event.event === "db_end" && event.data.onMainThread) {
      duration = num(event.data.elapsedMs);
      start = event.t - duration;
    } else {
      continue;
    }

    const x1 = toX(start, view, width);
    const x2 = Math.max(toX(start + duration, view, width), x1 + 3);
    if (x2 < 0 || x1 > width) continue;
    const left = Math.max(x1, 0);
    ctx.fillRect(left, baseline - span, Math.min(x2, width) - left, span);
  }
  ctx.globalAlpha = 1;
}

function drawSpans(scene: LaneScene): void {
  const { ctx, width, height, view, color } = scene;
  const baseline = height - FLOOR;
  const span = usable(height);

  for (const item of scene.spans) {
    const x1 = toX(item.start, view, width);
    const x2 = Math.max(toX(item.end, view, width), x1 + 2);
    if (x2 < 0 || x1 > width) continue;

    // A failed call or a failed write is the thing you are looking for, so it
    // gets its own colour rather than a subtler shade of the lane's.
    const failed = item.data.error !== undefined || num(item.data.status) >= 400;
    const left = Math.max(x1, 0);

    ctx.fillStyle = failed ? readCss("--danger") : color;
    ctx.globalAlpha = item.open ? 0.95 : failed ? 0.9 : 0.7;
    ctx.fillRect(left, baseline - span, Math.min(x2, width) - left, span);
  }
  ctx.globalAlpha = 1;
}

function drawLevels(scene: LaneScene): void {
  const { ctx, width, height, view } = scene;
  const baseline = height - FLOOR;
  const span = usable(height);
  const warn = readCss("--db");
  const error = readCss("--danger");

  for (const event of scene.events) {
    if (event.event !== "log") continue;
    const level = event.data.level;
    if (level !== "W" && level !== "E" && level !== "F") continue;
    const x = Math.round(toX(event.t, view, width));
    if (x < 0 || x > width) continue;
    ctx.fillStyle = level === "W" ? warn : error;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x, baseline - span, 2, span);
  }
  ctx.globalAlpha = 1;
}

/**
 * Heap as a filled area against its own ceiling.
 *
 * Scaled to the app's max heap rather than to the tallest sample, so the lane
 * answers "how close to the limit" rather than "how does this minute compare
 * with itself" — a heap idling at 12% should look calm, not full.
 */
function drawArea(scene: LaneScene): void {
  const { ctx, width, height, view, events, color } = scene;
  const samples = events.filter((event) => event.event === "memory");
  if (samples.length === 0) return;

  // Both series share one ceiling, because the point of drawing them together
  // is the gap between them: the heap is the memory you allocated, total RAM is
  // what the process actually costs.
  const ceiling = Math.max(
    1,
    ...samples.map((event) => Math.max(num(event.data.heapMaxMb), num(event.data.totalRamMb))),
  );
  const y = (mb: number) => height - 2 - (mb / ceiling) * (height - 6);

  const inView = samples.filter((event) => {
    const x = toX(event.t, view, width);
    return x >= -width && x <= width * 2;
  });
  if (inView.length === 0) return;

  // Collections go on first, behind the curves. They are context for the shape
  // of the line, and a mark drawn over it hides the thing it explains.
  for (const event of events) {
    if (event.event !== "gc") continue;
    const x = toX(event.t, view, width);
    if (x < 0 || x > width) continue;
    const blocking = num(event.data.blocking) > 0;
    ctx.fillStyle = blocking ? withAlpha(readCss("--danger"), 0.55) : withAlpha(color, 0.3);
    ctx.fillRect(x - 0.5, 0, blocking ? 2 : 1, height);
  }

  const line = (points: Array<{ x: number; y: number }>) => {
    ctx.beginPath();
    points.forEach((point, index) =>
      index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y),
    );
    ctx.stroke();
  };

  // Total RAM is only read every fifth sample, so it is missing from most
  // events. Plotting it blind would draw a sawtooth down to zero.
  const ram = inView.filter((event) => num(event.data.totalRamMb) > 0);
  if (ram.length > 1) {
    ctx.strokeStyle = withAlpha(color, 0.5);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    line(ram.map((event) => ({ x: toX(event.t, view, width), y: y(num(event.data.totalRamMb)) })));
    ctx.setLineDash([]);
  }

  const heap = inView.map((event) => ({
    x: toX(event.t, view, width),
    y: y(num(event.data.heapUsedMb)),
  }));

  ctx.beginPath();
  ctx.moveTo(heap[0].x, height);
  for (const point of heap) ctx.lineTo(point.x, point.y);
  ctx.lineTo(heap[heap.length - 1].x, height);
  ctx.closePath();
  ctx.fillStyle = withAlpha(color, 0.16);
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  line(heap);
}

/** Canvas has no colour-mix, so a token has to be resolved and re-emitted. */
function withAlpha(color: string, alpha: number): string {
  const match = color.trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return color;
  const value = parseInt(match[1], 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}
