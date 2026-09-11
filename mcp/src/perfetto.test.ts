// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { interpret, QUESTIONS, type Rows } from "./perfetto.js";

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
    expect(QUESTIONS.length).toBeLessThanOrEqual(6);
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

  it("claims nothing when asked about nothing", () => {
    expect(interpret({})).toEqual([]);
  });

  it("does not invent a cause from adjacency", () => {
    // Everything here is a direct reading. If a finding is ever derived by
    // putting two things next to each other it must say `correlated`.
    for (const f of findings) expect(f.confidence).toBe("observed");
  });
});
