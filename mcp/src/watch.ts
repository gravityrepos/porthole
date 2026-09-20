// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveProjectRoot } from "./adb.js";
import { requiredValue, parsePort, type ParseError } from "./args.js";
import { DeviceClient, type ConnectionState, type DeviceEvent, type Hello } from "./device.js";
import { sessionDirName, sessionIdentity, sessionsEnabled, sessionsRoot } from "./sessions.js";
import { findingsOf, resolveProfile, type Finding, type Severity, type Trace } from "./trace.js";
import { Watermark } from "./watermark.js";

/**
 * GRA-56: a blocking watch, for a harness that can watch a process instead
 * of a person watching a chat window.
 *
 * MCP has no push (watermark.ts's own module comment says so at length) and
 * an MCP server cannot run background work of its own — the ticket forbids
 * it, on purpose: whatever notices a problem has to be a process an agent's
 * harness can itself supervise, the way Claude Code supervises a background
 * bash task or a hook. So this is not a tool call — it is `capture.ts`'s
 * shape (a client that owns its own socket connection, independent of
 * whatever MCP server process may also be attached) turned around: instead
 * of recording a fixed window and exiting, it blocks, watches forever (or
 * until `--until-first`/`--timeout` says otherwise), and prints one line the
 * instant something crosses the severity threshold.
 *
 * **Sharing the device.** `PortholeSocketServer` already serves several
 * simultaneous clients — the timeline, an MCP server, this — each getting
 * its own copy of every event (see `testing/harness.ts`'s `FakeDevice`,
 * which broadcasts to every connected socket the same way). `watch` is just
 * one more `DeviceClient`, proven safe to run beside a real MCP server rig
 * in `watch.test.ts`.
 *
 * **Sharing the watermark (the actual open question).** `watermark.ts`
 * tracks `lastReportedErrorT` per session directory, on disk at
 * `<session dir>/watermark.json`, so an MCP server restart does not forget
 * what it already told an agent about. A `watch` running alongside a live
 * agent session must not repeat what the agent's own banner already
 * surfaced, or make the agent's next banner repeat what `watch` already
 * printed to the harness. The decision: **`watch` opens the exact same
 * `Watermark` (same session directory, keyed by `hello`'s identity exactly
 * as `sessions.ts` computes it) and reads/advances the very same
 * `lastReportedErrorT` field the MCP surface's banner uses** — not a
 * parallel one of its own. This is the same sharing `sessions.ts`'s own
 * `SessionWriter.open()` doc comment already describes for two MCP servers
 * attached to one app ("both would write the same file... this reads it
 * back rather than overwriting it"); `watch` is simply a second such writer,
 * of the watermark rather than the event log.
 *
 * Deliberately scoped to `error` severity only, matching the field's own
 * name and what the MCP banner already means by it. `--severity warning` or
 * `--severity note` still watch for those findings, but dedupes them only
 * within this one process's own run (a local `Map`, not the shared file):
 * there is no `lastReportedWarningT` field for a second client to
 * misinterpret, and inventing one here — in a ticket that owns `watch.ts`
 * alone — is exactly the kind of change GRA-55's own module owns, not this
 * one. A watch and an agent both running at `note` severity might each
 * mention the same low-priority finding once; both agree, to the millisecond,
 * about every `error`.
 *
 * **The mark records "newest event examined," matching `errorBanner()`
 * exactly — not a per-finding anchor (GRA-56 QA, W2).** An earlier version
 * of this file advanced `lastReportedErrorT` to the *finding's own*
 * `window.to` instead, reasoning that a narrower advance could only ever
 * leave a later banner re-scanning a harmless already-quiet span. That
 * reasoning missed that several error findings pin `window` to one *fixed*
 * contributing event rather than the newest — `findingsOf` (trace.ts)
 * anchors `http-failed` to the *first* failed call and `main-thread-stall`/
 * `db-on-main-thread` to the *worst* one so far, so a second, distinct, but
 * less severe occurrence raises `count` without moving `window` at all. The
 * shared mark, already advanced past that fixed window by the first print,
 * then silently swallowed every occurrence after it — a `watch` left
 * running went permanently quiet after one HTTP failure. Anchoring on
 * `newest` (the latest event this evaluation has actually looked at) and
 * advancing it every time this process looks — whether or not it found
 * anything, exactly like `errorBanner()` — fixes that: the question the
 * mark answers is "has anyone examined the stream up to here," which does
 * not depend on which finding's own window happened to move.
 *
 * **Not full mutual exclusion.** `watermark.ts`'s own module comment (W1)
 * says this precisely: refresh-then-decide-then-write is three steps, not
 * one atomic operation, so a `watch` and the MCP surface's banner that both
 * make that decision inside the same ~200ms poll interval can still both
 * report the same error once. Neither repeats it afterward, once each has
 * seen the other's write.
 */

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

