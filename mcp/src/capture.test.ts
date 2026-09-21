// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { capture, compare, parseCapture, report, type CaptureOptions } from "./capture.js";
import { TRACE_VERSION, type Trace } from "./trace.js";
import { buildRig } from "./testing/harness.js";
import { buildFakeAdb, fakeAdbArgsKey } from "./testing/fakeAdb.js";
import { buildFakeTraceProcessor } from "./testing/fakeTraceProcessor.js";
import { backgroundCaptureArgs, planCapture } from "./systrace.js";

const ESCAPE = /\x1b/;

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

/**
 * A raw TCP listener speaking just enough of the wire protocol for a real
 * `DeviceClient` (which `capture()` constructs internally) to connect and
 * exchange hello — with the hello answer deliberately delayed, so the test
 * below exercises the real handshake window instead of an instant
 * auto-answer racing nothing. See device.test.ts's own `startRawServer` for
 * the pattern this borrows; duplicated rather than imported because
 * device.test.ts's version lives in a test file, not a shared module.
 */
function startDelayedHelloServer(helloDelayMs: number): net.Server {
  return net.createServer((socket) => {
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let request: { id: number; method: string } | undefined;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        if (request?.method === "hello") {
          setTimeout(() => {
            socket.write(
              JSON.stringify({
                id: request!.id,
                ok: true,
                result: {
                  protocol: 1,
                  packageName: "com.example.shop",
                  processName: "com.example.shop",
                  versionName: "1.0.0-test",
                  device: "Test Device",
                  sdkInt: 34,
                  startedAt: 0,
                  collectors: [],
                },
              }) + "\n",
            );
          }, helloDelayMs);
        }
      }
    });
  });
}

/**
 * GRA-103: a raw hello server that answers immediately, with a real
 * `packageName` — `capture() --systrace` needs one to scope both the
 * on-device recording and `askTrace`'s own questions to. Same wire-protocol
 * shape as `startDelayedHelloServer` above, minus the delay this suite's own
 * tests have no reason to exercise.
 */
function startImmediateHelloServer(packageName: string): net.Server {
  return net.createServer((socket) => {
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let request: { id: number; method: string } | undefined;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        if (request?.method === "hello") {
          socket.write(
            JSON.stringify({
              id: request.id,
              ok: true,
              result: {
                protocol: 1,
                packageName,
                processName: packageName,
                versionName: "1.0.0-test",
                device: "Test Device",
                sdkInt: 34,
                startedAt: 0,
                collectors: [],
              },
            }) + "\n",
          );
        }
      }
    });
  });
}

