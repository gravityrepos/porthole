// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { ConnectionState } from "./device.js";
import { isAttached } from "./device.js";
import { type AdbResult, type RunAdbAsyncOptions, runAdbAsync } from "./adb.js";

/**
 * GRA-62: the agent connects to the device itself instead of asking a human
 * to run `adb` by hand. The MCP server already shells out to `adb` for
 * `system_context` and `capture_system_trace`; this is the same thing aimed
 * at the one gap that used to stop the loop cold — "not connected" with no
 * way for the agent to act on it, because the fix (`adb forward`, install,
 * launch) lived on a shell a chat client's agent cannot reach.
 *
 * Split, per the EM's ruling on this ticket: `porthole_status` (index.ts)
 * stays `readOnlyHint:true` and only ever calls [diagnoseAndReconnect] below
 * — idempotent, invisible to the app under test. Everything that can act on
 * the app itself (install/version checks, launching, restarting) lives in
 * the sibling `porthole_connect` tool, `readOnlyHint:false`, which calls the
 * rest of this module.
 */

// ---------------------------------------------------------------------------
// listing devices
// ---------------------------------------------------------------------------

export interface AdbDeviceListing {
  serial: string;
  /** "device" is ready; "unauthorized"/"offline"/anything else is attached but not usable. */
  state: string;
  model: string | null;
}

/**
 * `adb devices -l` output, e.g.:
 *
 *   List of devices attached
 *   R3CN90XXXXX            device usb:1-1 product:redfin model:Pixel_5 device:redfin transport_id:3
 *   emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:1
 *   ZY22222222             unauthorized usb:1-1 transport_id:2
 *
 * The header line and any blank line are dropped; everything else is
 * `<serial> <state> [key:value ...]`, and only `model` is pulled out of the
 * trailing key:value pairs — the rest (`usb`, `product`, `transport_id`)
 * has no caller here yet.
 */
export function parseDevicesOutput(output: string): AdbDeviceListing[] {
  const listings: AdbDeviceListing[] = [];
  for (const rawLine of output.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("List of devices attached")) continue;
    const parts = line.split(/\s+/);
    const [serial, state] = parts;
    if (!serial || !state) continue;
    const modelToken = parts.find((p) => p.startsWith("model:"));
    listings.push({ serial, state, model: modelToken ? modelToken.slice("model:".length) : null });
  }
  return listings;
}

export interface ListDevicesResult {
  ok: boolean;
  devices: AdbDeviceListing[];
  /** Raw adb output on success, or the error text on failure — same convention as AdbResult. */
  output: string;
}

export async function listDevices(options: RunAdbAsyncOptions = {}): Promise<ListDevicesResult> {
  const result = await runAdbAsync(["devices", "-l"], options);
  if (!result.ok) return { ok: false, devices: [], output: result.output };
  return { ok: true, devices: parseDevicesOutput(result.output), output: result.output };
}

/** For splicing into prose: "none" when the list is empty, otherwise "SERIAL (state, model), ...". */
export function describeDevices(devices: AdbDeviceListing[]): string {
  if (devices.length === 0) return "none";
  return devices.map((d) => `${d.serial} (${d.state}${d.model ? `, ${d.model}` : ""})`).join(", ");
}

// ---------------------------------------------------------------------------
// picking a serial
// ---------------------------------------------------------------------------

export type SerialResolution =
  | { kind: "resolved"; serial: string; source: "parameter" | "PORTHOLE_SERIAL" | "single-device" }
  /** Devices are attached, but none report the "device" state adb needs to talk to one. */
  | { kind: "none-ready"; devices: AdbDeviceListing[] }
  /** More than one candidate and nothing named which one. */
  | { kind: "ambiguous"; devices: AdbDeviceListing[] };

/**
 * `explicit` (a tool's own `serial` parameter) wins outright, then
 * `PORTHOLE_SERIAL` — GRA-119's env-var precedent, per the EM note on this
 * ticket: resolve from `adb devices` plus an explicit serial, never from the
 * Gradle plugin's own connection file and never from an assumed cwd. Neither
 * is validated against `devices` here — an unknown serial is adb's own
 * complaint to make, on the `forward` call that actually uses it, not
 * something this pure function can or should second-guess.
 *
 * Only "device"-state listings are ever picked automatically: a single
 * "unauthorized" or "offline" entry is not a workable candidate, so it falls
 * to "none-ready" rather than being silently selected and failing later at
 * the `forward` call with a less specific error.
 */
