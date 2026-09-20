// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import net, { type AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DeviceClient, type ConnectionState, type DeviceEvent, type Hello } from "../device.js";
import { TimelineServer } from "../timeline.js";
import { createPortholeServer } from "../index.js";

/**
 * A harness for testing the MCP surface behaviourally instead of grepping
 * `index.ts` as text.
 *
 * `surface.test.ts` used to read `index.ts` as a string and check that
 * certain substrings appeared, because there was no way to register the real
 * tools and call one. That proved a tool's *description* said the right
 * thing; it never proved the tool's *handler* did. Two pieces make the
 * handler reachable:
 *
 *  - `connect(server)` puts a real MCP `Client` on one end of a linked
 *    in-memory transport and the server under test on the other, so calling
 *    a tool goes through the SDK's own request validation and response
 *    envelope — the same path a real agent's call takes — without stdio or a
 *    subprocess.
 *  - `FakeDevice` is a real `net.Server` that speaks the same newline-JSON
 *    wire protocol the Kotlin runtime speaks (`{id,ok,result}` responses,
 *    `{event,t,seq,data}` events — see `protocol/Protocol.kt` and
 *    `device.ts`), so the real `DeviceClient` can connect to it. Tests never
 *    construct a `DeviceEvent` or a device response by hand and hope it
 *    matches what `device.ts` expects to parse; they go over the same
 *    newline-delimited socket `device.ts` parses in production.
 *
 * `buildRig()` wires the two together with the real `createPortholeServer`
 * and the real `TimelineServer`, so a test that wants to call a tool and read
 * its output is four lines:
 *
 *   const rig = await buildRig();
 *   await rig.pushEvents([{ event: "recompose", t: 1000, data: { name: "Cart" } }]);
 *   const result = await rig.client.callTool("timeline", {});
 *   expect(result.isError).toBeFalsy();
 */

// ---------------------------------------------------------------------------
// calling a tool through a real MCP client
// ---------------------------------------------------------------------------

export interface ToolContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolCallResult {
  content: ToolContent[];
  isError?: boolean;
  /** The first text block, unwrapped — every tool here returns exactly one. */
  text: string;
  /** The JSON half of `ok()`'s second `content` block, parsed back out. */
  json: unknown;
}

export interface TestClient {
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  /** The tools the server actually registered, with their JSON input schemas. */
  listTools(): Promise<Array<{ name: string; inputSchema: Record<string, unknown> }>>;
  close(): Promise<void>;
}

/**
 * GRA-171: reads the payload out of the *second* text block in `content`,
 * not by searching the first block's text for a delimiter. `ok()` now
 * returns two separate `content` entries — summary, then payload (see
 * `joinSummaryAndPayload()` in `index.ts`) — and `fail()` returns exactly
 * one, so "is there a second text block at all" is what used to be "did the
 * text contain a blank line", with no string scanning either way. Undefined
 * if the tool errored (no second block) or the second block isn't valid
 * JSON.
 */
function parsePayload(content: ToolContent[]): unknown {
  const textBlocks = content.filter((c) => c.type === "text");
  if (textBlocks.length < 2) return undefined;
  try {
    return JSON.parse(textBlocks[1].text ?? "");
  } catch {
    return undefined;
  }
}

/**
 * Connects a real MCP `Client` to `server` over a linked in-memory transport
 * pair. No stdio, no subprocess, no network socket — but the same
 * request/response machinery a real agent's call goes through, including the
 * zod input validation on the way in.
 */
