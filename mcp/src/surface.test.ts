// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTrace, type Finding } from "./trace.js";
import type { DeviceEvent } from "./device.js";

/**
 * The shape of the MCP surface, rather than any one tool's output.
 *
 * The complaint these guard against is not that a tool returned a wrong
 * number. It is that an agent handed eleven raw-data tools, inconsistent
 * windows and no stated confidence goes wandering — reaching for whichever
 * tool it guessed at, comparing two windows it did not notice were different,
 * and reporting a correlation as a cause. Each test below pins one of the
 * properties that stops that.
 */

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

/** A tool's own block. Bare names also appear in the follow-up map, earlier. */
function toolSource(name: string): string {
  const start = source.indexOf(`server.registerTool(
  "${name}",`);
  if (start < 0) throw new Error(`no such tool: ${name}`);
  const next = source.indexOf("server.registerTool(", start + 20);
  return source.slice(start, next < 0 ? undefined : next);
}

const event = (t: number, name: string, data: Record<string, unknown> = {}): DeviceEvent =>
  ({ t, seq: t, event: name, data }) as DeviceEvent;

describe("the window", () => {
  it("is the same three parameters on every tool that spans time", () => {
    // Six tools take a window. If one of them hand-rolls its own again, an
    // agent can no longer carry bounds between calls — which is how `timeline`
    // ended up the only tool that could not be asked about a moment.
    const shared = source.match(/\.\.\.windowShape/g) ?? [];
    expect(shared.length).toBe(5); // the sixth uses `inputSchema: windowShape` whole

    const handRolled = source.match(/^\s+sinceMs: z/gm) ?? [];
    expect(handRolled.length, "a tool has grown its own window again").toBe(1); // the definition
  });

  it("gives timeline the absolute bounds it lacked", () => {
    const timelineTool = toolSource("timeline");
    expect(timelineTool).toContain("...windowShape");
    expect(timelineTool).toContain("resolveWindow");
  });
});

describe("findings", () => {
  const events = [
    event(1000, "db", { phase: "end", sql: "SELECT 1", thread: "main", durationMs: 12 }),
    event(1100, "blocked", { durationMs: 420, stack: "com.app.Thing.work(Thing.kt:10)" }),
  ];

  it("runs the same analyser the headless capture runs", () => {
    // One analyser, so a finding means the same thing in CI as in an editor.
    // If the live path grew its own rules they would drift apart silently.
    const trace = buildTrace({
      scenario: "live",
      events,
      hello: null,
      durationMs: 1000,
      withEvents: false,
    });
    expect(trace.findings.length).toBeGreaterThan(0);
    expect(trace.findings.every((f: Finding) => f.confidence)).toBe(true);
  });

  it("states how strongly each finding can be claimed", () => {
    const trace = buildTrace({
      scenario: "live",
      events,
      hello: null,
      durationMs: 1000,
      withEvents: false,
    });
    for (const finding of trace.findings) {
      expect(["observed", "correlated"]).toContain(finding.confidence);
    }
  });

  it("names a follow-up tool for every finding the analyser can produce", () => {
    // A finding with no next step is a dead end, and guessing the next tool is
    // where the wandering starts. Every id the analyser emits must be mapped.
    // Entries wrap when long, so the brace may be on the next line.
    const emitted = [...source.matchAll(/"([a-z-]+)":\s*\{\s*tool:/g)].map((m) => m[1]);
    const analyser = readFileSync(new URL("./trace.ts", import.meta.url), "utf8");
    const ids = [...analyser.matchAll(/^\s+id: "([a-z-]+)",$/gm)].map((m) => m[1]);

    expect(ids.length).toBeGreaterThan(0);
    const unmapped = ids.filter((id) => !emitted.includes(id));
    expect(unmapped, `findings with no follow-up tool: ${unmapped.join(", ")}`).toEqual([]);
  });

  it("points every follow-up at a tool that exists", () => {
    const registered = [...source.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    const targets = [...source.matchAll(/\{ tool: "([a-z_]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(registered, `follow-up names a tool that is not registered: ${target}`).toContain(
        target,
      );
    }
  });
});

describe("saying what is not known", () => {
  it("warns that an empty findings list is not a clean bill of health", () => {
    const tool = toolSource("findings");
    // Specifically the description's wording. An alternation here also matched
    // the summary string in the handler, so the assertion survived the caveat
    // being deleted from the text an agent actually reads.
    expect(tool, "the description no longer says what an empty list does not mean").toMatch(
      /does not mean the app/,
    );
  });

  it("keeps the confidence vocabulary in the description an agent reads", () => {
    const tool = toolSource("findings");
    expect(tool).toContain("observed");
    expect(tool).toContain("correlated");
    expect(tool).toMatch(/ordering and not/);
  });

  it("gives the tools that describe the present tense their limits", () => {
    // These three describe what is, and an agent will otherwise infer what was
    // or what it costs. Each has to say what it cannot answer.
    for (const [tool, expected] of [
      ["nav_state", /Present tense only/],
      ["state", /do not read absence here/],
      ["semantics_tree", /says nothing about cost/],
    ] as const) {
      expect(toolSource(tool), `${tool} has no stated limits`).toMatch(expected);
    }
  });
});

describe("what_was_happening", () => {
  it("distinguishes 'outside the buffer' from 'nothing was happening'", () => {
    // Conflating the two is how an agent concludes an app was idle when the
    // truth is the moment simply aged out of the ring.
    const tool = toolSource("what_was_happening");
    expect(tool).toMatch(/no longer held|outside what is buffered/);
  });

  it("says durations are as they were then, not as they turned out", () => {
    expect(toolSource("what_was_happening")).toMatch(/what was true then/);
  });

  it("accepts the clock a Perfetto trace actually uses", () => {
    const tool = toolSource("what_was_happening");
    expect(tool).toContain("bootMs");
    expect(tool).toMatch(/CLOCK_BOOTTIME/);
  });
});

describe("system_context", () => {
  it("says its readings are current, not historical", () => {
    // The other windowed tools answer about a span. This one cannot, and an
    // agent that assumes it can will attribute today's thermal state to
    // yesterday's capture.
    expect(toolSource("system_context")).toMatch(/current, not historical/);
  });

  it("refuses to draw the conclusion", () => {
    const tool = toolSource("system_context");
    expect(tool).toMatch(/draws no conclusions|does not know what your app/);
  });

  it("lists what it could not read rather than omitting it", () => {
    expect(toolSource("system_context")).toContain("unavailable");
  });
});

describe("the entry point", () => {
  it("is named by the status tool rather than left to be guessed", () => {
    expect(toolSource("porthole_status")).toContain("`findings`");
  });
});

describe("the server version", () => {
  it("is read from the package rather than retyped", () => {
    // The same drift that put a stale npm package name in the Gradle plugin.
    expect(source).toContain("version: pkg.version");
    expect(source).not.toMatch(/version: "\d+\.\d+\.\d+"/);
  });
});