export function resolveSerial(
  devices: AdbDeviceListing[],
  explicit: string | undefined,
  envSerial: string | undefined,
): SerialResolution {
  if (explicit && explicit.trim()) return { kind: "resolved", serial: explicit.trim(), source: "parameter" };
  if (envSerial && envSerial.trim()) {
    return { kind: "resolved", serial: envSerial.trim(), source: "PORTHOLE_SERIAL" };
  }
  const ready = devices.filter((d) => d.state === "device");
  if (ready.length === 0) return { kind: "none-ready", devices };
  if (ready.length === 1) return { kind: "resolved", serial: ready[0].serial, source: "single-device" };
  return { kind: "ambiguous", devices: ready };
}

// ---------------------------------------------------------------------------
// the forward
// ---------------------------------------------------------------------------

/** `adb [-s serial] forward tcp:port tcp:port` — the exact call `porthole ui`/`porthole capture` already make, idempotent by construction (adb replaces an existing identical forward rather than erroring). */
export function ensureForward(
  port: number,
  serial: string | undefined,
  options: RunAdbAsyncOptions = {},
): Promise<AdbResult> {
  return runAdbAsync(["forward", `tcp:${port}`, `tcp:${port}`], { ...options, serial });
}

// ---------------------------------------------------------------------------
// porthole_status's one exception: list, resolve, forward, nudge, wait
// ---------------------------------------------------------------------------

/**
 * The minimal shape [diagnoseAndReconnect] needs from a `DeviceClient` —
 * `state` to decide whether there is anything to do, `start()` to nudge a
 * reconnect once the forward is (re-)established. Declared narrow rather
 * than importing the concrete class as a value, so a test can hand this a
 * bare object instead of standing up a real socket for cases that never
 * reach `start()` at all (no device, ambiguous, forward failure).
 */
export interface ReconnectableDevice {
  readonly state: ConnectionState;
  start(): void;
}

export interface ReconnectOutcome {
  /** False when the device was already attached — nothing here runs at all. */
  attempted: boolean;
  devices: AdbDeviceListing[];
  /** Set only when `adb devices` itself failed (adb missing, etc). */
  listError: string | null;
  serial: string | null;
  serialSource: "parameter" | "PORTHOLE_SERIAL" | "single-device" | null;
  ambiguous: boolean;
  forward: AdbResult | null;
  /** True once `device.state` is attached (handshaking or connected) after the bounded wait. */
  reconnected: boolean;
  /** Empty when nothing is worth adding to porthole_status's own summary (not attempted, or reconnected). */
  message: string;
}

export interface DiagnoseAndReconnectOptions {
  /** A tool's own `serial` parameter, when it has one. */
  serial?: string;
  /** `process.env.PORTHOLE_SERIAL`, read by the caller so this stays a pure-ish function to test. */
  envSerial?: string;
  adbOptions?: RunAdbAsyncOptions;
  /** How long to give a freshly-forwarded device to attach before giving up on THIS call. Default 4000. */
  waitMs?: number;
  /** Poll interval for the wait above. Default 100. */
  pollMs?: number;
}

/**
 * `porthole_status`'s one exception to staying read-only: list attached
 * devices, resolve which one to use, (re-)establish the `adb forward`, and
 * nudge the client to reconnect right away instead of waiting out its own
 * backoff — all of it idempotent, none of it touching the app under test.
 *
 * Does nothing at all (`attempted: false`) when the device is already
 * attached (handshaking or connected): there is nothing to fix, and running
 * `adb devices`/`adb forward` on the hot path of an otherwise-healthy call
 * would only add latency for no reason.
 */
