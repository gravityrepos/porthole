// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * cli.ts is the CLI entry point, not a library module: it has no
 * `if (require.main === module)` guard, so importing it runs its top-level
 * dispatch against process.argv immediately — that's fine when it's invoked
 * as `node dist/cli.js ...`, but importing it here to reach the exported
 * parse would otherwise try to open a device connection, start a server,
 * or call process.exit on the test runner itself, depending on whatever the
 * real argv happens to be. So argv and process.exit are faked out for
 * exactly as long as the import takes: no command means the module's own
 * dispatch falls into its harmless "print usage, exit 0" branch, not one of
 * the branches that starts touching adb or a socket.
 */
const originalArgv = process.argv;
process.argv = ["node", "cli.js"];
const exitDuringImport = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
const stdoutDuringImport = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

const { parse } = await import("./cli.js");

process.argv = originalArgv;
exitDuringImport.mockRestore();
stdoutDuringImport.mockRestore();

// parsePort itself — the pure validator `parse()` calls — is tested once,
// in args.test.ts, alongside capture.ts's copy of the same suite. Testing it
// again here would only be testing the same imported function twice under a
// different file name.

/**
 * `parsePort` being correct in isolation proves nothing about `parse()`, the
 * loop that calls it: mutation testing found that deleting the
 * `process.exit(2)` branches in that loop did not turn a single test red,
 * because nothing exercised the loop itself, only the pure helper. These
 * drive `parse()` the way `porthole ui` actually would, and check that a
 * refusal from `parsePort` really does stop the program rather than being
 * quietly absorbed.
 */
