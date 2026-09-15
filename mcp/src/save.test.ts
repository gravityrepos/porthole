// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Same rationale as sessions-integration.test.ts: real loopback sockets
// compete with 17 other test files' own sockets for the OS scheduler, and a
// `waitUntil()` has been measured missing its deadline under that load with
// no logic bug behind it. `retry: 2` is the honest tool for environment
// timing, not correctness — a real assertion failure fails identically on
// every attempt.
vi.setConfig({ testTimeout: 20_000, retry: 2 });

import { DeviceClient, type DeviceEvent, type Hello } from "./device.js";
import { TimelineServer } from "./timeline.js";
import { createPortholeServer } from "./index.js";
import { FakeDevice, connect, waitUntil, type TestClient } from "./testing/harness.js";
import { SessionWriter } from "./sessions.js";
import { buildTrace, resolveProfile, TRACE_VERSION, type Trace } from "./trace.js";
import { renderReport } from "./report.js";
import { compare, report } from "./capture.js";
import { readTrace } from "./args.js";
import {
  SAVE_DRIVER,
  buildSavedTrace,
  coverageNote,
  defaultOutPath,
  defaultScenarioName,
  listSessionsText,
  saveFromSessions,
  writeSavedTrace,
  type SavedTrace,
  validateScenario,
  InvalidScenarioError,
} from "./save.js";

/**
 * GRA-54: "save what just happened, after it happened".
 *
 * `save.ts` is deliberately thin — see its own module doc comment — so most
 * of what is worth testing here is that it is thin in the right way: it
 * calls `buildTrace` (trace.ts) exactly as `capture` does (AC2), it computes
 * `clippedMs` with the exact function `findings` uses (ruling 4), and the
 * events it builds a trace from always came from `fillWindowFromDisk`
 * (sessions.ts) — never a second read of `events.ndjson`. The MCP-tool-level
 * tests below go through the real tool, per the ticket's own instruction,
 * for the ACs that are about the tool's behavior rather than this module's.
 */

const ev = (t: number, name: string, data: Record<string, unknown> = {}): DeviceEvent =>
  ({ t, seq: t, event: name, data }) as DeviceEvent;

// GRA-185: `buildTrace`/`buildSavedTrace` now take the resolved profile as
// an explicit input rather than deriving it themselves — none of `events`
// below carries a `device`/`profile` event, and none of these tests are
// about the device section, so the assumed-60Hz shape stands in wherever
// the exact profile does not matter to the assertion.
const ASSUMED_PROFILE = { assumed: true as const, refreshHz: 60 };

// ---------------------------------------------------------------------------
// pure functions
// ---------------------------------------------------------------------------

describe("defaultScenarioName", () => {
  it("names a moment by its window on the uptime clock (ruling 1)", () => {
    expect(defaultScenarioName(1_000, 5_000)).toBe("moment-1000-5000");
  });
});

describe("defaultOutPath", () => {
  it("writes under .porthole/traces, the same directory capture_system_trace uses (ruling 1)", () => {
    expect(defaultOutPath("/home/dev/app", "checkout")).toBe(
      path.join("/home/dev/app", ".porthole", "traces", "checkout.json"),
    );
  });
});

describe("coverageNote", () => {
  it("is empty when nothing was clipped — a complete window says nothing extra", () => {
    expect(coverageNote({ start: 0, end: 0 })).toBe("");
  });

  it("states the shortfall in seconds, in words, when part of the window was never recorded (ruling 4)", () => {
    expect(coverageNote({ start: 1_500, end: 0 })).toBe(
      " 1.5s of the requested window was never recorded and is not in this trace.",
    );
  });

  it("sums both ends", () => {
    expect(coverageNote({ start: 500, end: 500 })).toContain("1s");
  });
});

