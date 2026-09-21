// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseDuration,
  parseFailOn,
  parseMillis,
  parsePort,
  parseSeconds,
  readTrace,
  requiredValue,
  TraceReadError,
} from "./args.js";
import { TRACE_VERSION, type Trace } from "./trace.js";

/**
 * These four — parsePort, parseFailOn, requiredValue, readTrace — used to be
 * two copies apiece: one in cli.ts, one in capture.ts (GRA-93 wrote them
 * twice on purpose, to stay inside that ticket's `Owns`). This is the single
 * copy both files import now. The tests below are the union of what each
 * copy's own suite covered, deduplicated; nothing that passed before is
 * missing here.
 */

function trace(over: Partial<Trace> = {}): Trace {
  return {
    porthole: TRACE_VERSION,
    scenario: "checkout",
    capturedAt: "2026-09-11T00:00:00Z",
    durationMs: 10_000,
    app: { packageName: "com.example.shop" },
    device: { model: "Pixel", refreshHz: 60, cores: 8, lowRamDevice: false },
    marks: [],
    metrics: {},
    findings: [],
    ...over,
  };
}

describe("parsePort", () => {
  it("names the option when the value is missing", () => {
    // porthole ui --port with nothing after it: argv[++i] is undefined.
    expect(parsePort(undefined, "--port")).toEqual({
      message: "--port needs a port number",
    });
  });

  it("names --ui-port too, not just --port", () => {
    expect(parsePort(undefined, "--ui-port")).toEqual({
      message: "--ui-port needs a port number",
    });
  });

  it("rejects a non-numeric value", () => {
    expect(parsePort("abc", "--port")).toEqual({
      message: '--port "abc" is not a number',
    });
  });

  it("rejects a negative port", () => {
    expect(parsePort("-1", "--port")).toEqual({
      message: "--port -1 is out of range (must be 1024-65535)",
    });
  });

  it("rejects a port above 65535", () => {
    expect(parsePort("70000", "--port")).toEqual({
      message: "--port 70000 is out of range (must be 1024-65535)",
    });
  });

  it("rejects a fractional port", () => {
    // QA bait: 8677.5 is finite and Number() happily parses it, but it is
    // not a port a socket can listen on.
    expect(parsePort("8677.5", "--port")).toEqual({
      message: "--port 8677.5 must be a whole number",
    });
  });

  it("rejects the default's neighbor just under the privileged boundary", () => {
    expect(parsePort("1023", "--port")).toEqual({
      message: "--port 1023 is out of range (must be 1024-65535)",
    });
  });

  it("accepts the documented default", () => {
    expect(parsePort("8677", "--port")).toBe(8677);
  });

  it("accepts both range boundaries", () => {
    expect(parsePort("1024", "--port")).toBe(1024);
    expect(parsePort("65535", "--port")).toBe(65535);
  });

  it("treats an empty value as missing, not as an out-of-range number", () => {
    // "" used to reach Number("") === 0 and report "out of range"; an empty
    // value is a missing value, not a number at all.
    expect(parsePort("", "--port")).toEqual({
      message: "--port needs a port number",
    });
  });

  it("rejects whitespace padding that Number() would silently trim", () => {
    expect(parsePort(" 8677 ", "--port")).toEqual({
      message: '--port " 8677 " is not a number',
    });
  });

  it("rejects scientific notation", () => {
    expect(parsePort("1e4", "--port")).toEqual({
      message: '--port "1e4" is not a number',
    });
  });

  it("rejects hex", () => {
    expect(parsePort("0x2000", "--port")).toEqual({
      message: '--port "0x2000" is not a number',
    });
  });
});

/**
 * capture.ts had its own copy of this exact suite before GRA-124 — same
 * function, same inputs, exercised a second time because parsePort was a
 * second copy of the code too. The two files' tests never actually differed
 * in what they proved, only in which boundary case each one happened to name
 * first. Kept as its own describe, unmerged, so the ticket's "test count
 * does not go down" holds by the numbers vitest actually prints, not just by
 * argument.
 */
