// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { connectionDisplay } from "./Header";
import type { ConnectionState } from "../types";

/**
 * `connectionDisplay` is the part of Header that decides what the pill says,
 * pulled out so it can be tested directly — this workspace has no
 * DOM-rendering test setup (see InsightsPanel.test.tsx's comment for the
 * same reasoning applied to FindingsLoader).
 *
 * GRA-161 AC3: the server-side equivalent of "prove the handshaking render"
 * is `buildRig({ connectDevice: false, handlers: { hello: () => new
 * Promise(() => {}) } })` plus a manual `device.start()` — a hello that
 * never resolves, so the window stays open on purpose rather than the test
 * racing a ~2s wall-clock handshake. Testing `connectionDisplay("handshaking",
 * ...)` directly is the same idea on this side of the socket: "handshaking"
 * is passed in as a value, not arrived at by waiting, so there is no timing
 * assumption to be flaky about.
 */
describe("connectionDisplay", () => {
  it("connected: the accent tone, pulsing, with the live event rate", () => {
    const display = connectionDisplay("connected", 42);
    expect(display).toEqual({ tone: "var(--accent)", label: "live · 42 evt/s", pulse: true });
  });

  it("handshaking: neither the connected accent nor the disconnected danger tone (GRA-161 AC2)", () => {
    const display = connectionDisplay("handshaking", 0);
    expect(display.tone).not.toBe("var(--accent)");
    expect(display.tone).not.toBe("var(--danger)");
    expect(display.pulse).toBe(false);
    // Wording should say what is true (AC2): connected to the device,
    // waiting on the app's first check-in — not a bare "connecting" or
    // "disconnected" that claims either too little or too much.
    expect(display.label).toMatch(/connected/i);
    expect(display.label).toMatch(/waiting/i);
  });

  it("connecting: neutral, not the danger tone it used to share with disconnected", () => {
    const display = connectionDisplay("connecting", 0);
    expect(display.tone).not.toBe("var(--danger)");
    expect(display.pulse).toBe(false);
    expect(display.label).toBe("connecting");
  });

  it("disconnected: the one state that actually gets the danger tone", () => {
    const display = connectionDisplay("disconnected", 0);
    expect(display.tone).toBe("var(--danger)");
    expect(display.pulse).toBe(false);
    expect(display.label).toBe("disconnected");
  });

  it("an unrecognised state does not render as disconnected (GRA-161 AC4 / GRA-162)", () => {
    // A build running slightly behind the server it is talking to is the
    // realistic way this happens — the server sends a ConnectionState this
    // UI bundle's own type does not list yet. Cast past the type on purpose:
    // the whole point is to prove behaviour for a value the type system
    // says cannot occur, the same gap that put the red pill on every
    // handshake before this ticket.
    const future = "reconnecting" as ConnectionState;
    const display = connectionDisplay(future, 0);
    expect(display.tone).not.toBe("var(--danger)");
    // Muted/neutral, same family as "connecting" — an unknown state is
    // unproven, not a proven failure.
    expect(display.tone).toBe("var(--color-muted)");
    expect(display.pulse).toBe(false);
    // The raw value survives into the label instead of being swallowed —
    // debuggable rather than a generic "disconnected" that hides what
    // actually arrived.
    expect(display.label).toContain("reconnecting");
  });
});
