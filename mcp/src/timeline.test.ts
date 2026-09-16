// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { DeviceClient, DeviceEvent, Hello } from "./device.js";
import { askTrace, findTraceProcessor, QUESTIONS, runScript } from "./perfetto.js";
import { TimelineServer } from "./timeline.js";
import { readTrace } from "./args.js";

// Where GRA-113's `tracesDir()` (timeline.ts, via `resolveProjectRoot()`)
// looks for this file's whole run — a throwaway temp directory, never the
// real project root. `.porthole/traces/` is also where a developer's own
// real captures live; this file's /api/traces tests `rm(tracesDir, {
// recursive: true })` between tests, and pointing that at the real one the
// first version of this file did cost a real capture mid-session while
// writing this ticket. Set as a plain top-level statement (not inside
// vi.mock's hoisted factory, which cannot see a `const` declared later in
// the file) — resolveProjectRoot() itself is left real (see the adb.js mock
// below) and reads this on every call.
const PROJECT_ROOT = mkdtempSync(resolve(tmpdir(), "porthole-timeline-test-"));
process.env.PORTHOLE_PROJECT_ROOT = PROJECT_ROOT;

afterAll(async () => {
  await rm(PROJECT_ROOT, { recursive: true, force: true });
});

// The only thing in here that touches the outside world besides trace_processor
// (see the next mock). `restart` shells out to adb, and a test that
// force-stopped whatever app happens to be installed would be a worse bug
// than the one this file exists to catch. `resolveProjectRoot` itself stays
// real — it reads PORTHOLE_PROJECT_ROOT above, which is what actually pins
// `tracesDir()` to the throwaway directory.
vi.mock("./adb.js", async () => {
  const actual = await vi.importActual<typeof import("./adb.js")>("./adb.js");
  return {
    ...actual,
    restartApp: vi.fn(() => ({ ok: true, output: "restarted" })),
  };
});

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
    // Wrapped, not replaced: this file's AC4 tests need to count how many
    // times `/api/traces`' coverage computation actually spawns
    // trace_processor, and a `vi.fn` around the real implementation is a call
    // count `vi.mocked(runScript).mock.calls` can answer without touching
    // `node:child_process` directly — `vi.spyOn` there throws ("Cannot
    // redefine property: spawn") under this project's ESM interop, which is
    // why this goes through the module mock instead of the built-in.
    runScript: vi.fn(actual.runScript),
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
  /** GRA-197: mirrors DeviceClient.packageMismatch — unset by every existing test, which is the "unset" case. */
  packageMismatch: string | null = null;
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
  /** A request with exact control over the request line, every header, and (GRA-116) an optional raw body. */
  send(
    path: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string },
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
        if (options.body !== undefined) request.write(options.body);
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
  const tracesDir = resolve(PROJECT_ROOT, ".porthole", "traces");
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

  /**
   * GRA-197: the UI cannot derive a package mismatch locally the way it does
   * `protocolMismatch` (App.tsx's own `EXPECTED_PROTOCOL_VERSION`) — it has
   * no way to know what this server was configured for, so the fact has to
   * actually cross the wire. `init` is what a client connecting *after* the
   * mismatch was established sees (mirrors "hands a connected client the
   * buffer it has" above, for the same reason: a page opened mid-session
   * must not see less than one open when the mismatch happened).
   */
  it("carries packageMismatch in the 'init' message a newly connecting client gets", async () => {
    timeline.device.saidHello();
    timeline.device.packageMismatch =
      "Connected to `com.example.shop`, but this MCP server was configured for `com.acme.app`.";

    const result = await connect(timeline.port);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const init = JSON.parse(result.message) as { type: string; packageMismatch: string | null };
      expect(init.type).toBe("init");
      expect(init.packageMismatch).toContain("com.acme.app");
    }
  });

  it("carries packageMismatch in the 'hello' broadcast, alongside hello itself", async () => {
    // A second client, connected before the hello that produces the
    // mismatch — the live-broadcast path, distinct from `init`'s
    // already-connected-client path above.
    const socket = new (await import("ws")).WebSocket(`ws://127.0.0.1:${timeline.port}/ws`);
    const helloMessage = new Promise<{ type: string; packageMismatch: string | null }>((resolve) => {
      let seenInit = false;
      socket.on("message", (data: Buffer) => {
        const parsed = JSON.parse(data.toString()) as { type: string; packageMismatch?: string | null };
        // The socket's own "init" arrives first (see the test above); only
        // the "hello" broadcast after it is what this test is about.
        if (!seenInit && parsed.type === "init") {
          seenInit = true;
          return;
        }
        resolve(parsed as { type: string; packageMismatch: string | null });
      });
    });
    await new Promise<void>((resolve) => socket.once("open", resolve));

    timeline.device.packageMismatch =
      "Connected to `com.example.shop`, but this MCP server was configured for `com.acme.app`.";
    timeline.device.emit("hello", { packageName: "com.example.shop", device: "Pixel 8", startedAt: 1 });

    const message = await helloMessage;
    expect(message.type).toBe("hello");
    expect(message.packageMismatch).toContain("com.acme.app");
    socket.close();
  });

  it("omits nothing — packageMismatch is null in 'init' when the server has no mismatch (the default)", async () => {
    timeline.device.saidHello();
    const result = await connect(timeline.port);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const init = JSON.parse(result.message) as { packageMismatch: string | null };
      expect(init.packageMismatch).toBeNull();
    }
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

describe("GET /api/traces (GRA-113)", () => {
  const tracesDir = resolve(PROJECT_ROOT, ".porthole", "traces");

  beforeEach(async () => {
    await rm(tracesDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(tracesDir, { recursive: true, force: true });
  });

  it("is an empty list when the traces directory does not exist", async () => {
    const response = await timeline.send("/api/traces");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ traces: [] });
  });

  it("is an empty list when the traces directory exists but is empty", async () => {
    await mkdir(tracesDir, { recursive: true });
    const response = await timeline.send("/api/traces");
    expect(JSON.parse(response.body)).toEqual({ traces: [] });
  });

  it("ignores a file that is not a .pftrace, rather than trying to read it as one", async () => {
    await mkdir(tracesDir, { recursive: true });
    await writeFile(resolve(tracesDir, "readme.txt"), "not a trace");
    const response = await timeline.send("/api/traces");
    expect(JSON.parse(response.body)).toEqual({ traces: [] });
  });

  it("lists a 0-byte .pftrace with bytes: 0 and a null coverage carrying a reason", async () => {
    await mkdir(tracesDir, { recursive: true });
    await writeFile(resolve(tracesDir, "zero-byte-a.pftrace"), "");
    const response = await timeline.send("/api/traces");
    const body = JSON.parse(response.body) as { traces: Array<Record<string, unknown>> };
    expect(body.traces).toHaveLength(1);
    // The mocked findTraceProcessor() in this file answers a path nothing is
    // actually listening on, so coverage comes back null via a spawn error
    // here rather than via the "no clock snapshot" reading a real 0-byte
    // file produces — verified separately against the real binary (see this
    // ticket's report). Both are real, honest "could not compute it" answers;
    // this test pins the shape every null-coverage entry must have, not which
    // specific reason produced it.
    expect(body.traces[0]).toMatchObject({ id: "zero-byte-a", bytes: 0, coverage: null });
    expect(typeof body.traces[0].reason).toBe("string");
    expect(typeof body.traces[0].recordedAt).toBe("string");
    expect(() => new Date(body.traces[0].recordedAt as string).toISOString()).not.toThrow();
  });

  it("spawns trace_processor at most once per file, even across repeated listings (AC4)", async () => {
    await mkdir(tracesDir, { recursive: true });
    await writeFile(resolve(tracesDir, "cached-b.pftrace"), "");
    vi.mocked(runScript).mockClear();
    await timeline.send("/api/traces");
    await timeline.send("/api/traces");
    await timeline.send("/api/traces");
    expect(runScript).toHaveBeenCalledTimes(1);
  });

  it("does spawn again for a second, different file — the cache is per-file, not a global switch", async () => {
    await mkdir(tracesDir, { recursive: true });
    await writeFile(resolve(tracesDir, "cached-c.pftrace"), "");
    vi.mocked(runScript).mockClear();
    await timeline.send("/api/traces");
    await writeFile(resolve(tracesDir, "cached-d.pftrace"), "");
    await timeline.send("/api/traces");
    expect(runScript).toHaveBeenCalledTimes(2);
  });
});