describe("parsePort (capture.ts's copy, before the two copies became one)", () => {
  it("names the option when the value is missing", () => {
    const result = parsePort(undefined, "--port");
    expect(result).toEqual({ message: "--port needs a port number" });
  });

  it("rejects a non-numeric value", () => {
    const result = parsePort("abc", "--port");
    expect(result).toEqual({ message: '--port "abc" is not a number' });
  });

  it("rejects a negative port", () => {
    const result = parsePort("-1", "--port");
    expect(result).toEqual({
      message: "--port -1 is out of range (must be 1024-65535)",
    });
  });

  it("rejects a port above 65535", () => {
    const result = parsePort("70000", "--port");
    expect(result).toEqual({
      message: "--port 70000 is out of range (must be 1024-65535)",
    });
  });

  it("rejects a fractional port", () => {
    const result = parsePort("8677.5", "--port");
    expect(result).toEqual({ message: "--port 8677.5 must be a whole number" });
  });

  it("rejects the low boundary just below 1024", () => {
    const result = parsePort("1023", "--port");
    expect(result).toEqual({
      message: "--port 1023 is out of range (must be 1024-65535)",
    });
  });

  it("accepts the range boundaries", () => {
    expect(parsePort("1024", "--port")).toBe(1024);
    expect(parsePort("65535", "--port")).toBe(65535);
  });

  it("accepts an ordinary port", () => {
    expect(parsePort("8677", "--port")).toBe(8677);
  });

  it("names whichever option asked", () => {
    const result = parsePort(undefined, "--ui-port");
    expect(result).toEqual({ message: "--ui-port needs a port number" });
  });

  it("treats an empty value as missing, not as an out-of-range number", () => {
    expect(parsePort("", "--port")).toEqual({ message: "--port needs a port number" });
  });

  it("rejects whitespace padding that Number() would silently trim", () => {
    expect(parsePort(" 8677 ", "--port")).toEqual({
      message: '--port " 8677 " is not a number',
    });
  });

  it("rejects scientific notation", () => {
    expect(parsePort("1e4", "--port")).toEqual({ message: '--port "1e4" is not a number' });
  });

  it("rejects hex", () => {
    expect(parsePort("0x2000", "--port")).toEqual({ message: '--port "0x2000" is not a number' });
  });
});

describe("requiredValue", () => {
  it("passes through an ordinary value", () => {
    expect(requiredValue("checkout", "--scenario")).toBe("checkout");
  });

  it("refuses a missing value", () => {
    expect(requiredValue(undefined, "--scenario")).toEqual({
      message: "--scenario needs a value",
    });
  });

  it("refuses the next flag rather than swallowing it as the value", () => {
    // `--scenario --port 8677` used to set scenario to the literal string
    // "--port" and leave "8677" to be rejected later as an unknown option —
    // blaming the wrong flag for the actual mistake.
    expect(requiredValue("--port", "--scenario")).toEqual({
      message: "--scenario needs a value",
    });
  });

  it("refuses the command separator rather than swallowing it as the value", () => {
    expect(requiredValue("--", "--scenario")).toEqual({
      message: "--scenario needs a value",
    });
  });
});

describe("parseFailOn", () => {
  it("accepts the three real values", () => {
    expect(parseFailOn("nothing")).toBe("nothing");
    expect(parseFailOn("error")).toBe("error");
    expect(parseFailOn("regression")).toBe("regression");
  });

  it("rejects a typo and lists the accepted values", () => {
    const result = parseFailOn("regresion");
    expect(result).toEqual({
      message: '--fail-on must be one of: nothing, error, regression (got "regresion")',
    });
  });

  it("rejects a missing value and still lists the accepted values", () => {
    const result = parseFailOn(undefined);
    expect(result).toEqual({
      message: "--fail-on must be one of: nothing, error, regression (got null)",
    });
  });
});

describe("readTrace", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "porthole-args-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, contents: string): string {
    const file = path.join(dir, name);
    writeFileSync(file, contents);
    return file;
  }

  it("reads back a valid trace", async () => {
    const file = write("trace.json", JSON.stringify(trace()));
    await expect(readTrace(file)).resolves.toEqual(trace());
  });

  it("refuses a file that does not exist, by name, with no stack trace leaking through", async () => {
    const missing = path.join(dir, "missing.json");
    await expect(readTrace(missing)).rejects.toThrow(TraceReadError);
    await expect(readTrace(missing)).rejects.toThrow(`no such file: ${missing}`);
  });

  it("refuses truncated JSON with one sentence", async () => {
    const file = write("truncated.json", '{"porthole": 1, "scenario":');
    await expect(readTrace(file)).rejects.toThrow(TraceReadError);
    await expect(readTrace(file)).rejects.toThrow(`${file} is not valid JSON`);
  });

  it("refuses a JSON file with no porthole version field", async () => {
    const file = write("no-version.json", JSON.stringify({ scenario: "checkout" }));
    await expect(readTrace(file)).rejects.toThrow(
      `${file} is not a porthole trace (missing "porthole" version field)`,
    );
  });

  it("refuses a trace whose version this build does not understand", async () => {
    const file = write("future.json", JSON.stringify(trace({ porthole: TRACE_VERSION + 1 })));
    await expect(readTrace(file)).rejects.toThrow(
      `${file} is trace version ${TRACE_VERSION + 1}, which this build (version ${TRACE_VERSION}) does not understand`,
    );
  });

  it("refuses an empty JSON object the same way as a missing field", async () => {
    const file = write("empty.json", "{}");
    await expect(readTrace(file)).rejects.toThrow('missing "porthole" version field');
  });
});

