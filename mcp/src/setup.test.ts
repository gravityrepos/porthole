// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SNIPPETS, buildSetupReport, type SetupEntry } from "./setup.js";
import { buildRig } from "./testing/harness.js";

/**
 * GRA-228/GRA-65: `setup.ts` carries the ranking and snippet logic behind
 * the `setup` MCP tool; this file is the "does the pure function do the
 * right thing with a fixture payload" half of the ticket's rig-test
 * requirement, and the tool-surface half lives in the `describe("the setup
 * MCP tool"` / `describe("porthole_status names setup"` blocks below,
 * which drive the real tool through `buildRig()`.
 */

function entry(over: Partial<SetupEntry> & { name: string }): SetupEntry {
  return { onClasspath: true, instrumented: false, hint: null, ...over };
}

describe("buildSetupReport", () => {
  it("passes every entry through untouched, socket and strictmode included (GRA-228 AC: 'every entry the UI's setup panel shows')", () => {
    const raw: SetupEntry[] = [
      entry({ name: "socket", instrumented: true, hint: null }),
      entry({ name: "strictmode", instrumented: false, hint: "off by default; enable with porthole { strictMode.set(true) }" }),
      entry({ name: "okhttp", instrumented: true }),
    ];
    // Mutation this catches: filtering `entries` down to only the names
    // this module knows how to rank (dropping `socket`/`strictmode`) would
    // still pass every other test below, since none of them read `entries`
    // for those two names — only this one does, on purpose.
    expect(buildSetupReport(raw).entries).toEqual(raw);
  });

  it("never ranks strictmode or socket as a gap — they have no builder line to add", () => {
    const raw: SetupEntry[] = [
      entry({ name: "socket", instrumented: true }),
      entry({ name: "strictmode", instrumented: false, hint: "off by default" }),
    ];
    const { gaps } = buildSetupReport(raw);
    // Mutation this catches: a gap filter that reads only `!instrumented`
    // (forgetting the `name in UNLOCKS` guard) would put strictmode here.
    expect(gaps).toEqual([]);
  });

  it("ranks the gap that leaves the most dark first (GRA-65 AC1)", () => {
    // navigation unlocks 1 lane + 1 tool (impact 2); okhttp unlocks 1 lane
    // + 2 tools, `inflight` and `blocking` (impact 3) — see setup.ts's own
    // UNLOCKS doc comment for why `blocking` counts too (README: "HTTP is
    // checked in the interceptor, not the event listener").
    const raw: SetupEntry[] = [
      entry({ name: "navigation", hint: "call Porthole.registerNavController(navController)" }),
      entry({ name: "okhttp", hint: "add installPorthole() to your OkHttpClient.Builder" }),
    ];
    const { gaps } = buildSetupReport(raw);
    // Mutation this catches: `impact()` returning only `unlock.lanes.length`
    // (dropping `tools.length`) ties every integration at 1 and this
    // ordering becomes whatever `entries` happened to be passed in — here
    // navigation-then-okhttp, the opposite of what this test pins.
    expect(gaps.map((g) => g.name)).toEqual(["okhttp", "navigation"]);
  });

  it("breaks a tie between equal-impact gaps by keeping their given order", () => {
    // okhttp and ktor share the same UNLOCKS entry (impact 3 each) — a
    // real tie, not one this module could break by data alone.
    const raw: SetupEntry[] = [entry({ name: "ktor" }), entry({ name: "okhttp" })];
    const { gaps } = buildSetupReport(raw);
    // Mutation this catches: a non-stable or reversed comparator
    // (`impact(a) - impact(b)` instead of `impact(b) - impact(a)`, or a
    // sort with no tie-break at all) could silently swap this pair.
    expect(gaps.map((g) => g.name)).toEqual(["ktor", "okhttp"]);
  });

  it("gives the exact snippet, lanes and tools for a present-but-unwired integration", () => {
    const raw: SetupEntry[] = [
      entry({ name: "okhttp", hint: "add installPorthole() to your OkHttpClient.Builder" }),
    ];
    const [gap] = buildSetupReport(raw).gaps;
    expect(gap.add).toBe(SNIPPETS.okhttp);
    expect(gap.lanes).toEqual(["http"]);
    expect(gap.tools).toEqual(["inflight", "blocking"]);
    expect(gap.hint).toBe("add installPorthole() to your OkHttpClient.Builder");
    // Mutation this catches: a sentence builder that drops either the lane
    // or the tool list would still leave `gap.lanes`/`gap.tools` correct
    // but silently under-report in the prose an agent actually reads.
    expect(gap.sentence).toContain("http lane");
    expect(gap.sentence).toContain("`inflight`");
    expect(gap.sentence).toContain("`blocking`");
  });

  it("does not report a gap for an integration that is not on the classpath at all", () => {
    // Room absent entirely (no database in the app) must never be told
    // "add installPorthole() to your Room databaseBuilder" — the runtime
    // itself already guards this (`Setup.kt`'s `hint = if (present &&
    // !wired) ...`), but this module must not defeat that guard by
    // ranking on `!instrumented` alone.
    const raw: SetupEntry[] = [entry({ name: "room", onClasspath: false, instrumented: false, hint: null })];
    expect(buildSetupReport(raw).gaps).toEqual([]);
  });

  it("says a fully-instrumented project is fully instrumented, explicitly", () => {
    const raw: SetupEntry[] = [
      entry({ name: "okhttp", instrumented: true }),
      entry({ name: "navigation", instrumented: true }),
    ];
    const report = buildSetupReport(raw);
    expect(report.gaps).toEqual([]);
    expect(report.wired.sort()).toEqual(["navigation", "okhttp"]);
    // Mutation this catches: a summary that only ever describes gaps (or
    // defaults to the "nothing on the classpath" sentence when `gaps` is
    // empty) reports a fully-wired project the same as an app with no
    // integrations at all — the exact ambiguity GRA-65's AC exists to kill.
    expect(report.summary).toContain("Everything present is wired");
    expect(report.summary).toContain("okhttp");
    expect(report.summary).toContain("navigation");
  });

  it("says so when nothing instrumentable is even on the classpath", () => {
    const raw: SetupEntry[] = [entry({ name: "okhttp", onClasspath: false, instrumented: false })];
    const report = buildSetupReport(raw);
    expect(report.gaps).toEqual([]);
    expect(report.wired).toEqual([]);
    expect(report.summary).not.toContain("Everything present is wired");
    expect(report.summary).toContain("classpath");
  });

  it("leads the summary with the top-ranked gap and still counts the rest", () => {
    const raw: SetupEntry[] = [
      entry({ name: "navigation" }),
      entry({ name: "okhttp" }),
      entry({ name: "room", instrumented: true }),
    ];
    const report = buildSetupReport(raw);
    expect(report.summary.startsWith("Nothing is instrumented on OkHttp")).toBe(true);
    expect(report.summary).toContain("1 more present but unwired: Navigation");
    expect(report.summary).toContain("Already wired: room");
  });
});