describe("capture() never records hello: null for a session it reports as connected (GRA-157 AC5)", () => {
  let dir: string;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "porthole-capture-race-"));
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("waits through a delayed handshake and writes a trace with hello actually set", async () => {
    // Longer than capture.ts's own fixed 750ms post-command wait ("the last
    // events are still in flight when the child exits") — that wait is
    // unrelated to the connection race this AC is about, but it is long
    // enough to accidentally swallow a short hello delay and make this test
    // pass even against the pre-GRA-157 code, which was checked by hand
    // against 200ms before landing on this value. 1200ms clears it with
    // margin while staying well under the ~2s measured on real hardware.
    const server = startDelayedHelloServer(1200);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    const out = path.join(dir, "race-trace.json");
    const options: CaptureOptions = {
      port,
      scenario: "race",
      out,
      withEvents: false,
      failOn: "nothing",
      forward: false,
      command: [], // nothing to run; the race is entirely in the connect phase
    };

    try {
      const code = await capture(options);
      expect(code).toBe(0);
      const trace = JSON.parse(readFileSync(out, "utf8")) as Trace;
      // This is the actual assertion: buildTrace() reads packageName off
      // `hello?.packageName`, which silently becomes "" if hello was null —
      // no throw, no error, just a poisoned trace with an empty app name.
      // Verified by hand against the pre-GRA-157 device.ts (awaitConnection()
      // resolved on the raw TCP connect rather than on hello): this exact
      // assertion went red with `expected '' to be 'com.example.shop'`,
      // confirming both that this test detects the race and that capture.ts's
      // own unrelated 750ms post-command wait is not what was protecting it.
      expect(trace.app.packageName).toBe("com.example.shop");
    } finally {
      server.close();
    }
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
    const baseline = write("baseline.json", JSON.stringify(trace({ porthole: TRACE_VERSION + 1 })));
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

/**
 * GRA-142: report()'s print call is supposed to decide colour from the
 * real stream it is about to write to, not from a hardcoded default —
 * report.test.ts already proves renderReport(trace) with no options stays
 * plain and renderReport(trace, { color: true }) colours ERROR; what is not
 * proven there is that capture.ts's own print call actually reads
 * process.stdout.isTTY and NO_COLOR and threads the result through. These
 * force process.stdout.isTTY the way a real terminal would, which is what
 * makes this a forced-TTY test of the wiring rather than of renderReport
 * itself.
 */
describe("report()'s print call wires real TTY-ness through to renderReport (GRA-142)", () => {
  let dir: string;
  let stdout: string[];
  let originalIsTTY: boolean | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "porthole-capture-colour-"));
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    originalIsTTY = process.stdout.isTTY;
    originalNoColor = process.env.NO_COLOR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.stdout.isTTY = originalIsTTY;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTrace(): string {
    const file = path.join(dir, "trace.json");
    writeFileSync(
      file,
      JSON.stringify(
        trace({
          findings: [{ id: "e", severity: "error", confidence: "observed", title: "an error" }],
        }),
      ),
    );
    return file;
  }

  it("colours ERROR when stdout is a real TTY", async () => {
    process.stdout.isTTY = true;
    delete process.env.NO_COLOR;
    const code = await report(writeTrace());
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("\x1b[31mERROR");
  });

  it("stays plain when stdout is a TTY but NO_COLOR is set", async () => {
    process.stdout.isTTY = true;
    process.env.NO_COLOR = "1";
    const code = await report(writeTrace());
    expect(code).toBe(0);
    expect(stdout.join("")).not.toMatch(ESCAPE);
  });

  it("stays plain when stdout is not a TTY, NO_COLOR or not (the piped/CI case, and every test above this one)", async () => {
    process.stdout.isTTY = false;
    delete process.env.NO_COLOR;
    const code = await report(writeTrace());
    expect(code).toBe(0);
    expect(stdout.join("")).not.toMatch(ESCAPE);
  });
});

/**
 * GRA-142 AC: "The MCP `findings` tool's returned text contains no escape
 * bytes (test)." This goes through the real tool handler in index.ts — not
 * owned by this ticket, and not touched by it — via the same behavioural
 * harness index.test.ts uses, rather than asserting against report.ts's own
 * output (findings never calls renderReport; its summary is built inline in
 * index.ts from plain template literals). Forcing process.stdout.isTTY here
 * is deliberate: it proves the tool text stays plain even in an environment
 * that would colour the CLI path, i.e. that "plain" is not an accident of
 * this test always running non-TTY.
 */
describe("the MCP findings tool never emits colour (GRA-142)", () => {
  let originalIsTTY: boolean | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    originalNoColor = process.env.NO_COLOR;
    // Cleared, not just left alone. An ambient NO_COLOR=1 — a real thing in
    // some shells/CI, and how this exact gap was found — makes shouldColor()
    // return false regardless of isTTY. Left untouched, that would silently
    // neutralise this test's TTY-forcing the moment findings is ever routed
    // through report.ts's colouring the way capture.ts is, which is the
    // regression this test exists to catch: the test would keep passing in
    // any NO_COLOR-set environment even after that regression landed.
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  });

  it("findings' returned text has no escape bytes even with a real finding and a forced TTY", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents([
        { event: "db_start", t: 1_000, data: { id: "q-1" } },
        { event: "db_end", t: 1_012, data: { id: "q-1", sql: "SELECT 1", onMainThread: "true" } },
      ]);
      const result = await rig.client.callTool("findings", { detail: "normal" });
      expect(result.isError).toBeFalsy();
      const payload = result.json as { findings: Array<{ severity: string }> };
      // Sanity check that this actually exercised a coloured-elsewhere
      // severity, not an empty list that would pass trivially.
      expect(payload.findings.some((f) => f.severity === "error")).toBe(true);
      expect(result.text).not.toMatch(ESCAPE);
    } finally {
      await rig.close();
    }
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

/**
 * GRA-103: `porthole capture --systrace` — the CLI's own argv wiring for the
 * three new flags. `parseSeconds`/`requiredValue` are exercised directly in
 * args.test.ts; this is `parseCapture`'s own loop actually acting on them,
 * the same split `parseCapture wiring` above draws for every other flag.
 */
