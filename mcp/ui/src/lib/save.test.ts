// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { DEFAULT_LOOKBACK_SECONDS, saveRequestBody, saveWindow } from "./save";

/**
 * `save.ts` is DOM-free on purpose -- see its own module comment on why the
 * window choice is computed independently of `summariseWindow`. These tests
 * exercise the two decisions ruling 1/2 make: which window a "keep" click
 * saves, and the exact body it sends for it.
 */
describe("saveWindow (GRA-116 ruling 1 / open question 1)", () => {
  it("zoomed or panned away: exactly the visible window, rounded to the millisecond", () => {
    const result = saveWindow({
      following: false,
      view: { start: 2057010.4, end: 2075089.6 },
      lookbackSeconds: DEFAULT_LOOKBACK_SECONDS,
      newestEventT: 9_999_999, // deliberately far from the view -- must be ignored while not following
    });
    expect(result).toEqual({ from: 2057010, to: 2075090 });
  });

  it("following: a fixed lookback ending at the newest event, not at the (lead-ahead) view", () => {
    const result = saveWindow({
      following: true,
      // App's own following effect parks `view.end` ahead of the newest
      // event on purpose -- this must not leak into the saved window.
      view: { start: 90_000, end: 110_500 },
      lookbackSeconds: 30,
      newestEventT: 100_000,
    });
    expect(result).toEqual({ from: 70_000, to: 100_000 });
  });

  it("following: the lookback maths uses whole seconds, not the view's own units", () => {
    const result = saveWindow({
      following: true,
      view: { start: 0, end: 1000 },
      lookbackSeconds: 5,
      newestEventT: 12_345,
    });
    expect(result).toEqual({ from: 7_345, to: 12_345 });
  });

  it("following: clamps from at 0 rather than going negative when the lookback outruns the uptime clock", () => {
    const result = saveWindow({
      following: true,
      view: { start: 0, end: 1000 },
      lookbackSeconds: 30,
      newestEventT: 5_000,
    });
    expect(result).toEqual({ from: 0, to: 5_000 });
  });

  it("following with nothing buffered yet: null, not a window ending at 0", () => {
    // The vacuous-assertion check: a version that always returned `{from: 0,
    // to: 0}` here would look plausible without ever saying "there is
    // nothing to save yet" -- this pins the null instead.
    const result = saveWindow({
      following: true,
      view: { start: 0, end: 1000 },
      lookbackSeconds: 30,
      newestEventT: null,
    });
    expect(result).toBeNull();
  });

  it("not following: still returns a window even with nothing buffered, since the ruler already has bounds regardless", () => {
    const result = saveWindow({
      following: false,
      view: { start: 100, end: 200 },
      lookbackSeconds: 30,
      newestEventT: null,
    });
    expect(result).toEqual({ from: 100, to: 200 });
  });
});

describe("saveRequestBody (GRA-116 ruling 2)", () => {
  it("carries from/to with no scenario key at all when none was given", () => {
    const body = saveRequestBody({ from: 10, to: 20 });
    expect(body).toEqual({ from: 10, to: 20 });
    expect("scenario" in body).toBe(false);
  });

  it("carries from/to with no scenario key when the given name is empty or all whitespace", () => {
    expect(saveRequestBody({ from: 10, to: 20 }, "")).toEqual({ from: 10, to: 20 });
    expect(saveRequestBody({ from: 10, to: 20 }, "   ")).toEqual({ from: 10, to: 20 });
  });

  it("trims and carries a real scenario name", () => {
    const body = saveRequestBody({ from: 10, to: 20 }, "  checkout stall  ");
    expect(body).toEqual({ from: 10, to: 20, scenario: "checkout stall" });
  });
});