describe("buildSavedTrace", () => {
  const events = [
    ev(1_000, "db", { phase: "end", sql: "SELECT 1", thread: "main", durationMs: 12, onMainThread: "true" }),
    ev(1_100, "blocked", { durationMs: 420, stack: "com.app.Thing.work(Thing.kt:10)" }),
  ];

  it("calls buildTrace exactly as capture does — driver 'session', withEvents always false (ruling 3)", () => {
    const saved = buildSavedTrace({
      events,
      hello: { packageName: "com.example.shop", versionName: "1.0.0" },
      window: { from: 0, to: 2_000 },
      coveredFrom: 0,
      coveredTo: 2_000,
      scenario: "checkout",
      profile: ASSUMED_PROFILE,
    });
    expect(saved.driver).toBe(SAVE_DRIVER);
    expect(saved.events).toBeUndefined();
    expect(saved.porthole).toBe(TRACE_VERSION);
    // Same analyser: a query on the main thread and a stall both produce
    // findings, the same way findingsOf() does when called directly.
    expect(saved.findings.length).toBeGreaterThan(0);
  });

  it("carries clippedMs computed the same way findings computes it (ruling 4)", () => {
    const saved = buildSavedTrace({
      events,
      hello: null,
      window: { from: 0, to: 5_000 },
      coveredFrom: 1_000, // coverage starts after the window's own start
      coveredTo: 5_000,
      scenario: "checkout",
      profile: ASSUMED_PROFILE,
    });
    expect(saved.clippedMs).toEqual({ start: 1_000, end: 0 });
  });

  it("AC4: a window reaching before anything was covered reports it honestly and does not silently shorten the trace", () => {
    const saved = buildSavedTrace({
      events: [],
      hello: null,
      window: { from: -5_000, to: 1_000 },
      coveredFrom: 0,
      coveredTo: 1_000,
      scenario: "checkout",
      profile: ASSUMED_PROFILE,
    });
    // The full requested span, not one trimmed to what was actually covered.
    expect(saved.durationMs).toBe(6_000);
    expect(saved.clippedMs).toEqual({ start: 5_000, end: 0 });
  });

  it("reports the whole window as clipped when nothing at all was covered", () => {
    const saved = buildSavedTrace({
      events: [],
      hello: null,
      window: { from: 0, to: 3_000 },
      coveredFrom: null,
      coveredTo: null,
      scenario: "empty",
      profile: ASSUMED_PROFILE,
    });
    expect(saved.clippedMs).toEqual({ start: 3_000, end: 0 });
  });
});

describe("writeSavedTrace", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("creates the output directory if it does not exist yet", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "porthole-save-write-"));
    roots.push(dir);
    const out = path.join(dir, "nested", "traces", "checkout.json");
    const saved = buildSavedTrace({
      events: [],
      hello: null,
      window: { from: 0, to: 1_000 },
      coveredFrom: 0,
      coveredTo: 1_000,
      scenario: "checkout",
      profile: ASSUMED_PROFILE,
    });
    await writeSavedTrace(saved, out);
    const content = JSON.parse(await readFile(out, "utf8"));
    expect(content.scenario).toBe("checkout");
    expect(content.clippedMs).toEqual({ start: 0, end: 0 });
  });
});

// ---------------------------------------------------------------------------
// AC2/AC3/ruling 4: byte-compatibility with capture's output
// ---------------------------------------------------------------------------

