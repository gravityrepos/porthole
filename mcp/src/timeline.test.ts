// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { DeviceClient, DeviceEvent, Hello } from "./device.js";
import { findTraceProcessor } from "./perfetto.js";
import { TimelineServer } from "./timeline.js";

// The only thing in here that touches the outside world besides trace_processor
// (see the next mock). `restart` shells out to adb, and a test that
// force-stopped whatever app happens to be installed would be a worse bug
// than the one this file exists to catch. `resolveProjectRoot` is stubbed to
// a fixed answer — `process.cwd()`, the same default it would reach on its
// own — purely so every test in this file agrees on where `tracesDir()`
// (timeline.ts) looks, regardless of any PORTHOLE_PROJECT_ROOT some other
// suite left behind in this worker.
vi.mock("./adb.js", () => ({
  restartApp: vi.fn(() => ({ ok: true, output: "restarted" })),
  resolveProjectRoot: vi.fn(() => ({ directory: process.cwd(), source: "cwd" as const })),
}));

// findTraceProcessor and askTrace are stubbed so the /api/findings "trace"
// branch can actually be reached in this test environment, which has no real
// trace_processor_shell by default — without this, findTraceProcessor()
// returns null and the app-scoping note this ticket changed (GRA-157) is
// unreachable, the same gap a weaker version of this file's test for it left
// open. Everything else — parseRows, runScript, why — is the real
// implementation: `/api/traces`' coverage computation (GRA-113) calls those
// directly, and a fake binary path plus the real (spawn-based) `runScript`
// together already produce the honest "could not run" answer most of this
// file's coverage tests want, with no need to fake the parsing too.
vi.mock("./perfetto.js", async () => {
  const actual = await vi.importActual<typeof import("./perfetto.js")>("./perfetto.js");
  return {
    ...actual,
    findTraceProcessor: vi.fn(() => "/fake/trace_processor_shell"),
    askTrace: vi.fn(async () => ({ findings: [], unanswered: [] })),
  };
});

/**
 * A running timeline server, on a real port, answering real requests.
 *
 * This is the first behavioural test of `timeline.ts`, so the harness is the
 * point: everything later — the MCP surface tests, whatever the next endpoint
 * turns out to be — hangs off `start()` and `send()` below. Two deliberate
 * choices:
 *
 * The device is a fake but the server is not. `TimelineServer` only ever asks
 * its `DeviceClient` for `request`, `hello`, `state` and `port`, so a small
 * EventEmitter stands in for the socket to the app, records what was asked of
 * it, and lets a test say what comes back. Everything above it — the HTTP
 * server, the routing, the WebSocket — is the real thing on a real socket.
 *
 * Requests go out over `http.request` rather than `fetch`, because `fetch`
 * refuses to send a `Host` it did not compute (it drops the header silently),
 * and forging `Host` is half of what is under test. Where a test wants to
 * prove that an ordinary client still works, it uses `fetch` directly.
 */
class FakeDevice extends EventEmitter {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  hello: Hello | null = null;
  state = "connected";
  port = 8677;
  /** What the device answers. Throw from here to be a device that failed. */
  answer: (method: string, params: Record<string, unknown>) => unknown = () => ({ ok: true });

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    return this.answer(method, params);
  }

  /** Only the fields this server reads; the rest of `Hello` never comes up. */
  saidHello(packageName = "com.example.shop"): void {
    this.hello = { packageName, device: "Pixel 8", startedAt: 1 } as Hello;
  }
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Harness {
  port: number;
  origin: string;
  device: FakeDevice;
  server: TimelineServer;
  /** A request with exact control over the request line and every header. */
  send(
    path: string,
    options?: { method?: string; headers?: Record<string, string> },
  ): Promise<Answer>;
  stop(): void;
}

