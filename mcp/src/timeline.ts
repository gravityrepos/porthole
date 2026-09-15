// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { restartApp, resolveProjectRoot } from "./adb.js";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { isConnected, isHandshaking, type ConnectionState, type DeviceClient, type DeviceEvent } from "./device.js";
import { askTrace, findTraceProcessor, parseRows, runScript, why, QUESTIONS, type RunResult } from "./perfetto.js";
import { buildTrace } from "./trace.js";
import { fromBootMs, fromTraceClockSnapshot, toBootNs } from "./moment.js";
import { UNKNOWN_DEVICE_ID, fillWindowFromDisk, sessionsRoot, type SessionEvent } from "./sessions.js";
import { InvalidScenarioError, buildSavedTrace, defaultOutPath, defaultScenarioName, validateScenario, writeSavedTrace } from "./save.js";

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
 * The database calls the inspector may make, by exact path.
 *
 * A map rather than a chain of comparisons ending in `db_query`, because that
 * chain had a fall-through: every path under `/api/db/` that was not `tables`
 * or `rows` — `/api/db/`, `/api/db/nonsense`, anything — became a `db_query`
 * carrying whatever `sql` the query string held. Unknown paths are now a 404.
 */
const DB_ROUTES: Record<string, string> = {
  "/api/db/tables": "db_tables",
  "/api/db/rows": "db_rows",
  "/api/db/query": "db_query",
};

/**
 * Vite's dev port, which this server also answers to. See `authorities`.
 *
 * `npm run dev` in `mcp/ui` serves the UI from :5273 and proxies `/api` and
 * `/ws` here. Vite's proxy leaves `Host` and `Origin` exactly as the browser
 * wrote them (`changeOrigin` is off by default), so a same-origin request from
 * the dev UI arrives here addressed to :5273. Verified, not assumed: with the
 * repo's own vite.config.ts, `Host: localhost:5273` and
 * `Origin: http://localhost:5273` are what land on the target socket, for the
 * WebSocket upgrade as well as for `/api`.
 *
 * The port is safe to allow only because `refuse` also requires the two halves
 * to agree. As a bare entry in an allowlist it was a hole, and the hole was
 * the WebSocket: nothing stops some other page from being served on :5273 —
 * the dev server is not the only thing that can hold a port, and a developer
 * who visits it has given that page this origin. Such a page opening
 * `ws://127.0.0.1:8678/ws` produced an upgrade carrying this server's own
 * `Host` and that page's allowed `Origin`, which passed, and the socket
 * answered with the entire event buffer. Requiring agreement refuses that
 * pair — the two halves name different ports — while still admitting the
 * proxy's, where both say :5273.
 */
const VITE_DEV_PORT = 5273;

