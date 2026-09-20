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
 * exists to preserve. `--background` (a plain detached child, no `--detach`
 * key needed because `unique_session_name` makes the session discoverable
 * by name afterward) plus `--clone-by-name` for a non-disruptive snapshot is
 * what `ring.ts` actually does instead — confirmed on the spike's emulator
 * by finding the source `perfetto` process still listed in `ps` immediately
 * after a `--clone-by-name` pull. This file is the test-suite half of that:
 * a fake adb standing in for the device, proving the plan is written
 * correctly, the right commands run in the right order, a snapshot pulls
 * without touching the running session, and `stop` leaves nothing behind —
 * the real emulator run is evidence in the ticket's report, not something
 * this suite can re-run in CI.
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
});

describe("RingController.status(), with no adb call ever made", () => {
  it("reports not running, with the measured overhead figures present regardless", () => {
    const controller = new RingController();
    const status = controller.status();
    expect(status.running).toBe(false);
    expect(status.startedAt).toBeNull();
    expect(status.elapsedMs).toBeNull();
    expect(status.app).toBeNull();
    expect(status.snapshots).toBe(0);
    expect(status.lastSnapshotAt).toBeNull();
    // Shown even when idle — an agent deciding whether to turn the ring on
    // sees the cost before asking, not after.
    expect(status.overhead).toEqual(MEASURED_OVERHEAD);
  });

  it("a snapshot attempt with nothing started fails without ever touching adb", async () => {
    const controller = new RingController();
    const result = await controller.snapshot({});
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// a fake adb standing in for the device
// ---------------------------------------------------------------------------

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

if (a[0] === "shell" && typeof a[1] === "string" && a[1].includes("--background")) {
  logOrder("start");
  if (process.env.PORTHOLE_TEST_RING_START_FAIL === "1") {
    process.stderr.write("fake-ring-adb: could not start\\n");
    process.exit(1);
  }
  process.stdout.write(FAKE_PID + "\\n");
  // A PTY warning perfetto genuinely writes on some hosts — ring.ts's PID
  // parsing has to see past this, not merely happen to work without it.
  process.stderr.write("Warning: No PTY.\\n");
  process.exit(0);
}

if (a[0] === "shell" && typeof a[1] === "string" && a[1].startsWith("printf")) {
  logOrder("pid-marker");
  process.exit(0);
}

if (a[0] === "shell" && typeof a[1] === "string" && a[1].includes("--clone-by-name")) {
  logOrder("clone");
  if (process.env.PORTHOLE_TEST_RING_CLONE_FAIL === "died") {
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
  if (process.env.PORTHOLE_TEST_RING_NO_PID_MARKER === "1") {
    process.stderr.write("cat: No such file or directory\\n");
    process.exit(1);
  }
  process.stdout.write(FAKE_PID + "\\n");
  process.exit(0);
}

if (a[0] === "shell" && typeof a[1] === "string" && a[1].startsWith("kill")) {
  logOrder("kill");
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
  cleanup(): void;
}

/**
 * Same shape as `index.test.ts`'s own `setupFakeAdb` (GRA-89/GRA-186) — a
 * hard link to the real, running `node` binary plus `NODE_OPTIONS` pointed
 * at a preload script — and the same reason: `ring.ts`'s commands include
 * dynamic local paths (a freshly `mkdtempSync`'d config file, a snapshot's
 * pulled-to path) that `testing/fakeAdb.ts`'s fixed-argv response table has
 * no way to key on, since the exact string is different on every test run.
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

  return {
    binaryPath,
    env: {
      ...process.env,
      ...extraEnv,
      NODE_OPTIONS: `--require=${preloadPath}`,
      PORTHOLE_TEST_RING_ORDER_LOG: orderLogPath,
      PORTHOLE_TEST_RING_LAST_PUSHED_CONFIG: lastPushedConfigPath,
    },
    order() {
      return readFileSync(orderLogPath, "utf8").split("\n").filter(Boolean);
    },
    lastPushedConfig() {
      return readFileSync(lastPushedConfigPath, "utf8");
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

// ---------------------------------------------------------------------------
// RingController, against the fake adb, through the real MCP tools
// ---------------------------------------------------------------------------

describe("system_trace_start / system_trace_snapshot / system_trace_stop", () => {
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
      expect(fakeAdb.order()).toEqual(["push", "start", "pid-marker", "rm"]);
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

  it("snapshot clones the running session — not attach+stop — and pulls the result without stopping anything", async () => {
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      await rig.client.callTool("system_trace_start", {});
      const outputDir = mkdtempSync(path.join(tmpdir(), "porthole-ring-out-"));
      const snap = await rig.client.callTool("system_trace_snapshot", { outputDir });
      expect(snap.isError).toBeFalsy();
      const payload = snap.json as { path: string; bytes: number };
      expect(readFileSync(payload.path, "utf8")).toContain("porthole: fake-ring-label");
      expect(payload.bytes).toBeGreaterThan(0);
      // clone, then pull, then a cleanup rm of the on-device snapshot file —
      // never a "stop"/"kill" anywhere in here, which is the whole point of
      // --clone-by-name over --attach --stop.
      expect(fakeAdb.order()).toEqual(["push", "start", "pid-marker", "rm", "clone", "pull", "rm"]);
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

  it("a snapshot whose clone fails because the session died on-device reports that, and status stops claiming it is running", async () => {
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      await rig.client.callTool("system_trace_start", {});
      const diedAdb = { ...fakeAdb.env, PORTHOLE_TEST_RING_CLONE_FAIL: "died" };
      const rigDied = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: diedAdb });
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
      await rig.close();
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
      await rig.client.callTool("system_trace_snapshot", { outputDir: snapshotOutputDir });
      const afterSnapshot = await rig.client.callTool("porthole_status", {});
      const ringAfterSnapshot = (afterSnapshot.json as { ring: Record<string, unknown> }).ring;
      expect(ringAfterSnapshot.snapshots).toBe(1);
      expect(ringAfterSnapshot.lastSnapshotAt).not.toBeNull();
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

describe("findings auto-snapshots the ring on an error-severity finding", () => {
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

  it("attaches a ringSnapshot to an error finding while the ring is running, and does not when it is not", async () => {
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      const now = 10_000;
      // A main-thread stall long enough to be an error-severity finding —
      // the exact shape `trace.ts`'s own analyser already recognises.
      await rig.pushEvents([
        { event: "blocked", t: now, data: { durationMs: 9000, stack: "CartViewModel.blockTheMainThread", top: "CartViewModel.blockTheMainThread(CartViewModel.kt:148)" } },
      ]);

      const withoutRing = await rig.client.callTool("findings", { from: 0, to: now + 1000 });
      const errorWithoutRing = (withoutRing.json as { findings: Array<Record<string, unknown>> }).findings.find(
        (f) => f.severity === "error",
      );
      expect(errorWithoutRing).toBeDefined();
      expect(errorWithoutRing?.ringSnapshot).toBeUndefined();

      await rig.client.callTool("system_trace_start", {});
      const withRing = await rig.client.callTool("findings", { from: 0, to: now + 1000 });
      const errorWithRing = (withRing.json as { findings: Array<Record<string, unknown>> }).findings.find(
        (f) => f.severity === "error",
      );
      expect(errorWithRing).toBeDefined();
      expect(errorWithRing?.ringSnapshot).toBeTruthy();
      const ringSnapshot = errorWithRing?.ringSnapshot as { path: string; bytes: number };
      expect(readFileSync(ringSnapshot.path, "utf8")).toContain("porthole: fake-ring-label");
      expect(fakeAdb.order()).toContain("clone");
    } finally {
      await rig.close();
    }
  });

  it("does not auto-snapshot twice within the cooldown window for the same ongoing error", async () => {
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      await rig.client.callTool("system_trace_start", {});
      await rig.pushEvents([
        { event: "blocked", t: 10_000, data: { durationMs: 9000, stack: "CartViewModel.blockTheMainThread", top: "CartViewModel.blockTheMainThread(CartViewModel.kt:148)" } },
      ]);

      await rig.client.callTool("findings", { from: 0, to: 11_000 });
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
