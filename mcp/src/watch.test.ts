// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeviceClient, type Hello } from "./device.js";
import { createPortholeServer } from "./index.js";
import { TimelineServer } from "./timeline.js";
import { sessionsRoot } from "./sessions.js";
import { buildRig, connect, FakeDevice, waitUntil, type Rig } from "./testing/harness.js";
import { parseWatch, runWatch, WATCH_EXIT, type WatchOptions } from "./watch.js";

/**
 * `parsePort`/`requiredValue` themselves are tested once, in args.test.ts —
 * see cli.test.ts's own note on the same point. What is tested here is
 * `parseWatch`'s own loop (the argv-driven `process.exit(2)` wiring
 * mutation testing found missing elsewhere in this codebase before it was
 * added deliberately — see cli.ts's `parse()` doc comment) and `runWatch`'s
 * actual behaviour against a real fake device speaking the real wire
 * protocol, the same `FakeDevice`/`buildRig` `capture.test.ts` and
 * `index.test.ts` already use.
 */

const mcpRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const distCli = path.join(mcpRoot, "dist", "cli.js");
const tscBin = path.join(mcpRoot, "node_modules", "typescript", "bin", "tsc");

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let defaultProjectRoot: string;
let originalProjectRoot: string | undefined;

/**
 * Every test below that reaches an error-severity finding also reaches
 * `ensureWatermark()`, which resolves a real session directory off
 * `PORTHOLE_PROJECT_ROOT` and `mkdir`s it. Left unset, that resolves to
 * `process.cwd()` — this checkout's own `mcp/` — and every test using the
 * harness's default `hello` (same fixed identity, `DEFAULT_STARTED_AT_MS`)
 * would then share one real, persistent `.porthole/sessions/.../
 * watermark.json` across test runs. A prior run's `lastReportedErrorT`
 * would then silently suppress a later run's own findings — exactly the
 * cross-run contamination that made this file flaky before this existed. A
 * fresh temp directory per test is what keeps each test's session, and its
 * watermark, from ever being any other test's.
 */
beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  originalProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
  defaultProjectRoot = mkdtempSync(path.join(tmpdir(), "porthole-watch-test-"));
  process.env.PORTHOLE_PROJECT_ROOT = defaultProjectRoot;
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  if (originalProjectRoot === undefined) delete process.env.PORTHOLE_PROJECT_ROOT;
  else process.env.PORTHOLE_PROJECT_ROOT = originalProjectRoot;
  rmSync(defaultProjectRoot, { recursive: true, force: true });
});

function stdoutLines(): string[] {
  return stdoutSpy.mock.calls.map((call) => String(call[0])).join("").split("\n").filter((l) => l.length > 0);
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((call) => String(call[0])).join("");
}

const DEFAULT_OPTIONS: Omit<WatchOptions, "port"> = {
  severity: "error",
  untilFirst: false,
  json: false,
  forward: true,
};

/** A stall long enough that it is unambiguously the "worst" once a second, bigger one lands too. */
function pushStall(fakeDevice: FakeDevice, t: number, durationMs: number): void {
  fakeDevice.emit("blocked", t, {
    durationMs,
    top: "com.example.shop.ui.CartViewModel.blockTheMainThread(CartViewModel.kt:146)",
    stack: "com.example.shop.ui.CartViewModel.blockTheMainThread(CartViewModel.kt:146)",
  });
}

// ---------------------------------------------------------------------------
// parseWatch() wiring
// ---------------------------------------------------------------------------

