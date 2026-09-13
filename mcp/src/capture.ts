// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { DeviceClient, type DeviceEvent } from "./device.js";
import { renderComparison, renderReport } from "./report.js";
import { buildTrace, TRACE_VERSION, type Trace } from "./trace.js";

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
  failOn: "nothing" | "error" | "regression";
  forward: boolean;
  baseline?: string;
  command: string[];
}

export const CAPTURE_USAGE = `
porthole capture — record a run and write a trace

  porthole capture --scenario <name> [options] -- <command to run>

  --scenario <name>   what this run is, and what a baseline is matched against
  --out <file>        where to write the trace (default porthole-trace.json)
  --driver <name>     what drove the app; compare warns when two runs differ
  --with-events       include the raw event stream. Large.
  --fail-on <what>    nothing (default), error, or regression
  --baseline <file>   compare against this trace when done
  --port <n>          device port (default 8677)
  --serial <id>       adb device serial
  --no-forward        skip 'adb forward'; use it if the bridge is already up

  porthole report <trace.json>
  porthole compare <baseline.json> <trace.json>

The command runs to completion with the porthole recording. Its exit code is
passed through unless --fail-on fires first.
`;

/** A parse failure that names what was wrong, for the caller to print and exit on. */
export interface ParseError {
  message: string;
}

const FAIL_ON_VALUES = ["nothing", "error", "regression"] as const;

/**
 * `--fail-on` used to be `argv[++i] as CaptureOptions["failOn"]` — a cast, not
 * a check. A typo like `regresion` compiled, ran, and turned the CI gate off
 * without saying a word: the worst failure mode here is a green build. This
 * validates against the real union and names the accepted values so the typo
 * is caught at the command line instead of at the postmortem.
 */
export function parseFailOn(raw: string | undefined): CaptureOptions["failOn"] | ParseError {
  if (raw !== undefined && (FAIL_ON_VALUES as readonly string[]).includes(raw)) {
    return raw as CaptureOptions["failOn"];
  }
  return {
    message: `--fail-on must be one of: ${FAIL_ON_VALUES.join(", ")} (got ${JSON.stringify(raw ?? null)})`,
  };
}

/**
 * A port a capture can plausibly reach. Missing, non-numeric, fractional and
 * out-of-range values were all previously accepted as-is — `Number(undefined)`
 * is `NaN`, and a `NaN` port silently never connects to anything.
 */
export function parsePort(raw: string | undefined, option: string): number | ParseError {
  if (raw === undefined) {
    return { message: `${option} needs a port number` };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { message: `${option} ${JSON.stringify(raw)} is not a number` };
  }
  if (!Number.isInteger(value)) {
    return { message: `${option} ${raw} must be a whole number` };
  }
  if (value < 1024 || value > 65535) {
    return { message: `${option} ${raw} is out of range (must be 1024-65535)` };
  }
  return value;
}

/** Thrown by readTrace; the message is written straight to stderr, so it earns its keep alone. */
export class TraceReadError extends Error {}

/**
 * Reads and validates a trace file, refusing anything that is not one, rather
 * than letting a missing file, truncated JSON, or a trace from a version this
 * build does not understand fall through as an unhandled rejection and a raw
 * stack trace — which is what a CI operator would have gotten instead of the
 * one sentence they need.
 */
export async function readTrace(file: string): Promise<Trace> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new TraceReadError(`no such file: ${file}`);
    throw new TraceReadError(`could not read ${file}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new TraceReadError(`${file} is not valid JSON`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).porthole !== "number"
  ) {
    throw new TraceReadError(`${file} is not a porthole trace (missing "porthole" version field)`);
  }

  const version = (parsed as Trace).porthole;
  if (version !== TRACE_VERSION) {
    throw new TraceReadError(
      `${file} is trace version ${version}, which this build (version ${TRACE_VERSION}) does not understand`,
    );
  }

  return parsed as Trace;
}

/** Waits for the device to answer, so a capture does not silently record nothing. */
async function awaitConnection(device: DeviceClient, timeoutMs = 10_000): Promise<boolean> {
  if (device.state === "connected") return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    device.on("state", (state: string) => {
      if (state === "connected") {
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

  const startedAt = Date.now();
  const exitCode = await run(options.command);
  const durationMs = Date.now() - startedAt;

  // The last events are still in flight when the child exits.
  await new Promise((resolve) => setTimeout(resolve, 750));
  const hello = device.hello as Record<string, unknown> | null;
  device.stop();

  const trace = buildTrace({
    scenario: options.scenario,
    driver: options.driver,
    events,
    hello,
    durationMs,
    withEvents: options.withEvents,
  });

  await writeFile(options.out, JSON.stringify(trace, null, 2));
  process.stderr.write(`\n${renderReport(trace)}`);
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
  process.stdout.write(renderReport(trace));
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
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      options.command = argv.slice(i + 1);
      break;
    } else if (arg === "--scenario") options.scenario = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--driver") options.driver = argv[++i];
    else if (arg === "--baseline") options.baseline = argv[++i];
    else if (arg === "--with-events") options.withEvents = true;
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
    } else if (arg === "--serial") options.serial = argv[++i];
    else if (arg === "--no-forward") options.forward = false;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(CAPTURE_USAGE);
      process.exit(0);
    } else {
      process.stderr.write(`unknown option: ${arg}\n${CAPTURE_USAGE}`);
      process.exit(2);
    }
  }
  return options;
}
