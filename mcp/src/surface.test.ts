// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTrace, resolveProfile, type Finding } from "./trace.js";
import type { DeviceEvent } from "./device.js";
import { buildRig } from "./testing/harness.js";
import { stripComments } from "./testing/stripComments.js";
import { buildFakeAdb, fakeAdbArgsKey, type FakeAdb } from "./testing/fakeAdb.js";
import { buildFakeScreencapAdb } from "./testing/fakeScreencapAdb.js";
import { PNG } from "pngjs";
import * as jpeg from "jpeg-js";

/**
 * The shape of the MCP surface, rather than any one tool's output.
 *
 * The complaint these guard against is not that a tool returned a wrong
 * number. It is that an agent handed eleven raw-data tools, inconsistent
 * windows and no stated confidence goes wandering — reaching for whichever
 * tool it guessed at, comparing two windows it did not notice were different,
 * and reporting a correlation as a cause. Each test below pins one of the
 * properties that stops that.
 *
 * "the tool surface", below, guards a different complaint: nothing pinned
 * the tool *names* themselves, in either direction. A renamed or deleted
 * tool left `windowedTools()` in `index.test.ts` silent (it only discovers
 * tools that declare a window) and left `entrypoints.test.ts` green (it
 * compares the two entry points to each other, so a rename both entry
 * points agree on still passes). Those tests exercise what a tool does;
 * this one exercises what an agent — or a person reading the README — would
 * call it. It has to ask the running server, not grep this file, or a
 * rename that both the code and a hand-copied test string agree on would
 * pass right along with the tool.
 */

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

/**
 * A tool's own block. Bare names also appear in the follow-up map, earlier.
 *
 * Matches `server.registerTool(` followed by the tool's name on the next
 * line, whatever the indentation — index.ts lives inside a function now (see
 * `createPortholeServer`), and prettier is free to reindent it. The tests
 * here care about a tool's wording and shape, never about the column it
 * starts in.
 */