/**
 * GRA-113 AC4's own wording: "returns correct coverage windows for the real
 * captures". Everything above proves the endpoint's contract against a fake
 * binary; this proves the arithmetic against the real one, the same
 * skipIf-gated shape perfetto-stdout.test.ts's `askTrace, end to end` test
 * already uses for the same reason — neither the binary nor a real capture
 * is guaranteed on a fresh checkout or CI runner, but both are real on this
 * machine today.
 */
describe("GET /api/traces, against the real binary and a real capture (GRA-113 AC4)", () => {
  const tracesDir = resolve(PROJECT_ROOT, ".porthole", "traces");
  // Read-only source: the main checkout's own captured trace, never this
  // worktree's — copied in, not moved, and never written back to.
  const sourceCapture =
    "C:/Users/james/dev/porthole/mcp/.porthole/traces/porthole-1789157940493.pftrace";
  const ready = existsSync(sourceCapture);

  it.skipIf(!ready)("reports the real capture's real coverage window, computed off its own clock_snapshot", async () => {
    const actual = await vi.importActual<typeof import("./perfetto.js")>("./perfetto.js");
    const binary = actual.findTraceProcessor();
    if (!binary) return; // No cached trace_processor on this machine either; nothing further to prove here.
    vi.mocked(findTraceProcessor).mockReturnValueOnce(binary);

    await mkdir(tracesDir, { recursive: true });
    await copyFile(sourceCapture, resolve(tracesDir, "porthole-1789157940493.pftrace"));
    try {
      const response = await timeline.send("/api/traces");
      const body = JSON.parse(response.body) as { traces: Array<Record<string, unknown>> };
      const entry = body.traces.find((t) => t.id === "porthole-1789157940493");
      expect(entry).toBeDefined();
      // Hand-verified against this same trace with trace_processor_shell
      // directly (SELECT start_ts, end_ts FROM trace_bounds; SELECT
      // clock_id, clock_value, ts FROM clock_snapshot WHERE clock_id IN
      // (3, 6)): bootNs 542876129521493..542887022165720, boot/monotonic
      // offset 202202963814863ns at the trace's own first snapshot — see
      // this ticket's report for the full derivation.
      expect(entry?.coverage).toEqual({ from: 340673166, to: 340684058 });
    } finally {
      await rm(resolve(tracesDir, "porthole-1789157940493.pftrace"), { force: true });
    }
  });
});

