// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { deviceLabel, hitLane, laneStat, navChips, spansForLane } from "./laneData";
import { LANES } from "../timeline/lanes";
import type { DeviceEvent, ViewWindow } from "../types";

const lane = (key: string) => LANES.find((entry) => entry.key === key)!;
const view: ViewWindow = { start: 0, end: 1000 };

function event(name: string, t: number, data: Record<string, unknown> = {}): DeviceEvent {
  return { event: name, t, seq: t, data };
}

describe("laneStat", () => {
  it("reports the peak per frame, not just the total", () => {
    // Three in one 16ms frame, one in another.
    const events = [
      event("recompose", 0),
      event("recompose", 1),
      event("recompose", 2),
      event("recompose", 200),
    ];
    expect(laneStat(lane("recompose"), events, view, false)).toBe("peak 3 / frame · 4 in view");
  });

  it("counts only what is inside the window", () => {
    const events = [event("recompose", 10), event("recompose", 5000)];
    expect(laneStat(lane("recompose"), events, view, false)).toBe("peak 1 / frame · 1 in view");
  });

  it("says hidden or anonymous depending on whether framework writes are shown", () => {
    const events = [
      event("state_write", 10, { named: ["A.b"] }),
      event("state_write", 20, { named: [], unnamed: 1 }),
    ];
    expect(laneStat(lane("state_write"), events, view, false)).toBe("1 yours · 1 hidden");
    expect(laneStat(lane("state_write"), events, view, true)).toBe("1 yours · 1 anonymous");
  });

  it("reports the worst run of missed frames", () => {
    const events = [
      event("frame", 10, { missedFrames: 1 }),
      event("frame", 20, { missedFrames: 24 }),
    ];
    expect(laneStat(lane("frame"), events, view, false)).toBe("2 janky · worst 24 missed");
  });

  it("combines stalls with queries that ran on the main thread", () => {
    const events = [
      event("blocked", 10, { durationMs: 420 }),
      event("db_end", 20, { onMainThread: true }),
    ];
    expect(laneStat(lane("blocked"), events, view, false)).toBe(
      "1 stall · worst 420ms · 1 db on main",
    );
  });

  it("says clear when the main thread was never blocked", () => {
    expect(laneStat(lane("blocked"), [event("db_end", 20, {})], view, false)).toBe("clear");
  });

  it("counts destinations rather than navigations", () => {
    const events = [
      event("nav", 10, { route: "cart" }),
      event("nav", 20, { route: "cart" }),
      event("nav", 30, { route: "home" }),
    ];
    expect(laneStat(lane("nav"), events, view, false)).toBe("2 destinations");
  });

  it("names spans for their own lane and flags failures", () => {
    const http = [
      event("http_start", 10, { id: "a" }),
      event("http_end", 20, { id: "a", status: 500 }),
      event("http_start", 30, { id: "b" }),
      event("http_end", 40, { id: "b", status: 200 }),
    ];
    expect(laneStat(lane("http"), http, view, false)).toBe("2 calls · 1 failed");

    const db = [event("db_start", 10, { id: "q" }), event("db_end", 20, { id: "q" })];
    expect(laneStat(lane("db"), db, view, false)).toBe("1 query");
  });

  it("counts work runs and retries", () => {
    const events = [
      event("work_start", 10, { id: "w1" }),
      event("work_end", 20, { id: "w1", retrying: "true" }),
      event("work_start", 30, { id: "w2" }),
      event("work_end", 40, { id: "w2", state: "SUCCEEDED" }),
    ];
    expect(laneStat(lane("work"), events, view, false)).toBe("2 runs · 1 retried");
  });

  it("counts only warnings and above in the log lane", () => {
    const events = [
      event("log", 10, { level: "I" }),
      event("log", 20, { level: "W" }),
      event("log", 30, { level: "E" }),
    ];
    expect(laneStat(lane("log"), events, view, false)).toBe("2 · 1 error");
  });

  it("summarises the heap against its own ceiling", () => {
    const events = [
      event("memory", 10, { heapUsedMb: 20, heapMaxMb: 192, totalRamMb: 70 }),
      event("memory", 900, { heapUsedMb: 60, heapMaxMb: 192, totalRamMb: 90, gcSinceLast: 2 }),
    ];
    const stat = laneStat(lane("memory"), events, view, false);
    expect(stat).toContain("60/192 MB");
    expect(stat).toContain("90 MB ram");
    expect(stat).toContain("2 GC");
    // Growth across the window is a hint worth surfacing.
    expect(stat).toContain("+40 MB");
  });

  it("says something honest when a lane is empty", () => {
    expect(laneStat(lane("recompose"), [], view, false)).toBe("quiet");
    expect(laneStat(lane("frame"), [], view, false)).toBe("no frames dropped");
    expect(laneStat(lane("http"), [], view, false)).toBe("idle");
    expect(laneStat(lane("nav"), [], view, false)).toBe("no navigation");
    expect(laneStat(lane("memory"), [], view, false)).toBe("no samples");
  });
});

