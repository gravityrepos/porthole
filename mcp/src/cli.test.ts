// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
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
 * user's shell does — with a malformed --port and a `-- <command>` that
 * writes a sentinel file. `capture()` only runs that command after
 * successfully connecting to a device, which only happens after `parseCapture`
 * has already accepted the arguments. If the sentinel file exists afterward,
 * either argument validation didn't run first, or it didn't refuse — either
 * way, the property this test exists to pin is gone. This is the exact
 * technique GRA-93's QA used by hand; here it runs on every `npm test`.
 */
describe("capture command: refused before device contact", () => {
  const mcpRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
  const distCli = path.join(mcpRoot, "dist", "cli.js");
  const tscBin = path.join(mcpRoot, "node_modules", "typescript", "bin", "tsc");

  beforeAll(() => {
    // A real build, not the vitest-transformed source: dispatch order lives
    // in top-level script code that only runs the way a user's shell would
    // run it once it is compiled and invoked as `node dist/cli.js`.
    execFileSync(process.execPath, [tscBin, "-p", mcpRoot], { stdio: "pipe" });
  }, 30_000);

  function sentinelPath(): string {
    return path.join(tmpdir(), `porthole-ordering-sentinel-${process.pid}-${Date.now()}.txt`);
  }

  it("never runs the -- command when --port is malformed", () => {
    const sentinel = sentinelPath();
    const result = spawnSync(process.execPath, [
      distCli,
      "capture",
      "--port",
      "not-a-port",
      "--",
      process.execPath,
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(sentinel)}, "ran")`,
    ]);
    expect(result.status).toBe(2);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("never runs the -- command when --fail-on is a typo", () => {
    const sentinel = sentinelPath();
    const result = spawnSync(process.execPath, [
      distCli,
      "capture",
      "--fail-on",
      "regresion",
      "--",
      process.execPath,
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(sentinel)}, "ran")`,
    ]);
    expect(result.status).toBe(2);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("sanity check: the harness itself does run the -- command once arguments validate", async () => {
    // Proves the sentinel technique can observe a "ran" outcome at all — a
    // harness that never runs anything would make the two refusal tests
    // above pass vacuously. device.ts sets state "connected" on the raw TCP
    // connect event, before the "hello" RPC round-trip even starts, so a
    // bare listener that never speaks the protocol is enough to get capture()
    // past awaitConnection and into running the -- command.
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
});
