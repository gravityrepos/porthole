// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRig,
  buildRingInState,
  waitUntil,
  DEFAULT_STARTED_AT_MS,
  type Rig,
} from "./testing/harness.js";
import type { ConnectionState } from "./device.js";
import { resolveProjectRoot, resolveSdkDir } from "./adb.js";
import { joinSummaryAndPayload } from "./index.js";
import { resetSourceIndexForTests } from "./sources.js";
import { currentSourceFingerprint, resetComposeReportCacheForTests } from "./composeReport.js";

/**
 * Behavioural tests for the MCP surface.
 *
 * `surface.test.ts` reads `index.ts` as text and checks that certain
 * wording appears — which is the right tool for "does a description say
 * what an empty findings list does not mean", and the wrong tool for
 * "does a tool actually honour the window it was given". This file is for
 * the second kind: register the real tools against a fake device speaking
 * the real wire protocol (`testing/harness.ts`), call a tool the way an
 * agent would, and read `content`/`isError` off what comes back.
 *
 * Nothing here counts how many tools exist or greps for a spread operator.
 * The windowed-tool tests below discover which tools take a window from
 * their live input schema, so adding one is covered automatically; a tool
 * that hand-rolls its own window and does not honour the `from`/`to` it was
 * given fails a test here for a behavioural reason, not a textual one.
 */

describe("the harness", () => {
  it("calls a tool and reads content/isError in four lines", async () => {
    const rig = await buildRig();
    const result = await rig.client.callTool("porthole_status", {});
    expect(result.isError).toBeFalsy();
    await rig.close();
  });

  it("reports not connected when the device never says hello", async () => {
    // `connectDevice: false` means `device.state` never leaves "disconnected"
    // (device.start() is never even called) — this only proves anything about
    // connectivity because `findings` now branches on `device.state`, not on
    // whether the ring happens to be empty. Flip this option to `true` and
    // the device connects and says hello with nothing pushed to the ring,
    // which makes `connected: false` wrong and this assertion fail.
    const rig = await buildRig({ connectDevice: false });
    try {
      const result = await rig.client.callTool("findings", {});
      expect(result.isError).toBeFalsy();
      expect(result.json).toMatchObject({ connected: false, findings: [] });
      expect(result.text).toContain("Not connected to the app on");

      // porthole_status's disconnected arm, pinned the same way the
      // connected and handshaking-pending arms are pinned in the
      // "handshake race" describe block below: summary and payload
      // asserted together, against the real registered tool, so the arm
      // cannot be changed in one without the other going red too.
      const status = await rig.client.callTool("porthole_status", {});
      expect(status.isError).toBeFalsy();
      expect(status.json).toMatchObject({ state: "disconnected" });
      expect(status.text).toContain("Not connected to the app on");
    } finally {
      await rig.close();
    }
  });

  it("reports connected when the device said hello but the ring is still empty", async () => {
    // The bug this guards against: `findings` used to decide "connected" by
    // asking whether the ring had anything in it, so the very first call
    // after every install — device attached, hello received, nothing
    // collected yet — printed the full "Not connected" troubleshooting wall.
    const rig = await buildRig(); // connectDevice defaults to true and waits for hello.
    try {
      expect(rig.device.state).toBe("connected");
      expect(rig.timeline.buffer()).toHaveLength(0);

      const result = await rig.client.callTool("findings", {});
      expect(result.isError).toBeFalsy();
      expect(result.json).toMatchObject({ connected: true, findings: [] });
      expect(result.text).not.toContain("Not connected to the app on");
    } finally {
      await rig.close();
    }
  });
});

describe("porthole_status names its SDK and project root sources", () => {
  // GRA-119 AC5, never actually wired up until this ticket: `porthole_status`
  // must call the real `resolveSdkDir()`/`resolveProjectRoot()` from adb.ts
  // and report their `.source`, not reimplement the resolution. Asserting by
  // value (not just "the field exists") is what makes deleting the
  // provenance from the payload — or hand-rolling a second implementation
  // that happens to agree by accident in this one case — turn this red.

  it("reports PORTHOLE_SDK_DIR as the source when it is set", async () => {
    const original = process.env.PORTHOLE_SDK_DIR;
    process.env.PORTHOLE_SDK_DIR = "C:\\fake\\porthole\\sdk";
    try {
      const rig = await buildRig();
      try {
        const result = await rig.client.callTool("porthole_status", {});
        expect(result.isError).toBeFalsy();
        expect(result.json).toMatchObject({
          sdkDir: "C:\\fake\\porthole\\sdk",
          sdkDirSource: "PORTHOLE_SDK_DIR",
        });
      } finally {
        await rig.close();
      }
    } finally {
      if (original === undefined) delete process.env.PORTHOLE_SDK_DIR;
      else process.env.PORTHOLE_SDK_DIR = original;
    }
  });

  it("reports whatever resolveSdkDir() resolves to when PORTHOLE_SDK_DIR is unset", async () => {
    const original = process.env.PORTHOLE_SDK_DIR;
    delete process.env.PORTHOLE_SDK_DIR;
    try {
      // Not a second, hand-rolled expectation of what the source "should" be —
      // the whole point of AC5 is that porthole_status reports adb.ts's own
      // answer, so the test's expectation is that same answer, called
      // directly.
      const expected = resolveSdkDir();
      const rig = await buildRig();
      try {
        const result = await rig.client.callTool("porthole_status", {});
        expect(result.isError).toBeFalsy();
        expect(result.json).toMatchObject({
          sdkDir: expected.directory,
          sdkDirSource: expected.source,
        });
      } finally {
        await rig.close();
      }
    } finally {
      if (original === undefined) delete process.env.PORTHOLE_SDK_DIR;
      else process.env.PORTHOLE_SDK_DIR = original;
    }
  });

  // GRA-166 item 1: the two tests below pin `projectRoot`/`projectRootSource`
  // to `resolveProjectRoot()`'s own answer, by value -- the same pattern the
  // sdkDir pair above uses. The test they replace only checked
  // `["PORTHOLE_PROJECT_ROOT", "cwd"]).toContain(payload.projectRootSource)`,
  // a membership check against the type's own two literals rather than an
  // assertion against a real value. Mutation M4 (hardcoding
  // `projectRootSource` to a constant) survived that check for as long as
  // the hardcoded string was one of the two the union already allows -- which
  // any hardcoded value naming this field would be, so the check could never
  // have failed. Pinning by value, as the sdkDir pair already did, is what
  // makes a hardcoded return actually distinguishable from a computed one.

  it("reports PORTHOLE_PROJECT_ROOT as the source when it is set", async () => {
    const original = process.env.PORTHOLE_PROJECT_ROOT;
    process.env.PORTHOLE_PROJECT_ROOT = "C:\\fake\\porthole\\project";
    try {
      const rig = await buildRig();
      try {
        const result = await rig.client.callTool("porthole_status", {});
        expect(result.isError).toBeFalsy();
        expect(result.json).toMatchObject({
          projectRoot: "C:\\fake\\porthole\\project",
          projectRootSource: "PORTHOLE_PROJECT_ROOT",
        });
      } finally {
        await rig.close();
      }
    } finally {
      if (original === undefined) delete process.env.PORTHOLE_PROJECT_ROOT;
      else process.env.PORTHOLE_PROJECT_ROOT = original;
    }
  });

  it("reports whatever resolveProjectRoot() resolves to when PORTHOLE_PROJECT_ROOT is unset", async () => {
    const original = process.env.PORTHOLE_PROJECT_ROOT;
    delete process.env.PORTHOLE_PROJECT_ROOT;
    try {
      // Not a second, hand-rolled expectation of what the source "should"
      // be -- the same reasoning as resolveSdkDir()'s pair above: the test's
      // expectation is adb.ts's own answer, called directly, not a re-typed
      // guess that could quietly drift from it.
      const expected = resolveProjectRoot();
      const rig = await buildRig();
      try {
        const result = await rig.client.callTool("porthole_status", {});
        expect(result.isError).toBeFalsy();
        expect(result.json).toMatchObject({
          projectRoot: expected.directory,
          projectRootSource: expected.source,
        });
      } finally {
        await rig.close();
      }
    } finally {
      if (original === undefined) delete process.env.PORTHOLE_PROJECT_ROOT;
      else process.env.PORTHOLE_PROJECT_ROOT = original;
    }
  });
});

describe("every tool that declares a window examines the same span", () => {
  /**
   * Tools discovered by their live JSON schema, not by name. This used to
   * require all three of `sinceMs`/`from`/`to` together, on the theory that
   * the shared `windowShape` always declares exactly those three keys. That
   * missed the actual historical bug shape: a tool that hand-rolls its own
   * window by declaring only `sinceMs` (or only `from`/`to`) is invisible to
   * an "all three" filter, so it never gets exercised by the test below and
   * a broken hand-rolled window would sail through. Declaring *any* of the
   * three is now enough to be considered windowed.
   *
   * The one legitimate exception is `ask_system_trace`, which takes `from`/
   * `to` scoped to a trace file rather than the shared live-buffer window,
   * and has no `sinceMs` — it is named here rather than narrowing the filter
   * back down, so a future tool with a real `sinceMs`-only bug cannot hide
   * behind a broadened exclusion.
   */
  async function windowedTools(rig: Rig): Promise<string[]> {
    const tools = await rig.client.listTools();
    return tools
      .filter((t) => {
        if (t.name === "ask_system_trace") return false;
        const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
        return "sinceMs" in props || "from" in props || "to" in props;
      })
      .map((t) => t.name);
  }

  it("finds at least the six tools known to take the shared window", async () => {
    const rig = await buildRig();
    try {
      const names = await windowedTools(rig);
      for (const expected of [
        "findings",
        "timeline",
        "recompositions",
        "frames",
        "blocking",
        "logs",
      ]) {
        expect(names, `${expected} should declare sinceMs/from/to`).toContain(expected);
      }
    } finally {
      await rig.close();
    }
  });

  it("gives back the same from/to it was asked for, for every windowed tool", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents([
        { event: "recompose", t: 1_000, data: {} },
        { event: "recompose", t: 5_000, data: {} },
        { event: "recompose", t: 9_000, data: {} },
      ]);

      const from = 2_000;
      const to = 8_000;
      const names = await windowedTools(rig);
      expect(names.length).toBeGreaterThan(0);

      for (const name of names) {
        const result = await rig.client.callTool(name, { from, to });
        expect(result.isError, `${name} errored: ${result.text}`).toBeFalsy();

        const payload = result.json as Record<string, unknown>;
        // `findings` and `timeline` resolve the window themselves against
        // the local buffer and report it back as `window`. The four that
        // delegate to the device get it back as `askedWindow` — a field the
        // fake device's canned response echoes straight from the params it
        // actually received on the wire, which is what proves the tool
        // forwarded `from`/`to` unmodified rather than resolving its own
        // and discarding them.
        const window = (payload.window ?? payload.askedWindow) as
          | { from?: number; to?: number }
          | undefined;
        expect(window, `${name} did not report the window it examined`).toBeTruthy();
        expect(window?.from, `${name} used a different 'from'`).toBe(from);
        expect(window?.to, `${name} used a different 'to'`).toBe(to);
      }
    } finally {
      await rig.close();
    }
  });

  it("quotes the window from one tool's own output into another and gets the same span back", async () => {
    // The literal workflow the shared window exists for: ask `findings`
    // about a span, quote the `window` it reports back — not the from/to
    // that was asked for, but what actually came back in the JSON — into a
    // second tool, and see it examine the same span rather than resolving
    // its own.
    const rig = await buildRig();
    try {
      await rig.pushEvents([
        { event: "recompose", t: 1_000, data: {} },
        { event: "recompose", t: 9_000, data: {} },
      ]);

      const findings = await rig.client.callTool("findings", { from: 2_000, to: 7_000 });
      const quoted = (findings.json as { window: { from: number; to: number; ms: number } }).window;
      expect(quoted).toEqual({ from: 2_000, to: 7_000, ms: 5_000 });

      const timeline = await rig.client.callTool("timeline", { from: quoted.from, to: quoted.to });
      const examined = (timeline.json as { window: { from: number; to: number; ms: number } })
        .window;
      expect(examined).toEqual(quoted);
    } finally {
      await rig.close();
    }
  });

  // -- GRA-120: the host and the device agree ------------------------------

  it(
    "findings' sinceMs+to window, quoted into timeline and frames, examines the identical span " +
      "on both (GRA-120)",
    async () => {
      // The load-bearing case from GRA-120: `timeline(sinceMs=5000, to=8000)`
      // used to silently drop `sinceMs` and answer a different, wider window
      // than `frames(sinceMs=5000, to=8000)` did — same two arguments, two
      // different answers, in exactly the workflow (correlate a `findings`
      // window against the raw timeline) the tools exist for. Proven here by
      // actually calling the tools, not by reading `resolveWindow` and
      // `Window.resolve` side by side and asserting they look similar.
      const rig = await buildRig();
      try {
        await rig.pushEvents([
          { event: "recompose", t: 1_000, data: {} },
          { event: "recompose", t: 4_000, data: {} },
          { event: "recompose", t: 6_000, data: {} },
          { event: "recompose", t: 8_000, data: {} },
        ]);

        const findings = await rig.client.callTool("findings", { sinceMs: 5_000, to: 8_000 });
        const quoted = (findings.json as { window: { from: number; to: number; ms: number } })
          .window;
        // This host has no device clock, so `sinceMs` anchors to `to`
        // (8_000) rather than a true "now" — see `resolveWindow`'s own doc
        // comment for why that is the honest choice, not a gap. Floor is
        // 8_000 - 5_000 = 3_000.
        expect(quoted).toEqual({ from: 3_000, to: 8_000, ms: 5_000 });

        // `timeline` resolves the window locally (merged live buffer + disk,
        // per the comment on `windowedTools` above) rather than round-
        // tripping to the device for it, so "the device received it" is
        // proven here by `timeline`'s own reported `window` — the exact
        // field an agent reads to know what span its answer covers.
        const timeline = await rig.client.callTool("timeline", {
          from: quoted.from,
          to: quoted.to,
        });
        const timelineWindow = (
          timeline.json as { window: { from: number; to: number; ms: number } }
        ).window;
        expect(timelineWindow).toEqual(quoted);

        // `frames` forwards its resolved window straight to the device —
        // `askedWindow` is the fake device's own echo of the params it
        // actually received on the wire (see `defaultHandlers` in
        // `testing/harness.ts`), so this is the real end-to-end proof that
        // the device was asked about the same span `findings` reported.
        const frames = await rig.client.callTool("frames", { from: quoted.from, to: quoted.to });
        const framesAsked = (frames.json as { askedWindow: { from?: number; to?: number } })
          .askedWindow;
        expect(framesAsked.from, "frames asked the device for a different 'from'").toBe(
          quoted.from,
        );
        expect(framesAsked.to, "frames asked the device for a different 'to'").toBe(quoted.to);
      } finally {
        await rig.close();
      }
    },
  );

  it("sinceMs anchors to `to`, not to the newest buffered event, when the two differ (QA round 1 on GRA-120)", async () => {
    // The first test above happens to use `to` equal to the newest event, so
    // a host that anchored the lookback to `newest` instead of `to` passed it
    // — QA's mutation survived. Here `to` is 4_000 with events out to 8_000:
    // anchored to `to` the floor is 3_700; anchored to newest it would be
    // 7_700, and the device would be asked about a window this call never
    // named.
    const rig = await buildRig();
    try {
      await rig.pushEvents([
        { event: "recompose", t: 1_000, data: {} },
        { event: "recompose", t: 4_000, data: {} },
        { event: "recompose", t: 8_000, data: {} },
      ]);
      const frames = await rig.client.callTool("frames", { sinceMs: 300, to: 4_000 });
      const asked = (frames.json as { askedWindow: { from?: number; to?: number } }).askedWindow;
      expect(asked.from).toBe(3_700);
      expect(asked.to).toBe(4_000);
    } finally {
      await rig.close();
    }
  });

  it("sinceMs with an explicit `to` is resolved on the host even with nothing buffered, so the device is never asked to anchor it to its own clock (QA round 1 on GRA-120)", async () => {
    // A fresh or just-reconnected host has an empty live buffer. Before this
    // fix that path forwarded `{ sinceMs, to }` raw, and the device's own
    // resolver anchored the lookback to device-now — contradicting the
    // description that promises `(to - sinceMs)..to`. The bounds the device
    // receives must be absolute here.
    const rig = await buildRig();
    try {
      const frames = await rig.client.callTool("frames", { sinceMs: 5_000, to: 1_000_000 });
      const asked = (frames.json as { askedWindow: { from?: number; to?: number; sinceMs?: number } })
        .askedWindow;
      expect(asked.sinceMs).toBeUndefined();
      expect(asked.from).toBe(995_000);
      expect(asked.to).toBe(1_000_000);
    } finally {
      await rig.close();
    }
  });

  it("timeline(sinceMs, to) and frames(sinceMs, to) resolve to the same window on the host, for all three shapes (AC1)", async () => {
    // The MCP-side half of AC1 — the runtime-side half (that `timelineEvents`
    // and `FrameCollector.report` resolve identically) is
    // `TimelineWindowTest.kt`. Both tools route through the same
    // `resolveWindowSince`/`resolveWindow` call here, so agreement is
    // structural, but the point of a test is proving it stayed that way, not
    // trusting that it did.
    const rig = await buildRig();
    try {
      await rig.pushEvents([
        { event: "recompose", t: 1_000, data: {} },
        { event: "recompose", t: 4_000, data: {} },
        { event: "recompose", t: 6_000, data: {} },
        { event: "recompose", t: 8_000, data: {} },
      ]);

      const shapes: Array<Record<string, number>> = [
        { sinceMs: 3_000 },
        { to: 6_000 },
        { sinceMs: 3_000, to: 6_000 },
      ];

      for (const args of shapes) {
        const timeline = await rig.client.callTool("timeline", args);
        const timelineWindow = (
          timeline.json as { window: { from: number; to: number; ms: number } }
        ).window;

        const frames = await rig.client.callTool("frames", args);
        const framesAsked = (frames.json as { askedWindow: { from?: number; to?: number } })
          .askedWindow;

        expect(
          { from: framesAsked.from, to: framesAsked.to },
          `shape ${JSON.stringify(args)} disagreed`,
        ).toEqual({ from: timelineWindow.from, to: timelineWindow.to });
      }
    } finally {
      await rig.close();
    }
  });
});

