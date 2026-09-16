// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom -- see App.render.test.tsx's top comment for
// why happy-dom over jsdom, and why it is opted into per-file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TimelinePanel } from "./TimelinePanel";
import { TimelineStore } from "../store/TimelineStore";

/**
 * GRA-194: the real `TimelinePanel`, mounted, with native wheel events
 * dispatched at a lane's plot. The other render tests in this workspace mock
 * `TimelinePanel` away because happy-dom implements neither `ResizeObserver`
 * nor a canvas context; here both are stubbed just far enough for the rows to
 * mount (`LaneRow.render` returns early on a null context, by design), since
 * what is under test is the listener the row attaches, not what it paints.
 *
 * Why native events: React's `onWheel` is registered passive, so a test that
 * went through React's synthetic event would pass `preventDefault` whether or
 * not the browser could honour it. `dispatchEvent` on the element with a
 * cancelable `WheelEvent` is what the browser does, and `defaultPrevented` is
 * the truth about whether the lane list would have scrolled.
 */

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const PLOT_WIDTH = 1000;

function mount() {
  const onViewChange = vi.fn();
  const onFollowingChange = vi.fn();
  const view = { start: 1_000, end: 11_000 };
  render(
    <TimelinePanel
      store={new TimelineStore()}
      version={0}
      view={view}
      onViewChange={onViewChange}
      onFollowingChange={onFollowingChange}
      showFramework={false}
      setup={[]}
      onSelect={() => {}}
      selectedSeq={null}
      findings={[]}
      findingsWindow={null}
      findingsLoading={false}
      hasFindingsPayload={false}
      selectedFindingId={null}
      traceLoaded={false}
      traceCoverage={null}
    />,
  );
  const plot = document.querySelector(".cursor-crosshair");
  if (!(plot instanceof HTMLElement)) throw new Error("no lane plot rendered");
  return { plot, onViewChange, onFollowingChange, view };
}

/**
 * happy-dom's `WheelEvent` extends `UIEvent`, not `MouseEvent`, so it keeps
 * `deltaX`/`deltaY`/`deltaMode` from the init but drops the modifier keys and
 * the pointer position a browser would carry. They are defined on the
 * instance here so the event the listener sees has the same shape a real
 * one does.
 */
function wheel(plot: HTMLElement, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  for (const [key, value] of Object.entries({
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    clientX: init.clientX ?? PLOT_WIDTH / 2,
  })) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  plot.dispatchEvent(event);
  return event;
}

describe("TimelinePanel wheel gestures (GRA-194)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: PLOT_WIDTH,
      bottom: 20,
      width: PLOT_WIDTH,
      height: 20,
      toJSON() {},
    } as DOMRect);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers the wheel listener non-passive, so preventDefault can actually hold the list still", () => {
    const spy = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const { plot } = mount();
    // React registers its own root-level listeners for every event type it
    // knows, wheel included, with plain boolean options; only the row's own
    // registration on the plot element is the one under test.
    const onPlot = spy.mock.calls
      .map((call, i) => ({ call, context: spy.mock.contexts[i] }))
      .filter(({ call, context }) => call[0] === "wheel" && context === plot);
    expect(onPlot).toHaveLength(1);
    expect(onPlot[0].call[2]).toEqual({ passive: false });
  });

  it("ctrl + wheel up zooms in at the cursor and prevents the default", () => {
    const { plot, onViewChange, onFollowingChange, view } = mount();
    const event = wheel(plot, { deltaY: -100, ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(onViewChange).toHaveBeenCalledTimes(1);
    const next = onViewChange.mock.calls[0][0] as { start: number; end: number };
    expect(next.end - next.start).toBeLessThan(view.end - view.start);
    // Anchored at the cursor, which sat at the middle of the plot: the window
    // shrinks around 6000ms, not from one edge.
    expect(next.start).toBeGreaterThan(view.start);
    expect(next.end).toBeLessThan(view.end);
    expect(onFollowingChange).not.toHaveBeenCalled();
  });

  it("a plain vertical wheel is left to the lane list: no view change, default not prevented", () => {
    const { plot, onViewChange, onFollowingChange } = mount();
    const event = wheel(plot, { deltaY: 100 });

    expect(event.defaultPrevented).toBe(false);
    expect(onViewChange).not.toHaveBeenCalled();
    expect(onFollowingChange).not.toHaveBeenCalled();
  });

  it("a sideways swipe pans later in time by its share of the plot, and stops following", () => {
    const { plot, onViewChange, onFollowingChange, view } = mount();
    const event = wheel(plot, { deltaX: 100, deltaY: 0 });

    expect(event.defaultPrevented).toBe(true);
    expect(onFollowingChange).toHaveBeenCalledWith(false);
    expect(onViewChange).toHaveBeenCalledTimes(1);
    const next = onViewChange.mock.calls[0][0] as { start: number; end: number };
    // 100px of a 1000px plot over a 10,000ms window is 1,000ms, span unchanged.
    expect(next.start).toBeCloseTo(view.start + 1_000, 6);
    expect(next.end - next.start).toBeCloseTo(view.end - view.start, 6);
  });

  it("a sideways swipe with no vertical component pans, and never zooms in (the old ternary's bug)", () => {
    const { plot, onViewChange, view } = mount();
    wheel(plot, { deltaX: -40, deltaY: 0 });

    const next = onViewChange.mock.calls[0][0] as { start: number; end: number };
    expect(next.end - next.start).toBeCloseTo(view.end - view.start, 6);
    expect(next.start).toBeLessThan(view.start);
  });
});
