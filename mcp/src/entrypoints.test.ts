// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * QA FAILED GRA-90 on exactly the gap this file closes: every other test in
 * this suite calls tools against an in-process `McpServer` (`testing/harness.ts`)
 * or an in-memory transport, so none of them can see whether the *published
 * entry points* actually boot one. They didn't. `cli.ts`'s `mcp` command used
 * to be `await import("./index.js")` for the side effect of booting — on
 * `main` that worked because importing `index.ts` booted unconditionally, but
 * once the boot moved behind `isMainModule()` (comparing `process.argv[1]`
 * against `import.meta.url`), the CLI's import could never satisfy that
 * check: `argv[1]` is `dist/cli.js`, not `dist/index.js`. `porthole mcp`
 * exited 0 having registered nothing and connected no transport — a silent,
 * successful-looking death with nothing in stdout or stderr to diagnose. The
 * suite stayed green at 320 the whole time.
 *
 * This spawns both *built* entry points as real subprocesses, talks real
 * MCP-over-stdio to each (the actual `@modelcontextprotocol/sdk` client, not
 * a hand-rolled JSON-RPC scraper), and asserts both hand back the same
 * non-empty tool list. Nothing about a fake device or an in-memory transport
 * can catch a boot regression like this — only spawning the real thing can.
 */

const DIST_INDEX = "dist/index.js";
const DIST_CLI = "dist/cli.js";

describe("both built entry points boot the same MCP server", () => {
  beforeAll(() => {
    // Building here (rather than assuming CI or a prior `npm run build` left
    // a current `dist/`) is what makes this test trustworthy on its own: a
    // stale `dist/` from before the boot fix would pass for the wrong reason.
    // Invoked as `node <tsc's own JS entry point>` rather than through the
    // `npx`/`tsc` shell shim: a shim needs `shell: true` on Windows to run at
    // all, and shelling out to build the very entry points this file is
    // about to spawn is an extra layer of "trust the platform" this test
    // does not need.
    const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
    execFileSync(process.execPath, [tsc, "-p", "."], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
  }, 60_000);

  const clients: Client[] = [];

  afterEach(async () => {
    while (clients.length > 0) {
      const client = clients.pop();
      await client?.close().catch(() => {});
    }
  });

  /**
   * Spawns `command args` as the MCP server's own process (not this test
   * runner's) over real stdio, performs a real `initialize`, and returns the
   * connected client plus its `tools/list`. `StdioClientTransport` owns the
   * child process lifecycle, so closing the client also kills it.
   */
  async function bootAndListTools(
    args: string[],
  ): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args,
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "entrypoint-test-client", version: "0.0.0" });
    clients.push(client);
    await client.connect(transport);
    const result = await client.listTools();
    return result.tools;
  }

  it("node dist/index.js (porthole-mcp) answers initialize + tools/list with a real, non-empty tool set", async () => {
    const tools = await bootAndListTools([DIST_INDEX]);
    expect(tools.length).toBeGreaterThan(0);
  }, 15_000);

  it("node dist/cli.js mcp (porthole mcp) answers initialize + tools/list with a real, non-empty tool set", async () => {
    // This is the exact command QA's report showed timing out on this branch:
    // the CLI booting the server by calling `bootPortholeServer()` explicitly
    // rather than importing index.js for a side effect that no longer fires.
    const tools = await bootAndListTools([DIST_CLI, "mcp"]);
    expect(tools.length).toBeGreaterThan(0);
  }, 15_000);

  it("both entry points register the exact same tools", async () => {
    const [fromIndex, fromCli] = await Promise.all([
      bootAndListTools([DIST_INDEX]),
      bootAndListTools([DIST_CLI, "mcp"]),
    ]);

    const namesOf = (tools: Array<{ name: string }>) => tools.map((t) => t.name).sort();
    expect(namesOf(fromIndex)).toEqual(namesOf(fromCli));
    expect(fromIndex.length).toBeGreaterThan(0);

    // Not just the same names: the same schemas, so a future change that
    // boots the CLI through some other path (say, a slimmed-down server
    // instance) can't drift silently from what `node dist/index.js` serves.
    const byName = (tools: Array<{ name: string; inputSchema: unknown }>) =>
      Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
    expect(byName(fromCli)).toEqual(byName(fromIndex));
  }, 20_000);
});
