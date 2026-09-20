// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { copyFileSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RING_BUFFER_KB,
  MAX_RING_BUFFER_KB,
  MIN_RING_BUFFER_KB,
  planRing,
  ringConfigText,
  RING_SESSION_NAME,
} from "./systrace.js";
import { MEASURED_OVERHEAD, RingController } from "./ring.js";
import { buildRig } from "./testing/harness.js";

/**
 * GRA-57's spike found that `--detach`/`--attach --stop` — the mechanism the
 * ticket's own research brief named — requires `write_into_file: true`,
 * which turns the on-device *file* into a continuously growing stream, not
 * a ring, and would have meant every snapshot stopped the very recording it
 * exists to preserve. `--background-wait` (a detached child, blocked on
 * confirming its own data sources actually started; no `--detach` key
 * needed because `unique_session_name` makes the session discoverable by
 * name afterward) plus `--clone-by-name` for a non-disruptive snapshot is
 * what `ring.ts` actually does instead — confirmed on the spike's emulator
 * by finding the source `perfetto` process still listed in `ps` immediately
 * after a `--clone-by-name` pull.
 *
 * QA on this ticket's first pass (R1/R2) found the pid `ring.ts` used to
 * trust — parsed from perfetto's own stdout — was also the single point of
 * failure that could leave a session running with nothing on this side able
 * to find it again. `findRunningRingPid` (a `ps -A -o PID,ARGS` scan for the
 * fixed `-o` target every ring session launches with) replaced it as the
 * actual source of truth, for pid discovery, for `start`'s "already
 * running" refusal, and as `stop`'s fallback when its own pid marker file
 * is missing. This file's fake adb has to simulate that scan too — see
 * `PORTHOLE_TEST_RING_PROCESS_MARKER`'s own comment below for how.
 *
 * This file is the test-suite half of all of it: a fake adb standing in for
 * the device, proving the plan is written correctly, the right commands run
 * in the right order, a snapshot pulls without touching the running
 * session, a launch that forks but then fails is killed before it is
 * reported as a failure, and `stop` leaves nothing behind even without its
 * own marker file — the real emulator run is evidence in the ticket's
 * report, not something this suite can re-run in CI.
 */

// ---------------------------------------------------------------------------
// planRing / ringConfigText (systrace.ts#ring-config) — pure, no adb needed
// ---------------------------------------------------------------------------

describe("planning a ring session", () => {
  it("defaults to DEFAULT_CATEGORIES and the standard buffer size", () => {
    const plan = planRing({ app: "com.example.shop" });
    expect(plan.app).toBe("com.example.shop");
    expect(plan.bufferKb).toBe(DEFAULT_RING_BUFFER_KB);
    expect(plan.sessionName).toBe(RING_SESSION_NAME);
    expect(plan.categories.length).toBeGreaterThan(0);
  });

  it("drops `app` as a category, same as planCapture, and says why", () => {
    const plan = planRing({ app: "com.example.shop", categories: ["app", "sched"] });
    expect(plan.categories).not.toContain("app");
    expect(plan.categories).toContain("sched");
    expect(plan.notes.join(" ")).toMatch(/not one|enabled per package/);
  });

  it("clamps an out-of-range buffer size and says so", () => {
    expect(planRing({ app: "a", bufferKb: 1 }).bufferKb).toBe(MIN_RING_BUFFER_KB);
    expect(planRing({ app: "a", bufferKb: 999_999_999 }).bufferKb).toBe(MAX_RING_BUFFER_KB);
    expect(planRing({ app: "a", bufferKb: 999_999_999 }).notes.join(" ")).toMatch(/clamped/);
  });

  it("trims the app name", () => {
    expect(planRing({ app: "  com.example.shop  " }).app).toBe("com.example.shop");
  });
});

describe("the ring's TraceConfig text", () => {
  it("carries unique_session_name, RING_BUFFER, every category and exactly one atrace_apps", () => {
    const text = ringConfigText(planRing({ app: "com.example.shop", categories: ["sched", "gfx"] }));
    expect(text).toContain(`unique_session_name: "${RING_SESSION_NAME}"`);
    expect(text).toContain("fill_policy: RING_BUFFER");
    expect(text).toContain('atrace_categories: "sched"');
    expect(text).toContain('atrace_categories: "gfx"');
    expect(text).toContain('atrace_apps: "com.example.shop"');
    // Exactly one atrace_apps line — a ring session is scoped to one package,
    // unlike capture_system_trace's own --app-per-package list.
    expect(text.match(/atrace_apps:/g)).toHaveLength(1);
  });

  it("writes the buffer size the plan asked for, in KB", () => {
    const text = ringConfigText(planRing({ app: "a", bufferKb: 8192 }));
    expect(text).toContain("size_kb: 8192");
  });

  it("QA F20: declares the same data sources capture_system_trace's light-config shorthand resolves to, not linux.ftrace alone", () => {
    // Confirmed by reading back a real capture_system_trace-style capture's
    // own embedded TraceConfig via trace_processor_shell's
    // `metadata` table (`trace_config_pbtxt`) — see this function's own doc
    // comment in systrace.ts and the ticket's spike writeup
    // (docs/spikes/GRA-57-perfetto-ring.md) for the full transcript. Without
    // these, ask_system_trace got zero findings from every ring snapshot in
    // a controlled comparison against a capture of the same moment.
    const text = ringConfigText(planRing({ app: "com.example.shop" }));
    expect(text).toContain('name: "android.surfaceflinger.frametimeline"');
    expect(text).toContain('name: "linux.process_stats"');
    expect(text).toContain('name: "linux.system_info"');
    expect(text).toContain("symbolize_ksyms: true");
  });
});