describe("/api/findings?trace= validation (GRA-113 AC5)", () => {
  const tracesDir = resolve(PROJECT_ROOT, ".porthole", "traces");
  const knownId = "validation-fixture";

  beforeEach(async () => {
    await mkdir(tracesDir, { recursive: true });
    await writeFile(resolve(tracesDir, `${knownId}.pftrace`), "");
  });

  afterEach(async () => {
    await rm(resolve(tracesDir, `${knownId}.pftrace`), { force: true });
  });

  it("400s an empty trace id", async () => {
    const response = await timeline.send("/api/findings?trace=");
    expect(response.status).toBe(400);
  });

  it("400s an id with a character outside the allowed set, even when a matching real file exists", async () => {
    // The two checks in resolveTraceFile() overlap heavily — a traversal
    // shape fails the regex AND fails the resolve-vs-literal-concat
    // comparison, so a test built only from traversal payloads cannot tell
    // whether the character class is actually doing anything. A space is
    // the case that separates them: it does not change what `resolve`
    // normalises to, so the belt-and-suspenders check alone would let a
    // real file called "weird id.pftrace" through. The character class is
    // what has to refuse this one.
    const weirdId = "weird id";
    await writeFile(resolve(tracesDir, `${weirdId}.pftrace`), "");
    try {
      const response = await timeline.send(`/api/findings?trace=${encodeURIComponent(weirdId)}`);
      expect(response.status).toBe(400);
    } finally {
      await rm(resolve(tracesDir, `${weirdId}.pftrace`), { force: true });
    }
  });

  it("400s a unix-style traversal", async () => {
    const response = await timeline.send(
      "/api/findings?trace=" + encodeURIComponent("../../../etc/passwd"),
    );
    expect(response.status).toBe(400);
  });

  it("400s a windows-style traversal", async () => {
    const response = await timeline.send(
      "/api/findings?trace=" + encodeURIComponent("..\\..\\..\\Windows\\win.ini"),
    );
    expect(response.status).toBe(400);
  });

  it("400s a well-formed id that does not resolve to a real file", async () => {
    const response = await timeline.send("/api/findings?trace=does-not-exist-at-all");
    expect(response.status).toBe(400);
  });

  it("never calls askTrace for any of the refused shapes above — refused before anything is spawned", async () => {
    vi.mocked(askTrace).mockClear();
    await timeline.send("/api/findings?trace=");
    await timeline.send("/api/findings?trace=" + encodeURIComponent("../../../etc/passwd"));
    await timeline.send("/api/findings?trace=" + encodeURIComponent("..\\..\\..\\Windows\\win.ini"));
    await timeline.send("/api/findings?trace=does-not-exist-at-all");
    expect(askTrace).not.toHaveBeenCalled();
  });

  it("accepts the matching id and reaches askTrace, proving the four refusals above are about the id and not the branch itself", async () => {
    timeline.device.saidHello();
    vi.mocked(askTrace).mockClear();
    const response = await timeline.send(`/api/findings?trace=${knownId}`);
    expect(response.status).toBe(200);
    expect(askTrace).toHaveBeenCalledTimes(1);
  });
});

