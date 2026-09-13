// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * cli.ts is the CLI entry point, not a library module: it has no
 * `if (require.main === module)` guard, so importing it runs its top-level
 * dispatch against process.argv immediately — that's fine when it's invoked
 * as `node dist/cli.js ...`, but importing it here to reach the exported
 * parsePort would otherwise try to open a device connection, start a server,
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

const { parse, parsePort } = await import("./cli.js");

process.argv = originalArgv;
exitDuringImport.mockRestore();
stdoutDuringImport.mockRestore();

describe("parsePort", () => {
  it("names the option when the value is missing", () => {
    // porthole ui --port with nothing after it: argv[++i] is undefined.
    expect(parsePort(undefined, "--port")).toEqual({
      message: "--port needs a port number",
    });
  });

  it("names --ui-port too, not just --port", () => {
    expect(parsePort(undefined, "--ui-port")).toEqual({
      message: "--ui-port needs a port number",
    });
  });

  it("rejects a non-numeric value", () => {
    expect(parsePort("abc", "--port")).toEqual({
      message: '--port "abc" is not a number',
    });
  });

  it("rejects a negative port", () => {
    expect(parsePort("-1", "--port")).toEqual({
      message: "--port -1 is out of range (must be 1024-65535)",
    });
  });

  it("rejects a port above 65535", () => {
    expect(parsePort("70000", "--port")).toEqual({
      message: "--port 70000 is out of range (must be 1024-65535)",
    });
  });

  it("rejects a fractional port", () => {
    // QA bait: 8677.5 is finite and Number() happily parses it, but it is
    // not a port a socket can listen on.
    expect(parsePort("8677.5", "--port")).toEqual({
      message: "--port 8677.5 must be a whole number",
    });
  });

  it("rejects the default's neighbor just under the privileged boundary", () => {
    expect(parsePort("1023", "--port")).toEqual({
      message: "--port 1023 is out of range (must be 1024-65535)",
    });
  });

  it("accepts the documented default", () => {
    expect(parsePort("8677", "--port")).toBe(8677);
  });

  it("accepts both range boundaries", () => {
    expect(parsePort("1024", "--port")).toBe(1024);
    expect(parsePort("65535", "--port")).toBe(65535);
  });

  it("treats an empty value as missing, not as an out-of-range number", () => {
    // "" used to reach Number("") === 0 and report "out of range"; an empty
    // value is a missing value, not a number at all.
    expect(parsePort("", "--port")).toEqual({
      message: "--port needs a port number",
    });
  });

  it("rejects whitespace padding that Number() would silently trim", () => {
    expect(parsePort(" 8677 ", "--port")).toEqual({
      message: '--port " 8677 " is not a number',
    });
  });

  it("rejects scientific notation", () => {
    expect(parsePort("1e4", "--port")).toEqual({
      message: '--port "1e4" is not a number',
    });
  });

  it("rejects hex", () => {
    expect(parsePort("0x2000", "--port")).toEqual({
      message: '--port "0x2000" is not a number',
    });
  });
});

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
});
