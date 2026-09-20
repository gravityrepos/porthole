// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { DeviceClient } from "./device.js";
import {
  checkInstalledApp,
  diagnoseAndReconnect,
  ensureForward,
  listDevices,
  parseDevicesOutput,
  resolveSerial,
} from "./devices.js";
import { buildFakeAdb, fakeAdbArgsKey, type FakeAdb } from "./testing/fakeAdb.js";
import { FakeDevice, waitUntil } from "./testing/harness.js";

/**
 * GRA-62: "the agent connects to the device itself instead of asking for
 * help". These are the primitives `porthole_status`'s one read-only
 * exception, and `porthole_connect`'s acting half, are built from —
 * `index.ts`'s own tests (`surface.test.ts`) cover the tools that call
 * them; this file covers the mechanism, direct and unit-level, so a
 * regression here fails close to its cause instead of surfacing as a
 * confusing MCP-surface assertion three layers up.
 */

let toCleanup: Array<{ cleanup(): void }> = [];
afterEach(() => {
  for (const fakeAdb of toCleanup) fakeAdb.cleanup();
  toCleanup = [];
});

function fakeAdb(responses: Parameters<typeof buildFakeAdb>[0]): FakeAdb {
  const built = buildFakeAdb(responses);
  toCleanup.push(built);
  return built;
}

describe("parseDevicesOutput", () => {
  it("is empty when adb reports no devices at all — just the header line", () => {
    expect(parseDevicesOutput("List of devices attached\n\n")).toEqual([]);
  });

  it("reads a ready device's serial, state and model out of the -l columns", () => {
    const output =
      "List of devices attached\n" +
      "R3CN90XXXXX           device usb:1-1 product:redfin model:Pixel_5 device:redfin transport_id:3\n";
    expect(parseDevicesOutput(output)).toEqual([{ serial: "R3CN90XXXXX", state: "device", model: "Pixel_5" }]);
  });

  it("leaves model null when the line carries no model: key — an unauthorized device's actual shape", () => {
    const output = "List of devices attached\nZY22222222             unauthorized usb:1-1 transport_id:2\n";
    expect(parseDevicesOutput(output)).toEqual([{ serial: "ZY22222222", state: "unauthorized", model: null }]);
  });

  it("reads every device when several are attached, tolerating blank lines and CRLF", () => {
    const output =
      "List of devices attached\r\n" +
      "emulator-5554  device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:1\r\n" +
      "\r\n" +
      "R3CN90XXXXX    device usb:1-1 model:Pixel_5 transport_id:3\r\n";
    expect(parseDevicesOutput(output)).toEqual([
      { serial: "emulator-5554", state: "device", model: "sdk_gphone64_arm64" },
      { serial: "R3CN90XXXXX", state: "device", model: "Pixel_5" },
    ]);
  });
});

describe("resolveSerial", () => {
  const twoReady = [
    { serial: "A1", state: "device", model: "Pixel_5" },
    { serial: "B2", state: "device", model: null },
  ];

  it("an explicit serial wins outright, even one that names no device in the list", () => {
    // Deliberately not validated against `devices` here — see the function's
    // own doc comment: adb's own complaint on the `forward` call this feeds
    // into is the right place for "no such device", not a second guess here.
    expect(resolveSerial(twoReady, "not-in-the-list", undefined)).toEqual({
      kind: "resolved",
      serial: "not-in-the-list",
      source: "parameter",
    });
  });

  it("PORTHOLE_SERIAL wins over auto-picking a single ready device", () => {
    const oneReady = [twoReady[0]];
    expect(resolveSerial(oneReady, undefined, "env-serial")).toEqual({
      kind: "resolved",
      serial: "env-serial",
      source: "PORTHOLE_SERIAL",
    });
  });

  it("auto-picks the one ready device when nothing else names one", () => {
    const oneReady = [twoReady[0]];
    expect(resolveSerial(oneReady, undefined, undefined)).toEqual({
      kind: "resolved",
      serial: "A1",
      source: "single-device",
    });
  });

  it("is none-ready when every attached device is unauthorized/offline, not silently picked", () => {
    const notReady = [
      { serial: "A1", state: "unauthorized", model: null },
      { serial: "B2", state: "offline", model: null },
    ];
    const result = resolveSerial(notReady, undefined, undefined);
    expect(result.kind).toBe("none-ready");
    expect(result.kind === "none-ready" && result.devices).toEqual(notReady);
  });

  it("is ambiguous with two ready devices and nothing to pick one — GRA-62 AC3", () => {
    const result = resolveSerial(twoReady, undefined, undefined);
    expect(result.kind).toBe("ambiguous");
    expect(result.kind === "ambiguous" && result.devices).toEqual(twoReady);
  });
});

