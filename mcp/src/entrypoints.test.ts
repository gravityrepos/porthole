// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DeviceClient } from "./device.js";
import { createPortholeServer } from "./index.js";
import { connect } from "./testing/harness.js";
import { TimelineServer } from "./timeline.js";

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
 *
 * GRA-176: the check above proves the two built entry points agree with
 * EACH OTHER, which a stale `dist/` — built once, before a tool was renamed
 * in `src/` — would also satisfy: both `dist/index.js` and `dist/cli.js`
 * come from that same stale build, so they always agree with each other
 * regardless of whether either still matches current source. The
 * `beforeAll` below already rebuilds `dist/` unconditionally before every
 * run (confirmed by measurement: deleting `dist/` first and renaming a tool
 * with no separate `npm run build` step both still leave this describe
 * block green, because the rebuild happens internally either way) — so
 * today staleness cannot occur *through this file*. What was still missing
 * was a check that does not rely on that rebuild happening at all: nothing
 * here compared either built artifact against source truth directly, so if
 * a future edit ever weakened or removed the `beforeAll` rebuild (a
 * plausible "optimisation" — rebuilding on every single test run is not
 * free), this file would go back to being blind to it, silently, exactly
 * like GRA-157's empty ring and the GRA-164 checkers before it.
 * `sourceToolNames()` below is that independent third reference: an
 * in-process server built straight from `src/index.ts` by vitest's own TS
 * transform, never through `dist/` and never through either subprocess, so
 * it cannot itself be behind a rename that has not been rebuilt. Comparing
 * a spawned entry point against it is a structural "does dist/ match
 * source" check, not a timestamp heuristic — there is no second
 * hand-maintained number here, just the tool names `index.ts` currently
 * declares.
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

  /** Sorted tool names, shared by every test below that compares two tool lists. */
  const namesOf = (tools: Array<{ name: string }>) => tools.map((t) => t.name).sort();

  /**
   * GRA-176: the tool set `src/index.ts` registers right now, gathered
   * without touching `dist/` or spawning anything — `createPortholeServer`
   * is the same TypeScript source both built entry points wrap, imported
   * directly and transformed on the fly by vitest, so this list is current
   * by construction and can never itself be "the stale side" of a
   * comparison. `device`/`timeline` are constructed exactly as
   * `testing/harness.ts`'s own `buildRig()` constructs them for the same
   * reason — real objects, but never started or connected, so this opens no
   * socket and binds no port (`DeviceClient.start()` and whatever binds
   * `TimelineServer`'s HTTP/WebSocket listener are never called).
   */
  async function sourceToolNames(): Promise<string[]> {
    const device = new DeviceClient("127.0.0.1", 0);
    const timeline = new TimelineServer(device, 0);
    const { server } = createPortholeServer({ device, timeline, version: "0.0.0-test" });
    const client = await connect(server);
    try {
      return namesOf(await client.listTools());
    } finally {
      await client.close();
    }
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

    expect(namesOf(fromIndex)).toEqual(namesOf(fromCli));
    expect(fromIndex.length).toBeGreaterThan(0);

    // Not just the same names: the same schemas, so a future change that
    // boots the CLI through some other path (say, a slimmed-down server
    // instance) can't drift silently from what `node dist/index.js` serves.
    const byName = (tools: Array<{ name: string; inputSchema: unknown }>) =>
      Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
    expect(byName(fromCli)).toEqual(byName(fromIndex));
  }, 20_000);

  // GRA-176: see the module docstring above for why the test just above this
  // one cannot catch a stale dist/ — both spawned entry points come from the
  // same build, so they always agree with each other whether or not that
  // build still matches src/index.ts. This compares one of them against an
  // in-process server built straight from source instead.
  it("node dist/index.js's tool set matches src/index.ts's, not just dist/cli.js's", async () => {
    const [fromIndex, fromSource] = await Promise.all([
      bootAndListTools([DIST_INDEX]).then(namesOf),
      sourceToolNames(),
    ]);
    expect(fromIndex).toEqual(fromSource);
  }, 20_000);
});
