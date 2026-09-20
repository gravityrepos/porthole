#!/usr/bin/env node
// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DeviceClient, isAttached, isHandshaking, type DeviceEvent } from "./device.js";
import { TimelineServer } from "./timeline.js";
import { readFileSync } from "node:fs";
import { launchAppAsync, resolveProjectRoot, resolveSdkDir, restartAppAsync, runAdb, runAdbAsync } from "./adb.js";
import {
  checkInstalledApp,
  describeDevices,
  diagnoseAndReconnect,
  ensureForward,
  forwardTarget,
  listDevices,
  resolveSerial,
} from "./devices.js";
import { describe as describeMoment, fromBootMs, momentOf, toBoot } from "./moment.js";
import {
  CPU_PROBE,
  describeSystem,
  parseCpu,
  parseMemory,
  parseThermal,
  parseTop,
  type SystemContext,
} from "./system.js";
import { askTrace, checkTracePath, findTraceProcessor, questionsDescription } from "./perfetto.js";
import { reconcileStartupWithTrace } from "./startup.js";
import { captureArgs, countPortholeLabels, describeCapture, planCapture } from "./systrace.js";
import { MEASURED_OVERHEAD, RingController } from "./ring.js";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  alsoInWindowOf,
  alsoInWindowSentence,
  buildTrace,
  describeBudget,
  num,
  resolveFontScale,
  resolveProfile,
  sortBySeverity,
  str,
  type Finding,
} from "./trace.js";
// GRA-72: the accessibility lint pass over a captured semantics tree lives
// entirely in accessibility.ts — this file only fetches a tree, hands it
// off, and (in `findings`) folds the result back in. See that module's own
// doc comment for the rules, thresholds and the fold-in decision.
import {
  lintSemanticsTree,
  parseSemanticsNode,
  recordSemanticsCapture,
  semanticsCaptureForWindow,
  summarizeAccessibilityResult,
} from "./accessibility.js";
import { timelineKindsDescription } from "./eventKinds.js";
import {
  UNKNOWN_DEVICE_ID,
  clippedMsOf,
  fillWindowFromDisk,
  sessionsRoot as sessionsRootPath,
  type SessionEvent,
} from "./sessions.js";
import { InvalidScenarioError, buildSavedTrace, coverageNote, defaultOutPath, defaultScenarioName, validateScenario, writeSavedTrace } from "./save.js";
import { Watermark, buildBanner, classificationSummary, classify } from "./watermark.js";
import { whereForFrame, whereForName, type Where } from "./sources.js";
import {
  explainNotRestartable,
  explainNotSkippable,
  explainSkippableButUnstable,
  joinComposableNode,
  staleJoinNote,
  type ComposeJoin,
} from "./composeReport.js";
import { captureScreenshot } from "./screenshot.js";
import { buildSetupReport, type SetupEntry } from "./setup.js";

/** Read, not retyped: a hardcoded version here drifts from the package. */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const HOST = process.env.PORTHOLE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORTHOLE_PORT ?? 8677);
const UI_PORT = Number(process.env.PORTHOLE_UI_PORT ?? 8678);
/**
 * GRA-197: the plugin's own knowledge of which app this server is for, when
 * it wrote one — absent (not empty) when it did not, which is what tells
 * `DeviceClient` to skip the check entirely rather than compare against "".
 */
const APPLICATION_ID = process.env.PORTHOLE_APPLICATION_ID || undefined;
/**
 * GRA-199: opts back into the pre-GRA-199 shared TCP port instead of the
 * abstract socket keyed by [APPLICATION_ID] — see `devices.ts`'s
 * `forwardTarget` for what this actually changes. Written by
 * `portholeMcpConfig` only when `porthole { legacyTcpPort.set(true) }`
 * (omitted, not `"0"`, otherwise — same convention [APPLICATION_ID] uses),
 * so any truthy value here means it was deliberately set.
 */
const LEGACY_TCP_PORT = Boolean(process.env.PORTHOLE_LEGACY_TCP_PORT);

/**
 * GRA-89: how much longer than the plan's own recording duration
 * `capture_system_trace` gives the on-device `perfetto` invocation before
 * presuming it wedged — adb's own connect/attach overhead plus whatever
 * margin covers a slow device, on top of the `-t Ns` the command itself
 * asked to run for.
 */
const CAPTURE_ADB_TIMEOUT_BUFFER_MS = 30_000;

/**
 * GRA-186: how long `capture_system_trace`'s `restartApp: true` path polls
 * for the on-device trace file before giving up and restarting anyway.
 *
 * The recording itself is one `runAdbAsync` call that only resolves when the
 * whole `-t Ns` window is over (GRA-89), so it gives no mid-flight signal
 * that the session has actually started — restarting the app before it has
 * would just repeat the case this option exists to fix, restarting after the
 * whole window is over would restart to no purpose at all. Perfetto creates
 * its output file on-device as soon as the session starts, before it writes
 * a single event into it, so polling for that file's existence is the
 * smallest reliable "it has started" signal available without parsing
 * perfetto's own stderr. If it never appears within this bound the restart
 * still goes ahead — the whole point is to make the app tag visible to the
 * target process, and doing that late is far better than not doing it.
 */
const RESTART_POLL_TIMEOUT_MS = 5_000;
const RESTART_POLL_INTERVAL_MS = 150;

interface AdbCallOptions {
  serial?: string;
  env?: NodeJS.ProcessEnv;
  binary?: string;
}

async function waitForCaptureToStart(devicePath: string, options: AdbCallOptions): Promise<void> {
  const deadline = Date.now() + RESTART_POLL_TIMEOUT_MS;
  for (;;) {
    const probe = await runAdbAsync(["shell", "test", "-e", devicePath], { ...options, timeoutMs: 2_000 });
    if (probe.ok) return;
    if (Date.now() >= deadline) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, RESTART_POLL_INTERVAL_MS));
  }
}

export interface PortholeServerOptions {
  /** Injected in tests; a real one is created in `createPortholeServer` otherwise. */
  device?: DeviceClient;
  timeline?: TimelineServer;
  version?: string;
  /**
   * Test-only. Passed straight through to every `runAdbAsync` call
   * `capture_system_trace` makes; every real caller leaves it undefined, in
   * which case each spawned adb inherits `process.env` exactly as it always
   * did. This exists so a test can point `findAdb()` at a stand-in adb that
   * needs its own `NODE_OPTIONS` (or any other variable) without mutating
   * the real `process.env` — a global shared with every other test running
   * in the same worker. See `runAdbAsync`'s own `env` option in `adb.ts` for
   * the incident that made this worth a parameter rather than a shared
   * global.
   */
  adbEnv?: NodeJS.ProcessEnv;
  /**
   * Test-only, same reasoning as `adbEnv`: overrides `findAdb()`'s own
   * resolution for every `runAdbAsync` call `capture_system_trace` makes, so
   * a test can point it at a real, controllable process without setting
   * `PORTHOLE_SDK_DIR`/`ANDROID_HOME` on the real `process.env` — again a
   * global, and again shared with `adb.test.ts`'s own tests of that exact
   * resolution, running concurrently in the same worker.
   */
  adbBinary?: string;
}

export interface PortholeServer {
  server: McpServer;
  device: DeviceClient;
  timeline: TimelineServer;
}

/**
 * Builds the MCP server and registers every tool against `device` and
 * `timeline`, but does not start either and does not connect any transport.
 *
 * Split out from the boot sequence at the bottom of this file so a test can
 * hand it a fake device speaking the real wire protocol (see
 * `testing/harness.ts`) and a fresh `TimelineServer`, register the real
 * tools, and call them the way an agent would — through an MCP client over an
 * in-memory transport — rather than grepping this file's source for the
 * properties a tool is supposed to have.
 */
/** A tool's `content` array is one text block (summary only, `fail()`'s
 * shape) or two (summary then payload, `ok()`'s shape). Both blocks are
 * plain text on the wire; only the count tells a consumer which is which.
 */
type ToolContentBlock = { type: "text"; text: string };

/**
 * GRA-171: builds the `content` array both `ok()` and `fail()` return, so
 * there is exactly one place a summary and a payload are put together.
 *
 * GRA-169 defended this same seam by *normalising*: `ok()` joined summary
 * and payload with the literal string `"\n\n"` and collapsed every blank
 * line out of the summary first, because a consumer found the payload by
 * searching the *text* for that substring — a property of the string, not
 * of anything the protocol enforced. Interpolate a device value containing
 * a blank line (`hello.device`, say) into the summary and the search finds
 * the wrong occurrence, slicing from the middle of the prose instead of the
 * start of the JSON; `JSON.parse` throws and the payload is gone, not
 * merely mislabelled. Normalising away every blank line closed that one
 * failure mode (14 tests, no known gap) but it was still a textual fix for
 * a textual bug: it bought safety by silently rewriting an author's
 * intended blank line into a space, and it left `fail()` unguarded, since
 * `fail()` never called `collapseBlankLines()` — a second chokepoint nobody
 * had reason to notice was missing.
 *
 * GRA-171's structural option was on the table from the start but rejected
 * for a reason that did not hold: 0.1.0 wire compatibility. The founder's
 * 2026-09-15 decision that 0.2.0 may change this delimiter removes that
 * obstacle, so the summary and the payload are now two separate blocks in
 * the `content` array, never one string joined by a marker. **This is what
 * "the delimiter cannot occur in data" means concretely: there is no
 * delimiter for a value to collide with, at any position, in either
 * block.** A consumer takes `content[0]` for the summary and `content[1]`
 * for the payload by position — the same way this function decides which
 * is which by argument count, not by scanning either string for anything.
 * No text search happens over either block's contents at all, so a value
 * containing every shape GRA-169 catalogued (CRLF pairs, three to seven
 * consecutive newlines, whitespace-only lines, U+2028/U+2029, NBSP, form
 * feed, leading and trailing blank lines, the empty string, or literally
 * `"\n\n"` itself) is carried verbatim in its own block and never
 * inspected here. If a future call site ever concatenated the payload back
 * into the summary string by hand instead of passing it as the `payload`
 * argument, that call site alone would reintroduce a textual seam — this
 * function cannot protect against bypassing itself, only against being
 * used and still failing.
 *
 * `collapseBlankLines()` (GRA-169) is deleted rather than kept alongside
 * this, and that is a deliberate call, not reflex. GRA-168's CRLF
 * normalisation was kept after GRA-166's scanner made it redundant for
 * *correctness*, because it still served a second purpose — canonical
 * output — that removing it would have destroyed. `collapseBlankLines()`
 * has no second purpose: its only job, on every call site, was defending
 * the "\n\n" delimiter, and it always cost prose fidelity to do it — a
 * device value an agent might want verbatim came back with its blank lines
 * flattened to spaces. With no delimiter left to defend, keeping it would
 * mean paying that cost for a defence nothing needs any more. That is a
 * reason to remove it, not merely permission to.
 *
 * Module-level and exported, as `collapseBlankLines()` was, so
 * `index.test.ts` can call this directly with adversarial summaries and
 * payloads and assert on the `content` array's shape and the payload
 * block's JSON round-trip — no `vi.mock`/`spyOn` needed, because there is
 * no module-local binding to intercept: the function under test *is* the
 * chokepoint, not a wrapper around one.
 */
export function joinSummaryAndPayload(summary: string, ...payload: [unknown] | []): ToolContentBlock[] {
  const blocks: ToolContentBlock[] = [{ type: "text", text: summary }];
  if (payload.length > 0) {
    // JSON.stringify(undefined) is the JS value `undefined`, not a string —
    // the `?? "null"` keeps this block's `text` a real string always (the
    // MCP content schema requires one), and keeps the payload something
    // `JSON.parse` can read back rather than a block with no usable text.
    blocks.push({ type: "text", text: JSON.stringify(payload[0], null, 2) ?? "null" });
  }
  return blocks;
}