const SEVERITY_VALUES = ["error", "warning", "note"] as const;

/** Lower ranks first, same as `trace.ts`'s own `findings.sort` — `error` is worst. */
const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, note: 2 };

/**
 * GRA-56 QA (F25): the two `findingsOf` (trace.ts) ids whose `count` is a
 * running tally over one continuous, still-open window rather than a
 * count of discrete occurrences. `frames-dropped` sums `missedFrames`
 * across every `frame` event in view; `recompose-hotspot` sums a
 * component's own recompositions — both climb roughly every tick for as
 * long as the episode (jank, a recomposition storm) keeps going, and the
 * plain "count grew since last print" rule every other finding uses would
 * print a fresh line on essentially every 200ms tick: QA measured one
 * jank episode producing 17 lines, counts walking 32 -> 209, "about a line
 * a second for as long as the jank lasts" — a flood for a `--json` hook to
 * parse, not a list of seventeen separate problems.
 *
 * Point findings — a stall, a failed call, a query on the main thread —
 * are the opposite on purpose and are unaffected: `findingsOf` anchors
 * each of those on one specific contributing event (the worst stall, the
 * first failure), so "count grew" means a genuinely new, distinct
 * occurrence happened, and every one of those still gets its own line
 * (see the W2 fix above `runWatch`'s own module comment).
 */
const AGGREGATE_FINDING_IDS = new Set(["frames-dropped", "recompose-hotspot"]);

/**
 * The throttle F25 asks to pick one of two shapes for ("re-print at most
 * once per 10s per finding id, or when the count at least doubles") —
 * decided as the time-based one: simpler to reason about and to test
 * deterministically, and it is the shape QA's own report already measures
 * against ("about a line a second... at most once per 10s"). On the
 * device uptime clock every window and every printed line already speaks
 * in, not wall-clock time, so a synthetic history (a test, or a session
 * replayed faster than it was recorded) throttles correctly too.
 */
const AGGREGATE_REPRINT_MS = 10_000;

export interface WatchOptions {
  port: number;
  serial?: string;
  severity: Severity;
  untilFirst: boolean;
  json: boolean;
  /** Milliseconds. `undefined` means "no timeout — run until SIGINT or (with --until-first) a finding." */
  timeoutMs?: number;
  forward: boolean;
  /** GRA-199: see `devices.ts`'s `forwardTarget`. Defaults to `PORTHOLE_APPLICATION_ID`. */
  applicationId?: string;
  /** GRA-199: see `devices.ts`'s `forwardTarget`. Defaults to `PORTHOLE_LEGACY_TCP_PORT` being set. */
  legacyTcpPort: boolean;
}

