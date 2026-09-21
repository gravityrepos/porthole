// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * GRA-68: "answers that fit in a context window."
 *
 * Every tool used to return its summary line plus the *entire* JSON payload,
 * pretty-printed. A 500-event `timeline` call is tens of thousands of
 * tokens, and an agent that calls a tool a dozen times in a session pays
 * that cost every single time, whether or not it ever reads past the first
 * sentence. `detail` is the lever: `"summary"` is the line an agent almost
 * always wants (plus the headline numbers and whatever it needs to make a
 * follow-up call — a window is always quotable straight from it), with no
 * JSON at all; `"normal"` is today's payload, made compact instead of
 * pretty-printed; `"full"` is the complete data, at whatever the old,
 * uncapped defaults were before this ticket, also compact.
 *
 * `"summary"` is the default — an explicit EM ruling on this ticket, not a
 * guess: an agent that never thought about context budget gets the cheap
 * answer, and has to opt in to the expensive one.
 *
 * This module is the one place that decision is made. `index.ts`'s `ok()`
 * is the only caller; every tool reaches this through it, the same way
 * GRA-55's banner and GRA-171's `joinSummaryAndPayload()` are each built in
 * one place so no tool can forget them by not being the one that remembered
 * to opt in.
 */
export type DetailLevel = "summary" | "normal" | "full";

export const DEFAULT_DETAIL: DetailLevel = "summary";

/**
 * The one `detail` declaration, spread into every tool's `inputSchema` —
 * `windowShape`'s own doc comment in index.ts is the model: one shared
 * shape, never a hand-rolled copy per tool (see `render.test.ts`'s
 * "not a hand-rolled copy" case, which checks the running server's schema
 * the same way `surface.test.ts` already does for `sinceMs`/`since`).
 */
export const detailShape = {
  detail: z
    .enum(["summary", "normal", "full"])
    .optional()
    .describe(
      'How much to return. "summary" (the default): the summary line, its headline numbers, ' +
        "and anything needed to make a follow-up call — a window is always quotable straight " +
        'from it — with no JSON payload at all. "normal": today\'s JSON payload, alongside the ' +
        'summary, compact rather than pretty-printed and sized for a context window. "full": ' +
        "the complete data at the old, uncapped defaults this tool used before detail existed, " +
        "still compact. Every level states how many bytes it actually returned and what the " +
        "next level up would cost, so you can decide whether it is worth asking for.",
    ),
};

export function resolveDetail(detail: DetailLevel | undefined): DetailLevel {
  return detail ?? DEFAULT_DETAIL;
}