describe("resolveWindow's edge cases (GRA-120)", () => {
  // Exercised through `findings`, which reports `window: null` whenever
  // `resolveWindow`/`resolveWindowSince` refuses, and the resolved `window`
  // it examined otherwise — the same public surface every one of these
  // arguments actually reaches.

  it("rejects sinceMs of 0 at the schema, before resolveWindow ever sees it", async () => {
    const rig = await buildRig();
    try {
      const result = await rig.client.callTool("findings", { sinceMs: 0 });
      expect(result.isError).toBe(true);
    } finally {
      await rig.close();
    }
  });

  it("rejects a negative sinceMs at the schema", async () => {
    const rig = await buildRig();
    try {
      const result = await rig.client.callTool("findings", { sinceMs: -1 });
      expect(result.isError).toBe(true);
    } finally {
      await rig.close();
    }
  });

  it("clamps a negative explicit from to 0, live buffer non-empty", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents([
        { event: "recompose", t: 1_000, data: {} },
        { event: "recompose", t: 9_000, data: {} },
      ]);
      const result = await rig.client.callTool("findings", { from: -500, to: 9_000 });
      expect(result.isError).toBeFalsy();
      const window = (result.json as { window: { from: number; to: number; ms: number } }).window;
      // Not -500: a timestamp on the device's uptime clock cannot be
      // negative, exactly as the runtime's own Window.resolve already
      // insists — this host used to hand a negative `from` straight
      // through uncorrected.
      expect(window).toEqual({ from: 0, to: 9_000, ms: 9_000 });
    } finally {
      await rig.close();
    }
  });

  it("clamps a negative explicit from to 0, live buffer empty (disk-only fallback)", async () => {
    const rig = await buildRig();
    try {
      // No pushEvents at all — the live buffer is empty, so this exercises
      // resolveWindow's other branch: the one that widens an explicit
      // {from, to} to work from disk alone (GRA-53).
      const result = await rig.client.callTool("findings", { from: -500, to: 1_000 });
      expect(result.isError).toBeFalsy();
      const window = (result.json as { window: { from: number; to: number; ms: number } | null })
        .window;
      expect(window).toEqual({ from: 0, to: 1_000, ms: 1_000 });
    } finally {
      await rig.close();
    }
  });

  it("refuses an explicit from after to instead of handing back an inverted window", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents([{ event: "recompose", t: 5_000, data: {} }]);
      const result = await rig.client.callTool("findings", { from: 9_000, to: 2_000 });
      expect(result.isError).toBeFalsy();
      const window = (result.json as { window: unknown }).window;
      // Refused the way the tool already refuses "no window at all" — not a
      // {from: 9_000, to: 2_000, ms: 0} object a caller could misread as a
      // valid, if oddly-shaped, answer.
      expect(window).toBeNull();
    } finally {
      await rig.close();
    }
  });

  it("refuses an explicit from after to with an empty live buffer too", async () => {
    const rig = await buildRig();
    try {
      const result = await rig.client.callTool("findings", { from: 9_000, to: 2_000 });
      expect(result.isError).toBeFalsy();
      const window = (result.json as { window: unknown }).window;
      expect(window).toBeNull();
    } finally {
      await rig.close();
    }
  });

  it("refuses a to before the oldest buffered event when from is left to default", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents([
        { event: "recompose", t: 5_000, data: {} },
        { event: "recompose", t: 6_000, data: {} },
      ]);
      // No `from`: it defaults to the oldest buffered event (5_000), which is
      // after this `to` — an inverted window with nothing explicit to blame,
      // refused the same way as the fully-explicit case above.
      const result = await rig.client.callTool("findings", { to: 1_000 });
      expect(result.isError).toBeFalsy();
      const window = (result.json as { window: unknown }).window;
      expect(window).toBeNull();
    } finally {
      await rig.close();
    }
  });
});

describe("windowShape's descriptions cannot drift on one tool (GRA-120 AC5)", () => {
  // `sinceMs`/`from`/`to` used to differ per tool before `windowShape`
  // existed, and even after it exists nothing stops a future edit from
  // spreading `windowShape` and then overriding one field's `.describe()`
  // locally on a single tool, which is exactly as silent as five hand-rolled
  // resolvers were. This walks the tools' *registered, live* JSON schemas —
  // what an agent actually reads — not the `windowShape` source object, so a
  // tool that stops spreading it (or shadows a field) fails here.

  const sharedWindowTools = [
    "findings",
    "save_moment",
    "recompositions",
    "frames",
    "blocking",
    "logs",
    "timeline",
  ];

  it("every tool that shares the windowShape uses the exact same sinceMs/from/to wording", async () => {
    const rig = await buildRig();
    try {
      const tools = await rig.client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      const reference = byName.get("findings");
      expect(reference, "findings is not registered").toBeTruthy();
      const refProps = reference!.inputSchema.properties as Record<string, { description?: string }>;
      for (const field of ["sinceMs", "from", "to"] as const) {
        expect(refProps[field]?.description, `findings.${field} has no description`).toBeTruthy();
      }

      for (const name of sharedWindowTools) {
        const tool = byName.get(name);
        expect(tool, `${name} is not registered`).toBeTruthy();
        const props = tool!.inputSchema.properties as Record<string, { description?: string }>;
        for (const field of ["sinceMs", "from", "to"] as const) {
          expect(props[field]?.description, `${name}.${field} drifted from findings.${field}`).toBe(
            refProps[field]?.description,
          );
        }
      }
    } finally {
      await rig.close();
    }
  });

  it("`to`'s description names the default the code actually uses, not a stale 'latest event' claim", async () => {
    // GRA-120's third fault: after GRA-84 the runtime defaults `to` to `now`,
    // and this host — which has no device clock of its own — defaults it to
    // the newest buffered event as its best estimate of `now`. "Defaults to
    // the latest event" (the old wording) described neither honestly: it
    // named a fact about the buffer, not about what "now" means here.
    const rig = await buildRig();
    try {
      const tools = await rig.client.listTools();
      const findings = tools.find((t) => t.name === "findings")!;
      const props = findings.inputSchema.properties as Record<string, { description?: string }>;
      expect(props.to?.description).toContain("current time");
      expect(props.to?.description).not.toContain("latest event");
      // sinceMs's own description must not claim it looks back from "now"
      // unqualified either — it anchors to `to` (explicit or defaulted),
      // which is this host's only honest source for "now".
      expect(props.sinceMs?.description).toContain("`to`");
    } finally {
      await rig.close();
    }
  });
});

describe("findings", () => {
  it("returns an empty list, not an error, for a window with genuinely nothing in it", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents([
        { event: "recompose", t: 1_000, data: {} },
        { event: "recompose", t: 2_000, data: {} },
      ]);

      // Zero-width, sitting strictly between the two buffered events — so
      // inside the buffer's own span, unlike the "outside the buffer" case
      // below. This is a window that was actually examined and found quiet.
      const result = await rig.client.callTool("findings", { from: 1_500, to: 1_500 });
      expect(result.isError).toBeFalsy();

      const payload = result.json as {
        findings: unknown[];
        window: { ms: number };
        clippedMs: { start: number; end: number };
        eventsExamined: number;
      };
      expect(payload.window.ms).toBe(0);
      expect(payload.eventsExamined).toBe(0);
      expect(payload.findings).toEqual([]);
      // Nothing here was clipped: the empty result is the answer, not an
      // artefact of asking about a moment the buffer does not hold.
      expect(payload.clippedMs.start + payload.clippedMs.end).toBe(0);
    } finally {
      await rig.close();
    }
  });

  it("does not read a window entirely outside the buffer as 'nothing happened'", async () => {
    const rig = await buildRig();
    try {
      // Buffer only ever holds 1000-2000ms of history.
      await rig.pushEvents([
        { event: "recompose", t: 1_000, data: {} },
        { event: "recompose", t: 2_000, data: {} },
      ]);

      // A window nowhere near what is buffered.
      const result = await rig.client.callTool("findings", { from: 50_000, to: 60_000 });
      expect(result.isError).toBeFalsy();

      const payload = result.json as {
        clippedMs: { start: number; end: number };
        eventsExamined: number;
      };
      // The whole window fell outside the buffer: nothing was examined, and
      // that has to be visible as clipping, not as a clean empty answer.
      expect(payload.eventsExamined).toBe(0);
      expect(payload.clippedMs.start + payload.clippedMs.end).toBeGreaterThan(0);
      // The wording has to carry the distinction too — this is the
      // behavioural half of what surface.test.ts checks textually against
      // the tool's description.
      expect(result.text).toMatch(/not examined at all|question the buffer cannot answer/);
    } finally {
      await rig.close();
    }
  });

  it("reports clippedMs non-zero when only part of the asked window is buffered", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents([
        { event: "recompose", t: 5_000, data: {} },
        { event: "recompose", t: 6_000, data: {} },
      ]);

      // The first half of this window (0-5000) is older than anything
      // buffered; the second half is fully covered.
      const result = await rig.client.callTool("findings", { from: 0, to: 6_000 });
      expect(result.isError).toBeFalsy();

      const payload = result.json as { clippedMs: { start: number; end: number } };
      expect(payload.clippedMs.start).toBeGreaterThan(0);
      expect(payload.clippedMs.end).toBe(0);
    } finally {
      await rig.close();
    }
  });

  it("runs the analyser for real: a query on the main thread is an observed finding", async () => {
    // Not a fixture asserting on itself — buildTrace is exercised directly
    // in trace.test.ts. This just proves the live `findings` tool actually
    // calls it and returns what it says, through the full tool-call path.
    const rig = await buildRig();
    try {
      // A start/end pair, the way the device actually emits a query — see
      // trace.test.ts's own `span()` helper for the same shape.
      await rig.pushEvents([
        { event: "db_start", t: 1_000, data: { id: "q-1" } },
        {
          event: "db_end",
          t: 1_012,
          data: { id: "q-1", sql: "SELECT 1", onMainThread: "true" },
        },
      ]);
      const result = await rig.client.callTool("findings", {});
      expect(result.isError).toBeFalsy();
      const payload = result.json as { findings: Array<{ id: string; confidence: string }> };
      expect(payload.findings.some((f) => f.id === "db-on-main-thread")).toBe(true);
      expect(payload.findings.every((f) => f.confidence)).toBe(true);
    } finally {
      await rig.close();
    }
  });

  describe("alsoInWindow (GRA-200): findings never hides an exit", () => {
    it("stays byte-identical to before this ticket when the window has none of this to report", async () => {
      // Exactly the first test in this describe block's own scenario, which
      // is already known to produce a deterministic, banner-free summary —
      // reused here so this is a real regression pin against the exact
      // string, not a guess at what "unaffected" should look like.
      const rig = await buildRig();
      try {
        await rig.pushEvents([
          { event: "recompose", t: 1_000, data: {} },
          { event: "recompose", t: 2_000, data: {} },
        ]);
        const result = await rig.client.callTool("findings", { from: 1_500, to: 1_500 });
        expect(result.isError).toBeFalsy();
        expect(result.text).toBe(
          "Nothing crossed a threshold in the 0s examined (0 events). That is not the same as the app being fast.",
        );
        expect(result.text).not.toContain("Also in this window");
        expect((result.json as { alsoInWindow?: unknown }).alsoInWindow).toBeUndefined();
        expect(Object.hasOwn(result.json as object, "alsoInWindow")).toBe(false);
      } finally {
        await rig.close();
      }
    });

    it("inventories a REASON_SIGNALED exit that produces no finding of its own, and names porthole_status", async () => {
      const rig = await buildRig();
      try {
        await rig.pushEvents([
          {
            event: "exit",
            t: 1_000,
            data: { reason: "REASON_SIGNALED", timestamp: 1_700_000_000_000 },
          },
        ]);
        const result = await rig.client.callTool("findings", { from: 0, to: 2_000 });
        expect(result.isError).toBeFalsy();

        const payload = result.json as {
          findings: unknown[];
          alsoInWindow?: { exits?: Array<{ reason: string; timestamp: number; at: string }> };
        };
        // The judgement: REASON_SIGNALED crosses no severity worth a finding.
        expect(payload.findings).toEqual([]);
        // The inventory: the exit is still visible.
        expect(payload.alsoInWindow?.exits).toEqual([
          { reason: "REASON_SIGNALED", timestamp: 1_700_000_000_000, at: "2023-11-14T22:13:20.000Z" },
        ]);
        expect(result.text).toContain("porthole_status");
        expect(result.text).toContain("REASON_SIGNALED");
        expect(result.text).toContain("exitTrace: 1700000000000");
      } finally {
        await rig.close();
      }
    });

    it("counts device and memory events under threshold, and the prose says where the raw detail is", async () => {
      const rig = await buildRig();
      try {
        await rig.pushEvents([
          { event: "device", t: 1_000, data: { kind: "rotation", rotation: "90" } },
          { event: "device", t: 1_001, data: { kind: "network", transport: "wifi" } },
          { event: "memory", t: 1_002, data: { heapUsedMb: "40" } },
        ]);
        const result = await rig.client.callTool("findings", { from: 0, to: 2_000 });
        expect(result.isError).toBeFalsy();

        const payload = result.json as { alsoInWindow?: { device?: number; memory?: number } };
        expect(payload.alsoInWindow).toEqual({ device: 2, memory: 1 });
        expect(result.text).toContain("2 device events");
        expect(result.text).toContain("1 memory event");
        expect(result.text).toContain("raw detail via `timeline`");
      } finally {
        await rig.close();
      }
    });
  });
});