export const WATCH_USAGE = `
porthole watch — block until something breaks, and say so

  porthole watch [options]

  --severity <level>     error (default), warning, or note — report at or above this
  --until-first           exit the instant a qualifying finding appears
  --json                  one finding object per line on stdout; diagnostics go to stderr
  --timeout <seconds>     give up after this long (exit 3) instead of waiting forever
  --port <n>              host port the forward listens on, not a port the device opens (default 8677)
  --serial <id>           adb device serial, when more than one is attached
  --application-id <id>   the app the abstract socket is named for (default PORTHOLE_APPLICATION_ID)
  --legacy-tcp-port       forward to the old shared TCP port instead (default PORTHOLE_LEGACY_TCP_PORT)
  --no-forward            skip 'adb forward'; use it if the bridge is already up

Connects like any other client — its own socket to the device, independent of
whatever MCP server may also be attached — and streams findings as they occur,
one line each. Never exits merely because the app disconnects: it waits and
reconnects on its own, the same as 'porthole ui'.

GRA-199: the device side listens on an abstract socket named for the app
(localabstract:porthole.<applicationId>), not a shared TCP port — --port is
the *host* port adb forwards to it. Without --application-id (or
PORTHOLE_APPLICATION_ID) and without --legacy-tcp-port (or
PORTHOLE_LEGACY_TCP_PORT), --forward refuses rather than guessing a socket
name; pass --no-forward if the bridge is already up some other way.

A stall, a failed call, a query on the main thread — each occurrence gets
its own line. frames-dropped and recompose-hotspot are different: their
count is a running tally over one still-open episode, not a count of
discrete events, so while one is ongoing this reprints at most once every
10 seconds rather than on every tick.

Exit codes:
  0   clean stop (SIGINT)
  1   a qualifying finding was found (--until-first only)
  2   bad arguments, or an internal error stopped the watch
  3   --timeout elapsed with nothing (yet) to report
`;

function parseTimeoutSeconds(raw: string | undefined, option: string): number | ParseError {
  if (raw === undefined || raw === "") return { message: `${option} needs a number of seconds` };
  if (!/^\d+$/.test(raw)) {
    return { message: `${option} ${JSON.stringify(raw)} is not a whole number of seconds` };
  }
  const value = Number(raw);
  if (value <= 0) return { message: `${option} ${raw} must be positive` };
  return value * 1000;
}

/**
 * Same discipline as `parseCapture`/`parseSave`/`parse()`: every value goes
 * through a validator that names the option and refuses rather than
 * silently accepting garbage, and every refusal is `process.exit(2)` so a
 * test driving this loop (not just the pure validators) catches a refusal
 * that got swallowed.
 */
