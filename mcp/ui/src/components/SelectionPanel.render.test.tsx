// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom -- see App.render.test.tsx's top comment for
// why happy-dom over jsdom, and why it is opted into per-file rather than as
// the package default.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SelectionPanel } from "./SelectionPanel";
import { LANES } from "../timeline/lanes";
import type { Hit } from "../lib/laneData";
import type { Finding } from "../types";

/**
 * GRA-114 ruling 3: a finding hit arrives in SelectionPanel like any other
 * hit -- title, detail, severity, confidence, source and window all shown,
 * not a placeholder. There was no `finding` hit kind before this ticket, so
 * this is a fresh render test rather than one adapted from an existing file.
 */

const findingsLane = LANES.find((lane) => lane.key === "findings")!;

function findingHit(overrides: Partial<Finding> = {}): Hit {
  const finding: Finding = {
    id: "jank-1",
    severity: "warning",
    confidence: "correlated",
    title: "Main thread was runnable but not scheduled for 180ms",
    detail: "The scheduler had it queued; it did not run.",
    source: "trace",
    window: { from: 1200, to: 1380 },
    ...overrides,
  };
  return { kind: "finding", lane: findingsLane, finding };
}

afterEach(cleanup);

describe("SelectionPanel renders a finding hit (GRA-114 ruling 3)", () => {
  it("shows the title as the heading", () => {
    render(<SelectionPanel hit={findingHit()} />);
    expect(screen.getByText(/Main thread was runnable/)).toBeTruthy();
  });

  it("shows severity, confidence and source in the subtitle", () => {
    render(<SelectionPanel hit={findingHit()} />);
    expect(screen.getByText(/warning · correlated · trace/)).toBeTruthy();
  });

  it("shows the detail sentence", () => {
    render(<SelectionPanel hit={findingHit()} />);
    expect(screen.getByText(/The scheduler had it queued/)).toBeTruthy();
  });

  it("shows the window as a span when from and to differ", () => {
    render(<SelectionPanel hit={findingHit({ window: { from: 1200, to: 1380 } })} />);
    expect(screen.getByText("1200–1380ms")).toBeTruthy();
  });

  it("shows the window as a single instant when from equals to", () => {
    render(<SelectionPanel hit={findingHit({ window: { from: 500, to: 500 } })} />);
    expect(screen.getByText("500ms")).toBeTruthy();
  });

  it("names a spanning finding's window as the whole window asked about, not a point", () => {
    render(<SelectionPanel hit={findingHit({ window: undefined, spanning: true })} />);
    expect(screen.getByText("the whole window asked about")).toBeTruthy();
  });

  it("does not render a finding with neither window nor spanning as some fabricated point (defensive)", () => {
    // The wire boundary again (see lib/findings.ts's own comment): GRA-113
    // AC1 says this cannot happen, but this component does not get to
    // assume the server upheld it.
    render(<SelectionPanel hit={findingHit({ window: undefined, spanning: undefined })} />);
    expect(screen.getByText("unplaced")).toBeTruthy();
  });
});

/** GRA-201: `where` -- resolved from the finding's own evidence, server-side
 *  -- shows up as its own row, resolved or not. There was no `where` field
 *  before this ticket, so this is a fresh block rather than an adapted one,
 *  following GRA-167's own pattern of adding a describe per new field. */
describe("SelectionPanel renders a finding's where (GRA-201)", () => {
  it("shows nothing extra when where is absent -- the off switch, or an older server", () => {
    render(<SelectionPanel hit={findingHit({ where: undefined })} />);
    expect(screen.queryByText("where")).toBeNull();
  });

  it("shows a resolved location as path:line", () => {
    render(
      <SelectionPanel
        hit={findingHit({
          where: { resolved: true, path: "app/src/main/kotlin/CartViewModel.kt", line: 148 },
        })}
      />,
    );
    expect(screen.getByText("where")).toBeTruthy();
    expect(screen.getByText("app/src/main/kotlin/CartViewModel.kt:148")).toBeTruthy();
  });

  it("shows a resolved location with no line as the bare path", () => {
    render(
      <SelectionPanel
        hit={findingHit({ where: { resolved: true, path: "core/network/src/ApiClient.kt" } })}
      />,
    );
    expect(screen.getByText("core/network/src/ApiClient.kt")).toBeTruthy();
  });

  it("shows the reason, not a fabricated path, when resolution failed", () => {
    render(<SelectionPanel hit={findingHit({ where: { resolved: false, reason: "ambiguous" } })} />);
    expect(screen.getByText("where")).toBeTruthy();
    expect(screen.getByText("ambiguous")).toBeTruthy();
  });

  it("copies the resolved path to the clipboard on click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // happy-dom exposes navigator.clipboard as getter-only; a plain
    // Object.assign throws instead of overriding it.
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(
      <SelectionPanel
        hit={findingHit({
          where: { resolved: true, path: "app/src/main/kotlin/CartViewModel.kt", line: 148 },
        })}
      />,
    );
    fireEvent.click(screen.getByText("app/src/main/kotlin/CartViewModel.kt:148"));
    expect(writeText).toHaveBeenCalledWith("app/src/main/kotlin/CartViewModel.kt:148");
    expect(await screen.findByText("copied")).toBeTruthy();
  });
});