describe("porthole_status, findings and what_was_happening agree during the handshake (GRA-157)", () => {
  // GRA-157 gave the gap this whole describe block is about its own
  // ConnectionState, "handshaking" — DeviceClient enters it on socket
  // connect and only leaves it for "connected" once hello has actually
  // resolved (see device.ts's setState()/connect()). Before that ticket,
  // DeviceClient set state = "connected" the instant the socket connected
  // and issued `request("hello")` without awaiting it, so this same race —
  // roughly 2s wide on real hardware (see GRA-152's device-verify comment) —
  // showed up as `device.state === "connected"` with `device.hello` still
  // null; these tests used to assert exactly that combination. They now
  // assert `device.state === "handshaking"` instead, which is what makes
  // this describe block still prove anything: with the fix in place,
  // `device.state === "connected"` can no longer coexist with a null hello
  // at all (device.ts throws if it would), so an assertion still written
  // against the old combination would either hang forever waiting for a
  // state that never arrives, or silently stop testing the race it names.
  //
  // `connectDevice: false` skips buildRig's own wait-for-hello, and a hello
  // handler that never resolves holds "handshaking" open indefinitely
  // instead of racing a real, narrow gap in a unit test.
  async function buildRaceRig(): Promise<Rig> {
    const rig = await buildRig({
      connectDevice: false,
      handlers: { hello: () => new Promise(() => {}) },
    });
    rig.device.start();
    await waitUntil(() => rig.device.state === "handshaking");
    return rig;
  }

  it("no tool emits the troubleshooting wall while the socket is up and hello is pending", async () => {
    const rig = await buildRaceRig();
    try {
      expect(rig.device.state).toBe("handshaking");
      expect(rig.device.hello).toBeNull();

      const status = await rig.client.callTool("porthole_status", {});
      const findings = await rig.client.callTool("findings", {});
      const whatWasHappening = await rig.client.callTool("what_was_happening", { at: 1000 });

      for (const result of [status, findings, whatWasHappening]) {
        expect(result.isError).toBeFalsy();
        expect(result.text).not.toContain("Not connected to the app on");
      }
    } finally {
      await rig.close();
    }
  });

  it("porthole_status's summary agrees with its own payload.state in the handshake window", async () => {
    // The bug this guards against (pre-GRA-157): the summary required
    // `device.state === "connected" && device.hello`, so it took the
    // not-connected branch and printed the wall while payload.state said
    // "connected" right below it — one call, two answers.
    const rig = await buildRaceRig();
    try {
      const status = await rig.client.callTool("porthole_status", {});
      const payload = status.json as { state: string; app: unknown };
      expect(payload.state).toBe("handshaking");
      expect(payload.app).toBeNull();
      expect(status.text).toContain("Connected, waiting on the app's first check-in");
    } finally {
      await rig.close();
    }
  });

  it("findings' summary and connected field agree with each other in the handshake window (kills M5 and M5c)", async () => {
    const rig = await buildRaceRig();
    try {
      const findings = await rig.client.callTool("findings", {});
      // M5: `const connected = device.hello !== null` reads the wrong field.
      // hello is null here, so that mutant reports connected: false even
      // though device.state === "handshaking" (loosely "attached") — this
      // assertion catches it.
      expect(findings.json).toMatchObject({ connected: true });
      // M5c: putting device.notConnectedMessage() back into the
      // hello-pending arm (i.e. bypassing device.pendingMessage()'s
      // "handshaking" case) reprints the wall here even though the payload
      // says connected — this assertion catches it.
      expect(findings.text).toContain("Connected, waiting on the app's first check-in");
      expect(findings.text).not.toContain("Not connected to the app on");
    } finally {
      await rig.close();
    }
  });

  it("what_was_happening tells the same handshake-pending story as findings (GRA-154, absorbed as AC7)", async () => {
    // GRA-154's bug, folded into this ticket: an empty ring (nothing pushed
    // to the timeline yet) used to read as "not connected" here regardless
    // of whether a device was actually attached. In this rig the ring truly
    // is empty (connectDevice: false — nothing was ever pushed), and the
    // device is mid-handshake, which is the same case findings' "hello
    // pending" arm covers above.
    //
    // QA caught a real regression here: an earlier version of this test
    // asserted `connected: false` for what_was_happening right next to
    // findings' `connected: true` for the identical state and identical
    // prose, under a describe block titled "...agree during the
    // handshake" — two tests each pinned to their own literal, silently
    // encoding a disagreement instead of catching one. Asserting the two
    // tools' `connected` fields equal to EACH OTHER, not each to a
    // constant, is what makes them unable to drift apart again.
    const rig = await buildRaceRig();
    try {
      const result = await rig.client.callTool("what_was_happening", { at: 1000 });
      const findings = await rig.client.callTool("findings", {});
      expect(result.isError).toBeFalsy();
      const resultConnected = (result.json as { connected: boolean }).connected;
      const findingsConnected = (findings.json as { connected: boolean }).connected;
      expect(resultConnected).toBe(findingsConnected);
      expect(resultConnected).toBe(true);
      expect(result.text).toContain("Connected, waiting on the app's first check-in");
      expect(result.text).not.toContain("Not connected to the app on");
    } finally {
      await rig.close();
    }
  });

  it("what_was_happening reports connected: false when genuinely disconnected, not merely handshaking", async () => {
    // The other half of the fix above: `connected` must still be false when
    // there really is no device, not just always true now that the
    // handshaking bug is fixed. device.start() is never called here, so
    // state never leaves "disconnected".
    const rig = await buildRig({ connectDevice: false });
    try {
      const result = await rig.client.callTool("what_was_happening", { at: 1000 });
      expect(result.isError).toBeFalsy();
      expect(result.json).toMatchObject({ connected: false });
      expect(result.text).toContain("Not connected to the app on");
    } finally {
      await rig.close();
    }
  });

  it("GRA-166 item 3: every branch's payload carries `connected`, not just the empty-ring ones", async () => {
    // Before this fix, `connected` was present only on the two empty-ring
    // branches above (device.pendingMessage() and "nothing buffered yet").
    // The four branches below -- reachable once the ring is non-empty -- had
    // no `connected` key at all, so `json.connected` read as `undefined`
    // there, which is falsy: a caller doing the obvious thing silently read
    // "not connected" from a response that never made that claim.
    // toHaveProperty fails on a genuinely missing key, not just a falsy one,
    // so this catches the omission itself rather than merely re-asserting a
    // value.
    const rig = await buildRig();
    try {
      await rig.pushEvents([{ event: "recompose", t: 1_000, data: { name: "Cart" } }]);

      const neitherArg = await rig.client.callTool("what_was_happening", {});
      expect(neitherArg.isError).toBeFalsy();
      expect(neitherArg.json).toHaveProperty("connected", true);

      // No "clocks" event was ever pushed, so a bootMs lookup cannot convert.
      const noClockSample = await rig.client.callTool("what_was_happening", { bootMs: 5_000 });
      expect(noClockSample.isError).toBeFalsy();
      expect(noClockSample.json).toHaveProperty("connected", true);

      const outsideBuffer = await rig.client.callTool("what_was_happening", { at: 999_999 });
      expect(outsideBuffer.isError).toBeFalsy();
      expect(outsideBuffer.json).toHaveProperty("connected", true);

      // The success branch: a moment actually found and described.
      const found = await rig.client.callTool("what_was_happening", { at: 1_000 });
      expect(found.isError).toBeFalsy();
      expect(found.json).toHaveProperty("connected", true);
    } finally {
      await rig.close();
    }
  });

  it("porthole_status and findings tell the same connection story in the handshake window", async () => {
    const rig = await buildRaceRig();
    try {
      const status = await rig.client.callTool("porthole_status", {});
      const findings = await rig.client.callTool("findings", {});
      const statusPayload = status.json as { state: string };
      const findingsPayload = findings.json as { connected: boolean };

      expect(statusPayload.state).toBe("handshaking");
      expect(findingsPayload.connected).toBe(true);
      // Not just "both non-wall" — both describe the same handshake-pending
      // story, so an agent reading either tool gets a consistent answer.
      expect(status.text).toContain("Connected, waiting on the app's first check-in");
      expect(findings.text).toContain("Connected, waiting on the app's first check-in");
    } finally {
      await rig.close();
    }
  });

  it("ask_system_trace and capture_system_trace name the handshake instead of telling the caller to connect (GRA-157 AC3)", async () => {
    const rig = await buildRaceRig();
    try {
      const trace = await rig.client.callTool("ask_system_trace", { trace: "whatever.pftrace" });
      expect(trace.isError).toBe(true);
      expect(trace.text).toContain("still waiting on its first check-in");
      expect(trace.text).not.toContain("Connect to the app");

      const capture = await rig.client.callTool("capture_system_trace", {});
      expect(capture.isError).toBe(true);
      expect(capture.text).toContain("Still waiting on the app's first check-in");
    } finally {
      await rig.close();
    }
  });

  it("device.state resolves to 'connected' — never anything else — once hello finally answers", async () => {
    // Proves the window actually closes, and closes onto the strict state:
    // buildRaceRig's hello handler never resolves on its own, so this
    // replaces it and lets the pending request settle.
    const rig = await buildRaceRig();
    try {
      rig.fakeDevice.on("hello", () => ({
        protocol: 1,
        packageName: "com.example.shop",
        processName: "com.example.shop",
        versionName: "1.0.0-test",
        device: "Test Device",
        sdkInt: 34,
        startedAt: 0,
        collectors: [],
      }));
      // The pending hello request from buildRaceRig's original handler is
      // never going to resolve; disconnect and let the client's own
      // reconnect loop send a fresh one against the new handler.
      rig.fakeDevice.disconnectAll();
      await waitUntil(() => rig.device.state === "connected", 5_000);
      expect(rig.device.hello).not.toBeNull();

      const status = await rig.client.callTool("porthole_status", {});
      expect(status.json).toMatchObject({ state: "connected" });
      expect(status.text).toContain("Connected to com.example.shop");
    } finally {
      await rig.close();
    }
  });
});