export async function diagnoseAndReconnect(
  device: ReconnectableDevice,
  port: number,
  options: DiagnoseAndReconnectOptions = {},
): Promise<ReconnectOutcome> {
  const notAttempted: ReconnectOutcome = {
    attempted: false,
    devices: [],
    listError: null,
    serial: null,
    serialSource: null,
    ambiguous: false,
    forward: null,
    reconnected: true,
    message: "",
  };
  if (isAttached(device.state)) return notAttempted;

  const listed = await listDevices(options.adbOptions);
  if (!listed.ok) {
    return {
      ...notAttempted,
      attempted: true,
      reconnected: false,
      listError: listed.output,
      message: `Could not list attached devices (${listed.output}).`,
    };
  }
  if (listed.devices.length === 0) {
    return {
      ...notAttempted,
      attempted: true,
      reconnected: false,
      message:
        "No Android device or emulator is attached ('adb devices' lists none). Plug one in, or start " +
        "an emulator, then try again.",
    };
  }

  const resolution = resolveSerial(listed.devices, options.serial, options.envSerial);
  if (resolution.kind === "none-ready") {
    return {
      ...notAttempted,
      attempted: true,
      reconnected: false,
      devices: listed.devices,
      message:
        `${listed.devices.length} device(s) attached, but none are ready: ${describeDevices(listed.devices)}. ` +
        "Check the device screen for a USB-debugging authorization prompt.",
    };
  }
  if (resolution.kind === "ambiguous") {
    return {
      ...notAttempted,
      attempted: true,
      reconnected: false,
      devices: listed.devices,
      ambiguous: true,
      message:
        `${resolution.devices.length} devices are attached and no serial is configured: ` +
        `${describeDevices(resolution.devices)}. Pass \`serial\`, or set PORTHOLE_SERIAL, to pick one.`,
    };
  }

  const forward = await ensureForward(port, resolution.serial, options.adbOptions);
  if (!forward.ok) {
    return {
      ...notAttempted,
      attempted: true,
      reconnected: false,
      devices: listed.devices,
      serial: resolution.serial,
      serialSource: resolution.source,
      forward,
      message: `Found ${resolution.serial}, but could not forward the port: ${forward.output}`,
    };
  }

  // Idempotent: DeviceClient.connect() no-ops if a socket already exists, so
  // this is safe to call whether the client is freshly disconnected or
  // already mid-attempt.
  device.start();

  const waitMs = options.waitMs ?? 4_000;
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + waitMs;
  while (!isAttached(device.state) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
  const reconnected = isAttached(device.state);

  return {
    attempted: true,
    devices: listed.devices,
    listError: null,
    serial: resolution.serial,
    serialSource: resolution.source,
    ambiguous: false,
    forward,
    reconnected,
    message: reconnected
      ? ""
      : `Forwarded port ${port} to ${resolution.serial}, but the app has not checked in yet. If it is ` +
        "running, try again in a moment. If not, call `porthole_connect` to check whether the debug " +
        "build is installed and launch it.",
  };
}

// ---------------------------------------------------------------------------
// install / version / running — porthole_connect's territory
// ---------------------------------------------------------------------------

export interface InstalledAppInfo {
  installed: boolean;
  versionName: string | null;
  /** null only when `installed` is false — there is nothing to read a flag off of. */
  debuggable: boolean | null;
  running: boolean;
}

/** Escapes a package name for use inside a RegExp literal — `.` is the only character package names contain that means anything to RegExp. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `adb shell dumpsys package <name>` for install state, version and whether
 * the installed build is debuggable, plus `adb shell pidof <name>` for
 * whether it is currently running — two separate, small, well-understood
 * commands rather than one that tries to parse everything out of a single
 * dump whose format shifts across Android versions.
 *
 * "debuggable" is a proxy for "this can be a Porthole runtime build", not
 * proof the runtime is actually on the classpath — `porthole_connect`'s own
 * prose says so rather than overclaiming here.
 */
export async function checkInstalledApp(
  packageName: string,
  serial: string | undefined,
  options: RunAdbAsyncOptions = {},
): Promise<{ ok: true; info: InstalledAppInfo } | { ok: false; output: string }> {
  const dump = await runAdbAsync(["shell", "dumpsys", "package", packageName], { ...options, serial });
  if (!dump.ok) return { ok: false, output: dump.output };

  const packageHeader = new RegExp(`Package \\[${escapeForRegExp(packageName)}\\]`).test(dump.output);
  const versionMatch = dump.output.match(/versionName=(\S+)/);
  if (!packageHeader && !versionMatch) {
    return { ok: true, info: { installed: false, versionName: null, debuggable: null, running: false } };
  }

  const flagsMatch = dump.output.match(/flags=\[([^\]]*)]/);
  const debuggable = flagsMatch ? flagsMatch[1].split(/\s+/).includes("DEBUGGABLE") : null;

  const pidof = await runAdbAsync(["shell", "pidof", packageName], { ...options, serial });
  const running = pidof.ok && /\d/.test(pidof.output.trim());

  return {
    ok: true,
    info: { installed: true, versionName: versionMatch ? versionMatch[1] : null, debuggable, running },
  };
}