export function parseWatch(argv: string[]): WatchOptions {
  const options: WatchOptions = {
    port: 8677,
    severity: "error",
    untilFirst: false,
    json: false,
    forward: true,
    applicationId: process.env.PORTHOLE_APPLICATION_ID || undefined,
    legacyTcpPort: Boolean(process.env.PORTHOLE_LEGACY_TCP_PORT),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--severity") {
      const value = requiredValue(argv[++i], "--severity");
      if (typeof value !== "string") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      if (!(SEVERITY_VALUES as readonly string[]).includes(value)) {
        process.stderr.write(
          `--severity must be one of: ${SEVERITY_VALUES.join(", ")} (got ${JSON.stringify(value)})\n`,
        );
        process.exit(2);
      }
      options.severity = value as Severity;
    } else if (arg === "--until-first") {
      options.untilFirst = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--timeout") {
      const value = parseTimeoutSeconds(argv[++i], "--timeout");
      if (typeof value !== "number") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.timeoutMs = value;
    } else if (arg === "--port") {
      const value = parsePort(argv[++i], "--port");
      if (typeof value !== "number") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.port = value;
    } else if (arg === "--serial") {
      const value = requiredValue(argv[++i], "--serial");
      if (typeof value !== "string") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.serial = value;
    } else if (arg === "--application-id") {
      const value = requiredValue(argv[++i], "--application-id");
      if (typeof value !== "string") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.applicationId = value;
    } else if (arg === "--legacy-tcp-port") {
      options.legacyTcpPort = true;
    } else if (arg === "--no-forward") {
      options.forward = false;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(WATCH_USAGE);
      process.exit(0);
    } else {
      process.stderr.write(`unknown option: ${arg}\n${WATCH_USAGE}`);
      process.exit(2);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// exit codes
// ---------------------------------------------------------------------------

/**
 * Decided (GRA-56 open question 3), and pinned by `watch.test.ts`:
 *   0 — clean stop (SIGINT)
 *   1 — `--until-first` found a qualifying finding
 *   2 — bad arguments (`parseWatch` above), so nothing ever connects; or
 *       `evaluate()` itself threw (GRA-56 QA, W3) — an internal defect, not
 *       a finding, so it must never read as WATCH_EXIT.FOUND to a hook
 *       checking `$?`
 *   3 — `--timeout` elapsed before 1 or 0 happened
 * A disconnect is never in this list on purpose: `DeviceClient` reconnects
 * on its own, and `watch` treats that exactly as `porthole ui` does — a
 * state to report on stderr, not a reason to stop.
 */
export const WATCH_EXIT = {
  CLEAN_STOP: 0,
  FOUND: 1,
  BAD_ARGS: 2,
  TIMEOUT: 3,
} as const;

// ---------------------------------------------------------------------------
// formatting one line
// ---------------------------------------------------------------------------

const SEVERITY_LABEL: Record<Severity, string> = { error: "ERROR", warning: "WARNING", note: "NOTE" };

/** The window text every printed line carries (AC: "carries the window so the agent quotes it"). `fallbackT` is the newest event examined, used only for a `spanning` finding, which has no `from`/`to` of its own to print (see `trace.ts`'s own comment on why exit findings are `spanning`). */
function windowText(finding: Finding, fallbackT: number): string {
  if (finding.window) return `t=${finding.window.from}..${finding.window.to}`;
  if (finding.spanning) return `t=${fallbackT} (spanning — see detail)`;
  return `t=${fallbackT}`;
}

/**
 * One line, human-readable: `SEVERITY  title  t=from..to  detail's first
 * line  where=path:line`. Every segment after the severity is optional and
 * omitted rather than left blank — a `detail`-less finding (most `warning`s)
 * does not get a trailing double space for a segment that has nothing to say.
 * `detail` is truncated to its first line: some (`strict_violation`) carry a
 * short stack, and this prints one line per finding, not one per frame.
 */
function formatLine(finding: Finding, fallbackT: number): string {
  const parts = [SEVERITY_LABEL[finding.severity], finding.title, windowText(finding, fallbackT)];
  const detailLine = finding.detail?.split("\n")[0];
  if (detailLine) parts.push(detailLine);
  // GRA-201: appended, not substituted for `detail` — `detail` is often
  // already the raw stack frame text; `where` is the resolved project-
  // relative path an agent can actually open, when PORTHOLE_PROJECT_ROOT is
  // set and resolution succeeded. Absent (not `resolved: false`) otherwise,
  // same as everywhere else `where` is optional. GRA-205: `line` is never
  // optional on a resolved `where`, so this is always a breakpoint address.
  if (finding.where?.resolved) {
    parts.push(`where=${finding.where.path}:${finding.where.line}`);
  }
  return parts.join("  ");
}

// ---------------------------------------------------------------------------
// bounded history — GRA-56 QA, W3
// ---------------------------------------------------------------------------

/**
 * How much history `evaluate()` keeps. A watch left running for hours must
 * not grow its own event buffer, or the cost of recomputing findings over
 * it, without bound — QA measured 14ms/tick at 1 hour of unbounded growth
 * and 107ms/tick, 189MB, at 10 hours, and `findingsOf`'s own `eventWindow`
 * (trace.ts) throws a `RangeError` somewhere past ~110k accumulated events
 * regardless of the recompute cost, from spreading a whole lane's
 * timestamps into `Math.min`/`Math.max` (fixed separately, but a buffer
 * this large is also simply more than a live watch has any use for).
 *
 * 10 minutes: `findingsOf` needs an occurrence's `_start` event still in
 * view to report it as a hang at all (`stillOpenFinding`, trace.ts) — the
 * reason this file keeps full history within its window rather than
 * `errorBanner()`'s own newest-slice-only delta — and nothing this project
 * calls a stall, a blocking GC, or a hung call is worth still narrating ten
 * minutes after the fact on a *live* watch; `porthole save`/`porthole
 * report` exist for a longer look back after something happened.
 */
export const WATCH_EVENT_WINDOW_MS = 10 * 60_000;

/**
 * Drops events older than `windowMs` before `newest`, in place — a
 * `splice`, not a rebuild, since `evaluate()` calls this every tick and a
 * fresh array every 200ms is its own avoidable churn. Exported so
 * `watch.test.ts` can pin the bound directly and fast, rather than only
 * reachable by pushing hours of real events through a real `runWatch()`.
 */
export function trimEventWindow(
  events: DeviceEvent[],
  newest: number,
  windowMs: number = WATCH_EVENT_WINDOW_MS,
): void {
  const cutoff = newest - windowMs;
  let dropTo = 0;
  while (dropTo < events.length && events[dropTo].t < cutoff) dropTo++;
  if (dropTo > 0) events.splice(0, dropTo);
}

// ---------------------------------------------------------------------------
// the watch itself
// ---------------------------------------------------------------------------

/**
 * Runs until `finish()` — internal to this function — resolves it: a
 * qualifying finding under `--until-first`, `--timeout`, or `signal`
 * aborting (SIGINT, wired by the CLI dispatch in cli.ts). Exported
 * separately from the CLI dispatch so a test can await it directly against
 * a fake device, the same split `capture()`/`cli.ts`'s capture dispatch
 * already uses.
 */
export async function runWatch(options: WatchOptions, signal?: AbortSignal): Promise<number> {
  const device = new DeviceClient("127.0.0.1", options.port);

  const events: DeviceEvent[] = [];
  /** Local, per-process dedup across every severity this run cares about: id -> highest `count` already printed. Reset whenever the device's identity changes (a genuinely new process, not a transient reconnect) — see the "hello" listener below. */
  const reported = new Map<string, number>();
  /** GRA-56 QA (F25): id -> the `t` (device uptime) an `AGGREGATE_FINDING_IDS` member was last actually printed at — checked against `AGGREGATE_REPRINT_MS` before a reprint, updated only when a print actually happens (never on a throttled skip, so a growing count still gets picked up the moment the window opens rather than needing its own further growth to be noticed). Reset alongside `reported` on a new identity. */
  const lastAggregatePrintAt = new Map<string, number>();

  const watermark = new Watermark();
  /** `undefined` — not yet resolved for the current identity. `null` — resolved, and there is nowhere to persist to (sessions off, or the directory could not be created): the shared watermark degrades to in-memory-only, same as `Watermark` itself already does for a null directory. */
  let watermarkDir: string | null | undefined;
  let identityKey: string | null = null;

  let settled = false;
  let resolveOutcome!: (code: number) => void;
  const outcome = new Promise<number>((resolve) => {
    resolveOutcome = resolve;
  });

  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  function finish(code: number): void {
    if (settled) return;
    settled = true;
    if (tickTimer) clearInterval(tickTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    device.stop();
    resolveOutcome(code);
  }

  // GRA-163's own precedent: a new *identity* clears state; a mere
  // reconnect (the same process, the socket dropped and came back) does
  // not. `events`/`reported` are this process's counterpart to the ring
  // `timeline.ts` clears on a new hello; `watermarkDir` is invalidated so
  // the next error-severity finding re-resolves it under the new session.
  device.on("hello", (hello: Hello) => {
    const key = `${hello.packageName}::${hello.deviceId ?? ""}::${hello.startedAt}`;
    if (key === identityKey) return;
    identityKey = key;
    events.length = 0;
    reported.clear();
    lastAggregatePrintAt.clear();
    watermarkDir = undefined;
  });

  device.on("state", (state: ConnectionState) => {
    // Diagnostics only, and only to stderr — an agent's hook may be parsing
    // stdout with `jq` (`--json`'s own AC: "no preamble on stdout"), and a
    // human tailing the human-readable form still wants to know the socket
    // is alive without that being mistaken for a finding. `finish()`'s own
    // `device.stop()` fires a final "disconnected" transition synchronously
    // on the way out; without this guard every clean stop would print a
    // trailing "waiting for the app..." after the exit code was already
    // decided, which is a fact about shutting the socket down, not about
    // the app.
    if (settled) return;
    switch (state) {
      case "connecting":
        break;
      case "handshaking":
        process.stderr.write("connected, waiting on the app's first check-in...\n");
        break;
      case "connected": {
        const hello = device.hello as NonNullable<typeof device.hello>;
        process.stderr.write(`connected to ${hello.packageName} on ${hello.device}\n`);
        break;
      }
      case "disconnected":
        // Never a reason to stop — see this file's own module comment and
        // WATCH_EXIT's. DeviceClient is already retrying on its own backoff.
        process.stderr.write("waiting for the app...\n");
        break;
      default: {
        const exhaustive: never = state;
        throw new Error(`porthole watch: unhandled ConnectionState '${exhaustive as string}'`);
      }
    }
  });

  function severityQualifies(severity: Severity): boolean {
    return SEVERITY_RANK[severity] <= SEVERITY_RANK[options.severity];
  }

  /** Resolves (once per identity) where this session's watermark lives, and points `watermark` at it. A best-effort `mkdir`: a directory that does not exist yet (no MCP server has ever written this session) is created here so `Watermark.persist()` — which does not mkdir itself — has somewhere to write. */
  async function ensureWatermark(): Promise<void> {
    if (watermarkDir !== undefined) return;
    const hello = device.hello;
    if (!hello || !sessionsEnabled()) {
      watermarkDir = null;
      await watermark.open(null);
      return;
    }
    try {
      const root = sessionsRoot(resolveProjectRoot().directory);
      const dir = path.join(root, sessionDirName(sessionIdentity(hello)));
      await mkdir(dir, { recursive: true });
      watermarkDir = dir;
    } catch {
      // Best-effort, same shape as watermark.ts's own loadState(): nowhere
      // to persist is not a reason to stop watching, only to stop sharing.
      watermarkDir = null;
    }
    await watermark.open(watermarkDir);
  }

  function printFinding(finding: Finding): void {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(finding)}\n`);
    } else {
      const newest = events.length > 0 ? events[events.length - 1].t : 0;
      process.stdout.write(`${formatLine(finding, newest)}\n`);
    }
  }

  let dirty = false;
  let evaluating = false;

  /**
   * Recomputes findings over the retained history (bounded — see
   * `WATCH_EVENT_WINDOW_MS`/`trimEventWindow` above, GRA-56 QA W3) and
   * prints whatever is new. Full-history *within that window*, not
   * `errorBanner()`'s newest-slice-only delta — a "still open" finding (the
   * hung call `--until-first` most wants to catch) is only visible when its
   * `_start` event is still in view; windowing to just the newest slice
   * would silently stop reporting a hang that started before the window
   * opened. Throttled to the tick interval below rather than run inline per
   * event, so a burst of events costs one recompute, not one per event.
   */
  async function evaluate(): Promise<void> {
    if (settled || evaluating || !dirty) return;
    evaluating = true;
    dirty = false;
    try {
      if (events.length === 0) return;
      const newest = events[events.length - 1].t;
      trimEventWindow(events, newest);
      const marks: Trace["marks"] = events
        .filter((e) => e.event === "mark")
        .map((e) => ({ at: e.t, label: String(e.data.label ?? ""), detail: e.data.detail ? String(e.data.detail) : undefined }));
      const profile = resolveProfile({
        liveEvents: events,
        windowTo: newest,
        sessionProfile: null,
        hello: device.hello as unknown as Record<string, unknown> | null,
      });
      const findings = findingsOf(events, marks, profile.refreshHz, profile.assumed);

      // GRA-56 QA, W2: decided at most once per tick, lazily (only once an
      // error-severity finding actually needs an answer) — never once per
      // finding. Deciding it fresh for each finding in the same tick would
      // have the first print's own `recordReportedErrorT(newest)` close the
      // gate before the second finding in that same loop ever asked. `null`
      // means "not decided yet this tick"; once decided it applies to every
      // error-severity finding for the rest of this tick, and is what gets
      // written once, after the loop, if it was ever consulted at all.
      let errorGateOpen: boolean | null = null;

      for (const finding of findings) {
        if (settled) return;
        if (!severityQualifies(finding.severity)) continue;

        const count = finding.count ?? 1;
        const prior = reported.get(finding.id);
        if (prior !== undefined && count <= prior) continue; // nothing new about this one since last time

        // GRA-56 QA (F25): checked — and only advanced — here, before the
        // error-severity branch below ever touches the shared watermark
        // (a throttled skip must never advance anything shared) and before
        // `reported` is updated (so a still-growing count is picked up the
        // instant the throttle window reopens, rather than needing to grow
        // again first to pass the check above on some later tick).
        if (AGGREGATE_FINDING_IDS.has(finding.id)) {
          const lastAt = lastAggregatePrintAt.get(finding.id);
          if (lastAt !== undefined && newest - lastAt < AGGREGATE_REPRINT_MS) continue;
          lastAggregatePrintAt.set(finding.id, newest);
        }

        if (finding.severity === "error") {
          await ensureWatermark();
          if (errorGateOpen === null) {
            // Refreshed explicitly, not left to whatever `ensureWatermark`
            // last loaded: that only opens the watermark once per session
            // identity, but another live process (the MCP surface's own
            // banner, another `watch`) can write to it on every tick of
            // its own — see watermark.ts's module comment (W1).
            await watermark.refresh();
            const last = watermark.get().lastReportedErrorT;
            errorGateOpen = last === null || newest > last;
            // Written here, immediately — not deferred to after the loop.
            // `--until-first` returns from inside this very loop the
            // instant it prints (below), which would skip a write placed
            // after the loop entirely: `finish()` calls `device.stop()`
            // and resolves the caller's `await runWatch(...)` before this
            // function ever reaches a line past that `return`. Advances
            // whenever this tick actually looked, whether or not it found
            // (or was allowed to print) anything — `errorBanner()`'s own
            // rule (index.ts), so a quiet stretch does not get re-examined
            // from the same old boundary by whichever side looks next.
            await watermark.recordReportedErrorT(newest);
          }
          reported.set(finding.id, count);
          if (!errorGateOpen) continue; // another client already examined up through `newest`
        } else {
          reported.set(finding.id, count);
        }

        printFinding(finding);
        if (options.untilFirst) {
          finish(WATCH_EXIT.FOUND);
          return;
        }
      }
    } catch (error) {
      // An internal defect (a `findingsOf`/`resolveProfile` throw, most
      // plausibly), not "found a finding" — WATCH_EXIT.FOUND (1) would be
      // indistinguishable from success to a hook checking `$?` (GRA-56 QA,
      // W3). Reported on stderr like every other diagnostic; exits under
      // the same code as "bad arguments, or nothing to connect to" — from
      // the harness's point of view, an internal error and never having
      // answered the question at all are the same kind of failure, and
      // this ticket's own exit-code table (WATCH_EXIT, above) has no
      // reason to invent a fifth code for the same fact.
      process.stderr.write(`porthole watch: internal error: ${(error as Error).stack ?? String(error)}\n`);
      finish(WATCH_EXIT.BAD_ARGS);
    } finally {
      evaluating = false;
    }
  }

  device.on("event", (event: DeviceEvent) => {
    events.push(event);
    dirty = true;
  });

  // 200ms: comfortably inside the "within a second" acceptance bar while
  // capping recompute frequency well below "once per event."
  tickTimer = setInterval(() => void evaluate(), 200);

  if (options.timeoutMs !== undefined) {
    timeoutTimer = setTimeout(() => finish(WATCH_EXIT.TIMEOUT), options.timeoutMs);
  }

  const onAbort = () => finish(WATCH_EXIT.CLEAN_STOP);
  signal?.addEventListener("abort", onAbort, { once: true });

  device.start();

  try {
    return await outcome;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
