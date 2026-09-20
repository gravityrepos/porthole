// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A controllable stand-in for `adb`, shared by `devices.test.ts` and
 * `surface.test.ts` (GRA-62/GRA-63).
 *
 * `index.test.ts`'s own `setupFakeAdb` (GRA-89/GRA-186) hard-links the real,
 * running `node` binary and points `NODE_OPTIONS=--require=...` at a
 * preload, so spawning it is a real OS process rather than a hand-rolled
 * fake. That trick does not survive an `-s SERIAL` prefix: with the hard
 * link itself as the "script", node parses the *spawned* argv as its own
 * CLI flags before the `--require` preload ever runs, and `-s` is not one
 * node recognises — `adb -s A1 forward ...` fails immediately with `bad
 * option: -s`, never reaching the preload at all. GRA-62's calls always
 * carry `-s SERIAL` (`ensureForward`, `checkInstalledApp`, every real
 * `adb -s ... shell ...`), so this uses a tiny wrapper script instead — a
 * `#!/bin/sh` one-liner on POSIX, a `.cmd` one-liner on Windows — that
 * `exec`s the real node binary with an *explicit* script path ahead of the
 * adb-style args. node then treats that path as its module unconditionally,
 * whatever the following arguments look like, and the wrapper script is
 * what a spawned `"adb"` actually is on disk, still a real process either way.
 *
 * Every response is configured through environment variables rather than a
 * fixed dispatcher, so a test only has to say what it wants, not extend a
 * shared if/else chain. `responses` maps a canonical, `-s SERIAL`-stripped
 * argv (joined by [fakeAdbArgsKey]) to a fixed `{stdout, stderr, exitCode}`.
 */

export interface FakeAdbResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface FakeAdb {
  /** Pass as `adbBinary` to `buildRig`/`createPortholeServer`. */
  binaryPath: string;
  /** Pass as `adbEnv` — carries the response table and the call log path to the child process. */
  env: NodeJS.ProcessEnv;
  /** Every invocation's args, oldest first, normalised the same way `responses` is keyed — so a test can assert not just the outcome but that the right command ran, and in what order. */
  calls(): string[][];
  cleanup(): void;
}

/** `-s SERIAL` (if present) stripped, then the remaining args joined — the same key both the dispatch script and a test's `responses` map use, so neither can drift from the other by hand. */
export function fakeAdbArgsKey(args: string[]): string {
  const a = args[0] === "-s" ? args.slice(2) : args;
  return a.join("");
}

const FAKE_ADB_SCRIPT_SOURCE = `
const fs = require("fs");

const args = process.argv.slice(2);

const callLogPath = process.env.PORTHOLE_TEST_FAKE_ADB_CALLS;
if (callLogPath) fs.appendFileSync(callLogPath, JSON.stringify(args) + "\\n");

const key = (args[0] === "-s" ? args.slice(2) : args).join("\\u0001");
const responses = JSON.parse(process.env.PORTHOLE_TEST_FAKE_ADB_RESPONSES || "{}");
const response = responses[key];

if (!response) {
  process.stderr.write("fake-adb: no configured response for " + JSON.stringify(args) + "\\n");
  process.exit(17);
}
if (response.stdout) process.stdout.write(response.stdout);
if (response.stderr) process.stderr.write(response.stderr);
process.exit(response.exitCode || 0);
`;

/**
 * `responses` is a plain object keyed by [fakeAdbArgsKey] — build the key
 * with that function (e.g. `fakeAdbArgsKey(["devices", "-l"])`) rather than
 * typing its separator by hand.
 */
export function buildFakeAdb(responses: Record<string, FakeAdbResponse>): FakeAdb {
  const root = mkdtempSync(path.join(tmpdir(), "porthole-fakeadb-"));
  const scriptPath = path.join(root, "fake-adb-script.cjs");
  writeFileSync(scriptPath, FAKE_ADB_SCRIPT_SOURCE);

  const isWindows = process.platform === "win32";
  const binaryPath = path.join(root, isWindows ? "adb.cmd" : "adb");
  if (isWindows) {
    // `%*` forwards every argument verbatim, `-s` included — a batch file
    // never tries to interpret its own arguments as flags the way spawning
    // node directly does.
    writeFileSync(binaryPath, `@"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    writeFileSync(binaryPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
    chmodSync(binaryPath, 0o755);
  }

  const callLogPath = path.join(root, "calls.log");
  writeFileSync(callLogPath, "");

  return {
    binaryPath,
    env: {
      ...process.env,
      PORTHOLE_TEST_FAKE_ADB_RESPONSES: JSON.stringify(responses),
      PORTHOLE_TEST_FAKE_ADB_CALLS: callLogPath,
    },
    calls() {
      return readFileSync(callLogPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    },
    cleanup() {
      // See index.test.ts's setupFakeAdb: Windows can refuse to unlink a
      // just-exited executable for a moment.
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
