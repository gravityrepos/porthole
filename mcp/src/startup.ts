// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { DeviceEvent } from "./device.js";
import type { Finding } from "./trace.js";
import { num, str } from "./trace.js";

/**
 * GRA-60: what `findings` says about a `startup` event.
 *
 * Kept apart from `trace.ts`'s own `findingsOf` rather than folded into it —
 * that function's only change for this ticket is the one call into
 * `startupFindingsOf` made right before it sorts and returns, per the
 * ticket's own "keep changes localized" instruction (other branches touch
 * `trace.ts`, `index.ts` and `Protocol.kt` at the same time this one does).
 */

/**
 * Android vitals' own "excessive" startup-time lines — cold 5s, warm 2s, hot
 * 1.5s (https://developer.android.com/topic/performance/vitals/launch-time,
 * "Android vitals considers the following startup times for your app
 * excessive"). Used here rather than a number invented for this ticket
 * because it is the same line Play Console already judges a *release* build
 * against — even though, per the `findings` tool's own description, this
 * event is never a release build's timing and the number should not be
 * quoted as if it were.
 */
const STARTUP_SLOW_THRESHOLD_MS: Record<string, number> = {
  cold: 5_000,
  warm: 2_000,
  hot: 1_500,
};

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

/**
 * `findingsOf`'s own findings, already computed from the same `events` —
 * `db-on-main-thread` and `main-thread-stall` each already carry a `window`
 * by the time this is called, so the cross-reference is a plain overlap
 * check against those, not a second pass over the raw event stream.
 */
export function startupFindingsOf(events: DeviceEvent[], otherFindings: Finding[]): Finding[] {
  const startups = events.filter((e) => e.event === "startup");
  if (startups.length === 0) return [];
  // At most one is ever expected per session; the latest wins on the off
  // chance a disk-session merge produced more than one in a window.
  const startup = startups[startups.length - 1];
  const data = startup.data;

  const classification = str(data.classification, "cold");
  const originMs = num(data.originMs);
  const firstFrameMs = data.firstFrameMs != null ? num(data.firstFrameMs) : null;
  const totalMs = data.totalMs != null ? num(data.totalMs) : null;
  const dominantPhase = data.dominantPhase != null ? str(data.dominantPhase) : undefined;
  const originAssumed = data.originAssumed === true || data.originAssumed === "true";
  const reportFullyDrawnMs = data.reportFullyDrawnMs != null ? num(data.reportFullyDrawnMs) : null;

  const findings: Finding[] = [];

  if (totalMs != null && firstFrameMs != null) {
    const threshold = STARTUP_SLOW_THRESHOLD_MS[classification] ?? STARTUP_SLOW_THRESHOLD_MS.cold;
    if (totalMs > threshold) {
      const window = { from: originMs, to: firstFrameMs };
      const inside = otherFindings.filter(
        (f) => CROSS_REFERENCED_IDS.has(f.id) && f.window && overlaps(f.window, window),
      );
      findings.push({
        id: "startup-slow",
        severity: "warning",
        confidence: "observed",
        title:
          `${classification} startup took ${totalMs}ms` +
          (dominantPhase ? ` — worst gap ${dominantPhase}` : ""),
        detail:
          `Android vitals calls a ${classification} startup "excessive" past ${threshold}ms.` +
          (inside.length > 0 ? ` Inside this window: ${inside.map((f) => f.title).join("; ")}.` : ""),
        count: 1,
        evidence: {
          classification,
          totalMs,
          dominantPhase,
          originAssumed,
          crossReferenced: inside.map((f) => f.id),
        },
        window,
      });
    }
  }

  if (firstFrameMs != null && reportFullyDrawnMs == null) {
    findings.push({
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
      window: { from: firstFrameMs, to: firstFrameMs },
    });
  }

  return findings;
}
