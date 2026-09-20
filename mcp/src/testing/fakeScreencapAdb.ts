// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A fake `adb` whose `exec-out screencap -p` writes a fixed PNG's raw bytes
 * to stdout — shared by `screenshot.test.ts` and `surface.test.ts`
 * (GRA-63).
 *
 * Not `testing/fakeAdb.ts` (GRA-62): that one's dispatcher writes *text*
 * responses that a test reads back as UTF-8 — exactly the corruption
 * `screenshot.ts`'s `captureRawScreenshot` exists to avoid for binary PNG
 * bytes. This writes a file's bytes to stdout untouched, and nothing else.
 *
 * Same wrapper-script technique as `fakeAdb.ts` for the same reason: a
 * `#!/bin/sh` (or, on Windows, `.cmd`) one-liner that `exec`s the real node
 * binary with an explicit script path, so a leading `-s SERIAL` in the
 * spawned args is never mistaken for node's own CLI flag.
 */
export interface FakeScreencapAdb {
  binaryPath: string;
  env: NodeJS.ProcessEnv;
  /** Every invocation's args, oldest first — proves `-s`/`-d` are actually sent. */
  calls(): string[][];
  cleanup(): void;
}

export function buildFakeScreencapAdb(
  pngBytes: Buffer,
  options: { exitCode?: number; stderr?: string } = {},
): FakeScreencapAdb {
  const root = mkdtempSync(path.join(tmpdir(), "porthole-fake-screencap-"));
  const pngPath = path.join(root, "capture.png");
  writeFileSync(pngPath, pngBytes);
  const callLogPath = path.join(root, "calls.log");
  writeFileSync(callLogPath, "");

  const scriptPath = path.join(root, "fake-screencap.cjs");
  writeFileSync(
    scriptPath,
    `
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PORTHOLE_TEST_SCREENCAP_CALLS, JSON.stringify(args) + "\\n");
const exitCode = Number(process.env.PORTHOLE_TEST_SCREENCAP_EXIT || "0");
const stderrMsg = process.env.PORTHOLE_TEST_SCREENCAP_STDERR || "";
if (stderrMsg) process.stderr.write(stderrMsg);
if (exitCode !== 0) process.exit(exitCode);
// A large write to a pipe (a real, uncompressed screenshot is megabytes)
// can exceed the OS pipe buffer, so process.exit() right after write()
// risks exiting before the write actually drains and truncating what the
// parent receives — waiting for write()'s own callback is what makes this
// reliable at real screenshot sizes, not only at tiny fixtures.
process.stdout.write(fs.readFileSync(process.env.PORTHOLE_TEST_SCREENCAP_PNG), () => process.exit(0));
`,
  );

  const isWindows = process.platform === "win32";
  const binaryPath = path.join(root, isWindows ? "adb.cmd" : "adb");
  if (isWindows) {
    writeFileSync(binaryPath, `@"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    writeFileSync(binaryPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
    chmodSync(binaryPath, 0o755);
  }

  return {
    binaryPath,
    env: {
      ...process.env,
      PORTHOLE_TEST_SCREENCAP_PNG: pngPath,
      PORTHOLE_TEST_SCREENCAP_EXIT: String(options.exitCode ?? 0),
      PORTHOLE_TEST_SCREENCAP_STDERR: options.stderr ?? "",
      PORTHOLE_TEST_SCREENCAP_CALLS: callLogPath,
    },
    calls() {
      return readFileSync(callLogPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    },
    cleanup() {
      // See testing/fakeAdb.ts's own comment: Windows can refuse to unlink
      // a just-exited executable for a moment.
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