/** A port nobody holds. Bound and released, so the server can take it next. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

async function start(): Promise<Harness> {
  const device = new FakeDevice();
  const port = await freePort();
  const server = new TimelineServer(device as unknown as DeviceClient, port);
  await server.start();

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    device,
    server,
    send(path, options = {}) {
      return new Promise<Answer>((resolve, reject) => {
        const request = http.request(
          {
            host: "127.0.0.1",
            port,
            path,
            method: options.method ?? "GET",
            // Keep-alive sockets outlive the server they were opened against
            // and hold the suite open at the end of the run.
            agent: false,
            headers: { connection: "close", ...options.headers },
          },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => (body += chunk));
            response.on("end", () =>
              resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
            );
          },
        );
        request.on("error", reject);
        request.end();
      });
    },
    stop() {
      server.stop();
    },
  };
}

const event = (seq: number, name: string, data: Record<string, unknown> = {}): DeviceEvent =>
  ({ t: seq, seq, event: name, data }) as DeviceEvent;

let timeline: Harness;

beforeEach(async () => {
  timeline = await start();
});

afterEach(() => {
  timeline.stop();
});

describe("who the server answers", () => {
  it("answers an ordinary request from its own address", async () => {
    const response = await fetch(`${timeline.origin}/api/health`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { name: string }).name).toBe("porthole-timeline");
  });

  it("counts localhost and 127.0.0.1 as the same here", async () => {
    for (const host of [`127.0.0.1:${timeline.port}`, `localhost:${timeline.port}`]) {
      expect((await timeline.send("/api/health", { headers: { host } })).status).toBe(200);
    }
  });

  it("counts the IPv6 loopback literal too", async () => {
    // The socket is bound to 127.0.0.1, so `[::1]` cannot actually arrive on
    // it today — but it names this same machine, and refusing it would be a
    // rule about the spelling rather than about where the request came from.
    const response = await timeline.send("/api/health", {
      headers: { host: `[::1]:${timeline.port}` },
    });
    expect(response.status).toBe(200);
  });

  it("refuses a Host that is a name on the internet", async () => {
    // The rebinding case: evil.example.com resolves to 127.0.0.1, the browser
    // treats it as the attacker's own origin, and the request lands here.
    const response = await timeline.send("/api/events", {
      headers: { host: "evil.example.com" },
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("Refused");
  });

  it("refuses a Host that merely starts with the loopback address", async () => {
    const response = await timeline.send("/api/health", {
      headers: { host: `127.0.0.1.evil.com:${timeline.port}` },
    });
    expect(response.status).toBe(403);
  });

  it("refuses a Host on the wrong port", async () => {
    const response = await timeline.send("/api/health", {
      headers: { host: `127.0.0.1:${timeline.port + 1}` },
    });
    expect(response.status).toBe(403);
  });

  it("refuses a Host with no port at all", async () => {
    const response = await timeline.send("/api/health", { headers: { host: "127.0.0.1" } });
    expect(response.status).toBe(403);
  });

  it("refuses a foreign Origin", async () => {
    const response = await timeline.send("/api/events", {
      headers: { origin: "https://evil.example.com" },
    });
    expect(response.status).toBe(403);
  });

  it("refuses an opaque Origin", async () => {
    // `null` is what a sandboxed iframe or a file:// page sends. It is never us.
    const response = await timeline.send("/api/health", { headers: { origin: "null" } });
    expect(response.status).toBe(403);
  });

  it("refuses our own address over https, which we do not speak", async () => {
    const response = await timeline.send("/api/health", {
      headers: { origin: `https://127.0.0.1:${timeline.port}` },
    });
    expect(response.status).toBe(403);
  });

  it("allows its own Origin, as a same-origin POST carries", async () => {
    const response = await timeline.send("/api/health", {
      headers: { origin: `http://127.0.0.1:${timeline.port}` },
    });
    expect(response.status).toBe(200);
  });

  it("believes the browser when it says the request came from elsewhere", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const response = await timeline.send("/api/health", { headers: { "sec-fetch-site": site } });
      expect(response.status, site).toBe(403);
    }
  });

  it("allows the two verdicts that mean us, and the absence of any", async () => {
    for (const site of ["same-origin", "none"]) {
      const response = await timeline.send("/api/health", { headers: { "sec-fetch-site": site } });
      expect(response.status, site).toBe(200);
    }
    // No header at all is curl, an older browser, and our own port probe.
    expect((await timeline.send("/api/health")).status).toBe(200);
  });

  it("allows the Vite dev proxy, which forwards the browser's own :5273", async () => {
    // `npm run dev` in mcp/ui proxies /api here without rewriting either
    // header, so this is exactly what a hot-reloading UI looks like.
    const response = await timeline.send("/api/health", {
      headers: {
        host: "localhost:5273",
        origin: "http://localhost:5273",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(response.status).toBe(200);
  });

  it("refuses an Origin the request was not also addressed to", async () => {
    // The dev port is allowed, which for a while meant allowed on its own:
    // a page served from :5273 could address this server directly and have
    // its `Origin` pass, because both spellings were in one flat list. The
    // two halves have to agree — a caller may only claim an origin it also
    // claims to have been addressed to — and here they do not.
    const response = await timeline.send("/api/events", {
      headers: { host: `127.0.0.1:${timeline.port}`, origin: "http://localhost:5273" },
    });
    expect(response.status).toBe(403);
  });

  it("refuses the mirror image, addressed to the dev port from ours", async () => {
    const response = await timeline.send("/api/events", {
      headers: { host: "localhost:5273", origin: `http://127.0.0.1:${timeline.port}` },
    });
    expect(response.status).toBe(403);
  });

  it("refuses two loopback spellings of this same server as disagreement", async () => {
    // `localhost` and `127.0.0.1` are the same machine, and the first test in
    // this file says so about `Host`. They are still different origins to a
    // browser, which will never send this pair; only something hand-rolling
    // headers can, and it gets no benefit of the doubt.
    const response = await timeline.send("/api/events", {
      headers: { host: `127.0.0.1:${timeline.port}`, origin: `http://localhost:${timeline.port}` },
    });
    expect(response.status).toBe(403);
  });

  it("explains itself in one line and quotes nothing back", async () => {
    const response = await timeline.send("/api/health", {
      headers: { host: "evil.example.com", origin: "https://attacker.example/secret-path" },
    });
    expect(response.status).toBe(403);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body.trim().split("\n")).toHaveLength(1);
    // A 403 that echoed the request would be one more place a captured value
    // comes back out.
    expect(response.body).not.toContain("evil.example.com");
    expect(response.body).not.toContain("attacker.example");
  });

  it("refuses before it routes, so a refused caller learns nothing", async () => {
    timeline.device.emit("event", event(1, "http", { url: "https://api.example.com/cart" }));
    const response = await timeline.send("/api/events", { headers: { host: "evil.example.com" } });
    expect(response.status).toBe(403);
    expect(response.body).not.toContain("api.example.com");
    expect(timeline.device.calls).toHaveLength(0);
  });

  it("refuses the endpoint that takes a trace id before even that gets validated", async () => {
    const response = await timeline.send("/api/findings?trace=C:/Windows/win.ini", {
      headers: { host: "evil.example.com" },
    });
    // The origin gate runs first regardless of what the id validation below
    // would have said about this value — a foreign caller learns nothing
    // about which id shapes this endpoint accepts.
    expect(response.status).toBe(403);
  });

  it("refuses the static UI to a foreign Host as well", async () => {
    // Not because index.html is a secret, but because a gate with a hole in it
    // invites the next endpoint to be added on the wrong side of it.
    const response = await timeline.send("/", { headers: { host: "evil.example.com" } });
    expect(response.status).toBe(403);
  });
});

describe("the database endpoints", () => {
  it("routes the three calls the inspector makes", async () => {
    timeline.device.answer = () => ({ rows: [] });
    await timeline.send("/api/db/tables");
    await timeline.send("/api/db/rows?table=cart_items&limit=10");
    await timeline.send("/api/db/query?sql=SELECT%201");
    expect(timeline.device.calls.map((call) => call.method)).toEqual([
      "db_tables",
      "db_rows",
      "db_query",
    ]);
    expect(timeline.device.calls[2].params.sql).toBe("SELECT 1");
  });

  it("404s an unknown path instead of running it as SQL", async () => {
    const response = await timeline.send("/api/db/nonsense?sql=SELECT%20*%20FROM%20users");
    expect(response.status).toBe(404);
    expect(timeline.device.calls).toHaveLength(0);
  });

  it("404s the bare prefix", async () => {
    const response = await timeline.send("/api/db/?sql=SELECT%201");
    expect(response.status).toBe(404);
    expect(timeline.device.calls).toHaveLength(0);
  });

  it("404s a path that dots its way back to a real one", async () => {
    // Sent unnormalised, which is what a client that means it would do.
    const response = await timeline.send("/api/db/rows/../query?sql=SELECT%201");
    expect(response.status).toBe(404);
    expect(timeline.device.calls).toHaveLength(0);
  });

  it("reports a device that cannot answer as unavailable", async () => {
    timeline.device.answer = () => {
      throw new Error("device disconnected");
    };
    const response = await timeline.send("/api/db/tables");
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error).toContain("disconnected");
  });
});

describe("the tool endpoints", () => {
  it("refuses every method but POST", async () => {
    timeline.device.saidHello();
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await timeline.send("/api/tools/restart", { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.allow, method).toBe("POST");
    }
  });

  it("restarts on POST", async () => {
    timeline.device.saidHello();
    const response = await timeline.send("/api/tools/restart", { method: "POST" });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).ok).toBe(true);
  });

  it("says so when there is no app to restart", async () => {
    const response = await timeline.send("/api/tools/restart", { method: "POST" });
    expect(response.status).toBe(409);
  });

  it("404s a tool it does not have rather than serving the UI", async () => {
    const response = await timeline.send("/api/tools/nonsense", { method: "POST" });
    expect(response.status).toBe(404);
  });
});

describe("GRA-157: the three sites that used to read hello without checking state", () => {
  // FakeDevice (this file's own stub, not the real DeviceClient) does not
  // enforce the "connected implies hello" invariant itself — nothing stops
  // a test from setting state = "connected" here with hello still null. That
  // is deliberate: it lets these tests drive "handshaking" directly instead
  // of racing a real handshake, the same way device.ts's own tests use a
  // raw server. The real DeviceClient's invariant is covered in
  // device.test.ts.

  // GRA-113: `trace=` is now an id resolved against the traces directory,
  // not an arbitrary path — the two tests below that scope a request to a
  // trace need one that actually resolves, or they would see this ticket's
  // own 400 before ever reaching the handshake/attachment branch they exist
  // to pin. `askTrace` is mocked (see this file's top), so nothing ever
  // reads this file's contents; it only has to exist.
  const tracesDir = resolve(process.cwd(), ".porthole", "traces");
  const traceFile = resolve(tracesDir, "gra157-fixture.pftrace");

  beforeEach(async () => {
    await mkdir(tracesDir, { recursive: true });
    await writeFile(traceFile, "");
  });

  afterEach(async () => {
    await rm(traceFile, { force: true });
  });

  it("/api/health reports connected: false with app/device null while handshaking, not the old self-contradicting combo", async () => {
    timeline.device.state = "handshaking";
    const response = await timeline.send("/api/health");
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { connected: boolean; app: unknown; device: unknown };
    // Pre-GRA-157 this endpoint reported connected: true here (state was
    // "connected" the instant the socket connected), with app and device
    // both null — a combination this ticket's own table names as the bug.
    expect(body).toMatchObject({ connected: false, app: null, device: null });
  });

  it("/api/health reports connected: true with app/device set once hello has actually landed", async () => {
    timeline.device.state = "connected";
    timeline.device.saidHello("com.example.shop");
    const response = await timeline.send("/api/health");
    const body = JSON.parse(response.body) as { connected: boolean; app: unknown; device: unknown };
    expect(body).toMatchObject({ connected: true, app: "com.example.shop", device: "Pixel 8" });
  });

  it("/api/tools/restart names the handshake instead of a generic 'has not said hello yet' while one is in progress", async () => {
    timeline.device.state = "handshaking";
    const response = await timeline.send("/api/tools/restart", { method: "POST" });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).output).toContain("Still waiting on the app's first check-in");
  });

  it("/api/tools/restart keeps the generic message when there is no handshake in progress at all", async () => {
    timeline.device.state = "disconnected";
    const response = await timeline.send("/api/tools/restart", { method: "POST" });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).output).toBe("The app has not said hello yet.");
  });

  it("/api/findings' trace-scoping note says 'still waiting' while handshaking, not 'not attached'", async () => {
    timeline.device.state = "handshaking";
    const response = await timeline.send("/api/findings?trace=gra157-fixture");
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { notes: string[] };
    expect(body.notes.join(" ")).toContain("Still waiting on the app's first check-in");
    expect(body.notes.join(" ")).not.toContain("Not attached to an app");
  });

  it("/api/findings' trace-scoping note says 'not attached' when there is no handshake in progress at all", async () => {
    timeline.device.state = "disconnected";
    const response = await timeline.send("/api/findings?trace=gra157-fixture");
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { notes: string[] };
    expect(body.notes.join(" ")).toContain("Not attached to an app");
  });
});

describe("GRA-163: the ring's session boundary", () => {
  // The ring (`TimelineServer.buffer()`) is the thing GRA-163 is about: it
  // is cleared on one specific signal and must be left alone by everything
  // else. These two tests pin both halves directly against TimelineServer,
  // without going through DeviceClient's real socket at all — the
  // constructor's hello handler is the only place the clear happens (see
  // timeline.ts), so this is the cheapest place to prove it does, and does
  // not, fire.
  it("a new hello with a different startedAt clears the ring; a repeated one does not", () => {
    // Establishes this session's origin first, the same as production:
    // `startedAt` is undefined until the very first hello, so that first
    // hello also "clears" an already-empty ring — a no-op, but establishes
    // the baseline the rest of this test is against.
    timeline.device.emit("hello", { startedAt: 1, packageName: "com.example.shop" });
    timeline.device.emit("event", event(1, "recompose"));
    timeline.device.emit("event", event(2, "recompose"));
    expect(timeline.server.buffer()).toHaveLength(2);

    // The same process saying hello again (a duplicate, e.g. over a flaky
    // link) must not discard what has already been collected — only a
    // startedAt that actually differs means a new process.
    timeline.device.emit("hello", { startedAt: 1, packageName: "com.example.shop" });
    expect(timeline.server.buffer()).toHaveLength(2);

    // A genuinely new process: sequence numbers restart with it, so keeping
    // the old events would put two timelines on one axis, and make the new
    // process's first events look like ones already seen.
    timeline.device.emit("hello", { startedAt: 2, packageName: "com.example.shop" });
    expect(timeline.server.buffer()).toHaveLength(0);
  });

  it("the ring is not cleared by a close — only by a new hello — so it still holds what an exited process produced", () => {
    timeline.device.emit("hello", { startedAt: 1, packageName: "com.example.shop" });
    timeline.device.emit("event", event(1, "recompose"));
    expect(timeline.server.buffer()).toHaveLength(1);

    // GRA-163: this is the other half of the session boundary a hello
    // already had. A real close fires DeviceClient's "state" event with
    // "disconnected" — exactly this — and TimelineServer has only ever
    // listened for "event"/"state"/"hello" (see its constructor). The
    // buffer must still hold what the exited process produced afterward:
    // the post-mortem case, "what happened before it died", is exactly
    // when someone needs those events most. (Whose data it is once it is
    // read back is device.ts's `lastExited` and index.ts's
    // `exitedProcessField()` — this test only pins that the ring itself
    // survives.)
    timeline.device.emit("state", "disconnected");
    expect(timeline.server.buffer()).toHaveLength(1);
  });
});

describe("the static files", () => {
  const uiDir = fileURLToPath(new URL("../ui/dist/", import.meta.url));
  const sibling = fileURLToPath(new URL("../ui/dist-sibling-fixture/", import.meta.url));

  beforeEach(async () => {
    await mkdir(sibling, { recursive: true });
    await writeFile(`${sibling}note.txt`, "SECRET-SIBLING");
  });

  afterEach(async () => {
    await rm(sibling, { recursive: true, force: true });
  });

  /** True whatever the response is: the file must not come out of this server. */
  const withheld = (answer: Answer) => expect(answer.body).not.toContain("SECRET-SIBLING");

  it("does not serve a sibling directory whose name starts with the UI's", async () => {
    // `resolve` strips the trailing separator, so a plain prefix test said
    // `.../ui/dist-sibling-fixture/note.txt` starts with `.../ui/dist` and
    // served it. The fix is one `+ sep`; this is the test that fails without it.
    expect(sibling.startsWith(uiDir.slice(0, -1))).toBe(true);
    withheld(await timeline.send("/../dist-sibling-fixture/note.txt"));
  });

  it("does not climb out of the UI directory", async () => {
    withheld(await timeline.send("/../../../../../../etc/passwd"));
  });
});

