// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { buildRig } from "./testing/harness.js";

/**
 * GRA-228: the runtime's `setup` report — which integration is
 * instrumented, which is only on the classpath, and (GRA-59) the
 * `socket`/`strictmode` entries alongside them — used to be reachable only
 * through the timeline UI's `GET /api/setup` or the raw socket. These
 * tests prove the new `setup` MCP tool surfaces the identical data, and
 * that `porthole_status` points at it whenever an integration looks
 * present but unwired.
 */

interface SetupEntry {
  name: string;
  onClasspath: boolean;
  instrumented: boolean;
  hint?: string | null;
}

describe("the setup MCP tool", () => {
  const fixture: SetupEntry[] = [
    { name: "socket", onClasspath: true, instrumented: true, hint: null },
    {
      name: "strictmode",
      onClasspath: true,
      instrumented: false,
      hint: "off by default; enable with porthole { strictMode.set(true) } in the app module",
    },
    { name: "okhttp", onClasspath: true, instrumented: false, hint: "add installPorthole() to your OkHttpClient.Builder" },
    { name: "navigation", onClasspath: true, instrumented: true, hint: null },
  ];

  it("returns every entry the runtime reported, unmodified — including strictmode and its hint", async () => {
    const rig = await buildRig({ handlers: { setup: () => fixture } });
    try {
      const result = await rig.client.callTool("setup", {});
      expect(result.isError).toBeFalsy();
      const json = result.json as { entries: SetupEntry[] };
      // Mutation this catches: filtering the entries down to only the
      // ones with something to say (dropping `socket`, or a wired,
      // hint-less entry) would still pass every other assertion in this
      // file — only this one reads `entries` for the full set.
      expect(json.entries).toEqual(fixture);
      const strictmode = json.entries.find((e) => e.name === "strictmode");
      expect(strictmode?.hint).toContain("strictMode.set(true)");
    } finally {
      await rig.close();
    }
  });

  it("says which integrations are present but unwired", async () => {
    const rig = await buildRig({ handlers: { setup: () => fixture } });
    try {
      const result = await rig.client.callTool("setup", {});
      expect(result.text).toContain("okhttp");
      expect(result.text).toContain("present but unwired");
    } finally {
      await rig.close();
    }
  });

  it("says everything present is wired when nothing is unwired", async () => {
    const wiredFixture: SetupEntry[] = [{ name: "okhttp", onClasspath: true, instrumented: true, hint: null }];
    const rig = await buildRig({ handlers: { setup: () => wiredFixture } });
    try {
      const result = await rig.client.callTool("setup", {});
      // Mutation this catches: a summary that only ever describes gaps (or
      // that reports "nothing on the classpath" whenever the unwired list
      // is empty) makes a fully-wired project read the same as one with no
      // integrations at all.
      expect(result.text).toBe("Everything present is wired.");
    } finally {
      await rig.close();
    }
  });

  it("fails cleanly, through fail(), when the device's setup RPC itself errors", async () => {
    const rig = await buildRig({
      handlers: {
        setup: () => {
          throw new Error("device went away mid-request");
        },
      },
    });
    try {
      const result = await rig.client.callTool("setup", {});
      expect(result.isError).toBe(true);
      expect(result.text).toContain("device went away mid-request");
    } finally {
      await rig.close();
    }
  });
});

describe("porthole_status names setup (GRA-228)", () => {
  it("points at `setup` when an integration is present but unwired", async () => {
    const rig = await buildRig({
      handlers: {
        setup: () => [
          { name: "okhttp", onClasspath: true, instrumented: false, hint: "add installPorthole() to your OkHttpClient.Builder" },
        ],
      },
    });
    try {
      const result = await rig.client.callTool("porthole_status", {});
      // Mutation this catches: dropping the `setupNote` concatenation (or
      // gating it on the wrong `pending`/mismatch condition) leaves
      // `porthole_status`'s summary silent about a real gap — the exact
      // failure GRA-228 exists to close, since it is the first tool most
      // agents call.
      expect(result.text).toContain("present but unwired");
      expect(result.text).toContain("okhttp");
      expect(result.text).toContain("call `setup`");
    } finally {
      await rig.close();
    }
  });

  it("stays quiet about setup when nothing is unwired", async () => {
    const rig = await buildRig({
      handlers: {
        setup: () => [{ name: "okhttp", onClasspath: true, instrumented: true, hint: null }],
      },
    });
    try {
      const result = await rig.client.callTool("porthole_status", {});
      expect(result.text).not.toContain("present but unwired");
    } finally {
      await rig.close();
    }
  });

  it("does not fail, or say anything about it, when the setup RPC itself errors", async () => {
    const rig = await buildRig({
      handlers: {
        setup: () => {
          throw new Error("boom");
        },
      },
    });
    try {
      const result = await rig.client.callTool("porthole_status", {});
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("Connected to");
      expect(result.text).not.toContain("boom");
    } finally {
      await rig.close();
    }
  });
});