describe("GRA-113 AC1: every finding carries window xor spanning, never neither", () => {
  const tracesDir = resolve(PROJECT_ROOT, ".porthole", "traces");
  const traceId = "both-sources-fixture";

  beforeEach(async () => {
    await mkdir(tracesDir, { recursive: true });
    await writeFile(resolve(tracesDir, `${traceId}.pftrace`), "");
  });

  afterEach(async () => {
    await rm(resolve(tracesDir, `${traceId}.pftrace`), { force: true });
  });

  it("walks every finding from a rig producing both a Porthole finding and a trace finding, and fails on any with neither", async () => {
    timeline.device.saidHello("com.example.shop");
    // A Porthole-side finding: a completed query on the main thread.
    timeline.device.emit("event", event(1, "db_start", { id: "q", sql: "SELECT 1", onMainThread: "true" }));
    timeline.device.emit("event", event(2, "db_end", { id: "q", onMainThread: "true" }));
    timeline.device.emit("event", event(3, "nav", { route: "cart" }));

    // A trace-side rig with one of each shape GRA-113 distinguishes: a
    // point-placeable finding (window) and a spanning one — the same pair
    // interpret() itself produces for a real jank + thread_states answer.
    vi.mocked(askTrace).mockResolvedValueOnce({
      findings: [
        {
          id: "trace-frame-deadline",
          severity: "error",
          confidence: "observed",
          title: "the frame timeline recorded a miss",
          window: { from: 1, to: 2 },
        },
        {
          id: "trace-main-thread-contention",
          severity: "note",
          confidence: "observed",
          title: "the main thread was not waiting for a CPU",
          spanning: true,
        },
      ],
      unanswered: [],
    });

    const response = await timeline.send(`/api/findings?trace=${traceId}`);
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { findings: Array<Record<string, unknown>> };

    // Positive control: a rig that produced no findings at all would make the
    // loop below pass vacuously. It has to actually see both sources' output.
    expect(body.findings.some((f) => f.source === "porthole")).toBe(true);
    expect(body.findings.some((f) => f.source === "trace")).toBe(true);
    expect(body.findings.length).toBeGreaterThanOrEqual(3);

    for (const finding of body.findings) {
      const hasWindow =
        finding.window !== undefined &&
        finding.window !== null &&
        typeof (finding.window as { from?: unknown }).from === "number" &&
        typeof (finding.window as { to?: unknown }).to === "number";
      const hasSpanning = finding.spanning === true;
      expect(
        hasWindow !== hasSpanning,
        `finding ${JSON.stringify(finding)} must carry exactly one of window/spanning`,
      ).toBe(true);
    }
  });
});