describe("a stale ring says whose process it belongs to, not the running one's (GRA-163)", () => {
  // The GRA-157 block above never pushes anything to the ring before
  // calling a tool — buildRaceRig() starts empty and stays empty — which is
  // exactly the one input where this ticket's defect cannot appear. Nine
  // commits, three QA rounds and five mutations were defended against that
  // one input. buildRingInState() (testing/harness.ts) is the fixture that
  // was missing: a non-empty ring in each of DeviceClient's four states.

  // AC4: "the test rig can build a non-empty ring in every connection
  // state" — the criterion the ticket itself names as the one that matters
  // most, since the other three are fixable in an afternoon and will
  // regress the moment the fixture shape narrows again.
  it("AC4: the rig builds a non-empty ring in every connection state", async () => {
    const states: ConnectionState[] = ["connected", "handshaking", "connecting", "disconnected"];
    for (const state of states) {
      const rig = await buildRingInState(state);
      try {
        expect(rig.device.state).toBe(state);
        expect(rig.timeline.buffer().length).toBeGreaterThan(0);
      } finally {
        await rig.close();
      }
    }
  });

  // AC1: "With a non-empty ring and the device disconnected, all three
  // tools agree on the connection state and none reports on the dead
  // process as if it were live."
  it("AC1: with a non-empty ring and the device disconnected, all three tools agree and none reports the dead process as live", async () => {
    const rig = await buildRingInState("disconnected");
    try {
      expect(rig.device.lastExited?.hello.packageName).toBe("com.example.shop");

      const status = await rig.client.callTool("porthole_status", {});
      const findings = await rig.client.callTool("findings", {});
      const wwh = await rig.client.callTool("what_was_happening", { at: 1_000 });

      expect(status.json).toMatchObject({ state: "disconnected" });
      expect((status.json as { exitedProcess: { packageName: string } }).exitedProcess).toMatchObject(
        { packageName: "com.example.shop" },
      );
      expect(status.text).toContain("com.example.shop");
      expect(status.text).toContain("exited at");

      expect(findings.json).toMatchObject({ connected: false });
      expect(
        (findings.json as { exitedProcess: { packageName: string } }).exitedProcess,
      ).toMatchObject({ packageName: "com.example.shop" });
      expect(findings.text).toContain("com.example.shop");
      expect(findings.text).toContain("not from what is running now");

      expect(wwh.json).toMatchObject({ connected: false });
      expect((wwh.json as { exitedProcess: { packageName: string } }).exitedProcess).toMatchObject({
        packageName: "com.example.shop",
      });
      // QA round 2: this test asserted wwh.json but never wwh.text, so the
      // mutation QA was sent back to prove (dropping exitedProcessNotice()
      // from what_was_happening's non-empty-ring call site) went undetected
      // here -- the one branch that mutation targets is the one branch
      // whose prose nothing checked.
      expect(wwh.text).toContain("com.example.shop");
      expect(wwh.text).toContain("not from what is running now");
    } finally {
      await rig.close();
    }
  });

  // AC2 + AC5: "With a non-empty ring and the device handshaking, no tool
  // reports connected: true about the previous session's data." This is
  // also the mutation-reachability test (AC5): the scenario only comes out
  // right if findings/what_was_happening actually consult
  // device.pendingMessage() on the non-empty branch — the pre-fix code
  // used isAttached(device.state) alone there, which reads "handshaking" as
  // attached and would report connected: true about the OLD process's
  // events. That is the measured bug: 34 of 613 hardware samples.
  it("AC2/AC5: with a non-empty ring and the device handshaking again, no tool reports connected: true about the previous session's data", async () => {
    const rig = await buildRingInState("handshaking");
    try {
      expect(rig.device.state).toBe("handshaking");
      expect(rig.device.hello).toBeNull();
      expect(rig.device.lastExited?.hello.packageName).toBe("com.example.shop");

      const findings = await rig.client.callTool("findings", {});
      expect(findings.json).toMatchObject({ connected: false });
      expect(
        (findings.json as { exitedProcess: { packageName: string } }).exitedProcess,
      ).toMatchObject({ packageName: "com.example.shop" });

      const wwh = await rig.client.callTool("what_was_happening", { at: 1_000 });
      expect(wwh.json).toMatchObject({ connected: false });
      expect((wwh.json as { exitedProcess: { packageName: string } }).exitedProcess).toMatchObject({
        packageName: "com.example.shop",
      });

      const status = await rig.client.callTool("porthole_status", {});
      expect(status.json).toMatchObject({ state: "handshaking" });
      expect(status.text).toContain("com.example.shop");
      expect(status.text).toContain("exited at");
    } finally {
      await rig.close();
    }
  });

  // AC3: "The session boundary is symmetric: whatever happens to the ring
  // on hello has a counterpart on close." Confirmed end-to-end here (a real
  // socket close through DeviceClient); timeline.test.ts pins the ring's
  // own clear-vs-keep behaviour directly against TimelineServer.
  it("AC3: on socket close the ring is kept, not cleared, and device.lastExited records who it belonged to", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents([{ event: "recompose", t: 1_000, data: { name: "Cart" } }]);
      const before = rig.timeline.buffer().length;
      expect(before).toBeGreaterThan(0);
      expect(rig.device.lastExited).toBeNull();

      rig.fakeDevice.disconnectAll();
      await waitUntil(() => rig.device.state === "disconnected");

      expect(rig.timeline.buffer().length).toBe(before);
      expect(rig.device.lastExited?.hello.packageName).toBe("com.example.shop");
    } finally {
      await rig.close();
    }
  });

  it("the ordinary case is unaffected: connected: true still means the ring is confirmed live, not a previous session's leftovers", async () => {
    const rig = await buildRingInState("connected");
    try {
      const findings = await rig.client.callTool("findings", {});
      expect(findings.json).toMatchObject({ connected: true, exitedProcess: null });
      expect(findings.text).not.toContain("exited at");
    } finally {
      await rig.close();
    }
  });

  // QA round 1 (verdict at bfd6ca7): the thirteenth state, missed by the
  // twelve above because none of them combine an empty ring with a
  // `lastExited`. It arises from a real sequence: a process runs and dies
  // (lastExited set, ring holds its leftovers), then a genuinely new
  // process connects -- its own `hello` clears the ring (timeline.ts) --
  // and dies before emitting anything at all. The ring is empty again, but
  // `lastExited` now names the second process. Before this fix,
  // `porthole_status` reported `exitedProcess` unconditionally while
  // `findings`/`what_was_happening`'s empty-ring branches reported nothing
  // -- cross-tool disagreement -- and `pendingMessage()`'s own prose said
  // "whatever is still buffered is from X" while the payload right next to
  // it said `bufferedEvents: 0` / `findings: []` -- prose contradicting its
  // own payload in a single answer, which is the hardware form of the
  // original bug and wider than what was filed.
  it("the empty-ring-plus-lastExited state: all three tools agree the process exited and nothing is buffered", async () => {
    const rig = await buildRig();
    try {
      // Session A: connects, produces one event, then exits.
      await rig.pushEvents([{ event: "recompose", t: 1_000, data: { name: "Cart" } }]);
      expect(rig.timeline.buffer().length).toBeGreaterThan(0);
      rig.fakeDevice.disconnectAll();
      await waitUntil(() => rig.device.state === "disconnected");
      // GRA-170: the default fixture's startedAt is no longer a fixed 0 —
      // it is this session's actual first value from the default handler.
      expect(rig.device.lastExited?.hello.startedAt).toBe(DEFAULT_STARTED_AT_MS);

      // Session B: a genuinely new process (different startedAt), which
      // clears the ring on its own hello, then exits before emitting
      // anything. stop()/start() is buildRingInState's own trick for a
      // deterministic reconnect rather than waiting on the real backoff
      // timer.
      rig.fakeDevice.on("hello", () => ({
        protocol: 1,
        packageName: "com.example.shop",
        processName: "com.example.shop",
        versionName: "1.0.0-test",
        device: "Test Device",
        sdkInt: 34,
        startedAt: 999,
        collectors: [],
      }));
      rig.device.stop();
      rig.device.start();
      await waitUntil(() => rig.device.state === "connected");
      expect(rig.timeline.buffer()).toHaveLength(0); // the new hello cleared it

      rig.fakeDevice.disconnectAll();
      await waitUntil(() => rig.device.state === "disconnected");
      expect(rig.timeline.buffer()).toHaveLength(0);
      expect(rig.device.lastExited?.hello.startedAt).toBe(999);

      const status = await rig.client.callTool("porthole_status", {});
      const findings = await rig.client.callTool("findings", {});
      const wwh = await rig.client.callTool("what_was_happening", { at: 1_000 });

      for (const [name, result] of [
        ["porthole_status", status],
        ["findings", findings],
        ["what_was_happening", wwh],
      ] as const) {
        expect(result.text, `${name} should name the exited process`).toContain("com.example.shop");
        expect(result.text, `${name} must say nothing is buffered`).toContain(
          "nothing is currently buffered from it",
        );
        expect(
          result.text,
          `${name} must not claim data is present when the ring is empty`,
        ).not.toContain("what follows is from it");
        expect(
          (result.json as { exitedProcess: { packageName: string } | null }).exitedProcess,
          `${name}'s payload must carry exitedProcess too, not just its prose`,
        ).toMatchObject({ packageName: "com.example.shop", device: "Test Device" });
      }

      expect(status.json).toMatchObject({ bufferedEvents: 0 });
      expect(findings.json).toMatchObject({ connected: false, findings: [] });
      expect(wwh.json).toMatchObject({ connected: false });
    } finally {
      await rig.close();
    }
  });
});

describe("GRA-170: an ordinary reconnect's startedAt, not a fixture accident, decides whether the ring clears", () => {
  // Measured before this ticket, across this file and device.test.ts (the
  // only two files that can drive DeviceClient through the rig; device.test.ts
  // never wires a TimelineServer, so it has zero candidates structurally):
  // exactly one test ever let a *second* real hello land after a first one
  // through buildRig/buildRingInState — the "empty-ring-plus-lastExited"
  // test above — and it only reached the "clear" branch by overriding
  // `startedAt` to 999 by hand. Nothing reached "carry forward" through the
  // rig at all, because the old default handler returned the same literal
  // `0` on every call and no reconnect test used two unmodified hellos to
  // find out what that would do. That is the blast radius this ticket
  // exists to close: not "every reconnect test carries forward", but "no
  // reconnect test exercises either branch via the plain default fixture,
  // and the one test that reaches the decision at all forces it by hand."
  //
  // These two tests are the missing evidence, one per branch, both driven
  // through a real reconnect (disconnect, then device.stop()/start() —
  // buildRingInState's own deterministic-reconnect trick) rather than by
  // constructing a TimelineServer and firing a synthetic `hello` at it by
  // hand the way timeline.test.ts's own (non-rig) tests do.

  it("an unmodified reconnect — no test-side startedAt override — clears the ring by default", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents([{ event: "recompose", t: 1_000, data: { name: "Cart" } }]);
      expect(rig.timeline.buffer().length).toBeGreaterThan(0);
      const firstStartedAt = rig.device.hello?.startedAt;

      rig.fakeDevice.disconnectAll();
      await waitUntil(() => rig.device.state === "disconnected");
      rig.device.stop();
      // No `hello` override at all: the plain default fixture, exactly what
      // most reconnect-adjacent tests in this file already use for other
      // reasons. This is the case that used to be structurally incapable of
      // clearing anything, because the default's startedAt never changed.
      rig.device.start();
      await waitUntil(() => rig.device.state === "connected");

      expect(rig.device.hello?.startedAt).not.toBe(firstStartedAt);
      expect(rig.timeline.buffer()).toHaveLength(0);
    } finally {
      await rig.close();
    }
  });

  it("a reconnect that deliberately repeats the same startedAt (the same process, after a transient drop) carries the ring forward", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents([{ event: "recompose", t: 1_000, data: { name: "Cart" } }]);
      const before = rig.timeline.buffer().length;
      expect(before).toBeGreaterThan(0);
      const pinnedStartedAt = rig.device.hello?.startedAt;
      expect(pinnedStartedAt).toBeDefined();

      rig.fakeDevice.disconnectAll();
      await waitUntil(() => rig.device.state === "disconnected");
      rig.device.stop();
      // The deliberate case (AC3): hold startedAt fixed across the
      // reconnect, exactly as a still-alive process would, since
      // SystemClock.uptimeMillis() does not change just because the socket
      // dropped and came back.
      rig.fakeDevice.on("hello", () => ({
        protocol: 1,
        packageName: "com.example.shop",
        processName: "com.example.shop",
        versionName: "1.0.0-test",
        device: "Test Device",
        sdkInt: 34,
        startedAt: pinnedStartedAt,
        collectors: [],
      }));
      rig.device.start();
      await waitUntil(() => rig.device.state === "connected");

      expect(rig.device.hello?.startedAt).toBe(pinnedStartedAt);
      expect(rig.timeline.buffer()).toHaveLength(before);

      // The other half of the same claim, in the same test: inverting the
      // comparison to clear only when startedAt EQUALS the previous value
      // (the inverse of the real rule) leaves `this.startedAt` permanently
      // undefined -- a real number is never `===` to it, so the assignment
      // never fires, on this hello or any later one. The ring then never
      // clears again for the rest of the test, which would pass everything
      // asserted above vacuously regardless of whether the two startedAt
      // values above actually differ. Reconnecting once more with a
      // genuinely different startedAt, and requiring the ring to clear
      // *this* time, rules that out: only a comparison that treats "equal"
      // and "different" as distinct cases passes both halves.
      rig.fakeDevice.disconnectAll();
      await waitUntil(() => rig.device.state === "disconnected");
      rig.device.stop();
      rig.fakeDevice.on("hello", () => ({
        protocol: 1,
        packageName: "com.example.shop",
        processName: "com.example.shop",
        versionName: "1.0.0-test",
        device: "Test Device",
        sdkInt: 34,
        startedAt: (pinnedStartedAt ?? 0) + 1,
        collectors: [],
      }));
      rig.device.start();
      await waitUntil(() => rig.device.state === "connected");

      expect(rig.device.hello?.startedAt).toBe((pinnedStartedAt ?? 0) + 1);
      expect(rig.timeline.buffer()).toHaveLength(0);
    } finally {
      await rig.close();
    }
  });
});

describe("more GRA-163 tools coverage", () => {
  // QA round 2: exitedProcessNotice()'s QA-round-1 rewrite silently dropped
  // a sentence the original fix had -- "Nothing has confirmed itself as the
  // running process yet" -- for the one case that has real buffered data
  // but no known predecessor to name: the very first connection, still
  // handshaking, with the ring already non-empty (GRA-163's own mechanism
  // for reproducing the defect without hardware: buildRaceRig(), push one
  // event before the deferred hello resolves). device.lastExited is null
  // here -- nothing has ever exited in this server's lifetime -- so
  // exitedProcess is null too, but the data still cannot be confirmed to
  // belong to whatever is connecting now, and this ticket's entire subject
  // is tools telling the truth about their state instead of saying
  // nothing.
  //
  // QA round 3: this test originally called only findings and
  // what_was_happening, so dropping the restored sentence at
  // porthole_status alone -- a call site this test never exercised -- left
  // the suite green. The three-tool loop below is the same one the
  // thirteenth-row test above uses, for the same reason: any tool this
  // ticket's scope later grows to cover is checked by construction, not
  // because someone remembered to add a fourth call.
  it("with no known predecessor and no confirmed live session, all three tools still say the data is not yet confirmed live", async () => {
    const rig = await buildRig({
      connectDevice: false,
      handlers: { hello: () => new Promise(() => {}) },
    });
    try {
      rig.device.start();
      await waitUntil(() => rig.device.state === "handshaking");
      await rig.pushEvents([{ event: "recompose", t: 1_000, data: { name: "Cart" } }]);
      expect(rig.device.lastExited).toBeNull();

      const status = await rig.client.callTool("porthole_status", {});
      const findings = await rig.client.callTool("findings", {});
      const wwh = await rig.client.callTool("what_was_happening", { at: 1_000 });

      for (const [name, result] of [
        ["porthole_status", status],
        ["findings", findings],
        ["what_was_happening", wwh],
      ] as const) {
        expect(
          result.text,
          `${name} should say nothing has confirmed itself as the running process`,
        ).toContain(
          "Nothing has confirmed itself as the running process yet, so what follows is not yet " +
            "confirmed to be live.",
        );
        expect(
          (result.json as { exitedProcess: unknown }).exitedProcess,
          `${name}'s payload must carry exitedProcess: null too, not just its prose`,
        ).toBeNull();
      }

      expect(status.json).toMatchObject({ state: "handshaking" });
      expect(findings.json).toMatchObject({ connected: false });
      expect(wwh.json).toMatchObject({ connected: false });
    } finally {
      await rig.close();
    }
  });
});

