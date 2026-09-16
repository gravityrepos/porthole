// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { ConnectionState, DeviceEvent, Hello, ServerMessage } from "../types";
import { num, str } from "../types";

/** Roughly ten minutes of a busy app. Beyond this the oldest events are dropped. */
const MAX_EVENTS = 20_000;

/**
 * Holds the event stream outside React.
 *
 * A busy screen emits well over sixty events a second. Putting that in
 * useState would re-render the tree on every one of them, and the canvas does
 * not need React to redraw — it needs the array. So the array lives here,
 * subscribers are notified at most once per animation frame, and components
 * read what they need when they wake up.
 */
export class TimelineStore {
  events: DeviceEvent[] = [];
  hello: Hello | null = null;
  connection: ConnectionState = "connecting";
  /**
   * GRA-197: mirrors `DeviceClient.packageMismatch` server-side — a fact
   * about the `hello` currently held, updated everywhere `hello` is and
   * cleared on disconnect for the same reason `hello` itself goes stale
   * then (see the "state" case in `apply` and `setConnection` below).
   */
  packageMismatch: string | null = null;

  private version = 0;
  private listeners = new Set<() => void>();
  private notifyHandle: number | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Version doubles as the snapshot: it changes exactly when the data does. */
  getVersion = (): number => this.version;

  apply(message: ServerMessage): void {
    switch (message.type) {
      case "init":
      case "reset": {
        this.events = message.events ?? [];
        if (message.state) this.connection = message.state;
        if (message.hello !== undefined) this.hello = message.hello;
        if (message.packageMismatch !== undefined) this.packageMismatch = message.packageMismatch;
        this.foldLogAppends();
        break;
      }
      case "event": {
        this.events.push(message.event);
        if (this.events.length > MAX_EVENTS) {
          // An O(n) memmove per event once the buffer is full. A ring buffer
          // would avoid it, but every reader here — the canvas, the lanes, the
          // fold below — wants a plain array in arrival order, and handing them
          // a ring means touching all of them. Left as it is deliberately.
          this.events.splice(0, this.events.length - MAX_EVENTS);
        }
        if (message.event.event === "log_append") this.foldAppend(message.event);
        break;
      }
      case "state": {
        this.connection = message.state;
        // GRA-197: a fact about a hello that is itself going stale the
        // instant this state is anything but "connected" — mirrors
        // device.ts's own close handler, which clears packageMismatch in
        // the same place (and for the same reason) it clears `hello`.
        if (message.state !== "connected") this.packageMismatch = null;
        break;
      }
      case "hello": {
        this.hello = message.hello;
        this.packageMismatch = message.packageMismatch;
        break;
      }
    }
    this.touch();
  }

  clear(): void {
    this.events = [];
    this.touch();
  }

  setConnection(state: ConnectionState): void {
    this.connection = state;
    // GRA-197: the "state" case above and this method are the two places
    // `connection` changes without a fresh `hello` — the WebSocket's own
    // "close" handler in useDeviceStream.ts calls this one directly, and it
    // needs the same clearing rule so a stale mismatch cannot survive past
    // the connection it was a fact about.
    if (state !== "connected") this.packageMismatch = null;
    this.touch();
  }

  /**
   * Stack traces arrive as follow-up lines for an entry already sent, so the
   * parent grows in place. Replayed over the whole buffer after a backfill,
   * because otherwise a trace only ever assembles for whoever was watching
   * when it happened.
   *
   * The parents are indexed once for the pass. Resolving each one with a scan
   * instead made this quadratic: a full 20 000-event buffer from a log-heavy
   * app is tens of millions of comparisons, spent on the frame the socket
   * delivers `init` or `reset` — and `reset` fires after every reconnect, which
   * for an app being reinstalled all day is not a rare event.
   */
  private foldLogAppends(): void {
    const logs = new Map<number, DeviceEvent>();
    for (const event of this.events) {
      // First one wins, as the scan this replaces did. Sequence numbers are
      // unique in anything the device actually emits, so it only decides a
      // malformed stream — but it keeps the fold behaving exactly as before.
      if (event.event === "log" && !logs.has(event.seq)) logs.set(event.seq, event);
    }
    for (const event of this.events) {
      if (event.event === "log_append") this.foldAppend(event, logs);
    }
  }

  /**
   * Folds one append's text onto its parent, or drops it.
   *
   * A missing parent is not an error: the append outlived the line it belonged
   * to, which is what eviction does to the oldest end of the buffer. Marking it
   * applied regardless is what stops a second fold from retrying it forever.
   *
   * `logs` is the index a fold pass builds; when it is there it is complete,
   * so a miss means evicted and must not fall back to a scan — that would put
   * the quadratic cost straight back for exactly the appends that have no
   * parent. A single streamed append has no index and scans, one pass over the
   * buffer for the occasional event that carries a stack trace.
   */
  private foldAppend(event: DeviceEvent, logs?: Map<number, DeviceEvent>): void {
    if (event.applied) return;
    event.applied = true;
    const seq = num(event.data.seq, -1);
    const target = logs
      ? logs.get(seq)
      : this.events.find((item) => item.event === "log" && item.seq === seq);
    if (!target) return;
    target.data.message = str(target.data.message) + "\n" + str(event.data.text);
  }

  /** Coalesced to one notify per frame, however many events arrived in it. */
  private touch(): void {
    this.version += 1;
    if (this.notifyHandle !== null) return;
    this.notifyHandle = requestAnimationFrame(() => {
      this.notifyHandle = null;
      for (const listener of this.listeners) listener();
    });
  }
}
