// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { connectionDetailText, connectionDisplay } from "./Header";
import type { ConnectionState, Hello } from "../types";

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

describe("connectionDisplay with a package mismatch (GRA-197)", () => {
  it("connected + a package mismatch: the danger tone, not the accent tone or the live-rate label", () => {
    const display = connectionDisplay("connected", 42, "Connected to `com.example.shop`, but this MCP server was configured for `com.acme.app`.");
    expect(display.tone).toBe("var(--danger)");
    expect(display.pulse).toBe(true);
    expect(display.label).not.toContain("evt/s");
  });

  it("connected with no mismatch (null, the default): unchanged from before this ticket", () => {
    const display = connectionDisplay("connected", 42);
    expect(display).toEqual({ tone: "var(--accent)", label: "live · 42 evt/s", pulse: true });
  });

  it("a mismatch carried on a non-connected state is not shown — packageMismatch is only ever set while connected", () => {
    // Defensive: device.ts clears packageMismatch in the same place it
    // clears hello, so this combination should not arise in practice, but
    // connectionDisplay must not invent a danger pill for a state whose own
    // wording (e.g. "disconnected") already covers it.
    const display = connectionDisplay("disconnected", 0, "stale mismatch text");
    expect(display.tone).toBe("var(--danger)");
    expect(display.label).toBe("disconnected");
  });
});

const testHello: Hello = {
  protocol: 1,
  packageName: "com.example.shop",
  processName: "com.example.shop",
  versionName: "1.0.0-test",
  device: "Test Device",
  sdkInt: 34,
  startedAt: 0,
  collectors: ["frames", "http"],
};

/**
 * GRA-198: the neighbour text beside the pill, pulled out the same way
 * `connectionDisplay` is (see this file's own doc comment above) — the bug
 * this ticket fixes was two phrasings of one fact rendered side by side
 * (`handshaking`'s pill already says "waiting on app"; this text used to say
 * "waiting for the app" regardless of state), so what matters here is that
 * `handshaking` gets a sentence the pill does not already carry, while every
 * other state keeps saying what it always has.
 */
describe("connectionDetailText", () => {
  it("handshaking: says what the wait is for, not the disconnected sentence reused", () => {
    const text = connectionDetailText("handshaking", null);
    expect(text).not.toBeNull();
    // Not the literal disconnected/generic phrase GRA-198 reported — the
    // pill already says "waiting on app" for this state, so this text has
    // to add something the pill does not.
    expect(text).not.toBe("waiting for the app");
    expect(text).toMatch(/no hello/i);
  });

  it("disconnected: keeps the existing sentence", () => {
    expect(connectionDetailText("disconnected", null)).toBe("waiting for the app");
  });

  it("connecting: keeps the existing sentence too — its pill says 'connecting', a different fact", () => {
    expect(connectionDetailText("connecting", null)).toBe("waiting for the app");
  });

  it("connected: null once hello has landed — Header renders the hello block instead, not this text", () => {
    expect(connectionDetailText("connected", testHello)).toBeNull();
  });

  it("a hello present short-circuits every state to null, not just 'connected'", () => {
    // Defensive: whichever state accompanies a real hello, this function's
    // job is "what to say when there is no hello", so it must get out of
    // the way the instant there is one rather than asserting on `connection`.
    expect(connectionDetailText("handshaking", testHello)).toBeNull();
    expect(connectionDetailText("disconnected", testHello)).toBeNull();
  });
});