describe("listDevices, against a real (faked) adb process", () => {
  it("parses what a real 'adb devices -l' invocation returns", async () => {
    const adb = fakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: {
        stdout: "List of devices attached\nA1  device model:Pixel_5\n",
      },
    });
    const result = await listDevices({ env: adb.env, binary: adb.binaryPath });
    expect(result.ok).toBe(true);
    expect(result.devices).toEqual([{ serial: "A1", state: "device", model: "Pixel_5" }]);
  });

  it("reports adb's own failure rather than an empty list — the two must not be confused", async () => {
    const adb = fakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: { exitCode: 1, stderr: "adb: no permissions\n" },
    });
    const result = await listDevices({ env: adb.env, binary: adb.binaryPath });
    expect(result.ok).toBe(false);
    expect(result.devices).toEqual([]);
    expect(result.output).toContain("no permissions");
  });
});

describe("ensureForward", () => {
  it("runs 'adb -s SERIAL forward tcp:PORT tcp:PORT' — the exact call porthole ui/capture already make", async () => {
    const adb = fakeAdb({
      [fakeAdbArgsKey(["-s", "A1", "forward", "tcp:8677", "tcp:8677"])]: {},
    });
    const result = await ensureForward(8677, "A1", { env: adb.env, binary: adb.binaryPath });
    expect(result.ok).toBe(true);
    expect(adb.calls()).toEqual([["-s", "A1", "forward", "tcp:8677", "tcp:8677"]]);
  });

  it("surfaces adb's own failure text when the forward fails", async () => {
    const adb = fakeAdb({
      [fakeAdbArgsKey(["-s", "A1", "forward", "tcp:8677", "tcp:8677"])]: {
        exitCode: 1,
        stderr: "error: device 'A1' not found\n",
      },
    });
    const result = await ensureForward(8677, "A1", { env: adb.env, binary: adb.binaryPath });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not found");
  });
});

describe("checkInstalledApp", () => {
  const dumpsysKey = (pkg: string) => fakeAdbArgsKey(["-s", "A1", "shell", "dumpsys", "package", pkg]);
  const pidofKey = (pkg: string) => fakeAdbArgsKey(["-s", "A1", "shell", "pidof", pkg]);

  it("reports not-installed when dumpsys names no such package", async () => {
    const adb = fakeAdb({
      [dumpsysKey("com.example.shop")]: { stdout: "Unable to find package: com.example.shop\n" },
    });
    const result = await checkInstalledApp("com.example.shop", "A1", { env: adb.env, binary: adb.binaryPath });
    expect(result).toEqual({
      ok: true,
      info: { installed: false, versionName: null, debuggable: null, running: false },
    });
  });

  it("reports version, debuggable and running for an installed, running debug build", async () => {
    const adb = fakeAdb({
      [dumpsysKey("com.example.shop")]: {
        stdout:
          "Packages:\n  Package [com.example.shop] (abcd1234):\n" +
          "    versionName=1.2.3\n    flags=[ DEBUGGABLE HAS_CODE ALLOW_BACKUP ]\n",
      },
      [pidofKey("com.example.shop")]: { stdout: "12345\n" },
    });
    const result = await checkInstalledApp("com.example.shop", "A1", { env: adb.env, binary: adb.binaryPath });
    expect(result).toEqual({
      ok: true,
      info: { installed: true, versionName: "1.2.3", debuggable: true, running: true },
    });
  });

  it("reports a release build as not debuggable and, here, not running — GRA-62 AC4", async () => {
    const adb = fakeAdb({
      [dumpsysKey("com.example.shop")]: {
        stdout: "Package [com.example.shop] (abcd1234):\n    versionName=1.2.3\n    flags=[ HAS_CODE ]\n",
      },
      // A real pidof exits non-zero with no stdout when nothing matches.
      [pidofKey("com.example.shop")]: { exitCode: 1 },
    });
    const result = await checkInstalledApp("com.example.shop", "A1", { env: adb.env, binary: adb.binaryPath });
    expect(result).toEqual({
      ok: true,
      info: { installed: true, versionName: "1.2.3", debuggable: false, running: false },
    });
  });

  it("propagates adb's own failure instead of reading it as 'not installed'", async () => {
    const adb = fakeAdb({
      [dumpsysKey("com.example.shop")]: { exitCode: 1, stderr: "error: no devices/emulators found\n" },
    });
    const result = await checkInstalledApp("com.example.shop", "A1", { env: adb.env, binary: adb.binaryPath });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.output).toContain("no devices/emulators found");
  });
});

// ---------------------------------------------------------------------------
// diagnoseAndReconnect — porthole_status's one exception, end to end
// ---------------------------------------------------------------------------