/** GRA-54: `porthole save --from`/`--to`. */
describe("parseMillis", () => {
  it("names the option when the value is missing", () => {
    expect(parseMillis(undefined, "--from")).toEqual({ message: "--from needs a millisecond value" });
  });

  it("names the option when the value is empty", () => {
    expect(parseMillis("", "--to")).toEqual({ message: "--to needs a millisecond value" });
  });

  it("rejects a non-numeric value", () => {
    expect(parseMillis("soon", "--from")).toEqual({ message: '--from "soon" is not a number' });
  });

  it("rejects a fractional value", () => {
    expect(parseMillis("100.5", "--from")).toEqual({ message: "--from 100.5 must be a whole number" });
  });

  it("rejects a negative value (no leading minus in the accepted shape)", () => {
    expect(parseMillis("-5", "--from")).toEqual({ message: '--from "-5" is not a number' });
  });

  it("accepts 0 — the very start of the uptime clock, not a missing value", () => {
    expect(parseMillis("0", "--from")).toBe(0);
  });

  it("accepts an ordinary uptime millisecond value", () => {
    expect(parseMillis("2057010", "--to")).toBe(2_057_010);
  });

  it("rejects scientific notation and hex, which Number() would otherwise accept", () => {
    expect(parseMillis("1e4", "--from")).toEqual({ message: '--from "1e4" is not a number' });
    expect(parseMillis("0x10", "--from")).toEqual({ message: '--from "0x10" is not a number' });
  });
});

/** GRA-103: `porthole capture --systrace-seconds`. */
describe("parseSeconds", () => {
  it("names the option when the value is missing", () => {
    expect(parseSeconds(undefined, "--systrace-seconds")).toEqual({
      message: "--systrace-seconds needs a whole number of seconds",
    });
  });

  it("names the option when the value is empty", () => {
    expect(parseSeconds("", "--systrace-seconds")).toEqual({
      message: "--systrace-seconds needs a whole number of seconds",
    });
  });

  it("rejects a non-numeric value", () => {
    expect(parseSeconds("soon", "--systrace-seconds")).toEqual({
      message: '--systrace-seconds "soon" is not a whole number of seconds',
    });
  });

  it("rejects a fractional value", () => {
    expect(parseSeconds("30.5", "--systrace-seconds")).toEqual({
      message: '--systrace-seconds "30.5" is not a whole number of seconds',
    });
  });

  it("rejects zero and negative values", () => {
    expect(parseSeconds("0", "--systrace-seconds")).toEqual({
      message: "--systrace-seconds 0 must be positive",
    });
    expect(parseSeconds("-5", "--systrace-seconds")).toEqual({
      message: '--systrace-seconds "-5" is not a whole number of seconds',
    });
  });

  it("accepts an ordinary value", () => {
    expect(parseSeconds("45", "--systrace-seconds")).toBe(45);
  });

  // Unlike --port, this does not refuse a value over 120 — planCapture's own
  // clamp (1-120s) answers that with a note in the plan, not a refusal at
  // the CLI, the same way capture_system_trace's `seconds` parameter behaves.
  it("accepts a value planCapture will later clamp, without refusing it here", () => {
    expect(parseSeconds("9999", "--systrace-seconds")).toBe(9999);
  });

  it("rejects scientific notation, which Number() would otherwise accept", () => {
    expect(parseSeconds("1e4", "--systrace-seconds")).toEqual({
      message: '--systrace-seconds "1e4" is not a whole number of seconds',
    });
  });
});

/** GRA-54: `porthole save --since`. */
describe("parseDuration", () => {
  it("names the option when the value is missing", () => {
    expect(parseDuration(undefined, "--since")).toEqual({
      message: "--since needs a duration (e.g. 10m, 90s, 2h, or a millisecond count)",
    });
  });

  it("names the option when the value is empty", () => {
    expect(parseDuration("", "--since")).toEqual({
      message: "--since needs a duration (e.g. 10m, 90s, 2h, or a millisecond count)",
    });
  });

  it("rejects a malformed unit", () => {
    expect(parseDuration("10x", "--since")).toEqual({
      message: '--since "10x" is not a duration (use 10m, 90s, 2h, or a millisecond count)',
    });
  });

  it("rejects a compound duration like 1h30m — one unit only", () => {
    expect(parseDuration("1h30m", "--since")).toEqual({
      message: '--since "1h30m" is not a duration (use 10m, 90s, 2h, or a millisecond count)',
    });
  });

  it("rejects zero — a lookback of nothing is not a window", () => {
    expect(parseDuration("0", "--since")).toEqual({ message: "--since 0 must be positive" });
    expect(parseDuration("0m", "--since")).toEqual({ message: "--since 0m must be positive" });
  });

  it("accepts a bare millisecond count", () => {
    expect(parseDuration("1500", "--since")).toBe(1_500);
  });

  it("converts minutes to milliseconds", () => {
    expect(parseDuration("10m", "--since")).toBe(600_000);
  });

  it("converts seconds to milliseconds", () => {
    expect(parseDuration("90s", "--since")).toBe(90_000);
  });

  it("converts hours to milliseconds", () => {
    expect(parseDuration("2h", "--since")).toBe(7_200_000);
  });

  it("accepts an explicit ms suffix", () => {
    expect(parseDuration("250ms", "--since")).toBe(250);
  });
});
