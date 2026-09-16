// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  CONNECTING_REVEAL_MS,
  initialSettledConnection,
  settleConnection,
  type SettledConnection,
} from "./settledConnection";
import type { ConnectionState } from "../types";

/**
 * GRA-192: `settleConnection` is a pure function of (previous result, raw
 * state, clock reading), so every case here drives it with an explicit `now`
 * instead of a real or fake timer — no DOM, no React, no setTimeout involved.
 * The `now` values below are chosen to mirror `mcp/src/device.ts`'s real
 * backoff sequence (500ms, 1s, 2s, 5s) so the "one settled state" claim is
 * checked against the actual cadence the bug report was about, not an
 * arbitrary one.
 */

/** Applies one disconnected->connecting->disconnected cycle and returns the
 *  result after the connecting excursion, plus the result after the
 *  following disconnected — the shape every cadence step in the flicker
 *  loop takes. */
function cycle(
  state: SettledConnection,
  connectingAt: number,
  disconnectedAt: number,
): { duringConnecting: SettledConnection; afterDisconnected: SettledConnection } {
  const duringConnecting = settleConnection(state, "connecting", connectingAt);
  const afterDisconnected = settleConnection(duringConnecting, "disconnected", disconnectedAt);
  return { duringConnecting, afterDisconnected };
}

describe("settleConnection: the disconnected/connecting retry loop (GRA-192 AC1)", () => {
  it("yields one displayed state across a full backoff sequence (500ms, 1s, 2s, 5s cadence)", () => {
    let state = initialSettledConnection("disconnected");
    const cadence = [500, 1000, 2000, 5000];
    const displayedThroughout: ConnectionState[] = [state.displayed];
    let t = 0;

    for (const gap of cadence) {
      t += gap;
      const { duringConnecting, afterDisconnected } = cycle(state, t, t + 1);
      displayedThroughout.push(duringConnecting.displayed, afterDisconnected.displayed);
      state = afterDisconnected;
      t += 1;
    }

    // Every single one of these is "disconnected" -- the retry loop never
    // produces a second displayed state as long as no excursion outlives
    // CONNECTING_REVEAL_MS, however many times it repeats.
    expect(new Set(displayedThroughout)).toEqual(new Set<ConnectionState>(["disconnected"]));
  });

  it("shows connecting once a connecting excursion outlives CONNECTING_REVEAL_MS (AC3: 5.5s)", () => {
    let state = initialSettledConnection("disconnected");
    state = settleConnection(state, "connecting", 0);
    expect(state.displayed).toBe("disconnected"); // not yet -- ticket AC1's steady pill

    // The same raw state, checked again later with nothing else having
    // changed -- exactly what the hook's own timer does when no new raw
    // state arrives to trigger a recompute.
    state = settleConnection(state, "connecting", 5_500);
    expect(state.displayed).toBe("connecting");
  });

  it("does not reveal at exactly CONNECTING_REVEAL_MS -- the threshold is exclusive", () => {
    let state = initialSettledConnection("disconnected");
    state = settleConnection(state, "connecting", 0);
    state = settleConnection(state, "connecting", CONNECTING_REVEAL_MS);
    expect(state.displayed).toBe("disconnected");
  });
});

describe("settleConnection: states that are never hidden (GRA-192 AC2, ticket ruling 1)", () => {
  it("shows handshaking immediately, from any prior settled state", () => {
    const fromDisconnected = settleConnection(initialSettledConnection("disconnected"), "handshaking", 100);
    expect(fromDisconnected.displayed).toBe("handshaking");

    const fromHiddenConnecting = settleConnection(
      settleConnection(initialSettledConnection("disconnected"), "connecting", 0),
      "handshaking",
      50,
    );
    expect(fromHiddenConnecting.displayed).toBe("handshaking");
  });

  it("shows connected immediately", () => {
    const state = settleConnection(initialSettledConnection("handshaking"), "connected", 10);
    expect(state.displayed).toBe("connected");
  });

  it("shows disconnected immediately when it follows connected or handshaking -- a real drop", () => {
    const afterConnected = settleConnection(initialSettledConnection("connected"), "disconnected", 10);
    expect(afterConnected.displayed).toBe("disconnected");

    const afterHandshaking = settleConnection(initialSettledConnection("handshaking"), "disconnected", 10);
    expect(afterHandshaking.displayed).toBe("disconnected");
  });

  it("shows disconnected immediately even mid-hidden-connecting-streak -- disconnected is always a fact", () => {
    const hidden = settleConnection(initialSettledConnection("disconnected"), "connecting", 0);
    expect(hidden.displayed).toBe("disconnected"); // still hidden, per AC1
    const state = settleConnection(hidden, "disconnected", 100);
    expect(state.displayed).toBe("disconnected");
    expect(state.pendingSince).toBeNull(); // the streak is over, not merely paused
  });
});

describe("settleConnection: self-check (a) inputs", () => {
  it("an unrecognised future state string is shown immediately, not hidden as if it were 'connecting'", () => {
    const unknown = "reconnecting" as ConnectionState;
    const fromHiddenConnecting = settleConnection(
      settleConnection(initialSettledConnection("disconnected"), "connecting", 0),
      unknown,
      50,
    );
    expect(fromHiddenConnecting.displayed).toBe(unknown);
    expect(fromHiddenConnecting.pendingSince).toBeNull();
  });

  it("connecting as the very first state ever observed is shown, not hidden -- nothing settled to hide behind", () => {
    const state = initialSettledConnection("connecting");
    expect(state.displayed).toBe("connecting");
    expect(state.pendingSince).toBeNull();
  });

  it("the same state repeated does not reset the pending clock or re-hide a state already revealed", () => {
    let state = initialSettledConnection("disconnected");
    state = settleConnection(state, "connecting", 0);
    state = settleConnection(state, "connecting", 5_500); // revealed
    expect(state.displayed).toBe("connecting");

    // Repeating the identical raw value at a later time must not restart the
    // pending window: an implementation that reset `pendingSince` to `now`
    // on every call to "connecting" (instead of only on a genuine
    // transition into it) would compute elapsed = 0 here, which is not
    // > CONNECTING_REVEAL_MS, and would wrongly flip back to "disconnected".
    state = settleConnection(state, "connecting", 5_600);
    expect(state.displayed).toBe("connecting");
  });
});