describe("parse() wiring", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    exit.mockRestore();
    stderr.mockRestore();
  });

  function stderrText(): string {
    return stderr.mock.calls.map((call) => String(call[0])).join("");
  }

  it("exits 2 and names --port when the value is missing", () => {
    expect(() => parse(["--port"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--port needs a port number");
  });

  it("exits 2 for a --port value out of range", () => {
    expect(() => parse(["--port", "70000"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--port 70000 is out of range");
  });

  it("exits 2 and names --ui-port specifically, not --port", () => {
    expect(() => parse(["--ui-port"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--ui-port needs a port number");
  });

  it("accepts a valid --port without exiting", () => {
    const options = parse(["--port", "9000", "--no-forward", "--no-open"]);
    expect(options.port).toBe(9000);
    expect(exit).not.toHaveBeenCalled();
  });

  /**
   * GRA-124 scoped fix: --serial used to read `argv[++i]` raw. A missing
   * value was accepted silently, and `--serial --port 8677` swallowed
   * "--port" as the serial and left "8677" to be rejected next as a nonsense
   * option — blaming the wrong token. Routed through requiredValue now, same
   * as --port already was.
   */
  it("exits 2 when --serial has no value", () => {
    expect(() => parse(["--serial"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--serial needs a value");
  });

  it("exits 2 when --serial swallows the next flag instead of taking a value", () => {
    expect(() => parse(["--serial", "--port", "8677"])).toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrText()).toContain("--serial needs a value");
  });

  it("accepts a valid --serial without exiting", () => {
    const options = parse(["--serial", "emulator-5554", "--no-forward", "--no-open"]);
    expect(options.serial).toBe("emulator-5554");
    expect(exit).not.toHaveBeenCalled();
  });
});

/**
 * The ordering guarantee GRA-93's QA verified empirically: a refused argv
 * must never reach the device, not "usually doesn't", not "doesn't today".
 * `parseCapture` calling `process.exit(2)` when mocked (as in the wiring
 * tests above) only proves that one function's own scope stops — it says
 * nothing about *this file's* dispatch order, i.e. that cli.ts calls
 * parseCapture before it calls runAdb or capture(). A future edit that moved
 * runAdb above parseCapture would leave every mocked test above green, because
 * nothing here exercises the real top-level sequencing.
 *
 * So this runs the actual compiled CLI as a subprocess — the same thing a
 * user's shell does — with a malformed argument and a `-- <command>` that
 * writes a sentinel file.
 *
 * GRA-124's own QA found the first version of this test insufficient: it only
 * checked that the `-- <command>` never ran, which is strictly weaker than
 * "never reaches the device" (`capture()` runs the `-- <command>` well
 * downstream of `runAdb`, so hoisting `runAdb` above `parseCapture` left the
 * command-sentinel check green even though adb had already been contacted).
 * The fix is a second sentinel that fires on device contact itself: a fake
 * `adb` is put where `findAdb()` (adb.ts) will find it ahead of any real one,
 * and the refusal tests below assert that sentinel is absent too.
 */
describe("capture command: refused before device contact", () => {
  const mcpRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
  const distCli = path.join(mcpRoot, "dist", "cli.js");
  const tscBin = path.join(mcpRoot, "node_modules", "typescript", "bin", "tsc");

  // findAdb() prefers local.properties, then ANDROID_HOME/ANDROID_SDK_ROOT,
  // and only falls back to a bare "adb"/"adb.exe" resolved off PATH once
  // neither says anything — so pointing ANDROID_HOME at a directory shaped
  // like an SDK (a platform-tools/ subfolder holding the binary) wins
  // regardless of what a real Android SDK is doing on this machine, and
  // regardless of whether one is installed at all (CI has none).
  const adbSdkRoot = mkdtempSync(path.join(tmpdir(), "porthole-adb-sdk-"));
  const adbPlatformTools = path.join(adbSdkRoot, "platform-tools");
  const adbShimBinary = path.join(adbPlatformTools, process.platform === "win32" ? "adb.exe" : "adb");
  const adbShimInit = path.join(adbSdkRoot, "adb-shim-init.cjs");

  beforeAll(() => {
    // A real build, not the vitest-transformed source: dispatch order lives
    // in top-level script code that only runs the way a user's shell would
    // run it once it is compiled and invoked as `node dist/cli.js`.
    execFileSync(process.execPath, [tscBin, "-p", mcpRoot], { stdio: "pipe" });

    // The fake adb has to be something the OS can actually execute directly:
    // a hand-written .bat/.cmd will not do, because CreateProcess (what
    // spawnSync uses without a shell) needs a real PE/ELF/Mach-O image for a
    // file named *.exe — only a shell's own file-association logic knows
    // what to do with a script, and nothing here asks for a shell. node.exe
    // itself is a real binary already sitting on disk, so copying it under
    // the exact name findAdb() asks for and using NODE_OPTIONS to preload a
    // tiny script gets a script to run under adb's name for free: `--require`
    // preloads execute before Node treats the real adb argv ("forward",
    // "tcp:<port>", "tcp:<port>") as a script path it would otherwise fail to
    // find, so process.exit() in the preload short-circuits before that.
    mkdirSync(adbPlatformTools, { recursive: true });
    copyFileSync(process.execPath, adbShimBinary);
    if (process.platform !== "win32") chmodSync(adbShimBinary, 0o755);
    // NODE_OPTIONS is inherited by every node process in the tree below, not
    // just the fake adb — including the outer `node dist/cli.js` invocation
    // itself, and the user's `-- <command>` when that happens to be a node
    // invocation too (both cases below), since neither runAdb's spawnSync nor
    // capture.ts's run() overrides env. Without a guard, the preload would
    // fire on all of them and exit before they ever ran their real code.
    // runAdb always calls the binary with "forward" (or "-s" with a serial)
    // as its very first argument; Node resolves that positional to an
    // absolute path before a preload even runs, which is why this compares
    // basenames, not the raw value.
    writeFileSync(
      adbShimInit,
      'const path = require("path");\n' +
        "const arg0 = process.argv[1] ? path.basename(process.argv[1]) : undefined;\n" +
        'if (arg0 !== "forward" && arg0 !== "-s") return;\n' +
        'const fs = require("fs");\n' +
        "if (process.env.PORTHOLE_ADB_SENTINEL) {\n" +
        '  fs.writeFileSync(process.env.PORTHOLE_ADB_SENTINEL, "adb ran");\n' +
        "}\n" +
        "process.exit(0);\n",
    );
  }, 30_000);

  afterAll(() => {
    // adbShimBinary is a full copy of node.exe (tens of MB); leaving it in
    // the OS temp directory on every run would be a slow, silent leak.
    rmSync(adbSdkRoot, { recursive: true, force: true });
  });

  function sentinelPath(): string {
    return path.join(tmpdir(), `porthole-ordering-sentinel-${process.pid}-${Date.now()}.txt`);
  }

  function adbSentinelPath(): string {
    return path.join(
      tmpdir(),
      `porthole-adb-sentinel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
  }

  /**
   * Spawns the compiled CLI with the fake adb from `beforeAll` standing in
   * for the real one. `adbSentinel` is the file that fake adb writes to if
   * — and only if — it is actually invoked, which is the signal a test needs
   * to tell "refused before touching the device" from "refused, but only
   * after touching the device" (the latter is what survived as GRA-124's QA
   * mutation 4).
   */
  function spawnCliWithFakeAdb(args: string[], adbSentinel: string) {
    return spawnSync(process.execPath, [distCli, ...args], {
      env: {
        ...process.env,
        ANDROID_HOME: adbSdkRoot,
        ANDROID_SDK_ROOT: adbSdkRoot,
        // NODE_OPTIONS is parsed with shell-like quoting rules: a backslash
        // inside a quoted value is an escape character, which silently
        // eats every path separator in a Windows absolute path ("C:\Users\..."
        // becomes "C:Users..." and the require fails). Forward slashes resolve
        // identically on Windows and sidestep that without needing to think
        // about escaping at all.
        NODE_OPTIONS: `--require "${adbShimInit.replace(/\\/g, "/")}"`,
        PORTHOLE_ADB_SENTINEL: adbSentinel,
      },
    });
  }

  it("never runs the -- command or contacts adb when --port is malformed", () => {
    const commandSentinel = sentinelPath();
    const adbSentinel = adbSentinelPath();
    const result = spawnCliWithFakeAdb(
      [
        "capture",
        "--port",
        "not-a-port",
        "--",
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(commandSentinel)}, "ran")`,
      ],
      adbSentinel,
    );
    expect(result.status).toBe(2);
    expect(existsSync(commandSentinel)).toBe(false);
    // The property this test exists to pin: refused before the *device* is
    // touched, not merely before the user's `-- <command>` runs. Hoisting
    // runAdb above parseCapture in cli.ts's dispatch leaves the command
    // sentinel above absent too (capture() is never reached), but adb gets
    // contacted first — this assertion is the one that goes red for that.
    expect(existsSync(adbSentinel)).toBe(false);
  });

  it("never runs the -- command or contacts adb when --fail-on is a typo", () => {
    const commandSentinel = sentinelPath();
    const adbSentinel = adbSentinelPath();
    const result = spawnCliWithFakeAdb(
      [
        "capture",
        "--fail-on",
        "regresion",
        "--",
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(commandSentinel)}, "ran")`,
      ],
      adbSentinel,
    );
    expect(result.status).toBe(2);
    expect(existsSync(commandSentinel)).toBe(false);
    expect(existsSync(adbSentinel)).toBe(false);
  });

  it("sanity check: the harness itself does run the -- command once arguments validate", async () => {
    // Proves the sentinel technique can observe a "ran" outcome at all — a
    // harness that never runs anything would make the two refusal tests
    // above pass vacuously. device.ts sets state "connected" on the raw TCP
    // connect event, before the "hello" RPC round-trip even starts, so a
    // bare listener that never speaks the protocol is enough to get capture()
    // past awaitConnection and into running the -- command. --no-forward
    // skips adb entirely here, on purpose: this test is only about the
    // command sentinel, and the adb shim gets its own positive control next.
    const server = net.createServer((socket) => socket.on("error", () => {}));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    const sentinel = sentinelPath();
    const out = path.join(tmpdir(), `porthole-ordering-trace-${process.pid}-${Date.now()}.json`);
    try {
      const result = spawnSync(process.execPath, [
        distCli,
        "capture",
        "--port",
        String(port),
        "--no-forward",
        "--out",
        out,
        "--",
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(sentinel)}, "ran")`,
      ]);
      expect(existsSync(sentinel)).toBe(true);
      expect(result.status).not.toBe(2);
    } finally {
      server.close();
      if (existsSync(sentinel)) rmSync(sentinel);
      if (existsSync(out)) rmSync(out);
    }
  });

  it("positive control: a valid capture argv does reach adb, so the fake-adb shim is not a dead end", async () => {
    // Without this, the two "adb sentinel absent" assertions above could pass
    // vacuously — e.g. if the shim were never actually reachable through
    // ANDROID_HOME on this platform — and nobody would notice, because an
    // assertion that a file was never created looks identical whether the
    // mechanism is sound or simply never fires. --no-forward is deliberately
    // NOT passed: parseCapture leaves options.forward at its default of
    // true, so a successful parse reaches cli.ts's real runAdb call.
    const server = net.createServer((socket) => socket.on("error", () => {}));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    const commandSentinel = sentinelPath();
    const adbSentinel = adbSentinelPath();
    const out = path.join(tmpdir(), `porthole-adb-positive-trace-${process.pid}-${Date.now()}.json`);
    try {
      const result = spawnCliWithFakeAdb(
        [
          "capture",
          "--port",
          String(port),
          "--out",
          out,
          "--",
          process.execPath,
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(commandSentinel)}, "ran")`,
        ],
        adbSentinel,
      );
      expect(existsSync(adbSentinel)).toBe(true);
      expect(existsSync(commandSentinel)).toBe(true);
      expect(result.status).not.toBe(2);
    } finally {
      server.close();
      if (existsSync(adbSentinel)) rmSync(adbSentinel);
      if (existsSync(commandSentinel)) rmSync(commandSentinel);
      if (existsSync(out)) rmSync(out);
    }
  });
});
