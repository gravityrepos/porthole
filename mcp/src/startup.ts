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

/**
 * GRA-231: does the trace's own `trace-startup` finding — Perfetto's
 * `android.startup.startups`/`startup_breakdowns` modules, via the
 * `startup` question (`ask_system_trace`, interpret() in perfetto.ts) —
 * agree with `StartupCollector`'s own `startup` event for the same launch?
 *
 * The two exist side by side today without knowing about each other — see
 * the "GRA-60 hook" comment above `interpret()`'s own `trace-startup` block
 * in perfetto.ts, which names exactly this function's job as the thing left
 * undone. `ask_system_trace` (index.ts) already has both by the time it
 * would call this: `askTrace`'s findings, already converted onto this
 * session's uptime clock (`toUptimeMs`), and `timeline.buffer()`, the same
 * session's own device events, on that same clock by construction. Nothing
 * here reaches for a device or a trace file itself, which is what makes it
 * cheap to rig-test with hand-built fixtures instead of a live capture —
 * the same split `startupFindingsOf` above makes.
 *
 * A `trace-startup` finding whose window overlaps a runtime `startup`
 * event's own `[originMs, firstFrameMs]` span (the same session, the
 * *only* session a caller's `timeline.buffer()` can ever hand this) gets
 * that launch's phases attached to `evidence.runtimePhases`, plus
 * `evidence.runtimeTotalMs`/`runtimeOriginKind`/`gapMs`. A `trace-startup`
 * finding with no matching runtime event, or a runtime `startup` event with
 * no matching trace window, is left exactly as it arrived — this function
 * only ever adds evidence or an extra note, never removes or overwrites a
 * finding either side already produced on its own.
 *
 * README's Startup section spells out the structural gap this is
 * reconciling: the trace times a launch from the launch request itself —
 * before the process even forks — while Porthole times from the fork
 * (cold) or the relaunched Activity's own first lifecycle callback
 * (warm/hot), always a later instant. So `gapMs` (trace total minus runtime
 * total) is expected to be positive — that gap *is* the process-creation
 * and window-setup work neither side can see — and a `note` finding fires
 * only when the two numbers say something that gap cannot explain: `gapMs`
 * negative (the runtime claims *more* time than the trace, which the later
 * origin makes impossible for the same launch), or `gapMs` past
 * [RECONCILIATION_GAP_BOUND_MS].
 */
export function reconcileStartupWithTrace(findings: Finding[], events: DeviceEvent[]): Finding[] {
  const launches = events
    .filter((event) => event.event === "startup")
    .map((event) => ({ event, launch: launchDataOf(event) }))
    .filter(
      (entry): entry is { event: DeviceEvent; launch: LaunchData & { firstFrameMs: number; totalMs: number } } =>
        entry.launch.firstFrameMs != null && entry.launch.totalMs != null,
    );
  // Nothing to reconcile against — every `trace-startup` finding passes
  // through unchanged, per this function's own "no change when the other
  // side is absent" contract.
  if (launches.length === 0) return findings;

  const reconciled: Finding[] = [];
  const notes: Finding[] = [];

  for (const finding of findings) {
    if (finding.id !== "trace-startup" || !finding.window) {
      reconciled.push(finding);
      continue;
    }
    const window = finding.window;
    const match = launches.find(({ launch }) => overlaps(window, { from: launch.originMs, to: launch.firstFrameMs }));
    if (!match) {
      reconciled.push(finding);
      continue;
    }

    const { event, launch } = match;
    const traceDurMs = num((finding.evidence ?? {}).durMs);
    const gapMs = traceDurMs - launch.totalMs;

    reconciled.push({
      ...finding,
      evidence: {
        ...finding.evidence,
        runtimeTotalMs: launch.totalMs,
        runtimeOriginKind: launch.originKind,
        runtimePhases: phasesOf(event, launch.originKind),
        gapMs,
      },
    });

    if (gapMs < 0 || gapMs > RECONCILIATION_GAP_BOUND_MS) {
      notes.push({
        // Suffixed by the launch's own origin, the same collision-avoidance
        // `startup-slow-${originMs}` already relies on (this file, above):
        // more than one launch in the window must not collapse onto one id.
        id: `startup-reconciliation-${launch.originMs}`,
        severity: "note",
        confidence: "observed",
        title:
          gapMs < 0
            ? `trace and runtime disagree on startup timing: trace ${traceDurMs}ms is shorter than the runtime's own ${launch.totalMs}ms`
            : `trace and runtime startup totals are ${gapMs}ms apart — wider than expected`,
        detail:
          gapMs < 0
            ? "The trace times a launch from the launch request itself, before the process even " +
              "forks; Porthole times from the fork (cold) or the relaunched Activity's own first " +
              "callback (warm/hot) — always a later instant, so the trace's own total should never " +
              "come out shorter than the runtime's. Either these are not the same launch, or one of " +
              "the two numbers is simply wrong — this does not pick which."
            : `Some of this gap is structural — the trace starts timing before ${launch.originKind === "fork" ? "the fork" : "the relaunched Activity's own first callback"}, Porthole after it (see README's Startup section) — but ${gapMs}ms alone is past the ${RECONCILIATION_GAP_BOUND_MS}ms Android vitals itself calls an excessive cold start, more than ordinary process-creation overhead accounts for.`,
        count: 1,
        evidence: {
          traceDurMs,
          runtimeTotalMs: launch.totalMs,
          gapMs,
          originKind: launch.originKind,
        },
        window,
      });
    }
  }

  return [...reconciled, ...notes];
}

/**
 * How far past [COLD_SLOW_THRESHOLD_MS] `gapMs` (trace total minus runtime
 * total) may run before [reconcileStartupWithTrace] calls it implausible
 * rather than structural. Reuses that same constant rather than inventing a
 * second number: the portion of a launch that happens before Porthole's own
 * origin — zygote fork, `ActivityThread`, window setup — is real OS work,
 * but if it alone outweighs the entire budget Android vitals considers
 * acceptable for a whole cold start, the gap has stopped being "process
 * creation overhead" and become a second thing wrong that neither side's
 * own number, read alone, could show.
 */
const RECONCILIATION_GAP_BOUND_MS = COLD_SLOW_THRESHOLD_MS;

/**
 * The runtime event's own phases, oldest first — what
 * [reconcileStartupWithTrace] attaches to `evidence.runtimePhases`. Reads
 * straight off the event's wire fields rather than [LaunchData] (which only
 * carries what the rest of this file needs): the intermediate phases —
 * `onCreateEntry`/`onCreateExit`/the three activity lifecycle callbacks —
 * exist only on the wire today, and widening `LaunchData` for one caller
 * would make every other reader of it carry fields it never asked for.
 */
function phasesOf(event: DeviceEvent, originKind: string): Array<{ name: string; atMs: number }> {
  const data = event.data;
  const entries: Array<[string, unknown]> = [
    [originKind === "fork" ? "fork" : "activityOrigin", data.originMs],
    ["onCreateEntry", data.onCreateEntryMs],
    ["onCreateExit", data.onCreateExitMs],
    ["activityOnCreate", data.activityOnCreateMs],
    ["activityOnStart", data.activityOnStartMs],
    ["activityOnResume", data.activityOnResumeMs],
    ["firstFrame", data.firstFrameMs],
    ["reportFullyDrawn", data.reportFullyDrawnMs],
  ];
  return entries.filter(([, v]) => v != null).map(([name, v]) => ({ name, atMs: num(v) }));
}
