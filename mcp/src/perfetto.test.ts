// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findTraceProcessor,
  hoistModules,
  interpret,
  MARKER_PREFIX,
  matchBatch,
  QUESTIONS,
  runBatch,
  runScript,
  type HoistedQuestion,
  type Question,
  type Rows,
  type RunFn,
} from "./perfetto.js";

/**
 * The fixtures are real: three exports taken from Perfetto's own UI against a
 * capture of the sample app on a Pixel, covering a frame that missed its
 * deadline by 117ms. They are the answers trace_processor gives to the three
 * questions in this module, which makes them the right thing to interpret
 * against — the alternative is inventing rows in the shape I expect, and every
 * time I have done that today the device has disagreed.
 */

const load = (name: string): Array<Record<string, unknown>> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const rows: Rows = {
  jank: load("jank"),
  thread_states: load("thread-states"),
  slices: load("slices"),
};

describe("the questions", () => {
  it("are a fixed set, not an interface for arbitrary SQL", () => {
    // The moment this grows a `query` parameter it stops being a tool and
    // becomes a worse Perfetto, with an agent guessing at a hundred tables.
    // Six was the ceiling set when this was designed; five are in.
    expect(QUESTIONS.length).toBeLessThanOrEqual(6);
    expect(QUESTIONS.length).toBe(5);
    for (const q of QUESTIONS) {
      expect(q.sql).toContain("$from");
      expect(q.sql).toContain("$to");
      // Narrowed to one process, which is the step a person otherwise performs
      // by picking their app out of the list before exporting anything.
      expect(q.sql, `${q.id} would answer for the whole device`).toContain("$package");
    }
  });
});