describe("hitLane", () => {
  const width = 1000;

  it("finds the nearest event on its own lane", () => {
    const events = [event("recompose", 100), event("recompose", 800)];
    const hit = hitLane(lane("recompose"), events, [], view, width, 798, false);
    expect(hit).toMatchObject({ kind: "event" });
    expect(hit && hit.kind === "event" && hit.event.t).toBe(800);
  });

  it("keeps the grab radius tight, so a click lands on what is under it", () => {
    const events = [event("recompose", 800)];
    // The radius is twelve pixels' worth of time at this zoom: close enough to
    // forgive an unsteady hand, far from "whatever is nearest on this lane".
    expect(hitLane(lane("recompose"), events, [], view, width, 790, false)).not.toBeNull();
    expect(hitLane(lane("recompose"), events, [], view, width, 780, false)).toBeNull();
  });

  it("ignores events belonging to other lanes", () => {
    const events = [event("log", 500, { level: "E" })];
    expect(hitLane(lane("recompose"), events, [], view, width, 500, false)).toBeNull();
  });

  it("misses when the pointer is nowhere near", () => {
    const events = [event("recompose", 10)];
    expect(hitLane(lane("recompose"), events, [], view, width, 900, false)).toBeNull();
  });

  it("will not select a write that is hidden from view", () => {
    const events = [event("state_write", 500, { named: [], unnamed: 2 })];
    expect(hitLane(lane("state_write"), events, [], view, width, 500, false)).toBeNull();
    expect(hitLane(lane("state_write"), events, [], view, width, 500, true)).not.toBeNull();
  });

  it("catches both stalls and main-thread queries on the blocked lane", () => {
    const stall = [event("blocked", 500, { durationMs: 300 })];
    const query = [event("db_end", 500, { onMainThread: true })];
    expect(hitLane(lane("blocked"), stall, [], view, width, 500, false)).not.toBeNull();
    expect(hitLane(lane("blocked"), query, [], view, width, 500, false)).not.toBeNull();
  });

  it("hits anywhere along a span, not only its edges", () => {
    const events = [event("http_start", 200, { id: "a" }), event("http_end", 800, { id: "a" })];
    const spans = spansForLane(lane("http"), events);
    for (const x of [210, 500, 790]) {
      expect(hitLane(lane("http"), events, spans, view, width, x, false)).toMatchObject({
        kind: "span",
      });
    }
    expect(hitLane(lane("http"), events, spans, view, width, 50, false)).toBeNull();
  });

  it("only selects log lines the lane actually draws", () => {
    const info = [event("log", 500, { level: "I" })];
    const warn = [event("log", 500, { level: "W" })];
    expect(hitLane(lane("log"), info, [], view, width, 500, false)).toBeNull();
    expect(hitLane(lane("log"), warn, [], view, width, 500, false)).not.toBeNull();
  });
});

describe("navChips", () => {
  const width = 1000;

  it("labels a lone navigation with its route", () => {
    const { rules, chips } = navChips([event("nav", 500, { route: "cart/{id}" })], view, width);
    expect(rules).toHaveLength(1);
    expect(chips.map((chip) => chip.label)).toEqual(["cart/{id}"]);
  });

  it("keeps every rule but collapses labels that would collide", () => {
    const events = [0, 1, 2, 3].map((i) => event("nav", 500 + i, { route: "cart" }));
    const { rules, chips } = navChips(events, view, width);

    expect(rules).toHaveLength(4);
    expect(chips).toHaveLength(1);
    expect(chips[0].label).toBe("cart ×4");
  });

  it("marks a mixed cluster with a count of the others", () => {
    const events = [
      event("nav", 500, { route: "cart" }),
      event("nav", 501, { route: "home" }),
      event("nav", 502, { route: "detail" }),
    ];
    expect(navChips(events, view, width).chips[0].label).toBe("cart +2");
  });

  it("separates the labels again once there is room", () => {
    const events = [event("nav", 100, { route: "cart" }), event("nav", 900, { route: "home" })];
    const { chips } = navChips(events, view, width);
    expect(chips.map((chip) => chip.label)).toEqual(["cart", "home"]);
  });

  it("drops navigations scrolled out of the window", () => {
    const events = [event("nav", -5000, { route: "gone" }), event("nav", 500, { route: "here" })];
    expect(navChips(events, view, width).rules).toHaveLength(1);
  });

  it("returns rules but no labels before the plot has been measured", () => {
    const { rules, chips } = navChips([event("nav", 500, { route: "cart" })], view, 0);
    expect(rules).toHaveLength(1);
    expect(chips).toHaveLength(0);
  });
});

describe("device lane", () => {
  const at = (kind: string, t: number, data: Record<string, unknown> = {}) =>
    event("device", t, { kind, ...data });

  it("describes the machine and how much changed", () => {
    const events = [
      at("profile", 5, { cores: "8", deviceRamMb: "7820", model: "Pixel 8" }),
      at("rotation", 100, { orientation: "landscape" }),
      at("background", 200),
    ];
    expect(laneStat(lane("device"), events, view, false)).toBe("8 cores · 8 GB · 2 changes");
  });

  it("says nothing happened rather than borrowing navigation's wording", () => {
    expect(laneStat(lane("device"), [], view, false)).toBe("no changes");
  });

  it("labels each kind for the chip", () => {
    expect(deviceLabel(at("foreground", 0))).toBe("foreground");
    expect(deviceLabel(at("background", 0))).toBe("background");
    expect(deviceLabel(at("rotation", 0, { orientation: "landscape" }))).toBe("landscape");
    expect(deviceLabel(at("theme", 0, { darkMode: "true" }))).toBe("dark mode");
    expect(deviceLabel(at("network", 0, { transport: "cellular" }))).toBe("cellular");
    expect(deviceLabel(at("network", 0, { transport: "none" }))).toBe("offline");
    expect(deviceLabel(at("trimMemory", 0, { level: "ui hidden" }))).toBe("trim: ui hidden");
    expect(deviceLabel(at("profile", 0, { model: "Pixel 8" }))).toBe("Pixel 8");
  });

  it("leads a power change with the condition, not the battery", () => {
    // Dozing explains a stalled request; the percentage rarely does.
    expect(deviceLabel(at("power", 0, { dozing: "true", batteryPercent: "12" }))).toBe(
      "dozing · 12%",
    );
    expect(deviceLabel(at("power", 0, { dozing: "false", batteryPercent: "88" }))).toBe("88%");
  });
});
