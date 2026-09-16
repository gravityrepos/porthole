// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import type { ConnectionState } from "../types";

/**
 * GRA-192: mirrors `mcp/src/device.ts`'s `RECONNECT_MAX_MS` — the client's
 * own worst-case backoff between reconnect attempts. A `connecting` that has
 * been showing for longer than this is no longer explained by the ordinary
 * disconnected/connecting churn a retry loop produces on its own, so it is
 * worth surfacing. Not imported from `mcp/src` — see `App.tsx`'s
 * `isAttached()` comment for why a value (as opposed to a type) out of
 * `device.ts` cannot be imported into this bundle without dragging `node:net`
 * in with it. Kept in sync by hand, the same way `EXPECTED_PROTOCOL_VERSION`
 * mirrors `PROTOCOL_VERSION`.
 */
export const CONNECTING_REVEAL_MS = 5_000;

/**
 * What the header should currently show, plus enough bookkeeping to decide
 * the *next* answer without re-deriving history.
 *
 * `pendingSince` is set the moment a `connecting` excursion starts (right
 * after a shown "disconnected", or continuing one already in progress) and
 * cleared the moment anything else is settled — it exists only so a caller
 * with no new raw state to report (the hook below, on a timer) can still ask
 * "has this gone on long enough to show yet?"
 */
export interface SettledConnection {
  displayed: ConnectionState;
  /** The raw state this result was computed from. */
  raw: ConnectionState;
  pendingSince: number | null;
}

/** The seed for a stream that has not produced a transition yet: whatever the
 *  first raw state is, shown as-is — there is nothing settled yet to hide
 *  behind, so hiding it would only mean pretending to know something that
 *  has not been observed. */
export function initialSettledConnection(raw: ConnectionState): SettledConnection {
  return { displayed: raw, raw, pendingSince: null };
}

/**
 * The pure decision, GRA-192's actual fix: given what was last settled, the
 * newly arrived raw state, and the clock reading it arrived at, what should
 * the pill show now?
 *
 * `now` is taken as a plain argument rather than read internally so this can
 * be driven by a test with an entirely fake clock and no timers, DOM, or
 * React involved — see settledConnection.test.ts.
 *
 * Rules (ticket ruling 1):
 * - "connected" / "handshaking" / "disconnected" are all proven facts, never
 *   retry noise, and displayed the moment they arrive — this is also what
 *   makes a real drop (connected/handshaking -> disconnected) immediate.
 * - "connecting" that continues a streak which was, until now, showing the
 *   settled "disconnected" pill keeps showing "disconnected" — it is not new
 *   information — unless the streak has run longer than
 *   `CONNECTING_REVEAL_MS`, at which point it is shown for what it is.
 * - "connecting" with nothing settled to hide behind (the very first state
 *   this stream has ever produced) is shown immediately: there is no prior
 *   "disconnected" pill to keep steady in its place.
 * - An unrecognised future state string (GRA-161 AC4's concern, one layer up
 *   from here) is not "connecting", so none of the hiding logic applies to
 *   it either — it is shown immediately, same as the three known proven
 *   states.
 */
export function settleConnection(
  prev: SettledConnection,
  raw: ConnectionState,
  now: number,
): SettledConnection {
  if (raw !== "connecting") {
    // "connected", "handshaking", "disconnected", or a value this build's
    // ConnectionState union does not list: none of them are the transient,
    // possibly-retry-noise state, so none of them are ever hidden.
    return { displayed: raw, raw, pendingSince: null };
  }

  const continuingStreak = prev.raw === "connecting";
  const followsShownDisconnect = prev.displayed === "disconnected";
  if (!continuingStreak && !followsShownDisconnect) {
    // Nothing settled to hide behind -- show it.
    return { displayed: "connecting", raw, pendingSince: now };
  }

  const pendingSince = continuingStreak ? (prev.pendingSince ?? now) : now;
  const displayed: ConnectionState = now - pendingSince > CONNECTING_REVEAL_MS ? "connecting" : "disconnected";
  return { displayed, raw, pendingSince };
}

/**
 * The React-facing half: applies `settleConnection` to a raw `connection`
 * prop as it changes, and — the part a pure function cannot do on its own —
 * keeps a timer running so a `connecting` streak still reveals itself after
 * `CONNECTING_REVEAL_MS` even if no new raw state ever arrives to trigger the
 * check. Without this, a device that dialled once and simply hung in
 * "connecting" forever (rather than cycling back through "disconnected")
 * would stay hidden behind a stale "disconnected" pill indefinitely.
 *
 * The prop-change branch runs during render, not in a `useEffect` keyed on
 * `[connection]`: an effect with that dependency array fires once on mount
 * too, and on mount `prev.raw` already equals `connection` (both seeded from
 * the same value), which would make a `connecting` first state look
 * indistinguishable from "continuing a streak" and hide it — exactly the
 * bug this hook exists to avoid. Comparing against a ref of the last prop
 * *this hook has actually reacted to* (React's own documented pattern for
 * adjusting state during rendering) sidesteps that: it is false on the very
 * first render by construction.
 */
export function useSettledConnection(connection: ConnectionState): ConnectionState {
  const [state, setState] = useState<SettledConnection>(() => initialSettledConnection(connection));
  const lastConnectionRef = useRef(connection);

  if (connection !== lastConnectionRef.current) {
    lastConnectionRef.current = connection;
    setState((prev) => settleConnection(prev, connection, Date.now()));
  }

  useEffect(() => {
    // Nothing pending, or already revealed: no timer needed.
    if (state.pendingSince === null || state.displayed === "connecting") return;

    // +1: settleConnection()'s own reveal check is strict ("longer than
    // CONNECTING_REVEAL_MS", not "at least") so a timer that fires exactly
    // on the deadline computes elapsed === CONNECTING_REVEAL_MS, is refused,
    // and would otherwise have to reschedule itself for one more tick. The
    // one extra millisecond here is what makes the timer and the check it
    // triggers agree on which side of the line "now" has to land.
    const deadline = state.pendingSince + CONNECTING_REVEAL_MS + 1;
    const timer = window.setTimeout(() => {
      setState((prev) => settleConnection(prev, prev.raw, Date.now()));
    }, Math.max(deadline - Date.now(), 0));
    return () => window.clearTimeout(timer);
  }, [state]);

  return state.displayed;
}
