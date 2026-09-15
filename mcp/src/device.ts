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

/**
 * GRA-96: the constant this side of the socket owns, matching
 * `PROTOCOL_VERSION` in `runtime/.../protocol/Protocol.kt` — the two are not
 * derived from a shared source, so a wire-format change obliges updating
 * both by hand (see that file's own comment on the constant it owns). This
 * is a bare integer with no `major.minor` split: a match means compatible,
 * anything else is a refusal, recorded in `protocolMismatch` below rather
 * than thrown, so the rest of the handshake can finish and the mismatch can
 * be reported as the specific, actionable message `porthole_status` needs
 * (GRA-96 AC1/AC2) instead of a generic connection failure.
 */
export const PROTOCOL_VERSION = 1;

/**
 * GRA-157: the socket connecting and the app saying hello are two different
 * events, roughly 2s apart on real hardware, and treating them as one was the
 * bug. "handshaking" names the gap: the socket is up, `request()` can already
 * be used (hello itself goes over it), but `hello` is still null. "connected"
 * is now a promise, not just a name — see `setState()` below, which refuses
 * to enter it while `hello` is null, and `connect()`'s hello handler, which is
 * the only place that promise is fulfilled. Every caller that used to write
 * `state === "connected" && hello` can drop the `&& hello`; every caller that
 * used to write `state === "connected"` alone and silently mean "and hello
 * happens to be set" was the bug, and now has three states to actually name
 * what it meant.
 */
export type ConnectionState = "disconnected" | "connecting" | "handshaking" | "connected";

/**
 * GRA-163: the ring survives a close (timeline.ts never clears it there —
 * only a new `hello` does, because the post-mortem case, "what happened
 * before it died", is exactly when someone needs those events most), but
 * that leaves a gap the ring itself cannot answer: whose process produced
 * what is still buffered, and when did it stop. This is that answer, kept
 * on `DeviceClient` because it is the thing that watches the socket close —
 * set in the close handler below, read by every tool that might describe
 * buffered data without a live session behind it.
 *
 * This is the counterpart to what a `hello` already does on the other side
 * of the session boundary: a `hello` discards the previous session's ring;
 * a close records the one that just ended, for whoever reads what is left
 * of it afterward.
 *
 * **Founder's decision, 2026-09-15: label answers as belonging to the
 * exited process, rather than clearing the ring or hiding them.**
 * This was built as an explicitly stated assumption and carried that label
 * until the founder confirmed it; the wording is updated here so nobody
 * reads a settled decision as an open bet. Retaining `lastExited` (instead
 * of, say, dropping it the moment the socket closes, which would make a
 * stale ring silently indistinguishable from an empty one again) is what
 * that decision means in code, recorded here because this is where someone
 * revisiting it would start looking — a search of `index.ts` alone would not
 * show that a decision was made, only its consequences. Were it ever
 * reversed, the change is to stop setting this field (or to clear it, and
 * the ring, on close) rather than to hunt through every caller. Five tests
 * pin it and would have to change with it: `index.test.ts`'s "AC1: with a non-empty ring and the device
 * disconnected, all three tools agree and none reports the dead process as
 * live", "AC2/AC5: with a non-empty ring and the device handshaking again,
 * no tool reports connected: true about the previous session's data", "AC3:
 * on socket close the ring is kept, not cleared, and device.lastExited
 * records who it belonged to", and "the ordinary case is unaffected:
 * connected: true still means the ring is confirmed live, not a previous
 * session's leftovers"; and `timeline.test.ts`'s "the ring is not cleared
 * by a close — only by a new hello — so it still holds what an exited
 * process produced".
 */
export interface ExitedSession {
  /** The process that produced whatever the ring may still hold. */
  hello: Hello;
  /** Wall-clock time (`Date.now()`) the socket actually closed. */
  disconnectedAt: number;
}

