// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { DeviceEvent } from "./device.js";
import type { Finding } from "./trace.js";
import { num, str } from "./trace.js";

/**
 * GRA-60: what `findings` says about every `startup` event in the window —
 * not only the last one.
 *
 * QA (60-A) caught the original version reading `events` as if
 * `StartupCollector` only ever emitted one `startup` event per session: it
 * emits one per *launch*, so treating only the newest as real meant a slow
 * cold launch's own `startup-slow` — and its db-on-main/main-thread-stall
 * cross-reference — silently disappeared the moment the user backgrounded
 * and reopened the app. Every launch in the window is now judged on its
 * own, with its own window and its own cross-reference.
 *
 * Kept apart from `trace.ts`'s own `findingsOf` rather than folded into it —
 * that function's only change for this ticket is the one call into
 * `startupFindingsOf` made right before it sorts and returns, per the
 * ticket's own "keep changes localized" instruction (other branches touch
 * `trace.ts`, `index.ts` and `Protocol.kt` at the same time this one does).
 */

/**
 * Android vitals' own "excessive" cold-startup line — 5s
 * (https://developer.android.com/topic/performance/vitals/launch-time,
 * "Android vitals considers the following startup times for your app
 * excessive"). Used here rather than a number invented for this ticket
 * because it is the same line Play Console already judges a *release*
 * build's cold start against — even though, per the `findings` tool's own
 * description, this event is never a release build's timing and the number
 * should not be quoted as if it were.
 *
 * QA (60-C): vitals' own warm (2s) and hot (1.5s) lines are deliberately
 * *not* applied here. Both are measured from the launch request itself —
 * before the process even forks — the same instant `am start -W`'s
 * `TotalTime` starts from. A warm/hot `startup` event's own origin
 * (`originKind: "activity"`) is the relaunched Activity's own
 * `onCreate`/`onStart`, already inside the work the system did to bring the
 * app back — a materially shorter span, not merely a smaller number for the
 * same thing. Emulator evidence: the same relaunch reported `HOT TotalTime:
 * 207` from `am start -W` and `totalMs: 3` from this collector. Applying
 * vitals' 1500ms line to that 3ms figure would call it fast for the wrong
 * reason, and scaling the figure up to compensate would be inventing a
 * number this project has no basis for. See README's Startup section and
 * the `findings` tool description for the fuller explanation — both were
 * asked to say this too, not only this file's own comment.
 */
const COLD_SLOW_THRESHOLD_MS = 5_000;

/**
 * EM's own note on GRA-60: "keep the cross-reference of db-on-main and
 * main-thread findings inside the startup window: it is the cheapest and
 * most valuable bullet in the ticket." Scoped to exactly these two ids, not
 * every finding — a startup window is expected to contain other noise (a
 * `device` foreground event, a first `frame`) that is not the lead this
 * cross-reference exists to surface.
 */
const CROSS_REFERENCED_IDS = new Set(["db-on-main-thread", "main-thread-stall"]);

