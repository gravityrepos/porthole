// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { DeviceClient, DeviceEvent, Hello } from "./device.js";
import { TimelineServer } from "./timeline.js";

// The only thing in here that touches the outside world. `restart` shells out
// to adb, and a test that force-stopped whatever app happens to be installed
// would be a worse bug than the one this file exists to catch.
vi.mock("./adb.js", () => ({
  restartApp: vi.fn(() => ({ ok: true, output: "restarted" })),
}));

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

  it("refuses the endpoint that takes a filesystem path", async () => {
    const response = await timeline.send("/api/findings?trace=C:/Windows/win.ini", {
      headers: { host: "evil.example.com" },
    });
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

  it("has nothing to say on any other path", async () => {
    const result = await connect(timeline.port, { path: "/nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("404");
  });
});
