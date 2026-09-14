// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { TRACE_VERSION, type Trace } from "./trace.js";

/**
 * Argument validators shared by cli.ts (`porthole ui`, `porthole capture`)
 * and capture.ts (`capture`, `report`, `compare`).
 *
 * GRA-93 fixed the CLI's silent argument handling but, inside that ticket's
 * `Owns`, wrote `parsePort` twice — once per file that needed it — rather
 * than add a third file neither ticket owned. That was the right call for
 * that ticket alone. It is exactly the shape that produced GRA-87
 * (`findAdb` existed twice and neither copy read `local.properties`): two
 * copies agree until the day someone changes one of them, and the
 * disagreement is silent because each copy has its own tests. This module
 * is that follow-up — one definition per validator, imported by both
 * commands, so 0.2.0's new commands reach for the same rules everyone else
 * did.
 */

/** A parse failure that names what was wrong, for the caller to print and exit on. */
export interface ParseError {
  message: string;
}

/**
 * A port a device or a browser can plausibly reach. `--port` used to be
 * `Number(argv[++i])` with no check at all: a missing value is `NaN`, and a
 * `NaN` port is not a refusal, it is a listener that never connects to
 * anything while printing nothing to say why. Below 1024 needs privileges
 * this process does not have on most platforms; above 65535 does not exist;
 * a fraction is a typo, not a port.
 */
export function parsePort(raw: string | undefined, option: string): number | ParseError {
  if (raw === undefined || raw === "") {
    return { message: `${option} needs a port number` };
  }
  // A port is a run of decimal digits, nothing else: `Number()` also accepts
  // " 8677 " (trims whitespace), "1e4" (scientific notation) and "0x2000"
  // (hex) as finite integers, none of which anyone typed on purpose.
  if (/^-?\d+$/.test(raw)) {
    const value = Number(raw);
    if (value < 1024 || value > 65535) {
      return { message: `${option} ${raw} is out of range (must be 1024-65535)` };
    }
    return value;
  }
  if (/^-?\d+\.\d+$/.test(raw)) {
    return { message: `${option} ${raw} must be a whole number` };
  }
  return { message: `${option} ${JSON.stringify(raw)} is not a number` };
}

const FAIL_ON_VALUES = ["nothing", "error", "regression"] as const;

export type FailOn = (typeof FAIL_ON_VALUES)[number];

/**
 * `--fail-on` used to be `argv[++i] as CaptureOptions["failOn"]` — a cast, not
 * a check. A typo like `regresion` compiled, ran, and turned the CI gate off
 * without saying a word: the worst failure mode here is a green build. This
 * validates against the real union and names the accepted values so the typo
 * is caught at the command line instead of at the postmortem.
 */
export function parseFailOn(raw: string | undefined): FailOn | ParseError {
  if (raw !== undefined && (FAIL_ON_VALUES as readonly string[]).includes(raw)) {
    return raw as FailOn;
  }
  return {
    message: `--fail-on must be one of: ${FAIL_ON_VALUES.join(", ")} (got ${JSON.stringify(raw ?? null)})`,
  };
}

/**
 * A required string option's value must actually be there — and must not be
 * the next flag left dangling because this one's value was omitted.
 * `--scenario` at the end of the command line and `--scenario --port 8677`
 * were both silently accepted before: the first became `undefined` with no
 * complaint, the second swallowed `--port` as the scenario name and left
 * `8677` to be rejected later as a nonsense option, blaming the wrong flag.
 */
export function requiredValue(raw: string | undefined, option: string): string | ParseError {
  if (raw === undefined || raw === "--" || raw.startsWith("--")) {
    return { message: `${option} needs a value` };
  }
  return raw;
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