/** The one sentence every tool uses for "the socket is up, hello has not landed yet" — GRA-157 AC3. */
export const HANDSHAKE_PENDING_MESSAGE =
  "Connected, waiting on the app's first check-in. Ask again in a moment.";

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
  /**
   * GRA-163: null until a session that actually got a `hello` has closed;
   * from then on, the most recent one — overwritten on every subsequent
   * close that had a `hello`, so it always names the last confirmed process,
   * never a stale one from further back. See the close handler in
   * `connect()` for where it is set, and index.ts's `exitedProcessField()`/
   * `exitedProcessNotice()` for where it turns into what every tool
   * actually reports (moved there after QA round 1: this field says whose
   * process it is, but only the caller knows whether the ring it is about
   * to describe is empty — see `pendingMessage()`'s own comment below).
   */
  lastExited: ExitedSession | null = null;
  /**
   * GRA-96: null when the app's `hello.protocol` matches `PROTOCOL_VERSION`,
   * otherwise the sentence `porthole_status` reports verbatim — set once,
   * in `connect()`'s hello handler, right where `hello` itself is set, so it
   * is never stale relative to whichever `hello` is currently held. Kept
   * separate from `lastError`: that field means "the socket or a request
   * failed", this one means "the socket and the handshake both succeeded and
   * the two sides still cannot be trusted to agree on the wire format" — a
   * different fact that deserves its own name instead of overloading
   * lastError's "something went wrong" with a case that is not a failure to
   * connect at all.
   */
  protocolMismatch: string | null = null;

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
    // Clearing the timeout without nulling the field leaves scheduleReconnect()'s
    // guard (`this.closed || this.reconnectTimer`) permanently true after a later
    // start(): the stale, already-cleared timer looks exactly like a reconnect
    // that is still scheduled, so a subsequent disconnect never retries.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
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
      // Not "connected" yet — GRA-157. The TCP handshake finishing says
      // nothing about whether the far end is a Porthole runtime, let alone
      // which app; hello is what answers that, and it has not been asked
      // yet at this line. Callers that need "connected" is real now get it:
      // the state stays "handshaking" until the block below actually has a
      // Hello in hand.
      this.setState("handshaking");
      // hello doubles as a liveness check and as the timeline's origin.
      this.request<Hello>("hello")
        .then((hello) => {
          // Order matters: hello is set before the state change that
          // announces it, so anything reacting to the "state" event (or
          // reading `.hello` right after seeing state flip to "connected")
          // never observes "connected" with `hello` still null. setState()
          // also asserts this itself, so a future edit that reordered these
          // two lines would fail loudly instead of reintroducing the race.
          this.hello = hello;
          // GRA-96: computed right where `hello` is set, not deferred to
          // whichever tool asks later — a caller reading `protocolMismatch`
          // right after the "hello" event below always sees the answer for
          // the `hello` it just received, never a stale one from a previous
          // connection. Refusal, not a thrown error: the socket is fine and
          // the app really did answer, so the rest of the surface (findings,
          // timeline, …) still works for whatever it can, and this is the
          // one specific, actionable fact layered on top (GRA-96 AC1/AC2).
          this.protocolMismatch =
            hello.protocol === PROTOCOL_VERSION
              ? null
              : `The app is speaking protocol ${hello.protocol}; this server understands protocol ` +
                `${PROTOCOL_VERSION}. Update the app's Porthole runtime dependency to a version that ` +
                `speaks protocol ${PROTOCOL_VERSION}, or pin the npm package this MCP server runs from ` +
                `(in .mcp.json) to the version that matches the app.`;
          this.setState("connected");
          this.emit("hello", hello);
        })
        .catch((error: Error) => {
          // The socket is still open and still usable — only the hello
          // round-trip failed (most likely its own 5s timeout, if the far
          // end accepted the TCP connection but never speaks the protocol).
          // Staying in "handshaking" rather than falling back to "connected"
          // is the point of this whole change; there is deliberately no
          // retry here, since request() already gives every other method
          // the same 5s timeout and nothing about hello is special enough to
          // loop on its own.
          this.lastError = error.message;
        });
    });

    socket.on("data", (chunk: string) => this.onData(chunk));

    socket.on("error", (error: Error) => {
      this.lastError = error.message;
    });

    socket.on("close", () => {
      this.socket = null;
      // GRA-163: captured before `hello` is cleared below, and only when
      // there was one — a socket that closes mid-handshake (this.hello
      // still null) never had a confirmed session to record, and recording
      // one here would overwrite the real last-exited process with nothing.
      if (this.hello) {
        this.lastExited = { hello: this.hello, disconnectedAt: Date.now() };
      }
      this.hello = null;
      // GRA-96: cleared with `hello`, for the same reason — a mismatch is a
      // fact about the `hello` that produced it, and once that `hello` is
      // gone (a new connection will get its own, possibly no longer
      // mismatched) there is nothing left for this to still be true about.
      this.protocolMismatch = null;
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
    // GRA-157 AC1: "connected" implies `hello` is non-null, enforced here —
    // the one place `state` is actually assigned — rather than left for
    // every reader to remember. If this throws, the bug is in this file
    // (most likely connect()'s hello handler setting state before hello),
    // never in whatever asked for the transition.
    if (state === "connected" && this.hello === null) {
      throw new Error(
        "DeviceClient invariant violated: cannot enter state 'connected' with hello still null",
      );
    }
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    // "handshaking" is allowed here on purpose: it is the exact state hello
    // itself is sent in (see connect()'s socket.on("connect") above, which
    // sets "handshaking" and then calls request<Hello>("hello") next) —
    // gating on "connected" alone would make sending hello reject itself.
    // Only "connecting" (TCP handshake still in flight — this.socket exists
    // but has not fired "connect" yet) and "disconnected" have no usable
    // socket to write a frame to.
    //
    // GRA-162 QA: this used to spell the same condition out longhand as
    // `this.state !== "handshaking" && this.state !== "connected"`, which is
    // isAttached() negated (De Morgan's) but written by hand instead of
    // through it. That made this a sixth silent site the AC 2 probe did not
    // catch: a `!==` pair against two literals still compiles unchanged when
    // the union grows, and a future state would fall through to "not
    // attached" and reject every request() call with the not-connected
    // message even while the socket was genuinely live. Routing through
    // isAttached() puts this choke point behind the same never-guarded
    // switch as the rest, so a new state fails `tsc` here too instead of
    // silently rejecting live traffic.
    if (!socket || !isAttached(this.state)) {
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

  /**
   * The disconnected/handshaking half of what every tool says about the
   * connection, written once instead of separately by porthole_status,
   * findings, and whichever tool asks next (GRA-157 AC3). Returns null when
   * `state` is "connected", since `hello` is guaranteed non-null there (see
   * setState() above) and what to say about a live connection differs by
   * caller — porthole_status names the collectors, findings talks about the
   * buffer — so that half stays with each tool.
   *
   * The switch is exhaustive on purpose, with a compiled-in `never` check
   * instead of a `default` that quietly falls through: a fifth
   * ConnectionState added later without a case here fails `tsc`, in this one
   * place, rather than silently being treated as either "connected" or the
   * wall. Everywhere else asks this method instead of re-deriving the answer
   * from `state` and `hello` by hand, which is the actual fix GRA-157 is
   * about. (GRA-162: this used to say it was "deliberately the only place in
   * the package with that check" — it no longer is. QA counted eight sites
   * outside this file that read `device.state === "…"` directly, which
   * `tsc` does not flag when a state is added because `===` against a string
   * literal just evaluates false for anything new. `isAttached()`,
   * `isConnected()` and `isHandshaking()` below give those call sites the
   * same guarantee this switch has always had, instead of leaving them to
   * reinvent it inconsistently or not at all.)
   */
  /**
   * GRA-163 QA round 1: this used to append an "exited process" sentence of
   * its own (`withExitedSessionNote()`, now removed) whenever `lastExited`
   * was set. That sentence unconditionally said "whatever is still buffered
   * is from X" — true on the branch that has a non-empty ring, false on the
   * branch that does not (the empty-ring-plus-`lastExited` case: a process
   * reconnects, clears the ring on its own `hello`, then dies before
   * emitting anything), because this method has no way to know which one it
   * is being asked from — `pendingMessage()` only ever sees `this.state`
   * and `this.lastExited`, never `timeline.buffer().length`. Two more
   * faults rode along with that one: `porthole_status` calls
   * `exitedProcessField()` unconditionally while `findings`/
   * `what_was_happening` only called it from their non-empty-ring branch,
   * so the same state produced a payload with `exitedProcess` on one tool
   * and without it on another — and the prose was folded into this string
   * while the structured field lived in index.ts, so the two could disagree
   * even about a single tool's own single answer.
   *
   * The fix moves all of it to index.ts's `exitedProcessNotice()`, called
   * from every branch of every tool that might describe ring content,
   * because index.ts is the one place that actually knows whether the ring
   * it is about to describe is empty. This method goes back to answering
   * exactly what its name says: how to reconnect, or that the handshake is
   * still pending. Nothing else.
   */
  pendingMessage(): string | null {
    switch (this.state) {
      case "disconnected":
      case "connecting":
        return this.notConnectedMessage();
      case "handshaking":
        return HANDSHAKE_PENDING_MESSAGE;
      case "connected":
        return null;
      default: {
        const exhaustive: never = this.state;
        throw new Error(`DeviceClient: unhandled ConnectionState '${exhaustive as string}'`);
      }
    }
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

// --- GRA-162: exhaustive readers of a bare ConnectionState ------------------
//
// Free functions, not methods, because every call site below holds a
// ConnectionState value (`device.state`, or one carried on an event/message)
// rather than a DeviceClient to ask. Each is a switch with the same
// compiled-in `never` guard as pendingMessage() above: adding a fifth
// ConnectionState without extending a case list here fails `tsc` at that
// list, not silently at nothing. Three functions rather than one because the
// call sites genuinely want three different questions answered, and a single
// helper returning a wider type would just move the "did I handle the new
// case" judgement call to every caller instead of to the compiler here.

/**
 * The "loose" sense `findings`, `porthole_status` and `what_was_happening`
 * use: the socket is up, whether or not `hello` has landed. True for
 * "handshaking" and "connected"; false for "connecting" and "disconnected".
 */
export function isAttached(state: ConnectionState): boolean {
  switch (state) {
    case "handshaking":
    case "connected":
      return true;
    case "connecting":
    case "disconnected":
      return false;
    default: {
      const exhaustive: never = state;
      throw new Error(`DeviceClient: unhandled ConnectionState '${exhaustive as string}'`);
    }
  }
}

/**
 * The "strict" sense: `hello` has actually landed. True only for
 * "connected" — see setState()'s invariant above, which makes that the only
 * state in which `hello` is guaranteed non-null.
 */
export function isConnected(state: ConnectionState): boolean {
  switch (state) {
    case "connected":
      return true;
    case "connecting":
    case "handshaking":
    case "disconnected":
      return false;
    default: {
      const exhaustive: never = state;
      throw new Error(`DeviceClient: unhandled ConnectionState '${exhaustive as string}'`);
    }
  }
}

/**
 * True only while the handshake is in flight: the socket is up, `hello` has
 * not landed. Named separately from isAttached()/isConnected() because
 * several call sites want to say something specific about the handshake
 * window rather than lump it in with either "attached" or "not yet".
 */
export function isHandshaking(state: ConnectionState): boolean {
  switch (state) {
    case "handshaking":
      return true;
    case "connecting":
    case "connected":
    case "disconnected":
      return false;
    default: {
      const exhaustive: never = state;
      throw new Error(`DeviceClient: unhandled ConnectionState '${exhaustive as string}'`);
    }
  }
}
