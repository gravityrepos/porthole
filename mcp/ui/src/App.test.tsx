// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { isAttached, protocolMismatchMessage } from "./App";
import type { ConnectionState, Hello } from "./types";

/**
 * `isAttached` and `protocolMismatchMessage` are pulled out of App() so they
 * can be tested directly, the same reasoning as Header.test.tsx's
 * `connectionDisplay` — this workspace has no DOM-rendering test setup.
 */

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

describe("isAttached (GRA-166 item 5)", () => {
  it("is false for connecting and disconnected", () => {
    expect(isAttached("connecting")).toBe(false);
    expect(isAttached("disconnected")).toBe(false);
  });

  it("is true for handshaking -- the setup probe now fires during the handshake too", () => {
    // Before this ticket the probe used `connection === "connected"`
    // directly, so it never fired during "handshaking" at all. That was
    // self-healing (the dependency changes the moment state reaches literal
    // "connected"), but there is no reason to wait: the socket is already up
    // during "handshaking", which is exactly what isAttached() means.
    expect(isAttached("handshaking")).toBe(true);
  });

  it("is true for connected", () => {
    expect(isAttached("connected")).toBe(true);
  });

  it("defaults to true for a state this bundle does not recognise, and does not throw (GRA-166 item 5)", () => {
    // The actual defect: `store.connection === "connected"` (and a
    // never-guarded throw-on-default switch, device.ts's own isAttached())
    // both treat an unrecognised future state as "not attached", and unlike
    // "handshaking" that never self-heals -- nothing re-evaluates the
    // decision once made. A build a version behind the server it is talking
    // to is the realistic way this happens (see Header.tsx's
    // connectionDisplay for the same scenario), so this must survive it
    // rather than throw.
    const future = "reconnecting" as ConnectionState;
    expect(() => isAttached(future)).not.toThrow();
    expect(isAttached(future)).toBe(true);
  });
});

describe("protocolMismatchMessage (GRA-96 AC3)", () => {
  it("is null before hello has landed", () => {
    expect(protocolMismatchMessage(null)).toBeNull();
  });

  it("is null when the app's protocol matches what this UI expects", () => {
    expect(protocolMismatchMessage(hello({ protocol: 1 }))).toBeNull();
  });

  it("names both versions and the action when they disagree", () => {
    const message = protocolMismatchMessage(hello({ protocol: 2 }));
    expect(message).not.toBeNull();
    // AC2: "The message names both versions and the action."
    expect(message).toContain("2");
    expect(message).toContain("1");
    expect(message).toMatch(/update|reload/i);
  });
});
