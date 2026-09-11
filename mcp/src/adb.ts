// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** adb, in the order a developer would look for it. Mirrors the Gradle plugin. */
export function findAdb(): string {
  const binary = process.platform === "win32" ? "adb.exe" : "adb";
  for (const variable of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const root = process.env[variable];
    if (!root) continue;
    const candidate = path.join(root, "platform-tools", binary);
    if (existsSync(candidate)) return candidate;
  }
  return binary;
}

export interface AdbResult {
  ok: boolean;
  output: string;
}

export function runAdb(args: string[], serial?: string): AdbResult {
  const prefix = serial ? ["-s", serial] : [];
  const result = spawnSync(findAdb(), [...prefix, ...args], { encoding: "utf8" });

  if (result.error) {
    return {
      ok: false,
      output:
        `Could not run adb (${result.error.message}). ` +
        "Set ANDROID_HOME, or put adb on your PATH.",
    };
  }

  const output = ((result.stdout || "") + (result.stderr || "")).trim();
  if (result.status !== 0) {
    return {
      ok: false,
      output:
        output.includes("more than one") && !serial
          ? `${output}\nStart the UI with --serial <id>; 'adb devices' lists them.`
          : output || `adb exited ${result.status}`,
    };
  }
  return { ok: true, output };
}

/**
 * Stop the app and start it again.
 *
 * Driven from this side rather than from inside the app: a process cannot
 * reliably restart itself, and asking it to try is how you end up with a
 * half-dead process that no longer answers the socket.
 */
export function restartApp(packageName: string, serial?: string): AdbResult {
  const stopped = runAdb(["shell", "am", "force-stop", packageName], serial);
  if (!stopped.ok) return stopped;

  const started = runAdb(
    ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"],
    serial,
  );
  if (!started.ok) return started;

  // monkey reports success on stdout even when it launched nothing, so the
  // absence of its "Events injected" line is the honest failure signal.
  if (!started.output.includes("Events injected")) {
    return {
      ok: false,
      output: started.output || `No launcher activity found for ${packageName}.`,
    };
  }
  return { ok: true, output: `restarted ${packageName}` };
}
