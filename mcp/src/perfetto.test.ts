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
  matchBatch,
  QUESTIONS,
  runBatch,
  runScript,
  type HoistedQuestion,
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