export function createPortholeServer(options: PortholeServerOptions = {}): PortholeServer {
  // GRA-53 `#window-fallback`: the real boot path gets on-disk session
  // persistence; a test that injects its own `options.device` (the harness
  // in `testing/harness.ts`, or a hand-built fake) is unaffected — this
  // branch only runs when nothing was injected.
  const device =
    options.device ??
    new DeviceClient(HOST, PORT, sessionsRootPath(resolveProjectRoot().directory), APPLICATION_ID);
  const timeline = options.timeline ?? new TimelineServer(device, UI_PORT);
  /**
   * GRA-62: `porthole_status`'s one read-only exception (re-establishing the
   * adb forward) only makes sense against the real device this function
   * built for itself — a caller that injected its own `device` (every test
   * in this suite) is not necessarily backed by a real, adb-managed device
   * at all, and must see no behaviour change. See `porthole_status`'s
   * handler below for where this is actually consulted.
   */
  const ownsDeviceConnection = options.device === undefined;
  const adbEnv = options.adbEnv;
  const adbBinary = options.adbBinary;
  // GRA-55: one watermark per process (see watermark.ts's module doc comment
  // for why not per connection), re-opened against whichever session
  // directory is current every time a tool runs — cheap, since `open()` is a
  // no-op once the directory has not changed.
  const watermark = new Watermark();
  // GRA-57: one ring controller per server instance, the same reasoning as
  // `watermark` above — see `RingController`'s own doc comment in ring.ts.
  const ring = new RingController();
  /** Set by `resolveWindowSince` on a first-ever `since: "last"` call, consumed by `ok()` (AC5). */
  let pendingFirstEverNote: string | null = null;
  const FIRST_EVER_NOTE =
    'First call this session: "since": "last" has nothing to start from yet, so this is the ' +
    "whole buffer, the same default as before since existed. ";

  const server = new McpServer({
    name: "porthole",
    version: options.version ?? pkg.version,
  });

  type ToolResult = { content: ToolContentBlock[]; isError?: boolean };

  /**
   * Summary first, payload second — as two `content` blocks now (see
   * `joinSummaryAndPayload()` above), not one string joined by a delimiter.
   * GRA-171: the post-collapse assertion this function used to carry
   * (`ok(): summary still contains a blank line after
   * collapseBlankLines()`) is deleted along with `collapseBlankLines()`
   * itself, and deliberately, not by omission. That assertion guarded one
   * specific failure of the textual design — the delimiter search finding
   * the wrong "\n\n" — and GRA-169's own QA had already shown it was
   * unreachable by any test without a production refactor, because `ok()`
   * called `collapseBlankLines` by a module-local binding no mock could
   * intercept. A structural join has no blank-line assumption to violate:
   * there is no search, so there is nothing for the assertion to catch that
   * `joinSummaryAndPayload()`'s own direct tests do not already cover by
   * construction. Keeping an assertion for a failure mode that no longer
   * exists would be exactly the untested-claim shape this ticket exists to
   * end, just moved from "untested" to "vacuous".
   */
  /**
   * GRA-55: the one place every successful tool result passes through, which
   * is what "the banner goes on every tool, built in one place" (the EM's
   * own condition for this ticket) means concretely — no per-tool call adds
   * it, so no tool can forget it the way the ticket's own history names as
   * the risk ("the one tool that forgets is the one the agent was using
   * when the ANR happened"). `attachSinceLastAndBanner()` does the actual
   * work; this function stays a thin async wrapper so every existing call
   * site (`return ok(summary, payload)`, inside an already-`async` handler)
   * keeps compiling unchanged — an `async` function returning a `Promise`
   * is flattened by the caller's own `await`/`return` exactly as returning
   * the value directly would be.
   */
  async function ok(summary: string, payload: unknown): Promise<ToolResult> {
    const { summary: withBanner, payload: withSinceLast } = await attachSinceLastAndBanner(summary, payload);
    return { content: joinSummaryAndPayload(withBanner, withSinceLast) };
  }

  /**
   * GRA-171: routes through `joinSummaryAndPayload()` too, with no payload
   * block (a bare `payload.length > 0` check away from getting one, if an
   * error ever needs structured detail). Before this ticket `fail()` built
   * its `content` array by hand and never passed through the chokepoint
   * `ok()` used for `collapseBlankLines()` — the GRA-169 ticket named this
   * explicitly as half of why normalisation could not be a complete fix.
   * With both going through the same function there is exactly one place
   * a `content` array is assembled, for success or failure alike.
   */
  function fail(error: unknown): ToolResult {
    const message = error instanceof Error ? error.message : String(error);
    return { content: joinSummaryAndPayload(message), isError: true };
  }

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
    summarise: (value: T) => string,
    // GRA-201: lets a tool attach `where` (or anything else) to the device's
    // own reply before it is summarised and returned, without every call
    // site re-implementing the try/catch above just to touch the payload.
    augment?: (value: T) => T,
  ) {
    try {
      const raw = await device.request<T>(method, params);
      const result = augment ? augment(raw) : raw;
      return ok(summarise(result), result);
    } catch (error) {
      return fail(error);
    }
  }

  type ExitedProcess = { packageName: string; device: string; disconnectedAt: string };

  /**
   * GRA-163: the payload half of the stale-ring fix, so an agent can tell
   * live data from post-mortem data without parsing the prose next to it.
   *
   * GRA-163 QA round 1: this used to take the caller's own `connected`
   * value as a parameter, so it agreed with whichever sense of "connected"
   * the caller happened to be using for its own boolean field — loose
   * (isAttached) on an empty-ring branch, strict (pending === null) on a
   * non-empty one. That is fine for the `connected` field itself (GRA-157
   * chose the loose sense on purpose, for "should an agent keep polling"),
   * but `exitedProcess` answers a different question — "is what I am about
   * to hand back confirmed to belong to the running process" — and that
   * question has exactly one right answer regardless of which `connected`
   * a given branch reports, or it is the same defect this ticket exists to
   * remove: three tools (or two branches of one tool) disagreeing about the
   * same state. So this is gated on `device.pendingMessage() === null`
   * directly — the strict sense, always, independent of the caller's own
   * `connected` — which is also why `porthole_status` (which never had a
   * `connected` field at all) and `findings`/`what_was_happening`'s
   * empty-ring branches (which report the loose sense) now all agree with
   * the non-empty branches on when this is null.
   *
   * Null whenever a session is currently confirmed live, or nothing has
   * ever exited in this server's lifetime (`device.lastExited` starts
   * null). Otherwise the last confirmed process and when its socket closed,
   * in the same shape every tool that calls this returns it in, so the
   * three tools' payloads agree on more than just prose.
   */
  function exitedProcessField(): ExitedProcess | null {
    if (device.pendingMessage() === null || !device.lastExited) return null;
    const { hello, disconnectedAt } = device.lastExited;
    return {
      packageName: hello.packageName,
      device: hello.device,
      disconnectedAt: new Date(disconnectedAt).toISOString(),
    };
  }

  /**
   * The prose half, and — after QA round 1 — the *only* place any tool says
   * anything about an exited process. `device.ts`'s `pendingMessage()` used
   * to append its own sentence here ("whatever is still buffered is from
   * X"), which was wrong on any branch where nothing actually is buffered:
   * `pendingMessage()` has no visibility into `timeline.buffer()`, only
   * this file does. `hasBufferedData` must be true only when the ring this
   * particular answer is about genuinely has content — every call site
   * below passes the same fact it already used to choose its branch (the
   * `!span`/`events.length === 0` checks), never a guess.
   *
   * `connected` (QA round 2): `exited` is null in two different
   * situations — a confirmed live session (`connected: true`, nothing to
   * say), and no confirmed live session *and* nothing has ever exited in
   * this server's lifetime (the very first connection, still handshaking,
   * with a ring already non-empty — GRA-163's own race mechanism:
   * `buildRaceRig()`, push one event before the deferred `hello` resolves).
   * The second case still has real data with no confirmed owner and needs
   * its own sentence — the original fix said so ("Nothing has confirmed
   * itself as the running process yet...") until this function's QA round 1
   * rewrite silently dropped it while consolidating three call sites into
   * one. Restored here, gated on there being data to caveat in the first
   * place: an empty ring with no known predecessor has nothing worth
   * flagging beyond what `pending`'s own message already says.
   */
  function exitedProcessNotice(
    exited: ExitedProcess | null,
    hasBufferedData: boolean,
    connected: boolean,
  ): string {
    if (exited) {
      return hasBufferedData
        ? `${exited.packageName} on ${exited.device} exited at ${exited.disconnectedAt}; what ` +
            "follows is from it, not from what is running now. "
        : `${exited.packageName} on ${exited.device} exited at ${exited.disconnectedAt}; nothing ` +
            "is currently buffered from it. ";
    }
    if (!connected && hasBufferedData) {
      return (
        "Nothing has confirmed itself as the running process yet, so what follows is not yet " +
        "confirmed to be live. "
      );
    }
    return "";
  }

  // ---------------------------------------------------------------------------
  // GRA-58: why the app died, folded into porthole_status rather than a new tool
  // ---------------------------------------------------------------------------

  /** How many recent exits `porthole_status`'s `exits.recent` carries — a literal, not "however many fit". */
  const EXITS_SECTION_CAP = 10;

  /** How long after an exit it is still worth calling out as *why* the app is not connected right now. */
  const RECENT_EXIT_MS = 5 * 60 * 1000;

  interface ExitSummary {
    reason: string;
    /**
     * GRA-188: epoch milliseconds — `ApplicationExitInfo.getTimestamp()`'s
     * own unit, not the device-uptime clock every other timestamp in this
     * surface uses — and exactly the value `exitTrace` below accepts:
     * quoting this field back works with no conversion, which used to
     * require a `Date.parse` an agent had to think to reach for on its own.
     */
    timestamp: number;
    /** The same instant as `timestamp`, spelled ISO-8601 for a human or a log line. `exitTrace` accepts this too (GRA-188) since it is the form most likely to get copied first. */
    at: string;
    versionName: string | null;
    versionAssumed: boolean;
    topAppFrame: string | null;
    /** GRA-201: `topAppFrame` resolved to where it lives under the project root. Absent — not `undefined` on a present key — when source resolution is off; see sources.ts. */
    where?: Where;
  }

  /**
   * `porthole_status`'s `exits` payload: the most recent deaths this
   * process's ring still holds (the runtime's `ExitInfoCollector` put them
   * there at install time — see `Protocol.kt#exit`), newest first, and the
   * one fact that needs no ring content at all: whether the exit-reason API
   * exists on this device. `hello.sdkInt` already answers that — the
   * runtime emits nothing at all below API 30 (GRA-58's own ruling), so
   * there is no event to read for it either way.
   */
  function exitsSection(): { apiUnavailable: string | null; recent: ExitSummary[] } {
    const hello = device.hello ?? device.lastExited?.hello ?? null;
    const sdkInt = hello?.sdkInt;
    const apiUnavailable =
      sdkInt !== undefined && sdkInt < 30
        ? `The exit-reason API needs Android 11 (API 30); this device reports API ${sdkInt}, so no exit history is available.`
        : null;

    const recent = timeline
      .buffer()
      .filter((e) => e.event === "exit")
      .slice()
      .sort((a, b) => num(b.data.timestamp) - num(a.data.timestamp))
      .slice(0, EXITS_SECTION_CAP)
      .map((e): ExitSummary => {
        const topAppFrame = str(e.data.mainStack).split("\n")[0] || null;
        const where = whereForFrame(topAppFrame);
        return {
          reason: str(e.data.reason),
          timestamp: num(e.data.timestamp),
          at: new Date(num(e.data.timestamp)).toISOString(),
          versionName: e.data.versionName != null ? str(e.data.versionName) : null,
          versionAssumed: e.data.versionAssumed === true,
          topAppFrame,
          ...(where ? { where } : {}),
        };
      });

    return { apiUnavailable, recent };
  }

  /**
   * "the app is not connected because it died and why" (GRA-58's own
   * wording): only when there is genuinely no live session right now, and
   * only when the most recent exit is recent enough that it is plausibly
   * *why* — an exit from an hour ago says nothing about a disconnect that
   * just happened.
   */
  function exitDeathNotice(recent: ExitSummary[], stronglyConnected: boolean): string {
    if (stronglyConnected || recent.length === 0) return "";
    const latest = recent[0];
    const ageMs = Date.now() - latest.timestamp;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > RECENT_EXIT_MS) return "";
    const build = latest.versionName
      ? `${latest.versionName}${latest.versionAssumed ? " (assumed)" : ""}`
      : "an unknown build";
    const frame = latest.topAppFrame ? ` Top app frame: ${latest.topAppFrame}.` : "";
    return (
      `Not connected because the app died: ${latest.reason} (${build}) at ${latest.at}.` + frame + " "
    );
  }

  // ---------------------------------------------------------------------------
  // windows
  // ---------------------------------------------------------------------------

  /**
   * The same three parameters on every tool that looks at a span of time.
   *
   * They used to differ per tool — `timeline` took only `sinceMs`, which made it
   * the one tool that could not be asked about a moment the others had just
   * named. An agent that cannot carry a window between calls compares two
   * different windows and does not notice.
   *
   * GRA-120: `sinceMs` anchors to `to` (explicit, or this host's own estimate
   * of "now" below) rather than to a true "now" the way the runtime's own
   * `Window.resolve` does — this host has no device clock, only the
   * timestamps events arrive stamped with, so "now" here can only ever be
   * "the newest thing we have seen", never the actual current instant. See
   * `resolveWindow` below for exactly what that means and why it is the
   * honest choice rather than an alignment gap.
   */
  const windowShape = {
    sinceMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Look back this many milliseconds from `to`. If `to` is omitted, from this host's best " +
          "estimate of the device's current time (see `to`'s description), or from the device's " +
          "own current time when nothing is buffered here yet. Ignored if `from` is given.",
      ),
    from: z
      .number()
      .int()
      .optional()
      .describe(
        "Absolute start on the device uptime clock that every event carries. Quote the `window` " +
          "from an earlier result to ask a second question about the same span.",
      ),
    to: z
      .number()
      .int()
      .optional()
      .describe(
        "Absolute end, same clock. Defaults to this host's best estimate of the device's current " +
          "time: the newest event currently buffered, since the host has no clock of the device's " +
          "own to read.",
      ),
    // GRA-55: only consulted when none of sinceMs/from/to above are given —
    // same precedence sinceMs already has against from/to. "last" is the
    // default rather than a value someone has to ask for, because the whole
    // point is that an agent should not have to guess a lookback.
    since: z
      .enum(["last", "all"])
      .optional()
      .describe(
        '"last" (the default when sinceMs/from/to are all omitted) starts where the previous ' +
          "window-taking tool call on this session left off, so nothing since is missed and " +
          'nothing already examined is re-read. On the very first call this session has ever made, ' +
          '"last" behaves exactly like today\'s default (the whole buffer). "all" is the reset: the ' +
          "whole buffer plus disk, same as every call before this existed, and it clears the " +
          "watermark that \"last\" tracks.",
      ),
  };

  interface Window {
    sinceMs?: number;
    from?: number;
    to?: number;
    since?: "last" | "all";
  }

  /**
   * The span actually examined, resolved against the buffer so it can be
   * quoted back.
   *
   * GRA-120: brought into line with the runtime's `Window.resolve` on the
   * two points that were outright bugs — a negative `from` used to reach
   * back before the device existed instead of clamping at 0 (`Window.kt`'s
   * own words: "not `Long.MIN_VALUE`: a timestamp on this clock cannot be
   * negative"), and an inverted window (`from` after `to`, or a `to` in the
   * past that `sinceMs` does not reach) used to hand a tool a backwards span
   * instead of being refused the way the tool already refuses "no window at
   * all". Both are fixed here, once, rather than in every caller.
   *
   * `sinceMs` anchoring to `to` (explicit or defaulted) rather than to a
   * true "now" is deliberately *not* changed to match the runtime bit for
   * bit: the runtime reads its own clock, and this host cannot — its only
   * source for "now" is the timestamp on the newest event it has seen,
   * which is what `to` already defaults to below. So "anchor `sinceMs` to
   * `to`" and "anchor it to the device's actual now" are the same rule
   * here, applied with the one clock this process actually has access to.
   * In the normal case this never surfaces as a disagreement anyway: every
   * caller that resolves a window here (`resolveWindowSince`) sends the
   * device *only* the resolved `from`/`to`, never a raw `sinceMs` — the
   * device's own `sinceMs` handling in `Window.resolve` is exercised by a
   * request that reaches it directly, not by anything this function
   * produces.
   */
  function resolveWindow(w: Window): { from: number; to: number; ms: number } | null {
    const events = timeline.buffer();
    if (events.length === 0) {
      // GRA-53: an empty *live* buffer used to mean "no window at all" —
      // right when the only source was memory. It no longer is: an agent
      // quoting a `window` from an earlier answer (the pattern every tool
      // description here recommends) is asking about a moment on the device
      // uptime clock, which is exactly as answerable from disk after the MCP
      // server restarts as it was from the ring before. Only the explicit
      // case is widened — `sinceMs`-relative-to-"now" still has no "now"
      // without a live buffer to take it from, so that shape still returns
      // null exactly as before.
      if (w.from !== undefined && w.to !== undefined) {
        const from = Math.max(0, w.from);
        const to = w.to;
        // Refused the same way the tool already refuses a bad window:
        // `resolveWindow` returning null, which every caller already treats
        // as "nothing to answer from" rather than a distinct error path.
        if (from > to) return null;
        return { from, to, ms: Math.max(0, to - from) };
      }
      // GRA-120 QA round 1: `sinceMs` with an explicit `to` needs no "now"
      // at all — the rule is `(to - sinceMs)..to` on both halves — so it is
      // resolved here even on a cold buffer. Forwarding it raw would let the
      // device anchor the lookback to its own clock instead, which is the
      // disagreement this ticket exists to remove. Only `sinceMs` alone (no
      // `to`) still returns null: that shape genuinely needs a "now", and the
      // device's is the right one when this host has nothing buffered.
      if (w.sinceMs !== undefined && w.to !== undefined) {
        const to = w.to;
        const from = Math.max(0, to - w.sinceMs);
        if (from > to) return null;
        return { from, to, ms: Math.max(0, to - from) };
      }
      return null;
    }
    const newest = events[events.length - 1].t;
    const oldest = events[0].t;
    const to = w.to ?? newest;
    const from = Math.max(0, w.from ?? (w.sinceMs !== undefined ? to - w.sinceMs : oldest));
    if (from > to) return null;
    return { from, to, ms: Math.max(0, to - from) };
  }

  /**
   * The identity `fillWindowFromDisk` should look up sessions under: the
   * currently-connected process's `hello`, or — the post-mortem case this
   * whole ticket is about — the last one `device.ts` saw exit. Null only
   * when neither has ever existed (never connected, this process's whole
   * life).
   */
  function currentIdentity(): { packageName: string; deviceId: string } | null {
    const hello = device.hello ?? device.lastExited?.hello ?? null;
    if (!hello) return null;
    return {
      packageName: hello.packageName,
      deviceId: (hello as { deviceId?: string }).deviceId ?? UNKNOWN_DEVICE_ID,
    };
  }

  /**
   * `findings`/`what_was_happening`/`timeline`'s one shared call into
   * `sessions.ts` — see that module's `fillWindowFromDisk` doc comment for
   * why routing all three through the same function is the point, not an
   * incidental convenience (GRA-163's history is full of what happens when
   * three tools each hand-roll the same merge).
   */
  async function mergeWithDisk(from: number, to: number) {
    return fillWindowFromDisk({
      root: device.sessions?.root ?? sessionsRootPath(resolveProjectRoot().directory),
      identity: currentIdentity(),
      buffered: timeline.buffer() as unknown as SessionEvent[],
      currentSessionDir: device.sessions?.currentDir() ?? null,
      from,
      to,
    });
  }

  /** The session directory `watermark` should currently be reading/writing — the same one `mergeWithDisk` already uses, so the two never disagree about which session is "current". */
  function currentWatermarkDir(): string | null {
    return device.sessions?.currentDir() ?? null;
  }

  // ---------------------------------------------------------------------------
  // GRA-55: since: "last", and the banner every tool result carries
  // ---------------------------------------------------------------------------

  /** What a resolved window carries once `since` has been folded in — `resolveWindow`'s own result plus whether this call was `since: "last"`-shaped, which `findings`' classification needs. */
  interface ResolvedWindow {
    from: number;
    to: number;
    ms: number;
    /** True for both "this call explicitly asked for since: last" and "no window was given at all", since the latter defaults to the former. False for an explicit sinceMs/from/to, and for since: "all". */
    sinceLast: boolean;
    /** AC5: true only for a since:"last" call with no watermark yet — "behaves exactly as today's default and says so in the summary line" is this flag reaching the caller. */
    firstEver: boolean;
    /**
     * GRA-189: true only for the "nothing new, and nothing to fall back to"
     * shape at the very end of `resolveWindowSince` below — a genuinely
     * empty `since: "last"` window with no previous `findings` digest to
     * re-ask. Deliberately distinct from an ordinary zero-width *digest*
     * re-ask (GRA-55 AC1's "two calls back to back with nothing between
     * them," which can also land on `from === to`): that shape still has a
     * real previous window to reclassify against and must keep doing so, so
     * only this one carries the flag. `findings` uses it to skip running the
     * analysis at all and say "nothing new" instead of "0s examined."
     */
    nothingNew: boolean;
  }

  /**
   * Folds `since` into `resolveWindow`, and records `lastExaminedT` on every
   * resolution — the one chokepoint every window-taking tool (`findings`,
   * `save_moment`, `recompositions`, `frames`, `blocking`, `logs`,
   * `timeline`) calls instead of `resolveWindow` directly, so "since: last
   * updates the watermark" cannot be true for six tools and forgotten by a
   * seventh.
   *
   * Explicit `sinceMs`/`from`/`to` wins outright, exactly as it always has —
   * `since` only ever supplies a default for when none of those were given.
   *
   * `since: "last"` with nothing yet in the watermark behaves exactly like
   * today's default (AC5): the whole buffer, same as `resolveWindow({})`.
   * With a watermark and new events since it, the window is `[lastExaminedT,
   * newest]` — genuinely new material only. With a watermark and *nothing*
   * new (the AC1 case: two calls back to back with no interaction between
   * them), there is no new material to narrow to, and narrowing there
   * anyway would return an empty window whose zero findings would then look
   * exactly like "everything resolved" — the opposite of AC1's "the second
   * call marks everything ongoing." So this falls back to re-asking the
   * exact window the last `findings` call covered (its digest, if there is
   * one): the same question again, honestly, which is what "nothing
   * happened" actually means here.
   */
  async function resolveWindowSince(w: Window): Promise<ResolvedWindow | null> {
    await watermark.open(currentWatermarkDir());

    if (w.sinceMs !== undefined || w.from !== undefined || w.to !== undefined) {
      const span = resolveWindow(w);
      if (span) await watermark.recordExamined(span.to);
      return span ? { ...span, sinceLast: false, firstEver: false, nothingNew: false } : null;
    }

    const since = w.since ?? "last";
    if (since === "all") {
      await watermark.reset();
      const span = resolveWindow({});
      if (span) await watermark.recordExamined(span.to);
      return span ? { ...span, sinceLast: false, firstEver: false, nothingNew: false } : null;
    }

    const state = watermark.get();
    if (state.lastExaminedT === null) {
      // AC5: no watermark yet — the whole buffer, exactly as if `since` did
      // not exist. `firstEver: true` is what lets the caller say so.
      const span = resolveWindow({});
      if (span) await watermark.recordExamined(span.to);
      // AC5's "says so": noted here, once, and consumed by `ok()` for
      // whichever tool made this call — not narrated per tool, so the six
      // other window-taking tools cannot each forget it.
      if (span) pendingFirstEverNote = FIRST_EVER_NOTE;
      return span ? { ...span, sinceLast: true, firstEver: true, nothingNew: false } : null;
    }

    const buffered = timeline.buffer();
    const liveNewest = buffered.length > 0 ? buffered[buffered.length - 1].t : null;
    if (liveNewest !== null && liveNewest > state.lastExaminedT) {
      // Exclusive lower bound: `lastExaminedT` was the `to` of whatever
      // window was examined last, and every window here (like
      // `resolveWindow`'s own) treats its bounds as inclusive. Starting the
      // next one at the same value would re-examine that one boundary event
      // twice across two consecutive since:"last" windows — harmless for a
      // raw event count, but exactly the kind of double-count that would
      // make a finding resting on that single event look "still happening"
      // one call after it actually stopped.
      const from = state.lastExaminedT + 1;
      const span = { from, to: liveNewest, ms: Math.max(0, liveNewest - from) };
      await watermark.recordExamined(span.to);
      return { ...span, sinceLast: true, firstEver: false, nothingNew: false };
    }

    if (state.digest) {
      const { from, to } = state.digest.window;
      return { from, to, ms: Math.max(0, to - from), sinceLast: true, firstEver: false, nothingNew: false };
    }

    // GRA-189: nothing new, and nothing to fall back to (a window-taking
    // tool other than `findings` was the only thing ever called before this
    // — or, the device case, before an earlier MCP process this one's
    // watermark.json survived). An honest zero-width window rather than a
    // guess, and `nothingNew: true` so the caller skips analysing it and
    // says so plainly instead of reporting "0s examined."
    return {
      from: state.lastExaminedT,
      to: state.lastExaminedT,
      ms: 0,
      sinceLast: true,
      firstEver: false,
      nothingNew: true,
    };
  }

  /** The structured half of the banner (ruling 5's "an agent that has to regex a sentence to know whether to act is a worse agent"). */
  interface SinceLast {
    errors: number;
    firstAt: number;
    lastAt: number;
  }

  /**
   * The banner's actual construction: every error-severity finding produced
   * by the events between `lastReportedErrorT` (exclusive, so nothing is
   * ever shown twice) and the newest event this process currently knows
   * about. Advances `lastReportedErrorT` whenever it looks — including when
   * it finds nothing to report — so a quiet stretch does not get re-scanned
   * from the same old boundary on every subsequent call.
   */
  async function errorBanner(): Promise<{ banner: string | null; sinceLast: SinceLast | null }> {
    const buffered = timeline.buffer();
    const liveNewest = buffered.length > 0 ? buffered[buffered.length - 1].t : null;
    const state = watermark.get();

    if (liveNewest === null) {
      // Nothing buffered at all yet — there is nothing to report on, and
      // nothing to seed either (there is no `t` to seed it to). Left null,
      // so the first call that actually has something buffered is the one
      // that decides whether it is worth reporting.
      return { banner: null, sinceLast: null };
    }
    if (state.lastReportedErrorT !== null && liveNewest <= state.lastReportedErrorT) {
      return { banner: null, sinceLast: null };
    }

    // `lastReportedErrorT === null` (this process has never reported
    // anything) is treated as "everything currently buffered counts as
    // unreported" rather than silently seeding to now — a call whose very
    // first look at the world finds an error already sitting there should
    // say so, not swallow it just because no earlier call happened to check
    // first. `from: 0` reaches back to the start of whatever this process
    // can see (the live buffer, widened by `mergeWithDisk`'s own disk
    // fallback), the same "no prior context" floor `resolveWindow`'s own
    // default uses.
    const from = state.lastReportedErrorT === null ? 0 : state.lastReportedErrorT + 1;
    const merged = await mergeWithDisk(from, liveNewest);
    const events = merged.events as unknown as DeviceEvent[];
    if (events.length === 0) {
      await watermark.recordReportedErrorT(liveNewest);
      return { banner: null, sinceLast: null };
    }

    const profile = resolveProfile({
      liveEvents: buffered,
      windowTo: liveNewest,
      sessionProfile: device.sessions?.currentMeta()?.profile ?? null,
      hello: (device.hello as unknown as Record<string, unknown>) ?? null,
    });
    const trace = buildTrace({
      scenario: "since-last-banner",
      events,
      hello: (device.hello as unknown as Record<string, unknown>) ?? null,
      durationMs: liveNewest - from,
      withEvents: false,
      profile,
    });
    const errorFindings = trace.findings.filter((f) => f.severity === "error");
    await watermark.recordReportedErrorT(liveNewest);
    if (errorFindings.length === 0) {
      return { banner: null, sinceLast: null };
    }

    return {
      banner: buildBanner(errorFindings),
      sinceLast: {
        errors: errorFindings.reduce((sum, f) => sum + (f.count ?? 1), 0),
        firstAt: events[0].t,
        lastAt: events[events.length - 1].t,
      },
    };
  }

  /**
   * `ok()`'s actual work (see that function's own comment for why it is
   * split out): opens the watermark for whichever session is current,
   * builds the banner, prefixes it onto the summary, and attaches the
   * structured `sinceLast` field to the payload — every payload here is a
   * plain object, so the spread below always applies.
   */
  async function attachSinceLastAndBanner(
    summary: string,
    payload: unknown,
  ): Promise<{ summary: string; payload: unknown }> {
    await watermark.open(currentWatermarkDir());
    const { banner, sinceLast } = await errorBanner();
    const firstEver = pendingFirstEverNote;
    pendingFirstEverNote = null;
    const narrated = firstEver ? `${firstEver}${summary}` : summary;
    // GRA-197: "warn loudly, do not refuse" means every successful result,
    // from every tool, leads with the package mismatch while one stands —
    // here, in the one place all of them pass through, so no tool can
    // forget it (the same reason the GRA-55 banner lives here and not in
    // each handler). A summary that already *is* the mismatch text —
    // porthole_status's, and findings' empty-ring branch — is left alone
    // rather than said twice.
    const mismatch = device.packageMismatch;
    const led = mismatch && !summary.startsWith(mismatch) ? `⚠ ${mismatch}\n${narrated}` : narrated;
    const withBanner = banner ? `${banner}\n${led}` : led;
    const withSinceLast =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), sinceLast }
        : payload;
    return { summary: withBanner, payload: withSinceLast };
  }

  // ---------------------------------------------------------------------------
  // what to do next
  // ---------------------------------------------------------------------------

  /**
   * The tool that shows a finding's evidence.
   *
   * Without this a finding is a dead end: it states a conclusion and leaves the
   * agent to guess which of eleven tools substantiates it. Guessing is where the
   * wandering starts, so each finding names its own next call.
   */
  const FOLLOW_UP: Record<string, { tool: string; why: string }> = {
    "db-on-main-thread": { tool: "blocking", why: "the queries, their SQL and how long each took" },
    "main-thread-stall": { tool: "blocking", why: "the stack the main thread was sitting in" },
    "http-failed": { tool: "inflight", why: "the failed calls with status and body previews" },
    "http-call-slow": {
      tool: "inflight",
      why: "recentHttp's own phase breakdown, byte counts and headers for the call",
    },
    "frames-dropped": { tool: "frames", why: "which phase dominated the janky frames" },
    "blocking-gc": {
      tool: "timeline",
      why: 'what allocated around each collection (kinds: ["gc"])',
    },
    "trim-memory": {
      tool: "timeline",
      why: 'the memory series around the trim (kinds: ["memory"])',
    },
    "work-retried": { tool: "inflight", why: "the jobs and their attempt counts" },
    "recompose-hotspot": {
      tool: "recompositions",
      why: "the per-node counts and the state keys written just before",
    },
  };

  function withFollowUp(finding: Finding) {
    const next = FOLLOW_UP[finding.id];
    return next
      ? { ...finding, next: { tool: next.tool, window: "quote `window` above", shows: next.why } }
      : finding;
  }

  /**
   * GRA-72: the device state `accessibility.ts`'s touch-target and
   * font-scale checks need, resolved the same way `resolveProfile` already
   * is everywhere else — the live buffer, unbounded by any particular
   * window, since this always describes "right now" for a live capture.
   * `density: null` (not `0` or a guessed default) means genuinely unknown,
   * which `lintSemanticsTree` already treats as "skip that rule and say
   * so" rather than silently measuring against a made-up screen.
   */
  function currentDensityAndFontScale(): { density: number | null; fontScale: number } {
    const buffered = timeline.buffer();
    const profile = resolveProfile({
      liveEvents: buffered,
      windowTo: Infinity,
      sessionProfile: device.sessions?.currentMeta()?.profile ?? null,
      hello: (device.hello as unknown as Record<string, unknown>) ?? null,
    });
    const density = !profile.assumed && profile.full.density > 0 ? profile.full.density : null;
    const fontScale = resolveFontScale(buffered, Infinity);
    return { density, fontScale };
  }

  // ---------------------------------------------------------------------------
  // tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "porthole_status",
    {
      title: "Porthole status",
      description:
        "Whether the porthole is connected to a running app, which collectors are active, and what to " +
        "do if it is not. Call this when another tool reports it cannot reach the device.\n\n" +
        "This tool answers 'is it plugged in', not 'is anything wrong'. For that, call `findings`.\n\n" +
        "Also carries `exits`: the most recent process deaths Android recorded for this app, so " +
        "'why did it just die' is answerable on the first call after a crash, not a tool an agent " +
        "has to know to reach for.\n\n" +
        "GRA-62: when not connected, this tries to fix the one thing it safely can before answering — " +
        "listing attached devices and (re-)establishing the `adb forward` — so a dropped forward is " +
        "often invisible: call this again and it is just connected. It never installs, launches or " +
        "restarts anything; when the fix needs that, the summary names `porthole_connect` instead.",
      inputSchema: {
        // GRA-188: `exits.recent` prints both an epoch-milliseconds
        // `timestamp` and an ISO-8601 `at` for the same instant (device
        // pass, 2026-09-15 — an agent's obvious next move, quoting the
        // printed timestamp straight back, used to fail validation whenever
        // it reached for `at`). Both forms are accepted here now; either
        // one round-trips with no conversion the caller has to think of.
        exitTrace: z
          .union([z.number().int().positive(), z.string()])
          .optional()
          .describe(
            "Fetch the full redacted ANR/native-crash trace for one entry in `exits` — pass either " +
              "that entry's `timestamp` (epoch milliseconds) or its `at` (ISO-8601) verbatim; both " +
              "are accepted and converted. Capped at 256 KB by the runtime, with a note in the text " +
              "if it was truncated. Omit this to just see the `exits` summary.",
          ),
        // GRA-62: only consulted while reconnecting (see diagnoseAndReconnect
        // above) — an already-connected call ignores this entirely, same as
        // every other windowed tool ignores parameters it has no use for.
        serial: z
          .string()
          .optional()
          .describe(
            "Device serial to use while reconnecting, when more than one is attached and " +
              "PORTHOLE_SERIAL is not set. `adb devices` lists them; this tool does too, in its " +
              "payload, when it cannot pick one on its own.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ exitTrace, serial }): Promise<ToolResult> => {
      // GRA-62: idempotent and invisible to the app under test — the one
      // exception the EM's ruling on this ticket carves out of
      // `readOnlyHint: true`. Gated on `ownsDeviceConnection` (see its own
      // comment above): only the real device this server manages itself is
      // ever worth running `adb` against here.
      const reconnect = ownsDeviceConnection
        ? await diagnoseAndReconnect(device, PORT, {
            serial,
            envSerial: process.env.PORTHOLE_SERIAL,
            // GRA-199: what ensureForward forwards to — see forwardTarget's
            // own doc comment for why a missing applicationId refuses rather
            // than guessing.
            applicationId: APPLICATION_ID,
            legacyTcpPort: LEGACY_TCP_PORT,
            adbOptions: { env: adbEnv, binary: adbBinary },
          })
        : null;

      // GRA-119 AC5: name which SDK and which project root this run resolved
      // to, and where each came from, so "adb resolved to the wrong SDK" is
      // something this tool can actually diagnose instead of something an
      // agent has to take on faith. resolveSdkDir()/resolveProjectRoot() in
      // adb.ts already compute both; this just reports them.
      const sdkDir = resolveSdkDir();
      const projectRoot = resolveProjectRoot();
      // GRA-157: DeviceClient now has a "handshaking" ConnectionState for the
      // gap between the socket connecting and hello resolving, so this reads
      // `device.state` alone — pendingMessage() names the disconnected and
      // handshaking stories the same way `findings` does (AC3), and returns
      // null only when state === "connected", which now guarantees `hello`
      // is set, so the non-null assertion below is the invariant, not a hope.
      //
      // GRA-62: when `reconnect` ran and still could not attach, its own
      // message replaces the generic wall-of-text — it names the specific
      // thing (no device, several with no serial, forward failed) instead
      // of a five-step checklist that starts "is the app running" when the
      // actual answer is "nothing is even plugged in". When `reconnect`
      // succeeded, `device.pendingMessage()` already reflects that (it is
      // either null or the ordinary handshake-pending message), so it is
      // left untouched.
      const pendingFromDevice = device.pendingMessage();
      const pending =
        reconnect && reconnect.attempted && !reconnect.reconnected && pendingFromDevice !== null
          ? reconnect.message
          : pendingFromDevice;
      const bufferedEvents = timeline.buffer().length;
      // GRA-163: same structured field findings and what_was_happening carry
      // — null once connected, otherwise the last confirmed process and when
      // it exited, so an agent reading any of the three tools' JSON alone
      // sees the same fact. QA round 1: `exitedProcessNotice()` builds the
      // matching sentence from `bufferedEvents` above, so it can never claim
      // buffered data this tool is not itself reporting any.
      const exitedProcess = exitedProcessField();
      const notice = exitedProcessNotice(exitedProcess, bufferedEvents > 0, pending === null);
      const exits = exitsSection();
      const deathNotice = exitDeathNotice(exits.recent, pending === null);

      // GRA-228: point at `setup` from the first call an agent makes,
      // rather than leaving "which integration did I forget" for a lucky
      // find of the tool table. Only asked once this tool has already
      // decided the connection itself is healthy — not mid-handshake, and
      // not while talking to the wrong app (packageMismatch) or the wrong
      // protocol version, where the setup report would be about a session
      // this call is not really vouching for. Best-effort: a `setup` RPC
      // failure here must never break `porthole_status` itself, hence its
      // own try/catch rather than routing through the ones above.
      let setupNote = "";
      if (pending === null && !device.packageMismatch && !device.protocolMismatch) {
        try {
          const setupEntries = await device.request<SetupEntry[]>("setup", {});
          const { gaps } = buildSetupReport(setupEntries);
          if (gaps.length > 0) {
            setupNote =
              ` ${gaps.length} integration${gaps.length > 1 ? "s" : ""} present but unwired ` +
              `(${gaps.map((gap) => gap.displayName).join(", ")}) — call \`setup\` for the exact line to add.`;
          }
        } catch {
          // Connected but `setup` itself failed: say nothing rather than a
          // second failure mode layered onto the one this tool already
          // reports plainly elsewhere.
        }
      }

      // GRA-58: a missing `exitTrace` fails zod validation before the
      // handler ever runs when it is a negative or non-integer number
      // (`exitTrace` is `z.union([z.number().int().positive(), z.string()])`);
      // a numeric shape reaching here may still name a timestamp the
      // runtime has never heard of, hence the `found` field in what comes
      // back rather than a thrown error.
      //
      // GRA-188: a *string* shape is new — `exits.recent` prints both an
      // epoch-milliseconds `timestamp` and an ISO-8601 `at` for the same
      // instant, and an agent quoting either back should work. `Date.parse`
      // covers `at`'s own format and every other syntax that reasonably
      // names an instant; a string that parses to nothing (empty, garbage)
      // is refused right here, with one line, rather than reaching
      // `device.request` with `NaN`.
      let exitTraceMs: number | null = null;
      if (typeof exitTrace === "string") {
        const parsed = Date.parse(exitTrace);
        if (!Number.isFinite(parsed)) {
          return fail(
            `exitTrace: ${JSON.stringify(exitTrace)} is not a valid epoch-milliseconds number or an ` +
              "ISO-8601 timestamp.",
          );
        }
        exitTraceMs = parsed;
      } else if (exitTrace !== undefined) {
        exitTraceMs = exitTrace;
      }

      let exitTraceResult: unknown = null;
      if (exitTraceMs !== null) {
        try {
          exitTraceResult = await device.request("exit_trace", { timestamp: exitTraceMs });
        } catch (error) {
          exitTraceResult = {
            timestamp: exitTraceMs,
            found: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      // GRA-199: the far end of the forward this server expects — reported
      // as data (not just implied by `forwardTarget`'s success/failure
      // inside `deviceDiagnosis.forward`) so a caller can see it even on a
      // call that never needed to (re-)forward at all, i.e. already
      // connected. `null` only when it cannot be computed yet (no
      // applicationId known and not on the legacy TCP path) — the same
      // condition `porthole_connect`'s own forward would refuse on.
      const socketTarget = forwardTarget(PORT, APPLICATION_ID, LEGACY_TCP_PORT);

      // QA F18/F19: same PORTHOLE_SERIAL fallback the ring tools themselves
      // use, and (F19) a real device consultation on a cache miss — see
      // `RingController.status`'s own doc comment for why this can no
      // longer answer from in-memory state alone. Gated on
      // `ownsDeviceConnection`, the same as `reconnect` above: a
      // test-injected `device` (every test in this suite) is not
      // necessarily backed by a real, adb-managed device at all, and this
      // must run no adb command against one — `cachedStatus()` is the
      // in-memory-only view `status()` itself falls back on.
      const ringStatus = ownsDeviceConnection
        ? await ring.status({ serial: serial ?? process.env.PORTHOLE_SERIAL, env: adbEnv, binary: adbBinary })
        : ring.cachedStatus();

      const payload = {
        state: device.state,
        host: HOST,
        port: PORT,
        socketTarget: socketTarget.ok ? socketTarget.target : null,
        app: device.hello,
        timelineUi: timeline.isRunning() ? timeline.url() : null,
        bufferedEvents,
        lastError: device.lastError,
        // GRA-96: null on a healthy handshake, otherwise the same sentence
        // `summary` uses below — reported in the payload too so a caller
        // reading structured data (not just the text) can branch on it
        // without string-matching `summary`.
        protocolMismatch: device.protocolMismatch,
        // GRA-197: same shape, beside it — null unless PORTHOLE_APPLICATION_ID
        // was configured and disagrees with the connected hello.
        packageMismatch: device.packageMismatch,
        sdkDir: sdkDir.directory,
        sdkDirSource: sdkDir.source,
        projectRoot: projectRoot.directory,
        projectRootSource: projectRoot.source,
        exitedProcess,
        exits,
        exitTrace: exitTraceResult,
        // GRA-62: null whenever `reconnect` never ran (already attached, or
        // `ownsDeviceConnection` is false) — present, with `devices` and
        // `serial`, exactly when this call actually went looking for one.
        deviceDiagnosis: reconnect,
        // GRA-57: whether the detached ring buffer is running, how deep it
        // is, and its measured cost — an agent deciding whether to turn it
        // on (`system_trace_start`) sees the overhead before asking, not
        // after. Present and non-null even when nothing is running: the
        // `overhead` figures are still worth showing then.
        ring: ringStatus,
      };
      // GRA-96/GRA-197: a mismatch takes priority over the normal "here is
      // what's connected" sentence — hello did land and the socket is fine,
      // but the one thing worth saying is that something disagrees, not the
      // collector list a mismatched build may not even be able to report
      // honestly. packageMismatch leads: talking to the wrong app entirely
      // is the more fundamental problem, and its protocol is not this
      // server's concern until it is talking to the right one. This is what
      // turns AC1's "specific, actionable message... not a generic failure"
      // into the actual summary text an agent reads, rather than a field it
      // has to know to check.
      // GRA-62: said once, ahead of everything else, only on the call that
      // actually fixed it — AC1's "a single porthole_status call ... reports
      // connected" means this sentence and the "Connected to ..." one below
      // land in the same response, not that this tool got quieter about how.
      const reconnectNotice =
        reconnect && reconnect.attempted && reconnect.reconnected
          ? `Re-established the adb forward to ${reconnect.serial}. `
          : "";
      const summary =
        reconnectNotice +
        notice +
        deathNotice +
        (pending ??
          device.packageMismatch ??
          device.protocolMismatch ??
          `Connected to ${device.hello!.packageName} on ${device.hello!.device} ` +
            `(API ${device.hello!.sdkInt}). Collectors: ${device.hello!.collectors.join(", ")}.`) +
        setupNote;
      return ok(summary, payload);
    },
  );

  server.registerTool(
    "porthole_connect",
    {
      title: "Connect the porthole to a device",
      description:
        "Does the parts of getting connected that `porthole_status` cannot safely do on its own: " +
        "checking whether the debug build is installed and which version, and launching or restarting " +
        "the app. Call this when `porthole_status` names it, or to deliberately force a fresh session " +
        "(an empty buffer) by restarting the app.\n\n" +
        "By default this only diagnoses — which device, whether the app is installed, what version, " +
        "whether it is debuggable, whether it is running — and touches nothing. Pass `launch: true` to " +
        "start the app if it is installed but not running, or `restart: true` to force-stop and " +
        "relaunch it even if it is already running, the same force-stop-then-launch the timeline UI's " +
        "own restart button and `capture_system_trace`'s `restartApp` option already do. A restart " +
        "produces a new session: the next `porthole_status` reports a new process, and the event " +
        "buffer starts over.\n\n" +
        "Unlike `porthole_status`, this can act on the app under test, so it is not called on the " +
        "speculative first-check-in path — only when something is actually known to need fixing.",
      inputSchema: {
        serial: z
          .string()
          .optional()
          .describe(
            "Device serial, when more than one is attached and PORTHOLE_SERIAL is not set. " +
              "`adb devices` lists them; so does this tool's own payload when it cannot pick one.",
          ),
        packageName: z
          .string()
          .optional()
          .describe(
            "The app to check/launch/restart. Defaults to PORTHOLE_APPLICATION_ID, or the package " +
              "this porthole last connected to or saw exit, if either is known.",
          ),
        launch: z
          .boolean()
          .optional()
          .default(false)
          .describe("Launch the app if it is installed but not currently running. Ignored when `restart` is true."),
        restart: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Force-stop and relaunch the app even if it is already running, for a fresh session and " +
              "an empty buffer. Takes priority over `launch`.",
          ),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ serial, packageName, launch, restart }): Promise<ToolResult> => {
      const adbOptions: AdbCallOptions = { env: adbEnv, binary: adbBinary };

      const listed = await listDevices(adbOptions);
      if (!listed.ok) return fail(`Could not list attached devices: ${listed.output}`);
      if (listed.devices.length === 0) {
        return ok("No Android device or emulator is attached. Plug one in, or start an emulator.", {
          devices: [],
        });
      }

      const resolution = resolveSerial(listed.devices, serial, process.env.PORTHOLE_SERIAL);
      if (resolution.kind === "none-ready") {
        return ok(
          `${listed.devices.length} device(s) attached, but none are ready: ${describeDevices(listed.devices)}. ` +
            "Check the device screen for a USB-debugging authorization prompt.",
          { devices: listed.devices },
        );
      }
      if (resolution.kind === "ambiguous") {
        return ok(
          `${resolution.devices.length} devices are attached and no serial is configured: ` +
            `${describeDevices(resolution.devices)}. Pass \`serial\` to pick one.`,
          { devices: resolution.devices, ambiguous: true },
        );
      }
      const chosenSerial = resolution.serial;

      // GRA-199: an explicit `packageName` argument wins over
      // PORTHOLE_APPLICATION_ID here too — the same precedence `targetPackage`
      // below uses for everything after the forward — since a caller naming
      // a package is asking about that one, not whatever this server was
      // configured for.
      const forward = await ensureForward(PORT, chosenSerial, packageName || APPLICATION_ID, LEGACY_TCP_PORT, adbOptions);
      if (!forward.ok) {
        return ok(`Found ${chosenSerial}, but could not forward the port: ${forward.output}`, {
          serial: chosenSerial,
          forward,
        });
      }

      // Defaulting order: an explicit `packageName` wins, then the app this
      // server was actually configured for (GRA-197), then whichever app it
      // last had a confirmed hello from — connected now, or the last one
      // seen before it exited — since that is almost always still the app
      // someone is asking about.
      const targetPackage =
        packageName || APPLICATION_ID || device.hello?.packageName || device.lastExited?.hello.packageName;
      if (!targetPackage) {
        return ok(
          `Forwarded port ${PORT} to ${chosenSerial}. No package name is known to check — pass ` +
            "`packageName`, or set PORTHOLE_APPLICATION_ID.",
          { serial: chosenSerial, forward, devices: listed.devices },
        );
      }

      const checked = await checkInstalledApp(targetPackage, chosenSerial, adbOptions);
      if (!checked.ok) {
        return ok(`Forwarded the port, but could not check ${targetPackage}: ${checked.output}`, {
          serial: chosenSerial,
          forward,
          packageName: targetPackage,
        });
      }
      const info = checked.info;

      if (!info.installed) {
        return ok(
          `${targetPackage} is not installed on ${chosenSerial}. Install the debug build: ` +
            "./gradlew installDebug",
          { serial: chosenSerial, forward, packageName: targetPackage, ...info },
        );
      }
      // A release build has no Porthole runtime in it at all (the Gradle
      // plugin only wires it into the debug variant) — saying so here is
      // the one diagnosis no amount of retrying `porthole_status` could
      // ever reach on its own.
      if (info.debuggable === false) {
        return ok(
          `${targetPackage} (${info.versionName ?? "unknown version"}) is installed on ${chosenSerial}, but it ` +
            "is a release build — the Porthole runtime will not be in it. Install the debug build: " +
            "./gradlew installDebug",
          { serial: chosenSerial, forward, packageName: targetPackage, ...info },
        );
      }

      if (restart) {
        const result = await restartAppAsync(targetPackage, { ...adbOptions, serial: chosenSerial });
        // GRA-233: launchState/totalTimeMs come from `am start -W`'s own
        // stable output, when the launch went through the resolved-activity
        // path rather than the monkey fallback — present here (both on
        // success and on a report-anyway failure) so GRA-60's startup work
        // can use them without a second round trip.
        return result.ok
          ? ok(
              `Restarted ${targetPackage} on ${chosenSerial}. Expect a new session on the next ` +
                "porthole_status call.",
              {
                serial: chosenSerial,
                forward,
                packageName: targetPackage,
                ...info,
                restarted: true,
                launchState: result.launchState,
                totalTimeMs: result.totalTimeMs,
              },
            )
          : ok(`Could not restart ${targetPackage}: ${result.output}`, {
              serial: chosenSerial,
              forward,
              packageName: targetPackage,
              ...info,
              restarted: false,
              launchState: result.launchState,
              totalTimeMs: result.totalTimeMs,
            });
      }

      if (!info.running) {
        if (launch) {
          const result = await launchAppAsync(targetPackage, { ...adbOptions, serial: chosenSerial });
          return result.ok
            ? ok(`Launched ${targetPackage} (${info.versionName ?? "unknown version"}) on ${chosenSerial}.`, {
                serial: chosenSerial,
                forward,
                packageName: targetPackage,
                ...info,
                launched: true,
                launchState: result.launchState,
                totalTimeMs: result.totalTimeMs,
              })
            : ok(`Could not launch ${targetPackage}: ${result.output}`, {
                serial: chosenSerial,
                forward,
                packageName: targetPackage,
                ...info,
                launched: false,
                launchState: result.launchState,
                totalTimeMs: result.totalTimeMs,
              });
        }
        return ok(
          `${targetPackage} (${info.versionName ?? "unknown version"}) is installed on ${chosenSerial} but not ` +
            "running. Call this again with `launch: true` to start it.",
          { serial: chosenSerial, forward, packageName: targetPackage, ...info },
        );
      }

      return ok(
        `${targetPackage} (${info.versionName ?? "unknown version"}) is installed and running on ${chosenSerial}. ` +
          "If porthole_status still does not report it connected, confirm the Porthole runtime is on " +
          "the app's debug classpath.",
        { serial: chosenSerial, forward, packageName: targetPackage, ...info },
      );
    },
  );

  server.registerTool(
    "setup",
    {
      title: "What's wired up",
      description:
        "Every integration the runtime can see: on the classpath or not, instrumented or not, each " +
        "with the runtime's own hint when there is something to do about it — the same data the " +
        "timeline UI's setup panel shows, including the `socket` entry (did the loopback socket " +
        "bind), the `strictmode` entry (GRA-59: is StrictMode installed, and note that Porthole's " +
        "policy REPLACES the app's own rather than chaining it), and — present only when it actually " +
        "happened — an `okhttp-listener` entry (GRA-66 F10): the app called its own " +
        "`eventListener()`/`eventListenerFactory()` *after* `installPorthole()` on the same builder, " +
        "which silently replaced Porthole's own factory (OkHttp's own last-call-wins) even though " +
        "`installPorthole()` itself already reported this client wired. Its hint says the fix: call " +
        "`installPorthole()` after the app's own listener, not before.\n\n" +
        "For each integration that is present but unwired, this also gives the exact line to add " +
        "and names which lanes and tools go dark without it — ranked so the gap that leaves the " +
        "most dark comes first. A fully-instrumented project gets an explicit 'everything present " +
        "is wired' rather than an empty list that looks the same as 'nothing to check'.\n\n" +
        "Instrumenting a client cannot be discovered by scanning the project for it — being handed " +
        "the builder before it is built is the only way to attach to one, and a real app usually has " +
        "several. This names which library is unwired, never where in the project to change it.\n\n" +
        "Call this once, early: `porthole_status` already names it whenever an integration looks " +
        "present but unwired, so you rarely have to remember to reach for it yourself.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (): Promise<ToolResult> => {
      try {
        const entries = await device.request<SetupEntry[]>("setup", {});
        const report = buildSetupReport(entries);
        return ok(report.summary, report);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "findings",
    {
      title: "What is wrong right now",
      description:
        "Start here. Everything the porthole can currently say is wrong, ranked, each with how " +
        "strongly it can be claimed and which tool shows its evidence.\n\n" +
        "The other tools return measurements and leave the conclusion to you. This one draws the " +
        "conclusions the data actually supports, which is a shorter list than it looks: queries on " +
        "the main thread, stalls, failed calls, dropped frames, blocking collections, memory trims, " +
        "retried jobs, recomposition hotspots. A hotspot the Kotlin compose compiler's own report " +
        "(`./gradlew portholeComposeReport`, not on by default) says is restartable but not " +
        "skippable is promoted to a `warning` and names the unstable parameter and why, in the " +
        "compiler's own words; one that is skippable but still carries an unstable parameter is a " +
        "different, less urgent finding of its own, never promoted the same way. That report is " +
        "always compiled with strong skipping off; when your own build has it on, the finding says " +
        "so and qualifies the claim — the composable still skips whenever the caller passes the " +
        "same instance, and only a fresh one each time defeats it.\n\n" +
        "`confidence` is load-bearing and worth repeating to whoever reads your answer. 'observed' " +
        "means the device reported it: a query ran on the main thread, a frame missed its deadline. " +
        "'correlated' means two things happened close together, which is ordering and not " +
        "causation. Do not upgrade a correlated finding to a cause because it is the only one you " +
        "have.\n\n" +
        "`clippedMs` says how much of the window asked for fell outside what is still buffered. " +
        "Non-zero means part of the question was never examined, which is a different answer from " +
        "there being nothing there.\n\n" +
        "An empty list means nothing crossed a threshold in this window. It does not mean the app " +
        "is fast, and it does not mean the window contained the problem — check `window` against " +
        "the moment you care about before concluding anything from silence.\n\n" +
        "`alsoInWindow` (present only when there is something to say) is an inventory, not a second " +
        "opinion: process exits, device events, memory samples, GC and memory-trim signals that " +
        "were in the window whether or not they crossed a threshold worth a finding — an exit " +
        "already covered by a finding above still appears here too, because a finding is a " +
        "judgement and this is a count. Absent means genuinely nothing to add, not that this tool " +
        "declined to look.\n\n" +
        "`startup-slow`/`startup-not-fully-drawn` (present only when a `startup` event exists in " +
        "the window) read a debug build's own launch, not a user's: no R8, JIT compilation rather " +
        "than a warm AOT profile, and dexopt in a state release never ships in. Use the total to " +
        "find which phase was slow, not to quote as what a user's release build would see. Every " +
        "launch in the window is judged on its own — reopening the app does not erase an earlier " +
        "slow launch's own finding — but `startup-slow` and the fully-drawn note only ever judge " +
        "the cold launch (`originKind: \"fork\"`): a warm/hot relaunch's `totalMs` starts from the " +
        "relaunched Activity's own onCreate/onStart, already inside the system's own launch work, " +
        "not the launch request `am start -W` (and Android vitals) measure from — which is also why " +
        "`am start -W`'s TotalTime always reads larger than this tool's `totalMs` for the same launch.\n\n" +
        "`http-call-slow` (GRA-66) fires at warning for a call whose own elapsed time was at least " +
        "3000ms — a pragmatic floor, not a platform-defined one, close to the point Google's own " +
        "RAIL guidance treats a wait as a wait rather than a step in a sequence — and names whichever " +
        "OkHttp phase (queued/dns/connect/secureConnect/dispatch/requestHeaders/requestBody/" +
        "waiting/responseBody) took the largest share, when the runtime reported one at all: a Ktor " +
        "call with no OkHttp engine underneath has no phase breakdown to attribute to, and says so " +
        "rather than guessing. Called 'mostly `<phase>`' only when that phase actually is at least " +
        "half of the call's own elapsed time — phases need not sum to it (queueing behind " +
        "`maxRequestsPerHost` and OkHttp's own exchange setup do, as `queued`/`dispatch`, but a redirect " +
        "or an auth-challenge retry's own request/response phases describe only the final leg) — " +
        "below that line it says 'largest phase: `<phase>` (Nms of Mms)' instead, honest about how " +
        "little of the call the largest phase actually explains. Joins the device's own most recent " +
        "`network` event in force when the call started, so a call that ran on a metered cellular " +
        "connection says so instead of just looking slow for no stated reason.\n\n" +
        "`ringSnapshot` (present only on an error-severity finding, only while `system_trace_start` " +
        "has a ring running): a fresh snapshot of it, pulled without blocking this call — a path and " +
        "byte count once it lands, or `{ inProgress: true }` on the call that kicked it off or is " +
        "still waiting on one already in flight. `porthole_status`'s `ring.lastSnapshot` carries the " +
        "same result independently, for when the next `findings` call is not the first place you " +
        "look.",
      inputSchema: windowShape,
      annotations: { readOnlyHint: true },
    },
    async ({ sinceMs, from, to, since }): Promise<ToolResult> => {
      const span = await resolveWindowSince({ sinceMs, from, to, since });
      if (!span) {
        // resolveWindow returns null whenever the ring is empty, which is not
        // the same thing as the device being unreachable — hello can have
        // landed seconds ago with nothing collected yet. Printing the full
        // troubleshooting wall in that case sends the first call after every
        // install chasing a socket that was never the problem.
        //
        // GRA-157: "connected" here is the loose sense porthole_status also
        // uses — the socket is up, whether or not hello has landed — because
        // that is the fact an agent deciding whether to keep polling
        // actually wants. GRA-162: isAttached() replaces the inline
        // `=== "handshaking" || === "connected"` so a fifth ConnectionState
        // fails `tsc` here instead of silently reading as not-connected.
        // GRA-163: this loose sense is safe only because there is no ring
        // content here to mislabel — an empty ring has nothing to claim is
        // live. The non-empty branch below asks a stricter question; see its
        // own comment for why the two cannot share one boolean.
        const connected = isAttached(device.state);
        const pending = device.pendingMessage();
        // GRA-163 QA round 1: called on this branch too now — an empty ring
        // can still have a `lastExited` behind it (reconnect, hello clears
        // the ring, then the new process dies before emitting anything),
        // and `porthole_status` was already reporting that unconditionally
        // while this branch reported nothing at all, which is the exact
        // cross-tool disagreement this ticket exists to remove.
        // `hasBufferedData: false` because this branch is reached only when
        // the ring is empty — the prose must not claim otherwise.
        const exitedProcess = exitedProcessField();
        // `connected: pending === null` (the strict sense) here, not the
        // loose `connected` above — inert in practice since
        // `hasBufferedData: false` short-circuits both of
        // exitedProcessNotice()'s non-exited cases to "", but kept correct
        // rather than passing whichever local happens to be in scope.
        const notice = exitedProcessNotice(exitedProcess, false, pending === null);
        if (pending !== null) {
          return ok(notice + pending, { window: null, findings: [], connected, exitedProcess });
        }
        // GRA-197: the same "leads with it" rule porthole_status's summary
        // follows, on an otherwise unrelated tool — a mismatched app is worth
        // saying here too, not only from porthole_status, since this is
        // often the first tool an agent calls.
        if (device.packageMismatch) {
          return ok(notice + device.packageMismatch, { window: null, findings: [], connected, exitedProcess });
        }
        const summary = `Connected to ${device.hello!.packageName}, nothing buffered yet. Ask again in a moment.`;
        return ok(notice + summary, { window: null, findings: [], connected, exitedProcess });
      }

      const buffered = timeline.buffer();

      // GRA-189: `since: "last"` resolved to a genuinely empty window — the
      // watermark this call would advance from has nothing newer past it,
      // and no previous `findings` digest to re-ask (see `nothingNew`'s own
      // comment on `resolveWindowSince`). Running the analyser over that
      // reports "0s examined," the least useful possible answer to exactly
      // the question `since: "last"` exists to shortcut — so this skips the
      // analysis entirely rather than dressing up an empty result. This is
      // also the device case: a fresh MCP process that loads a watermark an
      // earlier process left on disk lands here whenever nothing has
      // arrived since, and the prose must say "nothing new," not "first
      // call" — `firstEver` is false, because the watermark was not empty,
      // it simply has nothing new past it.
      if (span.nothingNew) {
        const pending = device.pendingMessage();
        const connected = pending === null;
        const exitedProcess = exitedProcessField();
        const notice = exitedProcessNotice(exitedProcess, buffered.length > 0, connected);
        return ok(
          notice +
            `Nothing new has arrived since the last call, which examined up to t=${span.to}. ` +
            'Use since: "all", or an explicit window, for the whole picture.',
          {
            window: { from: span.from, to: span.to, ms: 0 },
            eventsExamined: 0,
            findings: [],
            connected,
            exitedProcess,
          },
        );
      }

      // GRA-53: merges the live buffer with whatever sessions on disk
      // overlap the window, deduplicated and sorted — see
      // `fillWindowFromDisk`'s own doc comment in sessions.ts. `events` here
      // used to be the live ring alone; it is now the same merge
      // `what_was_happening` already uses, so a finding can be produced from
      // a window that spans an MCP-server restart, not only from whatever
      // survived in memory.
      const merged = await mergeWithDisk(span.from, span.to);
      const events = merged.events as unknown as DeviceEvent[];

      // GRA-163: a non-empty ring is not, on its own, proof the events in it
      // are from what is running now — the ring only clears on a new hello
      // (timeline.ts), so anything buffered while state has not reached
      // "connected" could just as easily be a previous session's leftovers.
      // `device.pendingMessage()` is the shared decision point GRA-157 built
      // for exactly this question, and it used to be reachable only from the
      // empty-ring branch above (`!span`) — the one input where a stale,
      // still-buffered ring cannot appear at all. Calling it here too is
      // what makes `connected` strict (true only once hello has actually
      // landed for the session that is being reported on) instead of the
      // loose isAttached() sense used above, where handshaking read as
      // attached even when the ring's contents predated the handshake. That
      // conflation was the measured bug: 34 hardware samples caught this
      // tool reporting `connected: true` about a dead process during a later
      // handshake, because handshaking alone was treated as good enough.
      const pending = device.pendingMessage();
      const connected = pending === null;
      // Structured, not just prose (per the founder-pending assumption this
      // ticket is built on): null once connected, otherwise the process
      // `device` last confirmed and when it exited, so an agent can branch
      // on this without parsing the summary text. `hasBufferedData: true`
      // because this is the non-empty branch — the ring genuinely has
      // events, even if the requested window clips around them.
      const exitedProcess = exitedProcessField();
      const notice = exitedProcessNotice(exitedProcess, true, connected);

      // Asking about a moment the ring no longer holds returns nothing, which is
      // indistinguishable from a moment when nothing happened. They are opposite
      // answers and only one of them is about the app.
      const liveOldest = buffered[0]?.t ?? span.from;
      const liveNewest = buffered[buffered.length - 1]?.t ?? span.to;
      // GRA-53: `clippedMs` is now a coverage question, answered against
      // `merged.coveredFrom`/`coveredTo` (live buffer bounds unioned with
      // every overlapping session's own recorded extent) rather than against
      // the live buffer's bounds alone — see `fillWindowFromDisk`'s doc
      // comment on why this must NOT be derived from which events actually
      // matched: a quiet stretch inside a recorded session must read as
      // covered, not as clipped, just because nothing happened in it. When
      // neither the buffer nor any session on disk overlaps the window at
      // all, `coveredFrom`/`coveredTo` are null and the whole window is
      // honestly unrecorded.
      // GRA-54: the same function `save_moment`'s trace carries this exact
      // number under, so the two cannot drift apart the way two hand-rolled
      // copies of this formula eventually would (see clippedMsOf's own
      // comment in sessions.ts).
      const clipped = clippedMsOf(span.from, span.to, merged.coveredFrom, merged.coveredTo);
      // GRA-185: searched over the live ring (`buffered`), not `events`
      // (which is windowed to `span`) — a profile event before `span.from`
      // must still count. See `resolveProfile`'s own doc comment.
      const profile = resolveProfile({
        liveEvents: buffered,
        windowTo: span.to,
        sessionProfile: device.sessions?.currentMeta()?.profile ?? null,
        hello: (device.hello as unknown as Record<string, unknown>) ?? null,
      });
      const trace = buildTrace({
        // The same analyser the headless capture runs, pointed at the live
        // buffer instead of a recorded scenario. One analyser, so a finding
        // means the same thing in CI as it does in an editor.
        scenario: "live",
        events,
        hello: (device.hello as unknown as Record<string, unknown>) ?? null,
        durationMs: span.ms,
        withEvents: false,
        profile,
      });

      // GRA-72: folded in only when a semantics capture (from `semantics_tree`
      // or `accessibility`) landed inside this exact window — never a fresh
      // RPC of `findings`' own, so a caller who never asked about
      // accessibility never pays for it. See accessibility.ts's own doc
      // comment on `semanticsCaptureForWindow` for the full reasoning.
      const a11yCapture = semanticsCaptureForWindow(span.from, span.to);
      if (a11yCapture) {
        const a11y = lintSemanticsTree(a11yCapture.root, {
          density: a11yCapture.density,
          fontScale: a11yCapture.fontScale,
          capturedAt: a11yCapture.capturedAt,
        });
        trace.findings = sortBySeverity([...trace.findings, ...a11y.findings]);
      }

      const findings = trace.findings.map(withFollowUp);

      // GRA-57, QA R4: a ring snapshot attached to every error-severity
      // finding in this result, when the ring is running — but never
      // *awaited* here. `triggerAutoSnapshotOnError` is synchronous with
      // respect to the snapshot itself: cloning the ring and pulling up to
      // `bufferKb` worth of trace off the device is exactly the adb work
      // GRA-89 made `capture_system_trace` non-blocking for, and the first
      // `findings` call to see a fresh error is not a reason to reintroduce
      // that block. `attached` is a *previous* call's finished snapshot
      // (see that function's own doc comment); `inProgress` says one was
      // just kicked off (or already was) and has not landed yet — `findings`
      // says so in the finding itself rather than going quiet about it.
      // `findingsWithRing` (not `findings`) is what feeds `classify` below,
      // so whichever of the two survives into the classified/new/ongoing
      // shape the payload actually returns.
      const hasErrorFinding = findings.some((f) => f.severity === "error");
      // `findings` (unlike system_trace_start/snapshot/stop) takes no
      // `serial` parameter of its own — PORTHOLE_SERIAL is the only way this
      // path can know which device to scope to on a host with more than one
      // attached, the same fallback `diagnoseAndReconnect` already reads.
      // Without it, more than one attached device makes every adb call here
      // fail with "more than one device/emulator" — silently, by design
      // (this never fails `findings` itself), which was caught on this
      // ticket's own dev host, not assumed.
      const { attached: autoSnapshot, inProgress: autoSnapshotInProgress } = ring.triggerAutoSnapshotOnError(
        hasErrorFinding,
        { serial: process.env.PORTHOLE_SERIAL, env: adbEnv, binary: adbBinary },
      );
      const findingsWithRing =
        autoSnapshot || autoSnapshotInProgress
          ? findings.map((f) =>
              f.severity === "error"
                ? { ...f, ringSnapshot: autoSnapshot ?? { inProgress: true as const } }
                : f,
            )
          : findings;

      // GRA-200: built from the same windowed `events` `trace` itself came
      // from, so this can never name a different window than the findings
      // beside it. See alsoInWindowOf's own comment in trace.ts for why an
      // exit that already produced a finding still appears here too.
      const also = alsoInWindowOf(events);
      const alsoSentence = alsoInWindowSentence(also);

      // GRA-55: classified against whatever the *previous* findings call
      // left in the watermark, before this call's own digest overwrites it
      // — order matters here, `recordDigest` below must come after reading
      // `previousDigest`, not before.
      const previousDigest = watermark.get().digest;
      const classified = classify(findingsWithRing, previousDigest, span.sinceLast, {
        from: span.from,
        to: span.to,
      });
      await watermark.recordDigest({
        findings: trace.findings.map((f) => ({ id: f.id, count: f.count ?? 1 })),
        window: { from: span.from, to: span.to },
        sinceLast: span.sinceLast,
      });
      const classificationNote = classified.counts
        ? ` (${classificationSummary(classified.counts)})`
        : classified.skippedNote
          ? ` (${classified.skippedNote})`
          : "";
      const payload = {
        window: { from: span.from, to: span.to, ms: span.ms },
        // The merged (disk + memory) recorded extent, clipped to the window
        // — distinct from `buffered` below, which stays the live ring's own
        // account of itself.
        examined: { from: merged.coveredFrom ?? span.from, to: merged.coveredTo ?? span.from },
        buffered: { from: liveOldest, to: liveNewest, events: buffered.length },
        clippedMs: clipped,
        eventsExamined: events.length,
        metrics: trace.metrics,
        // Classified findings (new/ongoing/resolved, per `classify()`'s own
        // comment on when that runs) rather than the plain list — `resolved`
        // entries can make this longer than `findings.length` below, which
        // stays keyed on what is *currently* true, not on what changed.
        findings: classified.findings,
        connected,
        exitedProcess,
        // GRA-200: absent, not `{}` or all-undefined, when there is nothing
        // to list — see alsoInWindowOf's own comment for why this is what
        // keeps the common case's payload byte-identical to before this
        // ticket. The spread (not `alsoInWindow: also`) is what actually
        // omits the key when `also` is `undefined`, rather than shipping a
        // key whose value happens to be `undefined`.
        ...(also ? { alsoInWindow: also } : {}),
      };

      const shortfall = clipped.start + clipped.end;
      const missing =
        shortfall > 0
          ? ` ${Math.round(shortfall / 100) / 10}s of the window asked for is older or newer than ` +
            "anything buffered, so it was not examined at all."
          : "";

      if (findings.length === 0) {
        return ok(
          notice +
            (shortfall > span.ms * 0.5
              ? `Almost none of that window is in the buffer${missing} This is not a quiet app; ` +
                "it is a question the buffer cannot answer."
              : `Nothing crossed a threshold in the ${Math.round(span.ms / 1000)}s examined ` +
                `(${events.length} events). That is not the same as the app being fast.${missing}`) +
            classificationNote +
            (alsoSentence ? ` ${alsoSentence}` : ""),
          payload,
        );
      }

      const worst = trace.findings[0];
      const bySeverity = trace.findings.reduce<Record<string, number>>((acc, f) => {
        acc[f.severity] = (acc[f.severity] ?? 0) + 1;
        return acc;
      }, {});
      const tally = Object.entries(bySeverity)
        .map(([severity, n]) => `${n} ${severity}`)
        .join(", ");

      return ok(
        notice +
          `${findings.length} finding(s) over ${Math.round(span.ms / 1000)}s (${tally}). ` +
          `Worst: ${worst.title} [${worst.confidence}].${missing}${classificationNote}` +
          (alsoSentence ? ` ${alsoSentence}` : ""),
        payload,
      );
    },
  );

  server.registerTool(
    "system_context",
    {
      title: "What the rest of the device was doing",
      description:
        "Thermal state, CPU governor and clock, the busiest processes, and system memory pressure. " +
        "Read straight off the device over adb.\n\n" +
        "This is the half Porthole cannot see. It watches one process, so when `blocking` reports a " +
        "stall whose stack bottoms out in a native read, or `frames` blames swapBuffers, the reason " +
        "is usually below the app and none of the other tools can reach it. A throttled device, a " +
        "governor holding the cores down, or another process eating the CPU explains a regression " +
        "that no code change accounts for.\n\n" +
        "Reports only what it read. Values are current, not historical — this says what is true now, " +
        "not what was true during a window you are investigating, so take it while the problem is " +
        "happening. Sources it could not parse are listed in `unavailable` rather than omitted, " +
        "because a missing thermal reading and a cool device are not the same thing.\n\n" +
        "It draws no conclusions. Two cores below maximum is a fact; that it is why your app is " +
        "slow is a guess, and this tool does not know what your app was doing.",
      inputSchema: {
        serial: z
          .string()
          .optional()
          .describe("Device serial, when more than one is attached. `adb devices` lists them."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ serial }): Promise<ToolResult> => {
      const unavailable: SystemContext["unavailable"] = [];

      const read = (source: string, args: string[]): string | null => {
        const result = runAdb(args, serial);
        if (!result.ok) {
          unavailable.push({ source, reason: result.output.split("\n")[0].slice(0, 160) });
          return null;
        }
        return result.output;
      };

      const thermalOut = read("thermalservice", ["shell", "dumpsys", "thermalservice"]);
      const cpuOut = read("cpufreq", ["shell", CPU_PROBE]);
      const topOut = read("cpuinfo", ["shell", "dumpsys", "cpuinfo"]);
      const memOut = read("meminfo", ["shell", "dumpsys", "meminfo"]);

      const context: SystemContext = {
        thermal: thermalOut === null ? null : parseThermal(thermalOut),
        cpu: cpuOut === null ? null : parseCpu(cpuOut),
        top: topOut === null ? [] : parseTop(topOut),
        memory: memOut === null ? null : parseMemory(memOut),
        unavailable,
      };

      return ok(describeSystem(context), context);
    },
  );

  server.registerTool(
    "ask_system_trace",
    {
      title: "Ask a system trace about a window",
      description:
        "Runs a fixed set of questions against a recorded trace, scoped to one window and one " +
        "process, and returns findings in the same vocabulary as everything else here.\n\n" +
        "It performs, without a person, the steps someone otherwise does by hand in a trace " +
        "viewer: find the moment worth looking at, drag out the window, pick the app out of the " +
        "process list, and export. Porthole already holds all four — the window comes from a " +
        "finding, the package from the handshake with the device — which is the only reason this " +
        "can be automated at all.\n\n" +
        "What it is for is ruling causes out. `findings` can say a frame was late and that " +
        "composition dominated it. It cannot say whether the device was starving the app of CPU, " +
        "blocking it on I/O, or compiling its own bytecode in the background. Answering no to " +
        "each of those is what turns a suspicion into a conclusion, and answering yes to one " +
        "means the app's own work was never the whole story.\n\n" +
        "Deliberately not a SQL interface. The questions are fixed, because an agent handed a " +
        "hundred tables and no guidance assembles an answer from whichever guess came back " +
        "non-empty — which is the failure this whole surface was reshaped to avoid. The full " +
        `set: ${questionsDescription()}.\n\n` +
        "`jank`, `binder`, `render`, `slices`, `startup` and `monitor_contention` point at a " +
        "moment; `thread_states` and `cpu` are a property of the whole window instead and never " +
        "carry one. `cpu` also never asserts causation — it says where the main thread ran and " +
        "who else wanted the same cores during a window something else already flagged, not why " +
        "that window was slow — and it stays silent unless running time on a little core, or at a " +
        "throttled frequency (a different bar for a little core than a big one), cleared 5% of " +
        "the window's own duration, not a fixed number of milliseconds regardless of how long the " +
        "window was.\n\n" +
        "Needs `trace_processor_shell`, which is not bundled — it is a large platform-specific " +
        "binary — but is fetched on request: `./gradlew portholeTraceProcessor` downloads the " +
        "pinned release, checks its SHA-256 and caches it where this tool looks.",
      inputSchema: {
        trace: z.string().describe("Path to a .pftrace, as returned by capture_system_trace."),
        from: z
          .number()
          .int()
          .optional()
          .describe("Window start on the device uptime clock. Quote a finding's `window`."),
        to: z.number().int().optional().describe("Window end, same clock."),
        packageName: z
          .string()
          .optional()
          .describe("Defaults to the app the porthole is attached to."),
        traceProcessor: z.string().optional().describe("Path to trace_processor_shell."),
        ask: z
          .array(z.string())
          .optional()
          .describe(
            `Which questions to ask, by id. Defaults to every one of them: ${questionsDescription()}. ` +
              "An id that is not one of these is reported back in `unanswered` rather than rejected " +
              "outright, the same as a question that failed to compile.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ trace, from, to, packageName, traceProcessor, ask }): Promise<ToolResult> => {
      // GRA-157: connection state checked before the trace_processor lookup,
      // not after. A device still mid-handshake is not the caller's fault and
      // not fixed by anything on this machine, so naming that first means a
      // caller who has not connected yet is never told to go install a
      // binary when the real, more immediate blocker is the device.
      const app = packageName ?? device.hello?.packageName;
      if (!app) {
        // "Connect to the app" was printed even while the socket was already
        // connected and just waiting on hello — telling someone to do a
        // thing that is already in progress. Naming the handshake instead of
        // the generic advice is the whole fix; the advice itself (pass
        // `packageName`) still applies either way.
        // GRA-162: isHandshaking() instead of `=== "handshaking"` — same
        // exhaustiveness argument as isAttached() above.
        const because =
          isHandshaking(device.state)
            ? "the app is still waiting on its first check-in — try again in a moment, "
            : "connect to the app, ";
        return fail(
          `No package to scope to: ${because}or pass \`packageName\` — without it the questions ` +
            "answer for the whole device, which is a different question.",
        );
      }

      const binary = traceProcessor ?? process.env.PORTHOLE_TRACE_PROCESSOR ?? findTraceProcessor();
      if (!binary) {
        return fail(
          "No trace_processor_shell found. Run `./gradlew portholeTraceProcessor` in the app's " +
            "project: it downloads the pinned Perfetto release, verifies its checksum and caches " +
            "it where this tool looks, so nothing further needs configuring. An existing copy " +
            "works too — set PORTHOLE_TRACE_PROCESSOR or pass `traceProcessor`. Either way the " +
            "trace itself is already readable at ui.perfetto.dev.",
        );
      }

      // The window arrives in Porthole's clock and the trace is stamped in the
      // boot clock, so it has to be converted before it means anything here.
      const events = timeline.buffer();
      const span = resolveWindow({ from, to });
      if (!span) {
        // GRA-154 (absorbed into GRA-157 AC7): this used to say "Nothing
        // buffered" unconditionally — a third, different vocabulary from
        // findings/what_was_happening for the identical empty-ring
        // condition. pendingMessage() brings the wording in line with
        // theirs. This one stays an error result rather than switching to
        // `ok` like the other two: there is genuinely no window here to ask
        // trace_processor about, nothing partial to return the way an empty
        // findings list or a "nothing happened here" moment still can.
        const pending = device.pendingMessage();
        return fail(
          pending ??
            "Connected, but nothing buffered yet, so there is no window to scope the trace to. " +
              "Ask again in a moment.",
        );
      }
      // GRA-113: the one conversion, through moment.ts's toBoot — this used
      // to read whichever `clocks` sample `events.find()` happened to
      // return first and apply it to both bounds, the same open-coded bug
      // that ticket fixed in timeline.ts. toBoot picks the sample actually
      // in force at each boundary separately (so a sleep that happened
      // between `from` and `to` is reflected correctly instead of averaged
      // away), and hands back the offset it used so this tool can still
      // report `sleepMs` the way its payload always has.
      const bootFrom = toBoot(events, span.from);
      const bootTo = toBoot(events, span.to);

      // GRA-231: without a `toUptimeMs` converter, `interpret()` (perfetto.ts)
      // has no way to place any point-placeable finding — startup included —
      // and every one of them comes back `spanning: true` instead of its own
      // `window` (see `rowsWindow`/`place` there). The reconciliation below
      // needs `trace-startup`'s own window to test against a runtime
      // `startup` event's window, so this tool needs the same wrapper around
      // `fromBootMs` that `timeline.ts` already builds for its own `askTrace`
      // call.
      const toUptimeMs = (bootNs: number) => fromBootMs(events, bootNs / 1e6)?.at ?? null;

      // GRA-234: stat `trace` before spending a trace_processor invocation
      // trying to load it. Without this, a bad path (typo, a trace already
      // cleaned up, one copied from the wrong session) reached askTrace()
      // anyway, where every one of QUESTIONS failed to load it independently
      // and came back unanswered — "8 question(s) failed" instead of the one
      // sentence a caller actually needed. `asked`/`unanswered`/`findings`
      // all come back empty here, not populated and then discarded, so nothing
      // downstream reads a phantom result off a file that was never opened.
      const traceCheck = checkTracePath(trace);
      if (!traceCheck.ok) {
        return ok(traceCheck.message!, {
          trace,
          app,
          window: { from: span.from, to: span.to, sleepMs: bootTo.sleepMs },
          asked: [],
          skipped: [],
          wallTimeMs: {},
          unanswered: [],
          findings: [],
        });
      }

      const {
        findings: traceFindings,
        unanswered,
        asked,
        skipped,
        wallTimeMs,
      } = await askTrace({
        binary,
        trace,
        packageName: app,
        fromNs: bootFrom.ns,
        toNs: bootTo.ns,
        ask,
        toUptimeMs,
      });

      // GRA-231: this session's own runtime `startup` events (already on
      // this session's uptime clock, same as `traceFindings`' own `window`
      // after `toUptimeMs` — see toBoot/toUptimeMs above) reconciled against
      // whichever `trace-startup` finding(s) just came back, before
      // `withFollowUp` — a `startup-reconciliation-*` note is exactly as
      // followable as anything else in this list.
      const findings = reconcileStartupWithTrace(traceFindings, events).map(withFollowUp);
      const payload = {
        trace,
        app,
        // bootTo's offset, not bootFrom's: if the device slept between the
        // two, the more recent sample is the more representative one to
        // report.
        window: { from: span.from, to: span.to, sleepMs: bootTo.sleepMs },
        // GRA-61: `asked` is now only what `ask` actually selected (every
        // question, when `ask` is omitted) — `skipped` names the rest, so a
        // caller can tell "not asked this time" apart from "asked and
        // unanswered", the two `unanswered` alone cannot distinguish.
        asked,
        skipped,
        wallTimeMs,
        unanswered,
        findings,
      };

      const failures = unanswered;
      const summary = findings.length
        ? `${findings.length} finding(s) from the trace. ${findings[0].title}.`
        : "The trace had nothing to add about that window.";
      return ok(
        summary +
          (failures.length ? ` ${failures.length} question(s) failed.` : "") +
          (skipped.length ? ` ${skipped.length} question(s) not asked.` : ""),
        payload,
      );
    },
  );

  server.registerTool(
    "capture_system_trace",
    {
      title: "Record a Perfetto trace",
      description:
        "Records a system trace on the device, pulls it to disk, and returns the path. Does not " +
        "return the trace itself: a ten-second capture is tens of megabytes of protobuf, and it is " +
        "not something to read — it is something to open.\n\n" +
        "The reason to take one here rather than by hand is that the app's own spans are already " +
        "inside it. The runtime writes navigations, HTTP calls, queries and main-thread stalls as " +
        "atrace sections, so the capture arrives annotated with what the app was doing and not only " +
        "what the kernel was doing. The result says how many Porthole labels it found, which is how " +
        "you know the annotation actually happened.\n\n" +
        "Use it when Porthole has found something it cannot explain — a stall whose stack bottoms " +
        "out below the app, or jank blamed on swapBuffers — and you need to see what the rest of " +
        "the system was doing at that moment. `findings` gives you the window worth looking at; " +
        "this gives you the depth at it.\n\n" +
        "`restartApp` force-stops and relaunches the target app right after the capture starts — " +
        "needed on builds that only read the app trace tag at process start (seen on a Pixel 9 " +
        "Pro Fold, Android 17), where an already-running process's own sections would otherwise " +
        "be silently missing, at the cost of the trace containing a cold start.\n\n" +
        "Blocks for the requested duration. Reproduce the problem while it runs.",
      inputSchema: {
        seconds: z
          .number()
          .int()
          .positive()
          .max(120)
          .optional()
          .describe("How long to record. Default 10."),
        categories: z
          .array(z.string())
          .optional()
          .describe(
            "atrace categories. Defaults to a set aimed at jank. `app` is always included, " +
              "since without it none of Porthole's own sections are recorded.",
          ),
        outputDir: z
          .string()
          .optional()
          .describe("Where to write it. Defaults to .porthole/traces under the working directory."),
        packages: z
          .array(z.string())
          .optional()
          .describe(
            "Packages whose app-tag sections to record. Defaults to the app the porthole is " +
              "attached to. Without one, the trace has no Porthole slices in it.",
          ),
        serial: z.string().optional().describe("Device serial, when more than one is attached."),
        restartApp: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Force-stop and relaunch the target app right after the capture starts, since on " +
              "builds that only read the app trace tag at process start (seen on a Pixel 9 Pro " +
              "Fold, Android 17) an already-running process's own sections never appear — the " +
              "trade-off is a cold start inside the trace. The package is the first entry of " +
              "`packages`, or the attached app when `packages` is omitted. Default false.",
          ),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ seconds, categories, outputDir, packages, serial, restartApp }): Promise<ToolResult> => {
      // GRA-157: `device.hello ? [...] : []` used to fall through to an
      // unscoped capture — silently, with nothing in the result saying so —
      // whenever this landed in the handshake window, since state was
      // already "connected" there under the old model. An unscoped capture
      // has none of Porthole's own slices in it, which defeats the point of
      // this tool, so when we can name the actual reason (a hello is
      // genuinely on its way) this fails and says so instead of guessing.
      // Fully disconnected keeps the old permissive behaviour: apps: []
      // captures the whole device, same as always.
      // GRA-162: isHandshaking() instead of `=== "handshaking"`.
      if (!packages?.length && isHandshaking(device.state)) {
        return fail(
          "Still waiting on the app's first check-in, so there is no package to scope this " +
            "capture to yet. Try again in a moment, or pass `packages` explicitly to capture " +
            "unscoped right now.",
        );
      }
      // Default to whatever app the porthole is attached to: that is the one
      // whose sections are worth recording, and asking for it again is friction.
      const apps = packages?.length ? packages : device.hello ? [device.hello.packageName] : [];
      const plan = planCapture({ seconds, categories, apps });
      const adbCallOptions: AdbCallOptions = { serial, env: adbEnv, binary: adbBinary };

      // GRA-89: async, awaited spawn for all three adb calls below, not
      // `runAdb`'s `spawnSync` — that used to freeze the whole MCP server
      // for the entire recording (up to two minutes at this tool's own
      // 120s maximum): nothing read the device socket, nothing answered
      // another tool call, and the timeline WebSocket went silent for as
      // long as each call took. The recording gets its own, longer timeout
      // (the plan's own duration plus room for adb's own startup and
      // teardown) rather than `runAdbAsync`'s short default, which exists
      // for calls — the pull, the cleanup — that are supposed to be quick.
      //
      // GRA-186: not awaited here any more. `restartApp: true` has to act
      // *during* this recording, not after it — awaiting first would mean
      // "restarting" only once the whole window is already over, which is
      // the exact bug this option exists to work around.
      const recordingPromise = runAdbAsync(captureArgs(plan), {
        ...adbCallOptions,
        timeoutMs: plan.seconds * 1000 + CAPTURE_ADB_TIMEOUT_BUFFER_MS,
        onProgress: (elapsedMs) =>
          process.stderr.write(
            `[porthole] capture_system_trace: recording, ${Math.round(elapsedMs / 1000)}s of ` +
              `${plan.seconds}s elapsed...\n`,
          ),
      });

      // GRA-186: on a build that only reads ATRACE_TAG_APP at process
      // attach (Pixel 9 Pro Fold, Android 17), a process already running
      // when the session starts never picks the tag up — a process that
      // (re)starts after the session has begun does. Restarting here, once
      // `waitForCaptureToStart` has the best available signal that the
      // session is live, is the fix; see systrace.ts's zero-label sentence
      // for the diagnosis this is a remedy for.
      let restarted = false;
      const restartNotes: string[] = [];
      if (restartApp) {
        const target = apps[0];
        if (!target) {
          restartNotes.push(
            "Could not restart the app for this capture: no package is attached or named, so " +
              "there is nothing to restart.",
          );
        } else {
          await waitForCaptureToStart(plan.devicePath, adbCallOptions);
          const restartResult = await restartAppAsync(target, adbCallOptions);
          restarted = restartResult.ok;
          if (!restartResult.ok) {
            restartNotes.push(`Could not restart ${target} for this capture: ${restartResult.output}`);
          }
        }
      }

      const recorded = await recordingPromise;
      if (!recorded.ok) {
        return fail(
          `Could not record: ${recorded.output}\n` +
            "On-device Perfetto needs Android 9 or newer, and the traced service must be running.",
        );
      }

      // Default under .porthole/, which the project's gitignore already covers —
      // a multi-megabyte trace should not be a candidate for committing.
      const dir = resolve(outputDir ?? join(process.cwd(), ".porthole", "traces"));
      mkdirSync(dir, { recursive: true });
      const local = join(dir, plan.devicePath.split("/").pop() as string);

      const pulled = await runAdbAsync(["pull", plan.devicePath, local], adbCallOptions);
      // Tidy up regardless: the device's trace directory is not ours to fill.
      await runAdbAsync(["shell", "rm", "-f", plan.devicePath], adbCallOptions);

      if (!pulled.ok) return fail(`Recorded, but could not pull it: ${pulled.output}`);

      const bytes = statSync(local).size;
      const result = {
        path: local,
        bytes,
        seconds: plan.seconds,
        categories: plan.categories,
        apps: plan.apps,
        restarted,
        // GRA-89: streamed in chunks by countPortholeLabels itself now, not
        // a whole-file readFileSync handed to it — see systrace.ts.
        portholeLabels: await countPortholeLabels(local),
        notes: [...plan.notes, ...restartNotes],
      };
      return ok(describeCapture(result), result);
    },
  );

  server.registerTool(
    "system_trace_start",
    {
      title: "Start a continuous system trace ring buffer",
      description:
        "Starts a Perfetto session that records continuously into a fixed-size in-memory ring " +
        "buffer, detached so it survives this MCP server and outlives the adb shell that started " +
        "it. Unlike `capture_system_trace`, this does not block and does not need a human standing " +
        "by to reproduce anything: the point is to have a system trace already running so " +
        "`system_trace_snapshot` can pull the last stretch of it *after* something already went " +
        "wrong, not before.\n\n" +
        "Opt-in only — nothing here runs until this tool is called, and there is no default-on " +
        "path. The EM's own re-scope on this ticket made that the condition for shipping it at " +
        "all: continuous `sched` tracing had to be measured cheap enough first. It was, on an " +
        `emulator, under a light synthetic workload: ${MEASURED_OVERHEAD.cpuPercentOfOneCore}% of ` +
        "one core combined across traced/traced_probes/the detached perfetto process — see " +
        "`porthole_status`'s `ring.overhead` for the same number with its own caveats. Hardware " +
        "measurement under real load is a separate, ongoing pass; treat the emulator number as a " +
        "starting point, not a guarantee, and turn this off (`system_trace_stop`) when done hunting.\n\n" +
        "Survives an adb disconnect and a screen-off: confirmed on an emulator by starting a " +
        "session, cycling the host's adb server (`adb kill-server`/`adb devices`) and separately " +
        "putting the device to sleep (`input keyevent 26`) for 15+ seconds, and finding the " +
        "session still present both times. Also survives the target app being killed and " +
        "restarted — the ring is a device-level session, not tied to any one process's lifetime. " +
        "Doze was not usefully testable: an emulator's `dumpsys deviceidle force-idle` jumps " +
        "straight to the IDLE state without the real hardware path (actual CPU/radio suspension), " +
        "so a pass there would prove only that the simulated state doesn't kill the session, not " +
        "that real deep sleep on a phone would not. Left for the hardware pass.\n\n" +
        "Only one ring can run at a time, whatever app it is scoped to — call `system_trace_stop` " +
        "before starting a different one. `system_trace_snapshot` pulls from it without " +
        "interrupting it; `capture_system_trace` keeps working exactly as before, independent of " +
        "this.",
      inputSchema: {
        app: z
          .string()
          .optional()
          .describe(
            "The package whose ATRACE_TAG_APP sections to record. Defaults to the app the porthole " +
              "is attached to. A ring scoped to no package has no Porthole sections in it, the same " +
              "problem `capture_system_trace` warns about.",
          ),
        categories: z
          .array(z.string())
          .optional()
          .describe("atrace categories. Defaults to the same set capture_system_trace uses."),
        bufferKb: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Ring buffer size in KB. Defaults to 32768 (32MB), sized for roughly 30s of the sample " +
              "app, but the true span is a function of how much the device is doing, not a " +
              "promise — see `system_trace_snapshot`'s own result.",
          ),
        serial: z.string().optional().describe("Device serial, when more than one is attached."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ app, categories, bufferKb, serial }): Promise<ToolResult> => {
      const target = app ?? device.hello?.packageName ?? "";
      const started = await ring.start({
        app: target,
        categories,
        bufferKb,
        // QA F18: falls back to PORTHOLE_SERIAL, same as porthole_status/
        // porthole_connect and findings' own auto-snapshot — without it,
        // more than one attached device makes this fail with "more than one
        // device/emulator" even when every other tool works, because it was
        // the one place that still passed the bare `serial` argument
        // through with nothing to fall back to.
        serial: serial ?? process.env.PORTHOLE_SERIAL,
        env: adbEnv,
        binary: adbBinary,
      });
      if (!started.ok) return fail(started.message);
      const summary =
        `Ring started, scoped to ${started.plan.app}, ${started.plan.bufferKb}KB buffer, ` +
        `${started.plan.categories.length} categories. Call system_trace_snapshot to pull the ` +
        "last stretch of it at any time, or system_trace_stop to end it.";
      return ok(summary, started);
    },
  );

  server.registerTool(
    "system_trace_snapshot",
    {
      title: "Flush the running ring buffer to a file",
      description:
        "Pulls the ring buffer's current contents to a file on disk, without interrupting the " +
        "ring itself — it keeps recording. Use this the moment after something goes wrong: the " +
        "trace has already been collecting, so there is no reproduction step to wait through.\n\n" +
        "Works even from a fresh MCP server that never called system_trace_start itself: this " +
        "checks the device's own pid marker (and a process-table scan when that marker is " +
        "missing) before concluding there is nothing to snapshot, the same way porthole_status " +
        "does. A ring discovered this way is still snapshotted correctly, but its start time and " +
        "buffer size are honestly unknown here — the result's `note` says so.\n\n" +
        "Uses Perfetto's `--clone-by-name`, discovered by this ticket's own spike rather than the " +
        "detach/attach/stop sequence its research brief named — that sequence turned out to " +
        "require `write_into_file`, which turns the on-device file into a continuously growing " +
        "stream rather than a ring, and stopping-to-flush would have interrupted the very " +
        "recording this tool exists to keep running. `--clone-by-name` reads the session's buffer " +
        "into a brand new file and leaves the original untouched; confirmed on the spike's " +
        "emulator by finding the source perfetto process still present in `ps` immediately after " +
        "a pull.\n\n" +
        "The result's `note` says how much of it is trustworthy: the buffer is sized for roughly " +
        "30s at default settings, but under real load it can wrap sooner, and this host has no way " +
        "to verify the actual covered span from outside the trace itself — read it with " +
        "`ask_system_trace` for that. `portholeLabels` counts the runtime's own atrace sections in " +
        "the snapshot, the same check `capture_system_trace` reports, and the ring's own config " +
        "carries the same data sources that capture uses (frame timeline, process/thread names) so " +
        "`ask_system_trace` gets real findings from a ring snapshot, not just from a one-shot capture.",
      inputSchema: {
        outputDir: z.string().optional().describe("Where to write it. Defaults to .porthole/traces."),
        serial: z.string().optional().describe("Device serial, when more than one is attached."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ outputDir, serial }): Promise<ToolResult> => {
      // QA F18: same PORTHOLE_SERIAL fallback as system_trace_start/stop.
      const snapshot = await ring.snapshot({
        outputDir,
        serial: serial ?? process.env.PORTHOLE_SERIAL,
        env: adbEnv,
        binary: adbBinary,
      });
      if (!snapshot.ok) return fail(snapshot.message);
      const mb = (snapshot.bytes / (1024 * 1024)).toFixed(1);
      // QA F20: the same count capture_system_trace reports, so the exact
      // failure GRA-186 was filed against (a capture that succeeds but
      // carries none of the runtime's own atrace sections) has evidence on
      // the ring path too, not only the one-shot capture path.
      const portholeLabels = await countPortholeLabels(snapshot.path);
      const labelsSentence =
        portholeLabels > 0
          ? `${portholeLabels} Porthole track(s) in it.`
          : "No Porthole labels found in it — either nothing the runtime annotates happened in " +
            "this window, or the app tag was not being read (see capture_system_trace's own notes " +
            "on this).";
      const result = { ...snapshot, portholeLabels };
      return ok(`Snapshot pulled to ${snapshot.path} (${mb}MB). ${labelsSentence} ${snapshot.note}`, result);
    },
  );

  server.registerTool(
    "system_trace_stop",
    {
      title: "Stop the ring buffer",
      description:
        "Stops the running ring and cleans up after it: the backgrounded perfetto process on the " +
        "device is killed, and every file this feature could have left behind (the PID marker, the " +
        "config, any flushed or snapshotted trace) is removed. Safe to call even when nothing is " +
        "known to be running here — including after this MCP server restarted and no longer " +
        "remembers starting anything: this reads the device's own pid marker first, and falls back " +
        "to scanning the device's process table by name when that marker is missing (it is written " +
        "best-effort and can be absent even for a session that is genuinely running), so a session " +
        "started by a process this one has no memory of is still found and killed.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial, when more than one is attached."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ serial }): Promise<ToolResult> => {
      // QA F18: same PORTHOLE_SERIAL fallback as system_trace_start/snapshot.
      const stopped = await ring.stop({ serial: serial ?? process.env.PORTHOLE_SERIAL, env: adbEnv, binary: adbBinary });
      return ok(stopped.message, stopped);
    },
  );

  server.registerTool(
    "save_moment",
    {
      title: "Save what just happened",
      description:
        "Turns a window of what already happened into a named trace file on disk, in exactly the " +
        "format `capture` writes — `porthole report` and `porthole compare` work on it with no " +
        "changes. For when the developer pokes the app, something bad happens, and only then wants " +
        "to keep it: no need to reproduce it again with a recording running.\n\n" +
        "Give it a window the way every other windowed tool takes one — `sinceMs`, or `from`/`to` " +
        "quoted from a `findings` result — plus an optional `scenario` name. `scenario` defaults to " +
        "`moment-<from>-<to>` on the uptime clock when omitted, and `out` defaults to " +
        "`.porthole/traces/<scenario>.json`, the same directory `capture_system_trace` uses.\n\n" +
        "The events come from the same merged live-buffer-plus-disk view `findings` and " +
        "`what_was_happening` already use, so a save over a window quoted from a `findings` result " +
        "produces the same findings `findings` reported for it. `clippedMs` in the result says how " +
        "much of the requested window was never actually recorded — a window reaching before the " +
        "session started reports that honestly rather than silently writing a shorter trace.",
      inputSchema: {
        ...windowShape,
        scenario: z
          .string()
          .optional()
          .describe("What to call this. Defaults to moment-<from>-<to> on the uptime clock."),
        out: z
          .string()
          .optional()
          .describe("Where to write the trace. Defaults to .porthole/traces/<scenario>.json."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ sinceMs, from, to, since, scenario, out }): Promise<ToolResult> => {
      const span = await resolveWindowSince({ sinceMs, from, to, since });
      if (!span) {
        // Same shape as ask_system_trace's empty-ring refusal: there is
        // genuinely no window to save here, nothing partial to write.
        return fail(
          "No window to save: nothing is buffered live and no absolute `from`/`to` was given. " +
            "Quote a `window` from an earlier `findings` result, or pass `from`/`to` directly.",
        );
      }

      const merged = await mergeWithDisk(span.from, span.to);
      const events = merged.events as unknown as DeviceEvent[];
      // Post-mortem is the whole point of this tool, so `device.hello` alone
      // is not enough — the app may well have exited since the moment being
      // saved. Falls back to the last confirmed process's own hello, the
      // same source `currentIdentity()` already trusts for exactly this.
      const helloLike = device.hello ?? device.lastExited?.hello ?? null;
      const hello = (helloLike as unknown as Record<string, unknown>) ?? null;

      let resolvedScenario: string;
      let outPath: string;
      try {
        resolvedScenario = scenario === undefined ? defaultScenarioName(span.from, span.to) : validateScenario(scenario);
        outPath = out ?? defaultOutPath(resolveProjectRoot().directory, resolvedScenario);
      } catch (error) {
        if (error instanceof InvalidScenarioError) return fail(`save_moment: ${error.message}`);
        throw error;
      }

      // GRA-185: same resolution `findings` uses — searched over the live
      // ring, not `events` (windowed to `span`), so a profile before
      // `span.from` still counts.
      const profile = resolveProfile({
        liveEvents: timeline.buffer(),
        windowTo: span.to,
        sessionProfile: device.sessions?.currentMeta()?.profile ?? null,
        hello,
      });
      const trace = buildSavedTrace({
        events,
        hello,
        window: { from: span.from, to: span.to },
        coveredFrom: merged.coveredFrom,
        coveredTo: merged.coveredTo,
        scenario: resolvedScenario,
        profile,
      });
      await writeSavedTrace(trace, outPath);

      const findings = trace.findings.map(withFollowUp);
      return ok(
        `Saved "${resolvedScenario}" (${trace.findings.length} finding(s)) to ${outPath}.` +
          coverageNote(trace.clippedMs),
        {
          scenario: resolvedScenario,
          out: outPath,
          window: { from: span.from, to: span.to, ms: span.ms },
          clippedMs: trace.clippedMs,
          metrics: trace.metrics,
          findings,
        },
      );
    },
  );

  server.registerTool(
    "what_was_happening",
    {
      title: "What was happening at a moment",
      description:
        "The narrative for one instant: which screen, with what arguments, what was in flight, what " +
        "the main thread was doing, and what state had just been written.\n\n" +
        "Built for the question a system trace cannot answer. Perfetto will tell you which threads " +
        "ran at 00:42.318 and for how long; it has no idea that you had just opened the cart, that " +
        "a checkout call had been open for 600ms, or that the query blocking the frame was on the " +
        "main thread. Paste the timestamp here and get the part Perfetto is missing.\n\n" +
        "Give it `at` in the device uptime clock every Porthole event carries, or `bootMs` for a " +
        "CLOCK_BOOTTIME reading taken from a Perfetto trace — the two differ by however long the " +
        "device has been in deep sleep, and the conversion uses the clock sample in force at that " +
        "moment rather than the newest one.\n\n" +
        "Durations are as they were then, not as they turned out. A call open for 600ms at the " +
        "moment asked about reports 600ms even if it ran for four seconds, because the question is " +
        "what was true then. A span that never finished says so.\n\n" +
        "Bounded by what the timeline server still holds. A moment older than the buffer cannot be " +
        "answered and will say so rather than return an empty one, which would read as 'nothing " +
        "was happening'.",
      inputSchema: {
        at: z
          .number()
          .int()
          .optional()
          .describe("The moment, in the device uptime clock. Omit if giving `bootMs`."),
        bootMs: z
          .number()
          .int()
          .optional()
          .describe(
            "The moment as CLOCK_BOOTTIME milliseconds, which is what a Perfetto trace stamps with.",
          ),
        spreadMs: z
          .number()
          .int()
          .positive()
          .max(60_000)
          .optional()
          .describe("How far either side to look for context. Default 2000."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ at, bootMs, spreadMs }): Promise<ToolResult> => {
      const events = timeline.buffer();
      if (events.length === 0) {
        // GRA-154, absorbed into GRA-157 as AC7: an empty ring is not the
        // same as a disconnected device — hello can have landed seconds ago
        // with nothing collected yet, and printing the "Not connected" wall
        // in that case blames the connection for a buffer that is merely
        // young. Same distinction `findings` and `porthole_status` make,
        // through the same method, so all three tell the same story about
        // an empty-but-attached device instead of each guessing separately.
        //
        // GRA-166 item 3 / GRA-163: `connected` is the loose sense (mirrors
        // findings' own empty-ring arm — handshaking counts as attached,
        // not just connected). Safe here for the same reason it is safe
        // there: an empty ring has no content to mislabel. The non-empty
        // branch below asks the strict question instead.
        const connected = isAttached(device.state);
        const pending = device.pendingMessage();
        // GRA-163 QA round 1: same fix as findings' empty-ring arm — an
        // empty ring can still have a `lastExited` behind it, and
        // `porthole_status` was already reporting that unconditionally
        // while this branch reported nothing, the same cross-tool
        // disagreement. `hasBufferedData: false`: this branch is reached
        // only when the ring is empty.
        const exitedProcess = exitedProcessField();
        // Inert in practice (see findings' identical comment above) but the
        // strict sense, correctly, not whichever local is in scope.
        const notice = exitedProcessNotice(exitedProcess, false, pending === null);

        // GRA-53: this is AC1's exact shape — the MCP server was just
        // (re)started, so the live ring is empty by construction, but the
        // moment being asked about may still be sitting on disk from before
        // the restart. Tried before falling back to either "not connected"
        // or "nothing buffered yet", since a real answer beats both.
        if (at !== undefined) {
          const merged = await mergeWithDisk(0, at + (spreadMs ?? 2_000));
          if (merged.coveredFrom !== null && merged.coveredTo !== null && at >= merged.coveredFrom && at <= merged.coveredTo) {
            const moment = { ...momentOf(merged.events as unknown as DeviceEvent[], at, spreadMs ?? 2_000), clock: null };
            return ok(notice + describeMoment(moment), { ...moment, connected, exitedProcess });
          }
        }

        if (pending !== null) {
          return ok(notice + pending, { moment: null, connected, exitedProcess });
        }
        return ok(
          notice +
            `Connected to ${device.hello!.packageName}, nothing buffered yet. Ask again in a moment.`,
          { moment: null, connected, exitedProcess },
        );
      }

      // GRA-163: from here on the ring has content, so — exactly as in
      // findings — the ring's contents are only guaranteed to belong to the
      // running process once its hello has actually landed. Consulting
      // pendingMessage() here (previously unreached from this branch) is
      // what stops this tool from agreeing with findings' old bug: reporting
      // `connected: true` for a moment that was really a previous session's,
      // just because the socket happened to be handshaking again by the
      // time someone asked.
      const pending = device.pendingMessage();
      const connected = pending === null;
      const exitedProcess = exitedProcessField();

      let moment_at = at;
      let clock: { bootMs: number; sleepMs: number; sampledAt: number } | null = null;

      if (moment_at === undefined && bootMs !== undefined) {
        const converted = fromBootMs(events, bootMs);
        if (!converted) {
          return ok(
            "No clock sample in the buffer, so a boot-clock timestamp cannot be placed. " +
              "The app must have been running with Porthole attached for that to exist.",
            { moment: null, bootMs, connected, exitedProcess },
          );
        }
        moment_at = converted.at;
        // Keep the boot reading that was asked about, so the answer shows both
        // ends of the conversion rather than only the result.
        clock = { bootMs, sleepMs: converted.sleepMs, sampledAt: converted.sampledAt };
      }

      if (moment_at === undefined) {
        return ok("Give either `at` or `bootMs`.", { moment: null, connected, exitedProcess });
      }

      // The same shared sentence findings uses, so an agent reading both
      // tools about the same stale window sees the same story — not two
      // hand-written near-duplicates that can drift apart from each other.
      // `hasBufferedData: true`: this is the non-empty branch.
      const notice = exitedProcessNotice(exitedProcess, true, connected);

      // Outside the buffer is a different answer from "nothing happened", and
      // conflating them is how an agent concludes the app was idle.
      const oldest = events[0].t;
      const newest = events[events.length - 1].t;
      if (moment_at < oldest || moment_at > newest) {
        // GRA-53: the ticket's headline scenario — the buffer rolled or the
        // process restarted since, but the moment may still be on disk.
        // `from: 0` rather than `oldest`: momentOf() needs the full nav
        // history up to `moment_at` to say which screen was current (the
        // last nav at-or-before the moment, not merely one inside the
        // spread window), so the merge has to reach back further than the
        // window actually returned.
        const merged = await mergeWithDisk(0, moment_at + (spreadMs ?? 2_000));
        if (
          merged.coveredFrom !== null &&
          merged.coveredTo !== null &&
          moment_at >= merged.coveredFrom &&
          moment_at <= merged.coveredTo
        ) {
          const moment = { ...momentOf(merged.events as unknown as DeviceEvent[], moment_at, spreadMs ?? 2_000), clock };
          return ok(notice + describeMoment(moment), { ...moment, connected, exitedProcess });
        }
        return ok(
          notice +
            `That moment is outside what is buffered (${oldest}–${newest} on the uptime clock). ` +
            "Not that nothing was happening — it is no longer held.",
          {
            moment: null,
            asked: moment_at,
            buffered: { from: oldest, to: newest },
            clock,
            connected,
            exitedProcess,
          },
        );
      }

      const moment = { ...momentOf(events, moment_at, spreadMs ?? 2_000), clock };
      return ok(notice + describeMoment(moment), { ...moment, connected, exitedProcess });
    },
  );

  // -- GRA-69: per-node compose-report join, `recompositions`' own -----------
  //
  // `composeReport.ts` owns the join itself; this is only the shape one
  // node's result takes on the wire, and the "when is it even worth
  // mentioning" call — the same off-entirely-when-there-is-nothing-to-say
  // rule `where` already follows (sources.ts's own doc comment), extended
  // to composeReport: omitted when the feature is off, when no report has
  // ever been generated, or when the label simply never resolved to
  // source, since none of those is a fact about *this composable* worth
  // repeating on every node in the list. Present, with `joined: false` and
  // `reason: "no report entry matched"` (or "matched more than one report
  // entry", with `candidates`), for the two outcomes GRA-69's own ticket
  // names explicitly: "never join a wrong function — an unjoined node says
  // 'no report entry matched' with the candidates."
  type ComposeReportNodeInfo =
    | {
        joined: true;
        enclosingFunction: string;
        module: string;
        generatedAt: string;
        gitHead: string | null;
        kotlinVersion: string;
        // The follow-up to GRA-69: whether the *consuming module's real
        // build* has strong skipping on — this report's own compile
        // always has it forced off, which is why "not skippable" alone can
        // be misleading about the running app; see
        // composeReport.ts's `strongSkippingCaveat`.
        strongSkippingInBuild: boolean | "unknown";
        stale: false;
        skippable: boolean;
        restartable: boolean;
        notSkippableReason?: string;
        notRestartableReason?: string;
        skippableButUnstableReason?: string;
      }
    | {
        // D6: a stale match never carries `skippable` — the report's own
        // verdict may no longer be true of the current source — only that a
        // report was found, how old it is, and that it disagrees with the
        // tree right now.
        joined: true;
        enclosingFunction: string;
        module: string;
        generatedAt: string;
        gitHead: string | null;
        kotlinVersion: string;
        strongSkippingInBuild: boolean | "unknown";
        stale: true;
        staleNote: string;
      }
    | {
        joined: false;
        reason: string;
        candidates?: Array<{ module: string; packageName: string | null; signature: string }>;
        declarationPackage?: string | null;
      };

  function composeReportNodeInfo(nodeName: string): ComposeReportNodeInfo | undefined {
    const join: ComposeJoin = joinComposableNode(nodeName);
    if (join.matched) {
      const common = {
        enclosingFunction: join.enclosingFunction,
        module: join.report.module,
        generatedAt: join.report.generatedAt,
        gitHead: join.report.gitHead,
        kotlinVersion: join.report.kotlinVersion,
        strongSkippingInBuild: join.report.strongSkippingInBuild,
      };
      if (join.stale) {
        return { ...common, joined: true, stale: true, staleNote: staleJoinNote(join.report) };
      }
      const notSkippableReason = explainNotSkippable(join);
      const notRestartableReason = explainNotRestartable(join);
      const skippableButUnstableReason = explainSkippableButUnstable(join);
      return {
        ...common,
        joined: true,
        stale: false,
        skippable: join.composable.skippable,
        restartable: join.composable.restartable,
        ...(notSkippableReason ? { notSkippableReason } : {}),
        ...(notRestartableReason ? { notRestartableReason } : {}),
        ...(skippableButUnstableReason ? { skippableButUnstableReason } : {}),
      };
    }
    if (join.reason === "no report entry matched" || join.reason === "matched more than one report entry") {
      return {
        joined: false,
        reason: join.reason,
        ...(join.candidates ? { candidates: join.candidates } : {}),
        ...(join.declarationPackage !== undefined ? { declarationPackage: join.declarationPackage } : {}),
      };
    }
    return undefined;
  }

  server.registerTool(
    "recompositions",
    {
      title: "Recomposition counts",
      description:
        "How many times each instrumented composable recomposed, and which state keys were written " +
        "just before each recomposition. Use it to find the composable doing needless work and the " +
        "state that keeps invalidating it.\n\n" +
        "Two limits worth holding in mind: only call sites wrapped in PortholeScreen or " +
        "Modifier.portholeNode are counted, so an absent composable is uninstrumented rather than " +
        "idle; and triggeredBy is a temporal correlation within a ~32ms window, not a causal read " +
        "of the invalidation graph, so several states changing in one frame all get listed.\n\n" +
        "Keys like 'unnamed#3f2a1c' are state objects nobody named. In a Compose app most of them " +
        "belong to the framework — ripples, scroll offsets, focus, animation clocks — and are not " +
        "worth chasing. A key that is yours and still unnamed means its owner was never registered: " +
        "Porthole.registerViewModel for a ViewModel, collectAsNamedState for a Flow, " +
        "rememberNamedState for state a composable creates for itself.\n\n" +
        "A key carrying 'holds' is anonymous state that was found holding one of the app's own " +
        "types, so it is definitely the app's and definitely unregistered — that one is worth " +
        "chasing. Its absence proves nothing: an unregistered Int is indistinguishable from a " +
        "ripple, so most of the app's own unnamed state will not be flagged.\n\n" +
        "'composeReport' (present only when it has something to say) joins each node against " +
        "the Kotlin compose compiler's own report (run `./gradlew portholeComposeReport` first — " +
        "it is not on by default, since enabling it costs a recompile): 'joined: true' names the " +
        "enclosing composable function, whether the compiler itself calls it skippable, and, when " +
        "it is not, 'notSkippableReason' quotes the compiler's own reason — an unstable parameter, " +
        "and, for a class parameter, why that class is unstable. 'joined: false' with 'reason: " +
        "\"no report entry matched\"' or '\"matched more than one report entry\"' (candidates " +
        "listed) means the label could not be tied to one function with confidence — never a " +
        "guess. A stale report ('stale: true' — its own source state has moved on) is still named " +
        "but never used for a reason. 'strongSkippingInBuild' says whether your own build (not " +
        "this report's own always-off compile) has strong skipping on; when it does, " +
        "'notSkippableReason' says so and qualifies the claim — the composable still skips when " +
        "the caller passes the same instance, only a fresh one each time defeats it.",
      inputSchema: {
        screen: z
          .string()
          .optional()
          .describe(
            "Only nodes on this screen, matched against the enclosing PortholeScreen name.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Busiest N nodes. Default 50; the tail is rarely what you are looking for."),
        ...windowShape,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ screen, sinceMs, from, to, limit, since }): Promise<ToolResult> => {
      // GRA-55: resolved here, on the MCP side, rather than forwarding
      // sinceMs/since to the device — `since: "last"` needs the watermark,
      // which only this process holds. Falls back to the caller's own raw
      // sinceMs/from/to, unchanged, when nothing can be resolved (an empty
      // buffer, no watermark yet) — exactly today's behaviour for that case.
      const resolved = await resolveWindowSince({ sinceMs, from, to, since });
      const windowArgs = resolved ? { from: resolved.from, to: resolved.to } : { sinceMs, from, to };
      return call<{
        nodes: Array<{
          name: string;
          count: number;
          triggeredBy: Array<{ key: string; count: number }>;
          where?: Where;
          // GRA-69, filled in below by the augment step.
          composeReport?: ComposeReportNodeInfo;
        }>;
        totalNodes?: number;
        truncated?: boolean;
        unattributedWrites: Array<{ key: string; count: number }>;
      }>(
        "recompositions",
        { screen, ...windowArgs, limit: limit ?? 50 },
        (report) => {
          if (report.nodes.length === 0) {
            return "No instrumented composable recomposed in that window.";
          }
          const top = report.nodes[0];
          const cause = top.triggeredBy[0];
          const total = report.nodes.reduce((sum, node) => sum + node.count, 0);
          // A capped list that does not say it is capped reads as the whole
          // truth, which is how "only three composables recomposed" gets believed.
          const cut = report.truncated
            ? ` Busiest ${report.nodes.length} of ${report.totalNodes ?? report.nodes.length} nodes shown.`
            : "";
          return (
            `${total} recompositions across ${report.nodes.length} nodes. ` +
            `Worst: ${top.name} at ${top.count}` +
            (cause ? `, most often after a write to ${cause.key} (${cause.count} of them).` : ".") +
            cut
          );
        },
        // GRA-201: `name` is the string literal given to portholeNode/PortholeScreen
        // (PortholeCompose.kt), not a declared Kotlin symbol — see sources.ts's own
        // doc comment for why that is what the name index looks up.
        (report) => ({
          ...report,
          nodes: report.nodes.map((node) => {
            const where = whereForName(node.name);
            // GRA-69: every node, not only the busiest one — an agent asking
            // about a specific composable by name wants this even when it
            // is nowhere near the top of the list. composeReportNodeInfo()
            // omits the key entirely for the common "no report yet" case;
            // see that function's own comment for exactly when it speaks up.
            const composeReport = composeReportNodeInfo(node.name);
            return { ...node, ...(where ? { where } : {}), ...(composeReport ? { composeReport } : {}) };
          }),
        }),
      );
    },
  );

  server.registerTool(
    "semantics_tree",
    {
      title: "Semantics tree",
      description:
        "The Compose semantics tree with a stable id per node. stableId is a structural path hash: " +
        "the same UI produces the same id across captures and across process restarts, so two " +
        "captures can be diffed. Nodes carrying a porthole node id line up with the ids in the " +
        "recompositions report.\n\n" +
        "A snapshot of what is on screen now. It says nothing about cost — a large tree is not a slow one — so do not infer performance from its shape; use `frames` for that.\n\n" +
        "GRA-72: this capture is also what `findings` folds its own accessibility findings from, " +
        "for free, whenever `findings`' window happens to cover this call's own moment — see " +
        "`accessibility` below for the same pass run and reported on its own.",
      inputSchema: {
        merged: z
          .boolean()
          .optional()
          .describe("Merged tree (what accessibility services see). Default true."),
        maxDepth: z.number().int().positive().optional().describe("Depth cap. Default 40."),
        maxNodes: z.number().int().positive().optional().describe("Node budget. Default 1500."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ merged, maxDepth, maxNodes }): Promise<ToolResult> =>
      call<{ root: unknown; error?: string; capturedAt: number }>(
        "semantics_tree",
        { merged, maxDepth, maxNodes },
        (tree) =>
          tree.error ? tree.error : tree.root ? "Captured the semantics tree." : "Empty tree.",
        // GRA-72: recorded here too, not only by the dedicated `accessibility`
        // tool below — both are legitimately "a semantics capture", and
        // `findings`' fold-in should not require an agent to have called the
        // newer tool specifically. A side effect, not a payload change: the
        // returned value is handed back exactly as the device sent it.
        (tree) => {
          const { density, fontScale } = currentDensityAndFontScale();
          recordSemanticsCapture({
            capturedAt: tree.capturedAt,
            root: parseSemanticsNode(tree.root),
            density,
            fontScale,
          });
          return tree;
        },
      ),
  );

  server.registerTool(
    "accessibility",
    {
      title: "Accessibility defects the semantics tree already proves",
      description:
        "A lint pass over a fresh Compose semantics capture: an interactive node with no label at all, " +
        "a touch target measurably under the 48dp minimum, a node that looks clickable but carries no " +
        "click action (or the reverse), a non-decorative image with no description, a description " +
        "repeated across siblings, and text whose box leaves no room to grow at a large system font " +
        "scale. Each finding names the node's `stableId`, its path in the tree and any `testTag` — " +
        "the `stableId` resolves through `semantics_tree`'s own output, so 'show me that node' is one " +
        "more call away, never a screenshot annotation (not available in this build — pairing is by " +
        "`stableId` through `semantics_tree` only).\n\n" +
        "A clean screen says so explicitly: 'nothing found, N node(s) checked', never a bare empty " +
        "list indistinguishable from 'did not look'. `coverage` says what this pass did and did not " +
        "see — only the Compose semantics tree, never a plain Android View, never anything Compose " +
        "itself marked invisible to the user.\n\n" +
        "A touch target between 24dp and 48dp is a `note`, not a `warning`: Compose's own " +
        "`minimumInteractiveComponentSize` (wired into IconButton, Checkbox and friends by default) " +
        "may already pad it back up to 48dp at touch time, invisibly to the bounds this tool can see — " +
        "below 24dp that automatic padding cannot plausibly explain the shortfall away, so that is a " +
        "`warning`.\n\n" +
        "Out of scope: colour contrast (nothing captured here carries a rendered colour), a View " +
        "hierarchy's own accessibility tree, and any claim of compliance — this proves what the " +
        "captured tree proves, never a certification. The TalkBack check on a real device remains the " +
        "hardware pass this cannot replace.\n\n" +
        "Calling this also feeds `findings`: its own next call folds these findings in for free, " +
        "whenever its window covers this capture's moment.",
      inputSchema: {
        merged: z
          .boolean()
          .optional()
          .describe("Merged tree (what accessibility services see). Default true, and the one this pass is meant to run against — TalkBack never sees the unmerged tree either."),
        maxDepth: z.number().int().positive().optional().describe("Depth cap on the capture. Default 40."),
        maxNodes: z.number().int().positive().optional().describe("Node budget on the capture. Default 1500."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ merged, maxDepth, maxNodes }): Promise<ToolResult> =>
      call<{
        root: unknown;
        error?: string;
        capturedAt: number;
        findings?: Finding[];
        nodesChecked?: number;
        coverage?: string[];
      }>(
        "semantics_tree",
        { merged, maxDepth, maxNodes },
        // `tree.error` (no semantics owner found) is a *successful* RPC
        // carrying no tree — `call`'s own try/catch already covers an
        // unreachable device, so this is this tool's own thing to report,
        // same distinction `semantics_tree` itself draws.
        (tree) => (tree.error ? tree.error : summarizeAccessibilityResult({
          findings: tree.findings ?? [],
          nodesChecked: tree.nodesChecked ?? 0,
          coverage: tree.coverage ?? [],
        })),
        (tree) => {
          if (tree.error) return tree;
          const root = parseSemanticsNode(tree.root);
          const { density, fontScale } = currentDensityAndFontScale();
          recordSemanticsCapture({ capturedAt: tree.capturedAt, root, density, fontScale });
          const lint = lintSemanticsTree(root, { density, fontScale, capturedAt: tree.capturedAt });
          return { ...tree, findings: lint.findings, nodesChecked: lint.nodesChecked, coverage: lint.coverage };
        },
      ),
  );

  server.registerTool(
    "nav_state",
    {
      title: "Navigation state",
      description:
        "The current back stack with each entry's route, arguments and lifecycle state, plus the " +
        "deep link that opened the app if there was one. Answers 'how did I get to this screen' " +
        "and 'what arguments is it actually holding', which is usually where the bug is.\n\n" +
        'Present tense only. This is the stack as it is now, not how it got that way — for the order things happened in, ask `timeline` with kinds: ["nav"].',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (): Promise<ToolResult> =>
      call<{ current?: { route?: string } | null; backStack: unknown[]; error?: string }>(
        "nav_state",
        {},
        (nav) =>
          nav.error ??
          `At ${nav.current?.route ?? "an unnamed destination"} with ${nav.backStack.length} entries on the stack.`,
      ),
  );

  server.registerTool(
    "state",
    {
      title: "ViewModel state",
      description:
        "Current values of the state held by registered ViewModels. Each field says whether writes " +
        "to it are attributable — meaning snapshot state the recomposition report can name. A " +
        "StateFlow is never attributable on its own; collectAsNamedState is what makes the State " +
        "it produces nameable.\n\n" +
        "Only registered owners appear. An empty result means nothing was registered, not that the app holds no state, so do not read absence here as evidence about the app.",
      inputSchema: {
        viewModel: z
          .string()
          .optional()
          .describe("Registered name or class name. Omit for every registered owner."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ viewModel }): Promise<ToolResult> =>
      call<{ owners: Array<{ name: string; fields: unknown[]; where?: Where }> }>(
        "state",
        { viewModel },
        (dump) => {
          if (dump.owners.length === 0) {
            return 'No ViewModels registered. Call Porthole.registerViewModel("CartViewModel", vm) where you obtain it.';
          }
          return dump.owners
            .map((owner) => `${owner.name} (${owner.fields.length} fields)`)
            .join(", ");
        },
        // GRA-201: an owner's `name` is whatever registerViewModel(name, vm)
        // was called with — usually, but not always, the class's own name —
        // so this resolves the label the same way `recompositions` above does.
        (dump) => ({
          owners: dump.owners.map((owner) => {
            const where = whereForName(owner.name);
            return where ? { ...owner, where } : owner;
          }),
        }),
      ),
  );

  server.registerTool(
    "inflight",
    {
      title: "In-flight work",
      description:
        "Open HTTP calls with the phase each is stuck in, database queries currently executing and " +
        "the thread running them, and enqueued or running WorkManager jobs. This is the tool for " +
        "'why is this screen still spinning'. `http`/`queries`/`work` are always the live set — " +
        "what is happening right now — and ignore the window below entirely.\n\n" +
        "Also returns recentHttp: finished calls with status, headers, OkHttp's own phase " +
        "breakdown (queued/dns/connect/secureConnect/dispatch/requestHeaders/requestBody/waiting/" +
        "responseBody, each already the time that phase itself took — queued and dispatch close the " +
        "two gaps that otherwise went unattributed, dispatcher queueing before any network activity " +
        "and OkHttp's own exchange setup once a connection exists), connection reuse, protocol, " +
        "connectAttempts (present only past 1 — a failover, not an ordinary connect), byte counts, " +
        "and — when the app opted in via BodyCapture — request and response body previews. A body " +
        "with text:null carries an omittedReason saying why it was not captured (disabled, wrong " +
        "content type, one-shot stream); that is different from the call having had no body at all. " +
        "`phases`/`reused`/`protocol`/`requestBytes`/`responseBytes` are only ever present for a call " +
        "OkHttp's own EventListener actually instrumented — empty for a Ktor call with no OkHttp " +
        "engine underneath (GRA-66; see KtorPorthole's own doc comment for why that boundary is " +
        "real). `dns`/`connect` sum every attempt a call made (a route failover included); " +
        "requestHeaders/requestBody/waiting/responseBody describe only the call's *final* leg — a " +
        "redirect or an auth-challenge retry re-runs its own, and each overwrites the last — while " +
        "elapsedMs still spans every leg.\n\n" +
        "GRA-66: recentHttp is now window-aware, the standard sinceMs/from/to below — quote a " +
        "finding's own `window` to reach a call `http-call-slow` named, even one older than the " +
        "default `limit` (25) would otherwise return. Only the newest 25 calls keep their body " +
        "previews, whatever `limit` is asked for — an older entry still has every other field, just " +
        "not the body.",
      inputSchema: {
        ...windowShape,
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Most recent N finished calls inside the window. Default 25."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceMs, from, to, since, limit }): Promise<ToolResult> => {
      const resolved = await resolveWindowSince({ sinceMs, from, to, since });
      const windowArgs = resolved ? { from: resolved.from, to: resolved.to } : { sinceMs, from, to };
      return call<{
        http: Array<{ method: string; url: string; phase: string; elapsedMs: number }>;
        queries: Array<{ sql: string; kind: string; elapsedMs: number; thread: string }>;
        work: Array<{ name: string; state: string }>;
        recentHttp?: Array<{
          method: string;
          url: string;
          status: number | null;
          elapsedMs: number;
        }>;
      }>("inflight", { ...windowArgs, limit }, (flight) => {
        const parts: string[] = [];
        if (flight.http.length) {
          const worst = flight.http[0];
          parts.push(
            `${flight.http.length} HTTP call(s), oldest ${worst.method} ${worst.url} ` +
              `in '${worst.phase}' for ${worst.elapsedMs}ms`,
          );
        }
        if (flight.queries.length) {
          const writes = flight.queries.filter((q) => q.kind === "write").length;
          parts.push(
            `${flight.queries.length} query(ies) running on ${flight.queries[0].thread}` +
              (writes ? ` (${writes} write)` : ""),
          );
        }
        if (flight.work.length) parts.push(`${flight.work.length} work job(s)`);

        const recent = flight.recentHttp ?? [];
        const failed = recent.filter((c) => c.status !== null && c.status >= 400);
        if (recent.length) {
          parts.push(
            `${recent.length} recent call(s)` +
              (failed.length ? `, ${failed.length} with a ${failed[0].status}` : ""),
          );
        }
        return parts.length ? parts.join("; ") : "Nothing in flight.";
      });
    },
  );

  server.registerTool(
    "frames",
    {
      title: "Frame timing",
      description:
        "How many frames the app dropped, and where the time went in the worst ones. This is the " +
        "outcome every other collector is a proxy for: a recomposition count only matters because " +
        "of what it does to frame time.\n\n" +
        "worstPhase names the stage that dominated a janky frame, which is what decides where to " +
        "look: layoutMeasure or draw points at composition doing too much, gpu or swapBuffers at " +
        "overdraw or an expensive shader, unknownDelay at the main thread being busy with " +
        "something that is not drawing at all. Pair a jank cluster with recompositions over the " +
        "same from/to window to see whether recomposition is the cause.\n\n" +
        "Frames with firstDraw are a window being drawn for the first time and are expected to be " +
        "slow. Needs API 24 or newer.",
      inputSchema: {
        ...windowShape,
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Worst N frames. Default 20."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceMs, from, to, limit, since }): Promise<ToolResult> => {
      const resolved = await resolveWindowSince({ sinceMs, from, to, since });
      const windowArgs = resolved ? { from: resolved.from, to: resolved.to } : { sinceMs, from, to };
      // GRA-185's "second, smaller thing": `frames` used to print its own
      // truncated `frameIntervalMs` with no Hz named at all ("budget 8ms"),
      // while `findings` — resolving the same profile through
      // `resolveProfile` — said "8.3ms at 120Hz" for the identical panel.
      // The prose below now goes through `describeBudget`, the same
      // function `findingsOf`'s `frames-dropped` title uses, so the two
      // cannot drift apart again. `frameIntervalMs` itself, in the payload
      // below, stays exactly as the runtime sends it — only the prose
      // changes.
      const profile = resolveProfile({
        liveEvents: timeline.buffer(),
        windowTo: resolved?.to ?? Number.POSITIVE_INFINITY,
        sessionProfile: device.sessions?.currentMeta()?.profile ?? null,
        hello: (device.hello as unknown as Record<string, unknown>) ?? null,
      });
      return call<{
        totalFrames: number;
        jankyFrames: number;
        frameIntervalMs: number;
        worst: Array<{
          totalMs: number;
          missedFrames: number;
          worstPhase: string;
          firstDraw: boolean;
        }>;
      }>("frames", { ...windowArgs, limit }, (report) => {
        if (report.totalFrames === 0) return "No frames observed yet.";
        const rate = ((report.jankyFrames / report.totalFrames) * 100).toFixed(1);
        const worst = report.worst[0];
        const byPhase: Record<string, number> = {};
        for (const frame of report.worst) {
          byPhase[frame.worstPhase] = (byPhase[frame.worstPhase] ?? 0) + 1;
        }
        const phases = Object.entries(byPhase)
          .sort((a, b) => b[1] - a[1])
          .map(([phase, n]) => `${phase} ${n}`)
          .join(", ");
        return (
          `${report.jankyFrames} of ${report.totalFrames} frames janky (${rate}%), ` +
          `budget ${describeBudget(profile)}.` +
          (worst
            ? ` Worst ${worst.totalMs}ms, ${worst.missedFrames} refresh(es) missed, mostly ` +
              `${worst.worstPhase}. Across the worst frames: ${phases}.`
            : "")
        );
      });
    },
  );

  server.registerTool(
    "blocking",
    {
      title: "Main thread blocking",
      description:
        "What held the main thread: stalls longer than the threshold, with the stack the main " +
        "thread was in at the time, and any database query that ran on it.\n\n" +
        "Stalls are found by pinging the main looper and timing the reply, so the duration is how " +
        "long everything queued ahead of the ping took. The stack is sampled once, when the ping " +
        "goes overdue, and app frames are listed first because the top frame is usually a native " +
        "read and the line you can change is a few frames down.\n\n" +
        "Database work on the main thread is reported however fast it was: a 4ms disk read in the " +
        "frame loop is a defect that has not bitten yet. For hitches shorter than the threshold, " +
        "use `frames` instead — that measures every frame, this one catches the big stops.",
      inputSchema: {
        ...windowShape,
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Worst N of each. Default 20."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceMs, from, to, limit, since }): Promise<ToolResult> => {
      const resolved = await resolveWindowSince({ sinceMs, from, to, since });
      const windowArgs = resolved ? { from: resolved.from, to: resolved.to } : { sinceMs, from, to };
      return call<{
        stalls: Array<{ durationMs: number; stack: string; where?: Where }>;
        mainThreadQueries: Array<{ sql: string; elapsedMs: number; kind: string }>;
        stallThresholdMs: number;
      }>(
        "blocking",
        { ...windowArgs, limit },
        (report) => {
          const parts: string[] = [];
          if (report.stalls.length) {
            const worst = report.stalls[0];
            parts.push(
              `${report.stalls.length} stall(s) over ${report.stallThresholdMs}ms, worst ` +
                `${worst.durationMs}ms in ${worst.stack.split("\n")[0]}`,
            );
          }
          if (report.mainThreadQueries.length) {
            const worst = report.mainThreadQueries[0];
            parts.push(
              `${report.mainThreadQueries.length} database ${report.mainThreadQueries.length === 1 ? "query" : "queries"} ` +
                `on the main thread, worst ${worst.elapsedMs}ms: ${worst.sql.slice(0, 80)}`,
            );
          }
          return parts.length ? parts.join(". ") : "Nothing blocked the main thread in this window.";
        },
        // GRA-201: each stall's own top frame (the stack's first line), the
        // same text `main-thread-stall` resolves in trace.ts — resolved
        // here too since this is a live device reply, not one of that
        // analyser's findings.
        (report) => ({
          ...report,
          stalls: report.stalls.map((stall) => {
            const where = whereForFrame(stall.stack.split("\n")[0]);
            return where ? { ...stall, where } : stall;
          }),
        }),
      );
    },
  );

  server.registerTool(
    "logs",
    {
      title: "App logs",
      description:
        "The app's own logcat output, captured in-process and streamed over the same socket as " +
        "everything else — no adb needed. Stack traces arrive attached to the line that started " +
        "them rather than as loose fragments.\n\n" +
        "Entries carry the same uptime clock as the timeline, so a log line can be placed against " +
        "a recomposition burst or an HTTP call. Only the app's own output is visible, and the " +
        "porthole's own tag is excluded.",
      inputSchema: {
        level: z
          .enum(["V", "D", "I", "W", "E", "F"])
          .optional()
          .describe("Minimum level. 'W' for warnings and worse, which is usually what you want."),
        tag: z.string().optional().describe("Substring match on the tag."),
        contains: z.string().optional().describe("Substring match on the message."),
        ...windowShape,
        limit: z
          .number()
          .int()
          .positive()
          .max(2000)
          .optional()
          .describe("Newest N entries. Default 200."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ level, tag, contains, sinceMs, from, to, limit, since }): Promise<ToolResult> => {
      const resolved = await resolveWindowSince({ sinceMs, from, to, since });
      const windowArgs = resolved ? { from: resolved.from, to: resolved.to } : { sinceMs, from, to };
      return call<{
        entries: Array<{ level: string; tag: string; message: string; wallTime: string }>;
        capturing: boolean;
        evicted: number;
        notes: string[];
      }>("logs", { level, tag, contains, ...windowArgs, limit }, (page) => {
        if (!page.capturing) {
          return page.notes.join(" ") || "Log capture is not running.";
        }
        if (page.entries.length === 0) {
          return page.notes.join(" ") || "No log entries matched.";
        }
        const counts: Record<string, number> = {};
        for (const entry of page.entries) counts[entry.level] = (counts[entry.level] ?? 0) + 1;
        const worst = page.entries
          .filter((entry) => entry.level === "E" || entry.level === "F")
          .at(-1);
        return (
          `${page.entries.length} entries (` +
          Object.entries(counts)
            .map(([level, count]) => `${level} ${count}`)
            .join(", ") +
          ")" +
          (worst
            ? `. Latest error: ${worst.tag}: ${worst.message.split("\n")[0].slice(0, 120)}`
            : ".")
        );
      });
    },
  );

  server.registerTool(
    "timeline",
    {
      title: "Event timeline",
      description:
        "Raw event stream: recompositions, state writes, navigation, HTTP and database start/end. " +
        "Use it to order events relative to each other — which write came before which navigation, " +
        "what the app was doing while a call was open.",
      inputSchema: {
        ...windowShape,
        kinds: z.array(z.string()).optional().describe(timelineKindsDescription()),
        limit: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe("Newest N events. Default 500."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceMs, from, to, since, kinds, limit }): Promise<ToolResult> => {
      try {
        // Absolute bounds first, so a window quoted from another tool selects the
        // same span here. sinceMs stays as the convenience for "recently".
        const span = await resolveWindowSince({ sinceMs, from, to, since });

        // GRA-53: the third consumer of the same merge `findings` and
        // `what_was_happening` already use — deliberately not a third
        // mechanism. A resolved span (the ordinary case, or an explicit
        // `{from, to}` quoted from an earlier answer) goes through
        // `mergeWithDisk`, which already returns events filtered to the
        // window; the un-resolved case (no span at all — nothing to bound
        // a disk lookup by) keeps the previous behaviour of asking the
        // device's own much-smaller ring directly.
        let events: DeviceEvent[];
        if (span) {
          const merged = await mergeWithDisk(span.from, span.to);
          events = merged.events as unknown as DeviceEvent[];
        } else {
          // Prefer the local buffer: it holds more history than the device
          // ring and survives the app being restarted underneath us.
          events = timeline.buffer();
          if (events.length === 0) {
            const page = await device.request<{ events: DeviceEvent[] }>("timeline", {
              limit: limit ?? 500,
            });
            events = page.events;
          }
        }
        if (kinds?.length) {
          const wanted = new Set(kinds);
          events = events.filter((event) => wanted.has(event.event));
        }

        const matched = events.length;
        const cap = limit ?? 500;
        events = events.slice(-cap);
        const truncated = matched > events.length;

        const counts: Record<string, number> = {};
        for (const event of events) counts[event.event] = (counts[event.event] ?? 0) + 1;
        const covered = events.length > 1 ? events[events.length - 1].t - events[0].t : 0;

        // Say when the answer was cut. Silent truncation is how an agent
        // concludes something did not happen when it simply fell off the end.
        const note = truncated
          ? ` ${matched} matched, newest ${events.length} returned — raise \`limit\` or narrow the window.`
          : "";
        const summary =
          events.length === 0
            ? "No events matched. Interact with the app, widen the window, or check `kinds`."
            : `${events.length} events over ${covered}ms: ` +
              Object.entries(counts)
                .map(([kind, count]) => `${kind} ${count}`)
                .join(", ") +
              "." +
              note;
        return ok(summary, {
          window: span ? { from: span.from, to: span.to, ms: span.ms } : null,
          matched,
          returned: events.length,
          truncated,
          events,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "open_timeline",
    {
      title: "Open the timeline UI",
      description:
        "Starts the local timeline UI and returns its URL. Lanes for recompositions, state writes, " +
        "navigation, network and database, on a shared time axis. Open it in a browser; it updates " +
        "live over a WebSocket.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        const url = await timeline.start();
        return ok(`Timeline UI running at ${url}`, { url, events: timeline.buffer().length });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "screenshot",
    {
      title: "See the screen",
      description:
        "Captures the device's screen right now and returns it as an image. The semantics tree and " +
        "recomposition counts do not say that the price is rendering as `$NaN`, that a list is empty, " +
        "or that a dialog is covering everything — that is a look, not a query.\n\n" +
        "Scaled and re-encoded before it comes back: JPEG, about 640px wide, quality 80, capped at " +
        "1.5MB. `originalWidth`/`originalHeight` in the payload are the device's real resolution; the " +
        "image itself is the scaled copy, so treat this as a look at the screen, not a source of " +
        "pixel-accurate measurements — `semantics_tree` has element bounds for that.\n\n" +
        "Refuses rather than returning a black rectangle when a FLAG_SECURE window is on top: " +
        "screencap itself returns solid black for one of those, and handing that back as if it were " +
        "the app would be worse than saying so.\n\n" +
        "Multi-display devices (foldables, Auto): defaults to display 0, the main display; pass " +
        "`displayId` for another.\n\n" +
        "Never written to the session file on disk: unlike the app's own text events, a screenshot " +
        "cannot be redacted, so it exists only in this one response.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial, when more than one is attached."),
        displayId: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Which display to capture (`adb shell dumpsys display` lists them). Defaults to 0, the main display."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({
      serial,
      displayId,
    }): Promise<{
      content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
      isError?: boolean;
    }> => {
      const result = await captureScreenshot({ serial, displayId, adbOptions: { env: adbEnv, binary: adbBinary } });
      if (!result.ok) {
        return ok(result.message, { ok: false, reason: result.reason, displayId: result.displayId });
      }
      const kb = Math.max(1, Math.round(result.bytes / 1024));
      const caption =
        `Captured ${result.width}x${result.height} (scaled from ${result.originalWidth}x` +
        `${result.originalHeight} on display ${result.displayId}), ${kb}KB JPEG.`;
      const payload = {
        ok: true,
        originalWidth: result.originalWidth,
        originalHeight: result.originalHeight,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        quality: result.quality,
        displayId: result.displayId,
      };
      // GRA-55: the same banner/sinceLast attachment `ok()` gives every other
      // tool, called directly rather than through `ok()` itself — `ok()`'s
      // own `content` shape is text-only (`joinSummaryAndPayload()`), and
      // widening that shared chokepoint for the one tool that returns an
      // image is a bigger, riskier change than building this one response
      // by hand from the same underlying `attachSinceLastAndBanner()` work.
      const { summary, payload: withSinceLast } = await attachSinceLastAndBanner(caption, payload);
      return {
        content: [
          { type: "text", text: summary },
          { type: "image", data: result.base64, mimeType: result.mimeType },
          { type: "text", text: JSON.stringify(withSinceLast, null, 2) ?? "null" },
        ],
      };
    },
  );

  return { server, device, timeline };
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

/**
 * True only when this file is the process's actual entry point (`node
 * dist/index.js`, or the `porthole-mcp` bin it is published as) — never when
 * it is merely imported, which is what every test does, and what `cli.ts`
 * now does too (it calls `bootPortholeServer()` explicitly instead of
 * relying on this guard). Importing this module must never open a socket,
 * attach to stdio, or install signal handlers; only running it as a program,
 * or explicitly asking it to boot, may.
 */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

/**
 * The one boot path: create the server, start the device, wire shutdown, and
 * connect stdio. `node dist/index.js` and `porthole mcp` (`cli.ts`) both call
 * this instead of each having their own copy — `porthole mcp` used to boot by
 * `import("./index.js")`ing this module for its side effect, which broke the
 * moment that side effect moved behind `isMainModule()`: `argv[1]` is
 * `cli.js` when the CLI does the importing, so the guard can never see
 * itself as the entry point and nothing started. Calling this function is
 * the boot; the `isMainModule()` block below is just the one caller that
 * also happens to be `node dist/index.js` itself.
 */
export async function bootPortholeServer(
  options: PortholeServerOptions = {},
): Promise<PortholeServer> {
  const rig = createPortholeServer(options);
  const { server, device, timeline } = rig;

  device.start();

  // stdout belongs to the MCP transport; anything we say goes to stderr.
  device.on("state", (state: string) => process.stderr.write(`[porthole] device ${state}\n`));

  const shutdown = () => {
    device.stop();
    timeline.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[porthole] MCP server ready, device target ${HOST}:${PORT}\n`);

  return rig;
}

if (isMainModule()) {
  await bootPortholeServer();
}