describe("resolveSdkDir's blank sdk.dir from local.properties (M6b)", () => {
  // adb.test.ts is not in this ticket's Owns (mcp/src/index.ts,
  // index.test.ts, device.ts, device.test.ts, adb.ts), so this fixture lives
  // here instead of alongside adb.test.ts's other local.properties tests —
  // per GRA-152, asking first or placing it wherever Owns allows and saying
  // so. adb.test.ts:312 already defends a blank PORTHOLE_SDK_DIR; nothing
  // defended a blank sdk.dir read out of local.properties (adb.ts's
  // `sdkDirFromLocalProperties`), which QA's mutation
  // (`if (value && value.trim()) return value.trim()` weakened to
  // `if (value !== undefined) return value`) proved by surviving the full
  // suite: a whitespace-only `sdk.dir=   ` would resolve as a real SDK
  // directory and shadow ANDROID_HOME.
  it("a whitespace-only sdk.dir in local.properties is treated as absent, not as an SDK directory", () => {
    const savedEnv = {
      PORTHOLE_SDK_DIR: process.env.PORTHOLE_SDK_DIR,
      PORTHOLE_PROJECT_ROOT: process.env.PORTHOLE_PROJECT_ROOT,
      ANDROID_HOME: process.env.ANDROID_HOME,
      ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT,
    };
    const project = mkdtempSync(path.join(tmpdir(), "porthole-index-sdkdir-"));
    const realSdk = mkdtempSync(path.join(tmpdir(), "porthole-index-realsdk-"));
    try {
      delete process.env.PORTHOLE_SDK_DIR;
      process.env.PORTHOLE_PROJECT_ROOT = project;
      // A blank value, not a missing key — this is the case
      // `value !== undefined` (M6b) gets wrong that `value && value.trim()`
      // gets right. Plain ASCII spaces after `=` do not reach that check at
      // all: parseProperties' own leading-whitespace regex (`[ \t\f]`) already
      // strips them down to an empty string before `sdkDirFromLocalProperties`
      // ever sees the value, so both the fixed and the mutated code fall
      // through identically and the fixture would prove nothing. U+00A0
      // (a non-breaking space, as a real editor can produce without anyone
      // noticing) is not in that character class, so it survives parsing as
      // a non-empty, all-whitespace string — exactly the value `.trim()`
      // exists to catch, and `value !== undefined` does not.
      const blankSdkDirValue = String.fromCharCode(160, 160, 160); // three non-breaking spaces
      const localPropertiesContent = "sdk.dir=" + blankSdkDirValue + String.fromCharCode(10);
      writeFileSync(path.join(project, "local.properties"), localPropertiesContent);
      process.env.ANDROID_HOME = realSdk;
      delete process.env.ANDROID_SDK_ROOT;

      const resolved = resolveSdkDir();
      // The blank sdk.dir must not shadow ANDROID_HOME: it should be treated
      // as though local.properties said nothing about sdk.dir at all.
      expect(resolved).toEqual({ directory: realSdk, source: "ANDROID_HOME" });
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(realSdk, { recursive: true, force: true });
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("no site re-derives the connection story by hand (GRA-154 AC5, absorbed into GRA-157)", () => {
  // GRA-154 AC5 asked for "a cheap and mechanical guard, not a comment asking
  // people to be careful" against a future call site reading
  // device.notConnectedMessage() directly in a branch that is really about
  // an empty buffer rather than a disconnected device — the exact shape B3
  // and this ticket's seven sites both were. Every such site in this file
  // now goes through device.pendingMessage() instead (see porthole_status,
  // findings, what_was_happening and ask_system_trace above), which is the
  // one place allowed to call notConnectedMessage() at all — this reads the
  // source text and fails if a second, independent caller shows up.
  it("index.ts never calls device.notConnectedMessage() directly", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    // pendingMessage() itself is defined in device.ts, not here, so a plain
    // substring count is enough — there is no legitimate definition of the
    // method in this file to exclude, only call sites.
    const count = (source.match(/notConnectedMessage\(/g) ?? []).length;
    expect(
      count,
      "index.ts should route every connection message through device.pendingMessage()",
    ).toBe(0);
  });
});

describe("porthole_status on a protocol mismatch (GRA-96)", () => {
  // AC4: "A test drives a fake device that reports a different protocol and
  // asserts the message." A real FakeDevice over a real socket — not a
  // hand-built DeviceClient state — answering `hello` with a protocol this
  // server does not understand, exactly the shape a runtime built against an
  // older or newer wire format would produce.
  function mismatchedHello(protocol: number) {
    return {
      protocol,
      packageName: "com.example.shop",
      processName: "com.example.shop",
      versionName: "1.0.0-test",
      device: "Test Device",
      sdkInt: 34,
      startedAt: 0,
      collectors: [],
    };
  }

  it("names both versions and the action instead of the normal connected summary (AC1/AC2)", async () => {
    const rig = await buildRig({ handlers: { hello: () => mismatchedHello(2) } });
    try {
      expect(rig.device.state).toBe("connected");
      expect(rig.device.protocolMismatch).not.toBeNull();

      const status = await rig.client.callTool("porthole_status", {});
      expect(status.isError).toBeFalsy();
      // AC1: a specific, actionable message, not the generic "Connected to
      // ... Collectors: ..." summary the healthy path prints.
      expect(status.text).not.toContain("Collectors:");
      // AC2: both versions and the action are in the text an agent reads.
      expect(status.text).toContain("2");
      expect(status.text).toContain("1");
      expect(status.text).toMatch(/update|pin/i);
      // Structured data agrees with the summary text, not just the prose:
      // the summary *is* protocolMismatch verbatim when there is one (see
      // ok()'s "summary\n\n{json}" convention — status.text carries both).
      const payload = status.json as { protocolMismatch: string | null };
      expect(payload.protocolMismatch).not.toBeNull();
      expect(status.text.startsWith(payload.protocolMismatch as string)).toBe(true);
    } finally {
      await rig.close();
    }
  });

  it("is absent for a matching protocol, the normal case", async () => {
    const rig = await buildRig(); // default fixture hello() sends protocol: 1
    try {
      expect(rig.device.protocolMismatch).toBeNull();
      const status = await rig.client.callTool("porthole_status", {});
      const payload = status.json as { protocolMismatch: string | null };
      expect(payload.protocolMismatch).toBeNull();
      expect(status.text).toContain("Collectors:");
    } finally {
      await rig.close();
    }
  });
});

describe("porthole_status and findings on a package mismatch (GRA-197)", () => {
  // The default fixture's hello() always answers as com.example.shop (see
  // testing/harness.ts's defaultHandlers()) — exactly the shape a real
  // "another Porthole app is holding the port" incident produces once this
  // server is configured, via applicationId, for a different app.
  it("porthole_status names both the connected and configured package instead of the normal connected summary", async () => {
    const rig = await buildRig({ applicationId: "com.acme.app" });
    try {
      expect(rig.device.state).toBe("connected");
      expect(rig.device.packageMismatch).not.toBeNull();

      const status = await rig.client.callTool("porthole_status", {});
      expect(status.isError).toBeFalsy();
      expect(status.text).not.toContain("Collectors:");
      expect(status.text).toContain("com.example.shop");
      expect(status.text).toContain("com.acme.app");
      expect(status.text).toContain("PORTHOLE_APPLICATION_ID");
      // Structured data agrees with the summary text, same convention as
      // protocolMismatch above.
      const payload = status.json as { packageMismatch: string | null };
      expect(payload.packageMismatch).not.toBeNull();
      expect(status.text.startsWith(payload.packageMismatch as string)).toBe(true);
    } finally {
      await rig.close();
    }
  });

  it("is absent from porthole_status for a matching applicationId, the normal case", async () => {
    const rig = await buildRig({ applicationId: "com.example.shop" });
    try {
      expect(rig.device.packageMismatch).toBeNull();
      const status = await rig.client.callTool("porthole_status", {});
      const payload = status.json as { packageMismatch: string | null };
      expect(payload.packageMismatch).toBeNull();
      expect(status.text).toContain("Collectors:");
    } finally {
      await rig.close();
    }
  });

  it("is absent from porthole_status when PORTHOLE_APPLICATION_ID was never configured", async () => {
    const rig = await buildRig(); // no applicationId — behaviour must be unchanged (AC3)
    try {
      expect(rig.device.packageMismatch).toBeNull();
      const status = await rig.client.callTool("porthole_status", {});
      const payload = status.json as { packageMismatch: string | null };
      expect(payload.packageMismatch).toBeNull();
    } finally {
      await rig.close();
    }
  });

  // GRA-197 AC2, the general case: every tool's result carries the mismatch,
  // through the one place all successful results pass (ok() →
  // attachSinceLastAndBanner), not through a per-tool branch — so a tool
  // with a real answer to give (events buffered, a window to report) still
  // leads with it, and a tool that never mentions packages at all does too.
  // Coordinator review of PR 63 found the AC met only by findings' empty-ring
  // branch below; this is the proof for the rest.
  it("frames and findings, with events buffered, both lead with the mismatch and still answer", async () => {
    const rig = await buildRig({ applicationId: "com.acme.app" });
    try {
      await rig.pushEvents([
        { event: "recompose", t: 1_000, data: {} },
        { event: "recompose", t: 5_000, data: {} },
      ]);

      const frames = await rig.client.callTool("frames", { from: 0, to: 6_000 });
      expect(frames.isError).toBeFalsy();
      expect(frames.text.startsWith("⚠ Connected to `com.example.shop`, but this MCP server was configured for `com.acme.app`")).toBe(
        true,
      );
      // Still the tool's own answer underneath, not a replacement for it.
      expect(frames.json).not.toBeNull();

      const findings = await rig.client.callTool("findings", { from: 0, to: 6_000 });
      expect(findings.isError).toBeFalsy();
      expect(findings.text).toContain("com.acme.app");
      expect(findings.text).toContain("examined");
      // Said once, never twice: the lead is skipped for a summary that
      // already is the mismatch text (porthole_status, the empty-ring branch).
      const status = await rig.client.callTool("porthole_status", {});
      expect(status.text.split("PORTHOLE_APPLICATION_ID").length - 1).toBe(1);
    } finally {
      await rig.close();
    }
  });

  it("with a matching applicationId, no tool result carries a lead", async () => {
    const rig = await buildRig({ applicationId: "com.example.shop" });
    try {
      await rig.pushEvents([{ event: "recompose", t: 1_000, data: {} }]);
      const frames = await rig.client.callTool("frames", { from: 0, to: 2_000 });
      expect(frames.text.startsWith("⚠")).toBe(false);
      expect(frames.text).not.toContain("PORTHOLE_APPLICATION_ID");
    } finally {
      await rig.close();
    }
  });

  // GRA-197 AC2: "present ... in the banner of an unrelated tool" — findings'
  // empty-ring branch leads with it the same way porthole_status's summary
  // does, proven here against a real tool call rather than device.ts alone.
  it("findings — an unrelated tool — leads its empty-ring summary with the mismatch too", async () => {
    const rig = await buildRig({ applicationId: "com.acme.app" });
    try {
      const findings = await rig.client.callTool("findings", {});
      expect(findings.isError).toBeFalsy();
      expect(findings.text).toContain("com.example.shop");
      expect(findings.text).toContain("com.acme.app");
      expect(findings.text).not.toContain("nothing buffered yet");
    } finally {
      await rig.close();
    }
  });
});

// -----------------------------------------------------------------------------
// GRA-171: joinSummaryAndPayload() itself, direct — proving the structural
// claim without going through a device fixture at all
// -----------------------------------------------------------------------------
//
// GRA-169's collapseBlankLines() needed a direct unit suite because the
// integration tests below only ever fed one blank-line shape through two
// fields — enough to prove the chokepoint was wired, not that the function
// behind it was correct in general. The structural design does not have
// that problem in the first place: there is no regex whose coverage could
// be incomplete, so one test that throws every adversarial shape at once
// and checks the array shape and the JSON round-trip is a complete proof,
// not a sample. That is the actual difference between "normalise harder"
// and "make the class impossible" this ticket is asking for — it shows up
// here as fewer, stronger tests, not merely different ones.
describe("GRA-171: joinSummaryAndPayload()", () => {
  it("returns exactly one block when called with no payload — fail()'s shape", () => {
    const content = joinSummaryAndPayload("plain error message");
    expect(content).toEqual([{ type: "text", text: "plain error message" }]);
  });

  it("returns exactly two blocks when called with a payload — ok()'s shape", () => {
    const content = joinSummaryAndPayload("a summary", { a: 1 });
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "a summary" });
    expect(JSON.parse(content[1].text)).toEqual({ a: 1 });
  });

  it("keeps the payload block a real string even when the payload argument itself is `undefined`", () => {
    // Argument COUNT decides whether there is a payload block, not whether
    // the payload argument is falsy — `joinSummaryAndPayload(s, undefined)`
    // (two arguments) must still produce ok()'s two-block shape, not
    // fail()'s one-block shape. And JSON.stringify(undefined) is the JS
    // value `undefined`, not a string, so a naive implementation would leak
    // that into `text`, which the MCP content schema requires to be a
    // string — `mcp/src/index.ts`'s `?? "null"` is what this pins.
    const content = joinSummaryAndPayload("summary", undefined);
    expect(content).toHaveLength(2);
    expect(typeof content[1].text).toBe("string");
    expect(content[1].text).toBe("null");
    expect(JSON.parse(content[1].text)).toBeNull();
  });

  // The full adversarial set this ticket must still parse (GRA-169's set,
  // widened per GRA-171 AC5): CRLF pairs, 3 and 7 consecutive newlines
  // (odd counts leave a dangling single "\n" under the old regex — see the
  // measured probe in this ticket's report — so both parities are covered),
  // whitespace-only lines, NBSP, form feed, vertical tab, U+2028, U+2029, a
  // bare CR with no matching LF, leading and trailing blank lines, the
  // empty string, and a literal "\n\n" itself. Every shape appears BOTH in
  // the summary and inside a payload field, in the same string, at once —
  // not one shape per test — because the structural fix's whole claim is
  // that it does not matter which shape or how many: nothing here is ever
  // scanned for a delimiter.
  const ADVERSARIAL = [
    "\r\n\r\n",
    "\n\n\n",
    "\n\n\n\n\n\n\n",
    "\n   \n",
    "\n\t\t\n",
    "\n \n",
    "\n\f\n",
    "\n\n",
    "  ",
    "  ",
    "\r\r",
    "",
    "\n\n",
  ].join("|");
  const DIRTY = `before[${ADVERSARIAL}]after`;

  it("carries the summary through byte-for-byte, whatever shape it contains", () => {
    const content = joinSummaryAndPayload(DIRTY, { ok: true });
    expect(content[0].text).toBe(DIRTY);
  });

  it("payload survives round-trip through JSON with every adversarial shape inside a field", () => {
    const payload = { device: DIRTY, nested: { note: DIRTY }, list: [DIRTY] };
    const content = joinSummaryAndPayload(DIRTY, payload);
    expect(content).toHaveLength(2);
    const parsed = JSON.parse(content[1].text) as typeof payload;
    expect(parsed).toEqual(payload);
    expect(parsed.device).toBe(DIRTY);
  });

  it("no scan of either block ever happens — same result whether the summary appears before or after the payload's own delimiter-shaped text", () => {
    // There is no "first occurrence" to get confused: swapping which side
    // the adversarial text sits on cannot matter, because array position,
    // not string content, decides which block is which.
    const a = joinSummaryAndPayload(DIRTY, { x: "clean" });
    const b = joinSummaryAndPayload("clean summary", { x: DIRTY });
    expect(a[0].text).toBe(DIRTY);
    expect(JSON.parse(a[1].text)).toEqual({ x: "clean" });
    expect(b[0].text).toBe("clean summary");
    expect(JSON.parse(b[1].text)).toEqual({ x: DIRTY });
  });
});

// -----------------------------------------------------------------------------
// GRA-169 / GRA-171: a blank line in interpolated device data must not break
// ok()'s summary/payload split
// -----------------------------------------------------------------------------
//
// `ok()` used to join the human-readable summary and the JSON payload with a
// blank line, and every consumer of that convention — an agent reading the
// tool's own text, and this suite's own `parsePayload()` in
// testing/harness.ts — found the payload by looking for the FIRST blank line
// and parsing everything after it. hello.device and hello.packageName arrive
// over the wire from the device with nothing on either side guaranteeing
// they are single-line, so a blank line inside either one used to re-split
// every tool's answer at the wrong place: `parsePayload()` sliced from the
// middle of the summary's own prose, `JSON.parse` threw on it, and the
// tool's payload was gone, not merely mislabelled. GRA-169 fixed this by
// normalising the summary before appending the delimiter; GRA-171 removed
// the delimiter (and the normalisation defending it) entirely — summary and
// payload are now two separate `content` blocks (see `joinSummaryAndPayload`
// in index.ts), so there is no blank line, of any shape, for either field to
// collide with. These tests still exercise the real risk — hello.device and
// hello.packageName reaching a tool's prose unmodified from the wire — they
// just no longer need a delimiter to survive.
//
// Two different fields, not one — a single working case would prove the
// mechanism was fixed at its one measured trigger, not that interpolated
// data is safe in general. hello.device reaches all three tools through the
// shared `exitedProcessNotice()` sentence; hello.packageName reaches them
// independently through each tool's own "just connected, nothing buffered
// yet" branch. Two call sites, not one, for the same reason.
describe("GRA-169 / GRA-171: a blank line in interpolated device data must not break ok()'s summary/payload split", () => {
  const DIRTY_DEVICE = "Pixel\n\n7a (rooted)";
  const DIRTY_PACKAGE = "com.example\n\nshop";

  function helloOf(overrides: Partial<Record<string, unknown>>) {
    return {
      protocol: 1,
      packageName: "com.example.shop",
      processName: "com.example.shop",
      versionName: "1.0.0-test",
      device: "Test Device",
      sdkInt: 34,
      startedAt: 0,
      collectors: [],
      ...overrides,
    };
  }

  /**
   * A rig whose `lastExited` names a process with `hello`, then left
   * disconnected — the scenario that makes every tool's shared
   * `exitedProcessNotice()` prepend `"${packageName} on ${device} exited at
   * ..."` to its summary. This is the one sentence, reachable identically
   * from all three tools, that puts hello.device into prose (mirrors the
   * "a stale ring..." (GRA-163) describe block above, which is where this
   * fixture pattern comes from).
   */
  async function buildExitedRig(hello: Record<string, unknown>): Promise<Rig> {
    const rig = await buildRig({ handlers: { hello: () => hello } });
    await rig.pushEvents([{ event: "recompose", t: 1_000, data: { name: "Cart" } }]);
    rig.fakeDevice.disconnectAll();
    await waitUntil(() => rig.device.state === "disconnected");
    return rig;
  }

  describe("hello.device contains a blank line (via the shared exited-process notice)", () => {
    const hello = helloOf({ device: DIRTY_DEVICE });

    // A case per tool, not a shared loop over the three — an assertion
    // inside a loop is eager and stops at the first failure, which would
    // prove only that the first tool in the list is defended (see this
    // project's "one edit reddened N tests" lesson). Three independent
    // `it()`s means a regression in any one tool is visible on its own.
    it("porthole_status's payload is still parseable", async () => {
      const rig = await buildExitedRig(hello);
      try {
        const result = await rig.client.callTool("porthole_status", {});
        expect(result.text).toContain("Pixel");
        expect(result.text).toContain("(rooted)");
        expect(result.json, "payload must survive a blank line in hello.device").not.toBeUndefined();
        // The payload itself was never at risk — JSON.stringify escapes the
        // newline as `\n`, not a raw line break — so the structured field
        // must still carry the value verbatim, blank line and all.
        expect((result.json as { exitedProcess: { device: string } }).exitedProcess.device).toBe(
          DIRTY_DEVICE,
        );
      } finally {
        await rig.close();
      }
    });

    it("findings's payload is still parseable", async () => {
      const rig = await buildExitedRig(hello);
      try {
        const result = await rig.client.callTool("findings", {});
        expect(result.text).toContain("Pixel");
        expect(result.text).toContain("(rooted)");
        expect(result.json, "payload must survive a blank line in hello.device").not.toBeUndefined();
        expect((result.json as { exitedProcess: { device: string } }).exitedProcess.device).toBe(
          DIRTY_DEVICE,
        );
      } finally {
        await rig.close();
      }
    });

    it("what_was_happening's payload is still parseable", async () => {
      const rig = await buildExitedRig(hello);
      try {
        const result = await rig.client.callTool("what_was_happening", { at: 1_000 });
        expect(result.text).toContain("Pixel");
        expect(result.text).toContain("(rooted)");
        expect(result.json, "payload must survive a blank line in hello.device").not.toBeUndefined();
        expect((result.json as { exitedProcess: { device: string } }).exitedProcess.device).toBe(
          DIRTY_DEVICE,
        );
      } finally {
        await rig.close();
      }
    });
  });

  describe("hello.packageName contains a blank line (via each tool's own \"just connected\" branch)", () => {
    const hello = helloOf({ packageName: DIRTY_PACKAGE });

    it("porthole_status's payload is still parseable on the ordinary connected summary", async () => {
      const rig = await buildRig({ handlers: { hello: () => hello } });
      try {
        const result = await rig.client.callTool("porthole_status", {});
        expect(result.text).toContain("com.example");
        expect(result.text).toContain("shop");
        expect(result.json, "payload must survive a blank line in hello.packageName").not.toBeUndefined();
        expect((result.json as { app: { packageName: string } }).app.packageName).toBe(DIRTY_PACKAGE);
      } finally {
        await rig.close();
      }
    });

    it("findings's payload is still parseable with an empty, just-connected ring", async () => {
      const rig = await buildRig({ handlers: { hello: () => hello } });
      try {
        const result = await rig.client.callTool("findings", {});
        expect(result.text).toContain("com.example");
        expect(result.text).toContain("shop");
        expect(result.json, "payload must survive a blank line in hello.packageName").not.toBeUndefined();
      } finally {
        await rig.close();
      }
    });

    it("what_was_happening's payload is still parseable with an empty, just-connected ring", async () => {
      const rig = await buildRig({ handlers: { hello: () => hello } });
      try {
        const result = await rig.client.callTool("what_was_happening", {});
        expect(result.text).toContain("com.example");
        expect(result.text).toContain("shop");
        expect(result.json, "payload must survive a blank line in hello.packageName").not.toBeUndefined();
      } finally {
        await rig.close();
      }
    });
  });

  // GRA-171: this test used to prove (per QA round 1's correction of the
  // comment that sat here) only that `ok()`'s happy path survived a device
  // value with more than the minimal two newlines — the post-collapse throw
  // guard it was originally written to exercise was never actually reached
  // by it. That guard is deleted now (see index.ts), so there is nothing
  // left for a test at this spot to prove about a guard. What replaced it:
  // the structural fix's actual, positive claim — that the summary no
  // longer needs to be rewritten at all — end to end through the real rig,
  // not just through `joinSummaryAndPayload()` directly (see the GRA-171
  // describe block above for that).
  it("porthole_status's payload still parses AND its summary keeps the device's blank lines verbatim, unlike GRA-169's collapsed prose", async () => {
    const DIRTY = "Two\n\n\n\nblank lines\r\n\r\nand a CRLF one";
    const hello = helloOf({ device: DIRTY });
    const rig = await buildExitedRig(hello);
    try {
      const result = await rig.client.callTool("porthole_status", {});
      // Structural proof: exactly one summary block and one payload block,
      // by array shape — not "a blank line found somewhere in the text".
      expect(result.content.filter((c) => c.type === "text")).toHaveLength(2);
      expect(result.json, "payload must survive a blank line in hello.device").not.toBeUndefined();
      expect((result.json as { exitedProcess: { device: string } }).exitedProcess.device).toBe(DIRTY);
      // Prose-fidelity proof: GRA-169's `collapseBlankLines()` would have
      // turned every one of DIRTY's blank lines into a single space before
      // this text ever reached the summary block — asserting the raw value
      // survives INSIDE the summary (not just the payload) is what pins
      // "a structural delimiter does not need to touch the prose at all"
      // as a behaviour, not just a claim in a comment.
      expect(result.text).toContain(DIRTY);
    } finally {
      await rig.close();
    }
  });
});

// GRA-58: porthole_status's `exits` section and `exitTrace` parameter,
// through the real tool against a FakeDevice that answers `exit_trace` --
// not a unit test of a helper function, the behavioural half surface.test.ts
// cannot cover (it only reads index.ts as text / the schema).
describe("porthole_status: why the app died (GRA-58)", () => {
  const exitData = (overrides: Record<string, unknown> = {}) => ({
    reason: "REASON_ANR",
    importance: 100,
    timestamp: 1_700_000_000_000,
    pss: 12_345,
    rss: 23_456,
    versionName: "1.2.3",
    versionAssumed: false,
    mainStack: "com.example.shop.Cart.load(Cart.kt:9)\nandroid.app.Activity.performCreate(Activity.java:1)",
    otherThreadCount: 2,
    otherThreadStates: { Waiting: 2 },
    ...overrides,
  });

  it("reports the most recent exits, newest first, each naming reason/build/top frame", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents([
        { event: "exit", t: 1000, data: exitData({ timestamp: 1_700_000_000_000, reason: "REASON_CRASH" }) },
        { event: "exit", t: 2000, data: exitData({ timestamp: 1_700_000_100_000, reason: "REASON_ANR" }) },
      ]);

      const status = await rig.client.callTool("porthole_status", {});
      expect(status.isError).toBeFalsy();
      const exits = (status.json as { exits: { recent: Array<Record<string, unknown>> } }).exits;
      expect(exits.recent).toHaveLength(2);
      // Newest first: the second-pushed event (a later `timestamp`) leads.
      expect(exits.recent[0].reason).toBe("REASON_ANR");
      expect(exits.recent[0].topAppFrame).toContain("com.example.shop.Cart.load");
      expect(exits.recent[0].versionName).toBe("1.2.3");
      expect(exits.recent[1].reason).toBe("REASON_CRASH");
    } finally {
      await rig.close();
    }
  });

  it("caps the recent list rather than growing it without bound", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents(
        Array.from({ length: 15 }, (_, i) => ({
          event: "exit",
          t: 1000 + i,
          data: exitData({ timestamp: 1_700_000_000_000 + i * 1000 }),
        })),
      );
      const status = await rig.client.callTool("porthole_status", {});
      const exits = (status.json as { exits: { recent: unknown[] } }).exits;
      expect(exits.recent.length).toBeLessThanOrEqual(10);
    } finally {
      await rig.close();
    }
  });

  it("says the API is unavailable below API 30, sourced from hello.sdkInt alone", async () => {
    const rig = await buildRig({ handlers: { hello: () => ({ ...defaultHello(), sdkInt: 28 }) } });
    try {
      const status = await rig.client.callTool("porthole_status", {});
      const exits = (status.json as { exits: { apiUnavailable: string | null } }).exits;
      expect(exits.apiUnavailable).toContain("API 30");
      expect(exits.apiUnavailable).toContain("28");
    } finally {
      await rig.close();
    }
  });

  it("says nothing is unavailable at or above API 30", async () => {
    const rig = await buildRig();
    try {
      const status = await rig.client.callTool("porthole_status", {});
      const exits = (status.json as { exits: { apiUnavailable: string | null } }).exits;
      expect(exits.apiUnavailable).toBeNull();
    } finally {
      await rig.close();
    }
  });

  it("says the app is not connected because it died, and why, when the last exit is recent", async () => {
    const rig = await buildRingInState("disconnected", [
      { event: "exit", t: 1000, data: exitData({ timestamp: Date.now() - 5_000 }) },
    ]);
    try {
      const status = await rig.client.callTool("porthole_status", {});
      expect(status.text).toContain("died");
      expect(status.text).toContain("REASON_ANR");
    } finally {
      await rig.close();
    }
  });

  it("says nothing extra when the most recent exit is old", async () => {
    const rig = await buildRingInState("disconnected", [
      { event: "exit", t: 1000, data: exitData({ timestamp: Date.now() - 60 * 60 * 1000 }) },
    ]);
    try {
      const status = await rig.client.callTool("porthole_status", {});
      expect(status.text).not.toContain("died:");
    } finally {
      await rig.close();
    }
  });

  it("leaves exitTrace null in the payload when the parameter is omitted", async () => {
    const rig = await buildRig();
    try {
      const status = await rig.client.callTool("porthole_status", {});
      expect((status.json as { exitTrace: unknown }).exitTrace).toBeNull();
    } finally {
      await rig.close();
    }
  });

  it("fetches the full redacted trace through exit_trace when exitTrace is given", async () => {
    const rig = await buildRig({
      handlers: {
        exit_trace: (params) => ({
          timestamp: params.timestamp,
          found: true,
          text: "\"main\" prio=5 tid=1 Native\n  at com.example.shop.Cart.load(Cart.kt:9)",
          truncated: false,
        }),
      },
    });
    try {
      const status = await rig.client.callTool("porthole_status", { exitTrace: 1_700_000_000_000 });
      expect(status.isError).toBeFalsy();
      const exitTrace = (status.json as { exitTrace: { found: boolean; text: string; timestamp: number } })
        .exitTrace;
      expect(exitTrace.found).toBe(true);
      expect(exitTrace.timestamp).toBe(1_700_000_000_000);
      expect(exitTrace.text).toContain("com.example.shop.Cart.load");
    } finally {
      await rig.close();
    }
  });

  it("reports found:false for a timestamp the device does not recognise, without failing the call", async () => {
    const rig = await buildRig({
      handlers: {
        exit_trace: (params) => ({
          timestamp: params.timestamp,
          found: false,
          error: `no exit recorded for timestamp ${params.timestamp}`,
        }),
      },
    });
    try {
      const status = await rig.client.callTool("porthole_status", { exitTrace: 999 });
      expect(status.isError).toBeFalsy();
      const exitTrace = (status.json as { exitTrace: { found: boolean; error: string } }).exitTrace;
      expect(exitTrace.found).toBe(false);
      expect(exitTrace.error).toContain("999");
    } finally {
      await rig.close();
    }
  });

  // GRA-188: `exitTrace` now accepts a string too (see below), so an empty
  // or garbage string is no longer refused by zod before the handler runs —
  // it reaches the handler's own `Date.parse` check and is refused there,
  // with one line. `isError: true` either way is the property that must
  // survive; the mechanism moved.
  it("rejects an empty exitTrace inside the handler, with one line naming why", async () => {
    const rig = await buildRig();
    try {
      const result = await rig.client.callTool("porthole_status", { exitTrace: "" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("exitTrace");
      expect(result.text).toMatch(/not a valid/i);
    } finally {
      await rig.close();
    }
  });

  it("rejects a malformed (non-parseable) exitTrace inside the handler, with one line naming why", async () => {
    const rig = await buildRig();
    try {
      const result = await rig.client.callTool("porthole_status", { exitTrace: "not-a-timestamp" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not-a-timestamp");
      expect(result.text).toMatch(/not a valid/i);
    } finally {
      await rig.close();
    }
  });

  it("rejects a negative exitTrace before the handler ever runs (the number branch is unchanged)", async () => {
    const rig = await buildRig();
    try {
      const result = await rig.client.callTool("porthole_status", { exitTrace: -5 });
      expect(result.isError).toBe(true);
    } finally {
      await rig.close();
    }
  });

  it("accepts the ISO `at` string exits.recent prints, and fetches the same trace the epoch timestamp would (GRA-188)", async () => {
    const rig = await buildRig({
      handlers: {
        exit_trace: (params) => ({
          timestamp: params.timestamp,
          found: true,
          text: "\"main\" prio=5 tid=1 Native\n  at com.example.shop.Cart.load(Cart.kt:9)",
          truncated: false,
        }),
      },
    });
    try {
      await rig.pushEvents([{ event: "exit", t: 1000, data: exitData({ timestamp: 1_700_000_000_000 }) }]);
      const status = await rig.client.callTool("porthole_status", {});
      const exits = (status.json as { exits: { recent: Array<{ timestamp: number; at: string }> } }).exits;
      expect(exits.recent[0].timestamp).toBe(1_700_000_000_000);
      expect(exits.recent[0].at).toBe(new Date(1_700_000_000_000).toISOString());

      // The obvious next move the device pass measured failing: quote `at` back.
      const traced = await rig.client.callTool("porthole_status", { exitTrace: exits.recent[0].at });
      expect(traced.isError).toBeFalsy();
      const exitTrace = (traced.json as { exitTrace: { found: boolean; timestamp: number; text: string } })
        .exitTrace;
      expect(exitTrace.found).toBe(true);
      expect(exitTrace.timestamp).toBe(1_700_000_000_000);
      expect(exitTrace.text).toContain("com.example.shop.Cart.load");
    } finally {
      await rig.close();
    }
  });

  function defaultHello() {
    return {
      protocol: 1,
      packageName: "com.example.shop",
      processName: "com.example.shop",
      versionName: "1.0.0-test",
      device: "Test Device",
      sdkInt: 34,
      startedAt: DEFAULT_STARTED_AT_MS,
      collectors: ["recompositions"],
    };
  }
});

/**
 * The dispatcher a fake "adb" child process runs, before Node ever attempts
 * to load its own first CLI argument as a module.
 *
 * `setupFakeAdb` below points `findAdb()` at a hard link to the *real*
 * `node` binary, named `adb`/`adb.exe`, and sets `NODE_OPTIONS=--require=…`
 * to this file. `--require` preloads run before Node tries to resolve its
 * own argv[1] as an entry module, and — critically — Node has already
 * rewritten argv[1] into an absolute path by that point (`path.resolve`
 * against argv[1] as given, before any file even needs to exist), so this
 * reads the SUBCOMMAND back off that path's *basename* rather than
 * comparing it for exact equality against "pull"/"shell". Everything this
 * does is synchronous, ending in `process.exit()`, specifically so Node
 * never reaches the point of actually trying to load that resolved path as
 * a module — which would fail, loudly, since "pull" and "shell" are not
 * real files.
 *
 * `sleepSync` blocks *this child process* for real — proven against a real
 * OS process is the whole point, matching perfetto.test.ts's own reason for
 * driving `runScript` against `cmd.exe`/`/bin/sh` rather than a hand-rolled
 * fake — but it never touches the MCP server's own event loop, which is the
 * property GRA-89's test actually needs: the parent process spawned this
 * child with `runAdbAsync` and is free to do other work for as long as this
 * sleeps.
 */
const FAKE_ADB_PRELOAD_SOURCE = `
const fs = require("fs");
const path = require("path");

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

// GRA-186: appends this invocation's tag to PORTHOLE_TEST_ORDER_LOG, when
// set, so a test can read back the sequence adb calls actually ran in —
// each invocation is its own OS process, so there is no shared in-memory
// array to push onto, only a file both sides can see.
function logOrder(tag) {
  const logPath = process.env.PORTHOLE_TEST_ORDER_LOG;
  if (logPath) fs.appendFileSync(logPath, tag + "\\n");
}

const raw = process.argv.slice(1);
const resolved = raw.length > 0 ? [path.basename(raw[0]), ...raw.slice(1)] : raw;
let a = resolved;
if (a[0] === "-s") a = a.slice(2);

if (a[0] === "pull") {
  logOrder("pull");
  fs.writeFileSync(a[2], "porthole: fake-adb-pulled-trace\\n");
  process.stdout.write(a[1] + ": 1 file pulled.\\n");
  process.exit(0);
}
if (a[0] === "shell" && a[1] === "rm") {
  logOrder("cleanup");
  process.exit(0);
}
if (a[0] === "shell" && a[1] === "perfetto") {
  logOrder("perfetto-start");
  // GRA-186: touches a marker file the instant this "session" starts, so a
  // concurrent "shell test -e <devicePath>" call (see below) can tell a
  // capture is under way without waiting for it to finish — the same signal
  // waitForCaptureToStart polls for in index.ts, standing in for perfetto
  // actually creating its output file on-device at session start.
  const oIndex = a.indexOf("-o");
  const devicePath = oIndex >= 0 ? a[oIndex + 1] : null;
  const markerDir = process.env.PORTHOLE_TEST_MARKER_DIR;
  if (devicePath && markerDir) {
    fs.writeFileSync(path.join(markerDir, path.basename(devicePath) + ".started"), "1");
  }
  const tIndex = a.indexOf("-t");
  const durationToken = tIndex >= 0 ? a[tIndex + 1] : "1s";
  const seconds = parseInt(durationToken, 10) || 1;
  sleepSync(seconds * 1000);
  process.exit(0);
}
if (a[0] === "shell" && a[1] === "test" && a[2] === "-e") {
  const devicePath = a[3];
  const markerDir = process.env.PORTHOLE_TEST_MARKER_DIR;
  const markerFile = markerDir ? path.join(markerDir, path.basename(devicePath) + ".started") : null;
  process.exit(markerFile && fs.existsSync(markerFile) ? 0 : 1);
}
if (a[0] === "shell" && a[1] === "am" && a[2] === "force-stop") {
  logOrder("force-stop");
  process.exit(0);
}
// GRA-233: resolve-activity is never configured to succeed in this file's
// own fixture — every restart/launch this preload drives falls back to
// monkey, the same as before this ticket, so the "force-stop"/"launch"
// ordering these tests already pin stays exactly as it was.
if (a[0] === "shell" && a[1] === "cmd" && a[2] === "package" && a[3] === "resolve-activity") {
  process.stderr.write("No activity found\\n");
  process.exit(1);
}
if (a[0] === "shell" && a[1] === "monkey") {
  logOrder("launch");
  // GRA-186 self-check (a): PORTHOLE_TEST_MONKEY_FAIL simulates the
  // "package is not installed" case — a real device's monkey exits non-zero
  // with no "Events injected" line when there is no launcher activity to hit.
  if (process.env.PORTHOLE_TEST_MONKEY_FAIL === "1") {
    process.stderr.write("No activities found to run, monkey aborted.\\n");
    process.exit(1);
  }
  // GRA-233: touches the same marker directory waitForCaptureToStart's own
  // marker uses, so the pidof handler below can honestly answer "is it up"
  // instead of every restart/launch in this file needing its own opt-in.
  const markerDir = process.env.PORTHOLE_TEST_MARKER_DIR;
  if (markerDir) fs.writeFileSync(path.join(markerDir, "app-running"), "1");
  process.stdout.write("Events injected: 1\\n");
  process.exit(0);
}
// GRA-233: restartAppAsync/launchAppAsync poll this after the launch step —
// "up" exactly when the monkey handler above most recently marked it so,
// never unconditionally, so the monkey-fails self-check still sees no
// process and reports the real failure.
if (a[0] === "shell" && a[1] === "pidof") {
  const markerDir = process.env.PORTHOLE_TEST_MARKER_DIR;
  const markerFile = markerDir ? path.join(markerDir, "app-running") : null;
  if (markerFile && fs.existsSync(markerFile)) {
    process.stdout.write("12345\\n");
    process.exit(0);
  }
  process.exit(1);
}
process.stderr.write("fake-adb: unhandled args " + JSON.stringify(a) + "\\n");
process.exit(17);
`;

interface FakeAdb {
  /** Pass as `adbBinary` to `buildRig` — `capture_system_trace`'s adb calls run this instead of resolving a real one. */
  binaryPath: string;
  /** Pass as `adbEnv` (spread over `process.env`) — this is what makes `binaryPath` run FAKE_ADB_PRELOAD_SOURCE instead of trying to load its own CLI args as modules. */
  env: NodeJS.ProcessEnv;
  /** GRA-186: the order every "shell"/"pull" invocation ran in, one tag per line, oldest first — see `logOrder` in FAKE_ADB_PRELOAD_SOURCE. */
  order(): string[];
  cleanup(): void;
}

/**
 * A controllable stand-in for adb.
 *
 * Deliberately returns a `binary` path and an `env` object for the caller to
 * pass to `buildRig({ adbBinary, adbEnv })` — see `PortholeServerOptions` in
 * index.ts — rather than mutating `process.env` itself. `NODE_OPTIONS` is
 * what makes `binaryPath` (a hard link to the real `node` binary) run
 * `FAKE_ADB_PRELOAD_SOURCE` instead of trying to load its own CLI arguments
 * as a module, and setting that on the real, shared `process.env` for the
 * duration of a multi-second capture is exactly what caused this test to
 * intermittently break an unrelated `cli.test.ts` case that spawns its own
 * child process — see `runAdbAsync`'s `env` option doc comment in adb.ts.
 * Building the env value here and handing it to one specific rig's server
 * removes the shared global instead of narrowing the window it is exposed
 * for.
 *
 * GRA-186: `extraEnv` lets one test override `PORTHOLE_TEST_MONKEY_FAIL`
 * without every other caller of this function having to know that variable
 * exists — the same "build the env value here, do not mutate the shared
 * one" reasoning as `NODE_OPTIONS` above, just for a second variable.
 */
function setupFakeAdb(extraEnv: NodeJS.ProcessEnv = {}): FakeAdb {
  const root = mkdtempSync(path.join(tmpdir(), "porthole-fakeadb-"));
  const binaryName = process.platform === "win32" ? "adb.exe" : "adb";
  const binaryPath = path.join(root, binaryName);
  if (process.platform === "win32") {
    // Always a copy on Windows. A hard link to the running node.exe can
    // never be unlinked while this test runner is alive — Windows refuses
    // with EPERM for every link to an in-use executable, not only the path
    // that was launched — and CI's windows leg failed on exactly that twice,
    // retries included. A copy the child ran and exited is deletable.
    copyFileSync(process.execPath, binaryPath);
  } else {
    try {
      // A hard link, not a copy: same bytes, no ~90MB copy per test run.
      // Falls back to copying only if the temp directory is not on the same
      // volume as the running node binary, which a hard link cannot span.
      linkSync(process.execPath, binaryPath);
    } catch {
      copyFileSync(process.execPath, binaryPath);
    }
  }

  const preloadPath = path.join(root, "fake-adb-preload.cjs");
  writeFileSync(preloadPath, FAKE_ADB_PRELOAD_SOURCE);

  // GRA-186: markerDir is where the fake "perfetto" process touches a file
  // the instant it starts, and where a concurrent "shell test -e" call looks
  // for it — see FAKE_ADB_PRELOAD_SOURCE. orderLog is a flat append-only
  // file every invocation writes its own tag to, so the sequence of real OS
  // processes that ran can be read back after the fact.
  const markerDir = path.join(root, "markers");
  mkdirSync(markerDir, { recursive: true });
  const orderLogPath = path.join(root, "order.log");
  writeFileSync(orderLogPath, "");

  return {
    binaryPath,
    env: {
      ...process.env,
      ...extraEnv,
      NODE_OPTIONS: `--require=${preloadPath}`,
      PORTHOLE_TEST_MARKER_DIR: markerDir,
      PORTHOLE_TEST_ORDER_LOG: orderLogPath,
    },
    order() {
      return readFileSync(orderLogPath, "utf8").split("\n").filter(Boolean);
    },
    cleanup() {
      // Windows can refuse to unlink a just-exited executable for a moment
      // (EPERM while the OS or an antivirus scanner still holds it); CI's
      // windows leg hit exactly that on the first run. Retrying is the
      // documented remedy, and nothing here depends on the directory being
      // gone instantly.
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

describe("GRA-89: capture_system_trace does not block the server while it runs", () => {
  it("keeps answering porthole_status and buffering pushed events during a multi-second capture, against a fake adb", async () => {
    const fakeAdb = setupFakeAdb();
    const outputDir = mkdtempSync(path.join(tmpdir(), "porthole-capture-out-"));

    // adbBinary/adbEnv (GRA-89) point this ONE rig's capture_system_trace
    // calls at the fake adb, without touching the real process.env — see
    // setupFakeAdb's own doc comment for why that distinction matters.
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      const seconds = 3;
      const started = Date.now();
      const capturePromise = rig.client.callTool("capture_system_trace", { seconds, outputDir });

      // The fake device is "recording" for `seconds` real seconds in a
      // separate OS process (see FAKE_ADB_PRELOAD_SOURCE's sleepSync) while
      // `capturePromise` is still pending. Both calls below must complete
      // in a small fraction of that time — the only way that is possible is
      // if `capture_system_trace`'s adb calls are not blocking this
      // process's one event loop, which is GRA-89's whole point. A
      // regression back to `runAdb`'s `spawnSync` would freeze this whole
      // process for the recording's duration, and these calls would not
      // return until after it did.
      const status = await rig.client.callTool("porthole_status", {});
      const statusElapsedMs = Date.now() - started;
      expect(status.isError).toBeFalsy();
      expect(statusElapsedMs).toBeLessThan(1_500);

      await rig.pushEvents([{ event: "recompose", t: 5_000, data: { name: "Cart" } }]);
      const eventsElapsedMs = Date.now() - started;
      const bufferedDuringCapture = rig.timeline.buffer().length;
      expect(eventsElapsedMs).toBeLessThan(1_500);
      expect(bufferedDuringCapture).toBeGreaterThan(0);

      const capture = await capturePromise;
      const totalElapsedMs = Date.now() - started;
      expect(capture.isError).toBeFalsy();
      expect(capture.json).toMatchObject({ seconds });
      // Confirms the fake adb's sleep really ran for the requested duration
      // rather than the capture short-circuiting some other way.
      expect(totalElapsedMs).toBeGreaterThanOrEqual(seconds * 1000 - 250);
    } finally {
      await rig.close();
      fakeAdb.cleanup();
      rmSync(outputDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 20_000);
});

describe("GRA-186: capture_system_trace can restart the app mid-capture", () => {
  it("with restartApp: true, force-stops and relaunches the app right after the recording starts, in order, then pulls and cleans up", async () => {
    const fakeAdb = setupFakeAdb();
    const outputDir = mkdtempSync(path.join(tmpdir(), "porthole-capture-out-"));
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      const capture = await rig.client.callTool("capture_system_trace", {
        seconds: 2,
        outputDir,
        packages: ["com.example.shop"],
        restartApp: true,
      });
      expect(capture.isError).toBeFalsy();
      expect(capture.json).toMatchObject({ restarted: true, apps: ["com.example.shop"] });
      // The whole point of GRA-186: the restart happens WHILE the recording
      // is under way, not before it (there would be nothing to enable the
      // tag for yet) and not after (the window would already be over) — so
      // "perfetto-start" must lead "force-stop"/"launch", which in turn must
      // lead the pull/cleanup that only run once the recording resolves.
      expect(fakeAdb.order()).toEqual(["perfetto-start", "force-stop", "launch", "pull", "cleanup"]);
    } finally {
      await rig.close();
      fakeAdb.cleanup();
      rmSync(outputDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 20_000);

  it("with restartApp omitted (the default), nothing is force-stopped or relaunched", async () => {
    const fakeAdb = setupFakeAdb();
    const outputDir = mkdtempSync(path.join(tmpdir(), "porthole-capture-out-"));
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      const capture = await rig.client.callTool("capture_system_trace", {
        seconds: 1,
        outputDir,
        packages: ["com.example.shop"],
      });
      expect(capture.isError).toBeFalsy();
      expect(capture.json).toMatchObject({ restarted: false });
      const order = fakeAdb.order();
      expect(order).not.toContain("force-stop");
      expect(order).not.toContain("launch");
      expect(order).toEqual(["perfetto-start", "pull", "cleanup"]);
    } finally {
      await rig.close();
      fakeAdb.cleanup();
      rmSync(outputDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 20_000);

  it("self-check (a): restartApp true with no package attached and none named skips the restart with a stated reason, rather than failing the whole capture", async () => {
    const fakeAdb = setupFakeAdb();
    const outputDir = mkdtempSync(path.join(tmpdir(), "porthole-capture-out-"));
    // connectDevice: false leaves device.hello null and state "disconnected"
    // (not "handshaking"), so the existing GRA-157 early-return does not
    // fire and this reaches the GRA-186 code with apps === [].
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env, connectDevice: false });
    try {
      const capture = await rig.client.callTool("capture_system_trace", {
        seconds: 1,
        outputDir,
        restartApp: true,
      });
      expect(capture.isError).toBeFalsy();
      expect(capture.json).toMatchObject({ restarted: false, apps: [] });
      const notes = (capture.json as { notes: string[] }).notes.join(" ");
      expect(notes).toContain(
        "Could not restart the app for this capture: no package is attached or named, so there is nothing to restart.",
      );
      // Confirms this is genuinely a skip, not a restart that silently failed.
      expect(fakeAdb.order()).not.toContain("force-stop");
    } finally {
      await rig.close();
      fakeAdb.cleanup();
      rmSync(outputDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 20_000);

  it("self-check (a): restartApp true with a package that is not installed reports the launch failure and still returns the capture", async () => {
    const fakeAdb = setupFakeAdb({ PORTHOLE_TEST_MONKEY_FAIL: "1" });
    const outputDir = mkdtempSync(path.join(tmpdir(), "porthole-capture-out-"));
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      const capture = await rig.client.callTool("capture_system_trace", {
        seconds: 1,
        outputDir,
        packages: ["com.example.shop"],
        restartApp: true,
      });
      expect(capture.isError).toBeFalsy();
      expect(capture.json).toMatchObject({ restarted: false });
      const notes = (capture.json as { notes: string[] }).notes.join(" ");
      expect(notes).toContain("Could not restart com.example.shop for this capture:");
      expect(notes).toContain("No activities found to run, monkey aborted.");
      // The force-stop half still ran — only the launch failed.
      expect(fakeAdb.order()).toEqual(["perfetto-start", "force-stop", "launch", "pull", "cleanup"]);
    } finally {
      await rig.close();
      fakeAdb.cleanup();
      rmSync(outputDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 20_000);
});

describe("GRA-201: tools attach where when PORTHOLE_PROJECT_ROOT points at a real project", () => {
  // The same fixture sources.test.ts uses: two modules,
  // FixtureCartViewModel.kt under app/, ApiClient.kt under core/network/,
  // and a Fixture.PromoField portholeNode label in FixtureScreens.kt --
  // named distinctly from the real sample app so a walk rooted at the
  // whole worktree never finds both and calls them ambiguous.
  const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/sources", import.meta.url));

  let savedProjectRoot: string | undefined;

  function withProjectRoot(root: string | undefined): void {
    if (root === undefined) delete process.env.PORTHOLE_PROJECT_ROOT;
    else process.env.PORTHOLE_PROJECT_ROOT = root;
  }

  it("blocking attaches where to a stall whose top frame names a file under the root", async () => {
    savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
    resetSourceIndexForTests();
    withProjectRoot(FIXTURE_ROOT);
    const rig = await buildRig({
      handlers: {
        blocking: () => ({
          stalls: [
            {
              durationMs: 900,
              stack: "com.example.shop.ui.FixtureCartViewModel.blockTheMainThread(FixtureCartViewModel.kt:11)",
            },
          ],
          mainThreadQueries: [],
          stallThresholdMs: 700,
        }),
      },
    });
    try {
      const result = await rig.client.callTool("blocking", {});
      expect(result.isError).toBeFalsy();
      const stalls = (result.json as { stalls: Array<{ where?: unknown }> }).stalls;
      expect(stalls[0].where).toEqual({
        resolved: true,
        path: "app/src/main/kotlin/com/example/shop/ui/FixtureCartViewModel.kt",
        line: 11,
      });
    } finally {
      await rig.close();
      withProjectRoot(savedProjectRoot);
      resetSourceIndexForTests();
    }
  });

  it("recompositions attaches where to a node resolved via its portholeNode label, not its declaring function", async () => {
    savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
    resetSourceIndexForTests();
    withProjectRoot(FIXTURE_ROOT);
    const rig = await buildRig({
      handlers: {
        recompositions: () => ({
          nodes: [{ name: "Fixture.PromoField", count: 42, triggeredBy: [] }],
          totalNodes: 1,
          truncated: false,
          unattributedWrites: [],
        }),
      },
    });
    try {
      const result = await rig.client.callTool("recompositions", {});
      expect(result.isError).toBeFalsy();
      const nodes = (result.json as { nodes: Array<{ where?: unknown }> }).nodes;
      expect(nodes[0].where).toEqual({
        resolved: true,
        path: "app/src/main/kotlin/com/example/shop/ui/FixtureScreens.kt",
        line: 14,
      });
    } finally {
      await rig.close();
      withProjectRoot(savedProjectRoot);
      resetSourceIndexForTests();
    }
  });

  it("recompositions joins the compose report and reports why LeakyRow is not skippable, in the compiler's own words (GRA-69)", async () => {
    savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
    resetSourceIndexForTests();
    resetComposeReportCacheForTests();
    withProjectRoot(FIXTURE_ROOT);
    const moduleRoot = path.join(FIXTURE_ROOT, "app");
    const reportDir = path.join(moduleRoot, "build", "porthole");
    mkdirSync(reportDir, { recursive: true });
    const reportFile = path.join(reportDir, "compose-report.json");
    writeFileSync(
      reportFile,
      JSON.stringify({
        generatedAt: "now",
        variant: "debug",
        module: "app",
        kotlinVersion: "2.1.0",
        gitHead: "abc",
        sourceFingerprint: currentSourceFingerprint(moduleRoot),
        composables: [
          {
            name: "FixtureCartScreen",
            packageName: "com.example.shop.ui",
            restartable: true,
            skippable: false,
            parameters: [{ name: "modifier", type: "RowHighlight", stable: false, unused: false }],
          },
        ],
        classes: [
          {
            name: "RowHighlight",
            stable: false,
            runtimeStability: "Unstable",
            properties: [{ name: "tappedAt", mutable: true, stable: true, type: "Long" }],
          },
        ],
      }),
    );
    const rig = await buildRig({
      handlers: {
        recompositions: () => ({
          nodes: [{ name: "Fixture.PromoField", count: 900, triggeredBy: [] }],
          totalNodes: 1,
          truncated: false,
          unattributedWrites: [],
        }),
      },
    });
    try {
      const result = await rig.client.callTool("recompositions", {});
      expect(result.isError).toBeFalsy();
      const nodes = (result.json as { nodes: Array<{ composeReport?: Record<string, unknown> }> }).nodes;
      expect(nodes[0].composeReport).toMatchObject({
        joined: true,
        enclosingFunction: "FixtureCartScreen",
        module: "app",
        skippable: false,
        stale: false,
      });
      expect((nodes[0].composeReport as { notSkippableReason?: string }).notSkippableReason).toContain(
        "`FixtureCartScreen` is restartable but not skippable",
      );
      expect((nodes[0].composeReport as { notSkippableReason?: string }).notSkippableReason).toContain(
        "`RowHighlight` is unstable because it has a `var` property (`tappedAt`)",
      );
    } finally {
      await rig.close();
      withProjectRoot(savedProjectRoot);
      resetSourceIndexForTests();
      rmSync(reportDir, { recursive: true, force: true });
      resetComposeReportCacheForTests();
    }
  });

  it("D6 (QA): recompositions never publishes a stale report's skippable verdict, but does say how old it is", async () => {
    savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
    resetSourceIndexForTests();
    resetComposeReportCacheForTests();
    withProjectRoot(FIXTURE_ROOT);
    const moduleRoot = path.join(FIXTURE_ROOT, "app");
    const reportDir = path.join(moduleRoot, "build", "porthole");
    mkdirSync(reportDir, { recursive: true });
    const reportFile = path.join(reportDir, "compose-report.json");
    writeFileSync(
      reportFile,
      JSON.stringify({
        generatedAt: "2026-09-20T04:10:00.000Z",
        variant: "debug",
        module: "app",
        kotlinVersion: "2.1.0",
        gitHead: "a1b2c3d",
        // Never equal to a real computed hash — stale by construction.
        sourceFingerprint: "stale-fingerprint-that-never-matches",
        composables: [
          {
            name: "FixtureCartScreen",
            packageName: "com.example.shop.ui",
            restartable: true,
            skippable: false,
            parameters: [],
          },
        ],
        classes: [],
      }),
    );
    const rig = await buildRig({
      handlers: {
        recompositions: () => ({
          nodes: [{ name: "Fixture.PromoField", count: 900, triggeredBy: [] }],
          totalNodes: 1,
          truncated: false,
          unattributedWrites: [],
        }),
      },
    });
    try {
      const result = await rig.client.callTool("recompositions", {});
      expect(result.isError).toBeFalsy();
      const nodes = (result.json as { nodes: Array<{ composeReport?: Record<string, unknown> }> }).nodes;
      // Mutation quoted: dropping the `if (join.stale) { return {...,
      // stale: true, staleNote: ... } }` early-return branch in
      // composeReportNodeInfo (index.ts) is what makes this assertion
      // fail — it would fall through to the fresh-match branch and publish
      // `skippable: false` as though the report still described the
      // current source.
      expect(nodes[0].composeReport).toEqual({
        joined: true,
        enclosingFunction: "FixtureCartScreen",
        module: "app",
        generatedAt: "2026-09-20T04:10:00.000Z",
        gitHead: "a1b2c3d",
        kotlinVersion: "2.1.0",
        strongSkippingInBuild: "unknown",
        stale: true,
        staleNote: "report from 2026-09-20T04:10:00.000Z at git a1b2c3d, sources have changed since — not used for a reason.",
      });
      expect(nodes[0].composeReport).not.toHaveProperty("skippable");
    } finally {
      await rig.close();
      withProjectRoot(savedProjectRoot);
      resetSourceIndexForTests();
      rmSync(reportDir, { recursive: true, force: true });
      resetComposeReportCacheForTests();
    }
  });

  it("recompositions says 'no report entry matched' with candidates rather than guessing, when nothing matches", async () => {
    savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
    resetSourceIndexForTests();
    resetComposeReportCacheForTests();
    withProjectRoot(FIXTURE_ROOT);
    const moduleRoot = path.join(FIXTURE_ROOT, "app");
    const reportDir = path.join(moduleRoot, "build", "porthole");
    mkdirSync(reportDir, { recursive: true });
    const reportFile = path.join(reportDir, "compose-report.json");
    writeFileSync(
      reportFile,
      JSON.stringify({
        generatedAt: "now",
        variant: "debug",
        module: "app",
        kotlinVersion: "2.1.0",
        gitHead: "abc",
        sourceFingerprint: currentSourceFingerprint(moduleRoot),
        composables: [
          { name: "SomethingUnrelated", packageName: "com.example.shop.ui", restartable: true, skippable: true, parameters: [] },
        ],
        classes: [],
      }),
    );
    const rig = await buildRig({
      handlers: {
        recompositions: () => ({
          nodes: [{ name: "Fixture.PromoField", count: 900, triggeredBy: [] }],
          totalNodes: 1,
          truncated: false,
          unattributedWrites: [],
        }),
      },
    });
    try {
      const result = await rig.client.callTool("recompositions", {});
      expect(result.isError).toBeFalsy();
      const nodes = (result.json as { nodes: Array<{ composeReport?: Record<string, unknown> }> }).nodes;
      expect(nodes[0].composeReport).toEqual({ joined: false, reason: "no report entry matched" });
    } finally {
      await rig.close();
      withProjectRoot(savedProjectRoot);
      resetSourceIndexForTests();
      rmSync(reportDir, { recursive: true, force: true });
      resetComposeReportCacheForTests();
    }
  });

  it("porthole_status's exits carry where on topAppFrame", async () => {
    savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
    resetSourceIndexForTests();
    withProjectRoot(FIXTURE_ROOT);
    const rig = await buildRig();
    try {
      await rig.pushEvents([
        {
          event: "exit",
          t: 1000,
          data: {
            reason: "REASON_ANR",
            timestamp: Date.now(),
            mainStack: "com.example.shop.ui.FixtureCartViewModel.blockTheMainThread(FixtureCartViewModel.kt:11)",
          },
        },
      ]);
      const status = await rig.client.callTool("porthole_status", {});
      expect(status.isError).toBeFalsy();
      const exits = (status.json as { exits: { recent: Array<{ where?: unknown }> } }).exits;
      expect(exits.recent[0].where).toEqual({
        resolved: true,
        path: "app/src/main/kotlin/com/example/shop/ui/FixtureCartViewModel.kt",
        line: 11,
      });
    } finally {
      await rig.close();
      withProjectRoot(savedProjectRoot);
      resetSourceIndexForTests();
    }
  });

  it("attaches no where at all when PORTHOLE_PROJECT_ROOT is unset — the off switch", async () => {
    savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
    resetSourceIndexForTests();
    withProjectRoot(undefined);
    const rig = await buildRig({
      handlers: {
        blocking: () => ({
          stalls: [
            {
              durationMs: 900,
              stack: "com.example.shop.ui.FixtureCartViewModel.blockTheMainThread(FixtureCartViewModel.kt:11)",
            },
          ],
          mainThreadQueries: [],
          stallThresholdMs: 700,
        }),
      },
    });
    try {
      const result = await rig.client.callTool("blocking", {});
      const stalls = (result.json as { stalls: Array<{ where?: unknown }> }).stalls;
      expect(stalls[0].where).toBeUndefined();
    } finally {
      await rig.close();
      withProjectRoot(savedProjectRoot);
      resetSourceIndexForTests();
    }
  });

  /**
   * 201-C: `blocking`'s AC3 rig test only proves the `where`-carrying
   * payload looks right; it does not prove `call()`'s `augment` step
   * leaves everything else on the payload alone. These two do, for the
   * other two tools that use `augment` (`recompositions`, `state`) —
   * calling each with resolution on and off against the *same* device
   * reply and asserting the two payloads agree on everything except
   * `where` itself.
   */
  it("recompositions: on vs off is byte-identical except each node's where", async () => {
    const deviceReply = {
      nodes: [{ name: "Fixture.PromoField", count: 42, triggeredBy: [{ key: "x", count: 1 }] }],
      totalNodes: 1,
      truncated: false,
      unattributedWrites: [],
    };

    savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
    resetSourceIndexForTests();
    withProjectRoot(FIXTURE_ROOT);
    const onRig = await buildRig({ handlers: { recompositions: () => deviceReply } });
    let onJson: { nodes: Array<Record<string, unknown>> };
    try {
      onJson = (await onRig.client.callTool("recompositions", {})).json as typeof onJson;
    } finally {
      await onRig.close();
    }

    withProjectRoot(undefined);
    resetSourceIndexForTests();
    const offRig = await buildRig({ handlers: { recompositions: () => deviceReply } });
    let offJson: { nodes: Array<Record<string, unknown>> };
    try {
      offJson = (await offRig.client.callTool("recompositions", {})).json as typeof offJson;
    } finally {
      await offRig.close();
      withProjectRoot(savedProjectRoot);
      resetSourceIndexForTests();
    }

    expect(onJson.nodes[0].where).toBeDefined();
    expect(offJson.nodes[0].where).toBeUndefined();
    const { where: onWhere, ...onNodeRest } = onJson.nodes[0];
    const { where: offWhere, ...offNodeRest } = offJson.nodes[0];
    expect(onNodeRest).toEqual(offNodeRest);
    expect({ ...onJson, nodes: undefined }).toEqual({ ...offJson, nodes: undefined });
  });

  it("state: on vs off is byte-identical except each owner's where", async () => {
    const deviceReply = { owners: [{ name: "FixtureCartViewModel", fields: [{ name: "items" }] }] };

    savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
    resetSourceIndexForTests();
    withProjectRoot(FIXTURE_ROOT);
    const onRig = await buildRig({ handlers: { state: () => deviceReply } });
    let onJson: { owners: Array<Record<string, unknown>> };
    try {
      onJson = (await onRig.client.callTool("state", {})).json as typeof onJson;
    } finally {
      await onRig.close();
    }

    withProjectRoot(undefined);
    resetSourceIndexForTests();
    const offRig = await buildRig({ handlers: { state: () => deviceReply } });
    let offJson: { owners: Array<Record<string, unknown>> };
    try {
      offJson = (await offRig.client.callTool("state", {})).json as typeof offJson;
    } finally {
      await offRig.close();
      withProjectRoot(savedProjectRoot);
      resetSourceIndexForTests();
    }

    expect(onJson.owners[0].where).toBeDefined();
    expect(offJson.owners[0].where).toBeUndefined();
    const { where: onWhere, ...onOwnerRest } = onJson.owners[0];
    const { where: offWhere, ...offOwnerRest } = offJson.owners[0];
    expect(onOwnerRest).toEqual(offOwnerRest);
  });
});
