// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom -- see App.render.test.tsx's top comment for
// why happy-dom over jsdom, and why it is opted into per-file rather than as
// the package default.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { FindingsLaneStatus } from "./FindingsLaneStatus";

/**
 * GRA-114 ruling 1 and the ticket's own test requirement: the findings lane
 * owns three states -- loading (nothing has ever landed), stale (a previous
 * answer on screen while a newer request is in flight) and empty (an answer
 * landed and named nothing) -- and they must read as different sentences,
 * not merely differ in some internal flag nothing on screen shows. This
 * renders the lane's own status text directly (see the component's own
 * comment for why it is a separate, canvas-free component) and asserts all
 * three produce distinct `data-findings-state` markers and distinct visible
 * text -- "empty" in particular must not read as "loading", which is the
 * exact confusion GRA-173 found in the old InsightsPanel.
 */

afterEach(cleanup);

describe("FindingsLaneStatus's three states (GRA-114 ruling 1)", () => {
  it("loading: nothing has ever landed", () => {
    const { container } = render(<FindingsLaneStatus state="loading" count={0} traceLoaded={true} />);
    const marker = container.querySelector("[data-findings-state]");
    expect(marker?.getAttribute("data-findings-state")).toBe("loading");
    expect(marker?.textContent).toMatch(/reading/i);
  });

  it("stale: a previous answer is shown while a newer request is in flight", () => {
    const { container } = render(<FindingsLaneStatus state="stale" count={3} traceLoaded={true} />);
    const marker = container.querySelector("[data-findings-state]");
    expect(marker?.getAttribute("data-findings-state")).toBe("stale");
    expect(marker?.textContent).toMatch(/refreshing/i);
  });

  it("empty: an answer landed and named nothing -- and does not read as loading", () => {
    const { container } = render(<FindingsLaneStatus state="empty" count={0} traceLoaded={true} />);
    const marker = container.querySelector("[data-findings-state]");
    expect(marker?.getAttribute("data-findings-state")).toBe("empty");
    expect(marker?.textContent).toMatch(/no findings/i);
    expect(marker?.textContent).not.toMatch(/reading/i);
  });

  it("the three states produce three different markers, not the same text three ways", () => {
    const loading = render(<FindingsLaneStatus state="loading" count={0} traceLoaded={true} />);
    const loadingText = loading.container.querySelector("[data-findings-state]")?.textContent;
    loading.unmount();

    const stale = render(<FindingsLaneStatus state="stale" count={0} traceLoaded={true} />);
    const staleText = stale.container.querySelector("[data-findings-state]")?.textContent;
    stale.unmount();

    const empty = render(<FindingsLaneStatus state="empty" count={0} traceLoaded={true} />);
    const emptyText = empty.container.querySelector("[data-findings-state]")?.textContent;
    empty.unmount();

    expect(new Set([loadingText, staleText, emptyText]).size).toBe(3);
  });

  it("names the trace chooser as the affordance when no trace is loaded (ruling 6)", () => {
    const { container } = render(<FindingsLaneStatus state="ready" count={2} traceLoaded={false} />);
    expect(container.querySelector("[data-findings-trace-missing]")).not.toBeNull();
  });

  it("says nothing about a missing trace once one is loaded", () => {
    const { container } = render(<FindingsLaneStatus state="ready" count={2} traceLoaded={true} />);
    expect(container.querySelector("[data-findings-trace-missing]")).toBeNull();
  });
});
