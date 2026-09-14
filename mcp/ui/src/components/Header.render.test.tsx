// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom -- see App.render.test.tsx's top comment for
// why happy-dom over jsdom, and why it is opted into per-file rather than as
// the package default.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
function renderHeader(connection: ConnectionState, eventsPerSecond = 0) {
  render(
    <Header
      connection={connection}
      hello={null}
      eventsPerSecond={eventsPerSecond}
      following={false}
      showFramework={false}
      onToggleFollowing={vi.fn()}
      onToggleFramework={vi.fn()}
      onFit={vi.fn()}
      onClear={vi.fn()}
      onAsk={vi.fn()}
      onOpenDatabase={vi.fn()}
      onRestart={vi.fn()}
      restartLabel="restart app"
      askLabel="ask agent"
    />,
  );
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