describe("a saved trace works with report/compare unmodified", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tmpFile(name: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "porthole-save-compat-"));
    roots.push(dir);
    return path.join(dir, name);
  }

  const events = [
    ev(1_000, "db", { phase: "end", sql: "SELECT 1", thread: "main", durationMs: 12, onMainThread: "true" }),
    ev(1_100, "blocked", { durationMs: 420, stack: "com.app.Thing.work(Thing.kt:10)" }),
    ev(1_200, "frame", { totalMs: 30, missedFrames: 1, worstPhase: "layoutMeasure" }),
  ];
  const hello = { packageName: "com.example.shop", versionName: "1.0.0", device: "Pixel", sdkInt: 34 };
  // None of `events` above carries a device/profile event, so this is the
  // same 60Hz-fallback-from-`hello` shape `buildTrace` always produced here
  // — resolved explicitly now rather than derived inside `buildTrace` itself.
  const profile = resolveProfile({ liveEvents: events, windowTo: 2_000, sessionProfile: null, hello });

  it("AC2: porthole report renders identically to a report from an equivalent capture run", () => {
    const saved = buildSavedTrace({
      events,
      hello,
      window: { from: 0, to: 2_000 },
      coveredFrom: 0,
      coveredTo: 2_000,
      scenario: "checkout",
      profile,
    });
    // What `capture()` itself would have produced for the same events, hello
    // and scenario, driven with `--driver session` — the "equivalent run"
    // AC2 asks about. capturedAt differs by construction (both stamp "now");
    // renderReport never prints it, so that difference cannot leak in.
    const captured = buildTrace({
      scenario: "checkout",
      driver: SAVE_DRIVER,
      events,
      hello,
      durationMs: 2_000,
      withEvents: false,
      profile,
    });
    expect(renderReport(saved)).toBe(renderReport(captured));
  });

  it("ruling 4: readTrace (args.ts) accepts a trace carrying the extra clippedMs field", async () => {
    const saved = buildSavedTrace({
      events,
      hello,
      window: { from: 0, to: 2_000 },
      coveredFrom: 0,
      coveredTo: 2_000,
      scenario: "checkout",
      profile,
    });
    const file = await tmpFile("saved.json");
    await writeSavedTrace(saved, file);
    const read = await readTrace(file);
    expect(read.porthole).toBe(TRACE_VERSION);
    expect((read as SavedTrace).clippedMs).toEqual({ start: 0, end: 0 });
  });

  it("`porthole report` renders a saved trace file with exit 0", async () => {
    const saved = buildSavedTrace({
      events,
      hello,
      window: { from: 0, to: 2_000 },
      coveredFrom: 0,
      coveredTo: 2_000,
      scenario: "checkout",
      profile,
    });
    const file = await tmpFile("saved.json");
    await writeSavedTrace(saved, file);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await report(file);
      expect(code).toBe(0);
      expect(stdout.mock.calls.map((c) => String(c[0])).join("")).toContain("checkout");
    } finally {
      stdout.mockRestore();
    }
  });

  it("AC3: `porthole compare` accepts a saved trace as the baseline", async () => {
    const saved = buildSavedTrace({
      events,
      hello,
      window: { from: 0, to: 2_000 },
      coveredFrom: 0,
      coveredTo: 2_000,
      scenario: "checkout",
      profile,
    });
    const savedFile = await tmpFile("saved.json");
    await writeSavedTrace(saved, savedFile);

    const capturedTrace: Trace = buildTrace({
      scenario: "checkout",
      events,
      hello,
      durationMs: 2_000,
      withEvents: false,
      profile,
    });
    const capturedFile = await tmpFile("captured.json");
    await writeFile(capturedFile, JSON.stringify(capturedTrace, null, 2));

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await compare(savedFile, capturedFile);
      // Both traces come from the identical events, so a real comparison
      // reports no regression (exit 0) — not merely "not refused" (2), which
      // a stub that always returned 0 or 1 would also satisfy.
      expect(code).toBe(0);
      const printed = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("nothing moved");
      expect(printed).not.toContain("refusing to compare");
    } finally {
      stdout.mockRestore();
    }
  });

  it("AC3: `porthole compare` accepts a saved trace as the comparison side too", async () => {
    const saved = buildSavedTrace({
      events,
      hello,
      window: { from: 0, to: 2_000 },
      coveredFrom: 0,
      coveredTo: 2_000,
      scenario: "checkout",
      profile,
    });
    const savedFile = await tmpFile("saved.json");
    await writeSavedTrace(saved, savedFile);

    const capturedTrace: Trace = buildTrace({
      scenario: "checkout",
      events,
      hello,
      durationMs: 2_000,
      withEvents: false,
      profile,
    });
    const capturedFile = await tmpFile("captured.json");
    await writeFile(capturedFile, JSON.stringify(capturedTrace, null, 2));

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await compare(capturedFile, savedFile);
      expect(code).toBe(0);
      const printed = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("nothing moved");
      expect(printed).not.toContain("refusing to compare");
    } finally {
      stdout.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// porthole save (CLI, disk-only — no live device)
// ---------------------------------------------------------------------------

describe("saveFromSessions (porthole save)", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tmpRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "porthole-save-cli-"));
    roots.push(dir);
    return dir;
  }

  const HELLO: Hello = {
    protocol: 1,
    packageName: "com.example.shop",
    processName: "com.example.shop",
    versionName: "1.0.0-test",
    device: "Test Device",
    sdkInt: 34,
    startedAt: 500_000,
    collectors: [],
    deviceId: "device-under-test",
  };

  it("refuses when no sessions are recorded yet (missing-input case, self-check a)", async () => {
    const root = await tmpRoot();
    const result = await saveFromSessions({ root, projectRoot: root, sinceMs: 60_000 });
    expect(result.code).toBe(1);
    expect(result.message).toContain("No sessions recorded on disk yet");
  });

  it("resolves --since against the most recently active session's own last event as 'now'", async () => {
    const root = await tmpRoot();
    const writer = new SessionWriter(root, 60_000);
    await writer.open(HELLO);
    writer.append({ event: "recompose", t: 100_000, seq: 0, data: {} });
    writer.append({ event: "recompose", t: 110_000, seq: 1, data: {} });
    await writer.flush();

    const result = await saveFromSessions({ root, projectRoot: root, sinceMs: 5_000, scenario: "recent" });
    expect(result.code).toBe(0);

    const outFile = defaultOutPath(root, "recent");
    const content = JSON.parse(await readFile(outFile, "utf8"));
    expect(content.scenario).toBe("recent");
    // window resolves to [110000-5000, 110000] = [105000, 110000], entirely
    // inside the session's own recorded span [100000, 110000].
    expect(content.clippedMs).toEqual({ start: 0, end: 0 });
  });

  it("AC4: --from/--to reaching before the session start reports clippedMs.start rather than silently shortening", async () => {
    const root = await tmpRoot();
    const writer = new SessionWriter(root, 60_000);
    await writer.open(HELLO);
    writer.append({ event: "recompose", t: 10_000, seq: 0, data: {} });
    writer.append({ event: "recompose", t: 20_000, seq: 1, data: {} });
    await writer.flush();

    const result = await saveFromSessions({ root, projectRoot: root, from: 0, to: 20_000, scenario: "early" });
    expect(result.code).toBe(0);
    const outFile = defaultOutPath(root, "early");
    const content = JSON.parse(await readFile(outFile, "utf8"));
    expect(content.clippedMs).toEqual({ start: 10_000, end: 0 }); // 0..10000 genuinely never recorded
    expect(content.durationMs).toBe(20_000); // the full requested window, not a shortened one
  });

  it("honors an explicit --to that differs from the session's own last event, rather than silently substituting it", async () => {
    // Deliberately distinct from the AC4 fixture above: there `to` and the
    // session's own `lastT` happened to be the same value (20_000), which
    // is exactly the shape a mutation that ignores `options.to` entirely and
    // always uses `latest.lastT` would pass right through unnoticed —
    // caught by mutation testing (self-check b) on this file's first pass.
    const root = await tmpRoot();
    const writer = new SessionWriter(root, 60_000);
    await writer.open(HELLO);
    writer.append({ event: "recompose", t: 10_000, seq: 0, data: {} });
    writer.append({ event: "recompose", t: 90_000, seq: 1, data: {} }); // session's own lastT — far past the window asked for
    await writer.flush();

    const result = await saveFromSessions({ root, projectRoot: root, from: 10_000, to: 20_000, scenario: "mid" });
    expect(result.code).toBe(0);
    const outFile = defaultOutPath(root, "mid");
    const content = JSON.parse(await readFile(outFile, "utf8"));
    expect(content.durationMs).toBe(10_000); // the requested 10_000..20_000, not 10_000..90_000
    // Fully covered: the session's own recorded span [10_000, 90_000]
    // encloses the requested [10_000, 20_000] window.
    expect(content.clippedMs).toEqual({ start: 0, end: 0 });
  });

  it("defaults scenario to moment-<from>-<to> and out to .porthole/traces/<scenario>.json", async () => {
    const root = await tmpRoot();
    const writer = new SessionWriter(root, 60_000);
    await writer.open(HELLO);
    writer.append({ event: "recompose", t: 1_000, seq: 0, data: {} });
    await writer.flush();

    const result = await saveFromSessions({ root, projectRoot: root, from: 0, to: 1_000 });
    expect(result.code).toBe(0);
    expect(result.message).toContain('"moment-0-1000"');
    const outFile = defaultOutPath(root, "moment-0-1000");
    await expect(readFile(outFile, "utf8")).resolves.toBeTruthy();
  });

  it("--out overrides the default path", async () => {
    const root = await tmpRoot();
    const writer = new SessionWriter(root, 60_000);
    await writer.open(HELLO);
    writer.append({ event: "recompose", t: 1_000, seq: 0, data: {} });
    await writer.flush();

    const customOut = path.join(root, "custom.json");
    const result = await saveFromSessions({ root, projectRoot: root, from: 0, to: 1_000, out: customOut });
    expect(result.code).toBe(0);
    await expect(readFile(customOut, "utf8")).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// porthole sessions (CLI listing)
// ---------------------------------------------------------------------------

describe("listSessionsText (porthole sessions)", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tmpRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "porthole-sessions-cli-"));
    roots.push(dir);
    return dir;
  }

  it("reports nothing recorded yet for an empty root (missing-input case)", async () => {
    const root = await tmpRoot();
    const result = await listSessionsText(root);
    expect(result.code).toBe(0);
    expect(result.message).toContain("No sessions recorded on disk yet");
  });

  it("lists sessions for two apps, newest-started first (ruling 5, ruling 7's two-session root)", async () => {
    const root = await tmpRoot();

    const older = new SessionWriter(root, 60_000);
    await older.open({
      protocol: 1,
      packageName: "com.example.shop",
      processName: "com.example.shop",
      versionName: "1.0.0",
      device: "Pixel",
      sdkInt: 34,
      startedAt: 1_000,
      collectors: [],
      deviceId: "device-a",
    });
    older.append({ event: "recompose", t: 1_000, seq: 0, data: {} });
    await older.flush();

    const newer = new SessionWriter(root, 60_000);
    await newer.open({
      protocol: 1,
      packageName: "com.example.other",
      processName: "com.example.other",
      versionName: "2.0.0",
      device: "Emulator",
      sdkInt: 35,
      startedAt: 50_000,
      collectors: [],
      deviceId: "device-b",
    });
    newer.append({ event: "recompose", t: 50_000, seq: 0, data: {} });
    await newer.flush();

    const result = await listSessionsText(root);
    expect(result.code).toBe(0);
    const lines = result.message.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("com.example.other"); // startedAt 50_000, newer
    expect(lines[1]).toContain("com.example.shop"); // startedAt 1_000, older
    // package, device id, first/last t, event count and size on disk are all present
    expect(lines[0]).toMatch(/device-b/);
    expect(lines[0]).toMatch(/t=\[50000,50000\]/);
    expect(lines[0]).toMatch(/events=1/);
    expect(lines[0]).toMatch(/B|KB|MB/);
  });

  it("marks 'current' by which session was most recently written to, not by which started most recently", async () => {
    const root = await tmpRoot();

    // Starts LATER (bigger startedAt) but is never touched again after this.
    const newerButIdle = new SessionWriter(root, 60_000);
    await newerButIdle.open({
      protocol: 1,
      packageName: "com.example.idle",
      processName: "com.example.idle",
      versionName: "1.0.0",
      device: "Pixel",
      sdkInt: 34,
      startedAt: 90_000,
      collectors: [],
      deviceId: "device-a",
    });
    newerButIdle.append({ event: "recompose", t: 90_000, seq: 0, data: {} });
    await newerButIdle.flush();

    await new Promise((resolve) => setTimeout(resolve, 5)); // distinguishable updatedAt

    // Starts EARLIER but is the one actually still active (flushed last).
    const olderButActive = new SessionWriter(root, 60_000);
    await olderButActive.open({
      protocol: 1,
      packageName: "com.example.active",
      processName: "com.example.active",
      versionName: "1.0.0",
      device: "Pixel",
      sdkInt: 34,
      startedAt: 1_000,
      collectors: [],
      deviceId: "device-b",
    });
    olderButActive.append({ event: "recompose", t: 1_000, seq: 0, data: {} });
    await olderButActive.flush();

    const result = await listSessionsText(root);
    const lines = result.message.split("\n");
    // newest-started first: idle (90_000) before active (1_000) — ordering
    // is untouched by which one is "current".
    expect(lines[0]).toContain("com.example.idle");
    expect(lines[1]).toContain("com.example.active");
    // but the marker follows activity, not start order.
    expect(lines[0].startsWith("*")).toBe(false);
    expect(lines[1].startsWith("*")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// save_moment (MCP tool) — through the real tool, per the ticket's own
// instruction for the ACs that are about the tool's behavior.
// ---------------------------------------------------------------------------

interface FindingsPayload {
  window: { from: number; to: number; ms: number };
  clippedMs: { start: number; end: number };
  findings: unknown[];
}

interface SaveMomentPayload {
  scenario: string;
  out: string;
  window: { from: number; to: number; ms: number };
  clippedMs: { start: number; end: number };
  findings: unknown[];
}

describe("save_moment (MCP tool)", () => {
  const roots: string[] = [];
  const clients: TestClient[] = [];
  const devices: DeviceClient[] = [];
  const timelines: TimelineServer[] = [];
  let fakeDevice: FakeDevice | null = null;

  afterEach(async () => {
    // Flush every SessionWriter before anything is torn down: `device.stop()`
    // does not touch `device.sessions` (it only closes the socket), so its
    // 250ms flush timer is still armed and unref'd — free to fire *after*
    // this afterEach has already removed the tmp root, which surfaced as an
    // unhandled rejection (ENOENT on meta.json) from a later test entirely.
    // Flushing here, before the `rm`, is what makes that impossible rather
    // than merely unlikely.
    await Promise.all(devices.map((d) => d.sessions?.flush()));
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
    for (const device of devices.splice(0)) device.stop();
    for (const timeline of timelines.splice(0)) timeline.stop();
    await fakeDevice?.close();
    fakeDevice = null;
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function buildToolRig(startedAt: number, deviceId: string) {
    const sessionsRootDir = await mkdtemp(path.join(tmpdir(), "porthole-save-tool-"));
    roots.push(sessionsRootDir);

    const hello: Hello = {
      protocol: 1,
      packageName: "com.example.shop",
      processName: "com.example.shop",
      versionName: "1.0.0-test",
      device: "Test Device",
      sdkInt: 34,
      startedAt,
      collectors: [],
      deviceId,
    };
    fakeDevice = await FakeDevice.start({
      hello: () => hello,
      timeline: () => ({ events: [], droppedBefore: 0, now: Date.now() }),
    });

    const device = new DeviceClient("127.0.0.1", fakeDevice.port, sessionsRootDir);
    const timeline = new TimelineServer(device, 0);
    devices.push(device);
    timelines.push(timeline);
    const { server } = createPortholeServer({ device, timeline, version: "0.0.0-test" });
    device.start();
    await waitUntil(() => device.hello !== null, 10_000);
    const client = await connect(server);
    clients.push(client);
    return { device, timeline, client };
  }

  it("AC1: over a window quoted from a findings result, its findings array matches findings' own", async () => {
    const { timeline, client } = await buildToolRig(500_000, "device-ac1");

    const target = timeline.buffer().length + 2;
    fakeDevice!.emit("db", 1_000, { phase: "end", sql: "SELECT 1", thread: "main", durationMs: 12, onMainThread: "true" });
    fakeDevice!.emit("blocked", 1_100, { durationMs: 420, stack: "com.app.Thing.work(Thing.kt:10)" });
    await waitUntil(() => timeline.buffer().length >= target, 10_000);

    const findingsResult = await client.callTool("findings", { from: 0, to: 2_000 });
    expect(findingsResult.isError).toBeFalsy();
    const findingsPayload = findingsResult.json as FindingsPayload;
    expect(findingsPayload.findings.length).toBeGreaterThan(0);

    const saveResult = await client.callTool("save_moment", {
      from: findingsPayload.window.from,
      to: findingsPayload.window.to,
      scenario: "ac1-test",
    });
    expect(saveResult.isError).toBeFalsy();
    const savePayload = saveResult.json as SaveMomentPayload;

    // The caller's own scenario name is honored, not silently replaced by
    // the moment-<from>-<to> default (caught by mutation testing: a mutant
    // that always used the default passed every other assertion here).
    expect(savePayload.scenario).toBe("ac1-test");
    expect(savePayload.clippedMs).toEqual(findingsPayload.clippedMs);
    expect(savePayload.findings).toEqual(findingsPayload.findings);

    // The file on disk is the actual trace format `capture` writes, which
    // never carries `next` (that is an MCP-payload-only enrichment,
    // `withFollowUp` in index.ts) — so it is compared against the findings
    // with that field stripped, not against the enriched tool payload
    // itself (which `savePayload.findings` already matched above).
    const savedFile = JSON.parse(await readFile(savePayload.out, "utf8"));
    const withoutNext = findingsPayload.findings.map((f) => {
      const { next: _next, ...rest } = f as { next?: unknown } & Record<string, unknown>;
      return rest;
    });
    expect(savedFile.findings).toEqual(withoutNext);
    expect(savedFile.driver).toBe(SAVE_DRIVER);
    expect(savedFile.clippedMs).toEqual(findingsPayload.clippedMs);
  });

  it("AC4: a window extending before the session start reports clippedMs.start and keeps the full window", async () => {
    const { timeline, client } = await buildToolRig(900_000, "device-ac4");

    const target = timeline.buffer().length + 1;
    fakeDevice!.emit("recompose", 10_000, { name: "Cart" });
    await waitUntil(() => timeline.buffer().length >= target, 10_000);

    const result = await client.callTool("save_moment", { from: 0, to: 10_000, scenario: "ac4-test" });
    expect(result.isError).toBeFalsy();
    const payload = result.json as SaveMomentPayload;
    expect(payload.window).toEqual({ from: 0, to: 10_000, ms: 10_000 });
    expect(payload.clippedMs.start).toBeGreaterThan(0);
    expect(result.text).toMatch(/never recorded/);

    const savedFile = JSON.parse(await readFile(payload.out, "utf8"));
    // The full requested window, not one silently shortened to what was covered.
    expect(savedFile.durationMs).toBe(10_000);
  });

  it("refuses a scenario that would escape .porthole/traces, before writing anything (QA round 1 on GRA-116)", async () => {
    const { timeline, client } = await buildToolRig(1_000, "device-traversal");
    const target = timeline.buffer().length + 1;
    fakeDevice!.emit("recompose", 500, { name: "Cart" });
    await waitUntil(() => timeline.buffer().length >= target, 10_000);

    const result = await client.callTool("save_moment", { from: 0, to: 1_000, scenario: "../../../../tmp/evil" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/scenario/);
  });

  it("defaults scenario and out when neither is given", async () => {
    const { timeline, client } = await buildToolRig(1_000, "device-defaults");
    const target = timeline.buffer().length + 1;
    fakeDevice!.emit("recompose", 500, { name: "Cart" });
    await waitUntil(() => timeline.buffer().length >= target, 10_000);

    const result = await client.callTool("save_moment", { from: 0, to: 1_000 });
    expect(result.isError).toBeFalsy();
    const payload = result.json as SaveMomentPayload;
    expect(payload.scenario).toBe("moment-0-1000");
    expect(payload.out.endsWith(path.join(".porthole", "traces", "moment-0-1000.json"))).toBe(true);
  });

  it("fails cleanly when there is no window to save at all (missing-input case, self-check a)", async () => {
    const { client } = await buildToolRig(2_000, "device-empty");
    const result = await client.callTool("save_moment", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("No window to save");
  });

  it("malformed input: a non-positive sinceMs is rejected by the shared schema, not silently accepted", async () => {
    const { client } = await buildToolRig(3_000, "device-malformed");
    // Zod's own input validation on the shared `windowShape` (index.ts)
    // rejects this before the handler ever runs — surfaced as an MCP error
    // result, not a thrown/rejected client call.
    const result = await client.callTool("save_moment", { sinceMs: -5 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/greater than 0|sinceMs/);
  });
});

describe("validateScenario (QA round 1 on GRA-116: the scenario becomes a file name)", () => {
  it("accepts ordinary names, trimmed", () => {
    expect(validateScenario("checkout")).toBe("checkout");
    expect(validateScenario("  cart flow 3  ")).toBe("cart flow 3");
    expect(validateScenario("moment-100-200")).toBe("moment-100-200");
    expect(validateScenario("v1.2_final")).toBe("v1.2_final");
  });

  it("refuses anything that could leave .porthole/traces", () => {
    const backslash = String.fromCharCode(92); // a shell heredoc ate the literal once already
    const bad = [
      "../../../../tmp/evil",
      `..${backslash}..${backslash}evil`,
      "a/b",
      `a${backslash}b`,
      "..",
      ".",
      "...",
      "",
      "   ",
      `x${String.fromCharCode(0)}y`,
      "a".repeat(121),
    ];
    for (const item of bad) {
      expect(() => validateScenario(item), JSON.stringify(item)).toThrow(InvalidScenarioError);
    }
  });

  it("defaultOutPath goes through the same check, so every caller is covered", () => {
    expect(() => defaultOutPath("/home/dev/app", "../evil")).toThrow(InvalidScenarioError);
    expect(path.basename(defaultOutPath("/home/dev/app", "ok name"))).toBe("ok name.json");
  });
});
