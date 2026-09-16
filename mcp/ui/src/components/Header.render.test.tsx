// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom -- see App.render.test.tsx's top comment for
// why happy-dom over jsdom, and why it is opted into per-file rather than as
// the package default.
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Header } from "./Header";
import type { ConnectionState } from "../types";

/**
 * GRA-167: the layer beneath Header.test.tsx's `connectionDisplay` tests.
 *
 * `connectionDisplay` is a pure function and Header.test.tsx already proves
 * it decides the right tone/label/pulse for every ConnectionState. What it
 * cannot prove -- the reason this file exists -- is that Header's JSX still
 * *uses* that decision: whether the pill's colour and text on screen
 * actually come from `connectionDisplay`'s return value, or whether that
 * call and the markup reading it have drifted apart. GRA-161's whole point
 * was what a user *sees* during the two-second handshake window, and an
 * element's props (GRA-96's technique, applied to App's banner) are a
 * weaker proxy for "what does this look like" than for "did this render at
 * all" -- a banner is either present or absent, but a pill is always
 * present and the thing at stake is its colour and wording. So this one
 * renders Header for real rather than inspecting a returned element.
 */
function headerProps(
  connection: ConnectionState,
  eventsPerSecond = 0,
  overrides: Partial<ComponentProps<typeof Header>> = {},
): ComponentProps<typeof Header> {
  return {
    connection,
    hello: null,
    eventsPerSecond,
    following: false,
    showFramework: false,
    onToggleFollowing: vi.fn(),
    onToggleFramework: vi.fn(),
    onFit: vi.fn(),
    onClear: vi.fn(),
    onAsk: vi.fn(),
    onOpenDatabase: vi.fn(),
    onRestart: vi.fn(),
    restartLabel: "restart app",
    askLabel: "ask agent",
    lookbackSeconds: 30,
    onLookbackSecondsChange: vi.fn(),
    onSave: vi.fn(),
    saveLabel: "keep",
    savePath: null,
    saveError: null,
    ...overrides,
  };
}

function renderHeader(
  connection: ConnectionState,
  eventsPerSecond = 0,
  overrides: Partial<ComponentProps<typeof Header>> = {},
) {
  return render(<Header {...headerProps(connection, eventsPerSecond, overrides)} />);
}

afterEach(cleanup);

describe("Header's connection pill (GRA-167 AC3, closing GRA-161)", () => {
  it("handshaking gets its own pill, not the connected accent or the disconnected danger tone (GRA-161 AC2)", () => {
    renderHeader("handshaking");
    const label = screen.getByText(/waiting on app/i);
    expect(label.style.color).toBe("var(--color-muted)");
    expect(label.style.color).not.toBe("var(--danger)");
    expect(label.style.color).not.toBe("var(--accent)");
    // The literal word "disconnected" must not appear anywhere in the pill --
    // this is the failure GRA-161 fixed: handshaking used to fall through to
    // exactly that label.
    expect(screen.queryByText(/disconnected/i)).toBeNull();
  });

  it("an unrecognised future connection state does not render as the alarming disconnected pill (GRA-161 AC4 / GRA-162, GRA-167 AC4)", () => {
    // Cast past the type on purpose -- proving behaviour for a value this
    // build's ConnectionState union does not list, which is exactly the
    // gap: a server a build ahead of this bundle can send a state name this
    // code has never heard of, and GRA-167's job is proving that renders as
    // "unproven", not as a red disconnected pill.
    const future = "reconnecting" as ConnectionState;
    renderHeader(future);
    const label = screen.getByText(/reconnecting/i);
    expect(label.style.color).toBe("var(--color-muted)");
    expect(label.style.color).not.toBe("var(--danger)");
    expect(screen.queryByText(/^disconnected$/i)).toBeNull();
  });

  it("connected still gets the accent tone and the live rate (control case: a working pill is not accidentally muted)", () => {
    renderHeader("connected", 42);
    const label = screen.getByText(/live · 42 evt\/s/);
    expect(label.style.color).toBe("var(--accent)");
  });

  it("disconnected still gets the danger tone (control case: the danger tone still exists for the state that should have it)", () => {
    renderHeader("disconnected");
    const label = screen.getByText(/^disconnected$/i);
    expect(label.style.color).toBe("var(--danger)");
  });
});

