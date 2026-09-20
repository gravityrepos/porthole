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
 * **Why the shared field alone, not a full replay of `errorBanner()`'s own
 * algorithm.** `errorBanner()` (index.ts) always advances `lastReportedErrorT`
 * to "the newest event examined," even when nothing was wrong, because its
 * caller already has a live ring to answer "newest" from. `watch` only
 * advances the mark when it actually prints something, to the finding's own
 * window — a narrower, more conservative advance that can occasionally leave
 * a later banner re-scanning a span `watch` already looked at and found
 * nothing further in, but can never cause either side to swallow a real
 * error the other has not yet said out loud. Given the choice between "an
 * occasional harmless re-scan" and "a dropped error," the former is what
 * this file chooses.
 */

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

const SEVERITY_VALUES = ["error", "warning", "note"] as const;

/** Lower ranks first, same as `trace.ts`'s own `findings.sort` — `error` is worst. */
const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, note: 2 };

export interface WatchOptions {
  port: number;
  serial?: string;
  severity: Severity;
  untilFirst: boolean;
  json: boolean;
  /** Milliseconds. `undefined` means "no timeout — run until SIGINT or (with --until-first) a finding." */
  timeoutMs?: number;
  forward: boolean;
}

export const WATCH_USAGE = `
porthole watch — block until something breaks, and say so

  porthole watch [options]

  --severity <level>   error (default), warning, or note — report at or above this
  --until-first         exit the instant a qualifying finding appears
  --json                one finding object per line on stdout; diagnostics go to stderr
  --timeout <seconds>   give up after this long (exit 3) instead of waiting forever
  --port <n>            device port (default 8677)
  --serial <id>         adb device serial, when more than one is attached
  --no-forward          skip 'adb forward'; use it if the bridge is already up

Connects like any other client — its own socket to the device, independent of
whatever MCP server may also be attached — and streams findings as they occur,
one line each. Never exits merely because the app disconnects: it waits and
reconnects on its own, the same as 'porthole ui'.

Exit codes:
  0   clean stop (SIGINT)
  1   a qualifying finding was found (--until-first only)
  2   bad arguments, or nothing to connect to
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
 *   2 — bad arguments (`parseWatch` above) — nothing ever connects
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

/** The single `t` this finding is "reported at," for the shared watermark — the end of its window when it has one, else the newest event examined. */
function anchorT(finding: Finding, fallbackT: number): number {
  return finding.window?.to ?? fallbackT;
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
  // same as everywhere else `where` is optional.
  if (finding.where?.resolved) {
    const line = finding.where.line ? `:${finding.where.line}` : "";
    parts.push(`where=${finding.where.path}${line}`);
  }
  return parts.join("  ");
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
   * Recomputes findings over everything seen so far and prints whatever is
   * new. Full-history, like `porthole capture`'s own final report — not
   * `errorBanner()`'s windowed delta — because a "still open" finding (the
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

      for (const finding of findings) {
        if (settled) return;
        if (!severityQualifies(finding.severity)) continue;

        const count = finding.count ?? 1;
        const prior = reported.get(finding.id);
        if (prior !== undefined && count <= prior) continue; // nothing new about this one since last time

        if (finding.severity === "error") {
          await ensureWatermark();
          const t = anchorT(finding, newest);
          const last = watermark.get().lastReportedErrorT;
          reported.set(finding.id, count);
          if (last !== null && t <= last) continue; // another client on this session already reported it
          await watermark.recordReportedErrorT(t);
        } else {
          reported.set(finding.id, count);
        }

        printFinding(finding);
        if (options.untilFirst) {
          finish(WATCH_EXIT.FOUND);
          return;
        }
      }
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
