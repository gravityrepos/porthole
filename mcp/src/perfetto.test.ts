// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTraceProcessor, interpret, QUESTIONS, type Rows } from "./perfetto.js";

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
