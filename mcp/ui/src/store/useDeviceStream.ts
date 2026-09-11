// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useSyncExternalStore } from "react";
import { TimelineStore } from "./TimelineStore";
import type { ServerMessage } from "../types";

const RECONNECT_MS = 1000;

/**
 * Connects to the timeline server and keeps the store fed.
 *
 * Returns the store itself rather than its contents: the canvas reads the
 * event array directly every frame, and handing that through React state would
 * copy twenty thousand objects for no one's benefit. The returned `version`
 * exists only so components that *do* render from the data know when to.
 */
export function useDeviceStream(): { store: TimelineStore; version: number } {
  const storeRef = useRef<TimelineStore | null>(null);
  storeRef.current ??= new TimelineStore();
  const store = storeRef.current;

  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${location.host}/ws`);

      socket.addEventListener("message", (message: MessageEvent<string>) => {
        try {
          store.apply(JSON.parse(message.data) as ServerMessage);
        } catch {
          // A frame we cannot parse is not worth tearing the socket down for.
        }
      });

      socket.addEventListener("close", () => {
        if (closed) return;
        store.setConnection("disconnected");
        // The far end is a dev server next to an app being reinstalled. It
        // going away is routine, so reconnecting quietly is the right response.
        retry = window.setTimeout(connect, RECONNECT_MS);
      });
    };

    connect();

    return () => {
      closed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, [store]);

  return { store, version };
}
