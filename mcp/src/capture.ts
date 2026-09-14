// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { DeviceClient, type DeviceEvent } from "./device.js";
import { renderComparison, renderReport } from "./report.js";
import { buildTrace, type Trace } from "./trace.js";
import { parseFailOn, parsePort, readTrace, requiredValue, type FailOn } from "./args.js";

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
  // Non-null here unless the app disconnected again during the run — a real,
  // separate risk (the process under test crashed or was reinstalled mid-run)
  // that this ticket does not attempt to paper over. It is no longer possible
  // for this to be null merely because we asked too early: awaitConnection()
  // above only returns once DeviceClient has actually set hello (GRA-157).
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
    } else if (arg === "--no-forward") options.forward = false;
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
