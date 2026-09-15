// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
//
// GRA-167 AC1: happy-dom over jsdom. Nothing here needs jsdom's closer
// fidelity to a real browser (no CSS layout, no getComputedStyle resolution
// of custom properties -- the assertions below read `.style.color` for the
// literal `var(--foo)` string App/Header set, not a resolved colour) and
// happy-dom is the lighter, faster option, which matters because this
// environment is opted into per-file with a magic comment rather than set
// as the package's default: `App.test.tsx` and `Header.test.tsx`'s existing
// pure-function tests deliberately keep running under vitest's default node
// environment (see their own comments), so only the two files that actually
// render pay happy-dom's cost. See this ticket's report for the measured
// runtime.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App } from "./App";
import type { Hello } from "./types";

/**
 * GRA-167: the layer beneath App.test.tsx's pure-function tests.
 *
 * GRA-96's `protocolBanner(hello)` made the render *decision* testable
 * without a DOM (App.test.tsx asserts `.type`/`.props` on the element it
 * returns), but its own comment names the residue that leaves: nothing
 * proves App()'s JSX still calls that function with the right argument, or
 * that React actually mounts what it returns. GRA-167 measured that residue
 * directly -- deleting the `{protocolBanner(store.hello)}` call from
 * App.tsx's JSX left the pure-function suite fully green, because nothing in
 * it renders App. This file is the test that call site needed: it renders
 * `<App />` for real and checks the banner is actually in the tree.
 *
 * Everything App composes other than the banner and Header is stubbed out:
 * TimelinePanel, LogPane, SelectionPanel, WindowPanel and InsightsPanel are
 * all replaced with `() => null` above. TimelinePanel owns a real `<canvas>`
 * 2D context and a `ResizeObserver`, neither of which happy-dom implements;
 * the other four are stubbed for the same reason it would be pointless not
 * to once one of them is.
 *
 * State the boundary plainly, since it is easy to misread this file as
 * covering App's whole tree: stubbing these five means **this file asserts
 * nothing about whether any of them actually renders inside App, or about
 * their own internals**. That each has its own logic tests elsewhere
 * (laneData, InsightsPanel.test.tsx, TimelineStore.test.ts) covers what
 * those files individually compute, not whether App's JSX still mounts
 * them -- measured, not assumed: deleting the `<InsightsPanel .../>` element
 * from App's JSX leaves this suite at 133 green and `tsc` clean, the same
 * shape of gap GRA-167 exists to close for the banner and the pill. Closing
 * it for every panel App composes was out of this ticket's scope (GRA-167's
 * AC2/AC3 name the banner and the pill specifically); if a panel silently
 * stops rendering, nothing here will catch it. Header is the one exception,
 * left real because it is cheap to render and Header.render.test.tsx
 * exercises its own pill separately -- so this file does incidentally prove
 * Header mounts inside App without throwing, which the five stubbed panels
 * get no equivalent of.
 */
vi.mock("./components/TimelinePanel", () => ({ TimelinePanel: () => null }));
vi.mock("./components/LogPane", () => ({ LogPane: () => null }));
vi.mock("./components/SelectionPanel", () => ({ SelectionPanel: () => null }));
vi.mock("./components/WindowPanel", () => ({ WindowPanel: () => null }));
vi.mock("./components/InsightsPanel", () => ({ InsightsPanel: () => null }));

// useSetup's effect fires a real fetch() once `isAttached(connection)` is
// true; stubbed so this file never depends on a fetch mock existing.
vi.mock("./lib/setup", () => ({ useSetup: () => [] }));

// useDeviceStream's effect opens a real WebSocket to `location.host`, which
// happy-dom does not implement -- mocked out entirely so App never reaches
// it, and so this file can drive `store.hello` directly per test.
const mockStore = {
  events: [] as unknown[],
  hello: null as Hello | null,
  connection: "connected" as const,
  clear: vi.fn(),
};
vi.mock("./store/useDeviceStream", () => ({
  useDeviceStream: () => ({ store: mockStore, version: 0 }),
}));

function hello(overrides: Partial<Hello> = {}): Hello {
  return {
    protocol: 1,
    packageName: "com.example.shop",
    processName: "com.example.shop",
    versionName: "1.0.0",
    device: "Pixel 10 Pro XL",
    sdkInt: 37,
    startedAt: 0,
    collectors: [],
    ...overrides,
  };
}

// GRA-114: App now also owns the findings fetch (`FindingsLoader`) and polls
// `/api/traces` directly (`useTraces`) -- neither is under test in this
// file, which only cares about the protocol banner, but both would
// otherwise fire real fetches happy-dom tries to actually connect on. A
// blanket empty-JSON stub, reapplied every test, keeps this file's tests
// exactly as offline as they were before those two effects existed.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ findings: [], traces: [] }), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  mockStore.hello = null;
  vi.unstubAllGlobals();
});

describe("App renders the protocol-mismatch banner (GRA-167 AC2)", () => {
  it("renders no alert before hello has landed", () => {
    mockStore.hello = null;
    render(<App />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders no alert when the app's protocol matches this build's", () => {
    mockStore.hello = hello({ protocol: 1 });
    render(<App />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the banner naming both protocol versions when they disagree", () => {
    mockStore.hello = hello({ protocol: 2 });
    render(<App />);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toMatch(/protocol 2/);
    expect(banner.textContent).toMatch(/protocol 1/);
  });
});
