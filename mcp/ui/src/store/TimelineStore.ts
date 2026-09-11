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
        this.foldLogAppends();
        break;
      }
      case "event": {
        this.events.push(message.event);
        if (this.events.length > MAX_EVENTS) {
          this.events.splice(0, this.events.length - MAX_EVENTS);
        }
        if (message.event.event === "log_append") this.foldAppend(message.event);
        break;
      }
      case "state": {
        this.connection = message.state;
        break;
      }
      case "hello": {
        this.hello = message.hello;
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
    this.touch();
  }

  /**
   * Stack traces arrive as follow-up lines for an entry already sent, so the
   * parent grows in place. Replayed over the whole buffer after a backfill,
   * because otherwise a trace only ever assembles for whoever was watching
   * when it happened.
   */
  private foldLogAppends(): void {
    for (const event of this.events) {
      if (event.event === "log_append") this.foldAppend(event);
    }
  }

  private foldAppend(event: DeviceEvent): void {
    if (event.applied) return;
    event.applied = true;
    const seq = num(event.data.seq, -1);
    const target = this.events.find((item) => item.event === "log" && item.seq === seq);
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
