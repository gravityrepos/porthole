// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeviceClient, type DeviceEvent, type Hello } from "./device.js";
import { createPortholeServer } from "./index.js";
import { TimelineServer } from "./timeline.js";
import { sessionsRoot } from "./sessions.js";
import { buildRig, connect, FakeDevice, waitUntil, type Rig } from "./testing/harness.js";
import {
  parseWatch,
  runWatch,
  trimEventWindow,
  WATCH_EVENT_WINDOW_MS,
  WATCH_EXIT,
  type WatchOptions,
} from "./watch.js";

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
  legacyTcpPort: false,
};

/** A stall long enough that it is unambiguously the "worst" once a second, bigger one lands too. */
function pushStall(fakeDevice: FakeDevice, t: number, durationMs: number): void {
  fakeDevice.emit("blocked", t, {
    durationMs,
    top: "com.example.shop.ui.CartViewModel.blockTheMainThread(CartViewModel.kt:146)",
    stack: "com.example.shop.ui.CartViewModel.blockTheMainThread(CartViewModel.kt:146)",
  });
}

/** A completed, failing HTTP call — `findingsOf`'s `http-failed` needs a matched `http_start`/`http_end` pair with a 4xx+ status (trace.ts's `spans`/`isCompleted`). */
function pushFailedHttp(fakeDevice: FakeDevice, id: string, startT: number, endT: number, status = 500): void {
  fakeDevice.emit("http_start", startT, { id, method: "GET", url: `https://api.example.com/${id}` });
  fakeDevice.emit("http_end", endT, {
    id,
    method: "GET",
    url: `https://api.example.com/${id}`,
    status: String(status),
    elapsedMs: String(endT - startT),
  });
}

/**
 * A `hello` handler that answers the same identity every time, unlike the
 * harness's own default (`DEFAULT_STARTED_AT_MS`'s own comment: it advances
 * `startedAt` on every call, deliberately, so an *unmodified* reconnect
 * reads as a new process). Any test that connects more than one
 * `DeviceClient` to the same `FakeDevice` — two `watch`es, or a `watch`
 * beside an "agent" `DeviceClient` — needs this: each connection triggers
 * its own `hello`, and two different `startedAt`s resolve to two different
 * session identities (`sessions.ts`), and therefore two different
 * `watermark.json` paths, which would make every "shares the session"
 * assertion pass or fail for the wrong reason.
 */
function fixedHelloHandlers(): { hello: () => Hello } {
  return {
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
  };
}

// ---------------------------------------------------------------------------
// parseWatch() wiring
// ---------------------------------------------------------------------------

