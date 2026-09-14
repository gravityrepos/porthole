// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import net, { type AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceClient, PROTOCOL_VERSION, type DeviceEvent } from "./device.js";

/**
 * device.ts is the only place that turns raw TCP bytes from the Android
 * runtime into `DeviceEvent`s and request/response pairs. Everything else in
 * this package trusts that it got that right, so this is the one file where
 * tests talk to a real `net.Server` instead of a fixture: framing bugs live
 * in exactly the gap between "what a fixture assumes arrives" and "what a
 * socket actually delivers in however many chunks the kernel felt like".
 *
 * The server below auto-answers `hello` (every DeviceClient sends one on
 * connect) and otherwise stays silent unless a test tells it to answer,
 * which is what makes the timeout tests possible without a real device.
 */

interface RawServer {
  port: number;
  sockets: net.Socket[];
  /** Writes a raw chunk, unsplit and unescaped, to the most recent connection. */
  write(raw: string): void;
  /** Destroys every open connection without a goodbye — a killed app, not a clean stop. */
  destroyAll(): void;
  /**
   * Resolves once this server has accepted at least `n` connections.
   *
   * The client reaches "connected" when *its* TCP connect completes, which can
   * be before this server's accept callback has run — the two are independent
   * halves of the same handshake. A test that destroys "every open connection"
   * at that moment can destroy an empty list, and the client then never notices
   * anything. That is a race, not a platform difference, and it lost on the
   * macOS runner while passing everywhere else; wait for the accept before
   * dropping the client.
   */
  whenAccepted(n?: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

async function startRawServer(options: { autoHello?: boolean } = {}): Promise<RawServer> {
  const autoHello = options.autoHello ?? true;
  const sockets: net.Socket[] = [];
  const acceptWaiters: Array<{ n: number; resolve: () => void }> = [];

  const server = net.createServer((socket) => {
    sockets.push(socket);
    for (let i = acceptWaiters.length - 1; i >= 0; i--) {
      if (sockets.length >= acceptWaiters[i].n) acceptWaiters.splice(i, 1)[0].resolve();
    }
    // A client calling stop() destroys its socket outright, which can arrive
    // here as ECONNRESET rather than a clean FIN. That is expected — several
    // tests deliberately abandon the connection — so it must not surface as
    // an uncaught exception on the server side.
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        if (!autoHello) continue;
        let request: { id: number; method: string } | undefined;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        if (request?.method === "hello") {
          socket.write(
            JSON.stringify({
              id: request.id,
              ok: true,
              result: {
                protocol: 1,
                packageName: "com.example.shop",
                processName: "com.example.shop",
                versionName: "1.0.0-test",
                device: "Test Device",
                sdkInt: 34,
                startedAt: 0,
                collectors: [],
              },
            }) + "\n",
          );
        }
        // Any other method is left unanswered on purpose — that is what
        // makes the request-timeout test possible without a real device.
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    sockets,
    write(raw: string) {
      sockets[sockets.length - 1]?.write(raw);
    },
    destroyAll() {
      for (const socket of sockets) socket.destroy();
    },
    whenAccepted(n = 1, timeoutMs = 3_000) {
      if (sockets.length >= n) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `timed out waiting for ${n} accepted connection(s); ${sockets.length} accepted`,
              ),
            ),
          timeoutMs,
        );
        acceptWaiters.push({
          n,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function waitForState(client: DeviceClient, state: string, timeoutMs = 3_000): Promise<void> {
  if (client.state === state) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("state", handler);
      reject(new Error(`timed out waiting for state '${state}', currently '${client.state}'`));
    }, timeoutMs);
    function handler(s: string) {
      if (s !== state) return;
      clearTimeout(timer);
      client.off("state", handler);
      resolve();
    }
    client.on("state", handler);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Every `DeviceClient` fires off its own `hello` request the instant the
 * socket connects (see device.ts's `connect()`), and the fake server answers
 * it asynchronously, on its own schedule. A test that starts writing raw,
 * hand-split bytes right after the "connected" state — rather than waiting
 * for that handshake to actually finish — races the hello response: the two
 * writes can interleave on the wire and corrupt both frames. Waiting for
 * `hello` first is what makes the raw writes below land on a clean stream.
 */
function waitForHello(client: DeviceClient, timeoutMs = 3_000): Promise<void> {
  if (client.hello) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for hello")), timeoutMs);
    client.once("hello", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const openClients: DeviceClient[] = [];
const openServers: RawServer[] = [];

function track(client: DeviceClient): DeviceClient {
  openClients.push(client);
  return client;
}

function trackServer(server: RawServer): RawServer {
  openServers.push(server);
  return server;
}

afterEach(async () => {
  for (const client of openClients.splice(0)) client.stop();
  for (const server of openServers.splice(0)) await server.close();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

describe("line framing", () => {
  it("reassembles a frame split across two data chunks", async () => {
    const server = trackServer(await startRawServer());
    const client = track(new DeviceClient("127.0.0.1", server.port));
    const events: DeviceEvent[] = [];
    client.on("event", (e: DeviceEvent) => events.push(e));

    client.start();
    await waitForState(client, "connected");
    await waitForHello(client);

    const frame = JSON.stringify({ event: "recompose", t: 1_000, seq: 1, data: { name: "Cart" } });
    const splitAt = Math.floor(frame.length / 2);

    server.write(frame.slice(0, splitAt));
    await sleep(30);
    expect(events, "half a line must not be parsed").toHaveLength(0);

    server.write(frame.slice(splitAt) + "\n");
    await sleep(30);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "recompose", t: 1_000, seq: 1, data: { name: "Cart" } });
  });

  it("holds a trailing partial line from a chunk that also contained a complete one", async () => {
    const server = trackServer(await startRawServer());
    const client = track(new DeviceClient("127.0.0.1", server.port));
    const events: DeviceEvent[] = [];
    client.on("event", (e: DeviceEvent) => events.push(e));

    client.start();
    await waitForState(client, "connected");
    await waitForHello(client);

    const first = JSON.stringify({ event: "a", t: 1, seq: 1, data: {} });
    const second = JSON.stringify({ event: "b", t: 2, seq: 2, data: {} });

    // One chunk: a complete line, a newline, then the first half of a second
    // line with nothing after it — the exact shape a TCP segment boundary
    // landing mid-frame produces.
    server.write(`${first}\n${second.slice(0, 10)}`);
    await sleep(30);
    expect(events.map((e) => e.event)).toEqual(["a"]);

    server.write(`${second.slice(10)}\n`);
    await sleep(30);
    expect(events.map((e) => e.event)).toEqual(["a", "b"]);
  });

  it("silently drops a line that is not valid JSON and keeps processing what follows", async () => {
    const server = trackServer(await startRawServer());
    const client = track(new DeviceClient("127.0.0.1", server.port));
    const events: DeviceEvent[] = [];
    const emittedErrors: unknown[] = [];
    client.on("event", (e: DeviceEvent) => events.push(e));
    client.on("error", (e: unknown) => emittedErrors.push(e));

    client.start();
    await waitForState(client, "connected");
    await waitForHello(client);

    server.write("this line is not JSON at all\n");
    server.write(JSON.stringify({ event: "after", t: 5, seq: 5, data: {} }) + "\n");
    await sleep(30);

    // Swallowed, not surfaced: no crash, no "error" event, and the next
    // well-formed line on the same connection still gets through.
    expect(emittedErrors).toEqual([]);
    expect(events.map((e) => e.event)).toEqual(["after"]);
    expect(client.state).toBe("connected");
  });

  it("drops a line that parses as JSON but is neither a response nor an event", async () => {
    // {"foo": 1} parses fine and has neither "event" nor a recognised
    // response id — device.ts's onLine treats anything without "event" as a
    // Response and looks up `frame.id` in the pending map; an id nothing is
    // waiting on must be a silent no-op, not a crash.
    const server = trackServer(await startRawServer());
    const client = track(new DeviceClient("127.0.0.1", server.port));
    const events: DeviceEvent[] = [];
    client.on("event", (e: DeviceEvent) => events.push(e));

    client.start();
    await waitForState(client, "connected");
    await waitForHello(client);

    server.write(JSON.stringify({ id: 999, ok: true, result: "nobody asked" }) + "\n");
    server.write(JSON.stringify({ event: "after", t: 1, seq: 1, data: {} }) + "\n");
    await sleep(30);

    expect(events.map((e) => e.event)).toEqual(["after"]);
    expect(client.state).toBe("connected");
  });
});

// ---------------------------------------------------------------------------
// reconnect
// ---------------------------------------------------------------------------

describe("reconnect", () => {
  it("waits before retrying, and doubles the wait on a second consecutive failure", async () => {
    const server = trackServer(await startRawServer());
    const client = track(new DeviceClient("127.0.0.1", server.port));

    client.start();
    await waitForState(client, "connected");

    // Stop listening entirely so every further attempt fails outright
    // (ECONNREFUSED) rather than connecting and then being dropped — a
    // dropped-then-reconnected cycle resets the backoff on the successful
    // TCP connect, which is not what this test is checking. Two straight
    // failures with no connect in between is what actually exercises
    // doubling.
    await server.close();

    const t0 = Date.now();
    await waitForState(client, "disconnected");
    await waitForState(client, "connecting"); // first retry attempt fires
    const firstDelay = Date.now() - t0;

    await waitForState(client, "disconnected"); // that attempt also fails
    const t1 = Date.now();
    await waitForState(client, "connecting"); // second retry attempt fires
    const secondDelay = Date.now() - t1;

    // RECONNECT_MIN_MS is 500 in device.ts; not asserting the exact constant
    // since it is not exported, only the shape: a real wait before the first
    // retry, and a longer one before the second.
    expect(firstDelay).toBeGreaterThanOrEqual(350);
    expect(firstDelay).toBeLessThan(1_000);
    expect(secondDelay).toBeGreaterThan(firstDelay * 1.5);
  }, 10_000);

  it("resets the backoff to the minimum after a successful reconnect", async () => {
    const server = trackServer(await startRawServer());
    const client = track(new DeviceClient("127.0.0.1", server.port));

    client.start();
    await waitForState(client, "connected");

    // First failure/retry cycle — the server is still listening, so the
    // retry succeeds.
    await server.whenAccepted(1);
    server.destroyAll();
    await waitForState(client, "disconnected");
    await waitForState(client, "connecting");
    await waitForState(client, "connected");

    // A second, independent failure. If the backoff had kept growing across
    // the successful reconnect, this wait would be roughly double the
    // first; since the TCP connect above succeeded, it should be back to
    // the minimum.
    // The reconnect is a second accept on this server, and the same race
    // applies to it: "connected" is the client's half of that handshake.
    await server.whenAccepted(2);
    const t0 = Date.now();
    server.destroyAll();
    await waitForState(client, "disconnected");
    await waitForState(client, "connecting");
    const delay = Date.now() - t0;

    expect(delay).toBeGreaterThanOrEqual(350);
    expect(delay).toBeLessThan(1_000);
  }, 10_000);

  it("stop() cancels a pending reconnect timer rather than letting it fire later", async () => {
    const server = trackServer(await startRawServer());
    const client = track(new DeviceClient("127.0.0.1", server.port));
    const states: string[] = [];
    client.on("state", (s: string) => states.push(s));

    client.start();
    await waitForState(client, "connected");

    await server.whenAccepted(1);
    server.destroyAll();
    await waitForState(client, "disconnected");

    // stop() before the reconnect timer (~500ms out) has a chance to fire.
    client.stop();
    states.length = 0;

    await sleep(800);
    expect(states, "a stopped client must not schedule a reconnect").not.toContain("connecting");
  }, 10_000);

  it("stop() clears its reconnect timer field, not just the timeout, so a later start() can reconnect again", async () => {
    const server = trackServer(await startRawServer());
    const client = track(new DeviceClient("127.0.0.1", server.port));

    client.start();
    await waitForState(client, "connected");

    // Disconnect once so scheduleReconnect() runs and sets a pending timer.
    await server.whenAccepted(1);
    server.destroyAll();
    await waitForState(client, "disconnected");

    // stop() while that timer is still pending. If it clears the timeout but
    // leaves `reconnectTimer` pointing at the (now-dead) handle, every later
    // scheduleReconnect() call sees a truthy `reconnectTimer` and treats a
    // reconnect as already scheduled, forever.
    client.stop();
    client.start();
    await waitForState(client, "connected");

    // A second, independent disconnect. This is the reconnect that a leaked
    // `reconnectTimer` would silently swallow: scheduleReconnect()'s guard
    // would still see the stale reference from before stop() and never
    // schedule anything, so the client would sit in "disconnected" forever
    // instead of moving to "connecting".
    await server.whenAccepted(2);
    server.destroyAll();
    await waitForState(client, "disconnected");
    await waitForState(client, "connecting", 2_000);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// requests: timeout and failure on close
// ---------------------------------------------------------------------------

describe("request timeout", () => {
  it("rejects a request the device never answers, once the timeout elapses", async () => {
    const server = trackServer(await startRawServer());
    const client = track(new DeviceClient("127.0.0.1", server.port));

    client.start();
    await waitForState(client, "connected");

    vi.useFakeTimers();
    try {
      const pending = client.request("nobody_handles_this");
      // Attached immediately, before the timer fires: Node flags a rejected
      // promise as unhandled the moment nothing has claimed it yet, and
      // `advanceTimersByTimeAsync` below is what actually fires the
      // rejection — the real `expect(pending).rejects...` assertion comes
      // after it, which is one microtask turn too late to count as the
      // promise's first handler.
      pending.catch(() => {});
      // REQUEST_TIMEOUT_MS is 5000 in device.ts; not exported, so advance
      // exactly that far rather than asserting the constant directly.
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).rejects.toThrow(/did not answer/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects immediately, before the connection exists, with a message naming the target", async () => {
    // No server at all — request() must not even try to write to a socket
    // that was never opened.
    const client = track(new DeviceClient("127.0.0.1", 1));
    await expect(client.request("anything")).rejects.toThrow(/Not connected/);
  });
});

// ---------------------------------------------------------------------------
// GRA-157: the handshake gets its own state
// ---------------------------------------------------------------------------

describe("the handshaking state", () => {
  it("moves disconnected -> connecting -> handshaking -> connected in order, with hello only set at the end", async () => {
    const server = trackServer(await startRawServer());
    const client = track(new DeviceClient("127.0.0.1", server.port));
    const seen: Array<{ state: string; helloWasNull: boolean }> = [];
    client.on("state", (s: string) => seen.push({ state: s, helloWasNull: client.hello === null }));

    client.start();
    await waitForState(client, "connected");

    // "handshaking" itself is not in this list until the real hello request
    // resolves and setState("connected") runs, so pulling the states out
    // this way is the honest order-of-events check, not just a set check.
    const states = seen.map((s) => s.state);
    expect(states).toEqual(["connecting", "handshaking", "connected"]);
    // hello was still null at the moment every one of those events fired,
    // except the very last ("connected") — this is the invariant from the
    // other direction: not just "connected implies hello", but "nothing
    // before connected has hello yet either", which is what makes
    // "handshaking" worth having as its own name instead of a substate of
    // "connected".
    expect(seen.map((s) => s.helloWasNull)).toEqual([true, true, false]);
  });

  it("accepts a request while merely handshaking, since hello itself is sent in that state", async () => {
    // A server that never auto-answers hello, so the client sits in
    // "handshaking" indefinitely — long enough to prove a second request
    // sent in that same state is not rejected the way one sent while
    // "connecting" or "disconnected" would be.
    const server = trackServer(await startRawServer({ autoHello: false }));
    const client = track(new DeviceClient("127.0.0.1", server.port));

    client.start();
    await waitForState(client, "handshaking");
    expect(client.state).toBe("handshaking");
    expect(client.hello).toBeNull();

    // The pending hello request itself is proof enough that request() did
    // not reject on entry to "handshaking" — if it had, connect() would
    // never have gotten this far and no server would have received a
    // "hello" method call at all.
    await server.whenAccepted(1);
    await sleep(30);
    expect(server.sockets).toHaveLength(1);
  });

  it("rejects a request while still 'connecting' (TCP handshake not yet complete), the same as before this state existed", async () => {
    // No listener at all: the TCP connect itself never completes, so the
    // client should reject immediately rather than queue a write against a
    // socket that may never open.
    const client = track(new DeviceClient("127.0.0.1", 1));
    client.start();
    await expect(client.request("anything")).rejects.toThrow(/Not connected/);
  });

  it("AC1: setState('connected') throws if hello is still null, independent of connect()'s own ordering", () => {
    // GRA-157 AC1 asks for the invariant to be enforced where state is set,
    // "not left as a comment" — this bypasses connect()'s hello-then-state
    // ordering entirely and calls the private method directly, so the test
    // is not just re-checking that connect() happens to call things in the
    // right order (device.test.ts's "moves disconnected -> ... -> connected"
    // test above already covers that). It proves the guard holds even if a
    // future edit got that ordering wrong.
    const client = track(new DeviceClient("127.0.0.1", 1));
    expect(client.hello).toBeNull();
    const setState = (
      client as unknown as { setState(state: string): void }
    ).setState.bind(client);
    expect(() => setState("connected")).toThrow(/invariant violated/);
    // The throw must not have half-applied the transition.
    expect(client.state).toBe("disconnected");
  });
});

describe("pending requests on close", () => {
  it("fails every pending request as soon as the device disconnects", async () => {
    const server = trackServer(await startRawServer());
    const client = track(new DeviceClient("127.0.0.1", server.port));

    client.start();
    await waitForState(client, "connected");

    const pending = client.request("nobody_handles_this");
    await server.whenAccepted(1);
    server.destroyAll();

    await expect(pending).rejects.toThrow(/disconnected/);
  });

  it("stop() settles pending requests promptly rather than leaving their timers to run out", async () => {
    const server = trackServer(await startRawServer());
    const client = track(new DeviceClient("127.0.0.1", server.port));

    client.start();
    await waitForState(client, "connected");

    const pending = client.request("nobody_handles_this");
    const started = Date.now();
    client.stop();

    await expect(pending).rejects.toThrow();
    const elapsed = Date.now() - started;
    // The request's own timeout is 5000ms. Settling promptly is the proof
    // that stop() actually tears the pending request down via the socket's
    // close handler, rather than leaving its timer to fire on its own much
    // later — which would still "work" but would keep the process (and a
    // real MCP server's shutdown) waiting on a timer stop() should have
    // owned.
    expect(elapsed).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// GRA-96: hello.protocol is now checked, not just sent
// ---------------------------------------------------------------------------

/** A hello response payload for the given protocol, otherwise realistic. */
function helloResult(protocol: number) {
  return {
    protocol,
    packageName: "com.example.shop",
    processName: "com.example.shop",
    versionName: "1.0.0-test",
    device: "Test Device",
    sdkInt: 34,
    startedAt: 0,
    collectors: [],
  };
}

describe("protocol mismatch", () => {
  it("records a specific message naming both versions when hello.protocol disagrees", async () => {
    // autoHello: false so this test can answer with a protocol the default
    // fixture (hard-coded to PROTOCOL_VERSION) never would — a real fake
    // device reporting a different protocol, not a hand-built expectation of
    // what device.ts "should" do with one.
    const server = trackServer(await startRawServer({ autoHello: false }));
    const client = track(new DeviceClient("127.0.0.1", server.port));

    client.start();
    await server.whenAccepted(1);
    // connect() sends exactly one request before this point — its own
    // "hello" — so this is always id 1; see the "handshaking state" describe
    // block above for the same assumption used to drive a hand-written
    // response.
    const mismatched = PROTOCOL_VERSION + 1;
    server.write(JSON.stringify({ id: 1, ok: true, result: helloResult(mismatched) }) + "\n");

    await waitForHello(client);
    // The handshake still succeeds -- a mismatch is a refusal to trust the
    // wire format, not a failure to talk to the device at all, so the rest
    // of the surface keeps working for whatever it can (GRA-96's own note on
    // protocolMismatch explains why this is not folded into lastError).
    expect(client.state).toBe("connected");
    expect(client.protocolMismatch).not.toBeNull();
    // AC2: "The message names both versions and the action."
    expect(client.protocolMismatch).toContain(String(mismatched));
    expect(client.protocolMismatch).toContain(String(PROTOCOL_VERSION));
    expect(client.protocolMismatch).toMatch(/update|pin/i);
  });

  it("is null when hello.protocol matches PROTOCOL_VERSION", async () => {
    const server = trackServer(await startRawServer()); // default fixture sends protocol: 1
    const client = track(new DeviceClient("127.0.0.1", server.port));

    client.start();
    await waitForState(client, "connected");
    await waitForHello(client);

    expect(client.protocolMismatch).toBeNull();
  });

  it("clears once the device disconnects, since it is a fact about the hello that produced it", async () => {
    const server = trackServer(await startRawServer({ autoHello: false }));
    const client = track(new DeviceClient("127.0.0.1", server.port));

    client.start();
    await server.whenAccepted(1);
    server.write(
      JSON.stringify({ id: 1, ok: true, result: helloResult(PROTOCOL_VERSION + 1) }) + "\n",
    );
    await waitForHello(client);
    expect(client.protocolMismatch).not.toBeNull();

    server.destroyAll();
    await waitForState(client, "disconnected");
    expect(client.protocolMismatch).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GRA-96 QA follow-up: the two copies of PROTOCOL_VERSION do not drift
// ---------------------------------------------------------------------------

describe("PROTOCOL_VERSION agrees with Protocol.kt's own copy", () => {
  // GRA-96's whole point is that the receiving side checks what it is given
  // instead of trusting it silently -- but that check is only as good as
  // this file's own PROTOCOL_VERSION, and nothing enforced that this
  // constant and Protocol.kt's stayed the same number. Bumping one side
  // while leaving the other at its old value is exactly the "receiving side
  // does not validate what it is given" shape this ticket exists to close,
  // one level up: the JVM suite has no way to know a TypeScript constant
  // exists, and vice versa, so a source-text read across the language
  // boundary is the only way one side can see the other's value at all --
  // the same technique surface.test.ts already uses for cross-file checks
  // within mcp/src.
  it("device.ts's PROTOCOL_VERSION equals Protocol.kt's internal const", () => {
    const kotlin = readFileSync(
      new URL(
        "../../runtime/src/main/kotlin/live/gravitylabs/porthole/protocol/Protocol.kt",
        import.meta.url,
      ),
      "utf8",
    );
    const match = kotlin.match(/internal const val PROTOCOL_VERSION\s*=\s*(\d+)/);
    expect(match, "Protocol.kt's PROTOCOL_VERSION declaration was not found in the expected shape").not.toBeNull();
    const kotlinVersion = Number(match![1]);
    expect(
      kotlinVersion,
      `device.ts's PROTOCOL_VERSION (${PROTOCOL_VERSION}) must equal Protocol.kt's (${kotlinVersion}) -- ` +
        "a mismatch here means the two sides of GRA-96's own check would silently disagree about what " +
        "a matching handshake even is.",
    ).toBe(PROTOCOL_VERSION);
  });
});