describe("GRA-115 ruling 4: /api/findings' asked field", () => {
  const tracesDir = resolve(PROJECT_ROOT, ".porthole", "traces");
  const traceId = "asked-fixture";

  beforeEach(async () => {
    await mkdir(tracesDir, { recursive: true });
    await writeFile(resolve(tracesDir, `${traceId}.pftrace`), "");
    timeline.device.saidHello("com.example.shop");
  });

  afterEach(async () => {
    await rm(resolve(tracesDir, `${traceId}.pftrace`), { force: true });
  });

  it("marks every question answered when askTrace reports nothing unanswered", async () => {
    vi.mocked(askTrace).mockResolvedValueOnce({ findings: [], unanswered: [] });

    const response = await timeline.send(`/api/findings?trace=${traceId}`);
    const body = JSON.parse(response.body) as { asked?: Array<{ id: string; answered: boolean }> };

    expect(body.asked).toEqual([
      { id: "jank", answered: true },
      { id: "thread_states", answered: true },
      { id: "binder", answered: true },
      { id: "render", answered: true },
      { id: "slices", answered: true },
    ]);
  });

  it("marks exactly the question named in askTrace's unanswered reasons as not answered", async () => {
    const failedQuestion = QUESTIONS.find((q) => q.id === "binder")!;
    vi.mocked(askTrace).mockResolvedValueOnce({
      findings: [],
      unanswered: [`${failedQuestion.asks} — trace_processor did not answer within 5000ms querying x; it may be wedged, so nothing after it was retried`],
    });

    const response = await timeline.send(`/api/findings?trace=${traceId}`);
    const body = JSON.parse(response.body) as { asked?: Array<{ id: string; answered: boolean }> };

    const byId = new Map(body.asked!.map((q) => [q.id, q.answered]));
    expect(byId.get("binder")).toBe(false);
    expect(byId.get("jank")).toBe(true);
    expect(byId.get("thread_states")).toBe(true);
    expect(byId.get("render")).toBe(true);
    expect(byId.get("slices")).toBe(true);
  });

  it("omits asked entirely when no trace= was given, rather than an empty array", async () => {
    const response = await timeline.send("/api/findings");
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect("asked" in body).toBe(false);
  });

  it("omits asked when a trace is named but the app is not attached, since askTrace never ran", async () => {
    timeline.device.hello = null;
    const response = await timeline.send(`/api/findings?trace=${traceId}`);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect("asked" in body).toBe(false);
  });
});

describe("GRA-113 AC3: one boot→uptime conversion, in moment.ts only", () => {
  // Copies the shape of surface.test.ts's ConnectionState-comparison guard:
  // a source grep, with a positive control proving the scanner actually sees
  // something, run against every production file in mcp/src — not a
  // hand-picked list. The first version of this guard scanned only
  // ["timeline.ts", "trace.ts", "perfetto.ts"] and matched bare presence of
  // the word "sleepMs", which is why it passed while index.ts's
  // ask_system_trace carried the identical open-coded conversion: the guard
  // was never pointed at that file at all. Two things are fixed here: the
  // file list is now every `*.ts` directly under src/ that isn't a test,
  // discovered with `readdirSync` rather than typed out by hand, so a future
  // file needs no one to remember to add it; and the pattern now looks for
  // *arithmetic* — `sleepMs` next to a `+` or `-` — rather than the bare
  // identifier, because moment.ts's own `toBoot` legitimately hands `sleepMs`
  // back to a caller (index.ts reports it in a payload) and a
  // presence-only check would have forced that call site onto the banned
  // list too.
  const productionFiles = readdirSync(new URL("./", import.meta.url))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter((name) => name !== "moment.ts");

  /** `+`/`-` next to the identifier, either order — arithmetic, not a mention. */
  const ARITHMETIC = /[-+]\s*sleepMs\b|\bsleepMs\s*[-+]/;

  it("the file list is non-empty and actually includes index.ts — the file the bug was found in", () => {
    // Same positive-control reasoning as surface.test.ts's own version: a
    // guard that silently scans nothing (a broken readdirSync filter, a
    // renamed directory) passes every offender through unseen. Naming
    // index.ts specifically pins the exact gap the coordinator's widened
    // grant closed — a passing list that happened to still exclude it would
    // reopen the same hole under a different mechanism.
    expect(productionFiles.length).toBeGreaterThan(10);
    expect(productionFiles).toContain("index.ts");
    expect(productionFiles).toContain("timeline.ts");
    expect(productionFiles).not.toContain("moment.ts");
  });

  it("the arithmetic pattern matches the exact buggy shape index.ts used to have, and does not match its fix", () => {
    // The mutation this test is built from: reverted to this literal text
    // (from git history, not retyped from memory) and re-ran the file-scan
    // test below, which failed with index.ts named as the offender. Restored
    // and re-ran clean. This unit-level pair is the permanent record of that
    // proof, independent of whichever way index.ts happens to read next.
    const buggy = "const bounds = {\n  fromNs: (span.from + sleepMs) * 1e6,\n  toNs: (span.to + sleepMs) * 1e6,\n};";
    expect(ARITHMETIC.test(buggy)).toBe(true);

    const fixed = "window: { from: span.from, to: span.to, sleepMs: bootTo.sleepMs },";
    expect(ARITHMETIC.test(fixed)).toBe(false);
  });

  it("moment.ts's own conversions do match the arithmetic pattern — the positive control for the file scan below", () => {
    const text = readFileSync(new URL("./moment.ts", import.meta.url), "utf8");
    expect(text).toMatch(ARITHMETIC);
  });

  it("no production file outside moment.ts contains sleepMs arithmetic", () => {
    const offenders: string[] = [];
    for (const file of productionFiles) {
      const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      if (ARITHMETIC.test(text)) offenders.push(file);
    }
    expect(offenders, `sleepMs arithmetic found outside moment.ts in: ${offenders.join(", ")}`).toEqual([]);
  });
});