/** Loopback spellings of one port, as they appear in a `Host` header. */
function loopbackAuthorities(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

/**
 * Where captures live: flat, under the project root. GRA-113's own open
 * question asked whether a `.pftrace` should instead file under the session
 * it covers once sessions are on disk (GRA-53) — answered "stay flat" for
 * now; `/api/traces` is the one place that would have to change.
 */
function tracesDir(): string {
  return resolve(resolveProjectRoot().directory, ".porthole", "traces");
}

/**
 * A `trace=` value has to look like a name this server minted itself —
 * `id`s come only from what `/api/traces` just listed — before anything
 * touches the filesystem or a subprocess with it. No path separator of
 * either flavour is even a legal character, which is what refuses
 * `../../../etc/passwd` and `..\..\..\Windows\win.ini` alike: neither `/`
 * nor `\` is in the class below, so both fail here and never reach `resolve`.
 */
const TRACE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * `id` → a real `.pftrace` inside the traces directory, or null for anything
 * that is not exactly that (GRA-113 AC5). The regex above is already enough
 * to refuse a traversal outright, since it admits no separator to traverse
 * with; the `resolve`-and-prefix check is the same belt-and-suspenders
 * pattern this file already uses for the static UI (see `target` below), and
 * catches the id of a file that simply does not exist, which the regex alone
 * cannot.
 */
function resolveTraceFile(id: string): string | null {
  if (!TRACE_ID_PATTERN.test(id)) return null;
  const dir = resolve(tracesDir());
  const resolved = resolve(dir, `${id}.pftrace`);
  if (resolved !== `${dir}${sep}${id}.pftrace`) return null;
  try {
    if (!statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
}

interface TraceListing {
  id: string;
  bytes: number;
  recordedAt: string;
  coverage: { from: number; to: number } | null;
  reason?: string;
}

/** A trace's coverage never changes for a given `(path, mtime)`, so it is computed at most once per file no matter how many times `/api/traces` is polled — GRA-82's pattern applied to a new endpoint rather than re-litigated for it. */
const coverageCache = new Map<string, { coverage: { from: number; to: number } | null; reason?: string }>();

/** trace_processor's own budget for this: bounds and a clock snapshot are cheap next to loading a whole trace to answer the five questions, so a much shorter fuse than `askTrace`'s 60s is enough to call a hang a hang. */
const COVERAGE_TIMEOUT_MS = 20_000;

/**
 * `start_ts`/`end_ts` and a clock snapshot, in one invocation — one trace
 * load, whatever `/api/traces` asks about next. Two plain `SELECT`s of
 * nothing but numbers, so splitting the output on the blank line between
 * statements (which `matchBatch` in perfetto.ts deliberately does NOT do for
 * the five questions, because a slice name can contain one) is safe here:
 * nothing in this query's result can contain an embedded newline.
 */
const COVERAGE_SQL =
  'SELECT start_ts, end_ts FROM trace_bounds;\n' +
  'SELECT clock_id, clock_value, ts FROM clock_snapshot WHERE clock_id IN (3, 6) ORDER BY snapshot_id LIMIT 2;';

function readCoverage(result: RunResult): { coverage: { from: number; to: number } | null; reason?: string } {
  if (result.spawnError) {
    return { coverage: null, reason: `trace_processor could not run: ${result.spawnError.message}` };
  }
  if (result.timedOut) {
    return {
      coverage: null,
      reason: `trace_processor did not answer within ${result.elapsedMs}ms; it may be wedged`,
    };
  }
  if (result.code !== 0) {
    return { coverage: null, reason: `trace_processor could not read this file: ${why(result.stderr, undefined)}` };
  }

  const [boundsBlock, clockBlock] = result.stdout.trim().split(/\r?\n\r?\n/);
  const bounds = parseRows(boundsBlock ?? "");
  const clocks = parseRows(clockBlock ?? "");
  const boot = clocks.find((r) => String(r.clock_id) === "6");
  const monotonic = clocks.find((r) => String(r.clock_id) === "3");
  const startTs = Number(bounds[0]?.start_ts);
  const endTs = Number(bounds[0]?.end_ts);

  if (!boot || !monotonic) {
    return {
      coverage: null,
      reason: "the trace has no clock snapshot, so its window cannot be placed on the device's uptime clock",
    };
  }
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || (startTs === 0 && endTs === 0)) {
    return { coverage: null, reason: "the trace has no bounds — trace_processor read it as empty" };
  }

  const snapshot = { bootNs: Number(boot.clock_value), monotonicNs: Number(monotonic.clock_value) };
  return {
    coverage: {
      from: fromTraceClockSnapshot(snapshot, startTs),
      to: fromTraceClockSnapshot(snapshot, endTs),
    },
  };
}

async function coverageOf(
  binary: string,
  tracePath: string,
  mtimeMs: number,
): Promise<{ coverage: { from: number; to: number } | null; reason?: string }> {
  const key = `${tracePath} ${mtimeMs}`;
  const cached = coverageCache.get(key);
  if (cached) return cached;

  const result = await runScript(binary, ["query", "-f", "-", tracePath], COVERAGE_SQL, COVERAGE_TIMEOUT_MS);
  const answer = readCoverage(result);
  coverageCache.set(key, answer);
  return answer;
}

/**
 * `<project root>/.porthole/traces/*.pftrace`, as `id`/`bytes`/`recordedAt`/
 * `coverage` (GRA-113). Missing or unreadable directory, or one with nothing
 * `.pftrace` in it, is an empty list rather than an error — the same
 * "absence is not exceptional" choice `findTraceProcessor` and
 * `resolveSdkDir` already make elsewhere in this codebase.
 *
 * Sequential, not `Promise.all` over the list: `coverageOf` spawns
 * trace_processor, and running several at once against a socket-driven
 * server that also has a live device attached is exactly the kind of
 * resource spike GRA-82 exists to avoid. One at a time also means the cache
 * above is never asked to answer for a file mid-computation from a second
 * concurrent request.
 */
async function listTraces(): Promise<TraceListing[]> {
  const dir = tracesDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const files = names
    .filter((name) => extname(name) === ".pftrace")
    .map((name) => {
      const path = resolve(dir, name);
      const stats = statSync(path);
      return { id: name.slice(0, -".pftrace".length), path, bytes: stats.size, mtimeMs: stats.mtimeMs };
    });

  const binary = findTraceProcessor();
  const out: TraceListing[] = [];
  for (const file of files) {
    const { coverage, reason } = binary
      ? await coverageOf(binary, file.path, file.mtimeMs)
      : {
          coverage: null,
          reason:
            "trace_processor_shell was not found, so this trace's coverage could not be read. " +
            "`./gradlew portholeTraceProcessor` fetches it.",
        };
    out.push({
      id: file.id,
      bytes: file.bytes,
      recordedAt: new Date(file.mtimeMs).toISOString(),
      coverage,
      ...(reason ? { reason } : {}),
    });
  }
  // Newest first: the trace someone just captured is the one they are asking about.
  return out.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

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

  /**
   * Every authority this server will answer to. Compared whole, lower-cased,
   * never parsed. There is no matching list of origins: an `Origin` is checked
   * against the one authority `Host` names, not against a list of its own.
   *
   * `Host` and `Origin` are text the caller chose, and every parser of them has
   * a seam — `user@host`, a trailing dot, an embedded slash, a bracketed v6
   * literal — where two readers disagree about which part is the name. A fixed
   * list of strings has no seam: `127.0.0.1.evil.com` is simply not in it.
   */
  private readonly authorities: Set<string>;

  constructor(
    private readonly device: DeviceClient,
    private readonly port: number,
    private readonly serial?: string,
  ) {
    this.authorities = new Set([
      ...loopbackAuthorities(port),
      ...loopbackAuthorities(VITE_DEV_PORT),
    ]);

    device.on("event", (event: DeviceEvent) => this.record(event));
    device.on("state", (state: ConnectionState) => this.broadcast({ type: "state", state }));
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

  /**
   * Why this request is not ours to answer, or null if it is.
   *
   * The socket is loopback-only, which keeps the network out but not the
   * browser: every page the developer has open can reach 127.0.0.1, and a
   * cross-origin POST — or a WebSocket upgrade — lands whether or not the
   * attacker can read the reply. Three questions close that, and all three are
   * about the browser's own account of the request rather than about its body:
   *
   * `Host` is what the URL said, and a page on the open web cannot forge it —
   * which is also the answer to DNS rebinding, where a name the attacker owns
   * resolves to 127.0.0.1 and arrives here as `Host: evil.example.com`.
   *
   * `Origin` is who asked, sent on every cross-origin request and on
   * same-origin POSTs, and it must name the authority `Host` already named: a
   * caller may only claim an origin it also claims to have been addressed to.
   * That is a stronger rule than membership of a list, and a cheaper one to
   * check by eye. It is also what makes the dev-port allowance safe rather than
   * merely convenient, since :5273 is then admitted only when both halves say
   * :5273 — the Vite proxy — and refused when `Origin` alone does, which is a
   * page that happens to have been served from that port.
   *
   * `Sec-Fetch-Site` is the browser's own verdict, and it backstops nothing on
   * the path that matters. Current Chrome — 152, observed, not assumed — sends
   * no `Sec-Fetch-*` header of any kind on a WebSocket handshake, and the
   * handshake is the request that answers with the whole event buffer. Every
   * ordinary fetch from the same page carried `sec-fetch-site: cross-site`; the
   * upgrade beside it carried nothing, so this check simply did not run. Its
   * absence has to pass anyway, or curl, the MCP server's own health probe and
   * anything older than 2020 stop working. Take it as a third opinion where a
   * browser offers one, never as a defence the other two can lean on.
   */
  private refuse(req: http.IncomingMessage): string | null {
    const host = req.headers.host?.toLowerCase();
    if (host === undefined || !this.authorities.has(host)) {
      return "Refused: this is a loopback debug server, and that is not one of its own addresses.";
    }

    // `http://` and nothing else: this server has no certificate and never
    // will, so an https origin claiming to be us is someone else.
    const origin = req.headers.origin?.toLowerCase();
    if (origin !== undefined && origin !== `http://${host}`) {
      return "Refused: this debug server answers only its own page, and that request came from elsewhere.";
    }

    const site = req.headers["sec-fetch-site"]?.toString().toLowerCase();
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      return "Refused: the browser reports this request did not come from this server's own page.";
    }

    return null;
  }

  /**
   * GRA-116: the identity `fillWindowFromDisk` should look up sessions
   * under, mirroring `index.ts`'s own `currentIdentity()` (the function this
   * one is a deliberate copy of, not an import of — `TimelineServer` has no
   * dependency on `index.ts` today and one new route is not reason enough to
   * start one). Falls back to `lastExited`'s own `hello` so a save can still
   * find the right session after the app has already exited — the same
   * post-mortem case `save_moment` exists for. Null only when neither has
   * ever existed.
   */
  private currentIdentity(): { packageName: string; deviceId: string } | null {
    const hello = this.device.hello ?? this.device.lastExited?.hello ?? null;
    if (!hello) return null;
    return {
      packageName: hello.packageName,
      deviceId: (hello as { deviceId?: string }).deviceId ?? UNKNOWN_DEVICE_ID,
    };
  }

  /** A refusal, as a response. */
  private refused(res: http.ServerResponse, reason: string): void {
    // The reason names the rule and never the header that broke it. Everything
    // this server holds is captured from someone's running app, and a 403 that
    // quoted the caller's own text back would be one more place where a value
    // that went in comes out again.
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end(`${reason}\n`);
  }

  async start(): Promise<string> {
    if (this.started) return this.url();
    this.started = true;

    const server = http.createServer(async (req, res) => {
      // Admission first, before any routing, so that adding an endpoint below
      // cannot accidentally add one that is reachable from a web page.
      const refusal = this.refuse(req);
      if (refusal) {
        this.refused(res, refusal);
        return;
      }

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
      // GRA-113: what captures exist, and the uptime window each one covers,
      // so a caller can ask "does any trace have anything to say about what
      // is on screen right now" without opening one. The ids this returns
      // are the only ones `/api/findings?trace=` will accept.
      if (path === "/api/traces") {
        const traces = await listTraces();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ traces }));
        return;
      }

      if (path === "/api/findings") {
        const query = new URL(req.url ?? "/", "http://localhost");
        const events = this.events;
        const to = numberParam(query.searchParams.get("to")) ?? events[events.length - 1]?.t ?? 0;
        const from = numberParam(query.searchParams.get("from")) ?? events[0]?.t ?? 0;
        const within = events.filter((e) => e.t >= from && e.t <= to);

        // GRA-113 AC5: `trace` is an id from `GET /api/traces`, never a
        // filesystem path handed straight to trace_processor_shell. An id
        // that does not resolve to a real file inside the traces directory —
        // a traversal shape, an unknown name, an empty value — is refused
        // right here, before anything else in this handler runs and in
        // particular before anything is spawned.
        const traceId = query.searchParams.get("trace");
        const traceFile = traceId === null ? null : resolveTraceFile(traceId);
        if (traceId !== null && traceFile === null) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: `Not a known trace id: ${JSON.stringify(traceId)}. See GET /api/traces.`,
            }),
          );
          return;
        }

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
        // GRA-115 ruling 4: which of the five questions trace_processor
        // actually answered, so a UI asking "what did the trace rule out"
        // does not have to infer it from the absence of a `trace-*` finding
        // -- that guess is wrong for `thread_states`, which always produces
        // a finding (even a reassuring one) whenever it is answered at all.
        // Left undefined when no trace was even queried (no `trace=`, no
        // binary, not attached): "asked nothing" and "asked and got nothing
        // back" are different states, and this is the field that tells them
        // apart.
        let askedQuestions: { id: string; answered: boolean }[] | undefined;

        if (traceFile) {
          const binary = findTraceProcessor();
          const app = this.device.hello?.packageName;
          if (!binary) {
            notes.push(
              "trace_processor_shell was not found, so the trace could not be read. " +
                "`./gradlew portholeTraceProcessor` fetches it; the trace itself already " +
                "opens at ui.perfetto.dev.",
            );
          } else if (!app) {
            // GRA-157: "Not attached" is wrong during the handshake window —
            // the socket is up and a hello is already on its way, so telling
            // the caller to attach is misleading advice for something
            // already in progress. Name the wait instead when we can.
            notes.push(
              // GRA-162: isHandshaking() instead of `=== "handshaking"`.
              isHandshaking(this.device.state)
                ? "Still waiting on the app's first check-in, so there is no process yet to scope " +
                    "the trace to. Try again in a moment."
                : "Not attached to an app, so there is no process to scope the trace to.",
            );
          } else {
            // GRA-113: the one conversion, both directions, both through
            // moment.ts — `toBootNs` to scope the query in the trace's own
            // clock, `fromBootMs` (wrapped as `toUptimeMs` below) to place
            // whatever it answers back on Porthole's. This replaced an
            // open-coded version here that read whichever `clocks` sample it
            // found first rather than the one in force at `from`/`to`.
            const toUptimeMs = (bootNs: number) => fromBootMs(events, bootNs / 1e6)?.at ?? null;
            // askTrace now spawns asynchronously (GRA-82), so this await is new
            // here. It is safe: the admission gate above runs to completion
            // synchronously, before this handler's first await of any kind, so
            // making this one call asynchronous does not move it earlier than
            // a check that already finished.
            const asked = await askTrace({
              binary,
              trace: traceFile,
              packageName: app,
              fromNs: toBootNs(events, from),
              toNs: toBootNs(events, to),
              toUptimeMs,
            });
            findings.push(...asked.findings.map((f): Sourced => ({ ...f, source: "trace" })));
            notes.push(...asked.unanswered);
            // Matched against `unanswered`'s own text rather than a second
            // field threaded out of askTrace: every unanswered reason
            // already begins with the question's own `asks` sentence
            // (`runBatch`'s three push sites all format it
            // `${question.asks} — <reason>`), so this reads an existing
            // contract instead of adding a new one to perfetto.ts.
            askedQuestions = QUESTIONS.map((question) => ({
              id: question.id,
              answered: !asked.unanswered.some((line) => line.startsWith(`${question.asks} — `)),
            }));
          }
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            window: { from, to, ms: Math.max(0, to - from) },
            eventsExamined: within.length,
            metrics: live.metrics,
            findings,
            ...(askedQuestions ? { asked: askedQuestions } : {}),
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
            // Strict on purpose (GRA-157): this used to read exactly this
            // way, but under the old model "connected" was true the instant
            // the socket connected — this is what produced the
            // `connected: true, app: null, device: null` combo the ticket
            // that generalised the fix names as the bug for this endpoint.
            // Now that "connected" implies `hello` is set, that combo cannot
            // happen: during a handshake this reports connected: false with
            // app/device null, which is a coherent "not yet" instead of a
            // self-contradicting one. explainPortInUse()'s "stale, restart
            // it" wording is technically a beat early for the ~2s handshake
            // window itself, which is a smaller, pre-existing gap this
            // ticket does not close.
            // GRA-162: isConnected() instead of `=== "connected"`.
            connected: isConnected(this.device.state),
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
        const method = DB_ROUTES[path];
        if (!method) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "No such database endpoint." }));
          return;
        }
        const query = new URL(req.url ?? "/", "http://localhost");
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

      // Everything under /api/tools does something to the device, so none of it
      // may be reachable by a method a page can issue without meaning to. A GET
      // here used to fall through to the static handler and quietly return
      // index.html, which made a typo look like a working link.
      if (path.startsWith("/api/tools/")) {
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json", allow: "POST" });
          res.end(JSON.stringify({ ok: false, output: "This endpoint takes POST." }));
          return;
        }

        // A session token belongs here: minted at start, printed by the CLI in
        // the URL it opens, required on every call below. It would add nothing
        // against another origin — the admission check already refuses those —
        // and everything against a same-origin page loaded by accident, which
        // is the one caller a same-origin check cannot tell from the real UI.
        // It needs cli.ts to print it and the UI to carry it, so it is deferred
        // to the tickets that own those files.

        if (path === "/api/tools/restart") {
          const packageName = (this.device.hello as { packageName?: string } | null)?.packageName;
          if (!packageName) {
            // GRA-157: distinguish "still handshaking, this will resolve
            // itself shortly" from "no device at all" the same way the
            // findings endpoint above now does, rather than one generic
            // sentence for both.
            // GRA-162: isHandshaking() instead of `=== "handshaking"`.
            const output =
              isHandshaking(this.device.state)
                ? "Still waiting on the app's first check-in. Try again in a moment."
                : "The app has not said hello yet.";
            res.writeHead(409, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, output }));
            return;
          }
          const result = restartApp(packageName, this.serial);
          res.writeHead(result.ok ? 200 : 502, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        }

        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, output: "No such tool." }));
        return;
      }

      // GRA-116: "keep the last N seconds, from where you are already
      // looking" — the timeline UI's own save gesture, POST and
      // state-changing exactly like /api/tools/*, hardened the same way
      // (GRA-78's origin/host check already ran above, before routing; this
      // adds the POST-only refusal that route also carries). Deliberately
      // not nested under /api/tools/: that prefix's own comment defers a
      // session token to whichever ticket owns cli.ts and the UI's token
      // plumbing, and this route has no more business waiting on that than
      // /api/findings or /api/traces do.
      if (path === "/api/save") {
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json", allow: "POST" });
          res.end(JSON.stringify({ error: "This endpoint takes POST." }));
          return;
        }

        let raw: string;
        try {
          raw = await readRequestBody(req);
        } catch (error) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `Could not read the request body: ${(error as Error).message}` }));
          return;
        }

        let parsed: unknown;
        try {
          // An empty body is not malformed JSON — it is the shape a caller
          // sends when it means "just from/to", so this reads the same as
          // `{}` rather than failing the JSON.parse a literal empty string
          // would.
          parsed = raw.trim() === "" ? {} : JSON.parse(raw);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Malformed JSON body." }));
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "The request body must be a JSON object with `from` and `to`." }));
          return;
        }

        const body = parsed as { from?: unknown; to?: unknown; scenario?: unknown };
        const from = Number(body.from);
        const to = Number(body.to);
        if (body.from === undefined || body.to === undefined || !Number.isFinite(from) || !Number.isFinite(to)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "`from` and `to` are required and must be numbers (device uptime ms)." }));
          return;
        }
        if (from >= to) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "`from` must be less than `to`." }));
          return;
        }
        const scenarioInput =
          typeof body.scenario === "string" && body.scenario.trim() !== "" ? body.scenario.trim() : undefined;
        // Refused before anything is read or written: the scenario becomes
        // a file name, and QA round 1 showed "../../../../tmp/evil" escaping
        // .porthole/traces/ through this route.
        if (scenarioInput !== undefined) {
          try {
            validateScenario(scenarioInput);
          } catch (error) {
            if (error instanceof InvalidScenarioError) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: error.message }));
              return;
            }
            throw error;
          }
        }

        // The same merged view every window-taking tool reads (GRA-53's
        // `fillWindowFromDisk`) and the same trace builder `save_moment`
        // calls (GRA-54's `buildSavedTrace`) — no second implementation of
        // either, per this ticket's own ruling.
        const merged = await fillWindowFromDisk({
          root: this.device.sessions?.root ?? sessionsRoot(resolveProjectRoot().directory),
          identity: this.currentIdentity(),
          buffered: this.events as unknown as SessionEvent[],
          currentSessionDir: this.device.sessions?.currentDir() ?? null,
          from,
          to,
        });
        const events = merged.events as unknown as DeviceEvent[];
        const helloLike = this.device.hello ?? this.device.lastExited?.hello ?? null;
        const hello = (helloLike as unknown as Record<string, unknown>) ?? null;

        const scenario = scenarioInput ?? defaultScenarioName(from, to);
        const outPath = defaultOutPath(resolveProjectRoot().directory, scenario);

        const trace = buildSavedTrace({
          events,
          hello,
          window: { from, to },
          coveredFrom: merged.coveredFrom,
          coveredTo: merged.coveredTo,
          scenario,
        });
        await writeSavedTrace(trace, outPath);

        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            out: outPath,
            scenario,
            clippedMs: trace.clippedMs,
            findings: trace.findings.length,
          }),
        );
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
      // The separator matters: `resolve` strips the trailing one, so a bare
      // prefix test would also accept a sibling whose name merely starts with
      // the UI directory's — `dist-backup` next to `dist`. No such sibling
      // exists today, which is exactly the kind of fact that stops being true
      // without anyone noticing.
      const target = resolved.startsWith(resolve(UI_DIR) + sep)
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
    //
    // `noServer` rather than handing it the server, because letting ws own the
    // upgrade would leave the upgrade ungated: a WebSocket handshake is a
    // request a page can make cross-origin with no preflight, and this one
    // answers with the whole event buffer. The HTTP gate would be closed and
    // the socket beside it open.
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    server.on("upgrade", (req, socket, head) => {
      const refusal = this.refuse(req);
      if (refusal) {
        socket.end(
          `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n${refusal}\n`,
        );
        return;
      }
      if ((req.url ?? "/").split("?")[0] !== "/ws") {
        socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
    });
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

/** The raw request body, as text. A request with no body at all resolves to `""`, not a rejection. */
function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