describe("parseWatch() wiring", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let originalApplicationId: string | undefined;
  let originalLegacyTcpPort: string | undefined;

  beforeEach(() => {
    exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    // `parseWatch`'s own defaults read these two (GRA-56 QA, F1), so a
    // developer's real shell environment must not leak into what "no flags
    // given" means here — the same isolation `PORTHOLE_PROJECT_ROOT` gets
    // in this file's other describe blocks.
    originalApplicationId = process.env.PORTHOLE_APPLICATION_ID;
    originalLegacyTcpPort = process.env.PORTHOLE_LEGACY_TCP_PORT;
    delete process.env.PORTHOLE_APPLICATION_ID;
    delete process.env.PORTHOLE_LEGACY_TCP_PORT;
  });

  afterEach(() => {
    exit.mockRestore();
    if (originalApplicationId === undefined) delete process.env.PORTHOLE_APPLICATION_ID;
    else process.env.PORTHOLE_APPLICATION_ID = originalApplicationId;
    if (originalLegacyTcpPort === undefined) delete process.env.PORTHOLE_LEGACY_TCP_PORT;
    else process.env.PORTHOLE_LEGACY_TCP_PORT = originalLegacyTcpPort;
  });

  it("defaults to port 8677, severity error, forwarding on, and no application id or legacy port", () => {
    const options = parseWatch([]);
    expect(options).toEqual({
      port: 8677,
      severity: "error",
      untilFirst: false,
      json: false,
      forward: true,
      applicationId: undefined,
      legacyTcpPort: false,
    });
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
      applicationId: undefined,
      legacyTcpPort: false,
    });
  });

  // GRA-56 QA (F1 blocker): `watch` needs the same GRA-199 forward-target
  // options `ui`/`capture` already have — see `forwardTarget()` (devices.ts)
  // for the actual routing logic these fields feed cli.ts's dispatch with;
  // `forwardTarget` itself is unit-tested in devices.test.ts, so this is
  // scoped to `parseWatch`'s own job: argv and env reach `WatchOptions`
  // correctly.
  it("--application-id sets applicationId", () => {
    const options = parseWatch(["--application-id", "com.example.shop"]);
    expect(options.applicationId).toBe("com.example.shop");
  });

  it("--legacy-tcp-port sets legacyTcpPort", () => {
    const options = parseWatch(["--legacy-tcp-port"]);
    expect(options.legacyTcpPort).toBe(true);
  });

  it("PORTHOLE_APPLICATION_ID is the default applicationId when --application-id is not given", () => {
    process.env.PORTHOLE_APPLICATION_ID = "com.example.shop";
    const options = parseWatch([]);
    expect(options.applicationId).toBe("com.example.shop");
  });

  it("--application-id overrides PORTHOLE_APPLICATION_ID", () => {
    process.env.PORTHOLE_APPLICATION_ID = "com.example.other";
    const options = parseWatch(["--application-id", "com.example.shop"]);
    expect(options.applicationId).toBe("com.example.shop");
  });

  it("PORTHOLE_LEGACY_TCP_PORT (any truthy value) is the default legacyTcpPort when --legacy-tcp-port is not given", () => {
    process.env.PORTHOLE_LEGACY_TCP_PORT = "1";
    const options = parseWatch([]);
    expect(options.legacyTcpPort).toBe(true);
  });

  it("exits 2 when --application-id has no value", () => {
    expect(() => parseWatch(["--application-id"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--application-id needs a value");
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

  /**
   * GRA-56 QA (W2 blocker), exact repro #1. `main-thread-stall`'s `window`
   * pins to the *worst* stall seen so far (trace.ts's `findingsOf`), not
   * the newest — so a second, distinct, but *smaller* stall raises `count`
   * without moving `window` at all. The buggy version gated the shared
   * watermark on the finding's own `window.to`: once that had been advanced
   * past the first (worse) stall's fixed window, this second, genuinely new
   * occurrence's identical, unmoved window read as "already reported" and
   * was silently dropped — permanent silence after the first stall.
   *
   * Mutation this pins: reverting `evaluate()`'s shared-watermark gate from
   * comparing `newest` (this tick's newest examined event) back to
   * comparing the finding's own `anchorT(finding, newest)` — i.e.
   * `finding.window?.to ?? newest` — makes this test fail, because the
   * second stall's `window.to` is still `1_000` (the worse stall's own),
   * which is `<= last` (already `1_000` from the first print).
   */
  it("W2 regression: a second, smaller, distinct stall is not swallowed by the first stall's fixed window", async () => {
    fakeDevice = await FakeDevice.start();
    const watching = runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, timeoutMs: 3_000 });
    await waitUntil(() => stderrText().includes("connected to com.example.shop"));

    pushStall(fakeDevice, 1_000, 800);
    await waitUntil(() => stdoutLines().length === 1, 2_000);
    expect(stdoutLines()[0]).toContain("main thread blocked for 800ms");

    // Smaller than the first: `worst` (trace.ts) stays anchored on the
    // 800ms stall, so this finding's own `window` is byte-for-byte
    // unchanged from the first print — only `count` (1 -> 2) says anything
    // happened at all.
    pushStall(fakeDevice, 5_000, 300);
    await waitUntil(() => stdoutLines().length === 2, 2_000);

    await watching;
  });

  /**
   * GRA-56 QA (W2 blocker), exact repro #2. `http-failed`'s `window` pins
   * to the *first* failed call (trace.ts: `const first = failed[0];`), so
   * every failure after the first — worse, smaller, it does not matter —
   * shares that exact same window forever. The buggy gate read the second
   * failure's `window.to` as identical to the first's, already `<= last`,
   * and dropped it: "a watch left running is permanently silent after the
   * first HTTP failure," QA's own words.
   */
  it("W2 regression: a second, later HTTP failure is not swallowed by the first failure's fixed window", async () => {
    fakeDevice = await FakeDevice.start();
    const watching = runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, timeoutMs: 3_000 });
    await waitUntil(() => stderrText().includes("connected to com.example.shop"));

    pushFailedHttp(fakeDevice, "req-1", 1_000, 1_200, 500);
    await waitUntil(() => stdoutLines().length === 1, 2_000);
    expect(stdoutLines()[0]).toContain("HTTP");
    expect(stdoutLines()[0]).toContain("failed");

    // A second, separate failed call — `http-failed`'s window stays pinned
    // to the *first* one (`failed[0]`), so this is the case that never
    // moves `window` at all, on any severity difference.
    pushFailedHttp(fakeDevice, "req-2", 5_000, 5_100, 500);
    await waitUntil(() => stdoutLines().length === 2, 2_000);

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
// runWatch(): aggregate findings are throttled, point findings are not —
// GRA-56 QA, F25
// ---------------------------------------------------------------------------

describe("runWatch(): frames-dropped/recompose-hotspot throttle to one line per 10s; point findings never do", () => {
  let fakeDevice: FakeDevice;

  afterEach(async () => {
    await fakeDevice?.close();
  });

  /**
   * GRA-56 QA (F25) reproduction: a jank episode that keeps ticking for
   * (synthetic) seconds used to print a fresh line roughly every 200ms
   * tick, all for the same still-ongoing episode — QA's own report
   * measured 17 lines, counts walking 32 -> 209. Pushed here as ten real
   * batches (crossing several real 200ms ticks, so this actually exercises
   * the throttle across multiple `evaluate()` calls, not one burst
   * evaluated once) whose synthetic `t` values span ten seconds of device
   * uptime — the exact quantity `AGGREGATE_REPRINT_MS` throttles against.
   * "One or two lines" (never in between, never thirty) is what QA's own
   * acceptance criterion asks for: one for the episode's first sighting,
   * and — only if a batch's timing happens to land the throttle window's
   * own boundary inside the ten-second span — at most one reprint.
   */
  it(
    "a jank episode ticking many times over ~10s of device uptime produces one or two lines, never one per tick",
    async () => {
      fakeDevice = await FakeDevice.start();
      const watching = runWatch({
        ...DEFAULT_OPTIONS,
        port: fakeDevice.port,
        severity: "warning",
        timeoutMs: 4_000,
      });
      await waitUntil(() => stderrText().includes("connected to com.example.shop"));

      const batches = 10;
      const framesPerBatch = 3;
      const spanMs = 10_000; // the exact quantity AGGREGATE_REPRINT_MS throttles against
      for (let batch = 0; batch < batches; batch++) {
        for (let i = 0; i < framesPerBatch; i++) {
          const t = Math.round(((batch * framesPerBatch + i) / (batches * framesPerBatch)) * spanMs);
          fakeDevice.emit("frame", t, { missedFrames: 1, totalMs: 50, worstPhase: "swapBuffers" });
        }
        // Real delay, not synthetic: crosses at least one real 200ms tick
        // per batch, so `evaluate()` genuinely runs several times across
        // this loop rather than seeing the whole episode in one recompute.
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      // A little more real time for the last batch's tick to land.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const lines = stdoutLines();
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const line of lines) expect(line).toContain("frames missed their deadline");

      // Lets the natural --timeout finish the run cleanly rather than
      // tearing the socket down mid-test (afterEach closes fakeDevice).
      expect(await watching).toBe(WATCH_EXIT.TIMEOUT);
    },
    10_000,
  );

  /**
   * The other half of F25's own acceptance criterion, and the reason
   * `AGGREGATE_FINDING_IDS` is a specific, named allow-list rather than
   * "anything whose count grew": a point finding (a stall) still gets a
   * line for every genuinely new occurrence, even well inside what would
   * be the aggregate throttle window, since it is never in that list.
   * `runWatch(): human-readable stdout`'s own "does not re-print an
   * unchanged finding..." test already exercises this (two stalls one
   * second apart, well inside 10s, both printed) — this is the same
   * property named explicitly for F25's own record.
   */
  it("a point finding (a stall) prints once per genuinely new occurrence, unaffected by the aggregate throttle", async () => {
    fakeDevice = await FakeDevice.start();
    const watching = runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, timeoutMs: 3_000 });
    await waitUntil(() => stderrText().includes("connected to com.example.shop"));

    pushStall(fakeDevice, 1_000, 800);
    await waitUntil(() => stdoutLines().length === 1, 2_000);
    // Well inside AGGREGATE_REPRINT_MS (10s) — a stall is not in
    // AGGREGATE_FINDING_IDS, so the throttle must not apply to it at all.
    pushStall(fakeDevice, 3_000, 9_000);
    await waitUntil(() => stdoutLines().length === 2, 2_000);

    await watching;
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
// trimEventWindow() / WATCH_EVENT_WINDOW_MS — GRA-56 QA, W3
// ---------------------------------------------------------------------------

describe("trimEventWindow()", () => {
  it("keeps events within WATCH_EVENT_WINDOW_MS of the newest and drops everything older", () => {
    // Three times the retained window, one event per millisecond — pushing
    // the pure function directly (no sockets, no timers) rather than
    // running a real watch for 30 minutes of simulated device time.
    const total = WATCH_EVENT_WINDOW_MS * 3;
    const events: DeviceEvent[] = Array.from({ length: total }, (_, t) => ({
      event: "recompose",
      t,
      seq: t,
      data: {},
    }));
    const newest = events[events.length - 1].t;

    trimEventWindow(events, newest);

    // Bounded to (approximately) the window, not to the original 3x size —
    // the actual QA acceptance ("assert length after pushing 3x the cap").
    expect(events.length).toBeLessThan(total / 2);
    expect(events.length).toBeLessThanOrEqual(WATCH_EVENT_WINDOW_MS + 1);
    expect(events.every((e) => e.t >= newest - WATCH_EVENT_WINDOW_MS)).toBe(true);
    // The newest event itself always survives.
    expect(events[events.length - 1].t).toBe(newest);
  });

  it("does nothing when everything already fits inside the window", () => {
    const events: DeviceEvent[] = [
      { event: "recompose", t: 1_000, seq: 1, data: {} },
      { event: "recompose", t: 2_000, seq: 2, data: {} },
    ];
    trimEventWindow(events, 2_000);
    expect(events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// runWatch(): an internal error is exit 2, never 1 — GRA-56 QA, W3
// ---------------------------------------------------------------------------

describe("runWatch(): an internal error in evaluate() exits 2, not 1", () => {
  afterEach(() => {
    vi.doUnmock("./trace.js");
    vi.resetModules();
  });

  /**
   * `--until-first`'s whole contract is "exit code 1 means a finding was
   * found, and the finding is on stdout" — a hook checks `$?` and trusts
   * that. If `evaluate()` itself throws (a defect in `findingsOf` or
   * `resolveProfile`, not anything the device said), that must never read
   * as the same code: a hook would act on a "finding" that does not exist
   * on stdout at all. `findingsOf` is mocked to throw so this is
   * deterministic rather than hoping to provoke a real crash from device
   * data — `watch.js` is re-imported fresh (`vi.resetModules()` +
   * `vi.doMock`, not the hoisted `vi.mock`) so this is the only test in the
   * file that ever sees a fake `findingsOf`.
   */
  it("reports the error on stderr and exits 2, never WATCH_EXIT.FOUND", async () => {
    vi.doMock("./trace.js", async () => {
      const actual = await vi.importActual<typeof import("./trace.js")>("./trace.js");
      return {
        ...actual,
        findingsOf: () => {
          throw new Error("synthetic evaluate() failure");
        },
      };
    });
    vi.resetModules();
    const isolated = await import("./watch.js");

    const fakeDevice = await FakeDevice.start();
    try {
      const watching = isolated.runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, timeoutMs: 3_000 });
      await waitUntil(() => stderrText().includes("connected to com.example.shop"));
      // Any event is enough to make `evaluate()` run and call the (mocked,
      // throwing) `findingsOf`.
      fakeDevice.emit("recompose", 1_000, { name: "Cart" });

      const code = await watching;
      expect(code).toBe(isolated.WATCH_EXIT.BAD_ARGS);
      expect(code).not.toBe(isolated.WATCH_EXIT.FOUND);
      expect(stderrText()).toContain("internal error");
      expect(stderrText()).toContain("synthetic evaluate() failure");
      expect(stdoutLines()).toEqual([]);
    } finally {
      await fakeDevice.close();
    }
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
    // A fixed hello: this is the "same process, socket dropped and came
    // back" case, not "a new process" — see this file's own module comment
    // on why identity, not connection state, decides whether accumulated
    // findings survive a reconnect, and `fixedHelloHandlers`'s own comment
    // on why the harness's own advancing default would not do here.
    fakeDevice = await FakeDevice.start(fixedHelloHandlers());

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

  /**
   * The "agent" side: a real MCP server, with sessions on (a real
   * sessionsRoot), attached to the same fake device `watch` will also
   * connect to. A fixed `hello` (see `fixedHelloHandlers`'s own comment) so
   * the agent's `DeviceClient` and `watch`'s own — two separate connections
   * to the same `fakeDevice` — resolve to the same session identity.
   */
  async function buildAgentSide(): Promise<void> {
    fakeDevice = await FakeDevice.start(fixedHelloHandlers());
    agentDevice = new DeviceClient("127.0.0.1", fakeDevice.port, sessionsRoot(projectRoot));
    agentTimeline = new TimelineServer(agentDevice, 0);
    const { server } = createPortholeServer({ device: agentDevice, timeline: agentTimeline, version: "0.0.0-test" });
    agentDevice.start();
    await waitUntil(() => agentDevice.hello !== null);
    agentClient = await connect(server);
  }

  /**
   * `waitUntil`'s `predicate` is declared `() => boolean` — a synchronous
   * check, not an async one — and passing an `async () => {...}` arrow
   * function there does not do what it looks like it does: the predicate
   * itself (a pending `Promise`) is a truthy object, so `!predicate()`
   * reads false on the very first check and `waitUntil` returns
   * immediately, having fired off a `findings` call it never actually
   * waited on. This is the correct alternative for "wait until the agent's
   * own live buffer has the event, then make exactly one, properly awaited
   * `findings` call" — a sync check against `agentTimeline.buffer()`
   * (visible to this describe block, unlike the agent's internal state)
   * followed by one real `await`.
   */
  async function waitForAgentToReportTheStall(): Promise<void> {
    await waitUntil(() => agentTimeline.buffer().some((e) => e.event === "blocked"));
    const result = await agentClient.callTool("findings", {});
    expect(result.text).toContain("main thread blocked");
  }

  it("does not re-print an error the agent's own `findings` call already surfaced on this session", async () => {
    await buildAgentSide();

    pushStall(fakeDevice, 2_000, 4_000);
    // The agent looks at its own live buffer and — via attachSinceLastAndBanner
    // (index.ts) — records lastReportedErrorT for this session on disk.
    await waitForAgentToReportTheStall();

    const code = await runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, timeoutMs: 1_000 });
    expect(code).toBe(WATCH_EXIT.TIMEOUT);
    expect(stdoutLines()).toEqual([]);
  }, 10_000);

  it("still reports a later error the agent has not seen yet, on the same session", async () => {
    await buildAgentSide();

    pushStall(fakeDevice, 2_000, 4_000);
    await waitForAgentToReportTheStall();

    const watching = runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, untilFirst: true, timeoutMs: 3_000 });
    await waitUntil(() => stderrText().includes("connected to com.example.shop"));
    // A second, later stall the agent has never looked at.
    pushStall(fakeDevice, 20_000, 9_000);

    expect(await watching).toBe(WATCH_EXIT.FOUND);
    expect(stdoutLines()).toHaveLength(1);
    expect(stdoutLines()[0]).toContain("main thread blocked for 9000ms");
  }, 10_000);

  /**
   * GRA-56 QA (W1 defect), the direction the pre-fix suite never checked:
   * `watch` reports first, and the agent's *own* banner must not repeat it.
   * Before W1, `attachSinceLastAndBanner`'s `watermark.open(currentWatermarkDir())`
   * was a no-op for an unchanged directory — the MCP server's `Watermark`
   * instance had already opened this session on its first tool call and
   * never looked at the file again, so a write `watch` made afterward was
   * invisible to it for the rest of the process's life. `open()` now
   * delegates to `refresh()` even when the directory has not changed (see
   * watermark.ts), which is the fix this test pins from the MCP side.
   */
  it("once `watch` has reported an error, the agent's own banner does not repeat it", async () => {
    await buildAgentSide();

    // The agent looks once, before the stall exists, so its own watermark
    // is opened (and its `Watermark` instance's cache populated) before
    // `watch` ever writes to the same file — the exact precondition W1's
    // stale in-memory cache bug needed.
    await agentClient.callTool("findings", {});

    const watching = runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, untilFirst: true, timeoutMs: 3_000 });
    await waitUntil(() => stderrText().includes("connected to com.example.shop"));
    pushStall(fakeDevice, 2_000, 4_000);
    expect(await watching).toBe(WATCH_EXIT.FOUND);
    expect(stdoutLines()).toHaveLength(1);

    const result = await agentClient.callTool("findings", {});
    expect(result.text).not.toContain("⚠ Since your last call");
  }, 10_000);

  /**
   * GRA-56 QA (W1 defect): two live `watch` processes sharing one session.
   * Run sequentially rather than raced to the same tick on purpose — the
   * module comments on both watermark.ts and watch.ts say plainly that a
   * genuine same-poll-interval race can still produce two reports; what
   * this test pins is the steady-state guarantee refresh-on-open actually
   * gives: a *second* live process, started after the first has already
   * written, sees that write and stays silent, rather than serving its own
   * stale first read forever (the literal W1 bug — `open()` used to never
   * look at the file again after its first read of an unchanged directory).
   * Summed across both processes, exactly one line was ever printed for
   * the one stall that happened.
   */
  /**
   * Deliberately sequential — `watch1` runs to completion, its write fully
   * persisted, *before* `watch2` ever starts — not two instances raced to
   * the same tick. A genuinely simultaneous race is explicitly not what
   * this module promises (watermark.ts's own comment, W1: "not full mutual
   * exclusion... a `watch` and the MCP surface's banner that both make
   * that decision inside the same ~200ms poll interval can still both
   * report the same error once"); a first attempt at this test raced two
   * instances from the start and reliably produced *two* lines for one
   * stall, which is that documented tradeoff working as designed, not a
   * bug to chase. What *is* guaranteed, and what this pins: a second live
   * process that starts after the first's write is complete sees it and
   * stays silent — the literal fix for W1 (`open()` used to never look at
   * the file again after its first read of an unchanged directory, so a
   * second process born after the first would have gone right on
   * repeating it forever).
   */
  it("two watch instances on one session: a later one stays silent once the earlier one's write has settled", async () => {
    // fixedHelloHandlers(): two separate DeviceClient connections to one
    // fakeDevice must resolve to the same session identity, or each
    // computes its own, disjoint watermark.json and this test would pass
    // for the wrong reason (never sharing anything, rather than sharing
    // and correctly deduping).
    fakeDevice = await FakeDevice.start(fixedHelloHandlers());

    const w1 = runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, untilFirst: true, timeoutMs: 2_000 });
    await waitUntil(() => stderrText().includes("connected to com.example.shop"));
    pushStall(fakeDevice, 2_000, 4_000);
    expect(await w1).toBe(WATCH_EXIT.FOUND);
    expect(stdoutLines()).toHaveLength(1);

    // A fresh process, fresh connection, fresh `Watermark` instance — and
    // the *same* stall pushed again (`fakeDevice.emit` only reaches sockets
    // connected right now; `watch1` already disconnected), so `watch2`
    // genuinely detects it locally (a brand new finding to its own `reported`
    // map) and the only thing standing between that and a second printed
    // line is the shared watermark correctly reading `watch1`'s write.
    const w2 = runWatch({ ...DEFAULT_OPTIONS, port: fakeDevice.port, timeoutMs: 1_000 });
    await waitUntil(() => (stderrText().match(/connected to com\.example\.shop/g) ?? []).length >= 2);
    pushStall(fakeDevice, 2_000, 4_000);
    expect(await w2).toBe(WATCH_EXIT.TIMEOUT);

    // Summed across both live processes, the one stall produced exactly one
    // line, ever.
    expect(stdoutLines()).toHaveLength(1);
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