/** GRA-68: "stop pretty-printing" — compact, never indented, for normal/full. */
export function compactJson(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function formatBytes(n: number): string {
  if (n < 1_000) return `${n}B`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}KB`;
  return `${(n / 1_000_000).toFixed(1)}MB`;
}

/**
 * The size report every level carries (the ticket's `{ bytes, nextLevelBytes
 * }`, spelled as prose appended to the summary line rather than a payload
 * field, since `"summary"` has no payload to carry one in — a field only
 * the other two levels could see would not be "every level"). `shownBytes`
 * is meant to be measured off the text this call is actually about to
 * return, never estimated ahead of building it, so it cannot itself be the
 * thing that silently returns less than it says (GRA-68's acceptance
 * criterion) — this function trusts its caller for that; it only formats
 * the two numbers it is handed. A caller that passes `shownBytes` measured
 * *before* appending this note's own return value would be the one gap
 * that criterion allows (a note that had to describe its own length would
 * have no fixed point to measure from) — `renderDetail`'s `"summary"`
 * branch closes exactly that gap with one extra pass (QA F6); the other
 * two levels have a real payload block to measure that this note is never
 * part of, so no such gap exists for them. `next` is `null` at `"full"`,
 * since there is no level past it.
 */
export function sizeNote(
  shownBytes: number,
  next: { label: "normal" | "full"; bytes: number } | null,
): string {
  return next
    ? ` [${formatBytes(shownBytes)} returned; ${next.label} ≈ ${formatBytes(next.bytes)}]`
    : ` [${formatBytes(shownBytes)} returned]`;
}

export interface DetailDecision {
  /** The final summary text — banner, prose, and the size note, in that order. */
  summaryText: string;
  /** Present only for "normal"/"full" — the raw payload `ok()` hands to `joinSummaryAndPayload()`. Undefined at "summary": no payload block at all. */
  payload?: unknown;
}

/**
 * Decides what a tool result actually contains, for a given `detail`.
 *
 * `fullPayload` is optional and almost always omitted: most tools have
 * nothing bigger to offer than what `normalPayload` already carries (no
 * truncation to lift), so `"full"` falls back to `normalPayload` and the
 * size note says so honestly (the "next level" costs the same, because
 * there is no next level). Only a tool with a real truncation to lift
 * (`timeline`'s `limit`, `semantics_tree`'s `maxNodes` — see their own
 * comments in index.ts) passes a distinct one.
 */
export function renderDetail(params: {
  summary: string;
  normalPayload: unknown;
  fullPayload?: unknown;
  /**
   * An *approximate* byte count for what `"full"` would cost, used only
   * when `fullPayload` itself is not available to measure — a tool whose
   * truncation happens on the device side (`semantics_tree`'s `maxNodes`)
   * cannot build a second, bigger payload without a second round trip, so
   * it estimates instead of fetching one just to throw it away. Never used
   * to describe what *this* call actually returned — only ever the "next
   * level" half of the note, which the ticket's own wording allows to be
   * approximate. Ignored when `fullPayload` is given (a real measurement
   * always wins over an estimate) or when `detail` is already `"full"`
   * (nothing to estimate: what was returned is what was returned).
   */
  fullBytesHint?: number;
  /**
   * QA F2: bytes returned outside the JSON payload but present at every
   * level regardless — `screenshot`'s own image content block, which is
   * never gated by `detail` (see that tool's own comment). Added into
   * every "shown"/"next" figure below, at every level, so the note never
   * claims a two-digit byte count while an actual ~26KB base64 image went
   * out alongside it. Zero for every tool that has nothing outside the
   * JSON payload, which is every tool but `screenshot`.
   */
  extraBytes?: number;
  detail: DetailLevel;
}): DetailDecision {
  const { summary, normalPayload, detail } = params;
  const extraBytes = params.extraBytes ?? 0;
  const hasDistinctFull = params.fullPayload !== undefined;
  const fullPayload = hasDistinctFull ? params.fullPayload : normalPayload;
  const normalBytes = byteLength(compactJson(normalPayload)) + extraBytes;
  // QA F5: `fullBytesHint` is an estimate of what a *different*, bigger
  // fetch would cost — it never describes what this call is actually
  // about to return. At `detail: "full"` with no distinct `fullPayload`,
  // what is returned is `normalPayload` itself (the same fallback `"full"`
  // uses below), so the hint has nothing left to estimate and must not be
  // substituted for the real, measured `normalBytes` — matching the doc
  // comment above, which the code did not, until now.
  const fullBytes = hasDistinctFull
    ? byteLength(compactJson(fullPayload)) + extraBytes
    : detail === "full"
      ? normalBytes
      : params.fullBytesHint !== undefined
        ? params.fullBytesHint + extraBytes
        : normalBytes;

  if (detail === "summary") {
    const next = { label: "normal", bytes: normalBytes } as const;
    // QA F6: the "returned" figure at `"summary"` must count the whole
    // block actually sent — there is no separate payload block at this
    // level, so the note's own bytes (and `extraBytes`, QA F2) are part
    // of what was returned, not just the prose ahead of it. The note's
    // length depends on the number it reports, so this is a one-step
    // fixed point: the first pass sizes the note off the prose plus
    // `extraBytes` alone, and is accurate to within the note's own text
    // (only a number that crosses a `formatBytes` rounding boundary —
    // 999 to 1000, say — right at this step could disagree with a second
    // pass, which no summary line does in practice).
    const firstPass = sizeNote(byteLength(summary) + extraBytes, next);
    const totalBytes = byteLength(summary) + extraBytes + byteLength(firstPass);
    return { summaryText: summary + sizeNote(totalBytes, next) };
  }
  if (detail === "normal") {
    const next = fullBytes > normalBytes ? ({ label: "full", bytes: fullBytes } as const) : null;
    return { summaryText: summary + sizeNote(normalBytes, next), payload: normalPayload };
  }
  return { summaryText: summary + sizeNote(fullBytes, null), payload: fullPayload };
}

// ---------------------------------------------------------------------------
// GRA-91, folded in: what "summary" must mean for three specific tools
// ---------------------------------------------------------------------------

/**
 * `timeline`'s own event shape, loose on purpose — this module never
 * imports `DeviceEvent` from `device.ts` to avoid a dependency cycle, and
 * only ever needs `t`/`event` off of it.
 */
export interface TimelineLikeEvent {
  t: number;
  event: string;
}

export interface TimelineHighlights {
  /** The one-second bucket (by `t`, floored) carrying the most events, when there is more than one bucket. */
  busiestSecond: { startMs: number; count: number } | null;
  /** The largest gap between two consecutive events, when there are at least two. */
  longestGap: { fromMs: number; toMs: number; ms: number } | null;
  /** An event kind that occurred exactly once in the window, when one exists — the first by time, when several tie. */
  onceOnly: { kind: string; atMs: number } | null;
}

/**
 * GRA-91: "the busiest second, the longest gap, and the thing that
 * happened exactly once" — `timeline`'s own contribution to what
 * `detail: "summary"` must say, computed off the same `events` array the
 * tool already resolved (no second fetch, no new data source).
 */
export function timelineHighlights(events: readonly TimelineLikeEvent[]): TimelineHighlights {
  if (events.length === 0) {
    return { busiestSecond: null, longestGap: null, onceOnly: null };
  }
  const sorted = [...events].sort((a, b) => a.t - b.t);

  const buckets = new Map<number, number>();
  for (const e of sorted) {
    const bucket = Math.floor(e.t / 1000) * 1000;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  let busiestSecond: TimelineHighlights["busiestSecond"] = null;
  for (const [startMs, count] of buckets) {
    if (!busiestSecond || count > busiestSecond.count) busiestSecond = { startMs, count };
  }
  // A single bucket carrying every event is not "busy" relative to
  // anything — only worth naming once there is a second bucket to be busier
  // than.
  if (buckets.size <= 1) busiestSecond = null;

  let longestGap: TimelineHighlights["longestGap"] = null;
  for (let i = 1; i < sorted.length; i++) {
    const ms = sorted[i].t - sorted[i - 1].t;
    if (!longestGap || ms > longestGap.ms) {
      longestGap = { fromMs: sorted[i - 1].t, toMs: sorted[i].t, ms };
    }
  }

  const counts = new Map<string, number>();
  const firstAt = new Map<string, number>();
  for (const e of sorted) {
    counts.set(e.event, (counts.get(e.event) ?? 0) + 1);
    if (!firstAt.has(e.event)) firstAt.set(e.event, e.t);
  }
  let onceOnly: TimelineHighlights["onceOnly"] = null;
  for (const [kind, count] of counts) {
    if (count !== 1) continue;
    const atMs = firstAt.get(kind)!;
    if (!onceOnly || atMs < onceOnly.atMs) onceOnly = { kind, atMs };
  }

  return { busiestSecond, longestGap, onceOnly };
}

export function describeTimelineHighlights(h: TimelineHighlights): string {
  const parts: string[] = [];
  if (h.busiestSecond) {
    parts.push(`busiest second at t=${h.busiestSecond.startMs} (${h.busiestSecond.count} events)`);
  }
  if (h.longestGap) {
    parts.push(`longest gap ${h.longestGap.ms}ms (t=${h.longestGap.fromMs}-${h.longestGap.toMs})`);
  }
  if (h.onceOnly) {
    parts.push(`only one ${h.onceOnly.kind} (t=${h.onceOnly.atMs})`);
  }
  return parts.length ? parts.join("; ") + "." : "";
}

/** `semantics_tree`'s node shape, loose — see `SemanticsNodeDto` (`protocol/Protocol.kt`) for the wire type this mirrors. */
export interface RawSemanticsNode {
  text?: string | null;
  contentDescription?: string | null;
  testTag?: string | null;
  truncated?: boolean;
  children?: RawSemanticsNode[] | null;
}

export interface SemanticsTreeStats {
  nodeCount: number;
  /** Neither `text` nor `contentDescription` — nothing an accessibility service, or this tool's own reader, can read off the node. */
  unlabelledCount: number;
  /** Carries a `testTag` — a porthole node id (or a plain test tag) that lines this node up with `recompositions`' own ids, per this tool's own description. */
  instrumentedCount: number;
  /** True when the walk hit a node whose own `truncated` flag says its children were cut by the budget — the signal `renderDetail`'s "full" estimate below is scaled from. */
  anyTruncated: boolean;
}

/** GRA-91: "node count, unlabelled count and instrumented-node coverage" — `semantics_tree`'s own contribution to `detail: "summary"`. */
export function semanticsTreeStats(root: unknown): SemanticsTreeStats {
  const stats: SemanticsTreeStats = {
    nodeCount: 0,
    unlabelledCount: 0,
    instrumentedCount: 0,
    anyTruncated: false,
  };
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as RawSemanticsNode;
    stats.nodeCount++;
    if (!n.text && !n.contentDescription) stats.unlabelledCount++;
    if (n.testTag) stats.instrumentedCount++;
    if (n.truncated) stats.anyTruncated = true;
    for (const child of n.children ?? []) walk(child);
  };
  walk(root);
  return stats;
}

export function describeSemanticsTreeStats(stats: SemanticsTreeStats): string {
  if (stats.nodeCount === 0) return "";
  const coverage = Math.round((stats.instrumentedCount / stats.nodeCount) * 100);
  return (
    `${stats.nodeCount} node(s), ${stats.unlabelledCount} unlabelled, ` +
    `${stats.instrumentedCount} instrumented (${coverage}% coverage).`
  );
}

/** `state`'s own field shape — see `StateField` (`protocol/Protocol.kt`) for the wire type this mirrors. */
export interface RawStateField {
  key?: string;
  kind?: string;
  attributable?: boolean;
}

export interface RawStateOwner {
  name?: string;
  /** `unknown[]`, not `RawStateField[]` — `state`'s own payload types this `unknown[]` too (the wire shape is the device's, not typed on this side), so callers can hand this function their raw dump without a cast of their own. */
  fields?: unknown[];
}

export interface UnattributableField {
  key: string;
  kind: string;
  /** The API that would make this field's writes attributable, in the same vocabulary this tool's own description already uses. */
  fix: string;
}

/** GRA-91: the API that would fix a field of this `kind` not being attributable — `StateCollector.kt`'s own `readFields` is what this mirrors: only `MutableState`/`DerivedState` are ever attributable. */
function fixFor(kind: string): string {
  switch (kind) {
    case "StateFlow":
    case "Flow":
      return "collectAsNamedState";
    case "plain":
      return "not a State or Flow at all — wrap it (rememberNamedState, or a mutableStateOf field the owner already registers) if you want its writes attributed";
    default:
      return "collectAsNamedState (a Flow/StateFlow) or rememberNamedState (state a composable owns)";
  }
}

/** GRA-91: "names each unattributable field and the API that would fix it" — `state`'s own contribution to `detail: "summary"`. */
export function unattributableStateFields(owners: readonly RawStateOwner[]): UnattributableField[] {
  const out: UnattributableField[] = [];
  for (const owner of owners) {
    for (const raw of owner.fields ?? []) {
      const field = raw as RawStateField;
      if (field.attributable === false && field.key) {
        out.push({ key: field.key, kind: field.kind ?? "unknown", fix: fixFor(field.kind ?? "") });
      }
    }
  }
  return out;
}

/** How many unattributable fields `describeUnattributableFields` names before saying "+N more" — same "cut list" convention `recompositions`'/`timeline`'s own truncation notes already use. */
const UNATTRIBUTABLE_LIST_CAP = 8;

export function describeUnattributableFields(fields: readonly UnattributableField[]): string {
  if (fields.length === 0) return "";
  const shown = fields.slice(0, UNATTRIBUTABLE_LIST_CAP);
  const rest = fields.length - shown.length;
  const named = shown.map((f) => `${f.key} (${f.kind} — ${f.fix})`).join("; ");
  return `Unattributable: ${named}${rest > 0 ? `; +${rest} more` : ""}.`;
}
