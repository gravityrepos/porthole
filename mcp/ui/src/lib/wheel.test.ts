// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { interpretWheel, LINE_PX, MAX_ZOOM_FACTOR, PAGE_PX, ZOOM_PER_PX, type WheelInput } from "./wheel";

const base: WheelInput = { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false };
const wheel = (over: Partial<WheelInput>): WheelInput => ({ ...base, ...over });

describe("interpretWheel", () => {
  it("a plain vertical wheel is the lane list's scroll, not a zoom", () => {
    expect(interpretWheel(wheel({ deltaY: 100 }))).toEqual({ kind: "scroll" });
    expect(interpretWheel(wheel({ deltaY: -100 }))).toEqual({ kind: "scroll" });
  });

  it("an event with no delta at all does nothing, whatever the modifiers", () => {
    expect(interpretWheel(wheel({}))).toEqual({ kind: "scroll" });
    expect(interpretWheel(wheel({ ctrlKey: true }))).toEqual({ kind: "scroll" });
    expect(interpretWheel(wheel({ shiftKey: true }))).toEqual({ kind: "scroll" });
  });

  it("ctrl + wheel zooms: positive delta out (factor above 1), negative in", () => {
    const out = interpretWheel(wheel({ deltaY: 100, ctrlKey: true }));
    const into = interpretWheel(wheel({ deltaY: -100, ctrlKey: true }));
    expect(out).toEqual({ kind: "zoom", factor: Math.exp(100 * ZOOM_PER_PX) });
    expect(into).toEqual({ kind: "zoom", factor: Math.exp(-100 * ZOOM_PER_PX) });
    expect(out.kind === "zoom" && out.factor).toBeGreaterThan(1);
    expect(into.kind === "zoom" && into.factor).toBeLessThan(1);
  });

  it("cmd + wheel is the same gesture as ctrl + wheel", () => {
    expect(interpretWheel(wheel({ deltaY: 100, metaKey: true }))).toEqual(
      interpretWheel(wheel({ deltaY: 100, ctrlKey: true })),
    );
  });

  it("the zoom factor scales with the delta's magnitude, not just its sign", () => {
    const small = interpretWheel(wheel({ deltaY: 10, ctrlKey: true }));
    const large = interpretWheel(wheel({ deltaY: 100, ctrlKey: true }));
    if (small.kind !== "zoom" || large.kind !== "zoom") throw new Error("expected zoom");
    expect(large.factor).toBeGreaterThan(small.factor);
    expect(small.factor).toBeGreaterThan(1);
  });

  it("one event never zooms by more than MAX_ZOOM_FACTOR, in either direction", () => {
    expect(interpretWheel(wheel({ deltaY: 100_000, ctrlKey: true }))).toEqual({ kind: "zoom", factor: MAX_ZOOM_FACTOR });
    expect(interpretWheel(wheel({ deltaY: -100_000, ctrlKey: true }))).toEqual({
      kind: "zoom",
      factor: 1 / MAX_ZOOM_FACTOR,
    });
  });

  it("ctrl + a purely horizontal wheel still zooms, reading deltaX", () => {
    expect(interpretWheel(wheel({ deltaX: 50, ctrlKey: true }))).toEqual({ kind: "zoom", factor: Math.exp(50 * ZOOM_PER_PX) });
  });

  it("shift + wheel pans by the vertical delta, sign preserved", () => {
    expect(interpretWheel(wheel({ deltaY: 40, shiftKey: true }))).toEqual({ kind: "pan", deltaPx: 40 });
    expect(interpretWheel(wheel({ deltaY: -40, shiftKey: true }))).toEqual({ kind: "pan", deltaPx: -40 });
  });

  it("a wheel whose horizontal delta dominates pans by deltaX, sign preserved", () => {
    expect(interpretWheel(wheel({ deltaX: 30, deltaY: 5 }))).toEqual({ kind: "pan", deltaPx: 30 });
    expect(interpretWheel(wheel({ deltaX: -30, deltaY: 5 }))).toEqual({ kind: "pan", deltaPx: -30 });
  });

  it("a sideways swipe with no vertical component at all pans, never zooms in", () => {
    // The old code read deltaY === 0 as "zoom in". This is the regression.
    expect(interpretWheel(wheel({ deltaX: 12 }))).toEqual({ kind: "pan", deltaPx: 12 });
  });

  it("a diagonal tie goes to the vertical scroll", () => {
    expect(interpretWheel(wheel({ deltaX: 20, deltaY: 20 }))).toEqual({ kind: "scroll" });
    expect(interpretWheel(wheel({ deltaX: 20, deltaY: -20 }))).toEqual({ kind: "scroll" });
  });

  it("line and page deltaModes are converted to pixels before anything is judged", () => {
    expect(interpretWheel(wheel({ deltaY: 1, deltaMode: 1, ctrlKey: true }))).toEqual({
      kind: "zoom",
      factor: Math.exp(LINE_PX * ZOOM_PER_PX),
    });
    expect(interpretWheel(wheel({ deltaX: 1, deltaMode: 2 }))).toEqual({ kind: "pan", deltaPx: PAGE_PX });
    // Lines: 3 lines sideways against 1 line down is still a pan, after scaling.
    expect(interpretWheel(wheel({ deltaX: 3, deltaY: 1, deltaMode: 1 }))).toEqual({ kind: "pan", deltaPx: 3 * LINE_PX });
  });
});