describe("reading a real capture", () => {
  const findings = interpret(rows);

  it("reports the deadline miss as Android classified it", () => {
    const frame = findings.find((f) => f.id === "trace-frame-deadline");
    expect(frame?.title).toContain("App Deadline Missed");
    expect(frame?.evidence?.worstMs).toBe(117.3);
    // Android's own label, so it is observed rather than inferred.
    expect(frame?.confidence).toBe("observed");
  });

  it("rules out CPU starvation, which is the half Porthole cannot see", () => {
    const contention = findings.find((f) => f.id === "trace-main-thread-contention");
    // 3.08ms runnable against a 117ms miss: the app was scheduled when it
    // wanted to run, so the time went on work it chose to do.
    expect(contention?.title).toContain("not waiting for a CPU");
    expect(contention?.severity).toBe("note");
    expect(Number(contention?.evidence?.runnableMs)).toBeLessThan(5);
  });

  it("finds the main thread despite the kernel truncating its name", () => {
    // comm is 16 bytes, so "com.example.shop" arrives as "om.example.shop".
    // Matching on equality finds nothing and the tool silently concludes the
    // main thread never waited for anything.
    const contention = findings.find((f) => f.id === "trace-main-thread-contention");
    expect(contention).toBeDefined();
    expect(Number(contention?.evidence?.runnableMs)).toBeGreaterThan(0);
  });

  it("names work in the process that the app did not write", () => {
    // 86ms of ART compiling, which reads as the app being slow unless someone
    // says otherwise. It is the app being new.
    const art = findings.find((f) => f.id.includes("ART-compiling"));
    expect(art?.title).toMatch(/ART compiling bytecode/);
    expect(Number(art?.evidence?.totalMs)).toBeGreaterThan(80);
    expect(art?.detail).toMatch(/not representative/);
  });

  it("puts the error above the notes", () => {
    expect(findings[0].severity).toBe("error");
  });

  /**
   * Unlike everything above, these rows are constructed rather than exported:
   * answering them needs trace_processor, which is not installed here. The
   * shapes follow the columns the queries select, and the interpretation is
   * what is being pinned — but the SQL itself has not been run against a real
   * trace, and today has repeatedly shown that is where the surprises live.
   */
  it("separates one blocking call into another process from chatter", () => {
    const blocking = interpret({
      binder: [
        { target: "system_server", COUNT: "2", "SUM(dur)": "41000000", "MAX(dur)": "38000000" },
      ],
    });
    const found = blocking.find((f) => f.id === "trace-binder");
    expect(found?.severity).toBe("warning");
    expect(found?.title).toContain("system_server");
    expect(found?.detail).toMatch(/not in this one/);

    const chatter = interpret({
      binder: [
        { target: "system_server", COUNT: "60", "SUM(dur)": "30000000", "MAX(dur)": "900000" },
      ],
    });
    expect(chatter.find((f) => f.id === "trace-binder")?.severity).toBe("note");
  });

  it("says the render path is not something recompositions can explain", () => {
    const found = interpret({
      render: [
        { name: "flush commands", thread_name: "RenderThread", COUNT: "40", "SUM(dur)": "62000000" },
      ],
    }).find((f) => f.id === "trace-render");
    expect(found?.title).toContain("flush commands");
    expect(found?.detail).toMatch(/recompositions` will have nothing to say/);
  });

  it("stays quiet about binder chatter too small to matter", () => {
    const tiny = interpret({
      binder: [{ target: "x", COUNT: "1", "SUM(dur)": "100000", "MAX(dur)": "100000" }],
    });
    expect(tiny.find((f) => f.id === "trace-binder")).toBeUndefined();
  });

  it("claims nothing when asked about nothing", () => {
    expect(interpret({})).toEqual([]);
  });

  it("does not invent a cause from adjacency", () => {
    // Everything here is a direct reading. If a finding is ever derived by
    // putting two things next to each other it must say `correlated`.
    for (const f of findings) expect(f.confidence).toBe("observed");
  });
});

/**
 * `portholeTraceProcessor` puts the binary somewhere specific and then says
 * nothing further is needed. That promise is only kept if this function looks
 * where the task actually wrote.
 */
describe("findTraceProcessor", () => {
  let home: string;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "porthole-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.PORTHOLE_TRACE_PROCESSOR;
  });

  afterEach(() => {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  });

  const cache = (version: string, name: string) => {
    const dir = join(home, ".porthole", "trace-processor", version);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, "");
    return file;
  };

  it("finds what the Gradle task cached", () => {
    const file = cache("v58.2", "trace_processor_shell");
    expect(findTraceProcessor()).toBe(file);
  });

  it("finds the Windows binary too", () => {
    const file = cache("v58.2", "trace_processor_shell.exe");
    expect(findTraceProcessor()).toBe(file);
  });

  it("prefers the newest version numerically, not alphabetically", () => {
    // "v9.0" sorts above "v58.2" as a string, which would quietly pin every
    // session to whichever version was released first.
    cache("v9.0", "trace_processor_shell");
    const newer = cache("v58.2", "trace_processor_shell");
    expect(findTraceProcessor()).toBe(newer);
  });

  it("lets an explicit path win over the cache", () => {
    cache("v58.2", "trace_processor_shell");
    const mine = join(home, "my_trace_processor");
    writeFileSync(mine, "");
    process.env.PORTHOLE_TRACE_PROCESSOR = mine;
    expect(findTraceProcessor()).toBe(mine);
  });

  it("returns null rather than a path that is not there", () => {
    // An empty cache directory is the state right after a failed download.
    mkdirSync(join(home, ".porthole", "trace-processor", "v58.2"), { recursive: true });
    expect(findTraceProcessor()).toBeNull();
  });

  it("survives there being no cache at all", () => {
    expect(findTraceProcessor()).toBeNull();
  });
});

/**
 * `hoistModules` is what GRA-61 (five more trace questions) and GRA-85 (a
 * project's own question) will both extend, so it is tested against the
 * real `QUESTIONS` array rather than a hand-built stand-in: a test against a
 * toy input would keep passing even if a future question's module stopped
 * being pulled out correctly, which is precisely the failure this exists to
 * catch.
 */
describe("hoistModules", () => {
  const { modules, questions } = hoistModules(QUESTIONS);

  it("declares a module shared by two questions once, not twice", () => {
    // render and slices both need slices.with_context.
    expect(modules.filter((m) => m === "slices.with_context")).toHaveLength(1);
  });

  it("still declares a module only one question needs", () => {
    expect(modules).toContain("android.binder");
  });

  it("strips every question's own INCLUDE line, module or not", () => {
    for (const q of questions) {
      expect(q.sql).not.toMatch(/INCLUDE\s+PERFETTO\s+MODULE/i);
    }
  });

  it("leaves a question with nothing to hoist otherwise unchanged", () => {
    const jank = questions.find((q) => q.id === "jank");
    expect(jank?.sql).toContain("actual_frame_timeline_slice");
  });

  it("carries every question's id and asks text through unchanged", () => {
    expect(questions.map((q) => q.id)).toEqual(QUESTIONS.map((q) => q.id));
    expect(questions.map((q) => q.asks)).toEqual(QUESTIONS.map((q) => q.asks));
  });

  /**
   * Every test above iterates the real `QUESTIONS`, where no single question
   * declares two modules — `render` and `slices` each declare one, and they
   * happen to be the same one. That makes the loop inside `hoistModules`
   * (`while ((match = finder.exec(...)))`) structurally untested: swap it for
   * an `if` and every existing assertion still passes, because taking only
   * the first match of a question that only ever has one match is
   * indistinguishable from taking all of them. This is the exact failure the
   * code comment on `hoistModules` names as the thing to guard against, so it
   * needs a question that actually declares two.
   */
  it("hoists every module a single question declares, not just its first", () => {
    const synthetic: Question[] = [
      {
        id: "synthetic",
        asks: "a question that needs two modules at once",
        sql: `INCLUDE PERFETTO MODULE android.binder;
              INCLUDE PERFETTO MODULE slices.with_context;
              SELECT 1 AS one`,
      },
    ];
    const { modules, questions: hoisted } = hoistModules(synthetic);
    expect(modules).toEqual(["android.binder", "slices.with_context"]);
    expect(hoisted[0].sql).not.toMatch(/INCLUDE\s+PERFETTO\s+MODULE/i);
    expect(hoisted[0].sql).toContain("SELECT 1 AS one");
  });
});

describe("matchBatch", () => {
  const markerBlock = (id: string) => `"marker"\n"porthole:${id}"`;

  it("pairs each marker with the data block that follows it, in order", () => {
    const stdout = [
      `${markerBlock("a")}\n\n"x"\n"1"`,
      `${markerBlock("b")}\n\n"y"\n"2"`,
    ].join("\n\n");
    const { rows, answered } = matchBatch(stdout, ["a", "b"]);
    expect(answered).toBe(2);
    expect(rows.get("a")).toEqual([{ x: "1" }]);
    expect(rows.get("b")).toEqual([{ y: "2" }]);
  });

  it("does not mistake a data row with an embedded quote for a marker", () => {
    // trace_processor does not escape a quote inside a quoted field, so a
    // slice name like `he said "hi"` prints as `"he said "hi""`. That is
    // exactly the shape that breaks a split which goes looking for a magic
    // string anywhere in the byte stream; here the marker is a whole separate
    // statement; this row is just data, whatever it contains.
    const stdout = [
      `${markerBlock("a")}\n\n"name"\n"he said "hi""`,
      `${markerBlock("b")}\n\n"y"\n"2"`,
    ].join("\n\n");
    const { rows, answered } = matchBatch(stdout, ["a", "b"]);
    expect(answered).toBe(2);
    expect(rows.get("a")).toEqual([{ name: 'he said "hi"' }]);
    expect(rows.get("b")).toEqual([{ y: "2" }]);
  });

  it("does not mistake an all-[NULL] row for a missing block", () => {
    // trace_processor writes NULL as the literal, quoted "[NULL]". A row that
    // is [NULL] in its one column is still a real, present data block — the
    // risk named on the ticket for this work was confusing that with "no
    // block at all", which is what a failed or killed question looks like.
    const stdout = [
      `${markerBlock("a")}\n\n"io_wait"\n"[NULL]"`,
      `${markerBlock("b")}\n\n"y"\n"2"`,
    ].join("\n\n");
    const { rows, answered } = matchBatch(stdout, ["a", "b"]);
    expect(answered).toBe(2);
    expect(rows.get("a")).toEqual([{ io_wait: null }]);
  });

  it("stops at the first id whose marker has no data block after it", () => {
    // What a mid-script failure and a killed process both look like: the
    // marker for the next question printed, and then nothing.
    const stdout = `${markerBlock("a")}\n\n"x"\n"1"\n\n${markerBlock("b")}`;
    const { rows, answered } = matchBatch(stdout, ["a", "b"]);
    expect(answered).toBe(1);
    expect(rows.get("a")).toEqual([{ x: "1" }]);
    expect(rows.has("b")).toBe(false);
  });

  /**
   * QA's reproducer for the FAIL this shipped with: a value containing two
   * consecutive newlines used to be indistinguishable from the blank line
   * that separated one statement's CSV block from the next, because the old
   * `splitBlocks` split on `/\r?\n\r?\n/` rather than looking for the marker
   * itself. Reachable through `slices`, whose `s.name` is a developer's own
   * atrace section name — arbitrary text via `Trace.beginSection`.
   *
   * Scanning for the literal next marker instead of a blank line means the
   * whole multi-line block — the corrupted row and all — is now captured and
   * handed to the *following* question correctly, rather than the corrupted
   * remainder being mistaken for that question's marker. What is left over is
   * the pre-existing, separate `parseRows` limitation this ticket is not
   * responsible for: a single embedded newline still splits one CSV row into
   * two garbage rows. That is the known, inherited shape asserted below —
   * `{"name":"a","k":null}` and `{"name":'b"',"k":"99"}` — not a new failure.
   * The property this test actually pins is that "two" and "three" are
   * answered cleanly and never reported as unanswered.
   */
  it("does not lose the next question when a value contains a blank line (FAIL 1 reproducer)", () => {
    const corrupted = `"name","k"\n"a\n\nb","99"`;
    const stdout = [
      `${markerBlock("one")}\n\n${corrupted}`,
      `${markerBlock("two")}\n\n"z"\n"2"`,
      `${markerBlock("three")}\n\n"z"\n"3"`,
    ].join("\n\n");

    const { rows, answered } = matchBatch(stdout, ["one", "two", "three"]);

    expect(answered).toBe(3);
    // The inherited (not introduced) garbage: a single embedded newline still
    // splits this row into two, which is a separate, pre-existing bug and not
    // this ticket's to fix.
    expect(rows.get("one")).toEqual([
      { name: "a", k: null },
      { name: 'b"', k: "99" },
    ]);
    // The property that actually matters: the next two questions are neither
    // corrupted nor swallowed by question one's broken block.
    expect(rows.get("two")).toEqual([{ z: "2" }]);
    expect(rows.get("three")).toEqual([{ z: "3" }]);
  });

  /**
   * M5 (delete the marker *id* check, keep only the `"marker"` header check)
   * survived the first pass because the shipped "keys every question's real
   * rows onto its own id" test builds its fixture already in order — a batch
   * that never actually arrives out of order cannot exercise a guard whose
   * whole job is noticing when it does.
   */
  it("refuses a marker block for the wrong id, even though the header token is right (kills M5)", () => {
    const stdout = markerBlock("b") + `\n\n"y"\n"2"`;
    const { rows, answered } = matchBatch(stdout, ["a", "b"]);
    expect(answered).toBe(0);
    expect(rows.has("a")).toBe(false);
  });

  /**
   * M4 (delete the `"marker"` header-token check, keep only the id check).
   * Without it, a data block whose header is `"name"` and whose row happens
   * to be the literal string `"porthole:a"` — nothing today selects a column
   * named `name` that returns exactly that string, but GRA-85 lets a project
   * supply its own SQL — is consumed as if it were the real marker for `a`.
   * This is the same forgery hole QA flagged for GRA-85's benefit.
   */
  it("refuses a data block whose row merely looks like the next marker (kills M4)", () => {
    const stdout = `"name"\n"${MARKER_PREFIX}a"\n\n"y"\n"2"`;
    const { answered } = matchBatch(stdout, ["a"]);
    expect(answered).toBe(0);
  });

  /**
   * The forgery the M4 test above does NOT cover, checked here rather than
   * assumed: a question's own data whose header is the literal column name
   * `marker` and whose first row is the literal text `porthole:<next-id>` —
   * not a near-miss like the M4 case, but the exact two-line shape
   * `matchBatch` treats as a real marker pair. Nothing in today's `QUESTIONS`
   * can produce that (none select a column named `marker`), so this is
   * unreachable today; GRA-85 lets a project supply its own SQL, at which
   * point it becomes reachable. `matchBatch` cannot tell this apart from a
   * real marker — the header-and-id checks it has are exactly what a forged
   * pair also satisfies — so this pins the resulting behaviour rather than
   * pretending it does not exist: the forged pair is consumed as `b`'s
   * marker, which truncates `a`'s real answer to whatever preceded the
   * forgery and leaves `a` unanswered rather than corrupting `b`'s later
   * data. Fails safe, not silent. Closing this hole for real is GRA-85's
   * job, not this ticket's.
   */
  it("a question's own data that happens to spell out the next marker gets consumed as that marker (documented, not fixed here)", () => {
    const stdout = [
      markerBlock("a"),
      `${markerBlock("b")}\n"another"`, // this is `a`'s own (forged-shaped) data, not b's real marker
      `${markerBlock("b")}\n\n"y"\n"2"`, // b's real marker and data
    ].join("\n\n");
    const { rows, answered } = matchBatch(stdout, ["a", "b"]);
    // `a` never gets a data block of its own: the forged pair inside what
    // should have been its answer is mistaken for `b`'s marker, and the
    // "block between the two markers" left for `a` is empty, which
    // `matchBatch` already treats the same as a mid-script failure.
    expect(answered).toBe(0);
    expect(rows.has("a")).toBe(false);
    expect(rows.has("b")).toBe(false);
  });
});

/**
 * A hand-written stand-in for `runScript` that speaks the same marker
 * protocol a real trace_processor_shell batch does, without spawning
 * anything. `runBatch`'s job — answer everything in one call when it can,
 * isolate a failing question instead of losing the rest, stop rather than
 * retry on a timeout — is a property of this loop, not of the OS process
 * underneath it, so this is what lets that job be tested on every machine
 * this suite runs on rather than only where a 77MB binary has been fetched.
 */
function fakeRun(
  plan: Record<string, { rows?: Array<Record<string, string | number | null>>; fail?: string }>,
): { run: RunFn; callCount: () => number } {
  let calls = 0;
  const run: RunFn = async (_binary, _args, sql) => {
    calls++;
    const ids = [...sql.matchAll(/SELECT 'porthole:([\w.]+)' AS marker;/g)].map((m) => m[1]);
    let stdout = "";
    for (const id of ids) {
      stdout += `"marker"\n"porthole:${id}"\n\n`;
      const spec = plan[id] ?? { rows: [] };
      if (spec.fail) {
        return { code: 1, stdout, stderr: spec.fail, timedOut: false, elapsedMs: 1 };
      }
      const rows = spec.rows ?? [];
      const columns = rows.length > 0 ? Object.keys(rows[0]) : ["value"];
      stdout += columns.map((c) => `"${c}"`).join(",") + "\n";
      for (const row of rows) {
        stdout += columns.map((c) => (row[c] === null ? '"[NULL]"' : `"${row[c]}"`)).join(",") + "\n";
      }
      stdout += "\n";
    }
    return { code: 0, stdout, stderr: "", timedOut: false, elapsedMs: 1 };
  };
  return { run, callCount: () => calls };
}

describe("runBatch", () => {
  const question = (id: string): HoistedQuestion => ({ id, asks: `asks about ${id}`, sql: "SELECT 1" });
  const questions = [question("a"), question("b"), question("c")];
  const options = {
    binary: "unused",
    trace: "some.pftrace",
    packageName: "com.example.shop",
    fromNs: 0,
    toNs: 1,
    timeoutMs: 5_000,
  };

  it("answers everything in one call when nothing fails", async () => {
    const { run, callCount } = fakeRun({
      a: { rows: [{ x: "1" }] },
      b: { rows: [{ x: "2" }] },
      c: { rows: [{ x: "3" }] },
    });
    const { rows, unanswered } = await runBatch(questions, [], options, run);
    expect(callCount()).toBe(1);
    expect(unanswered).toEqual([]);
    expect((rows as Record<string, unknown>).a).toEqual([{ x: "1" }]);
    expect((rows as Record<string, unknown>).c).toEqual([{ x: "3" }]);
  });

  it("keeps the other two when one fails, at the cost of one extra call", async () => {
    const { run, callCount } = fakeRun({
      a: { rows: [{ x: "1" }] },
      b: { fail: "no such table: bogus" },
      c: { rows: [{ x: "3" }] },
    });
    const { rows, unanswered } = await runBatch(questions, [], options, run);
    expect(callCount()).toBe(2);
    expect(unanswered).toHaveLength(1);
    expect(unanswered[0]).toContain("asks about b");
    expect(unanswered[0]).toContain("no such table: bogus");
    expect((rows as Record<string, unknown>).a).toEqual([{ x: "1" }]);
    expect((rows as Record<string, unknown>).c).toEqual([{ x: "3" }]);
    expect((rows as Record<string, unknown>).b).toBeUndefined();
  });

  it("keeps whatever answered before two failures in a row, at the cost of one extra call each", async () => {
    // Three questions, both b and c broken: the first call answers a and
    // fails on b; the second call (just [c], since b is dropped rather than
    // retried) fails again. Two calls in total, not three — the point of
    // dropping the failed question rather than reattempting it.
    const { run, callCount } = fakeRun({
      a: { rows: [{ x: "1" }] },
      b: { fail: "first failure" },
      c: { fail: "second failure" },
    });
    const { rows, unanswered } = await runBatch(questions, [], options, run);
    expect(callCount()).toBe(2);
    expect(unanswered).toHaveLength(2);
    expect(unanswered[0]).toContain("first failure");
    expect(unanswered[1]).toContain("second failure");
    expect((rows as Record<string, unknown>).a).toEqual([{ x: "1" }]);
  });

  it("stops entirely on a timeout rather than retrying into the same hang", async () => {
    let calls = 0;
    const run: RunFn = async () => {
      calls++;
      return { code: null, stdout: "", stderr: "", timedOut: true, elapsedMs: 5_000 };
    };
    const { unanswered } = await runBatch(questions, [], options, run);
    expect(calls).toBe(1);
    expect(unanswered).toHaveLength(3);
    for (const u of unanswered) {
      expect(u).toContain("5000ms");
      expect(u).toContain(options.trace);
    }
  });

  it("stops entirely when the binary itself cannot be run", async () => {
    let calls = 0;
    const run: RunFn = async () => {
      calls++;
      return {
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        elapsedMs: 1,
        spawnError: new Error("ENOENT: no such file"),
      };
    };
    const { unanswered } = await runBatch(questions, [], options, run);
    expect(calls).toBe(1);
    expect(unanswered).toHaveLength(3);
    for (const u of unanswered) expect(u).toContain("ENOENT");
  });

  /**
   * The suite stayed green while M17 deleted the `INCLUDE` emission from the
   * built script entirely: nothing in the existing tests looks at the SQL
   * `run` actually receives. Confirmed against the real binary and a real
   * capture that this is not equivalent-mutant territory — with the
   * emission gone, three of five questions failed with "no such table" and
   * `newFindings` dropped from 6 to 2. This captures the sql `runBatch` sends
   * and checks the hoisted modules are actually in it, ahead of the first
   * marker (an `INCLUDE` after the marker it belongs before would still
   * compile-fail the question that needed it).
   */
  it("puts every hoisted module into the script, ahead of the first marker (kills M17)", async () => {
    const calls: string[] = [];
    const run: RunFn = async (_binary, _args, sql) => {
      calls.push(sql);
      // Stop after one call — spawnError short-circuits runBatch's retry
      // loop, and this test only cares what the first call sent.
      return { code: null, stdout: "", stderr: "", timedOut: false, elapsedMs: 1, spawnError: new Error("stop") };
    };
    const modules = ["android.binder", "slices.with_context"];
    await runBatch(questions, modules, options, run);

    expect(calls).toHaveLength(1);
    const sql = calls[0];
    const firstMarker = sql.indexOf(`SELECT '${MARKER_PREFIX}`);
    expect(firstMarker).toBeGreaterThan(-1);
    for (const module of modules) {
      const includeLine = `INCLUDE PERFETTO MODULE ${module};`;
      const at = sql.indexOf(includeLine);
      expect(at, `${includeLine} missing from the built script`).toBeGreaterThan(-1);
      expect(at).toBeLessThan(firstMarker);
    }
  });

  /**
   * M18 (stop escaping `'` in the package name inside `substitute()`). Low
   * risk — pre-existing behaviour just moved when batching was built — but
   * now untested, and a package name containing an apostrophe (an unlikely
   * but real Android application id character) would otherwise close the SQL
   * string early and corrupt the whole batch rather than one question.
   */
  it("escapes an apostrophe in the package name so the batch stays valid SQL (kills M18)", async () => {
    const calls: string[] = [];
    const run: RunFn = async (_binary, _args, sql) => {
      calls.push(sql);
      return { code: null, stdout: "", stderr: "", timedOut: false, elapsedMs: 1, spawnError: new Error("stop") };
    };
    // Needs a question whose SQL actually references $package — the shared
    // `questions` fixture above does not, so the substitution would have
    // nothing to replace and the escaped name would never show up either way.
    const withPackage: HoistedQuestion[] = [{ id: "a", asks: "asks about a", sql: "SELECT * FROM x WHERE p = $package" }];
    await runBatch(withPackage, [], { ...options, packageName: "o'brien" }, run);
    expect(calls[0]).toContain("'o''brien'");
  });
});

/**
 * `runScript` itself, against a real spawned process rather than a fake —
 * proving the timeout actually kills something, and that the event loop
 * stays free while it waits, needs an OS process on the other end, not a
 * hand-written stand-in that could just declare victory. `cmd.exe` fills
 * that role: it is a real, always-present executable Windows will spawn
 * directly (unlike a `.cmd`/`.bat` file, which needs `shell: true` and is
 * not what production ever passes), and it can be told to succeed, fail or
 * hang on demand.
 */
describe("runScript, against a real process", () => {
  const isWindows = process.platform === "win32";
  const binary = isWindows ? "cmd.exe" : "/bin/sh";
  const args = (command: string) => (isWindows ? ["/d", "/s", "/c", command] : ["-c", command]);
  // An infinite loop cmd.exe runs itself, not one it hands to a child
  // process: `ping` was tried first and did not work for this — killing
  // cmd.exe left the ping.exe it had started still holding the output pipe
  // open, so the pipe never closed and the test hung for the real 30s
  // regardless of the timeout. TerminateProcess only ever reaches the one
  // process handle Node holds, which is exactly the situation trace_processor_
  // shell is in (a single process, nothing it spawns further) but is not what
  // `cmd.exe /c ping` is.
  const hang = isWindows ? "for /l %i in () do @rem" : "sleep 30";
  const short = isWindows ? "ping -n 2 127.0.0.1 >nul" : "sleep 1";

  it("captures a real process's stdout and a clean exit", async () => {
    const result = await runScript(binary, args("echo hello"), "", 5_000);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.timedOut).toBe(false);
  });

  it("reports a nonzero exit without treating it as a timeout", async () => {
    const result = await runScript(binary, args("exit 7"), "", 5_000);
    expect(result.code).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it("kills a wedged process and says how long it waited", async () => {
    const started = Date.now();
    const result = await runScript(binary, args(hang), "", 200);
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    // The real proof this was killed rather than left running: the test
    // returns in a small fraction of the 30s the command asked to hang for.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it("keeps the event loop free while the child runs", async () => {
    const order: string[] = [];
    const running = runScript(binary, args(short), "", 10_000).then(() => order.push("run"));
    const timer = new Promise<void>((resolve) => setTimeout(resolve, 30)).then(() => order.push("timer"));
    await Promise.all([running, timer]);
    // `short` runs for roughly a second; a 30ms timer that fires first is
    // only possible if the child is not blocking the thread it runs on.
    expect(order[0]).toBe("timer");
  }, 15_000);
});