describe("RingController.status(), with no adb call ever made", () => {
  // QA (F19): status()/snapshot() now consult the device on a cache miss
  // (`confirmRunningFromDevice`), so "nothing started" is no longer provable
  // without an adb binary at all — a deliberately nonexistent one makes
  // that consultation fail fast and deterministically (ENOENT) rather than
  // depending on whatever adb this environment does or does not have.
  const NO_ADB = { binary: "/nonexistent/adb-binary-for-ring-test" };

  it("reports not running, with the measured overhead figures present regardless", async () => {
    const controller = new RingController();
    const status = await controller.status(NO_ADB);
    expect(status.running).toBe(false);
    expect(status.startedAt).toBeNull();
    expect(status.elapsedMs).toBeNull();
    expect(status.app).toBeNull();
    expect(status.snapshots).toBe(0);
    expect(status.lastSnapshotAt).toBeNull();
    expect(status.lastSnapshot).toBeNull();
    // Shown even when idle — an agent deciding whether to turn the ring on
    // sees the cost before asking, not after.
    expect(status.overhead).toEqual(MEASURED_OVERHEAD);
  });

  it("a snapshot attempt with nothing started fails without a real device to confirm it against", async () => {
    const controller = new RingController();
    const result = await controller.snapshot(NO_ADB);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// a fake adb standing in for the device
// ---------------------------------------------------------------------------

/**
 * QA (R1/R2) on this ticket's first pass added the two things a fixed
 * stdout-response table cannot fake: a device-side process the fake itself
 * has to "remember" is alive across several separate adb invocations (each
 * one a real, separate OS process — see `setupFakeRingAdb`'s own comment),
 * and a `ps -A -o PID,ARGS` scan that has to see it. `PORTHOLE_TEST_RING_PROCESS_MARKER`
 * is that memory: a file on disk that stands in for "the backgrounded
 * perfetto process is alive on the device" — created when the fake's
 * `--background-wait` handler decides to simulate a real fork (which is
 * independent of whether the launch command itself reports success:
 * `PORTHOLE_TEST_RING_START_ACK_FAIL=1` simulates perfetto forking and then
 * the *acknowledgement* failing, exactly the QA repro this exists to catch —
 * a live session, a failed launch command), and removed by `kill -TERM`.
 */
const FAKE_RING_ADB_PRELOAD_SOURCE = `
const fs = require("fs");
const path = require("path");

function logOrder(tag) {
  const logPath = process.env.PORTHOLE_TEST_RING_ORDER_LOG;
  if (logPath) fs.appendFileSync(logPath, tag + "\\n");
}

const raw = process.argv.slice(1);
const resolved = raw.length > 0 ? [path.basename(raw[0]), ...raw.slice(1)] : raw;
let a = resolved;
if (a[0] === "-s") a = a.slice(2);

const FAKE_PID = process.env.PORTHOLE_TEST_RING_PID || "9999";
const PROCESS_MARKER = process.env.PORTHOLE_TEST_RING_PROCESS_MARKER;
const DEVICE_OUT_PATH = "/data/misc/perfetto-traces/porthole-ring.pftrace";

if (a[0] === "push") {
  logOrder("push");
  // Copies the pushed config's own text somewhere the test can read back,
  // so a test can assert on what was actually written — not just that a
  // push happened.
  const dest = process.env.PORTHOLE_TEST_RING_LAST_PUSHED_CONFIG;
  if (dest) fs.copyFileSync(a[1], dest);
  process.stdout.write(a[1] + ": 1 file pushed.\\n");
  process.exit(0);
}

if (a[0] === "shell" && a[1] === "ps") {
  logOrder("ps-scan");
  // Mirrors ring.ts's own findRunningRingPid parsing: "<pid> <argv...>",
  // matched on "perfetto" and the fixed -o path.
  if (PROCESS_MARKER && fs.existsSync(PROCESS_MARKER)) {
    process.stdout.write(
      "  " + FAKE_PID + " perfetto --txt -c - --background-wait -o " + DEVICE_OUT_PATH + "\\n",
    );
  } else {
    process.stdout.write("  PID ARGS\\n"); // header only — an empty table, same as a real device with nothing running
  }
  process.exit(0);
}

if (a[0] === "shell" && typeof a[1] === "string" && a[1].includes("--background-wait")) {
  logOrder("start");
  if (process.env.PORTHOLE_TEST_RING_START_FAIL === "1") {
    // Never forked at all — a config/launch error, nothing for a later scan
    // to find.
    process.stderr.write("fake-ring-adb: could not start\\n");
    process.exit(1);
  }
  // The fork happens before the wait-for-acknowledgement phase in real
  // perfetto too, so the marker is created regardless of what this
  // invocation's own exit code ends up being.
  if (PROCESS_MARKER) fs.writeFileSync(PROCESS_MARKER, "1");
  if (process.env.PORTHOLE_TEST_RING_START_ACK_FAIL === "1") {
    // QA's R1 repro, reframed for --background-wait: the process forked
    // (the marker above proves it), but the acknowledgement the real flag
    // waits on never arrived, so the command itself reports failure.
    process.stderr.write("fake-ring-adb: timed out waiting for acknowledgement\\n");
    process.exit(1);
  }
  process.stdout.write(FAKE_PID + "\\n");
  process.exit(0);
}

if (a[0] === "shell" && typeof a[1] === "string" && a[1].startsWith("printf")) {
  logOrder("pid-marker");
  process.exit(0);
}

if (a[0] === "shell" && typeof a[1] === "string" && a[1].includes("--clone-by-name")) {
  logOrder("clone");
  // QA (R4): lets a test prove findings() never awaits this — a real clone
  // of a multi-megabyte ring plus the pull after it takes real, measurable
  // time; this is that time, under test control, without needing a real
  // device.
  const delayMs = Number(process.env.PORTHOLE_TEST_RING_CLONE_DELAY_MS || "0");
  if (delayMs > 0) {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, delayMs);
  }
  if (process.env.PORTHOLE_TEST_RING_CLONE_FAIL === "died") {
    // A dead session is dead everywhere on the device, not just to
    // --clone-by-name — remove the process marker too, so a subsequent
    // cat/ps-scan (confirmRunningFromDevice, QA F19) agrees with this
    // failure instead of re-"discovering" a session that is not really
    // there.
    if (PROCESS_MARKER && fs.existsSync(PROCESS_MARKER)) fs.unlinkSync(PROCESS_MARKER);
    process.stderr.write("perfetto_cmd.cc: no tracing session found matching porthole-ring\\n");
    process.exit(1);
  }
  if (process.env.PORTHOLE_TEST_RING_CLONE_FAIL === "1") {
    process.stderr.write("fake-ring-adb: clone failed\\n");
    process.exit(1);
  }
  process.exit(0);
}

if (a[0] === "pull") {
  logOrder("pull");
  fs.writeFileSync(a[2], "porthole: fake-ring-label\\n");
  process.stdout.write(a[1] + ": 1 file pulled.\\n");
  process.exit(0);
}

if (a[0] === "shell" && typeof a[1] === "string" && a[1].startsWith("cat") && a[1].includes(".pid")) {
  logOrder("pid-read");
  // Stateful, mirroring a real device: the pid-marker text file only ever
  // exists because a start() call wrote it at the same moment it created
  // the process itself — QA (F19)'s confirmRunningFromDevice calls this on
  // every snapshot()/status() cache miss now, not only from stop(), so this
  // can no longer unconditionally "succeed" regardless of whether anything
  // was ever actually started.
  const markerReallyThere = PROCESS_MARKER && fs.existsSync(PROCESS_MARKER);
  if (process.env.PORTHOLE_TEST_RING_NO_PID_MARKER === "1" || !markerReallyThere) {
    process.stderr.write("cat: No such file or directory\\n");
    process.exit(1);
  }
  process.stdout.write(FAKE_PID + "\\n");
  process.exit(0);
}

if (a[0] === "shell" && typeof a[1] === "string" && a[1].startsWith("kill")) {
  logOrder("kill");
  if (PROCESS_MARKER && fs.existsSync(PROCESS_MARKER)) fs.unlinkSync(PROCESS_MARKER);
  process.exit(0);
}

if (a[0] === "shell" && typeof a[1] === "string" && a[1].startsWith("rm")) {
  logOrder("rm");
  process.exit(0);
}

process.stderr.write("fake-ring-adb: unhandled args " + JSON.stringify(a) + "\\n");
process.exit(17);
`;

interface FakeRingAdb {
  binaryPath: string;
  env: NodeJS.ProcessEnv;
  order(): string[];
  lastPushedConfig(): string;
  /** Whether the fake's own "device" currently believes a ring process is alive — the ps-scan's source of truth, checkable directly without going through adb. */
  processMarkerExists(): boolean;
  cleanup(): void;
}

/**
 * Same shape as `index.test.ts`'s own `setupFakeAdb` (GRA-89/GRA-186) — a
 * hard link to the real, running `node` binary plus `NODE_OPTIONS` pointed
 * at a preload script — and the same reason: `ring.ts`'s commands include
 * dynamic local paths (a freshly `mkdtempSync`'d config file, a snapshot's
 * pulled-to path) that `testing/fakeAdb.ts`'s fixed-argv response table has
 * no way to key on, since the exact string is different on every test run.
 *
 * Each call builds its own root directory, and so its own
 * `PORTHOLE_TEST_RING_PROCESS_MARKER` path — two fake adbs from two separate
 * calls never see each other's "device", the same way two real devices
 * would not. A test that wants two rigs to share one simulated device (a
 * second MCP process finding the first one's ring) passes the *same*
 * `FakeRingAdb.env` to both `buildRig` calls, not two separate
 * `setupFakeRingAdb()` results.
 */
function setupFakeRingAdb(extraEnv: NodeJS.ProcessEnv = {}): FakeRingAdb {
  const root = mkdtempSync(path.join(tmpdir(), "porthole-fake-ring-adb-"));
  const binaryName = process.platform === "win32" ? "adb.exe" : "adb";
  const binaryPath = path.join(root, binaryName);
  try {
    linkSync(process.execPath, binaryPath);
  } catch {
    copyFileSync(process.execPath, binaryPath);
  }

  const preloadPath = path.join(root, "fake-ring-adb-preload.cjs");
  writeFileSync(preloadPath, FAKE_RING_ADB_PRELOAD_SOURCE);

  const orderLogPath = path.join(root, "order.log");
  writeFileSync(orderLogPath, "");
  const lastPushedConfigPath = path.join(root, "last-pushed-config.pbtxt");
  writeFileSync(lastPushedConfigPath, "");
  const processMarkerPath = path.join(root, "process.marker");

  return {
    binaryPath,
    env: {
      ...process.env,
      ...extraEnv,
      NODE_OPTIONS: `--require=${preloadPath}`,
      PORTHOLE_TEST_RING_ORDER_LOG: orderLogPath,
      PORTHOLE_TEST_RING_LAST_PUSHED_CONFIG: lastPushedConfigPath,
      PORTHOLE_TEST_RING_PROCESS_MARKER: processMarkerPath,
    },
    order() {
      return readFileSync(orderLogPath, "utf8").split("\n").filter(Boolean);
    },
    lastPushedConfig() {
      return readFileSync(lastPushedConfigPath, "utf8");
    },
    processMarkerExists() {
      try {
        readFileSync(processMarkerPath);
        return true;
      } catch {
        return false;
      }
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

// ---------------------------------------------------------------------------
// RingController, against the fake adb, through the real MCP tools
// ---------------------------------------------------------------------------

// GRA-237: on windows-latest this file's two adb-driven blocks never finish
// — the fake adb here is a node.exe copy driven by a NODE_OPTIONS preload
// (not testing/fakeAdb.ts's .cmd shim), and the run hangs until the job's
// 12-minute timeout. The three pure describes above still run there; the
// adb-driven ones are exercised on ubuntu and macOS until GRA-237 lands.
const adbDriven = describe.skipIf(process.platform === "win32");

adbDriven("system_trace_start / system_trace_snapshot / system_trace_stop", () => {
  let fakeAdb: FakeRingAdb;

  beforeEach(() => {
    fakeAdb = setupFakeRingAdb();
  });

  afterEach(() => {
    fakeAdb.cleanup();
  });

  it("writes a config with the attached app and default categories, and starts a background session — not a detach/attach pair", async () => {
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      const start = await rig.client.callTool("system_trace_start", {});
      expect(start.isError).toBeFalsy();
      const config = fakeAdb.lastPushedConfig();
      expect(config).toContain(`unique_session_name: "${RING_SESSION_NAME}"`);
      expect(config).toContain("fill_policy: RING_BUFFER");
      // buildRig's fake device hellos in as "com.example.app" (testing/harness.ts) —
      // the point being this used no explicit `app` argument and still scoped
      // correctly, defaulting to the attached package.
      expect(config).toMatch(/atrace_apps: "[^"]+"/);
      // A ps-scan before the launch (QA R2: "is one already running, even
      // one this process did not start") and a second one after it (QA R1:
      // the pid this controller trusts comes from the device's own process
      // table, not from parsing perfetto's own stdout) bracket the
      // push/start/marker/cleanup sequence.
      expect(fakeAdb.order()).toEqual(["ps-scan", "push", "start", "ps-scan", "pid-marker", "rm"]);
    } finally {
      await rig.close();
    }
  });

  it("refuses a second start while one is already running", async () => {
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      await rig.client.callTool("system_trace_start", {});
      const second = await rig.client.callTool("system_trace_start", {});
      expect(second.isError).toBe(true);
      expect(second.text).toMatch(/already running/i);
    } finally {
      await rig.close();
    }
  });

  it("QA R2: refuses a start when a session is found only by scanning the device — not this process's own memory of starting one", async () => {
    // Two rigs sharing one simulated device (same fakeAdb.env, so the same
    // process-table marker): rig1 starts a ring, rig2 is a fresh
    // RingController — in-memory `running` is false on rig2, the same as
    // after an MCP server restart — and must still refuse.
    const rig1 = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      const started = await rig1.client.callTool("system_trace_start", {});
      expect(started.isError).toBeFalsy();

      const rig2 = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
      try {
        const secondStart = await rig2.client.callTool("system_trace_start", {});
        expect(secondStart.isError).toBe(true);
        expect(secondStart.text).toMatch(/already running/i);
        expect(secondStart.text).toMatch(/no memory of/i);
      } finally {
        await rig2.close();
      }
    } finally {
      await rig1.close();
    }
  });

  it("QA F19: a fresh RingController's status() sees a ring the device reports running, not just this process's own memory", async () => {
    // rig1 starts a ring — real process marker, real pid-marker text file,
    // both on the shared fake device. A brand-new, standalone
    // RingController (never wired into any rig — the same "restarted MCP
    // process, never called start() itself" shape) is checked directly
    // against the same fake device: this is `porthole_status`'s own
    // `ownsDeviceConnection` gate at work — see `index.ts`'s
    // `porthole_status` handler — every rig in this suite injects a fake
    // `DeviceClient`, so `porthole_status` itself always answers from
    // `RingController.cachedStatus()` here, never by touching adb; the
    // actual device consultation this test is about is `status()` itself,
    // exercised directly rather than through that gate.
    const rig1 = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      const started = await rig1.client.callTool("system_trace_start", {});
      expect(started.isError).toBeFalsy();

      const freshController = new RingController();
      const status = await freshController.status({ binary: fakeAdb.binaryPath, env: fakeAdb.env });
      // Confirmed running — the whole point of F19 — even though
      // freshController never started anything itself. `app`/`startedAt`
      // stay honestly null: this process cannot know a plan it never
      // received.
      expect(status.running).toBe(true);
      expect(status.app).toBeNull();
      expect(status.startedAt).toBeNull();
    } finally {
      await rig1.close();
    }
  });

  it("QA F19: system_trace_snapshot works from a fresh rig that never called system_trace_start, against a ring another rig started", async () => {
    const rig1 = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      const started = await rig1.client.callTool("system_trace_start", {});
      expect(started.isError).toBeFalsy();

      // system_trace_snapshot is not gated on ownsDeviceConnection — unlike
      // porthole_status's ring field, it always talks to the device it was
      // given, which is exactly what makes this rig2 case meaningful: a
      // second MCP process (or this same one, restarted) reaching for
      // system_trace_snapshot with no memory of having started anything.
      const rig2 = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
      try {
        const outputDir = mkdtempSync(path.join(tmpdir(), "porthole-ring-f19-out-"));
        const snap = await rig2.client.callTool("system_trace_snapshot", { outputDir });
        expect(snap.isError).toBeFalsy();
        const payload = snap.json as { path: string; startedAt: unknown; bufferKb: unknown; note: string };
        expect(readFileSync(payload.path, "utf8")).toContain("porthole: fake-ring-label");
        expect(payload.startedAt).toBeNull();
        expect(payload.bufferKb).toBeNull();
        expect(payload.note).toMatch(/did not start the ring itself/i);
      } finally {
        await rig2.close();
      }
    } finally {
      await rig1.close();
    }
  });

  it("QA R1: a launch that forks but fails its own acknowledgement is killed before start() reports failure, and leaves the config removed", async () => {
    const rig = await buildRig({
      adbBinary: fakeAdb.binaryPath,
      adbEnv: { ...fakeAdb.env, PORTHOLE_TEST_RING_START_ACK_FAIL: "1" },
    });
    try {
      expect(fakeAdb.processMarkerExists()).toBe(false);
      const start = await rig.client.callTool("system_trace_start", {});
      // The launch command itself reported failure (the acknowledgement
      // never arrived) — QA's repro is that the session was nonetheless
      // left running on the device when this was reported as a plain
      // failure with nothing cleaned up.
      expect(start.isError).toBe(true);
      // QA R2's scan is what finds and kills it — not a pid parsed from a
      // stdout line that, in this exact scenario, was never trustworthy.
      const order = fakeAdb.order();
      expect(order).toEqual(["ps-scan", "push", "start", "ps-scan", "kill", "rm"]);
      // The device is actually clean, not merely reported as such: the fake
      // "device"'s own process marker is gone (kill removed it) — proof
      // independent of the order log, which only proves a command ran, not
      // that it had the intended effect.
      expect(fakeAdb.processMarkerExists()).toBe(false);

      // A subsequent, ordinary start against the same (now genuinely clean)
      // fake device must succeed — proving the failed launch left nothing
      // behind for a real session to collide with. A fresh rig without the
      // ACK-fail override, sharing the same fake device (same
      // fakeAdb.binaryPath/env, so the same process marker path) — reusing
      // `rig` itself would still be pointed at the ack-fail env for every
      // call it makes, which would only prove the retry fails the same way,
      // not that the device is actually clean.
      const rigRetry = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
      try {
        const retry = await rigRetry.client.callTool("system_trace_start", {});
        expect(retry.isError).toBeFalsy();
      } finally {
        await rigRetry.close();
      }
    } finally {
      await rig.close();
    }
  });

  it("QA R3: a launch that never forks at all still removes the pushed config", async () => {
    const rig = await buildRig({
      adbBinary: fakeAdb.binaryPath,
      adbEnv: { ...fakeAdb.env, PORTHOLE_TEST_RING_START_FAIL: "1" },
    });
    try {
      const start = await rig.client.callTool("system_trace_start", {});
      expect(start.isError).toBe(true);
      // Nothing forked (no process marker was ever created), so there is
      // nothing for the ps-scan to find and nothing to kill — but the
      // config removal must still happen on this failure path.
      const order = fakeAdb.order();
      expect(order).toEqual(["ps-scan", "push", "start", "ps-scan", "rm"]);
      expect(order).not.toContain("kill");
    } finally {
      await rig.close();
    }
  });

  it("QA R5: a snapshot with no outputDir lands under the project root, not the process's own working directory", async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "porthole-ring-root-"));
    const previousProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
    process.env.PORTHOLE_PROJECT_ROOT = projectRoot;
    try {
      const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
      try {
        await rig.client.callTool("system_trace_start", {});
        const snap = await rig.client.callTool("system_trace_snapshot", {});
        expect(snap.isError).toBeFalsy();
        const snapshotPath = (snap.json as { path: string }).path;
        expect(snapshotPath.startsWith(path.join(projectRoot, ".porthole", "traces"))).toBe(true);
      } finally {
        await rig.close();
      }
    } finally {
      if (previousProjectRoot === undefined) delete process.env.PORTHOLE_PROJECT_ROOT;
      else process.env.PORTHOLE_PROJECT_ROOT = previousProjectRoot;
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("snapshot clones the running session — not attach+stop — and pulls the result without stopping anything", async () => {
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      await rig.client.callTool("system_trace_start", {});
      const outputDir = mkdtempSync(path.join(tmpdir(), "porthole-ring-out-"));
      const snap = await rig.client.callTool("system_trace_snapshot", { outputDir });
      expect(snap.isError).toBeFalsy();
      const payload = snap.json as { path: string; bytes: number; portholeLabels: number };
      expect(readFileSync(payload.path, "utf8")).toContain("porthole: fake-ring-label");
      expect(payload.bytes).toBeGreaterThan(0);
      // QA F20: system_trace_snapshot now reports the same Porthole-label
      // count capture_system_trace does, so the GRA-186 AC has evidence on
      // the ring path — the fake's own pull fixture carries exactly one
      // label ("porthole: fake-ring-label").
      expect(payload.portholeLabels).toBe(1);
      // clone, then pull, then a cleanup rm of the on-device snapshot file —
      // never a "stop"/"kill" anywhere in here, which is the whole point of
      // --clone-by-name over --attach --stop.
      expect(fakeAdb.order()).toEqual([
        "ps-scan",
        "push",
        "start",
        "ps-scan",
        "pid-marker",
        "rm",
        "clone",
        "pull",
        "rm",
      ]);
    } finally {
      await rig.close();
    }
  });

  it("refuses a snapshot when nothing is running", async () => {
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      const snap = await rig.client.callTool("system_trace_snapshot", {});
      expect(snap.isError).toBe(true);
      expect(snap.text).toMatch(/not running/i);
    } finally {
      await rig.close();
    }
  });

  it("stop reads the device's own pid marker, kills it, and cleans up — even with no in-memory state to trust", async () => {
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      await rig.client.callTool("system_trace_start", {});
      const stop = await rig.client.callTool("system_trace_stop", {});
      expect(stop.isError).toBeFalsy();
      const payload = stop.json as { wasRunning: boolean };
      expect(payload.wasRunning).toBe(true);
      const order = fakeAdb.order();
      expect(order).toContain("pid-read");
      expect(order).toContain("kill");
      // The cleanup rm runs after the kill, not before — killing a process
      // and then deleting the marker that named it is the only order that
      // cannot lose track of the pid partway through.
      expect(order.indexOf("kill")).toBeLessThan(order.lastIndexOf("rm"));
    } finally {
      await rig.close();
    }
  });

  it("stop is a harmless no-op, not an error, when nothing was ever started", async () => {
    const rig = await buildRig({
      adbBinary: fakeAdb.binaryPath,
      adbEnv: { ...fakeAdb.env, PORTHOLE_TEST_RING_NO_PID_MARKER: "1" },
    });
    try {
      const stop = await rig.client.callTool("system_trace_stop", {});
      expect(stop.isError).toBeFalsy();
      const payload = stop.json as { wasRunning: boolean };
      expect(payload.wasRunning).toBe(false);
      expect(stop.text).toMatch(/nothing was running/i);
    } finally {
      await rig.close();
    }
  });

  it("QA R2: stop finds and kills a genuinely running session by scanning the device when the pid marker is missing", async () => {
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      const started = await rig.client.callTool("system_trace_start", {});
      expect(started.isError).toBeFalsy();
      expect(fakeAdb.processMarkerExists()).toBe(true);

      // A second rig against the same simulated device, with the pid-marker
      // file made unreadable for this one call only — standing in for a
      // marker write that never landed (best-effort, per DEVICE_PID_PATH's
      // own doc comment) rather than trusting the in-memory `this.pid` this
      // fresh RingController does not have either.
      const rigNoMarker = await buildRig({
        adbBinary: fakeAdb.binaryPath,
        adbEnv: { ...fakeAdb.env, PORTHOLE_TEST_RING_NO_PID_MARKER: "1" },
      });
      try {
        const stop = await rigNoMarker.client.callTool("system_trace_stop", {});
        expect(stop.isError).toBeFalsy();
        const payload = stop.json as { wasRunning: boolean };
        expect(payload.wasRunning).toBe(true);
        const order = fakeAdb.order();
        // pid-read fails first (the marker file is "missing"), then the
        // scan finds it, then it is killed.
        const stopOrder = order.slice(order.indexOf("pid-read"));
        expect(stopOrder).toEqual(["pid-read", "ps-scan", "kill", "rm"]);
        expect(fakeAdb.processMarkerExists()).toBe(false);
      } finally {
        await rigNoMarker.close();
      }
    } finally {
      await rig.close();
    }
  });

  it("a snapshot whose clone fails because the session died on-device reports that, and status stops claiming it is running", async () => {
    // A second, independent fake adb — its own process-table marker, its
    // own simulated "device" — rather than reusing `fakeAdb`: `start` now
    // refuses a second session even one it did not itself start (QA R2), so
    // sharing one fake device between two rigs here would make `rigDied`'s
    // own `system_trace_start` see the first rig's still-"running" marker
    // and correctly refuse, which is not what this test is about.
    const diedFakeAdb = setupFakeRingAdb({ PORTHOLE_TEST_RING_CLONE_FAIL: "died" });
    try {
      const rigDied = await buildRig({ adbBinary: diedFakeAdb.binaryPath, adbEnv: diedFakeAdb.env });
      try {
        await rigDied.client.callTool("system_trace_start", {});
        const snap = await rigDied.client.callTool("system_trace_snapshot", {});
        expect(snap.isError).toBe(true);
        expect(snap.text).toMatch(/no longer running/i);
        const status = await rigDied.client.callTool("porthole_status", {});
        const ring = (status.json as { ring: { running: boolean } }).ring;
        expect(ring.running).toBe(false);
      } finally {
        await rigDied.close();
      }
    } finally {
      diedFakeAdb.cleanup();
    }
  });

  it("porthole_status's ring field: not running, then running with the app/categories/buffer it started with", async () => {
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      const before = await rig.client.callTool("porthole_status", {});
      const ringBefore = (before.json as { ring: Record<string, unknown> }).ring;
      expect(ringBefore.running).toBe(false);
      expect(ringBefore.overhead).toEqual(MEASURED_OVERHEAD);

      await rig.client.callTool("system_trace_start", { bufferKb: 16384 });
      const after = await rig.client.callTool("porthole_status", {});
      const ringAfter = (after.json as { ring: Record<string, unknown> }).ring;
      expect(ringAfter.running).toBe(true);
      expect(ringAfter.bufferKb).toBe(16384);
      expect(typeof ringAfter.elapsedMs).toBe("number");
      expect(ringAfter.snapshots).toBe(0);

      const snapshotOutputDir = mkdtempSync(path.join(tmpdir(), "porthole-ring-status-out-"));
      const snap = await rig.client.callTool("system_trace_snapshot", { outputDir: snapshotOutputDir });
      const afterSnapshot = await rig.client.callTool("porthole_status", {});
      const ringAfterSnapshot = (afterSnapshot.json as {
        ring: { snapshots: number; lastSnapshotAt: string | null; lastSnapshot: unknown };
      }).ring;
      expect(ringAfterSnapshot.snapshots).toBe(1);
      expect(ringAfterSnapshot.lastSnapshotAt).not.toBeNull();
      // QA (R4): porthole_status.ring.lastSnapshot carries the same result
      // an explicit system_trace_snapshot call just returned — the same
      // field `findings`' own fire-and-forget auto-snapshot populates
      // without `findings` ever returning it directly.
      expect(ringAfterSnapshot.lastSnapshot).toEqual({
        path: (snap.json as { path: string }).path,
        bytes: (snap.json as { bytes: number }).bytes,
        auto: false,
      });
    } finally {
      await rig.close();
    }
  });

  it("system_trace_stop's payload leaves the ring field showing not running", async () => {
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      await rig.client.callTool("system_trace_start", {});
      await rig.client.callTool("system_trace_stop", {});
      const status = await rig.client.callTool("porthole_status", {});
      const ring = (status.json as { ring: { running: boolean } }).ring;
      expect(ring.running).toBe(false);
    } finally {
      await rig.close();
    }
  });
});