/**
 * GRA-116: the "keep" control, the result-path display and the error state.
 *
 * The window/lookback maths itself is `lib/save.ts`'s job (see save.test.ts)
 * -- this only proves Header's own JSX: the control is present and wired to
 * `onSave`/`onLookbackSecondsChange`, the N-input's relevance to `following`,
 * and that a `savePath`/`saveError` prop actually renders what ruling 1
 * promises (a selectable path, the fixed GRA-57 note, one error line) rather
 * than silently not being read.
 */
describe("Header's keep control (GRA-116)", () => {
  afterEach(cleanup);

  it("shows a keep control that calls onSave when clicked", () => {
    const onSave = vi.fn();
    renderHeader("connected", 0, { onSave });
    fireEvent.click(screen.getByText("keep"));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("shows the lookback input while following, defaulting to the given value, and reports whole-second changes", () => {
    const onLookbackSecondsChange = vi.fn();
    renderHeader("connected", 0, { following: true, lookbackSeconds: 30, onLookbackSecondsChange });
    const input = screen.getByLabelText("seconds to keep") as HTMLInputElement;
    expect(input.value).toBe("30");
    fireEvent.change(input, { target: { value: "45" } });
    expect(onLookbackSecondsChange).toHaveBeenCalledWith(45);
  });

  it("hides the lookback input when not following -- the ruler already decides the window, nothing to configure", () => {
    renderHeader("connected", 0, { following: false });
    expect(screen.queryByLabelText("seconds to keep")).toBeNull();
  });

  it("ignores a non-numeric or non-positive lookback edit rather than forwarding garbage to onLookbackSecondsChange", () => {
    const onLookbackSecondsChange = vi.fn();
    renderHeader("connected", 0, { following: true, onLookbackSecondsChange });
    const input = screen.getByLabelText("seconds to keep");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.change(input, { target: { value: "-5" } });
    fireEvent.change(input, { target: { value: "0" } });
    expect(onLookbackSecondsChange).not.toHaveBeenCalled();
  });

  it("renders no result row and no alert before any save has happened", () => {
    renderHeader("connected");
    // The whole row, not just the elements inside it -- an empty wrapper
    // rendering unconditionally would pass the two checks below without
    // actually gating anything, which is exactly what this line is here to
    // catch (measured: mutating the row's own condition to `true` left both
    // inner checks green).
    expect(screen.queryByTestId("save-result")).toBeNull();
    expect(screen.queryByLabelText("saved trace path")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the written path, selectable, plus the GRA-57 note, when savePath is set", () => {
    renderHeader("connected", 0, { savePath: "/project/.porthole/traces/moment-1-2.json" });
    const pathField = screen.getByLabelText("saved trace path") as HTMLInputElement;
    expect(pathField.value).toBe("/project/.porthole/traces/moment-1-2.json");
    expect(pathField.readOnly).toBe(true);
    // Ruling 1's exact sentence -- GRA-57 is not in 0.2.0, so every save
    // through this control is the Porthole half only.
    expect(screen.getByText("Porthole half only; no system trace was attached.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows exactly the given error, as an alert, and no path row, when saveError is set", () => {
    renderHeader("connected", 0, { saveError: "Nothing buffered yet to save." });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Nothing buffered yet to save.");
    expect(screen.queryByLabelText("saved trace path")).toBeNull();
  });
});

/**
 * GRA-192: `device.ts` retries the device socket on a backoff from
 * `RECONNECT_MIN_MS` (500ms) to `RECONNECT_MAX_MS` (5s), and every attempt
 * moves the broadcast connection state disconnected -> connecting ->
 * disconnected. Before this ticket that made Header's pill flip between the
 * red "disconnected" pill and the muted "connecting" one at the retry
 * cadence, for as long as no app was running. `useSettledConnection`
 * (lib/settledConnection.ts) is the fix; this file proves it through the
 * real `Header`, with fake timers standing in for the passage of time
 * `device.ts` would otherwise take, the way GRA-173's own render test
 * proved its fix by counting states rather than eyeballing a description.
 */
describe("Header's connection pill across a reconnect retry loop (GRA-192)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  /** `device.ts`'s own backoff sequence (`RECONNECT_MIN_MS` doubling up to
   *  `RECONNECT_MAX_MS`). Each entry is the gap before the *next* retry
   *  fires -- not how long any one "connecting" attempt itself lasts, which
   *  is what makes this loop never cross `CONNECTING_REVEAL_MS` on its own. */
  const BACKOFF_CADENCE_MS = [500, 1000, 2000, 5000];

  function pillPartsFor(text: RegExp) {
    const label = screen.getByText(text);
    const pill = label.parentElement!;
    return { label, pill, dot: pill.firstElementChild as HTMLElement };
  }

  it("does not remount the pill or restart its animation across the loop (ruling 2)", () => {
    const { rerender } = renderHeader("disconnected");
    const before = pillPartsFor(/^disconnected$/i);
    const dotClassBefore = before.dot.className;

    for (const gap of BACKOFF_CADENCE_MS) {
      act(() => {
        vi.advanceTimersByTime(gap);
      });
      rerender(<Header {...headerProps("connecting")} />);
      // Steady throughout -- if this ever reads "connecting" mid-loop, the
      // settling failed and the flicker this ticket exists to remove is back.
      expect(screen.getByText(/^disconnected$/i)).toBe(before.label);
      rerender(<Header {...headerProps("disconnected")} />);
    }

    const after = pillPartsFor(/^disconnected$/i);
    // Same DOM nodes, not new ones that merely look the same -- proves
    // nothing above the dot was keyed or conditionally remounted.
    expect(after.label).toBe(before.label);
    expect(after.dot).toBe(before.dot);
    expect(after.dot.className).toBe(dotClassBefore);
    // Only "connected" pulses (Header.tsx's own ConnectionDisplay comment);
    // this loop never reaches it.
    expect(after.dot.className).not.toContain("ph-pulse");
  });

  it("collapses the whole retry loop into one settled rendering -- no DOM mutation while it stays within backoff (ruling 3 / AC1)", () => {
    const { rerender } = renderHeader("disconnected");
    const { pill } = pillPartsFor(/^disconnected$/i);

    const observer = new MutationObserver(() => {});
    observer.observe(pill, { attributes: true, childList: true, subtree: true, characterData: true });

    for (const gap of BACKOFF_CADENCE_MS) {
      act(() => {
        vi.advanceTimersByTime(gap);
      });
      rerender(<Header {...headerProps("connecting")} />);
      rerender(<Header {...headerProps("disconnected")} />);
    }

    // takeRecords() drains the queue synchronously -- it does not depend on
    // the observer's own callback microtask having fired yet, which matters
    // under fake timers.
    const mutations = observer.takeRecords();
    observer.disconnect();
    expect(mutations).toHaveLength(0);
  });

  it("reveals once a connecting excursion outlives the max backoff (AC3: 5.5s)", async () => {
    const { rerender } = renderHeader("disconnected");
    pillPartsFor(/^disconnected$/i); // establishes the pill exists before the excursion

    rerender(<Header {...headerProps("connecting")} />);
    await act(async () => {
      // Async, not the sync `advanceTimersByTime` the other tests in this
      // file use: the reveal is driven by useSettledConnection's own
      // internal setTimeout (not a prop change), so nothing re-renders
      // Header until that timer's callback runs and calls setState --
      // advanceTimersByTimeAsync is what actually lets that callback fire
      // and its resulting commit flush before this line resumes, the same
      // pattern App.findings.render.test.tsx already relies on.
      await vi.advanceTimersByTimeAsync(5_500);
    });

    expect(screen.getByText(/^connecting$/i)).toBeTruthy();
    expect(screen.queryByText(/^disconnected$/i)).toBeNull();
  });

  it("still replaces the pill immediately for handshaking and connected -- GRA-161 stays green through the settled layer (AC2)", () => {
    const { rerender } = renderHeader("disconnected");
    rerender(<Header {...headerProps("handshaking")} />);
    expect(screen.getByText(/waiting on app/i)).toBeTruthy();

    rerender(<Header {...headerProps("connected", 7)} />);
    expect(screen.getByText(/live · 7 evt\/s/)).toBeTruthy();
  });
});
