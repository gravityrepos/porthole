// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTrace, type Finding } from "./trace.js";
import type { DeviceEvent } from "./device.js";
import { buildRig } from "./testing/harness.js";

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

describe("the tool surface", () => {
  // The 16 names `index.ts` registers, in registration order, verified
  // against the running server rather than copied from the ticket that
  // asked for this test — see the "registers exactly these tools" case
  // below, which is what would have caught this list being wrong.
  const REGISTERED_TOOLS = [
    "porthole_status",
    "findings",
    "system_context",
    "ask_system_trace",
    "capture_system_trace",
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

/**
 * Blanks out comments without disturbing line numbers, so an offender's
 * reported line still points at the real line. A block comment's content
 * becomes spaces, one per character, with its own newlines left in place —
 * so a match that would have spanned the comment's start and end markers is
 * neither created nor hidden by the blanking; a line ("//") comment is cut
 * from its marker to the end of its line. This does not understand string
 * literals — a comment marker inside a quoted string would be mistaken for
 * a real comment — which is a known, accepted gap in a file whose own
 * `toolSource()` above makes the same kind of trade: loose about things
 * this codebase does not actually do, strict about the one thing that
 * matters here.
 */
function stripComments(text: string): string {
  const noBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  return noBlockComments
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

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
    // single quotes all pass it unseen. The one worth naming on purpose is a
    // hand-rolled `switch` on `ConnectionState` with no `never`-guarded
    // default: `switch`-on-state is this ticket's own house idiom now, tsc
    // only catches a non-exhaustive one when that guard is present, and this
    // regex does not look for a switch at all. So: the compiler covers a new
    // *state*; this guard covers one spelling of a new *comparison*. Neither
    // is complete alone, and nothing here is complete either.
    const pattern = /\bstate\s*(?:===|!==)\s*"(?:disconnected|connecting|handshaking|connected)"/;
    const offenders: string[] = [];
    for (const file of productionSourceFiles()) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      const lines = stripComments(text).split("\n");
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