// ---------------------------------------------------------------------------
// auto-snapshot on an error-severity finding
// ---------------------------------------------------------------------------

/**
 * Polls `porthole_status` until its `ring.lastSnapshot` is set — the actual
 * fact these tests care about, set at the very end of `RingController.snapshot`
 * (after the clone, the pull, and its own on-device cleanup `rm` have all
 * finished). Waiting on `fakeAdb.order()` containing "pull" instead is a
 * race: that tag is written the instant the pull's OS process starts, not
 * once `snapshot()`'s promise — which still has a cleanup `rm` and a
 * `statSync` ahead of it — actually resolves and updates `pendingAutoSnapshot`.
 */
async function waitForAutoSnapshot(
  rig: { client: { callTool(name: string, args?: Record<string, unknown>): Promise<{ json: unknown }> } },
  timeoutMs = 3_000,
): Promise<{ path: string; bytes: number; auto: boolean }> {
  const start = Date.now();
  for (;;) {
    const status = await rig.client.callTool("porthole_status", {});
    const lastSnapshot = (status.json as { ring: { lastSnapshot: { path: string; bytes: number; auto: boolean } | null } })
      .ring.lastSnapshot;
    if (lastSnapshot) return lastSnapshot;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForAutoSnapshot timed out after ${timeoutMs}ms waiting for ring.lastSnapshot`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

adbDriven("findings auto-snapshots the ring on an error-severity finding", () => {
  let fakeAdb: FakeRingAdb;

  beforeEach(() => {
    fakeAdb = setupFakeRingAdb();
  });

  afterEach(() => {
    fakeAdb.cleanup();
    // The `findings` auto-snapshot path has no `outputDir` to redirect —
    // like `capture_system_trace`, it always writes under `.porthole/traces`
    // relative to the working directory — so these tests, unlike the
    // explicit-`system_trace_snapshot` ones above, cannot avoid writing
    // there. `.porthole/` is gitignored and per-checkout for exactly this
    // reason; removing only what this describe block itself wrote keeps
    // `perfetto-stdout.test.ts`'s own `newestPftrace()` (which picks up
    // whatever real capture is actually there) from being handed one of
    // these tests' fake, non-Perfetto-format snapshot files instead.
    rmSync(path.join(process.cwd(), ".porthole", "traces"), { recursive: true, force: true });
  });

  it("QA R4: the finding says a snapshot is in progress immediately, then carries the path once a later call asks again", async () => {
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      const now = 10_000;
      // A main-thread stall long enough to be an error-severity finding —
      // the exact shape `trace.ts`'s own analyser already recognises.
      await rig.pushEvents([
        {
          event: "blocked",
          t: now,
          data: { durationMs: 9000, stack: "CartViewModel.blockTheMainThread", top: "CartViewModel.blockTheMainThread(CartViewModel.kt:148)" },
        },
      ]);

      const withoutRing = await rig.client.callTool("findings", { from: 0, to: now + 1000 });
      const errorWithoutRing = (withoutRing.json as { findings: Array<Record<string, unknown>> }).findings.find(
        (f) => f.severity === "error",
      );
      expect(errorWithoutRing).toBeDefined();
      expect(errorWithoutRing?.ringSnapshot).toBeUndefined();

      await rig.client.callTool("system_trace_start", {});

      // The first call to see the error with the ring running kicks the
      // snapshot off but does not wait for it (QA R4) — the finding says so
      // rather than going quiet about it.
      const firstWithRing = await rig.client.callTool("findings", { from: 0, to: now + 1000 });
      const firstError = (firstWithRing.json as { findings: Array<Record<string, unknown>> }).findings.find(
        (f) => f.severity === "error",
      );
      expect(firstError).toBeDefined();
      expect(firstError?.ringSnapshot).toEqual({ inProgress: true });

      const lastSnapshot = await waitForAutoSnapshot(rig);

      const secondWithRing = await rig.client.callTool("findings", { from: 0, to: now + 1000 });
      const secondError = (secondWithRing.json as { findings: Array<Record<string, unknown>> }).findings.find(
        (f) => f.severity === "error",
      );
      expect(secondError?.ringSnapshot).toBeTruthy();
      const ringSnapshot = secondError?.ringSnapshot as { path: string; bytes: number };
      expect(readFileSync(ringSnapshot.path, "utf8")).toContain("porthole: fake-ring-label");

      // QA R4: porthole_status.ring.lastSnapshot independently carries the
      // same finished result, `auto: true` since findings triggered it.
      expect(lastSnapshot).toEqual({ path: ringSnapshot.path, bytes: ringSnapshot.bytes, auto: true });
    } finally {
      await rig.close();
    }
  });

  it("QA R4: findings returns before the fire-and-forget snapshot's own clone resolves", async () => {
    const rig = await buildRig({
      adbBinary: fakeAdb.binaryPath,
      adbEnv: { ...fakeAdb.env, PORTHOLE_TEST_RING_CLONE_DELAY_MS: "1500" },
    });
    try {
      await rig.client.callTool("system_trace_start", {});
      await rig.pushEvents([
        {
          event: "blocked",
          t: 10_000,
          data: { durationMs: 9000, stack: "CartViewModel.blockTheMainThread", top: "CartViewModel.blockTheMainThread(CartViewModel.kt:148)" },
        },
      ]);

      const startedAt = Date.now();
      const result = await rig.client.callTool("findings", { from: 0, to: 11_000 });
      const elapsedMs = Date.now() - startedAt;
      // The fake adb's own clone step alone takes 1.5s when it runs to
      // completion — findings returning in well under that is what proves
      // this call never awaited it, the same reasoning GRA-89 already
      // established for capture_system_trace's adb calls.
      expect(elapsedMs).toBeLessThan(1_000);
      const errorFinding = (result.json as { findings: Array<Record<string, unknown>> }).findings.find(
        (f) => f.severity === "error",
      );
      expect(errorFinding?.ringSnapshot).toEqual({ inProgress: true });

      // Let the delayed clone (and the pull after it) actually finish
      // before tearing the rig down — tidiness, not part of the assertion
      // above.
      await waitForAutoSnapshot(rig);
    } finally {
      await rig.close();
    }
  });

  it("does not auto-snapshot twice within the cooldown window for the same ongoing error", async () => {
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      await rig.client.callTool("system_trace_start", {});
      await rig.pushEvents([
        {
          event: "blocked",
          t: 10_000,
          data: { durationMs: 9000, stack: "CartViewModel.blockTheMainThread", top: "CartViewModel.blockTheMainThread(CartViewModel.kt:148)" },
        },
      ]);

      await rig.client.callTool("findings", { from: 0, to: 11_000 });
      await waitForAutoSnapshot(rig);
      const cloneCallsAfterFirst = fakeAdb.order().filter((tag) => tag === "clone").length;
      expect(cloneCallsAfterFirst).toBe(1);

      await rig.client.callTool("findings", { from: 0, to: 11_000, since: "all" });
      const cloneCallsAfterSecond = fakeAdb.order().filter((tag) => tag === "clone").length;
      // Still 1: the second call happened well inside AUTO_SNAPSHOT_COOLDOWN_MS
      // of the first, and the same still-ongoing error should not re-pull a
      // fresh multi-megabyte trace on every poll.
      expect(cloneCallsAfterSecond).toBe(1);
    } finally {
      await rig.close();
    }
  });
});
