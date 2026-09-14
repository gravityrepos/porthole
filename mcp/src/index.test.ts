// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRig, waitUntil, type Rig } from "./testing/harness.js";
import { resolveSdkDir } from "./adb.js";

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

  it("also reports the project root and its source", async () => {
    const rig = await buildRig();
    try {
      const result = await rig.client.callTool("porthole_status", {});
      expect(result.isError).toBeFalsy();
      const payload = result.json as Record<string, unknown>;
      expect(typeof payload.projectRoot).toBe("string");
      expect(["PORTHOLE_PROJECT_ROOT", "cwd"]).toContain(payload.projectRootSource);
    } finally {
      await rig.close();
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
