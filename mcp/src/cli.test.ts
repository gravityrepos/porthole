// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

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

const { parsePort } = await import("./cli.js");

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
});