function overlaps(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/** One `startup` event's fields, loosely typed off the wire the same way every other event here is. */
interface LaunchData {
  classification: string;
  originKind: string;
  originMs: number;
  firstFrameMs: number | null;
  totalMs: number | null;
  dominantPhase: string | undefined;
  originAssumed: boolean;
  reportFullyDrawnMs: number | null;
}

function launchDataOf(event: DeviceEvent): LaunchData {
  const data = event.data;
  return {
    classification: str(data.classification, "cold"),
    // Absent on an event from before this field existed (a recorded session
    // predating QA's 60-C fix, say) reads as "fork" — the only kind that
    // ever existed before `originKind` was added, so this is a faithful
    // default, not a guess.
    originKind: data.originKind != null ? str(data.originKind) : "fork",
    originMs: num(data.originMs),
    firstFrameMs: data.firstFrameMs != null ? num(data.firstFrameMs) : null,
    totalMs: data.totalMs != null ? num(data.totalMs) : null,
    dominantPhase: data.dominantPhase != null ? str(data.dominantPhase) : undefined,
    originAssumed: data.originAssumed === true || data.originAssumed === "true",
    reportFullyDrawnMs: data.reportFullyDrawnMs != null ? num(data.reportFullyDrawnMs) : null,
  };
}

/**
 * `startup-slow` for exactly one launch, or `undefined` when this launch
 * does not cross the line — cold only (`originKind: "fork"`); see this
 * file's own top comment on [COLD_SLOW_THRESHOLD_MS] for why warm/hot get
 * no threshold here at all rather than a borrowed or invented one.
 */
function slowFindingFor(launch: LaunchData, otherFindings: Finding[]): Finding | undefined {
  if (launch.originKind !== "fork") return undefined;
  if (launch.totalMs == null || launch.firstFrameMs == null) return undefined;
  if (launch.totalMs <= COLD_SLOW_THRESHOLD_MS) return undefined;

  const window = { from: launch.originMs, to: launch.firstFrameMs };
  const inside = otherFindings.filter(
    (f) => CROSS_REFERENCED_IDS.has(f.id) && f.window && overlaps(f.window, window),
  );
  return {
    // Suffixed by this launch's own origin, the same shape `exit-${timestamp}`
    // already uses (trace.ts) for a finding kind that can legitimately occur
    // more than once in a window — without it, two slow launches in the same
    // window would collide on one id, and GRA-55's classify() (index.ts),
    // which tracks findings by id across polling calls, would read the
    // second one as "the first one, still ongoing" rather than a new launch.
    id: `startup-slow-${launch.originMs}`,
    severity: "warning",
    confidence: "observed",
    title:
      `${launch.classification} startup took ${launch.totalMs}ms` +
      (launch.dominantPhase ? ` — worst gap ${launch.dominantPhase}` : ""),
    detail:
      `Android vitals calls a cold startup "excessive" past ${COLD_SLOW_THRESHOLD_MS}ms.` +
      (inside.length > 0 ? ` Inside this window: ${inside.map((f) => f.title).join("; ")}.` : ""),
    count: 1,
    evidence: {
      classification: launch.classification,
      originKind: launch.originKind,
      totalMs: launch.totalMs,
      dominantPhase: launch.dominantPhase,
      originAssumed: launch.originAssumed,
      crossReferenced: inside.map((f) => f.id),
    },
    window,
  };
}

/**
 * `startup-not-fully-drawn` for exactly one launch, or `undefined`.
 *
 * QA (60-B): judged against the **cold** launch only. A warm/hot launch's
 * own event is closed by its ending frame, not a timer — there is no grace
 * window in which "has not reported yet" and "never reports" could be told
 * apart the way the cold launch's own grace window (`StartupCollector`)
 * allows. Restricting this note to cold is also what stops it from firing
 * for a relaunch whenever `startupFindingsOf` now evaluates every launch in
 * the window (60-A) rather than only the last one — an app that reported on
 * its cold launch and then, minutes later, the user reopened it, must not
 * be told it "never reported itself fully drawn" just because that later,
 * fast relaunch's own event has nothing in its `reportFullyDrawnMs` field.
 */
function notFullyDrawnFindingFor(launch: LaunchData): Finding | undefined {
  if (launch.classification !== "cold") return undefined;
  if (launch.firstFrameMs == null || launch.reportFullyDrawnMs != null) return undefined;
  return {
    id: "startup-not-fully-drawn",
    severity: "note",
    confidence: "observed",
    title: "the app never reported itself fully drawn",
    detail:
      "Call `Activity.reportFullyDrawn()` — the standard Android API — once everything on screen " +
      "is actually ready, not just the first frame. In a Compose app, or any app whose Activity " +
      "extends androidx.activity.ComponentActivity, that call alone is already enough: this " +
      "collector hooks ComponentActivity's own fullyDrawnReporter automatically, no other app " +
      "code needed. `Porthole.reportFullyDrawn()` is the documented fallback for an Activity that " +
      "is not one — see that function's own doc comment.",
    window: { from: launch.firstFrameMs, to: launch.firstFrameMs },
  };
}

/**
 * `findingsOf`'s own findings, already computed from the same `events` —
 * `db-on-main-thread` and `main-thread-stall` each already carry a `window`
 * by the time this is called, so the cross-reference is a plain overlap
 * check against those, not a second pass over the raw event stream.
 */
export function startupFindingsOf(events: DeviceEvent[], otherFindings: Finding[]): Finding[] {
  const findings: Finding[] = [];
  for (const event of events) {
    if (event.event !== "startup") continue;
    const launch = launchDataOf(event);
    const slow = slowFindingFor(launch, otherFindings);
    if (slow) findings.push(slow);
    const note = notFullyDrawnFindingFor(launch);
    if (note) findings.push(note);
  }
  return findings;
}