describe("the websocket", () => {
  /** Resolves to the first message, or to the handshake's refusal. */
  function connect(
    port: number,
    options: { path?: string; headers?: Record<string, string> } = {},
  ): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? "/ws"}`, {
        headers: options.headers,
      });
      socket.on("message", (data: Buffer) => {
        socket.close();
        resolve({ ok: true, message: data.toString() });
      });
      socket.on("error", (error: Error) => resolve({ ok: false, error: error.message }));
    });
  }

  it("hands a connected client the buffer it has", async () => {
    timeline.device.emit("event", event(1, "frame", { durationMs: 8 }));
    const result = await connect(timeline.port);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.message).type).toBe("init");
  });

  it("refuses an upgrade from a foreign Origin", async () => {
    // The upgrade is a separate handler on the same server, and it answers
    // with the whole event buffer. An ungated one would reopen everything the
    // HTTP gate just closed — and a page can open a WebSocket cross-origin
    // with no preflight at all.
    const result = await connect(timeline.port, {
      headers: { origin: "https://evil.example.com" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("403");
  });

  it("refuses an upgrade addressed to a foreign Host", async () => {
    const result = await connect(timeline.port, { headers: { host: "evil.example.com" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("403");
  });

  it("refuses an upgrade from a page on the dev port, addressed to us", async () => {
    // The one that got through. A page served from http://localhost:5273 —
    // and the Vite dev server is not the only thing that can hold that port —
    // opening `ws://127.0.0.1:<ours>/ws` produces exactly this pair: our own
    // `Host`, its allowed `Origin`, and, because it is an upgrade, no
    // `Sec-Fetch-*` header of any kind. Chrome 152 sends none on a handshake,
    // so the third check never runs and the `Origin` check was the only one
    // left; with the dev port in a flat allowlist it passed, and the socket
    // replied with the whole event buffer. Note the headers below: no
    // sec-fetch-site, deliberately, because that is what the browser does.
    timeline.device.emit("event", event(1, "http", { header: "CANARY-SECRET" }));
    const result = await connect(timeline.port, {
      headers: { origin: "http://localhost:5273" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("403");
    if (result.ok) expect(result.message).not.toContain("CANARY-SECRET");
  });

  it("allows an upgrade through the Vite dev proxy, where both halves say :5273", async () => {
    // The capability the allowance exists for, on the path that carries the
    // data. `npm run dev` forwards `Host` and `Origin` untouched for /ws as
    // well as /api, so this is what hot reload actually looks like on the
    // wire, and refusing it would take the live timeline away from the dev UI.
    const result = await connect(timeline.port, {
      headers: { host: "localhost:5273", origin: "http://localhost:5273" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.message).type).toBe("init");
  });

  it("allows an upgrade where Host and Origin are both this server", async () => {
    // The direct UI, served by this process on its own port.
    const result = await connect(timeline.port, {
      headers: { origin: `http://127.0.0.1:${timeline.port}` },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.message).type).toBe("init");
  });

  it("has nothing to say on any other path", async () => {
    const result = await connect(timeline.port, { path: "/nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("404");
  });
});
