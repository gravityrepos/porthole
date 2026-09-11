// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { bounds, centreOn, fitView, followNewest, panBy, toTime, toX, zoomAt } from "./geometry";
import { MIN_SPAN_MS } from "./lanes";
import type { DeviceEvent, ViewWindow } from "../types";

const view: ViewWindow = { start: 1000, end: 2000 };

function at(t: number): DeviceEvent {
  return { event: "log", t, seq: t, data: {} };
}

describe("toX and toTime", () => {
  it("maps the window onto the plot width", () => {
    expect(toX(1000, view, 400)).toBe(0);
    expect(toX(1500, view, 400)).toBe(200);
    expect(toX(2000, view, 400)).toBe(400);
  });

  it("round-trips a time through a pixel", () => {
    for (const t of [1000, 1234, 1999]) {
      expect(toTime(toX(t, view, 800), view, 800)).toBeCloseTo(t, 6);
    }
  });

  it("keeps mapping outside the window, so off-screen marks can be culled", () => {
    expect(toX(500, view, 400)).toBe(-200);
    expect(toX(2500, view, 400)).toBe(600);
  });
});

describe("bounds", () => {
  it("gives a usable window for an empty stream", () => {
    expect(bounds([])).toEqual({ min: 0, max: 1000 });
  });

  it("widens a single event to a minimum span rather than a zero-width one", () => {
    expect(bounds([at(500)])).toEqual({ min: 500, max: 500 + MIN_SPAN_MS });
  });
});

describe("fitView", () => {
  it("pads both ends so the first and last marks are not on the edge", () => {
    const fitted = fitView([at(0), at(10_000)]);
    expect(fitted.start).toBeLessThan(0);
    expect(fitted.end).toBeGreaterThan(10_000);
  });

  it("pads by at least 20ms when the span is tiny", () => {
    const fitted = fitView([at(1000), at(1001)]);
    expect(fitted.start).toBeLessThanOrEqual(980);
  });
});

describe("zoomAt", () => {
  it("holds the anchor still while the span changes", () => {
    const zoomed = zoomAt(view, 1500, 0.5);
    expect(zoomed.end - zoomed.start).toBe(500);
    // The anchor was halfway across, so it stays halfway across.
    expect((1500 - zoomed.start) / (zoomed.end - zoomed.start)).toBeCloseTo(0.5, 6);
  });

  it("holds an off-centre anchor still too", () => {
    const zoomed = zoomAt(view, 1250, 0.5);
    expect((1250 - zoomed.start) / (zoomed.end - zoomed.start)).toBeCloseTo(0.25, 6);
  });

  it("refuses to zoom past the minimum span", () => {
    let zoomed = view;
    for (let i = 0; i < 50; i++) zoomed = zoomAt(zoomed, 1500, 0.5);
    expect(zoomed.end - zoomed.start).toBe(MIN_SPAN_MS);
  });
});

describe("panBy", () => {
  it("moves both edges and leaves the span alone", () => {
    const panned = panBy(view, 250);
    expect(panned).toEqual({ start: 1250, end: 2250 });
  });
});

describe("centreOn", () => {
  it("puts the time in the middle without changing zoom", () => {
    const centred = centreOn(view, 5000);
    expect(centred.end - centred.start).toBe(1000);
    expect((centred.start + centred.end) / 2).toBe(5000);
  });
});

describe("followNewest", () => {
  it("pins the newest event near the right edge at the same zoom", () => {
    const followed = followNewest(view, [at(0), at(9000)]);
    expect(followed.end - followed.start).toBe(1000);
    expect(followed.end).toBeGreaterThan(9000);
    // Close to the edge, but not on it: new events need somewhere to land.
    expect(toX(9000, followed, 100)).toBeGreaterThan(85);
    expect(toX(9000, followed, 100)).toBeLessThan(100);
  });

  it("leaves the view alone when there is nothing to follow", () => {
    expect(followNewest(view, [])).toBe(view);
  });
});
