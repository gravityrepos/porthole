// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { MIN_MARK_PX, placeFindings } from "./findings";
import { MAX_FINDING_ROWS } from "../timeline/lanes";
import type { Finding } from "../types";

/**
 * DOM-free placement maths for the findings lane (GRA-114's own required
 * test): window → x/width for a view, row assignment for overlap, and the
 * overflow count once rows run out. No canvas, no React, no happy-dom — the
 * same discipline `timeline/geometry.ts` and `lib/laneData.ts`'s pure
 * helpers already keep.
 */

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    severity: "warning",
    confidence: "observed",
    title: "test finding",
    source: "porthole",
    window: { from: 100, to: 200 },
    ...overrides,
  };
}

const view = { start: 0, end: 1000 };
/** For most tests the queried window is just the view itself, converted from `{start,end}` to `{from,to}`. */
const queryWindow = { from: view.start, to: view.end };
const width = 1000; // 1px per ms, so assertions read as plain milliseconds.

describe("placeFindings: window placement", () => {
  it("places a window fully inside the view at its exact x/width", () => {
    const { placed } = placeFindings([finding({ window: { from: 100, to: 200 } })], queryWindow, view, width);
    expect(placed).toHaveLength(1);
    expect(placed[0].x).toBe(100);
    expect(placed[0].width).toBe(100);
    expect(placed[0].band).toBe(false);
  });

  it("gives a point finding (from === to) a minimum visible width, never zero", () => {
    const { placed } = placeFindings([finding({ window: { from: 500, to: 500 } })], queryWindow, view, width);
    expect(placed[0].width).toBe(MIN_MARK_PX);
    expect(placed[0].x).toBe(500);
  });

  it("clamps a window that starts before the view to x=0", () => {
    const { placed } = placeFindings([finding({ window: { from: -300, to: 150 } })], queryWindow, view, width);
    expect(placed).toHaveLength(1);
    expect(placed[0].x).toBe(0);
    expect(placed[0].width).toBe(150);
  });

  it("clamps a window that ends after the view to the right edge", () => {
    const { placed } = placeFindings([finding({ window: { from: 900, to: 1400 } })], queryWindow, view, width);
    expect(placed).toHaveLength(1);
    expect(placed[0].x).toBe(900);
    expect(placed[0].width).toBe(100);
  });

  it("drops a window entirely outside the view rather than drawing off-canvas", () => {
    const { placed, overflow } = placeFindings(
      [finding({ window: { from: 2000, to: 2100 } })],
      queryWindow,
      view,
      width,
    );
    expect(placed).toHaveLength(0);
    expect(overflow).toBe(0); // not overflow -- it was never a candidate for a row.
  });

  it("returns nothing for a non-positive width without throwing", () => {
    expect(placeFindings([finding()], queryWindow, view, 0)).toEqual({ placed: [], overflow: 0 });
    expect(placeFindings([finding()], queryWindow, view, -5)).toEqual({ placed: [], overflow: 0 });
  });
});

describe("placeFindings: spanning findings", () => {
  it("places a spanning finding as a band across the queried window, not a point", () => {
    const queryWindow = { from: 200, to: 800 };
    const { placed } = placeFindings([finding({ window: undefined, spanning: true })], queryWindow, view, width);
    expect(placed).toHaveLength(1);
    expect(placed[0].band).toBe(true);
    expect(placed[0].x).toBe(200);
    expect(placed[0].width).toBe(600);
  });

  it("clamps a spanning band's queried window the same way a point window clamps", () => {
    const queryWindow = { from: -200, to: 1500 };
    const { placed } = placeFindings([finding({ window: undefined, spanning: true })], queryWindow, view, width);
    expect(placed[0].x).toBe(0);
    expect(placed[0].width).toBe(1000);
  });
});

describe("placeFindings: a finding with neither window nor spanning (defensive)", () => {
  it("is silently skipped, not thrown, and does not count toward overflow", () => {
    const broken = finding({ window: undefined, spanning: undefined });
    const good = finding({ id: "f2", window: { from: 10, to: 20 } });
    expect(() => placeFindings([broken, good], queryWindow, view, width)).not.toThrow();
    const { placed, overflow } = placeFindings([broken, good], queryWindow, view, width);
    expect(placed.map((p) => p.finding.id)).toEqual(["f2"]);
    expect(overflow).toBe(0);
  });
});

describe("placeFindings: row assignment and overflow (ruling 1)", () => {
  it("stacks two overlapping findings into separate rows", () => {
    const a = finding({ id: "a", window: { from: 0, to: 100 } });
    const b = finding({ id: "b", window: { from: 20, to: 80 } }); // fully inside a's span
    const { placed } = placeFindings([a, b], queryWindow, view, width);
    expect(placed).toHaveLength(2);
    const rows = new Set(placed.map((p) => p.row));
    expect(rows.size).toBe(2);
  });

  it("reuses a row once the finding in it has ended", () => {
    const a = finding({ id: "a", window: { from: 0, to: 50 } });
    const b = finding({ id: "b", window: { from: 60, to: 100 } }); // starts after a ends
    const { placed } = placeFindings([a, b], queryWindow, view, width);
    expect(placed.find((p) => p.finding.id === "a")?.row).toBe(0);
    expect(placed.find((p) => p.finding.id === "b")?.row).toBe(0);
  });

  it(`stacks up to ${MAX_FINDING_ROWS} overlapping findings before overflowing`, () => {
    const findings = Array.from({ length: MAX_FINDING_ROWS }, (_, i) =>
      finding({ id: `row-${i}`, window: { from: 0, to: 100 } }),
    );
    const { placed, overflow } = placeFindings(findings, queryWindow, view, width);
    expect(placed).toHaveLength(MAX_FINDING_ROWS);
    expect(new Set(placed.map((p) => p.row)).size).toBe(MAX_FINDING_ROWS);
    expect(overflow).toBe(0);
  });

  it(`counts a finding past the ${MAX_FINDING_ROWS}th overlapping one as overflow, not a fourth row`, () => {
    const findings = Array.from({ length: MAX_FINDING_ROWS + 2 }, (_, i) =>
      finding({ id: `row-${i}`, window: { from: 0, to: 100 } }),
    );
    const { placed, overflow } = placeFindings(findings, queryWindow, view, width);
    expect(placed).toHaveLength(MAX_FINDING_ROWS);
    expect(overflow).toBe(2);
  });
});
