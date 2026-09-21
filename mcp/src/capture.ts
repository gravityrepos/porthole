// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { DeviceClient, isConnected, type ConnectionState, type DeviceEvent } from "./device.js";
import { renderComparison, renderReport, shouldColor } from "./report.js";
import { buildTrace, resolveProfile, str, type Finding, type Trace } from "./trace.js";
import { parseFailOn, parseSeconds, parsePort, readTrace, requiredValue, type FailOn } from "./args.js";
import type { RunAdbAsyncOptions } from "./adb.js";
import {
  countPortholeLabels,
  planCapture,
  startSystraceCapture,
  stopAndPullSystraceCapture,
  type CapturePlan,
  type SystraceCaptureHandle,
} from "./systrace.js";
import { askTrace, findTraceProcessor } from "./perfetto.js";
import { fromBootMs, toBoot } from "./moment.js";

/**
 * Recording a run with nobody watching.
 *
 * Wrapping a child process is the shape because it asks nothing of whatever is
 * driving the app: connectedAndroidTest, Maestro, a shell script and an agentic
 * driver are all just a command. The process lifetime is the capture window,
 * which means there is no protocol to version and no way to leave a capture
 * running.
 */

export interface CaptureOptions {
  port: number;
  serial?: string;
  scenario: string;
  out: string;
  driver?: string;
  withEvents: boolean;
  failOn: FailOn;
  forward: boolean;
  baseline?: string;
  command: string[];
  /** GRA-199: see `devices.ts`'s `forwardTarget`. Defaults to `PORTHOLE_APPLICATION_ID`. */
  applicationId?: string;
  /** GRA-199: see `devices.ts`'s `forwardTarget`. Defaults to `PORTHOLE_LEGACY_TCP_PORT` being set. */
  legacyTcpPort: boolean;
  /**
   * GRA-103: also record an on-device Perfetto system trace for the lifetime
   * of the child command, ask it the same eight questions
   * `ask_system_trace` does, and merge the answers into this trace's own
   * `findings` — see `capture()`'s own `#systrace` section for the whole
   * story.
   */
  systrace: boolean;
  /** The on-device recording's own safety ceiling — `planCapture`'s 1-120s clamp. Defaults to the max (120) when `--systrace` is given with no explicit value, since the *intended* bound is the child's own lifetime, not this one. */
  systraceSeconds?: number;
  systraceCategories?: string[];
  /** Test-only: overrides `findAdb()`'s resolution for every adb call `--systrace` makes. Same seam `PortholeServerOptions.adbBinary` (index.ts) gives `capture_system_trace`. */
  adbBinary?: string;
  /** Test-only, same reasoning as `adbBinary`. */
  adbEnv?: NodeJS.ProcessEnv;
  /** Test-only: overrides `findTraceProcessor()` — "the lookup pointed at nothing" is how a rig test proves `--systrace` still succeeds, .pftrace and all, with no `trace_processor_shell` on the machine. */
  findTraceProcessor?: () => string | null;
  /** Test-only: threaded into `planCapture`'s own `now` — the on-device path is stamped with it, so a test can predict the exact adb args `--systrace` will send instead of racing `Date.now()`. */
  systraceNow?: number;
}

export const CAPTURE_USAGE = `
porthole capture — record a run and write a trace

  porthole capture --scenario <name> [options] -- <command to run>

  --scenario <name>      what this run is, and what a baseline is matched against
  --out <file>           where to write the trace (default porthole-trace.json)
  --driver <name>        what drove the app; compare warns when two runs differ
  --with-events          include the raw event stream. Large.
  --fail-on <what>       nothing (default), error, or regression
  --baseline <file>      compare against this trace when done
  --port <n>             host port the forward listens on, not a port the device opens (default 8677)
  --serial <id>          adb device serial
  --application-id <id>  the app the abstract socket is named for (default PORTHOLE_APPLICATION_ID)
  --legacy-tcp-port      forward to the old shared TCP port instead (default PORTHOLE_LEGACY_TCP_PORT)
  --no-forward           skip 'adb forward'; use it if the bridge is already up
  --systrace              also record an on-device Perfetto trace for the run, and merge its
                          findings into this trace's own — writes <out>.pftrace beside <out>
  --systrace-seconds <n>  the on-device recording's own safety ceiling, 1-120s (default 120;
                          the command's own lifetime is the real bound, whichever ends first)
  --systrace-categories <a,b>  atrace categories for --systrace (default: the same set
                          capture_system_trace uses)

  porthole report <trace.json>
  porthole compare <baseline.json> <trace.json>

The command runs to completion with the porthole recording. Its exit code is
passed through unless --fail-on fires first.
`;

