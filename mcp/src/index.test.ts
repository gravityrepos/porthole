// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { buildRig, type Rig } from "./testing/harness.js";

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
    const rig = await buildRig({ connectDevice: false });
    try {
      const result = await rig.client.callTool("findings", {});
      expect(result.isError).toBeFalsy();
      expect(result.json).toMatchObject({ connected: false, findings: [] });
    } finally {
      await rig.close();
    }
  });
});

describe("every tool that declares a window examines the same span", () => {
  /**
   * Tools discovered by their live JSON schema, not by name. The shared
   * `windowShape` always declares exactly these three keys together —
   * `sinceMs`, `from` and `to` — so a tool's schema carrying all three is
   * how you tell "this tool takes the shared window" from a tool that
   * merely happens to have a `from`/`to` pair for some other reason
   * (`ask_system_trace` takes `from`/`to` scoped to a trace file, with no
   * `sinceMs`, and is deliberately not part of this group).
   */
  async function windowedTools(rig: Rig): Promise<string[]> {
    const tools = await rig.client.listTools();
    return tools
      .filter((t) => {
        const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
        return "sinceMs" in props && "from" in props && "to" in props;
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
