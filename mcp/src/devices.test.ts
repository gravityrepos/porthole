// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DeviceClient } from "./device.js";
import {
  checkInstalledApp,
  diagnoseAndReconnect,
  ensureForward,
  forwardTarget,
  listDevices,
  parseDevicesOutput,
  resolveSerial,
} from "./devices.js";
import { stripComments } from "./testing/stripComments.js";
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
  it("runs 'adb -s SERIAL forward tcp:PORT localabstract:porthole.<applicationId>' by default (GRA-199)", async () => {
    const adb = fakeAdb({
      [fakeAdbArgsKey(["-s", "A1", "forward", "tcp:8677", "localabstract:porthole.com.example.shop"])]: {},
    });
    const result = await ensureForward(8677, "A1", "com.example.shop", false, { env: adb.env, binary: adb.binaryPath });
    expect(result.ok).toBe(true);
    expect(adb.calls()).toEqual([["-s", "A1", "forward", "tcp:8677", "localabstract:porthole.com.example.shop"]]);
  });

  it("surfaces adb's own failure text when the forward fails", async () => {
    const adb = fakeAdb({
      [fakeAdbArgsKey(["-s", "A1", "forward", "tcp:8677", "localabstract:porthole.com.example.shop"])]: {
        exitCode: 1,
        stderr: "error: device 'A1' not found\n",
      },
    });
    const result = await ensureForward(8677, "A1", "com.example.shop", false, { env: adb.env, binary: adb.binaryPath });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("legacyTcpPort forwards to the old shared TCP port instead, applicationId or not", async () => {
    const adb = fakeAdb({
      [fakeAdbArgsKey(["-s", "A1", "forward", "tcp:8677", "tcp:8677"])]: {},
    });
    const result = await ensureForward(8677, "A1", undefined, true, { env: adb.env, binary: adb.binaryPath });
    expect(result.ok).toBe(true);
    expect(adb.calls()).toEqual([["-s", "A1", "forward", "tcp:8677", "tcp:8677"]]);
  });

  it("refuses, without ever calling adb, when applicationId is unset and legacyTcpPort is off", async () => {
    const adb = fakeAdb({});
    const result = await ensureForward(8677, "A1", undefined, false, { env: adb.env, binary: adb.binaryPath });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("PORTHOLE_APPLICATION_ID");
    expect(adb.calls()).toEqual([]);
  });
});

