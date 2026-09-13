// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * How far up from the working directory to look for local.properties.
 *
 * The working directory is usually the build root, but an agent or a shell is
 * just as often sitting in a module inside it. Five levels covers that without
 * letting a build that has no local.properties at all walk to the top of the
 * disk looking for one.
 */
const LOCAL_PROPERTIES_LEVELS = 5;

/**
 * A .properties file, read the way java.util.Properties reads it.
 *
 * local.properties is written by Android Studio, and on Windows what it writes
 * is `sdk.dir=C\:\\Users\\james\\AppData\\Local\\Android\\Sdk`. Splitting on
 * the first `=` and keeping the rest verbatim yields a path with an escaped
 * colon and doubled separators that no filesystem call will accept, so the
 * escapes have to come off. The rules honoured here are Java's, because Java's
 * are what wrote the file and what the Gradle plugin reads it back with: `#`
 * and `!` comment out a whole line and nothing else — a `#` partway through a
 * value belongs to the value — `=`, `:` or whitespace ends the key, and a line
 * ending in an odd number of backslashes continues onto the next.
 */
export function parseProperties(text: string): Map<string, string> {
  const properties = new Map<string, string>();
  const lines = text.split(/\r\n|\n|\r/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^[ \t\f]+/, "");
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;

    while (trailingBackslashes(line) % 2 === 1 && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].replace(/^[ \t\f]+/, "");
    }

    // The key runs to the first separator that is not itself escaped.
    let end = 0;
    while (end < line.length) {
      const character = line[end];
      if (character === "\\") {
        end += 2;
        continue;
      }
      if ("=: \t\f".includes(character)) break;
      end++;
    }

    let value = line.slice(end).replace(/^[ \t\f]*/, "");
    if (value.startsWith("=") || value.startsWith(":")) {
      value = value.slice(1).replace(/^[ \t\f]*/, "");
    }
    properties.set(unescape(line.slice(0, end)), unescape(value));
  }
  return properties;
}

function trailingBackslashes(line: string): number {
  let count = 0;
  while (count < line.length && line[line.length - 1 - count] === "\\") count++;
  return count;
}

function unescape(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      out += raw[i];
      continue;
    }
    const escaped = raw[++i];
    if (escaped === undefined) break;
    if (escaped === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
      continue;
    }
    // Java drops the backslash before anything it does not recognise, which is
    // what turns `C\:\\Users` back into `C:\Users`.
    out += { t: "\t", n: "\n", r: "\r", f: "\f" }[escaped] ?? escaped;
  }
  return out;
}

/** `sdk.dir` from the nearest local.properties at or above `from`. */
function sdkDirFromLocalProperties(from: string): string | null {
  let directory = path.resolve(from);
  for (let level = 0; level <= LOCAL_PROPERTIES_LEVELS; level++) {
    const file = path.join(directory, "local.properties");
    try {
      if (existsSync(file)) {
        // A local.properties with no sdk.dir in it is not an answer, so the
        // walk continues past it rather than stopping at the first file found.
        const value = parseProperties(readFileSync(file, "utf8")).get("sdk.dir");
        if (value && value.trim()) return value.trim();
      }
    } catch {
      // Unreadable is the same as absent: the environment is next, and a
      // permissions problem on someone's parent directory is not adb's fault.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break; // The root of the filesystem is its own parent.
    directory = parent;
  }
  return null;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The Android SDK, in the order a developer would look for it.
 *
 * The order is deliberately the Gradle plugin's — `sdkDirectory` in
 * PortholePlugin.kt — and the two agreeing is the whole point of it. sdk.dir is
 * what Android Studio writes into local.properties, and on a stock install it
 * is the only one of these three that is set: neither environment variable
 * exists, and platform-tools is not on PATH, least of all on Windows. Reading
 * only the environment is why `system_context` used to tell the user to go fix
 * something that `./gradlew portholeConnect`, on the same machine and the same
 * SDK, had no trouble with.
 *
 * Once local.properties names a directory, that is the answer even if adb
 * turns out not to be beneath it. The plugin stops there too, and one tool
 * quietly falling through to a different SDK than the other is the exact split
 * personality this replaced.
 */
function sdkRoot(): string | null {
  const declared = sdkDirFromLocalProperties(process.cwd());
  if (declared) return declared;

  for (const variable of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const root = process.env[variable];
    if (root && isDirectory(root)) return root;
  }
  return null;
}

/** adb, from the SDK if one can be found, and otherwise left to the PATH. */
export function findAdb(): string {
  const binary = process.platform === "win32" ? "adb.exe" : "adb";
  const root = sdkRoot();
  if (!root) return binary;
  const candidate = path.join(root, "platform-tools", binary);
  return existsSync(candidate) ? candidate : binary;
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
