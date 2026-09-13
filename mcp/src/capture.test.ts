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
