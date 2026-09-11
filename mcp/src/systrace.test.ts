// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  captureArgs,
  countPortholeLabels,
  DEFAULT_CATEGORIES,
  describeCapture,
  planCapture,
} from "./systrace.js";

/**
 * The failure this file exists for did not look like a failure.
 *
 * The first version passed `app` as an atrace category, on the assumption that
 * the tag the runtime writes under is selected the way every other one is. The
 * capture succeeded, the file was the right size, and it contained not a single
 * Porthole slice. Reading debug.atrace.tags.enableflags during a capture gave
 * 0xa — VIEW and GRAPHICS set, ATRACE_TAG_APP (0x1000) clear. App sections are
 * enabled per package with `--app`, and `app` is not in
 * `atrace --list_categories` at all.
 *
 * Nothing about that is visible from the result of the capture, which is why it
 * is pinned here rather than left to be noticed in a trace viewer.
 */

describe("planning a capture", () => {
  it("does not offer `app` as a category, because it is not one", () => {
    expect(DEFAULT_CATEGORIES).not.toContain("app");
  });

  it("drops `app` if asked for it, and says why", () => {
    const plan = planCapture({ categories: ["app", "sched"], apps: ["com.example"] });
    expect(plan.categories).not.toContain("app");
    expect(plan.categories).toContain("sched");
    expect(plan.notes.join(" ")).toMatch(/not one|enabled per package/);
  });

  it("turns the app tag on per package, which is the part that matters", () => {
    const plan = planCapture({ apps: ["com.example.shop"] });
    const args = captureArgs(plan);
    const at = args.indexOf("--app");
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe("com.example.shop");
  });

  it("passes one --app per package rather than a joined list", () => {
    const args = captureArgs(planCapture({ apps: ["a.one", "b.two"] }));
    expect(args.filter((a) => a === "--app")).toHaveLength(2);
    expect(args).toContain("a.one");
    expect(args).toContain("b.two");
  });

  it("warns when no app is named, since the trace will be unannotated", () => {
    // The capture still succeeds, which is exactly why silence is dangerous.
    const plan = planCapture({});
    expect(plan.apps).toEqual([]);
    expect(plan.notes.join(" ")).toMatch(/no Porthole sections/);
  });

  it("clamps a duration rather than handing it to the device", () => {
    expect(planCapture({ seconds: 9999 }).seconds).toBe(120);
    expect(planCapture({ seconds: 0.2 }).seconds).toBe(1);
    expect(planCapture({ seconds: 9999 }).notes.join(" ")).toMatch(/clamped/);
  });

  it("writes where the trace service can actually write", () => {
    // /sdcard is not writable by traced; the capture fails with a permission
    // error that reads like adb being broken.
    expect(planCapture({}).devicePath).toMatch(/^\/data\/misc\/perfetto-traces\//);
  });
});

describe("reporting what landed in the trace", () => {
  it("finds the runtime's labels by their prefix", () => {
    const trace = Buffer.concat([
      Buffer.from([0x0a, 0x1f, 0x00]),
      Buffer.from("porthole: nav → cart/{id}", "utf8"),
      Buffer.from([0x00]),
      Buffer.from("porthole: db SELECT * FROM cart_items", "utf8"),
    ]);
    expect(countPortholeLabels(trace)).toBe(2);
  });

  it("finds none in a trace that has none", () => {
    expect(countPortholeLabels(Buffer.from("sched_switch prev_comm=foo", "utf8"))).toBe(0);
  });

  it("says a trace is unannotated rather than letting it look fine", () => {
    const line = describeCapture({
      path: "/tmp/t.pftrace",
      bytes: 2_400_000,
      seconds: 8,
      categories: ["sched"],
      portholeLabels: 0,
      notes: [],
    });
    expect(line).toMatch(/No Porthole labels/);
    // Still valid, and it should say so: the trace is usable, just not ours.
    expect(line).toMatch(/still valid/);
  });

  it("does not offer to read the trace, because it cannot", () => {
    const line = describeCapture({
      path: "/tmp/t.pftrace",
      bytes: 1,
      seconds: 1,
      categories: [],
      portholeLabels: 3,
      notes: [],
    });
    expect(line).toMatch(/nothing here reads it for you/);
  });
});