describe("diagnoseAndReconnect", () => {
  it("does nothing at all when the device is already attached — no adb call, idempotent by construction", async () => {
    const fakeDevice = await FakeDevice.start();
    const device = new DeviceClient("127.0.0.1", fakeDevice.port);
    device.start();
    await waitUntil(() => device.state === "connected");

    // A fake adb that would exit 17 ("no configured response") on any call
    // at all — proving no call happened is the only way this test can fail
    // for the right reason instead of by coincidence.
    const adb = fakeAdb({});
    const outcome = await diagnoseAndReconnect(device, 8677, { adbOptions: { env: adb.env, binary: adb.binaryPath } });

    expect(outcome).toEqual({
      attempted: false,
      devices: [],
      listError: null,
      serial: null,
      serialSource: null,
      ambiguous: false,
      forward: null,
      reconnected: true,
      message: "",
    });
    expect(adb.calls()).toEqual([]);

    device.stop();
    await fakeDevice.close();
  });

  it("names 'no device attached' specifically, without suggesting portholeConnect — GRA-62 AC2", async () => {
    const device = new DeviceClient("127.0.0.1", 1); // never started; state stays "disconnected"
    const adb = fakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: { stdout: "List of devices attached\n\n" },
    });

    const outcome = await diagnoseAndReconnect(device, 8677, { adbOptions: { env: adb.env, binary: adb.binaryPath } });

    expect(outcome.attempted).toBe(true);
    expect(outcome.reconnected).toBe(false);
    expect(outcome.message).toContain("No Android device or emulator is attached");
    expect(outcome.message).not.toContain("portholeConnect");
  });

  it("lists both devices and asks for a serial when two are attached and none is configured — GRA-62 AC3", async () => {
    const device = new DeviceClient("127.0.0.1", 1);
    const adb = fakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: {
        stdout: "List of devices attached\nA1  device model:Pixel_5\nB2  device model:Pixel_6\n",
      },
    });

    const outcome = await diagnoseAndReconnect(device, 8677, { adbOptions: { env: adb.env, binary: adb.binaryPath } });

    expect(outcome.ambiguous).toBe(true);
    expect(outcome.devices.map((d) => d.serial)).toEqual(["A1", "B2"]);
    expect(outcome.message).toContain("A1");
    expect(outcome.message).toContain("B2");
    expect(outcome.reconnected).toBe(false);
  });

  it("reports the forward failure by name rather than a generic 'not connected'", async () => {
    const device = new DeviceClient("127.0.0.1", 1);
    const adb = fakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: { stdout: "List of devices attached\nA1  device model:Pixel_5\n" },
      [fakeAdbArgsKey(["-s", "A1", "forward", "tcp:8677", "tcp:8677"])]: {
        exitCode: 1,
        stderr: "error: device offline\n",
      },
    });

    const outcome = await diagnoseAndReconnect(device, 8677, { adbOptions: { env: adb.env, binary: adb.binaryPath } });

    expect(outcome.serial).toBe("A1");
    expect(outcome.forward?.ok).toBe(false);
    expect(outcome.reconnected).toBe(false);
    expect(outcome.message).toContain("could not forward the port");
  });

  it("re-establishes the forward, nudges the client, and reports connected — GRA-62 AC1", async () => {
    const fakeDevice = await FakeDevice.start();
    // Constructed but never started: this stands in for "the forward was
    // removed" — nothing has attempted to connect at all, same symptom.
    const device = new DeviceClient("127.0.0.1", fakeDevice.port);
    expect(device.state).toBe("disconnected");

    const adb = fakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: { stdout: "List of devices attached\nA1  device model:Pixel_5\n" },
      [fakeAdbArgsKey(["-s", "A1", "forward", `tcp:${fakeDevice.port}`, `tcp:${fakeDevice.port}`])]: {},
    });

    const outcome = await diagnoseAndReconnect(device, fakeDevice.port, {
      adbOptions: { env: adb.env, binary: adb.binaryPath },
    });

    expect(outcome.serial).toBe("A1");
    expect(outcome.forward?.ok).toBe(true);
    expect(outcome.reconnected).toBe(true);
    expect(outcome.message).toBe("");
    expect(device.state).not.toBe("disconnected");

    device.stop();
    await fakeDevice.close();
  });

  it("says try again and names porthole_connect when nothing answers within the wait — not a false 'connected'", async () => {
    // A port nothing is listening on: the TCP connect itself fails
    // (ECONNREFUSED), so the client cannot even reach "handshaking" —
    // unlike a listening-but-silent peer, which `isAttached()` already
    // counts as attached the instant the socket connects, before hello
    // ever answers (the same loose sense `findings`/`porthole_status` use
    // elsewhere). Found by briefly listening and closing again, rather
    // than a literal, so this cannot collide with a port something else on
    // the test machine actually has open.
    const net = await import("node:net");
    const probe = net.createServer();
    await new Promise<void>((resolveListen) => probe.listen(0, "127.0.0.1", () => resolveListen()));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));

    const device = new DeviceClient("127.0.0.1", port);
    const adb = fakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: { stdout: "List of devices attached\nA1  device model:Pixel_5\n" },
      [fakeAdbArgsKey(["-s", "A1", "forward", `tcp:${port}`, `tcp:${port}`])]: {},
    });

    const outcome = await diagnoseAndReconnect(device, port, {
      adbOptions: { env: adb.env, binary: adb.binaryPath },
      waitMs: 250,
      pollMs: 25,
    });

    expect(outcome.reconnected).toBe(false);
    expect(outcome.message).toContain("porthole_connect");

    device.stop();
  });
});