describe("SNIPPETS stay in sync with README.md (GRA-65 EM: 'keep in sync by test where possible')", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const normalizedReadme = normalize(readme);

  // GRA-228 QA (S2): the loop below generates its own test cases from
  // `Object.entries(SNIPPETS)`, so an emptied SNIPPETS silently generates
  // zero tests — a green suite with nothing actually checked — and an
  // empty-string snippet passes `toContain("")` trivially, since every
  // string contains the empty string. Neither failure mode shows up as a
  // red test; this one pins the shape the loop depends on, outside the
  // loop, so removing an entry (or emptying its snippet) fails here even
  // when the generated per-entry test it would have produced is simply
  // gone rather than failing.
  it("covers all five integrations, each with a real, non-empty snippet", () => {
    expect(Object.keys(SNIPPETS)).toHaveLength(5);
    for (const [name, snippet] of Object.entries(SNIPPETS)) {
      expect(snippet.trim().length, `${name}'s snippet must not be empty`).toBeGreaterThan(0);
    }
  });

  for (const [name, snippet] of Object.entries(SNIPPETS)) {
    it(`${name}'s snippet is the line README.md actually documents`, () => {
      // Mutation this catches: hand-editing a SNIPPETS entry (or
      // README.md's own code block) so the two drift — this fails the
      // moment either side changes without the other, rather than only
      // when someone remembers to check by eye.
      expect(normalizedReadme).toContain(normalize(snippet));
    });
  }
});

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

  it("returns the runtime's own entries plus the ranked gaps and snippet, through a real MCP call", async () => {
    const rig = await buildRig({ handlers: { setup: () => fixture } });
    try {
      const result = await rig.client.callTool("setup", {});
      expect(result.isError).toBeFalsy();
      const json = result.json as { entries: SetupEntry[]; gaps: Array<{ name: string; add: string }> };
      // Mutation this catches: registering the tool with `call()`'s generic
      // augment (which requires the augmented value to keep the raw `T`
      // shape) would either fail to compile or silently hand back the bare
      // array instead of `{ entries, gaps, wired, summary }` — this proves
      // the payload is the richer shape, not just the passthrough.
      expect(json.entries).toEqual(fixture);
      expect(json.gaps).toHaveLength(1);
      expect(json.gaps[0]).toMatchObject({ name: "okhttp", add: SNIPPETS.okhttp });
      expect(result.text).toContain("OkHttp");
    } finally {
      await rig.close();
    }
  });

  it("says everything present is wired when the fixture has no gaps", async () => {
    const wiredFixture: SetupEntry[] = [{ name: "okhttp", onClasspath: true, instrumented: true, hint: null }];
    const rig = await buildRig({ handlers: { setup: () => wiredFixture } });
    try {
      const result = await rig.client.callTool("setup", {});
      expect(result.text).toContain("Everything present is wired");
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
      expect(result.text).toContain("OkHttp");
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
