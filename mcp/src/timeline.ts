// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { restartApp } from "./adb.js";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { DeviceClient, DeviceEvent } from "./device.js";
import { askTrace, findTraceProcessor } from "./perfetto.js";
import { buildTrace } from "./trace.js";

const UI_DIR = fileURLToPath(new URL("../ui/dist/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".map": "application/json",
};

/** Roughly ten minutes of a busy app. The device ring is smaller; this is the wider view. */
const BUFFER_LIMIT = 20_000;

/**
 * Serves the timeline UI and streams events to it.
 *
 * Kept separate from the MCP transport on purpose: MCP talks stdio to the agent,
 * this talks HTTP and WebSocket to a browser, and the two never cross. The event
 * buffer is shared so the UI and the `timeline` tool see the same history.
 */
interface OtherTimeline {
  connected: boolean;
  app: string | null;
  device: string | null;
  devicePort: number;
}

/** An EADDRINUSE that knows whether the squatter is one of ours and alive. */
export interface PortInUse extends Error {
  portholeAlreadyRunning: boolean;
  url: string;
}

export class TimelineServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private events: DeviceEvent[] = [];
  private started = false;

  constructor(
    private readonly device: DeviceClient,
    private readonly port: number,
    private readonly serial?: string,
  ) {
    device.on("event", (event: DeviceEvent) => this.record(event));
    device.on("state", (state: string) => this.broadcast({ type: "state", state }));
    device.on("hello", (hello: unknown) => {
      // A process is a session. Sequence numbers restart with it, so keeping the
      // previous process's events would put two timelines on one axis — and,
      // worse, make the new process's first events look like ones already seen.
      const startedAt = (hello as { startedAt?: number } | null)?.startedAt;
      if (startedAt !== undefined && startedAt !== this.startedAt) {
        this.startedAt = startedAt;
        this.events = [];
      }
      this.broadcast({ type: "hello", hello });
      void this.backfill();
    });
  }

  /** Uptime the connected process started at; identifies the session. */
  private startedAt: number | undefined;

  /** Everything we have seen, newest last. Used by the `timeline` tool too. */
  buffer(): DeviceEvent[] {
    return this.events;
  }

  private record(event: DeviceEvent): void {
    this.events.push(event);
    if (this.events.length > BUFFER_LIMIT) {
      this.events.splice(0, this.events.length - BUFFER_LIMIT);
    }
    this.broadcast({ type: "event", event });
  }

  /**
   * Pulls the device's own ring after a (re)connect, so events emitted while
   * nothing was listening are not lost — which is most of them, since the app
   * usually starts before anyone attaches.
   */
  private async backfill(): Promise<void> {
    try {
      const page = await this.device.request<{ events: DeviceEvent[] }>("timeline", {
        limit: 2000,
      });
      const known = new Set(this.events.map((e) => e.seq));
      const fresh = page.events.filter((e) => !known.has(e.seq));
      if (fresh.length === 0) return;
      this.events = [...fresh, ...this.events].sort((a, b) => a.seq - b.seq).slice(-BUFFER_LIMIT);
      this.broadcast({ type: "reset", events: this.events });
    } catch {
      // A failed backfill is not worth surfacing; live events still flow.
    }
  }

  async start(): Promise<string> {
    if (this.started) return this.url();
    this.started = true;

    const server = http.createServer(async (req, res) => {
      const path = (req.url ?? "/").split("?")[0];

      // Identifies this server to another instance that finds the port
      // taken. Sniffing the HTML would answer 'a web server' and not
      // 'a Porthole, attached to this device, still alive'.
      /**
       * Both halves of the answer, in one list.
       *
       * Porthole says what the app was doing and that it hurt; a system trace
       * says what the rest of the device was doing, and mostly rules causes
       * out. They only belong in one list because they already share a shape —
       * the same severities, and the same distinction between what was
       * observed and what was merely adjacent. Each carries its source so a
       * reader can tell which tool is making the claim.
       */
      if (path === "/api/findings") {
        const query = new URL(req.url ?? "/", "http://localhost");
        const events = this.events;
        const to = numberParam(query.searchParams.get("to")) ?? events[events.length - 1]?.t ?? 0;
        const from = numberParam(query.searchParams.get("from")) ?? events[0]?.t ?? 0;
        const within = events.filter((e) => e.t >= from && e.t <= to);

        const live = buildTrace({
          scenario: "live",
          events: within,
          hello: (this.device.hello as unknown as Record<string, unknown>) ?? null,
          durationMs: Math.max(0, to - from),
          withEvents: false,
        });

        type Sourced = (typeof live.findings)[number] & { source: "porthole" | "trace" };
        const findings: Sourced[] = live.findings.map((f) => ({ ...f, source: "porthole" }));
        const notes: string[] = [];

        const tracePath = query.searchParams.get("trace");
        if (tracePath) {
          const binary = findTraceProcessor();
          const app = this.device.hello?.packageName;
          if (!binary) {
            notes.push(
              "trace_processor_shell was not found, so the trace could not be read. " +
                "The trace itself still opens at ui.perfetto.dev.",
            );
          } else if (!app) {
            notes.push("Not attached to an app, so there is no process to scope the trace to.");
          } else {
            // The window is in Porthole's clock; the trace is stamped in the
            // boot clock, and the two differ by however long the device slept.
            const sample = within.find((e) => e.event === "clocks") ?? events.find((e) => e.event === "clocks");
            const sleepMs = sample ? Number(sample.data.sleepMs) || 0 : 0;
            const asked = askTrace({
              binary,
              trace: tracePath,
              packageName: app,
              fromNs: (from + sleepMs) * 1e6,
              toNs: (to + sleepMs) * 1e6,
            });
            findings.push(...asked.findings.map((f): Sourced => ({ ...f, source: "trace" })));
            notes.push(...asked.unanswered);
          }
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            window: { from, to, ms: Math.max(0, to - from) },
            eventsExamined: within.length,
            metrics: live.metrics,
            findings,
            notes,
          }),
        );
        return;
      }

      if (path === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            name: "porthole-timeline",
            uiPort: this.port,
            devicePort: this.device.port,
            connected: this.device.state === "connected",
            app: this.device.hello?.packageName ?? null,
            device: this.device.hello?.device ?? null,
            bufferedEvents: this.events.length,
          }),
        );
        return;
      }

      // The inspector proxies to the device rather than holding a copy: the
      // app's tables are the app's, and a cached mirror would go stale the
      // moment it mattered.
      if (path.startsWith("/api/db/")) {
        const query = new URL(req.url ?? "/", "http://localhost");
        const method =
          path === "/api/db/tables"
            ? "db_tables"
            : path === "/api/db/rows"
              ? "db_rows"
              : "db_query";
        const params: Record<string, unknown> = {
          database: query.searchParams.get("database") ?? undefined,
          table: query.searchParams.get("table") ?? undefined,
          sql: query.searchParams.get("sql") ?? undefined,
          limit: numberParam(query.searchParams.get("limit")),
          offset: numberParam(query.searchParams.get("offset")),
          count: query.searchParams.get("count") === "0" ? false : undefined,
        };
        try {
          const result = await this.device.request(method, params);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
        return;
      }

      if (path === "/api/tools/restart" && req.method === "POST") {
        const packageName = (this.device.hello as { packageName?: string } | null)?.packageName;
        if (!packageName) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, output: "The app has not said hello yet." }));
          return;
        }
        const result = restartApp(packageName, this.serial);
        res.writeHead(result.ok ? 200 : 502, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // What the app wired up, and what it has on its classpath but did not.
      // The UI uses it to tell an empty lane apart from a missing integration.
      if (path === "/api/setup") {
        try {
          const result = await this.device.request("setup", {});
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
        return;
      }

      if (path === "/api/events") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ events: this.events, hello: this.device.hello }));
        return;
      }

      // The UI is a built Vite bundle: an entry document plus hashed assets.
      // Anything that is not a real file falls back to index.html, so a deep
      // link still boots the app rather than 404ing.
      const requested = path === "/" ? "index.html" : path.replace(/^\/+/, "");
      const resolved = resolve(UI_DIR, requested);
      const target = resolved.startsWith(resolve(UI_DIR))
        ? resolved
        : resolve(UI_DIR, "index.html");

      try {
        const body = await readFile(target);
        res.writeHead(200, {
          "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
        });
        res.end(body);
      } catch {
        try {
          const html = await readFile(resolve(UI_DIR, "index.html"));
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(html);
        } catch (error) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(
            "The timeline UI has not been built. Run `npm run build` in the package root.\n" +
              (error as Error).message,
          );
        }
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        // Loopback only. The UI is a dev tool and has no business being routable.
        server.listen(this.port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.started = false;
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      const other = await this.probeHealth();
      const problem = new Error(this.explainPortInUse(other)) as PortInUse;
      // Lets a caller tell "someone else has the port" from "yours is already
      // open", which want different answers: one is a failure, one is a URL.
      problem.portholeAlreadyRunning = other !== null && other.connected;
      problem.url = this.url();
      throw problem;
    }

    // After the bind, not before. Attached to a server that has not
    // listened, the socket server re-emits the bind failure as its own
    // unhandled error — which is what turned a taken port into a raw
    // stack trace, escaping the handler written to explain it.
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (socket: WebSocket) => {
      socket.send(
        JSON.stringify({
          type: "init",
          state: this.device.state,
          hello: this.device.hello,
          events: this.events,
        }),
      );
    });

    this.server = server;
    return this.url();
  }

  /**
   * Who has the port, in a sentence someone can act on.
   *
   * Nearly always an older instance of this server that outlived the session
   * that started it — and it will answer requests, so the failure otherwise
   * looks like the port being busy when the real problem is that the thing
   * answering is attached to a device that went away hours ago.
   */
  private explainPortInUse(other: OtherTimeline | null): string {
    if (!other) {
      return (
        `Port ${this.port} is already in use by something that is not a Porthole timeline. ` +
        `Stop it, or start this one on another port.`
      );
    }
    const attached = other.connected
      ? `attached to ${other.app ?? "an app"}` +
        (other.device ? ` on ${other.device}` : "") +
        ` via device port ${other.devicePort}`
      : "not attached to any device";
    return (
      `A Porthole timeline is already running at ${this.url()}, ${attached}. ` +
      (other.connected
        ? "Open it rather than starting a second one."
        : "It is stale — stop it and start again, or it will show nothing.")
    );
  }

  /** Null when nothing answers, or answers as something else. */
  private async probeHealth(): Promise<OtherTimeline | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/api/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as Record<string, unknown>;
      if (body.name !== "porthole-timeline") return null;
      return {
        connected: body.connected === true,
        app: (body.app as string) ?? null,
        device: (body.device as string) ?? null,
        devicePort: Number(body.devicePort) || 0,
      };
    } catch {
      // Holding a port without answering HTTP is still "something else".
      return null;
    }
  }

  stop(): void {
    this.wss?.close();
    this.server?.close();
    this.server = null;
    this.wss = null;
    this.started = false;
  }

  isRunning(): boolean {
    return this.started;
  }

  url(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  private broadcast(message: unknown): void {
    if (!this.wss) return;
    const payload = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }
}

function numberParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