/**
 * Waits for the device to answer, so a capture does not silently record
 * nothing.
 *
 * GRA-157 AC5: this used to resolve the instant the socket connected, before
 * hello had a chance to land — DeviceClient set state = "connected" on
 * socket connect and issued the hello request without awaiting it, so a
 * capture that started recording right here could finish with `hello: null`
 * for a run it had already reported as connected. That is now structurally
 * impossible without any change to this function: DeviceClient's "state"
 * event does not fire "connected" until hello has actually resolved (see
 * device.ts's setState()/connect()), and this only resolves `true` on that
 * exact event, so by the time it does, `device.hello` below is guaranteed
 * non-null. Waiting through the new "handshaking" state in between is free —
 * this function was never told which non-"connected" states exist, and does
 * not need to be now either.
 */
async function awaitConnection(device: DeviceClient, timeoutMs = 10_000): Promise<boolean> {
  // GRA-162: routed through isConnected() rather than `=== "connected"` so
  // that a fifth ConnectionState fails `tsc` here instead of this function
  // just never resolving true for it.
  if (isConnected(device.state)) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    device.on("state", (state: ConnectionState) => {
      if (isConnected(state)) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}

export async function capture(options: CaptureOptions): Promise<number> {
  const device = new DeviceClient("127.0.0.1", options.port);
  const events: DeviceEvent[] = [];
  device.on("event", (event: DeviceEvent) => events.push(event));
  device.start();

  const connected = await awaitConnection(device);
  if (!connected) {
    device.stop();
    process.stderr.write(device.notConnectedMessage() + "\n");
    return 1;
  }
  process.stderr.write(`recording "${options.scenario}"\n`);

  // ---------------------------------------------------------------------
  // #systrace (GRA-103): start the on-device recording before the child
  // runs, so its window covers exactly the command's own lifetime — see
  // systrace.ts's `#capture-integration` section for why a backgrounded,
  // `-t`-bounded capture is what makes that possible without blocking here.
  // ---------------------------------------------------------------------
  const adbOptions: RunAdbAsyncOptions = { serial: options.serial, env: options.adbEnv, binary: options.adbBinary };
  let systracePlan: CapturePlan | undefined;
  let systraceHandle: SystraceCaptureHandle | undefined;
  const systraceNotes: string[] = [];
  if (options.systrace) {
    // Guaranteed non-null: `device.hello` is set the moment `awaitConnection`
    // resolves true (GRA-157), same as the `hello` local built further down.
    const packageName = str(device.hello?.packageName);
    if (!packageName) {
      systraceNotes.push(
        "--systrace: no package to scope the system trace to (no packageName on the handshake), so it was skipped.",
      );
    } else {
      // The intended bound is the child's own lifetime — stopAndPullSystraceCapture
      // below stops it the moment the child exits. --systrace-seconds's real job is
      // a safety ceiling for a child that hangs or runs long, so it defaults to the
      // max planCapture allows rather than planCapture's own short default.
      systracePlan = planCapture({
        seconds: options.systraceSeconds ?? 120,
        categories: options.systraceCategories,
        apps: [packageName],
        now: options.systraceNow,
      });
      systraceNotes.push(...systracePlan.notes);
      const started = await startSystraceCapture(systracePlan, adbOptions);
      if (!started.ok) {
        systraceNotes.push(`--systrace: ${started.message} — continuing without a system trace.`);
      } else {
        systraceHandle = started.handle;
      }
    }
  }

  const startedAt = Date.now();
  const exitCode = await run(options.command);
  const durationMs = Date.now() - startedAt;

  // The last events are still in flight when the child exits.
  await new Promise((resolve) => setTimeout(resolve, 750));
  // Non-null here unless the app disconnected again during the run — a real,
  // separate risk (the process under test crashed or was reinstalled mid-run)
  // that this ticket does not attempt to paper over. It is no longer possible
  // for this to be null merely because we asked too early: awaitConnection()
  // above only returns once DeviceClient has actually set hello (GRA-157).
  const hello = device.hello as Record<string, unknown> | null;
  device.stop();

  // ---------------------------------------------------------------------
  // #systrace (GRA-103), continued: stop the recording now that the child
  // has exited (whichever ends first, this or the plan's own `-t` ceiling),
  // pull it beside the trace JSON, and ask it the same eight questions
  // `ask_system_trace` does — converting Porthole's uptime clock to the
  // trace's boot clock exactly the way that tool does (moment.ts's `toBoot`/
  // `fromBootMs`, off the same `clocks` samples).
  // ---------------------------------------------------------------------
  let systraceBlock: Trace["systrace"] | undefined;
  let traceFindings: Array<Finding & { source: "trace" }> = [];
  const extraFindings: Array<Finding & { source: "porthole" }> = [];
  if (systracePlan && systraceHandle) {
    const pftracePath = systracePathFor(options.out);
    const stopped = await stopAndPullSystraceCapture(systraceHandle, pftracePath, adbOptions);
    if (!stopped.ok) {
      // QA (F11): this used to only push a note here and never assign
      // `systraceBlock` at all — the `else if (options.systrace)` fallback
      // below only covers a capture that never *started*, so a pull failure
      // (the recording ran, `adb pull` itself failed) fell through with no
      // `trace.systrace` in the artifact and these notes written nowhere a
      // reader would ever see them. `pulled: false` here is honest: nothing
      // reached `pftracePath`, and `stopped.message` (systrace.ts) already
      // names the on-device copy this call left in place rather than
      // deleting, so `notes` alone is enough to recover it by hand.
      systraceNotes.push(`--systrace: ${stopped.message}`);
      systraceBlock = {
        path: "",
        bytes: 0,
        pulled: false,
        seconds: systracePlan.seconds,
        categories: systracePlan.categories,
        apps: systracePlan.apps,
        portholeLabels: 0,
        questionsAsked: false,
        notes: systraceNotes,
      };
    } else {
      const portholeLabels = await countPortholeLabels(pftracePath);
      if (portholeLabels === 0) {
        const detail =
          systracePlan.apps.length === 0
            ? "No app was named, so the app trace tag was never enabled."
            : "Either the app was not running with the runtime attached, or this device only reads " +
              "the app trace tag at process start, in which case a process already running before " +
              "the capture began would never pick it up.";
        systraceNotes.push(`0 Porthole labels in the system trace — ${detail}`);
        // GRA-103 AC: "portholeLabels: 0 produces a warning in the artifact" —
        // a structural finding, not only a sentence in `notes`, so a reader
        // of the trace JSON sees it the same way it sees every other warning.
        extraFindings.push({
          id: "systrace-no-porthole-labels",
          severity: "warning",
          confidence: "observed",
          title: "the system trace has no Porthole labels in it",
          detail,
          source: "porthole",
        });
      }

      const traceProcessorLookup = options.findTraceProcessor ?? findTraceProcessor;
      const binary = process.env.PORTHOLE_TRACE_PROCESSOR ?? traceProcessorLookup();
      let questionsAsked = false;
      if (!binary) {
        systraceNotes.push(
          "No trace_processor_shell found, so the system trace's questions were not asked — the " +
            ".pftrace was still written. Run `./gradlew portholeTraceProcessor` in the app's " +
            "project to fetch it, or set PORTHOLE_TRACE_PROCESSOR.",
        );
      } else {
        // GRA-113/GRA-103: the window the capture actually covered — the
        // earliest to the latest event this run saw, the same "no window
        // narrower than the whole run" reasoning `resolveProfile` below
        // already uses for the profile. `toBoot` picks whichever `clocks`
        // sample was in force at each boundary separately, exactly as
        // `ask_system_trace` (index.ts) does.
        const from = events.length ? events[0].t : 0;
        const to = events.length ? events[events.length - 1].t : from;
        const bootFrom = toBoot(events, from);
        const bootTo = toBoot(events, to);
        const toUptimeMs = (bootNs: number) => fromBootMs(events, bootNs / 1e6)?.at ?? null;

        const asked = await askTrace({
          binary,
          trace: pftracePath,
          packageName: str(hello?.packageName),
          fromNs: bootFrom.ns,
          toNs: bootTo.ns,
          toUptimeMs,
        });
        questionsAsked = true;
        traceFindings = asked.findings.map((finding) => ({ ...finding, source: "trace" as const }));
        systraceNotes.push(...asked.unanswered);
      }

      systraceBlock = {
        path: pftracePath,
        bytes: stopped.bytes,
        pulled: true,
        seconds: systracePlan.seconds,
        categories: systracePlan.categories,
        apps: systracePlan.apps,
        portholeLabels,
        questionsAsked,
        notes: systraceNotes,
      };
    }
  } else if (options.systrace) {
    // --systrace was asked for but never actually started (no package, or
    // startSystraceCapture failed) — still worth saying so in the artifact,
    // even with no .pftrace to point at. Whatever the plan resolved (categories,
    // seconds) still rides along when there was one; there is none at all when
    // the failure was "no package to scope this to" (systracePlan itself null).
    systraceBlock = {
      path: "",
      bytes: 0,
      pulled: false,
      seconds: systracePlan?.seconds ?? 0,
      categories: systracePlan?.categories ?? [],
      apps: systracePlan?.apps ?? [],
      portholeLabels: 0,
      questionsAsked: false,
      notes: systraceNotes,
    };
  }

  // GRA-185: `capture` has no window narrower than the whole run, so
  // `windowTo: Infinity` — a profile emitted anywhere in `events` (in
  // practice, `DeviceCollector`'s one startup event) counts, exactly as it
  // always has here.
  const profile = resolveProfile({ liveEvents: events, windowTo: Number.POSITIVE_INFINITY, sessionProfile: null, hello });
  const trace = buildTrace({
    scenario: options.scenario,
    driver: options.driver,
    events,
    hello,
    durationMs,
    withEvents: options.withEvents,
    profile,
  });

  if (options.systrace) {
    // GRA-103: every finding `findingsOf` already produced is porthole-sourced
    // by construction — tagged here, not inside trace.ts, so a plain
    // `porthole capture` (no --systrace) never carries a `source` field at
    // all and its JSON stays byte-for-byte what it always was. Merged with
    // whatever the trace answered and re-sorted by severity, the same order
    // `findingsOf`/`interpret` each already produce on their own.
    const rank: Record<Finding["severity"], number> = { error: 0, warning: 1, note: 2 };
    trace.findings = [
      ...trace.findings.map((finding): Finding => ({ ...finding, source: "porthole" })),
      ...extraFindings,
      ...traceFindings,
    ].sort((a, b) => rank[a.severity] - rank[b.severity]);
    if (systraceBlock) trace.systrace = systraceBlock;
  }

  await writeFile(options.out, JSON.stringify(trace, null, 2));
  // stderr, not stdout — this is the summary `porthole capture` prints
  // alongside the child command's own output, so it colours against stderr's
  // own TTY-ness, which can differ from stdout's (e.g. `capture ... | tee log`).
  process.stderr.write(`\n${renderReport(trace, { color: shouldColor(process.stderr) })}`);
  process.stderr.write(`\nwrote ${options.out} (${events.length} events)\n`);

  let regressed = false;
  if (options.baseline) {
    try {
      const before = await readTrace(options.baseline);
      const comparison = renderComparison(before, trace);
      process.stderr.write(`\n${comparison.text}`);
      regressed = comparison.regressed;
    } catch (error) {
      // Same hazard as `porthole compare` reading its two files, just reached
      // from a capture that asked to be checked against a baseline inline. A
      // baseline we could not read is not evidence either way, so it is
      // reported and the comparison is skipped rather than crashing the run
      // that was otherwise recorded successfully.
      process.stderr.write(`${(error as Error).message}\n`);
    }
  }

  const hasError = trace.findings.some((finding) => finding.severity === "error");
  if (options.failOn === "error" && hasError) return 1;
  if (options.failOn === "regression" && regressed) return 1;
  return exitCode;
}

/** Where `--systrace` writes the .pftrace, beside `out` — `porthole-trace.json` becomes `porthole-trace.pftrace`; anything without a `.json` suffix just gets `.pftrace` appended. */
function systracePathFor(out: string): string {
  return out.endsWith(".json") ? `${out.slice(0, -".json".length)}.pftrace` : `${out}.pftrace`;
}

/** Runs the child with its output passed straight through. */
function run(command: string[]): Promise<number> {
  if (command.length === 0) return Promise.resolve(0);
  return new Promise((resolve) => {
    // No shell. Passing an argv array through one concatenates it unescaped,
    // which mangles any argument containing a space and turns the command into
    // an injection point. A caller who wants a shell asks for one by name:
    // `-- bash -c "..."`.
    const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
    child.on("error", (error) => {
      process.stderr.write(`could not run ${command[0]}: ${error.message}\n`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export async function report(file: string): Promise<number> {
  let trace: Trace;
  try {
    trace = await readTrace(file);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  process.stdout.write(renderReport(trace, { color: shouldColor(process.stdout) }));
  return 0;
}

export async function compare(baseline: string, file: string): Promise<number> {
  let before: Trace;
  let after: Trace;
  try {
    before = await readTrace(baseline);
    after = await readTrace(file);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const comparison = renderComparison(before, after);
  process.stdout.write(comparison.text);
  // A refusal is not a pass. Exiting 0 would turn a gate that compared nothing
  // into a green build, which is the one outcome worse than a red one.
  if (comparison.refused) return 2;
  return comparison.regressed ? 1 : 0;
}

export function parseCapture(argv: string[]): CaptureOptions {
  const options: CaptureOptions = {
    port: 8677,
    scenario: "capture",
    out: "porthole-trace.json",
    withEvents: false,
    failOn: "nothing",
    forward: true,
    command: [],
    applicationId: process.env.PORTHOLE_APPLICATION_ID || undefined,
    legacyTcpPort: Boolean(process.env.PORTHOLE_LEGACY_TCP_PORT),
    systrace: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      options.command = argv.slice(i + 1);
      break;
    } else if (arg === "--scenario") {
      const value = requiredValue(argv[++i], "--scenario");
      if (typeof value !== "string") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.scenario = value;
    } else if (arg === "--out") {
      // Validated here, before `capture()` is ever called: a bad --out used
      // to fail only after the recording had already happened, so the run was
      // lost *and* the operator got a raw stack trace instead of a sentence.
      const value = requiredValue(argv[++i], "--out");
      if (typeof value !== "string") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.out = value;
    } else if (arg === "--driver") {
      // Previously `argv[++i]` raw: `--driver --serial abc` swallowed
      // "--serial" as the driver name and left "abc" to be rejected next as
      // a nonsense option — blaming the wrong token for the actual mistake.
      const value = requiredValue(argv[++i], "--driver");
      if (typeof value !== "string") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.driver = value;
    } else if (arg === "--baseline") {
      const value = requiredValue(argv[++i], "--baseline");
      if (typeof value !== "string") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.baseline = value;
    } else if (arg === "--with-events") options.withEvents = true;
    else if (arg === "--fail-on") {
      const value = parseFailOn(argv[++i]);
      if (typeof value !== "string") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.failOn = value;
    } else if (arg === "--port") {
      const value = parsePort(argv[++i], "--port");
      if (typeof value !== "number") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.port = value;
    } else if (arg === "--serial") {
      // Same hazard as --driver above: a raw argv[++i] blames the wrong
      // token when the value is missing or is actually the next flag.
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
    } else if (arg === "--legacy-tcp-port") options.legacyTcpPort = true;
    else if (arg === "--no-forward") options.forward = false;
    else if (arg === "--systrace") options.systrace = true;
    else if (arg === "--systrace-seconds") {
      const value = parseSeconds(argv[++i], "--systrace-seconds");
      if (typeof value !== "number") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.systraceSeconds = value;
    } else if (arg === "--systrace-categories") {
      const value = requiredValue(argv[++i], "--systrace-categories");
      if (typeof value !== "string") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.systraceCategories = value
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(CAPTURE_USAGE);
      process.exit(0);
    } else {
      process.stderr.write(`unknown option: ${arg}\n${CAPTURE_USAGE}`);
      process.exit(2);
    }
  }

  // QA (F12), per GRA-93's own discipline: an option that silently does
  // nothing is exactly the shape that ticket exists to close off elsewhere
  // in this same loop (a mistyped --fail-on, a swallowed --driver value).
  // `--systrace-seconds`/`--systrace-categories` without `--systrace` used
  // to parse cleanly and then have no effect at all — no warning, nothing —
  // which reads as "it worked" to whoever typed it. Checked once here,
  // after the loop, rather than inline at each flag: a value can arrive in
  // either order (`--systrace-seconds 30 --systrace` is exactly as valid as
  // the reverse), so this cannot be decided while the option that licenses
  // it might still be a few tokens away.
  if (!options.systrace && options.systraceSeconds !== undefined) {
    process.stderr.write(`--systrace-seconds requires --systrace\n${CAPTURE_USAGE}`);
    process.exit(2);
  }
  if (!options.systrace && options.systraceCategories !== undefined) {
    process.stderr.write(`--systrace-categories requires --systrace\n${CAPTURE_USAGE}`);
    process.exit(2);
  }

  return options;
}