describe("parseWatch() wiring", () => {
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
  });

  afterEach(() => {
    exit.mockRestore();
  });

  it("defaults to port 8677, severity error, and forwarding on", () => {
    const options = parseWatch([]);
    expect(options).toEqual({ port: 8677, severity: "error", untilFirst: false, json: false, forward: true });
    expect(exit).not.toHaveBeenCalled();
  });

  it("accepts --until-first, --json, --severity and --timeout together", () => {
    const options = parseWatch(["--until-first", "--json", "--severity", "warning", "--timeout", "30"]);
    expect(options).toEqual({
      port: 8677,
      severity: "warning",
      untilFirst: true,
      json: true,
      timeoutMs: 30_000,
      forward: true,
    });
  });

  it("exits 2 when --severity is not one of error/warning/note", () => {
    expect(() => parseWatch(["--severity", "critical"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--severity must be one of: error, warning, note");
  });

  it("exits 2 when --severity has no value", () => {
    expect(() => parseWatch(["--severity"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--severity needs a value");
  });

  it("exits 2 when --timeout is not a whole number of seconds", () => {
    expect(() => parseWatch(["--timeout", "30s"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain('--timeout "30s" is not a whole number of seconds');
  });

  it("exits 2 when --timeout is zero or negative", () => {
    expect(() => parseWatch(["--timeout", "0"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--timeout 0 must be positive");
  });

  it("exits 2 when --port is out of range", () => {
    expect(() => parseWatch(["--port", "70000"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--port 70000 is out of range");
  });

  it("exits 2 when --serial swallows the next flag instead of taking a value", () => {
    expect(() => parseWatch(["--serial", "--json"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--serial needs a value");
  });

  it("exits 2 on an unknown option", () => {
    expect(() => parseWatch(["--nonsense"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("unknown option: --nonsense");
  });

  it("--help prints usage and exits 0", () => {
    expect(() => parseWatch(["--help"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(0);
    expect(stdoutLines().join("\n")).toContain("porthole watch");
  });

  it("--no-forward turns off adb forwarding", () => {
    const options = parseWatch(["--no-forward"]);
    expect(options.forward).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runWatch(): human-readable stdout
// ---------------------------------------------------------------------------

describe("runWatch(): human-readable stdout", () => {
  let fakeDevice: FakeDevice;

  afterEach(async () => {
    await fakeDevice?.close();
  });

  it("prints nothing on a healthy app and gives up cleanly at --timeout (exit 3)", async () => {
    fakeDevice = await FakeDevice.start();
    const code = await runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, timeoutMs: 300 });
    expect(code).toBe(WATCH_EXIT.TIMEOUT);
    expect(stdoutLines()).toEqual([]);
  });

  it(
    "exits 1 within a second of an injected main-thread stall, with the stall on stdout (--until-first)",
    async () => {
      fakeDevice = await FakeDevice.start();
      const started = Date.now();
      const watching = runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, untilFirst: true, timeoutMs: 5_000 });
      // Give the handshake a moment, then inject the stall the AC is about.
      await waitUntil(() => stderrText().includes("connected to com.example.shop"));
      pushStall(fakeDevice, 2_094_551, 6_240);

      const code = await watching;
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(code).toBe(WATCH_EXIT.FOUND);

      const lines = stdoutLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("ERROR");
      expect(lines[0]).toContain("main thread blocked for 6240ms");
      expect(lines[0]).toContain("t=2088311..2094551");
      expect(lines[0]).toContain("CartViewModel.blockTheMainThread(CartViewModel.kt:146)");
    },
    10_000,
  );

  it("does not re-print an unchanged finding, but does print once a worse one raises the count", async () => {
    fakeDevice = await FakeDevice.start();
    const watching = runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, timeoutMs: 3_000 });
    await waitUntil(() => stderrText().includes("connected to com.example.shop"));

    pushStall(fakeDevice, 1_000, 800);
    await waitUntil(() => stdoutLines().length === 1, 2_000);
    expect(stdoutLines()[0]).toContain("main thread blocked for 800ms");

    // An unrelated, harmless event: no new finding, no new line.
    fakeDevice.emit("recompose", 1_100, { name: "Cart" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(stdoutLines()).toHaveLength(1);

    // A second, worse stall: `main-thread-stall`'s count goes from 1 to 2 —
    // "something new happened", even though the id is unchanged.
    pushStall(fakeDevice, 2_000, 9_000);
    await waitUntil(() => stdoutLines().length === 2, 2_000);
    expect(stdoutLines()[1]).toContain("main thread blocked for 9000ms");

    await watching;
  });

  it("--severity error (the default) excludes a warning-level finding that --severity warning includes", async () => {
    fakeDevice = await FakeDevice.start();

    const quiet = runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, timeoutMs: 400 });
    await waitUntil(() => stderrText().includes("connected to com.example.shop"));
    fakeDevice.emit("gc", 5_000, { blocking: 1, pausedMs: 120 });
    expect(await quiet).toBe(WATCH_EXIT.TIMEOUT);
    expect(stdoutLines()).toEqual([]);

    // Both cleared: `waitUntil` below checks stderr for the *second* watch's
    // own "connected" line, and without this it would match the first
    // watch's identical line still sitting in the mock's call history,
    // resolving before the second watch has actually finished connecting —
    // dropping the `gc` event pushed right after into a socket nothing is
    // listening on yet.
    stdoutSpy.mockClear();
    stderrSpy.mockClear();
    await fakeDevice.close();
    fakeDevice = await FakeDevice.start();
    const watching = runWatch({
      ...DEFAULT_OPTIONS,
      port: fakeDevice.port,
      severity: "warning",
      untilFirst: true,
      timeoutMs: 3_000,
    });
    await waitUntil(() => stderrText().includes("connected to com.example.shop"));
    fakeDevice.emit("gc", 5_000, { blocking: 1, pausedMs: 120 });
    const code = await watching;
    expect(code).toBe(WATCH_EXIT.FOUND);
    expect(stdoutLines()[0]).toContain("WARNING");
    expect(stdoutLines()[0]).toContain("blocking collections paused the app");
  });
});

// ---------------------------------------------------------------------------
// runWatch(): --json
// ---------------------------------------------------------------------------

describe("runWatch(): --json", () => {
  let fakeDevice: FakeDevice;

  afterEach(async () => {
    await fakeDevice?.close();
  });

  it("prints one JSON object per line on stdout and keeps every diagnostic on stderr", async () => {
    fakeDevice = await FakeDevice.start();
    const watching = runWatch({
      ...DEFAULT_OPTIONS,
      port: fakeDevice.port,
      json: true,
      untilFirst: true,
      timeoutMs: 3_000,
    });
    await waitUntil(() => stderrText().includes("connected to com.example.shop"));
    pushStall(fakeDevice, 2_000, 500);

    const code = await watching;
    expect(code).toBe(WATCH_EXIT.FOUND);

    const lines = stdoutLines();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { severity: string; title: string; id: string };
    expect(parsed.severity).toBe("error");
    expect(parsed.id).toBe("main-thread-stall");
    expect(parsed.title).toContain("500ms");

    // No preamble: connection chatter went to stderr, never stdout.
    expect(stderrText()).toContain("connected to com.example.shop");
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runWatch(): connection lifecycle
// ---------------------------------------------------------------------------

describe("runWatch(): connection lifecycle", () => {
  let fakeDevice: FakeDevice;

  afterEach(async () => {
    await fakeDevice?.close();
  });

  it("reconnects after the app drops and keeps watching, rather than exiting", async () => {
    // A fixed hello (unlike the harness's own advance-on-every-call default,
    // documented on DEFAULT_STARTED_AT_MS): this is the "same process,
    // socket dropped and came back" case, not "a new process" — see this
    // file's own module comment on why identity, not connection state,
    // decides whether accumulated findings survive a reconnect.
    fakeDevice = await FakeDevice.start({
      hello: (): Hello => ({
        protocol: 1,
        packageName: "com.example.shop",
        processName: "com.example.shop",
        versionName: "1.0.0-test",
        device: "Test Device",
        sdkInt: 34,
        startedAt: 47_213,
        collectors: [],
      }),
    });

    const watching = runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, timeoutMs: 6_000 });
    await waitUntil(() => stderrText().includes("connected to com.example.shop"));

    fakeDevice.disconnectAll();
    await waitUntil(() => stderrText().includes("waiting for the app..."));
    await waitUntil(() => {
      const text = stderrText();
      const afterDrop = text.slice(text.indexOf("waiting for the app..."));
      return afterDrop.includes("connected to com.example.shop");
    }, 5_000);

    // Proves the process is still the same live watch, not a new one: a
    // stall injected after the reconnect is still caught.
    pushStall(fakeDevice, 9_000, 700);
    await waitUntil(() => stdoutLines().length === 1, 2_000);
    expect(stdoutLines()[0]).toContain("main thread blocked for 700ms");

    expect(await watching).toBe(WATCH_EXIT.TIMEOUT);
  }, 15_000);

  it("stops cleanly with exit 0 the instant its AbortSignal aborts — the SIGINT wiring cli.ts uses", async () => {
    fakeDevice = await FakeDevice.start();
    const controller = new AbortController();
    const watching = runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port }, controller.signal);
    await waitUntil(() => stderrText().includes("connected to com.example.shop"));
    controller.abort();
    expect(await watching).toBe(WATCH_EXIT.CLEAN_STOP);
  });
});

// ---------------------------------------------------------------------------
// runWatch(): shared watermark — the GRA-56 dedup decision
// ---------------------------------------------------------------------------

describe("runWatch(): shares watermark.ts's lastReportedErrorT with the MCP surface", () => {
  let projectRoot: string;
  let originalProjectRoot: string | undefined;
  let fakeDevice: FakeDevice;
  let agentDevice: DeviceClient;
  let agentTimeline: TimelineServer;
  let agentClient: Awaited<ReturnType<typeof connect>>;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), "porthole-watch-session-"));
    originalProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
    process.env.PORTHOLE_PROJECT_ROOT = projectRoot;
  });

  afterEach(async () => {
    if (originalProjectRoot === undefined) delete process.env.PORTHOLE_PROJECT_ROOT;
    else process.env.PORTHOLE_PROJECT_ROOT = originalProjectRoot;
    await agentClient?.close();
    agentDevice?.stop();
    agentTimeline?.stop();
    await fakeDevice?.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** The "agent" side: a real MCP server, with sessions on (a real sessionsRoot), attached to the same fake device `watch` will also connect to. */
  async function buildAgentSide(): Promise<void> {
    fakeDevice = await FakeDevice.start();
    agentDevice = new DeviceClient("127.0.0.1", fakeDevice.port, sessionsRoot(projectRoot));
    agentTimeline = new TimelineServer(agentDevice, 0);
    const { server } = createPortholeServer({ device: agentDevice, timeline: agentTimeline, version: "0.0.0-test" });
    agentDevice.start();
    await waitUntil(() => agentDevice.hello !== null);
    agentClient = await connect(server);
  }

  it("does not re-print an error the agent's own `findings` call already surfaced on this session", async () => {
    await buildAgentSide();

    pushStall(fakeDevice, 2_000, 4_000);
    // The agent looks at its own live buffer and — via attachSinceLastAndBanner
    // (index.ts) — records lastReportedErrorT for this session on disk.
    await waitUntil(async () => {
      const result = await agentClient.callTool("findings", {});
      return result.text.includes("main thread blocked");
    });

    const code = await runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, timeoutMs: 1_000 });
    expect(code).toBe(WATCH_EXIT.TIMEOUT);
    expect(stdoutLines()).toEqual([]);
  }, 10_000);

  it("still reports a later error the agent has not seen yet, on the same session", async () => {
    await buildAgentSide();

    pushStall(fakeDevice, 2_000, 4_000);
    await waitUntil(async () => {
      const result = await agentClient.callTool("findings", {});
      return result.text.includes("main thread blocked");
    });

    const watching = runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, untilFirst: true, timeoutMs: 3_000 });
    await waitUntil(() => stderrText().includes("connected to com.example.shop"));
    // A second, later stall the agent has never looked at.
    pushStall(fakeDevice, 20_000, 9_000);

    expect(await watching).toBe(WATCH_EXIT.FOUND);
    expect(stdoutLines()).toHaveLength(1);
    expect(stdoutLines()[0]).toContain("main thread blocked for 9000ms");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// runWatch(): coexists with a running MCP server — GRA-56 open question 1
// ---------------------------------------------------------------------------

describe("runWatch(): two clients on the one device (GRA-56 open question 1)", () => {
  let rig: Rig;

  afterEach(async () => {
    await rig?.close();
  });

  it("a watch and a real MCP server rig both see the same event over the same fake device", async () => {
    rig = await buildRig();

    const watching = runWatch({
      ...DEFAULT_OPTIONS,
      port: rig.fakeDevice.port,
      untilFirst: true,
      timeoutMs: 5_000,
    });
    await waitUntil(() => stderrText().includes("connected to com.example.shop"));

    await rig.pushEvents([
      {
        event: "blocked",
        t: 3_000,
        data: {
          durationMs: 1_200,
          top: "com.example.shop.ui.CartViewModel.blockTheMainThread(CartViewModel.kt:146)",
        },
      },
    ]);

    expect(await watching).toBe(WATCH_EXIT.FOUND);
    expect(stdoutLines()[0]).toContain("main thread blocked for 1200ms");

    // The MCP server's own tool surface, on the very same rig, still works —
    // watch never took the device, its own connection or its own findings.
    const result = await rig.client.callTool("findings", {});
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("main thread blocked");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// porthole watch — the real CLI (cli.ts#watch-command)
// ---------------------------------------------------------------------------

describe("porthole watch (compiled CLI)", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [tscBin, "-p", mcpRoot], { stdio: "pipe" });
  }, 30_000);

  it("prints usage and exits 0 for --help, without touching the network", () => {
    const result = execFileSync(process.execPath, [distCli, "watch", "--help"], { encoding: "utf8" });
    expect(result).toContain("porthole watch");
    expect(result).toContain("Exit codes:");
  });

  it("exits 2 for a bad argument before ever trying to connect", () => {
    let threw: unknown;
    try {
      execFileSync(process.execPath, [distCli, "watch", "--severity", "critical"], { stdio: "pipe" });
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeDefined();
    const err = threw as { status: number; stderr: Buffer };
    expect(err.status).toBe(2);
    expect(err.stderr.toString("utf8")).toContain("--severity must be one of");
  });

  it(
    "exits 0 on SIGINT",
    async () => {
      const fakeDevice = await FakeDevice.start();
      try {
        const child = spawn(process.execPath, [
          distCli,
          "watch",
          "--port",
          String(fakeDevice.port),
          "--no-forward",
        ]);
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.stdout.on("data", () => {});

        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 8_000;
          const poll = setInterval(() => {
            if (stderr.includes("connected to com.example.shop")) {
              clearInterval(poll);
              resolve();
            } else if (Date.now() > deadline) {
              clearInterval(poll);
              reject(new Error(`timed out waiting to connect; stderr so far: ${stderr}`));
            }
          }, 25);
        });

        const exitCode = await new Promise<number | null>((resolve) => {
          child.on("exit", (code) => resolve(code));
          child.kill("SIGINT");
        });
        expect(exitCode).toBe(0);
      } finally {
        await fakeDevice.close();
      }
    },
    12_000,
  );
});
