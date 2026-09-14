// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compare, parseCapture, report } from "./capture.js";
import { TRACE_VERSION, type Trace } from "./trace.js";

/**
 * parsePort, parseFailOn, requiredValue and readTrace — what GRA-93 is
 * about — moved to args.ts under GRA-124, along with their tests; see
 * args.test.ts. What is left here is capture.ts's own behavior: parseCapture
 * wiring those validators into its argv loop, and report()/compare() wiring
 * readTrace into their exit codes.
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

  /**
   * QA non-blocking #1 on GRA-124: cli.test.ts already had this case (parse()
   * calling parsePort with an out-of-range value), but capture.ts's own
   * argv loop never did — the missing-value case above was covered on both
   * sides, the out-of-range case only on one. Mutating the range check in
   * parsePort turned cli.test.ts red without touching this file, which is
   * exactly the asymmetry a shared validator is supposed to make impossible.
   */
  it("exits 2 when --port is out of range", () => {
    expect(() => parseCapture(["--port", "70000"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--port 70000 is out of range");
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

  /**
   * GRA-124 scoped fix, not just a rename: --driver and --serial used to read
   * `argv[++i]` raw, with no check at all. A missing value was accepted
   * silently (no test could have caught that — there was nothing to assert
   * against), and `--driver --serial abc` swallowed "--serial" as the driver
   * name and left "abc" to be rejected next as a nonsense option, blaming the
   * wrong token. Routed through requiredValue, both now name the flag the
   * user actually typed, same as --scenario/--out/--baseline already did.
   */
  it("exits 2 when --driver has no value", () => {
    expect(() => parseCapture(["--driver"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--driver needs a value");
  });

  it("exits 2 when --driver swallows the next flag instead of taking a value", () => {
    expect(() => parseCapture(["--driver", "--serial", "abc"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--driver needs a value");
  });

  it("exits 2 when --serial has no value", () => {
    expect(() => parseCapture(["--serial"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--serial needs a value");
  });

  it("exits 2 when --serial swallows the next flag instead of taking a value", () => {
    expect(() => parseCapture(["--serial", "--port", "8677"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--serial needs a value");
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
