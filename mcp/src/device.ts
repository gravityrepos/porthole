// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import net from "node:net";
import { EventEmitter } from "node:events";

/**
 * One frame per line, UTF-8. A frame carrying `id` is a response to a request
 * we sent; a frame carrying `event` is the device telling us something happened.
 */
export interface DeviceEvent {
  event: string;
  /** Device uptime in ms. Not wall clock — see hello.startedAt for the origin. */
  t: number;
  seq: number;
  data: Record<string, unknown>;
}

interface Response {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface Hello {
  protocol: number;
  packageName: string;
  processName: string;
  versionName: string | null;
  device: string;
  sdkInt: number;
  startedAt: number;
  collectors: string[];
}

export type ConnectionState = "disconnected" | "connecting" | "connected";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Talks to the app over the adb-forwarded loopback port.
 *
 * Reconnects on its own, because the far end is an app being actively developed:
 * it gets killed, reinstalled and relaunched constantly, and none of that should
 * require restarting the MCP server.
 */
export class DeviceClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
  >();
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  state: ConnectionState = "disconnected";
  hello: Hello | null = null;
  lastError: string | null = null;

  constructor(
    private readonly host: string,
    readonly port: number,
  ) {
    super();
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.socket = null;
    this.setState("disconnected");
  }

  private connect(): void {
    if (this.closed || this.socket) return;
    this.setState("connecting");

    const socket = net.createConnection({ host: this.host, port: this.port });
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    this.socket = socket;

    socket.on("connect", () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.lastError = null;
      this.setState("connected");
      // hello doubles as a liveness check and as the timeline's origin.
      this.request<Hello>("hello")
        .then((hello) => {
          this.hello = hello;
          this.emit("hello", hello);
        })
        .catch((error: Error) => {
          this.lastError = error.message;
        });
    });

    socket.on("data", (chunk: string) => this.onData(chunk));

    socket.on("error", (error: Error) => {
      this.lastError = error.message;
    });

    socket.on("close", () => {
      this.socket = null;
      this.hello = null;
      this.failPending("device disconnected");
      this.setState("disconnected");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let frame: Response | DeviceEvent;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }

    if ("event" in frame) {
      this.emit("event", frame);
      return;
    }

    const waiter = this.pending.get(frame.id);
    if (!waiter) return;
    this.pending.delete(frame.id);
    clearTimeout(waiter.timer);
    if (frame.ok) waiter.resolve(frame.result);
    else waiter.reject(new Error(frame.error ?? "unknown device error"));
  }

  private failPending(reason: string): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || this.state !== "connected") {
      return Promise.reject(new Error(this.notConnectedMessage()));
    }

    const id = this.nextId++;
    // Strip undefined so optional tool arguments do not become JSON nulls that
    // the Kotlin side would have to special-case.
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) cleaned[key] = value;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`device did not answer '${method}' within ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      socket.write(JSON.stringify({ id, method, params: cleaned }) + "\n");
    });
  }

  notConnectedMessage(): string {
    return [
      `Not connected to the app on ${this.host}:${this.port}.`,
      this.lastError ? `Last socket error: ${this.lastError}.` : null,
      "Check, in order:",
      "  1. the debug build is running on the device (the porthole starts with the process)",
      "  2. the adb bridge is up: 'adb forward tcp:PORT tcp:PORT', which",
      "     'porthole ui' and './gradlew portholeConnect' both do for you",
      `  3. nothing else on this machine is holding ${this.port}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
}