describe("parseCapture --systrace wiring (GRA-103)", () => {
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

  it("defaults to off", () => {
    const options = parseCapture(["--", "true"]);
    expect(options.systrace).toBe(false);
    expect(options.systraceSeconds).toBeUndefined();
    expect(options.systraceCategories).toBeUndefined();
  });

  it("turns --systrace on with no value", () => {
    const options = parseCapture(["--systrace", "--", "true"]);
    expect(options.systrace).toBe(true);
  });

  it("parses --systrace-seconds", () => {
    const options = parseCapture(["--systrace", "--systrace-seconds", "45", "--", "true"]);
    expect(options.systraceSeconds).toBe(45);
  });

  it("exits 2 when --systrace-seconds is not a whole number", () => {
    expect(() => parseCapture(["--systrace-seconds", "soon"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--systrace-seconds");
  });

  it("exits 2 when --systrace-seconds has no value", () => {
    expect(() => parseCapture(["--systrace-seconds"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--systrace-seconds needs a whole number of seconds");
  });

  it("splits --systrace-categories on commas and trims each one", () => {
    const options = parseCapture(["--systrace", "--systrace-categories", "sched, freq ,gfx", "--", "true"]);
    expect(options.systraceCategories).toEqual(["sched", "freq", "gfx"]);
  });

  it("exits 2 when --systrace-categories has no value", () => {
    expect(() => parseCapture(["--systrace-categories"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--systrace-categories needs a value");
  });

  /**
   * QA F12: these two flags used to be accepted and silently ignored
   * without `--systrace` — no warning, nothing, which reads as "it worked"
   * to whoever typed it. GRA-93's own discipline (this ticket's dependency)
   * is that a flag with no effect is a usage error, not a quiet no-op.
   */
  it("exits 2 for --systrace-seconds without --systrace, naming the flag", () => {
    expect(() => parseCapture(["--systrace-seconds", "30", "--", "true"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--systrace-seconds requires --systrace");
  });

  it("exits 2 for --systrace-categories without --systrace, naming the flag", () => {
    expect(() => parseCapture(["--systrace-categories", "sched", "--", "true"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--systrace-categories requires --systrace");
  });

  it("does not care what order --systrace arrives in relative to the flag it licenses", () => {
    expect(() => parseCapture(["--systrace-seconds", "30", "--systrace", "--", "true"])).not.toThrow();
    const options = parseCapture(["--systrace-seconds", "30", "--systrace", "--", "true"]);
    expect(options.systrace).toBe(true);
    expect(options.systraceSeconds).toBe(30);
  });
});

/**
 * GRA-103: `porthole capture --systrace` end to end — the on-device
 * recording, pulled beside the trace JSON, its findings merged into the same
 * `findings` array, each carrying `source`.
 *
 * A real device (an immediate-hello raw server, same wire protocol
 * `startDelayedHelloServer` above already speaks) drives `capture()`'s own
 * `DeviceClient`; a fake `adb` (`testing/fakeAdb.ts`) stands in for the
 * on-device perfetto session and the pull; a fake `trace_processor_shell`
 * (`testing/fakeTraceProcessor.ts`) stands in for `askTrace`'s own spawn —
 * the same three-seam shape `index.test.ts`'s own GRA-89/GRA-186 rig uses
 * for `capture_system_trace`, reassembled here for the CLI path instead of
 * the MCP tool.
 */
describe("porthole capture --systrace (GRA-103)", () => {
  const PACKAGE = "com.example.shop";
  let dir: string;
  let server: net.Server;
  let port: number;
  let originalTraceProcessorEnv: string | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "porthole-capture-systrace-"));
    server = startImmediateHelloServer(PACKAGE);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as net.AddressInfo).port;
    // GRA-103: --systrace checks PORTHOLE_TRACE_PROCESSOR before its own
    // `findTraceProcessor` lookup, same as the MCP tool — cleared here so a
    // developer's own real, cached trace_processor_shell (this ticket's own
    // Build section has one at ~/.porthole/trace-processor/) can never make
    // these tests pass or fail depending on whose machine runs them.
    originalTraceProcessorEnv = process.env.PORTHOLE_TRACE_PROCESSOR;
    delete process.env.PORTHOLE_TRACE_PROCESSOR;
  });

  afterEach(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    if (originalTraceProcessorEnv === undefined) delete process.env.PORTHOLE_TRACE_PROCESSOR;
    else process.env.PORTHOLE_TRACE_PROCESSOR = originalTraceProcessorEnv;
  });

  function baseOptions(over: Partial<CaptureOptions> = {}): CaptureOptions {
    return {
      port,
      scenario: "systrace-e2e",
      out: path.join(dir, "porthole-trace.json"),
      withEvents: false,
      failOn: "nothing",
      forward: false,
      command: [],
      legacyTcpPort: false,
      systrace: true,
      systraceNow: 1_726_000_000_000,
      ...over,
    };
  }

  function planFor(options: CaptureOptions) {
    return planCapture({
      seconds: options.systraceSeconds ?? 120,
      categories: options.systraceCategories,
      apps: [PACKAGE],
      now: options.systraceNow,
    });
  }

  function pftracePathFor(options: CaptureOptions): string {
    return options.out.endsWith(".json")
      ? `${options.out.slice(0, -".json".length)}.pftrace`
      : `${options.out}.pftrace`;
  }

  it("writes both files, merges trace findings into the same array with their source, and records portholeLabels", async () => {
    const options = baseOptions();
    const plan = planFor(options);
    const pftracePath = pftracePathFor(options);
    const pid = 4321;

    writeFileSync(pftracePath, "porthole: nav home\nporthole: db SELECT 1\n");

    const fakeAdb = buildFakeAdb({
      [fakeAdbArgsKey(backgroundCaptureArgs(plan))]: { stdout: "" },
      [fakeAdbArgsKey(["shell", "ps", "-A", "-o", "PID,ARGS"])]: {
        stdout: `PID ARGS\n${pid} perfetto --background-wait -o ${plan.devicePath} -t ${plan.seconds}s\n`,
      },
      [fakeAdbArgsKey(["shell", `kill -TERM ${pid}`])]: { stdout: "" },
      [fakeAdbArgsKey(["pull", plan.devicePath, pftracePath])]: { stdout: "1 file pulled" },
      [fakeAdbArgsKey(["shell", "rm", "-f", plan.devicePath])]: { stdout: "" },
    });
    const fakeTp = buildFakeTraceProcessor({
      jank: {
        rows: [
          {
            jank_type: "missed_frame",
            COUNT: 1,
            "MIN(dur)": 1_000_000,
            "MAX(dur)": 6_000_000,
            "AVG(dur)": 6_000_000,
            "MIN(ts)": 0,
            "MAX(ts)": 6_000_000,
          },
        ],
      },
    });

    try {
      const code = await capture({
        ...options,
        adbBinary: fakeAdb.binaryPath,
        adbEnv: fakeAdb.env,
        findTraceProcessor: () => fakeTp.binaryPath,
      });
      expect(code).toBe(0);

      expect(readFileSync(pftracePath, "utf8")).toContain("porthole:");
      const trace = JSON.parse(readFileSync(options.out, "utf8")) as Trace;

      expect(trace.systrace).toBeDefined();
      expect(trace.systrace?.path).toBe(pftracePath);
      expect(trace.systrace?.portholeLabels).toBe(2);
      expect(trace.systrace?.questionsAsked).toBe(true);

      // Every finding carries its source, and the trace-derived one is in
      // the very same array as anything findingsOf would have produced.
      expect(trace.findings.length).toBeGreaterThan(0);
      expect(trace.findings.every((f) => f.source === "porthole" || f.source === "trace")).toBe(true);
      const traceFinding = trace.findings.find((f) => f.id === "trace-frame-deadline");
      expect(traceFinding?.source).toBe("trace");
    } finally {
      fakeAdb.cleanup();
      fakeTp.cleanup();
    }
    // Longer than vitest's 5s default: the fake `ps` scan always reports the
    // session still running, so stopAndPullSystraceCapture's own poll runs
    // to its full, bounded timeout before pulling anyway — see that
    // function's own doc comment in systrace.ts for why a real emulator
    // needs exactly this "tidy up regardless" behaviour.
  }, 10_000);

  it("still succeeds, still writes the .pftrace, and says the questions were not asked (and how to fix that) with no trace_processor_shell", async () => {
    const options = baseOptions();
    const plan = planFor(options);
    const pftracePath = pftracePathFor(options);
    const pid = 5555;

    writeFileSync(pftracePath, "porthole: nav home\n");

    const fakeAdb = buildFakeAdb({
      [fakeAdbArgsKey(backgroundCaptureArgs(plan))]: { stdout: "" },
      [fakeAdbArgsKey(["shell", "ps", "-A", "-o", "PID,ARGS"])]: {
        stdout: `PID ARGS\n${pid} perfetto --background-wait -o ${plan.devicePath} -t ${plan.seconds}s\n`,
      },
      [fakeAdbArgsKey(["shell", `kill -TERM ${pid}`])]: { stdout: "" },
      [fakeAdbArgsKey(["pull", plan.devicePath, pftracePath])]: { stdout: "1 file pulled" },
      [fakeAdbArgsKey(["shell", "rm", "-f", plan.devicePath])]: { stdout: "" },
    });

    try {
      // GRA-103 AC: "the lookup pointed at nothing" — a fake lookup that
      // always returns null, exactly as if this machine had never run
      // `./gradlew portholeTraceProcessor`.
      const code = await capture({
        ...options,
        adbBinary: fakeAdb.binaryPath,
        adbEnv: fakeAdb.env,
        findTraceProcessor: () => null,
      });
      expect(code).toBe(0);

      const trace = JSON.parse(readFileSync(options.out, "utf8")) as Trace;
      expect(trace.systrace?.questionsAsked).toBe(false);
      expect(trace.systrace?.path).toBe(pftracePath);
      expect(readFileSync(pftracePath, "utf8").length).toBeGreaterThan(0);
      expect(trace.systrace?.notes.join(" ")).toMatch(/No trace_processor_shell found/);
      expect(trace.systrace?.notes.join(" ")).toMatch(/portholeTraceProcessor/);
      // Nothing here could have come from a trace this run never queried.
      expect(trace.findings.every((f) => f.source !== "trace")).toBe(true);
    } finally {
      fakeAdb.cleanup();
    }
  }, 10_000);

  it("produces a warning when portholeLabels is 0", async () => {
    const options = baseOptions();
    const plan = planFor(options);
    const pftracePath = pftracePathFor(options);
    const pid = 6666;

    // No "porthole: " markers anywhere in it.
    writeFileSync(pftracePath, "sched_switch prev_comm=foo\n");

    const fakeAdb = buildFakeAdb({
      [fakeAdbArgsKey(backgroundCaptureArgs(plan))]: { stdout: "" },
      [fakeAdbArgsKey(["shell", "ps", "-A", "-o", "PID,ARGS"])]: {
        stdout: `PID ARGS\n${pid} perfetto --background-wait -o ${plan.devicePath} -t ${plan.seconds}s\n`,
      },
      [fakeAdbArgsKey(["shell", `kill -TERM ${pid}`])]: { stdout: "" },
      [fakeAdbArgsKey(["pull", plan.devicePath, pftracePath])]: { stdout: "1 file pulled" },
      [fakeAdbArgsKey(["shell", "rm", "-f", plan.devicePath])]: { stdout: "" },
    });

    try {
      const code = await capture({
        ...options,
        adbBinary: fakeAdb.binaryPath,
        adbEnv: fakeAdb.env,
        findTraceProcessor: () => null,
      });
      expect(code).toBe(0);

      const trace = JSON.parse(readFileSync(options.out, "utf8")) as Trace;
      expect(trace.systrace?.portholeLabels).toBe(0);
      const warning = trace.findings.find((f) => f.id === "systrace-no-porthole-labels");
      expect(warning).toBeDefined();
      expect(warning?.severity).toBe("warning");
      expect(warning?.source).toBe("porthole");
    } finally {
      fakeAdb.cleanup();
    }
  }, 10_000);

  /**
   * QA F11: this used to leave `trace.systrace` entirely absent on a pull
   * failure — the `!stopped.ok` branch pushed a note onto `systraceNotes`
   * and then fell straight through, never assigning `systraceBlock` at all,
   * so the note went nowhere a reader of the trace JSON would ever see it
   * and the artifact was indistinguishable from a plain `porthole capture`
   * with no `--systrace`. Also asserts systrace.ts's own half of the fix:
   * the on-device file is left in place (no `rm -f`) when the pull that was
   * supposed to retrieve it never succeeded — deleting the only complete
   * copy of a recording because the *download* of it failed would turn one
   * flaky `adb pull` into total data loss.
   */
  it("still writes a systrace block, with the notes and no local file, when the pull itself fails — and never rm's the device copy (QA F11)", async () => {
    const options = baseOptions();
    const plan = planFor(options);
    const pftracePath = pftracePathFor(options);
    const pid = 7777;

    const fakeAdb = buildFakeAdb({
      [fakeAdbArgsKey(backgroundCaptureArgs(plan))]: { stdout: "" },
      [fakeAdbArgsKey(["shell", "ps", "-A", "-o", "PID,ARGS"])]: {
        stdout: `PID ARGS\n${pid} perfetto --background-wait -o ${plan.devicePath} -t ${plan.seconds}s\n`,
      },
      [fakeAdbArgsKey(["shell", `kill -TERM ${pid}`])]: { stdout: "" },
      [fakeAdbArgsKey(["pull", plan.devicePath, pftracePath])]: {
        stderr: "adb: error: failed to stat remote object",
        exitCode: 1,
      },
      // Deliberately no response configured for `shell rm -f <devicePath>`:
      // if the fix regressed and this were called anyway, the fake adb
      // process would exit 17 ("no configured response") — belt and braces
      // alongside the direct assertion on `fakeAdb.calls()` below.
    });

    try {
      const code = await capture({
        ...options,
        adbBinary: fakeAdb.binaryPath,
        adbEnv: fakeAdb.env,
        findTraceProcessor: () => null,
      });
      // A failed pull is not itself a reason to fail the whole `porthole
      // capture` run — the porthole-sourced half of the trace still
      // recorded fine, same as capture.ts's own baseline() comment on
      // --systrace failures elsewhere.
      expect(code).toBe(0);

      const trace = JSON.parse(readFileSync(options.out, "utf8")) as Trace;
      expect(trace.systrace).toBeDefined();
      expect(trace.systrace?.pulled).toBe(false);
      expect(trace.systrace?.bytes).toBe(0);
      expect(trace.systrace?.path).toBe("");
      expect(trace.systrace?.notes.join(" ")).toMatch(/could not pull it/);
      expect(trace.systrace?.notes.join(" ")).toContain(plan.devicePath);
      expect(existsSync(pftracePath)).toBe(false);

      const calls = fakeAdb.calls();
      expect(calls.some((c) => c[0] === "pull")).toBe(true);
      expect(calls.some((c) => c[0] === "shell" && c[1] === "rm")).toBe(false);
    } finally {
      fakeAdb.cleanup();
    }
  }, 10_000);
});

/**
 * GRA-103 AC: `compare` handles a baseline without trace findings against a
 * run with them, and vice versa, without refusing — tested both directions.
 * `comparability`/`compareMetrics` (report.ts) never look at `findings` at
 * all, so this is really pinning that fact rather than fixing anything —
 * but the ticket asks for it proven, not just true by construction, and a
 * future change that does start reading `findings` for comparability should
 * break this test rather than silently starting to refuse.
 */
describe("compare() and findings sourced from a system trace (GRA-103)", () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "porthole-capture-compare-systrace-"));
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

  const withTraceFindings: Partial<Trace> = {
    findings: [
      {
        id: "trace-frame-deadline",
        severity: "error",
        confidence: "observed",
        title: "the frame timeline recorded 1× missed_frame",
        source: "trace",
      },
      {
        id: "db-on-main-thread",
        severity: "error",
        confidence: "observed",
        title: "1 database query ran on the main thread",
        source: "porthole",
      },
    ],
    systrace: {
      path: "porthole-trace.pftrace",
      bytes: 1024,
      pulled: true,
      seconds: 30,
      categories: ["sched"],
      apps: ["com.example.shop"],
      portholeLabels: 4,
      questionsAsked: true,
      notes: [],
    },
  };

  it("does not refuse a baseline WITHOUT trace findings compared against a run WITH them", async () => {
    const baseline = write("baseline.json", JSON.stringify(trace()));
    const after = write("after.json", JSON.stringify(trace(withTraceFindings)));
    const code = await compare(baseline, after);
    expect(code).toBe(0);
    expect(stdout.join("")).not.toMatch(/refusing to compare/);
  });

  it("does not refuse a baseline WITH trace findings compared against a run WITHOUT them", async () => {
    const baseline = write("baseline.json", JSON.stringify(trace(withTraceFindings)));
    const after = write("after.json", JSON.stringify(trace()));
    const code = await compare(baseline, after);
    expect(code).toBe(0);
    expect(stdout.join("")).not.toMatch(/refusing to compare/);
  });
});
