// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compare,
  parseCapture,
  parseFailOn,
  parsePort,
  readTrace,
  report,
  requiredValue,
  TraceReadError,
} from "./capture.js";
import { TRACE_VERSION, type Trace } from "./trace.js";

/**
 * These three — parsePort, parseFailOn, readTrace — are what GRA-93 is about.
 * Each used to take whatever argv or a file handed it and use it without
 * asking whether it made sense: a missing --port became NaN and never
 * connected to anything, a typo'd --fail-on silently turned a CI gate off,
 * and a missing or malformed trace file became an unhandled rejection and a
 * raw stack trace instead of the one sentence a CI operator needs. They are
 * pure (or close enough — readTrace only reads a file, it does not touch
 * process), so there is no excuse not to test them directly rather than only
 * through the CLI.
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
    // "" used to reach Number("") === 0, reported as "out of range" rather
    // than the missing value it actually is.
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
    dir = mkdtempSync(path.join(tmpdir(), "porthole-capture-"));
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

describe("report() and compare() exit codes", () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "porthole-capture-cli-"));
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, contents: string): string {
    const file = path.join(dir, name);
    writeFileSync(file, contents);
    return file;
  }

  it("report() exits 2 with one sentence for a missing file, and prints nothing else", async () => {
    const missing = path.join(dir, "missing.json");
    const code = await report(missing);
    expect(code).toBe(2);
    expect(stderr.join("")).toBe(`no such file: ${missing}\n`);
    expect(stdout.join("")).toBe("");
  });

  it("report() exits 2 for truncated JSON", async () => {
    const file = write("truncated.json", "{not json");
    const code = await report(file);
    expect(code).toBe(2);
    expect(stderr.join("")).toBe(`${file} is not valid JSON\n`);
  });

  it("compare() refuses (exit 2, not 0 or 1) a baseline with an unknown trace version", async () => {
    const baseline = write(
      "baseline.json",
      JSON.stringify(trace({ porthole: TRACE_VERSION + 1 })),
    );
    const after = write("after.json", JSON.stringify(trace()));
    const code = await compare(baseline, after);
    expect(code).toBe(2);
    expect(stderr.join("")).toContain(
      `${baseline} is trace version ${TRACE_VERSION + 1}, which this build (version ${TRACE_VERSION}) does not understand`,
    );
    expect(stdout.join("")).toBe("");
  });

  it("compare() refuses a baseline JSON with no porthole field at all", async () => {
    const baseline = write("baseline.json", JSON.stringify({ scenario: "checkout" }));
    const after = write("after.json", JSON.stringify(trace()));
    const code = await compare(baseline, after);
    expect(code).toBe(2);
    expect(stderr.join("")).toContain('missing "porthole" version field');
  });

  it("compare() still exits 2 for a comparability refusal, unrelated to version", async () => {
    const baseline = write(
      "baseline.json",
      JSON.stringify(trace({ device: { model: "Pixel", refreshHz: 60 } })),
    );
    const after = write(
      "after.json",
      JSON.stringify(trace({ device: { model: "Pixel", refreshHz: 120 } })),
    );
    const code = await compare(baseline, after);
    expect(code).toBe(2);
  });

  it("compare() exits 0 for two comparable, unchanged traces", async () => {
    const baseline = write("baseline.json", JSON.stringify(trace()));
    const after = write("after.json", JSON.stringify(trace()));
    const code = await compare(baseline, after);
    expect(code).toBe(0);
  });
});

describe("parseCapture failOn wiring", () => {
  // parseFailOn and parsePort are exercised directly above; this just pins
  // that parseCapture's default stays "nothing" so a capture run with no
  // --fail-on flag at all does not start gating on anything by accident.
  it("defaults failOn to nothing", () => {
    const options = parseCapture(["--", "true"]);
    expect(options.failOn).toBe("nothing");
  });
});

/**
 * The pure validators above (parsePort, parseFailOn, requiredValue) being
 * correct proves nothing about parseCapture's own argv loop, which is the
 * thing that actually decides whether a refusal stops the program. Mutation
 * testing found that gutting the --fail-on branch here — so a typo silently
 * became `failOn: "nothing"` — did not turn a single existing test red,
 * because every test that touched --fail-on called `parseFailOn` directly
 * and never drove the loop that is supposed to act on its result. These call
 * `parseCapture` itself and check that a refusal really exits and is never
 * quietly absorbed into a default.
 */
describe("parseCapture wiring", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    exit.mockRestore();
    stderr.mockRestore();
  });

  function stderrText(): string {
    return stderr.mock.calls.map((call) => String(call[0])).join("");
  }

  it("exits 2 and lists the accepted values when --fail-on is a typo", () => {
    expect(() => parseCapture(["--fail-on", "regresion", "--", "true"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--fail-on must be one of: nothing, error, regression");
  });

  it("exits 2 when --port has no value", () => {
    expect(() => parseCapture(["--port"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--port needs a port number");
  });

  it("exits 2 when --out has no value, before any capture could start", () => {
    expect(() => parseCapture(["--out"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--out needs a value");
  });

  it("exits 2 when --out is followed by another flag instead of a filename", () => {
    expect(() => parseCapture(["--out", "--fail-on", "error"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--out needs a value");
  });

  it("exits 2 when --baseline has no value", () => {
    expect(() => parseCapture(["--baseline"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--baseline needs a value");
  });

  it("exits 2 when --scenario has no value", () => {
    expect(() => parseCapture(["--scenario"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--scenario needs a value");
  });

  it("exits 2 when --scenario swallows the next flag instead of taking a value", () => {
    expect(() => parseCapture(["--scenario", "--baseline", "b.json"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--scenario needs a value");
  });

  it("accepts a fully valid argv without exiting", () => {
    const options = parseCapture([
      "--scenario",
      "checkout",
      "--out",
      "trace.json",
      "--fail-on",
      "error",
      "--",
      "true",
    ]);
    expect(options).toMatchObject({ scenario: "checkout", out: "trace.json", failOn: "error" });
    expect(exit).not.toHaveBeenCalled();
  });
});
