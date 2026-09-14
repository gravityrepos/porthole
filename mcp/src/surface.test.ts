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
 *
 * Normalises CRLF to LF first (GRA-166 item 6). Without this, a line ending
 * in "\r\n" defeats the "//" stripping below: `.` in `/\/\/.*$/` does not
 * match "\r" (it is a line terminator to the regex engine even without the
 * `s` flag), and `$` without the `m` flag demands the true end of the
 * string — so on a line carrying a trailing "\r" the pattern never reaches
 * it and the replace silently no-ops, leaving the raw comment text in
 * place. That is exactly how a prose comment like `// ... state ===
 * "connected" ...` in `index.ts` starts matching the offender pattern below
 * on a CRLF-ending file even though the only line-ending byte changed and
 * no comparison was added: a false positive on a clean tree, which is worse
 * than a missed real one — see the describe block below for why. `.gitattributes`
 * pins `* text=auto eol=lf` (an `eol` directive overrides `core.autocrlf`
 * unconditionally), so a plain `git clone` cannot actually produce this —
 * the real routes are an editor saving CRLF, a patch or archive applied
 * outside git, or an edit to `.gitattributes` itself. Narrower than it
 * looks, but still a route, and still a false positive rather than a missed
 * real one when it happens. Collapsing "\r\n" to "\n" up front costs
 * nothing (it cannot change how many lines the file has, only how each
 * line's own terminator is spelled) and makes every reader of this function
 * — comment-blanking included — see the same normalised text regardless of
 * which line ending the checkout happened to produce.
 */
function stripComments(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const noBlockComments = normalized.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, " "),
  );
  return noBlockComments
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("stripComments (GRA-166 item 6)", () => {
  it("blanks a // comment whose line ends in \\r\\n, not just \\n", () => {
    // Direct unit test on the normalisation step itself. The two describe
    // blocks below that consume stripComments() only ever read real files
    // off this checkout, and .gitattributes pins every checkout to LF (see
    // the doc comment above stripComments()) — so nothing else in this file
    // exercises the CRLF branch, ever. Without this test, deleting
    // `text.replace(/\r\n/g, "\n")` from stripComments() leaves the whole
    // suite green: the fix would have shipped with zero coverage of the
    // exact line it added. Feeding stripComments() a CRLF string directly,
    // rather than writing a temp file or mutating index.ts, is what makes
    // this test independent of the working tree's own line endings.
    const crlf = 'const ok = 1;\r\n// state === "connected", left here on purpose\r\nconst after = 2;\r\n';
    const stripped = stripComments(crlf);
    expect(stripped).not.toContain('state === "connected"');
    // And the blanking is real, not a side effect of the whole line
    // vanishing — the code before and after the comment must survive.
    expect(stripped).toContain("const ok = 1;");
    expect(stripped).toContain("const after = 2;");
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