describe("forwardTarget", () => {
  it("defaults to the abstract socket named for applicationId", () => {
    expect(forwardTarget(8677, "com.example.shop", false)).toEqual({
      ok: true,
      target: "localabstract:porthole.com.example.shop",
    });
  });

  it("legacyTcpPort forwards to the port itself, applicationId or not", () => {
    expect(forwardTarget(8677, "com.example.shop", true)).toEqual({ ok: true, target: "tcp:8677" });
    expect(forwardTarget(8677, undefined, true)).toEqual({ ok: true, target: "tcp:8677" });
  });

  it("refuses a missing applicationId rather than build a blank socket name", () => {
    const result = forwardTarget(8677, undefined, false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("PORTHOLE_APPLICATION_ID");
  });

  it("refuses a blank applicationId the same way as a missing one", () => {
    const result = forwardTarget(8677, "   ", false);
    expect(result.ok).toBe(false);
  });

  // -- GRA-199 QA (F3): trimmed, not just checked for blankness -----------

  it("trims surrounding whitespace on applicationId before building the target", () => {
    // Not merely "does not refuse" - the built target must be byte-for-byte
    // identical to what an untouched value would produce, so this side's
    // target agrees with PortholeTasks.kt's own forwardTarget (which now
    // trims too, GRA-199 QA F3) for the same nominal id.
    expect(forwardTarget(8677, "  com.example.shop  ", false)).toEqual({
      ok: true,
      target: "localabstract:porthole.com.example.shop",
    });
    expect(forwardTarget(8677, "\tcom.example.shop\n", false)).toEqual({
      ok: true,
      target: "localabstract:porthole.com.example.shop",
    });
  });

  it("whitespace-only applicationId is the same refusal as a genuinely blank one", () => {
    const result = forwardTarget(8677, "\t\n  ", false);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GRA-199 QA (F2): forwardTarget's abstract-socket prefix does not drift
// against Protocol.kt's PORTHOLE_SOCKET_PREFIX, or against PortholeTasks.kt's
// own copy of the same string. See PORTHOLE_SOCKET_PREFIX's own KDoc in
// Protocol.kt for the full story; ForwardTargetParityTest.kt in gradle-plugin
// carries the matching Kotlin-side half.
// ---------------------------------------------------------------------------

describe("forwardTarget's prefix agrees with Protocol.kt's PORTHOLE_SOCKET_PREFIX", () => {
  it("localabstract:porthole. matches Protocol.kt's own constant", () => {
    const kotlin = readFileSync(
      new URL(
        "../../runtime/src/main/kotlin/live/gravitylabs/porthole/protocol/Protocol.kt",
        import.meta.url,
      ),
      "utf8",
    );
    const matches = [
      ...stripComments(kotlin).matchAll(/internal const val PORTHOLE_SOCKET_PREFIX\s*=\s*"([^"]*)"/g),
    ];
    expect(
      matches.length,
      matches.length === 0
        ? "PORTHOLE_SOCKET_PREFIX declaration was not found in Protocol.kt in the expected shape"
        : `found ${matches.length} things that look like a PORTHOLE_SOCKET_PREFIX declaration in ` +
            "Protocol.kt outside comments -- this parser cannot tell which one is real, so it refuses to guess",
    ).toBe(1);
    const prefix = matches[0][1];
    expect(prefix).toBe("porthole.");

    const result = forwardTarget(8677, "com.example.shop", false);
    expect(result).toEqual({ ok: true, target: `localabstract:${prefix}com.example.shop` });
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
      [fakeAdbArgsKey(["-s", "A1", "forward", "tcp:8677", "localabstract:porthole.com.example.shop"])]: {
        exitCode: 1,
        stderr: "error: device offline\n",
      },
    });

    const outcome = await diagnoseAndReconnect(device, 8677, {
      applicationId: "com.example.shop",
      adbOptions: { env: adb.env, binary: adb.binaryPath },
    });

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
      [fakeAdbArgsKey(["-s", "A1", "forward", `tcp:${fakeDevice.port}`, "localabstract:porthole.com.example.shop"])]: {},
    });

    const outcome = await diagnoseAndReconnect(device, fakeDevice.port, {
      applicationId: "com.example.shop",
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
      [fakeAdbArgsKey(["-s", "A1", "forward", `tcp:${port}`, "localabstract:porthole.com.example.shop"])]: {},
    });

    const outcome = await diagnoseAndReconnect(device, port, {
      applicationId: "com.example.shop",
      adbOptions: { env: adb.env, binary: adb.binaryPath },
      waitMs: 250,
      pollMs: 25,
    });

    expect(outcome.reconnected).toBe(false);
    expect(outcome.message).toContain("porthole_connect");

    device.stop();
  });

  it("reports forwardTarget's own refusal, without calling adb's forward, when applicationId is unknown", async () => {
    const device = new DeviceClient("127.0.0.1", 1);
    const adb = fakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: { stdout: "List of devices attached\nA1  device model:Pixel_5\n" },
    });

    // No applicationId, no legacyTcpPort — the one combination GRA-199's
    // forwardTarget refuses outright, from a caller (porthole_status, via
    // this function) that has no `packageName` argument of its own to fall
    // back on the way porthole_connect does.
    const outcome = await diagnoseAndReconnect(device, 8677, { adbOptions: { env: adb.env, binary: adb.binaryPath } });

    expect(outcome.serial).toBe("A1");
    expect(outcome.forward?.ok).toBe(false);
    expect(outcome.message).toContain("PORTHOLE_APPLICATION_ID");
    // Only the device listing ran - forwardTarget's refusal is synchronous
    // and short-circuits ensureForward before it ever calls adb again.
    expect(adb.calls()).toEqual([["devices", "-l"]]);
  });
});