export async function connect(server: McpServer): Promise<TestClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "porthole-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    async callTool(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content ?? []) as ToolContent[];
      // The summary is always the FIRST text block, by position — not "the
      // first text block found" scanning for a marker inside it. GRA-171:
      // there is no longer a single string to split, so `text` is exactly
      // `content[0]`'s text, whatever it contains (see `parsePayload` above
      // for the payload half).
      const text = content.find((c) => c.type === "text")?.text ?? "";
      return {
        content,
        isError: result.isError as boolean | undefined,
        text,
        json: parsePayload(content),
      };
    },
    async listTools() {
      const result = await client.listTools();
      return result.tools.map((t) => ({
        name: t.name,
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      }));
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// a fake device that speaks the real wire protocol
// ---------------------------------------------------------------------------

export type FakeDeviceHandler = (
  params: Record<string, unknown>,
) => unknown | Promise<unknown>;

export type FakeDeviceHandlers = Record<string, FakeDeviceHandler>;

interface WireRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * A loopback TCP server that speaks exactly the protocol
 * `PortholeSocketServer.kt` speaks: newline-delimited JSON, one object per
 * line, `{id,method,params}` in, `{id,ok,result}` or `{id,ok:false,error}`
 * out, and `{event,t,seq,data}` pushed unprompted.
 *
 * Deliberately not a hand-rolled object implementing `DeviceClient`'s
 * interface — this project's recurring lesson is that a self-written fixture
 * tests the format the author assumed, not the one that arrives. Going
 * through a real socket means the real `DeviceClient` does its own framing,
 * its own JSON parsing and its own request/response correlation against
 * this, exactly as it does against the Kotlin runtime.
 */
export class FakeDevice {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly handlers: FakeDeviceHandlers;
  private seq = 0;

  private constructor(server: net.Server, handlers: FakeDeviceHandlers) {
    this.server = server;
    this.handlers = handlers;
  }

  static async start(handlers: FakeDeviceHandlers = {}): Promise<FakeDevice> {
    const server = net.createServer();
    const fake = new FakeDevice(server, { ...defaultHandlers(), ...handlers });
    server.on("connection", (socket) => fake.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    return fake;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** Installs or replaces a method handler after the server has started. */
  on(method: string, handler: FakeDeviceHandler): void {
    this.handlers[method] = handler;
  }

  /** Pushes an event frame to every connected client, in the real wire shape. */
  emit(event: string, t: number, data: Record<string, unknown> = {}): void {
    this.broadcast({ event, t, seq: this.seq++, data });
  }

  /** Closes every open connection without a goodbye, the way a killed app would. */
  disconnectAll(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private serve(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) void this.onLine(socket, line);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
  }

  private async onLine(socket: net.Socket, line: string): Promise<void> {
    let request: WireRequest;
    try {
      request = JSON.parse(line);
    } catch {
      // The real device answers a malformed request with an error frame
      // carrying id -1 (see PortholeSocketServer.respond) rather than
      // dropping the connection.
      this.send(socket, { id: -1, ok: false, error: "malformed request" });
      return;
    }

    const handler = this.handlers[request.method];
    if (!handler) {
      this.send(socket, {
        id: request.id,
        ok: false,
        error: `unknown method ${request.method}. known: ${Object.keys(this.handlers).join(", ")}`,
      });
      return;
    }

    try {
      const result = await handler(request.params ?? {});
      this.send(socket, { id: request.id, ok: true, result });
    } catch (error) {
      this.send(socket, {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private send(socket: net.Socket, frame: unknown): void {
    socket.write(JSON.stringify(frame) + "\n");
  }

  private broadcast(frame: unknown): void {
    const line = JSON.stringify(frame) + "\n";
    for (const socket of this.sockets) socket.write(line);
  }
}

/** Every device response `t`/`sinceMs`/`from`/`to` the tool called with — a test-only field so a caller can prove which window a method was asked about. */
function askedWindow(params: Record<string, unknown>): Record<string, unknown> {
  return { sinceMs: params.sinceMs, from: params.from, to: params.to };
}

/**
 * `startedAt` a first-ever hello reports by default, in the same units the
 * real runtime uses (`SystemClock.uptimeMillis()`): milliseconds since boot,
 * not since epoch, so a modest five-digit number is realistic here, not a
 * sentinel.
 *
 * GRA-170: this used to be a bare `0`, returned identically by every call to
 * the same handler. Ring-clearing on a new session (`timeline.ts`) is decided
 * by comparing the incoming hello's `startedAt` against the previous one, so
 * a rig "reconnect" that never overrode `hello` could not help but present
 * the *same* startedAt both times — the comparison always took its "same
 * session, carry forward" branch, and no test that merely reconnected without
 * special setup could ever land on the other one. See
 * `buildRig`/`defaultHandlers` below for the fix: the default now advances on
 * every call, so an *unmodified* reconnect clears the ring, and carrying the
 * ring forward (the same process reconnecting after a transient drop) is the
 * deliberate case — a test wanting that must hold `startedAt` fixed across
 * calls itself, the way GRA-163's disconnect/close tests already do.
 */
export const DEFAULT_STARTED_AT_MS = 47_213;

/**
 * Handlers matching the shape `device.ts`/`index.ts` expect for every method
 * the MCP tools call, from `protocol/Protocol.kt`. Empty and quiet by
 * default; a test overrides only the method it cares about.
 */
function defaultHandlers(): FakeDeviceHandlers {
  // Counts calls to *this* hello handler specifically. A test that replaces
  // `hello` via `rig.fakeDevice.on("hello", ...)` gets its own closure and
  // this counter never runs for it; a test that leaves the default alone
  // sees startedAt advance by a full minute on every call, i.e. every
  // reconnect through the unmodified default reads as a new process.
  let helloCalls = 0;
  return {
    hello: (): Hello => ({
      protocol: 1,
      packageName: "com.example.shop",
      processName: "com.example.shop",
      versionName: "1.0.0-test",
      device: "Test Device",
      sdkInt: 34,
      startedAt: DEFAULT_STARTED_AT_MS + helloCalls++ * 60_000,
      collectors: [
        "recompositions",
        "semantics_tree",
        "state",
        "inflight",
        "logs",
        "nav_state",
        "frames",
        "main_thread",
        "memory",
      ],
    }),
    timeline: () => ({ events: [], droppedBefore: 0, now: Date.now() }),
    recompositions: (params) => ({
      nodes: [],
      totalNodes: 0,
      truncated: false,
      unattributedWrites: [],
      notes: [],
      askedWindow: askedWindow(params),
    }),
    frames: (params) => ({
      totalFrames: 0,
      jankyFrames: 0,
      droppedBySystem: 0,
      frameIntervalMs: 8,
      worst: [],
      notes: [],
      askedWindow: askedWindow(params),
    }),
    blocking: (params) => ({
      stalls: [],
      mainThreadQueries: [],
      mainThreadHttp: [],
      stallThresholdMs: 700,
      notes: [],
      askedWindow: askedWindow(params),
    }),
    logs: (params) => ({
      entries: [],
      capturing: true,
      evicted: 0,
      notes: [],
      askedWindow: askedWindow(params),
    }),
    // GRA-66: recentHttp is now windowed, so `inflight` joined the four
    // above that delegate their window straight to the device — same
    // askedWindow echo, same reason.
    inflight: (params) => ({
      capturedAt: 0,
      http: [],
      queries: [],
      work: [],
      recentHttp: [],
      notes: [],
      askedWindow: askedWindow(params),
    }),
    nav_state: () => ({
      capturedAt: 0,
      graph: null,
      current: null,
      backStack: [],
      deepLink: null,
    }),
    state: () => ({ capturedAt: 0, owners: [] }),
    semantics_tree: () => ({ capturedAt: 0, merged: true, root: null }),
    setup: () => ({ entries: [] }),
  };
}

// ---------------------------------------------------------------------------
// waiting
// ---------------------------------------------------------------------------

/**
 * Polls `predicate` until it is true. Everything here is async over a real
 * socket.
 *
 * GRA-183: every prior timeout here read as a bare "waitUntil timed out
 * after 10000ms" with a stack frame pointing at this function, not at the
 * call site that actually hung — the useful line (which condition, in which
 * test) had to be found by re-reading the surrounding source by hand every
 * time. `description` closes that gap two ways: pass a string for a
 * human-written reason ("device2 hello landed"), or omit it and this falls
 * back to `predicate.toString()` — the arrow function's own source text,
 * which vitest's esbuild transform leaves readable (original identifiers,
 * no minification) even though the *values* those identifiers held are
 * long gone by the time the error is thrown. Either way the timeout names
 * the condition instead of making a reader reconstruct it.
 */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
  description?: string,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      const what = description ?? predicate.toString();
      throw new Error(`waitUntil timed out after ${timeoutMs}ms waiting for: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// the rig
// ---------------------------------------------------------------------------

export interface Rig {
  fakeDevice: FakeDevice;
  device: DeviceClient;
  timeline: TimelineServer;
  server: McpServer;
  client: TestClient;
  /**
   * Emits each event over the fake device's socket and waits for the real
   * `TimelineServer` (listening on `device`'s "event" emissions, exactly as
   * it does in production) to have buffered all of them. Events arrive over
   * a real socket, so this is genuinely asynchronous.
   */
  pushEvents(events: Array<{ event: string; t: number; data?: Record<string, unknown> }>): Promise<void>;
  close(): Promise<void>;
}

export interface BuildRigOptions {
  handlers?: FakeDeviceHandlers;
  /** Skip waiting for the fake device's `hello` to land — for testing the disconnected state. */
  connectDevice?: boolean;
  /** Forwarded to `createPortholeServer` — see `PortholeServerOptions.adbEnv` in index.ts (GRA-89). */
  adbEnv?: NodeJS.ProcessEnv;
  /** Forwarded to `createPortholeServer` — see `PortholeServerOptions.adbBinary` in index.ts (GRA-89). */
  adbBinary?: string;
  /**
   * GRA-197: what the fake `DeviceClient` was "configured for" —
   * `PORTHOLE_APPLICATION_ID` in production, threaded straight to
   * `DeviceClient`'s constructor here rather than through `process.env`, so
   * a test asking for a mismatch cannot leak that env var into any other
   * test running in the same process. Omitted means unset, the same as a
   * real server started with no PORTHOLE_APPLICATION_ID.
   */
  applicationId?: string;
}

/**
 * Assembles a fake device, a real `DeviceClient` pointed at it, a real
 * `TimelineServer`, the real `createPortholeServer`, and an MCP client
 * connected to it — everything a test needs to call a tool and read what
 * came back.
 */
export async function buildRig(options: BuildRigOptions = {}): Promise<Rig> {
  const fakeDevice = await FakeDevice.start(options.handlers);
  const device = new DeviceClient("127.0.0.1", fakeDevice.port, undefined, options.applicationId);
  const timeline = new TimelineServer(device, 0);
  const { server } = createPortholeServer({
    device,
    timeline,
    version: "0.0.0-test",
    adbEnv: options.adbEnv,
    adbBinary: options.adbBinary,
  });

  if (options.connectDevice ?? true) {
    device.start();
    await waitUntil(() => device.hello !== null, 5_000);
  }

  const client = await connect(server);

  return {
    fakeDevice,
    device,
    timeline,
    server,
    client,
    async pushEvents(events) {
      const target = timeline.buffer().length + events.length;
      for (const event of events) fakeDevice.emit(event.event, event.t, event.data ?? {});
      await waitUntil(() => timeline.buffer().length >= target);
    },
    async close() {
      await client.close();
      device.stop();
      timeline.stop();
      await fakeDevice.close();
    },
  };
}

/**
 * GRA-163: builds a rig whose ring already holds events, then leaves
 * `device` sitting in `state`. This is the fixture GRA-157's own handshake
 * block never had: every test there built an empty ring by construction —
 * `buildRaceRig()` in index.test.ts never pushes anything before calling a
 * tool — which is exactly the one input where a stale, still-buffered ring
 * left behind by an exited process cannot appear at all. Nine commits and
 * three QA rounds were defended against that one input.
 *
 * The recipe is the same for every state past "connected": connect for
 * real, get a hello, push events so the ring is non-empty, then force a
 * real disconnect. The ring survives it untouched — nothing but a new
 * `hello` ever clears it (see timeline.ts) — which is the whole point:
 * `device.lastExited` gets set (device.ts's close handler) while the ring
 * still holds what that now-exited process produced, the exact combination
 * GRA-163 is about.
 *
 * "connecting" and "handshaking" are driven by an explicit stop()/start()
 * rather than by waiting on DeviceClient's own automatic reconnect timer —
 * both faster (no RECONNECT_MIN_MS delay) and, for "connecting", actually
 * deterministic: start() re-enters connect() synchronously, and
 * connect() sets "connecting" before the asynchronous TCP handshake even
 * begins (see device.ts), so checking state immediately after start()
 * returns, with no `await` in between, cannot race a loopback connect that
 * resolves in well under a millisecond. "handshaking" still needs a
 * `waitUntil` — reaching it depends on a real socket "connect" event — but
 * holding the reconnect's own hello open (the same trick `buildRaceRig` in
 * index.test.ts uses for the very first connection) means it cannot then
 * race past that state into "connected" on its own.
 */
export async function buildRingInState(
  state: ConnectionState,
  events: Array<{ event: string; t: number; data?: Record<string, unknown> }> = [
    { event: "recompose", t: 1_000, data: { name: "Cart" } },
  ],
): Promise<Rig> {
  const rig = await buildRig();
  await rig.pushEvents(events);
  if (state === "connected") return rig;

  // Every other state needs a real disconnect first: the far end drops the
  // socket without a goodbye, the same as a killed app.
  rig.fakeDevice.disconnectAll();
  await waitUntil(() => rig.device.state === "disconnected");
  // Cancels the reconnect DeviceClient just scheduled for itself, so state
  // does not keep moving while a test built for "disconnected" is still
  // making assertions.
  rig.device.stop();
  if (state === "disconnected") return rig;

  if (state === "connecting") {
    // GRA-170 note: before that ticket, the default hello handler returned
    // the same literal startedAt on every call, so even if this reconnect
    // finished in the background before a caller got around to asserting
    // anything, the new hello would always compare equal to the old one and
    // the "clear" branch could never fire. The default now advances on
    // every call (see DEFAULT_STARTED_AT_MS above), so a reconnect that
    // actually completes here WOULD clear the ring once its hello lands.
    // This is safe only because every caller returns to a synchronous
    // assertion immediately -- no `await` between this function returning
    // and the check (see AC4 in index.test.ts) -- so the loopback connect
    // cannot resolve in between. An `await` inserted there, or any
    // asynchronous work before the assertion, could race this ring away.
    rig.device.start();
    if ((rig.device.state as ConnectionState) !== "connecting") {
      throw new Error(
        `buildRingInState: expected 'connecting' immediately after start(), got '${rig.device.state}'`,
      );
    }
    return rig;
  }

  if (state === "handshaking") {
    rig.fakeDevice.on("hello", () => new Promise(() => {}));
    rig.device.start();
    await waitUntil(() => rig.device.state === "handshaking", 5_000);
    return rig;
  }

  throw new Error(`buildRingInState: unhandled state '${state}'`);
}

export type { DeviceEvent };