/**
 * GRA-116: "keep the last N seconds, from where you are already looking" --
 * the UI's own save gesture, server-side. Ruling 2's own words: the handler
 * builds events through the same `fillWindowFromDisk` merge and
 * `buildSavedTrace`/`writeSavedTrace` pair `save_moment` already calls (no
 * second implementation of either), and is hardened exactly like
 * `/api/tools/restart` -- POST only, the origin/host gate that already runs
 * ahead of every route (see "who the server answers" above), a malformed
 * body is a 400, and `from >= to` is a 400.
 */
describe("POST /api/save (GRA-116)", () => {
  const tracesDir = resolve(PROJECT_ROOT, ".porthole", "traces");
  const written: string[] = [];

  afterEach(async () => {
    await Promise.all(written.splice(0).map((file) => rm(file, { force: true })));
  });

  it("refuses every method but POST, same shape as /api/tools/restart", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await timeline.send("/api/save", { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.allow, method).toBe("POST");
    }
  });

  it("refuses a cross-origin POST the same way every other route does (GRA-78)", async () => {
    const response = await timeline.send("/api/save", {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
      body: JSON.stringify({ from: 0, to: 1000 }),
    });
    expect(response.status).toBe(403);
  });

  it("400s a missing body -- no from/to to act on", async () => {
    const response = await timeline.send("/api/save", { method: "POST" });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toContain("from");
  });

  it("400s an explicitly empty body the same way -- not a JSON.parse crash, an honest 'from and to are required'", async () => {
    const response = await timeline.send("/api/save", { method: "POST", body: "" });
    expect(response.status).toBe(400);
  });

  it("400s malformed JSON, in one line", async () => {
    const response = await timeline.send("/api/save", { method: "POST", body: "{not json" });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe("Malformed JSON body.");
  });

  it("400s a scenario that would escape .porthole/traces, and writes nothing (QA round 1)", async () => {
    // Every escape below stays inside the throwaway project root's parent
    // chain only as far as `.porthole/` and the root itself, so "nothing
    // written" is checked as "these two listings did not change" rather than
    // as the absence of a fixed path outside anything this test owns — a
    // mutation run once left such a file behind on the developer's machine,
    // and a stale artifact must not be able to fail a later run.
    const dotPorthole = resolve(tracesDir, "..");
    const before = [
      existsSync(tracesDir) ? readdirSync(tracesDir).sort() : null,
      readdirSync(dotPorthole).sort(),
      readdirSync(PROJECT_ROOT).sort(),
    ];
    for (const scenario of ["../evil", "..\\evil", "a/b", "a\\b", "..", "."]) {
      const response = await timeline.send("/api/save", {
        method: "POST",
        body: JSON.stringify({ from: 0, to: 1_000, scenario }),
      });
      expect(response.status, scenario).toBe(400);
      expect(JSON.parse(response.body).error, scenario).toMatch(/scenario/);
    }
    const after = [
      existsSync(tracesDir) ? readdirSync(tracesDir).sort() : null,
      readdirSync(dotPorthole).sort(),
      readdirSync(PROJECT_ROOT).sort(),
    ];
    expect(after).toEqual(before);
  });

  it("400s a well-formed JSON body that is not an object (an array, a bare number)", async () => {
    const arrayBody = await timeline.send("/api/save", { method: "POST", body: "[1,2,3]" });
    expect(arrayBody.status).toBe(400);
    const numberBody = await timeline.send("/api/save", { method: "POST", body: "42" });
    expect(numberBody.status).toBe(400);
  });

  it("400s when from is missing", async () => {
    const response = await timeline.send("/api/save", {
      method: "POST",
      body: JSON.stringify({ to: 1000 }),
    });
    expect(response.status).toBe(400);
  });

  it("400s when to is missing", async () => {
    const response = await timeline.send("/api/save", {
      method: "POST",
      body: JSON.stringify({ from: 0 }),
    });
    expect(response.status).toBe(400);
  });

  it("400s from >= to, both the equal and the reversed case", async () => {
    const equal = await timeline.send("/api/save", {
      method: "POST",
      body: JSON.stringify({ from: 1000, to: 1000 }),
    });
    expect(equal.status).toBe(400);
    const reversed = await timeline.send("/api/save", {
      method: "POST",
      body: JSON.stringify({ from: 1000, to: 500 }),
    });
    expect(reversed.status).toBe(400);
  });

  it("still writes a trace for a window with no events at all -- an empty window is not an error", async () => {
    const response = await timeline.send("/api/save", {
      method: "POST",
      body: JSON.stringify({ from: 0, to: 1000, scenario: "gra116-empty-fixture" }),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { out: string; scenario: string; findings: number };
    written.push(body.out);
    expect(body.scenario).toBe("gra116-empty-fixture");
    expect(body.findings).toBe(0);
    // GRA-54's own reader -- no second, hand-rolled JSON.parse of this file.
    await expect(readTrace(body.out)).resolves.toMatchObject({ scenario: "gra116-empty-fixture" });
  });

  it("writes a file under the project root that GRA-54's own reader (readTrace) parses back", async () => {
    timeline.device.saidHello("com.example.shop");
    timeline.device.emit("event", event(1, "recompose", { screen: "cart" }));
    timeline.device.emit("event", event(2, "recompose", { screen: "cart" }));

    const response = await timeline.send("/api/save", {
      method: "POST",
      body: JSON.stringify({ from: 0, to: 10, scenario: "gra116-write-fixture" }),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { out: string; scenario: string; clippedMs: unknown; findings: number };
    written.push(body.out);
    expect(body.out).toBe(resolve(tracesDir, "gra116-write-fixture.json"));
    expect(existsSync(body.out)).toBe(true);

    const trace = await readTrace(body.out);
    expect(trace.scenario).toBe("gra116-write-fixture");
  });

  it("defaults scenario/out exactly the way save_moment does when scenario is omitted", async () => {
    const response = await timeline.send("/api/save", {
      method: "POST",
      body: JSON.stringify({ from: 100, to: 200 }),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { out: string; scenario: string };
    written.push(body.out);
    expect(body.scenario).toBe("moment-100-200");
    expect(body.out).toBe(resolve(tracesDir, "moment-100-200.json"));
  });

  it("reports an honest clippedMs for a window reaching earlier than anything actually recorded", async () => {
    timeline.device.saidHello("com.example.shop");
    // The earliest thing this server has seen is t=1000 -- asking from 0
    // must say so rather than silently writing a shorter trace.
    timeline.device.emit("event", event(1000, "recompose", { screen: "cart" }));
    timeline.device.emit("event", event(1500, "recompose", { screen: "cart" }));

    const response = await timeline.send("/api/save", {
      method: "POST",
      body: JSON.stringify({ from: 0, to: 1500, scenario: "gra116-clip-fixture" }),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { out: string; clippedMs: { start: number; end: number } };
    written.push(body.out);
    expect(body.clippedMs).toEqual({ start: 1000, end: 0 });
  });
});