function toolSource(name: string): string {
  const pattern = new RegExp(`server\\.registerTool\\(\\s*\\n\\s*"${name}",`);
  const match = pattern.exec(source);
  if (!match) throw new Error(`no such tool: ${name}`);
  const rest = source.slice(match.index + match[0].length);
  const next = rest.search(/server\.registerTool\(/);
  return source.slice(match.index, next < 0 ? undefined : match.index + match[0].length + next);
}

const event = (t: number, name: string, data: Record<string, unknown> = {}): DeviceEvent =>
  ({ t, seq: t, event: name, data }) as DeviceEvent;

describe("the window", () => {
  it("gives every windowed tool the same shared definition, not a hand-rolled copy", () => {
    // The complaint this guards against is not "how many tools take a window" —
    // that number grows every time a ticket adds one, and pinning it is what
    // made this file need editing for reasons unrelated to correctness. What
    // must stay true regardless of how many tools there are is that none of
    // them declares its own copy of `sinceMs`/`from`/`to`: there is exactly
    // one such declaration in the whole file, the shared `windowShape` itself.
    // A tool that grows a second one is the `timeline` bug happening again —
    // see index.test.ts for the behavioural version of this check, which
    // catches it even if the second copy is spelled differently.
    const handRolled = source.match(/^\s+sinceMs: z/gm) ?? [];
    expect(handRolled.length, "a tool has grown its own window again").toBe(1); // the definition
  });

  it("gives timeline the absolute bounds it lacked", () => {
    const timelineTool = toolSource("timeline");
    expect(timelineTool).toContain("...windowShape");
    expect(timelineTool).toContain("resolveWindow");
  });

  // GRA-55: `since` lives on the same shared `windowShape` `sinceMs` does,
  // for the same reason — one declaration, not a hand-rolled copy per tool.
  it("puts since: \"last\"/\"all\" on the shared windowShape too, not a second hand-rolled copy", () => {
    const handRolled = source.match(/^\s+since: z/gm) ?? [];
    expect(handRolled.length, "a tool has grown its own `since` again").toBe(1); // the definition
    expect(source).toMatch(/since:\s*z\s*\n\s*\.enum\(\["last", "all"\]\)/);
  });

  it("every tool that shares windowShape actually registers since as an enum of last/all, not just in source text", async () => {
    // The behavioural half of the check above: asks the running server's own
    // schema, the same way `windowedTools()`-style tests in index.test.ts do,
    // rather than trusting that the source-text match above implies the
    // schema compiled the way it reads.
    const rig = await buildRig();
    try {
      const tools = await rig.client.listTools();
      const windowed = ["findings", "save_moment", "recompositions", "frames", "blocking", "logs", "timeline"];
      for (const name of windowed) {
        const tool = tools.find((t) => t.name === name);
        expect(tool, `${name} is not registered`).toBeDefined();
        const props = (tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
        const since = props.since as { enum?: string[] } | undefined;
        expect(since, `${name}'s schema has no \`since\``).toBeDefined();
        expect(since?.enum?.slice().sort(), `${name}'s \`since\` is not enum(["last","all"])`).toEqual([
          "all",
          "last",
        ]);
      }
    } finally {
      await rig.close();
    }
  });
});

describe("findings", () => {
  const events = [
    event(1000, "db", { phase: "end", sql: "SELECT 1", thread: "main", durationMs: 12 }),
    event(1100, "blocked", { durationMs: 420, stack: "com.app.Thing.work(Thing.kt:10)" }),
  ];
  // GRA-185: `buildTrace` now takes the resolved profile explicitly; none of
  // `events` above carries a device/profile event, so this resolves to the
  // same 60Hz fallback it always used internally.
  const profile = resolveProfile({ liveEvents: events, windowTo: 1000, sessionProfile: null, hello: null });

  it("runs the same analyser the headless capture runs", () => {
    // One analyser, so a finding means the same thing in CI as in an editor.
    // If the live path grew its own rules they would drift apart silently.
    const trace = buildTrace({
      scenario: "live",
      events,
      hello: null,
      durationMs: 1000,
      withEvents: false,
      profile,
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
      profile,
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

// GRA-58: porthole_status gains `exitTrace` rather than a sixteenth tool —
// the schema-level half of that; index.test.ts exercises the handler itself
// against a FakeDevice.
describe("porthole_status's exitTrace parameter", () => {
  it("declares exitTrace as optional, accepting either a positive integer or a string (GRA-188), not a hand-rolled copy of the window shape", async () => {
    const rig = await buildRig();
    try {
      const tools = await rig.client.listTools();
      const tool = tools.find((t) => t.name === "porthole_status");
      expect(tool, "porthole_status is not registered").toBeDefined();
      const props = (tool?.inputSchema as { properties?: Record<string, unknown>; required?: string[] })
        .properties ?? {};
      const required = (tool?.inputSchema as { required?: string[] }).required ?? [];
      expect(props.exitTrace, "porthole_status has no exitTrace parameter").toBeDefined();
      expect(required, "exitTrace must be optional").not.toContain("exitTrace");

      // GRA-188: a union now, not a bare `z.number()` — the JSON schema
      // carries both branches rather than one `type`. Checked structurally
      // (both an integer variant and a string variant exist somewhere in
      // the schema) rather than pinned to zod's exact `anyOf`/`oneOf`
      // encoding, which is an implementation detail of the conversion, not
      // of this ticket.
      const exitTrace = props.exitTrace as Record<string, unknown>;
      const branches = (exitTrace.anyOf ?? exitTrace.oneOf) as Array<{ type?: string }> | undefined;
      expect(branches, `exitTrace schema has no anyOf/oneOf: ${JSON.stringify(exitTrace)}`).toBeDefined();
      const types = branches!.map((b) => b.type);
      expect(types).toContain("integer");
      expect(types).toContain("string");
      expect(exitTrace.type, "exitTrace must no longer be a bare number type").not.toBe("integer");
    } finally {
      await rig.close();
    }
  });

  it("says what it fetches and how it is capped", () => {
    const tool = toolSource("porthole_status");
    expect(tool).toContain("exitTrace");
    expect(tool).toMatch(/256\s*KB/);
  });
});

// GRA-186: the schema-level half of capture_system_trace's new
// `restartApp` parameter — index.test.ts's fake-adb rig exercises the
// handler itself (the force-stop/relaunch sequence, both self-check (a)
// cases); this file only pins the shape an agent actually sees when it
// lists tools, and the wording of the platform caveat.
describe("capture_system_trace's restartApp parameter", () => {
  it("declares restartApp as an optional boolean, not required and not the tool's only optional field turned required by a typo", async () => {
    const rig = await buildRig();
    try {
      const tools = await rig.client.listTools();
      const tool = tools.find((t) => t.name === "capture_system_trace");
      expect(tool, "capture_system_trace is not registered").toBeDefined();
      const schema = tool?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      const props = schema.properties ?? {};
      const required = schema.required ?? [];
      expect(props.restartApp, "capture_system_trace has no restartApp parameter").toBeDefined();
      expect(required, "restartApp must be optional").not.toContain("restartApp");

      const restartApp = props.restartApp as { type?: string; default?: unknown };
      expect(restartApp.type, `restartApp schema: ${JSON.stringify(restartApp)}`).toBe("boolean");
      // GRA-186 AC1: "default false" is a stated contract, not just this
      // test's assumption — pin the compiled schema's own default so a
      // change to the zod declaration that silently drops `.default(false)`
      // fails here instead of only showing up as an agent-visible surprise.
      expect(restartApp.default).toBe(false);
    } finally {
      await rig.close();
    }
  });

  it("documents the parameter and the platform caveat naming the device, build and cold-start trade-off", () => {
    const tool = toolSource("capture_system_trace");
    expect(tool).toContain("restartApp");
    expect(tool).toMatch(/Pixel 9 Pro Fold/);
    expect(tool).toMatch(/Android 17/);
    expect(tool).toMatch(/cold start/);

    // Named in the tool's own top-level description, not only buried in the
    // parameter's own `.describe()` — an agent deciding whether to call the
    // tool at all reads the former first. Sliced to just the `description:`
    // field's own text (up to `inputSchema:`) so this fails if `restartApp`
    // is only ever mentioned inside the schema below it.
    const descriptionStart = tool.indexOf("description:");
    const inputSchemaStart = tool.indexOf("inputSchema:");
    expect(descriptionStart, "capture_system_trace has no description: field").toBeGreaterThan(-1);
    expect(inputSchemaStart, "capture_system_trace has no inputSchema: field").toBeGreaterThan(descriptionStart);
    const description = tool.slice(descriptionStart, inputSchemaStart);
    expect(description).toContain("restartApp");
  });
});

describe("the server version", () => {
  it("is read from the package rather than retyped", () => {
    // The same drift that put a stale npm package name in the Gradle plugin.
    // `options.version` is the test-only override `createPortholeServer`
    // accepts; the fallback is still the package, never a literal.
    expect(source).toContain("options.version ?? pkg.version");
    expect(source).not.toMatch(/version: "\d+\.\d+\.\d+"/);
  });
});

/**
 * Pulls the tool names out of the README's "between them they cover" table
 * (currently just above `## Layout`, but this does not assume that — it
 * finds the table by its own header cell, not by a heading or a line
 * number). Reads the first pipe-delimited cell of each data row, which is
 * where the tool's name lives in a backtick span, e.g.
 * `| \`findings\` | start here: ... |`.
 *
 * Deliberately loose about everything that is just table formatting —
 * column widths, extra spaces, how the separator row is dashed — so
 * reflowing the table does not break this test. What it does not tolerate
 * is a row's name cell losing its tool, which is the actual thing AC 2
 * exists to catch.
 */
function readmeToolNames(): string[] {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const lines = readme.split("\n");
  const headerIndex = lines.findIndex((line) => /^\|\s*tool\s*\|/i.test(line.trim()));
  if (headerIndex < 0) {
    throw new Error("no tool table found in README.md (expected a `| tool | answers |` header)");
  }

  const names: string[] = [];
  // headerIndex + 1 is the "| --- | --- |" separator row; data starts after it.
  for (let i = headerIndex + 2; i < lines.length && lines[i].trim().startsWith("|"); i++) {
    const nameCell = lines[i].split("|")[1] ?? "";
    const match = nameCell.match(/`([a-z_]+)`/);
    if (match) names.push(match[1]);
  }
  return names;
}

describe("GRA-55: every tool's result carries sinceLast", () => {
  // The EM's own warning on this ticket: "make the test assert the *absence*
  // of a tool that skipped it — otherwise the one tool that forgets is the
  // one the agent was using when the ANR happened." Walks the *registered*
  // tool list (`listTools()`, not a hand-copied array — the same reason
  // "the tool surface" below asks the running server rather than grepping
  // this file) so a future tool that forgets `ok()` — or forgets to route
  // through it — fails this test by name, without anyone remembering to
  // extend a list.
  const ARGS_BY_TOOL: Record<string, Record<string, unknown>> = {
    // The two tools with a required, non-window argument — anything else
    // here is optional, so `{}` is a valid call.
    save_moment: { from: 0, to: 2_000 },
    what_was_happening: { at: 1_000 },
    // No real trace file or trace_processor binary in this environment —
    // this call is expected to `fail()`, which carries no payload at all
    // (by `fail()`'s own design) and is explicitly excluded below, the same
    // way `capture_system_trace` (no real adb) is excluded without needing
    // an entry here.
    ask_system_trace: { trace: "/nonexistent.pftrace" },
  };

  // This walk calls every registered tool, and several shell out to adb. On a runner with no adb the
  // spawn failures alone took 7.7 s on windows-latest, past the 5 s default (GRA-186's CI run); GRA-62's
  // porthole_connect and GRA-63's screenshot each add their own adb round trip on top of that, and QA
  // measured 26-29 s against this test's own 30 s timeout once both existed — one flaky CI run away from
  // red for a reason that has nothing to do with what this test actually checks. GRA-182 was going to be
  // the general hermetic fix for every adb-shelling tool in this walk; this injects the same fake adb
  // (GRA-89's) here now rather than waiting on that ticket, since two more real, unconfigured adb calls
  // were the specific thing that pushed this over. Nothing is configured for "exec-out screencap -p" —
  // that is deliberate: the fake's own default (an immediate, fast "no configured response" exit) is
  // exactly what a real adb-with-no-device eventually says too, just without the wall-clock cost of
  // actually asking. `porthole_connect`'s "devices -l" IS configured, to an empty list, so it returns a
  // real `ok()` result (not `fail()`) and is actually exercised by this walk's `sinceLast` check instead
  // of being silently skipped alongside `capture_system_trace`/`ask_system_trace`.
  it("every successful (ok()) tool result has a sinceLast field on its payload — a fail() result carries no payload at all, and is not this test's concern", { timeout: 30_000 }, async () => {
    const fakeAdb = buildFakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: { stdout: "List of devices attached\n\n" },
    });
    const rig = await buildRig({ adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      await rig.pushEvents([
        { event: "recompose", t: 1_000, data: { name: "Cart" } },
        { event: "nav", t: 1_500, data: { route: "cart" } },
      ]);

      const tools = await rig.client.listTools();
      expect(tools.length).toBeGreaterThan(0); // positive control: a broken listTools() must not read as "nothing to check"

      const missing: string[] = [];
      for (const tool of tools) {
        const args = ARGS_BY_TOOL[tool.name] ?? {};
        const result = await rig.client.callTool(tool.name, args);
        if (result.isError) continue; // no payload block at all — see fail()
        const payload = result.json;
        const hasSinceLast =
          payload !== null && typeof payload === "object" && "sinceLast" in (payload as object);
        if (!hasSinceLast) missing.push(tool.name);
      }
      expect(missing, `tool(s) whose successful result has no sinceLast field: ${missing.join(", ")}`).toEqual(
        [],
      );
    } finally {
      await rig.close();
      fakeAdb.cleanup();
    }
  });
});

describe("the tool surface", () => {
  // The 20 names `index.ts` registers, in registration order, verified
  // against the running server rather than copied from the ticket that
  // asked for this test — see the "registers exactly these tools" case
  // below, which is what would have caught this list being wrong.
  const REGISTERED_TOOLS = [
    "porthole_status",
    "porthole_connect",
    "setup",
    "findings",
    "system_context",
    "ask_system_trace",
    "capture_system_trace",
    "system_trace_start",
    "system_trace_snapshot",
    "system_trace_stop",
    "save_moment",
    "what_was_happening",
    "recompositions",
    "semantics_tree",
    "nav_state",
    "state",
    "inflight",
    "frames",
    "blocking",
    "logs",
    "timeline",
    "open_timeline",
    "screenshot",
  ];

  it("registers exactly these tools — a rename or a deletion fails this, named", async () => {
    // `buildRig` drives `createPortholeServer` through a real MCP `Client`
    // (see `testing/harness.ts`), so this asks the server what it actually
    // registered — the same `tools/list` call an agent makes — rather than
    // parsing `index.ts`'s source for `registerTool(` calls. A renamed tool
    // shows up as both a missing expected name and an unexpected extra one;
    // a deleted tool shows up as missing only. Either way the assertion
    // message names the tool, not just "arrays differ".
    const rig = await buildRig();
    try {
      const names = (await rig.client.listTools()).map((t) => t.name);
      const missing = REGISTERED_TOOLS.filter((n) => !names.includes(n));
      const extra = names.filter((n) => !REGISTERED_TOOLS.includes(n));
      expect(missing, `expected but not registered: ${missing.join(", ")}`).toEqual([]);
      expect(extra, `registered but not expected: ${extra.join(", ")}`).toEqual([]);
    } finally {
      await rig.close();
    }
  });

  it("documents every registered tool in the README, and no tool it does not register", async () => {
    // Both directions of AC 2: a tool the server registers but the README
    // never mentions, and a tool the README mentions that the server does
    // not register (a stale doc, or a typo in the table).
    const rig = await buildRig();
    try {
      const registered = (await rig.client.listTools()).map((t) => t.name);
      const documented = readmeToolNames();
      const undocumented = registered.filter((n) => !documented.includes(n));
      const phantom = documented.filter((n) => !registered.includes(n));
      expect(undocumented, `registered but not documented in README.md: ${undocumented.join(", ")}`).toEqual(
        [],
      );
      expect(phantom, `documented in README.md but not registered: ${phantom.join(", ")}`).toEqual([]);
    } finally {
      await rig.close();
    }
  });
});

/**
 * Every top-level `.ts` file in `src/` except `device.ts` itself and any
 * `*.test.ts` — `src/` is flat other than `fixtures/` (data, not code) and
 * `testing/` (test infrastructure, already excluded from the real build by
 * tsconfig for the same reason test files are). Non-recursive on purpose:
 * if `src/` grows a subdirectory of production code later, that is worth
 * noticing and deciding about, not silently picking up.
 */
function productionSourceFiles(): string[] {
  const dir = new URL("./", import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "device.ts")
    .sort();
}

// `stripComments()` used to live here as its own copy (and a second,
// drifting copy in device.test.ts) — see `./testing/stripComments.ts` for
// the shared implementation, its CRLF-normalisation rationale (GRA-166 item
// 6), and the string-literal-awareness fix and documented residue (GRA-168
// items 1 and 3).

describe("stripComments (GRA-166 item 6)", () => {
  it("blanks a // comment whose line ends in \\r\\n, not just \\n", () => {
    // Direct unit test on CRLF handling, independent of the working tree's
    // own line endings (.gitattributes pins every checkout to LF, so
    // nothing else in this file ever exercises this path against a real
    // file). This test predates GRA-168's rewrite of stripComments() from a
    // per-line regex to the character-by-character scan it is now, and its
    // original comment claimed that deleting the regex-era CRLF
    // normalisation would leave the whole suite green *without* this test
    // existing to catch it — true at the time, but now stale in a more
    // important way: mutation-tested after the rewrite, deleting that same
    // normalisation line leaves the whole suite green *with* this test
    // present and passing too, because the new scan handles "\r" correctly
    // on its own (see the comment on `const normalized = ...` in
    // testing/stripComments.ts for why). So this test no longer guards the
    // normalisation line specifically — nothing does, because nothing needs
    // to. What it still guards, and why it stays: that stripComments()
    // correctly blanks a comment on a CRLF-ending line, which is worth
    // pinning in its own right given .gitattributes makes it otherwise
    // unreachable from any real file in this checkout.
    const crlf = 'const ok = 1;\r\n// state === "connected", left here on purpose\r\nconst after = 2;\r\n';
    const stripped = stripComments(crlf);
    expect(stripped).not.toContain('state === "connected"');
    // And the blanking is real, not a side effect of the whole line
    // vanishing — the code before and after the comment must survive.
    expect(stripped).toContain("const ok = 1;");
    expect(stripped).toContain("const after = 2;");
  });
});

describe("stripComments (GRA-168 item 1): string literals do not open or close a comment span", () => {
  it("does not blank a real ConnectionState comparison sitting between two string literals that merely contain /* and */", () => {
    // The headline reproduction from GRA-168, made permanent and independent
    // of index.ts: before this fix, stripComments() was a pure text blanker
    // with no notion of a string literal, so these two ordinary-looking
    // string literals opened and closed a comment span exactly like a real
    // block comment would, and the genuine offender between them vanished
    // before the ConnectionState pattern ever saw it. Measured directly
    // against index.ts at the time this ticket was filed: injecting this
    // exact shape left the guard's test 22/22 green. Feeding the three
    // lines to stripComments() here, rather than mutating index.ts, is what
    // makes this a permanent regression test instead of a one-off manual
    // check.
    const src = [
      'const qaOpen = "/*";',
      'const qaOffender = ({ state: "c" } as { state: string }).state === "connected";',
      'const qaClose = "*/";',
    ].join("\n");
    const scanned = stripComments(src);
    expect(scanned).toContain('state === "connected"');
  });

  it("still blanks a genuine comment that merely mentions the comparison, with no string trickery nearby", () => {
    // The other half of AC3: the fix above must not turn into a guard that
    // stops blanking ordinary comments. A comment that only *talks about*
    // the comparison — the exact prose a reviewer might reasonably write
    // while explaining this guard — must still disappear from the scanned
    // text, the same way it did before this fix (see the CRLF test above
    // for the equivalent check on a CRLF-ending line; this is the plain-LF
    // case, which is the one every real checkout on this project actually
    // produces).
    const src = [
      "const ok = 1;",
      '// example: state === "connected" is what this guard looks for',
      "const after = 2;",
    ].join("\n");
    const scanned = stripComments(src);
    expect(scanned).not.toContain('state === "connected"');
    expect(scanned).toContain("const ok = 1;");
    expect(scanned).toContain("const after = 2;");
  });

  it("a string literal containing an unescaped // is not mistaken for a line comment", () => {
    // A side effect of the same fix worth pinning on its own: the old
    // version's line-comment step (`line.replace(/\/\/.*$/, "")`) had no
    // notion of strings either, so a perfectly ordinary string containing
    // "//" — a URL is the obvious example — had everything after the "//"
    // silently cut from the scanned line, string content and any real code
    // sharing that line included. That is a truncation bug distinct from
    // GRA-168 item 2's (which is about the guard's own positive controls),
    // but it is the same root cause as item 1's headline case, and the same
    // fix closes both.
    const src = 'const url = "http://example.com"; const c = ({ state: "c" } as { state: string }).state === "connected";';
    const scanned = stripComments(src);
    expect(scanned).toContain('const url = "http://example.com";');
    expect(scanned).toContain('state === "connected"');
  });

  it("the same headline case is defended for single-quoted strings, not only double-quoted ones", () => {
    // Mutation testing this fix (deliberately, before reporting this ticket
    // done) found that a version tracking only double-quoted strings and
    // template literals -- dropping the single-quote branch entirely --
    // survived the whole suite: nothing in this file's production source
    // happens to use a single-quoted string containing '/*' today, so
    // nothing forced that branch to prove itself. This closes that gap
    // directly, independent of what index.ts happens to contain.
    const src = [
      "const qaOpen = '/*';",
      'const qaOffender = ({ state: "c" } as { state: string }).state === "connected";',
      "const qaClose = '*/';",
    ].join("\n");
    const scanned = stripComments(src);
    expect(scanned).toContain('state === "connected"');
  });

  it("the same headline case is defended for template literals, not only quoted strings", () => {
    // Same mutation-testing gap as the single-quote case above, for the
    // template-literal branch.
    const src = [
      "const qaOpen = `/*`;",
      'const qaOffender = ({ state: "c" } as { state: string }).state === "connected";',
      "const qaClose = `*/`;",
    ].join("\n");
    const scanned = stripComments(src);
    expect(scanned).toContain('state === "connected"');
  });

  it("an escaped quote inside a double-quoted string does not end the string early", () => {
    // QA mutation-tested the escape-handling branch itself (the
    // `if (c === "\\" && next !== undefined) { ... }` inside the dq/sq
    // case) and found it untested: a mutant that drops it survives the
    // whole suite. The reproduction has to land the parity exactly right
    // to demonstrate a real miss rather than a harmless no-op: a string
    // with *two* escaped quotes before the "/*" ends up back in the
    // correct mode by coincidence (each mis-toggle cancels the last), so
    // it does not expose the bug. One escaped quote does: without the
    // escape check, `"he said \"hi; /*` closes the string right at the
    // escaped quote (the backslash is read as ordinary content, so the
    // quote after it looks like the real terminator), landing back in
    // code mode with `/*` immediately ahead and no real closing quote
    // left on the line at all. From there `/*` is read as a genuine
    // block-comment opener and blanks everything up to the next `*/` it
    // finds -- the real offender on the next line, included. That is a
    // miss, not a false positive: the guard goes blind rather than crying
    // wolf, but it is the same root cause as the headline case above,
    // reached through the escape path instead of the string-tracking one.
    // With the real escape handling, the backslash-quote pair is consumed
    // as one unit, the string stays open (deliberately unterminated here)
    // through "hi; /*", and the newline fallback below hands line 2 back
    // to a fresh, un-confused code mode.
    const src = [
      'const s = "he said \\"hi; /*',
      'const qaOffender = ({ state: "c" } as { state: string }).state === "connected";',
      'const qaClose = "*/";',
    ].join("\n");
    const scanned = stripComments(src);
    expect(scanned).toContain('state === "connected"');
  });

  it("an escaped backtick inside a template literal does not end the template early", () => {
    // Same gap and same parity requirement as the double-quote escape test
    // above, for the template-literal mode's own escape handling (a
    // separate branch in the implementation, mutated and tested
    // separately for the same reason the string and switch guards above
    // are checked in their own describe blocks rather than assumed to
    // share one fate). One escaped backtick, no further real closing
    // backtick on the line, so the mutant's mis-toggle lands exactly on
    // "/*". With real escape handling the template stays open past this
    // line (template literals may legitimately span lines, so this mode
    // has no newline fallback); that is harmless here because template
    // mode only ever copies characters through unchanged; it never blanks
    // anything, so the offender on line 2 survives regardless of which
    // mode nominally contains it.
    const src = [
      "const s = `he said \\`hi; /*",
      'const qaOffender = ({ state: "c" } as { state: string }).state === "connected";',
      'const qaClose = "*/";',
    ].join("\n");
    const scanned = stripComments(src);
    expect(scanned).toContain('state === "connected"');
  });

  it("a string opened by a stray quote inside an untokenized regex literal does not swallow a later real comment (no false positive)", () => {
    // QA's highest-priority finding: the dq/sq newline fallback
    // (`else if (c === "\n") { mode = "code"; }`) was untested, and its
    // *absence* produces a false positive rather than a miss — the more
    // dangerous direction per item 6's thesis, since a guard that cries
    // wolf on a clean tree gets deleted by the next person who hits it.
    //
    // The mechanism: regex literals are not tokenized (documented residue
    // #1 on stripComments() above), so `/can't/` is read as the two plain
    // characters '/' and 'c', 'a', 'n', then an apostrophe that *does*
    // open sq-string mode, because apostrophes are otherwise
    // indistinguishable from real single-quote string delimiters to a
    // scanner that does not know what a regex is. Without the newline
    // fallback, that spurious string mode has no way to end before another
    // apostrophe shows up, so it swallows every following line, comments
    // included, verbatim into the "scanned" output -- and a genuine prose
    // comment mentioning the ConnectionState comparison a line below then
    // reads as unblanked code and gets flagged. With the fallback, the
    // spurious string ends at the newline right after `can't`, and the
    // real "//" comment on the next line is recognised and blanked
    // normally.
    const src = ["const re = /can't/;", '// state === "connected" is examined here'].join("\n");
    const scanned = stripComments(src);
    expect(scanned).not.toContain('state === "connected"');
  });
});

describe("ConnectionState reads (GRA-162)", () => {
  it("never compares .state to a literal directly outside device.ts — isAttached()/isConnected()/isHandshaking() exist for exactly this", () => {
    // GRA-162's whole argument is that tsc catches a fifth ConnectionState,
    // because isAttached()/isConnected()/isHandshaking()/pendingMessage() are
    // never-guarded switches every reader is supposed to call. QA proved that
    // argument covers *new states* but not *new comparisons*: reverting any
    // one call site back to `something.state === "connected"` still compiles
    // and still passes every behavioural test, because the anti-pattern and
    // the helper that replaced it are both legal TypeScript — nothing
    // structural stops a future edit from writing the old shape again next
    // to the helpers rather than through them.
    //
    // This is the write-time half of that guarantee, and it is a grep, not a
    // type check, on purpose: nothing else in this codebase can see the
    // *source text* of a comparison, only its result. device.ts is excluded
    // deliberately — isAttached()/isConnected()/isHandshaking()/
    // pendingMessage()/setState() are the one place `.state` is compared to
    // a literal on purpose, because they are what every other file is
    // supposed to call instead of doing this themselves.
    //
    // What this does not reach, so the next reader does not assume it does:
    // it matches one spelling — `state`, `===`/`!==`, a double-quoted
    // literal, all on one line — so a line break inside the comparison, an
    // aliased or locally-copied `state` variable, reversed operand order, or
    // single quotes all pass it unseen (GRA-166 item 4 closed a different
    // gap, not any of these five — they are still open, on purpose named
    // here rather than silently assumed fixed). The sixth spelling that used
    // to be open here — a hand-rolled `switch` on `ConnectionState` with no
    // `never`-guarded default — is now caught by the companion check below
    // ("ConnectionState switches"), which reads a switch's body for the same
    // exhaustiveness marker device.ts's own helpers use, since a switch is a
    // different shape of comparison this regex was never going to match. So:
    // the compiler covers a new *state*; this guard plus the one below cover
    // two spellings of a new *comparison*, between the two of them. The
    // other five remain open, and nothing here is complete alone.
    const pattern = /\bstate\s*(?:===|!==)\s*"(?:disconnected|connecting|handshaking|connected)"/;

    // Positive control (GRA-166 QA follow-up): without this, a mutation that
    // makes productionSourceFiles() return [] -- or one that empties what
    // stripComments() hands back -- leaves `offenders` empty and the
    // assertion below passes for exactly the wrong reason: not "I looked
    // and found nothing", but "I looked at nothing". The checks below can
    // each only fail that way, so a future edit that guts what this test
    // actually scans dies here, by name, before ever reaching the real
    // assertion. The non-empty check on the scanned text has to run on
    // stripComments()'s *output*, not the raw file read: a control on the
    // raw read only proves the file on disk has content, not that anything
    // survived stripComments() into what the pattern below actually sees —
    // an earlier version of this control checked the raw read and passed
    // while scanning entirely blank text, which is the exact failure this
    // control exists to catch.
    const files = productionSourceFiles();
    expect(
      files.length,
      "productionSourceFiles() returned no files — this guard would then scan nothing and still pass",
    ).toBeGreaterThan(0);
    expect(files, "index.ts must be among the scanned files").toContain("index.ts");

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      const scanned = stripComments(text);
      expect(scanned.trim().length, `${file}: nothing left to scan after stripComments()`).toBeGreaterThan(
        0,
      );
      // GRA-168 item 2: the check above only catches stripComments() handing
      // back nothing at all. It does not catch truncation -- a mutation that
      // feeds stripComments() only part of the file (real code surviving,
      // just less of it) leaves the check above satisfied and this whole
      // guard scanning a fraction of the file it claims to. stripComments()'s
      // own doc comment already claims it "blanks ... without disturbing
      // line numbers"; this asserts that claim instead of trusting it.
      // Measured on a clean tree: this passes across all files scanned here.
      // A mutation truncating to the first 2000 characters (real code
      // surviving, just less of it) dies here, by name, rather than passing
      // silently the way the check above does for this specific mutation.
      expect(
        scanned.split("\n").length,
        `${file}: stripComments() changed the line count — it must not`,
      ).toBe(text.replace(/\r\n/g, "\n").split("\n").length);
      const lines = scanned.split("\n");
      lines.forEach((line, index) => {
        if (pattern.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(
      offenders,
      `bare ConnectionState comparison(s) outside device.ts — route through isAttached()/` +
        `isConnected()/isHandshaking() instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

/**
 * The gap named above and filed as GRA-166 item 4: a hand-rolled `switch` on
 * a ConnectionState-shaped value with no `never`-guarded default. Text-based
 * for the same reason `toolSource()` and the `===`/`!==` guard above are:
 * nothing else in this codebase can see the *source text* of a switch, only
 * whether tsc accepted it — and tsc accepts a non-exhaustive switch happily
 * whenever nothing forces the unhandled case's arm to type as `never`.
 *
 * Not a parser, so this looks for the *shape* of the guarantee rather than
 * asking tsc whether the switch is actually exhaustive: a `default` arm that
 * assigns the discriminant to a `never`-typed local and throws, the way
 * device.ts's own isAttached()/isConnected()/isHandshaking()/
 * pendingMessage() do. A candidate switch is one whose discriminant mentions
 * `state` and whose body handles at least one of the four ConnectionState
 * literals — both required, so a `switch (someOtherState)` elsewhere in the
 * codebase, or a `switch (state)` over some unrelated enum, is not mistaken
 * for this one. Braces are balanced by hand rather than matched with another
 * regex, because a switch body nests further braces (blocks, object
 * literals, the `default: { ... }` arm itself) that a lazy match would close
 * on too early.
 */
function switchesOnConnectionState(text: string): { line: number; body: string }[] {
  const results: { line: number; body: string }[] = [];
  const opener = /\bswitch\s*\(([^)]*)\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(text))) {
    if (!/\bstate\b/.test(match[1])) continue;
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    const body = text.slice(match.index + match[0].length, i - 1);
    if (!/case\s+"(?:disconnected|connecting|handshaking|connected)"/.test(body)) continue;
    results.push({ line: text.slice(0, match.index).split("\n").length, body });
  }
  return results;
}

describe("ConnectionState switches (GRA-166 item 4)", () => {
  it("flags a hand-rolled switch on ConnectionState with no never-guarded default, outside device.ts", () => {
    // GRA-162 made switch-on-state the house idiom (see device.ts's
    // isAttached() and its three siblings) and, in doing so, raised the
    // probability of the one spelling neither tsc nor the guard above
    // reaches: a switch that handles today's four states without a
    // never-guarded default compiles cleanly today, and silently stops
    // being exhaustive the day a fifth ConnectionState is added — no
    // never-typed local to trip tsc, and no `===`/`!==` for the regex above
    // to match. This is the write-time check that closes that gap: it does
    // not ask whether the switch is exhaustive (only tsc can answer that),
    // it asks whether the switch is *wired* to fail loudly if it stops
    // being exhaustive, the same way the real device.ts helpers are.
    // Positive control (GRA-166 QA follow-up) -- same shape and same reason
    // as the guard above: an empty file list or an empty result out of
    // stripComments() both leave `offenders` empty for the wrong reason.
    // Checked on stripComments()'s *output*, not the raw read, for the same
    // reason as the guard above: a check on the raw read cannot tell "the
    // file has content" from "the content survived stripComments()", which
    // is the only text this loop actually feeds to
    // switchesOnConnectionState(). Checked separately from the guard above
    // because each `describe` owns its own file loop.
    const files = productionSourceFiles();
    expect(
      files.length,
      "productionSourceFiles() returned no files — this guard would then scan nothing and still pass",
    ).toBeGreaterThan(0);
    expect(files, "index.ts must be among the scanned files").toContain("index.ts");

    const offenders: string[] = [];
    for (const file of files) {
      const raw = readFileSync(new URL(file, import.meta.url), "utf8");
      const text = stripComments(raw);
      expect(text.trim().length, `${file}: nothing left to scan after stripComments()`).toBeGreaterThan(
        0,
      );
      // GRA-168 item 2: same line-count invariant as the guard above, kept
      // on this loop separately since each describe block owns its own file
      // loop and a truncation here would silently shrink the text this
      // guard's switch-brace-matcher sees, the same way it would for the
      // ===/!== pattern above.
      expect(
        text.split("\n").length,
        `${file}: stripComments() changed the line count — it must not`,
      ).toBe(raw.replace(/\r\n/g, "\n").split("\n").length);
      for (const { line, body } of switchesOnConnectionState(text)) {
        const neverGuarded = /default\s*:[\s\S]*?:\s*never\b/.test(body);
        if (!neverGuarded) offenders.push(`${file}:${line}`);
      }
    }
    expect(
      offenders,
      `switch(es) on ConnectionState with no never-guarded default arm — give the default arm a ` +
        `'const exhaustive: never = state; throw ...' the way device.ts's isAttached() does, so a ` +
        `fifth ConnectionState fails tsc here too:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("timeline's kinds param (GRA-200)", () => {
  it("is generated from eventKinds.ts, not a hand-written string that can silently fall out of sync", () => {
    // The behavioural half — that the generated text actually narrates every
    // kind — is eventKinds.test.ts's job. This is the textual half: that the
    // registered tool actually calls the generator rather than a literal
    // string someone pasted its output into once and never touched again.
    const block = toolSource("timeline");
    expect(block).toContain("timelineKindsDescription()");
    expect(block).not.toMatch(/kinds: z\s*\.array\(z\.string\(\)\)\s*\.optional\(\)\s*\.describe\(\s*"/);
  });
});

// ---------------------------------------------------------------------------
// GRA-62: the agent connects to the device itself instead of asking for help
// ---------------------------------------------------------------------------

/** Same default `PORT` computation `index.ts` makes, so these tests track it instead of hardcoding 8677 and drifting if the environment ever sets PORTHOLE_PORT. */
const PORT = Number(process.env.PORTHOLE_PORT ?? 8677);

describe("porthole_status's one exception stays inert against a test-injected device", () => {
  it("never calls adb, and deviceDiagnosis is null, when the device was injected (every test in this suite) — the ownsDeviceConnection gate", async () => {
    // A fake adb that errors loudly (exit 17) on any call — buildRig always
    // injects its own `device`, so `createPortholeServer`'s
    // `ownsDeviceConnection` must be false here, and `porthole_status` must
    // never reach for adb at all. If that gate were ever dropped, this
    // fake's failure would flow into `deviceDiagnosis`/the summary and this
    // test would catch it — instead of every other disconnected-state test
    // in index.test.ts silently starting to depend on this machine's real
    // adb and real attached devices, which is the regression this pins.
    const fakeAdb = buildFakeAdb({});
    const rig = await buildRig({ connectDevice: false, adbBinary: fakeAdb.binaryPath, adbEnv: fakeAdb.env });
    try {
      const status = await rig.client.callTool("porthole_status", {});
      expect(status.isError).toBeFalsy();
      expect(status.json).toMatchObject({ deviceDiagnosis: null });
      // The exact pre-GRA-62 message, unchanged — this is what every other
      // disconnected-state test elsewhere in this suite still asserts.
      expect(status.text).toContain("Not connected to the app on");
      expect(fakeAdb.calls()).toEqual([]);
    } finally {
      await rig.close();
      fakeAdb.cleanup();
    }
  });
});

describe("porthole_status names porthole_connect for what it cannot fix itself", () => {
  it("is readOnlyHint:true, and its description names porthole_connect", () => {
    const block = toolSource("porthole_status");
    expect(block).toContain("readOnlyHint: true");
    expect(block).toContain("porthole_connect");
  });
});

describe("porthole_connect", () => {
  it("is readOnlyHint:false — unlike porthole_status, it can act on the app under test", () => {
    const block = toolSource("porthole_connect");
    expect(block).toContain("readOnlyHint: false");
  });

  async function closeAll(rig: Awaited<ReturnType<typeof buildRig>>, adb: FakeAdb): Promise<void> {
    await rig.close();
    adb.cleanup();
  }

  it("names the absence of a device specifically — GRA-62 AC (shared wording with porthole_status)", async () => {
    const adb = buildFakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: { stdout: "List of devices attached\n\n" },
    });
    const rig = await buildRig({ adbBinary: adb.binaryPath, adbEnv: adb.env });
    try {
      const result = await rig.client.callTool("porthole_connect", {});
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("No Android device or emulator is attached");
    } finally {
      await closeAll(rig, adb);
    }
  });

  it("lists both devices and asks for a serial when two are attached and none is configured", async () => {
    const adb = buildFakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: {
        stdout: "List of devices attached\nA1  device model:Pixel_5\nB2  device model:Pixel_6\n",
      },
    });
    const rig = await buildRig({ adbBinary: adb.binaryPath, adbEnv: adb.env });
    try {
      const result = await rig.client.callTool("porthole_connect", {});
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("A1");
      expect(result.text).toContain("B2");
      expect(result.json).toMatchObject({ ambiguous: true });
    } finally {
      await closeAll(rig, adb);
    }
  });

  it("says a release build has no runtime in it, instead of a generic 'not connected' — GRA-62 AC4", async () => {
    // buildRig's default hello reports packageName "com.example.shop" — the
    // package porthole_connect's own default-resolution falls back to.
    const adb = buildFakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: { stdout: "List of devices attached\nA1  device model:Pixel_5\n" },
      [fakeAdbArgsKey(["-s", "A1", "forward", `tcp:${PORT}`, `tcp:${PORT}`])]: {},
      [fakeAdbArgsKey(["-s", "A1", "shell", "dumpsys", "package", "com.example.shop"])]: {
        stdout: "Package [com.example.shop] (abcd1234):\n    versionName=1.0.0\n    flags=[ HAS_CODE ]\n",
      },
    });
    const rig = await buildRig({ adbBinary: adb.binaryPath, adbEnv: adb.env });
    try {
      const result = await rig.client.callTool("porthole_connect", {});
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("release build");
      expect(result.json).toMatchObject({ installed: true, debuggable: false });
    } finally {
      await closeAll(rig, adb);
    }
  });

  it("offers to launch an installed-but-not-running debug build, rather than launching unasked — GRA-62 AC4", async () => {
    const adb = buildFakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: { stdout: "List of devices attached\nA1  device model:Pixel_5\n" },
      [fakeAdbArgsKey(["-s", "A1", "forward", `tcp:${PORT}`, `tcp:${PORT}`])]: {},
      [fakeAdbArgsKey(["-s", "A1", "shell", "dumpsys", "package", "com.example.shop"])]: {
        stdout:
          "Package [com.example.shop] (abcd1234):\n    versionName=1.0.0\n    flags=[ DEBUGGABLE HAS_CODE ]\n",
      },
      [fakeAdbArgsKey(["-s", "A1", "shell", "pidof", "com.example.shop"])]: { exitCode: 1 },
    });
    const rig = await buildRig({ adbBinary: adb.binaryPath, adbEnv: adb.env });
    try {
      const result = await rig.client.callTool("porthole_connect", {});
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("not running");
      expect(result.text).toContain("launch: true");
      expect(result.json).toMatchObject({ installed: true, debuggable: true, running: false });
      // Did not launch it: no monkey call should have run.
      expect(adb.calls().some((c) => c.includes("monkey"))).toBe(false);
    } finally {
      await closeAll(rig, adb);
    }
  });

  it("launches the app when asked, issuing the monkey launcher intent", async () => {
    const adb = buildFakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: { stdout: "List of devices attached\nA1  device model:Pixel_5\n" },
      [fakeAdbArgsKey(["-s", "A1", "forward", `tcp:${PORT}`, `tcp:${PORT}`])]: {},
      [fakeAdbArgsKey(["-s", "A1", "shell", "dumpsys", "package", "com.example.shop"])]: {
        stdout:
          "Package [com.example.shop] (abcd1234):\n    versionName=1.0.0\n    flags=[ DEBUGGABLE HAS_CODE ]\n",
      },
      [fakeAdbArgsKey(["-s", "A1", "shell", "pidof", "com.example.shop"])]: { exitCode: 1 },
      [fakeAdbArgsKey([
        "-s",
        "A1",
        "shell",
        "monkey",
        "-p",
        "com.example.shop",
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
      ])]: { stdout: "Events injected: 1\n" },
    });
    const rig = await buildRig({ adbBinary: adb.binaryPath, adbEnv: adb.env });
    try {
      const result = await rig.client.callTool("porthole_connect", { launch: true });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("Launched com.example.shop");
      expect(result.json).toMatchObject({ launched: true });
    } finally {
      await closeAll(rig, adb);
    }
  });

  it("restarts an already-running app when asked — force-stop then the launcher intent, the same pair restartApp always issues", async () => {
    const adb = buildFakeAdb({
      [fakeAdbArgsKey(["devices", "-l"])]: { stdout: "List of devices attached\nA1  device model:Pixel_5\n" },
      [fakeAdbArgsKey(["-s", "A1", "forward", `tcp:${PORT}`, `tcp:${PORT}`])]: {},
      [fakeAdbArgsKey(["-s", "A1", "shell", "dumpsys", "package", "com.example.shop"])]: {
        stdout:
          "Package [com.example.shop] (abcd1234):\n    versionName=1.0.0\n    flags=[ DEBUGGABLE HAS_CODE ]\n",
      },
      [fakeAdbArgsKey(["-s", "A1", "shell", "pidof", "com.example.shop"])]: { stdout: "12345\n" },
      [fakeAdbArgsKey(["-s", "A1", "shell", "am", "force-stop", "com.example.shop"])]: {},
      [fakeAdbArgsKey([
        "-s",
        "A1",
        "shell",
        "monkey",
        "-p",
        "com.example.shop",
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
      ])]: { stdout: "Events injected: 1\n" },
    });
    const rig = await buildRig({ adbBinary: adb.binaryPath, adbEnv: adb.env });
    try {
      const result = await rig.client.callTool("porthole_connect", { restart: true });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("Restarted com.example.shop");
      expect(result.json).toMatchObject({ restarted: true });
      // Force-stop strictly before the relaunch — a restart that launched
      // first would leave two processes racing instead of one fresh one.
      const tags = adb.calls().map((c) => c.join(" "));
      const stopIndex = tags.findIndex((c) => c.includes("force-stop"));
      const monkeyIndex = tags.findIndex((c) => c.includes("monkey"));
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(monkeyIndex).toBeGreaterThan(stopIndex);
    } finally {
      await closeAll(rig, adb);
    }
  });
});

// ---------------------------------------------------------------------------
// GRA-63: the agent can see the screen
// ---------------------------------------------------------------------------

describe("screenshot", () => {
  function solidPng(width: number, height: number, [r, g, b]: [number, number, number] = [0, 0, 0]): Buffer {
    const png = new PNG({ width, height });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
    return PNG.sync.write(png);
  }

  it("is readOnlyHint:true — capturing the screen touches nothing on the device", () => {
    const block = toolSource("screenshot");
    expect(block).toContain("readOnlyHint: true");
  });

  it("returns an image content block a multimodal agent can read, plus a text summary and JSON payload", async () => {
    const adb = buildFakeScreencapAdb(solidPng(1200, 2000, [40, 90, 200]));
    const rig = await buildRig({ adbBinary: adb.binaryPath, adbEnv: adb.env });
    try {
      const result = await rig.client.callTool("screenshot", {});
      expect(result.isError).toBeFalsy();

      const image = result.content.find((c) => c.type === "image") as
        | { type: "image"; data: string; mimeType: string }
        | undefined;
      expect(image, "no image content block in the result").toBeDefined();
      expect(image?.mimeType).toBe("image/jpeg");
      // Round-trip: what came back must actually decode as a JPEG, not just
      // be a base64 string of the right shape.
      const decoded = jpeg.decode(Buffer.from(image!.data, "base64"));
      expect(decoded.width).toBeGreaterThan(0);
      expect(decoded.height).toBeGreaterThan(0);

      expect(result.json).toMatchObject({ ok: true, originalWidth: 1200, originalHeight: 2000 });
      expect(result.text).toContain("Captured");
    } finally {
      await rig.close();
      adb.cleanup();
    }
  });

  it("refuses a black capture — names FLAG_SECURE, carries no image block", async () => {
    const adb = buildFakeScreencapAdb(solidPng(200, 400, [0, 0, 0]));
    const rig = await buildRig({ adbBinary: adb.binaryPath, adbEnv: adb.env });
    try {
      const result = await rig.client.callTool("screenshot", {});
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("FLAG_SECURE");
      expect(result.content.some((c) => c.type === "image")).toBe(false);
      expect(result.json).toMatchObject({ ok: false, reason: "black-frame" });
    } finally {
      await rig.close();
      adb.cleanup();
    }
  });

  it("passes displayId through to the adb call", async () => {
    const adb = buildFakeScreencapAdb(solidPng(20, 20, [10, 20, 30]));
    const rig = await buildRig({ adbBinary: adb.binaryPath, adbEnv: adb.env });
    try {
      const result = await rig.client.callTool("screenshot", { displayId: 2 });
      expect(result.isError).toBeFalsy();
      expect(adb.calls()[0]).toEqual(["exec-out", "screencap", "-p", "-d", "2"]);
    } finally {
      await rig.close();
      adb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// GRA-230 (QA on GRA-62/GRA-63): the not-connected message names
// porthole_status/porthole_connect everywhere it appears, not just where
// porthole_status's own active remediation already fixed it in production.
// device.test.ts's "notConnectedMessage's checklist" is the direct,
// unit-level pin on the shared string itself; this is the same property
// proven through the actual running server, on the tool paths that surface
// it (findings' and what_was_happening's empty-ring branches, and
// porthole_status's own, all of which route through the one shared
// `device.pendingMessage()` — see notConnectedMessage()'s own doc comment).
// ---------------------------------------------------------------------------

describe("every tool's not-connected text names porthole_status and porthole_connect", () => {
  it("findings, what_was_happening and porthole_status all point at the tools that can fix it, not a manual adb checklist alone", async () => {
    const rig = await buildRig({ connectDevice: false });
    try {
      for (const name of ["findings", "what_was_happening", "porthole_status"]) {
        const result = await rig.client.callTool(name, {});
        expect(result.isError, `${name} unexpectedly errored`).toBeFalsy();
        expect(result.text, `${name}'s not-connected text does not name porthole_status`).toContain(
          "porthole_status",
        );
        expect(result.text, `${name}'s not-connected text does not name porthole_connect`).toContain(
          "porthole_connect",
        );
      }
    } finally {
      await rig.close();
    }
  });
});
