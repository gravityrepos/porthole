#!/usr/bin/env node
// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DeviceClient, isAttached, isHandshaking, type DeviceEvent } from "./device.js";
import { TimelineServer } from "./timeline.js";
import { readFileSync } from "node:fs";
import { resolveProjectRoot, resolveSdkDir, runAdb } from "./adb.js";
import { describe as describeMoment, fromBootMs, momentOf } from "./moment.js";
import {
  CPU_PROBE,
  describeSystem,
  parseCpu,
  parseMemory,
  parseThermal,
  parseTop,
  type SystemContext,
} from "./system.js";
import { askTrace, findTraceProcessor, QUESTIONS } from "./perfetto.js";
import { captureArgs, countPortholeLabels, describeCapture, planCapture } from "./systrace.js";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildTrace, type Finding } from "./trace.js";

/** Read, not retyped: a hardcoded version here drifts from the package. */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const HOST = process.env.PORTHOLE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORTHOLE_PORT ?? 8677);
const UI_PORT = Number(process.env.PORTHOLE_UI_PORT ?? 8678);

export interface PortholeServerOptions {
  /** Injected in tests; a real one is created in `createPortholeServer` otherwise. */
  device?: DeviceClient;
  timeline?: TimelineServer;
  version?: string;
}

export interface PortholeServer {
  server: McpServer;
  device: DeviceClient;
  timeline: TimelineServer;
}

/**
 * Builds the MCP server and registers every tool against `device` and
 * `timeline`, but does not start either and does not connect any transport.
 *
 * Split out from the boot sequence at the bottom of this file so a test can
 * hand it a fake device speaking the real wire protocol (see
 * `testing/harness.ts`) and a fresh `TimelineServer`, register the real
 * tools, and call them the way an agent would — through an MCP client over an
 * in-memory transport — rather than grepping this file's source for the
 * properties a tool is supposed to have.
 */
export function createPortholeServer(options: PortholeServerOptions = {}): PortholeServer {
  const device = options.device ?? new DeviceClient(HOST, PORT);
  const timeline = options.timeline ?? new TimelineServer(device, UI_PORT);

  const server = new McpServer({
    name: "porthole",
    version: options.version ?? pkg.version,
  });

  type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

  /** Summary line first, then the JSON. The summary is often the whole answer. */
  function ok(summary: string, payload: unknown): ToolResult {
    return {
      content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(payload, null, 2)}` }],
    };
  }

  function fail(error: unknown): ToolResult {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
    summarise: (value: T) => string,
  ) {
    try {
      const result = await device.request<T>(method, params);
      return ok(summarise(result), result);
    } catch (error) {
      return fail(error);
    }
  }

  // ---------------------------------------------------------------------------
  // windows
  // ---------------------------------------------------------------------------

  /**
   * The same three parameters on every tool that looks at a span of time.
   *
   * They used to differ per tool — `timeline` took only `sinceMs`, which made it
   * the one tool that could not be asked about a moment the others had just
   * named. An agent that cannot carry a window between calls compares two
   * different windows and does not notice.
   */
  const windowShape = {
    sinceMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Look back this many milliseconds from now. Ignored if `from` is given."),
    from: z
      .number()
      .int()
      .optional()
      .describe(
        "Absolute start on the device uptime clock that every event carries. Quote the `window` " +
          "from an earlier result to ask a second question about the same span.",
      ),
    to: z
      .number()
      .int()
      .optional()
      .describe("Absolute end, same clock. Defaults to the latest event."),
  };

  interface Window {
    sinceMs?: number;
    from?: number;
    to?: number;
  }

  /** The span actually examined, resolved against the buffer so it can be quoted back. */
  function resolveWindow(w: Window): { from: number; to: number; ms: number } | null {
    const events = timeline.buffer();
    if (events.length === 0) return null;
    const newest = events[events.length - 1].t;
    const oldest = events[0].t;
    const to = w.to ?? newest;
    const from = w.from ?? (w.sinceMs !== undefined ? to - w.sinceMs : oldest);
    return { from, to, ms: Math.max(0, to - from) };
  }

  // ---------------------------------------------------------------------------
  // what to do next
  // ---------------------------------------------------------------------------

  /**
   * The tool that shows a finding's evidence.
   *
   * Without this a finding is a dead end: it states a conclusion and leaves the
   * agent to guess which of eleven tools substantiates it. Guessing is where the
   * wandering starts, so each finding names its own next call.
   */
  const FOLLOW_UP: Record<string, { tool: string; why: string }> = {
    "db-on-main-thread": { tool: "blocking", why: "the queries, their SQL and how long each took" },
    "main-thread-stall": { tool: "blocking", why: "the stack the main thread was sitting in" },
    "http-failed": { tool: "inflight", why: "the failed calls with status and body previews" },
    "frames-dropped": { tool: "frames", why: "which phase dominated the janky frames" },
    "blocking-gc": {
      tool: "timeline",
      why: 'what allocated around each collection (kinds: ["gc"])',
    },
    "trim-memory": {
      tool: "timeline",
      why: 'the memory series around the trim (kinds: ["memory"])',
    },
    "work-retried": { tool: "inflight", why: "the jobs and their attempt counts" },
    "recompose-hotspot": {
      tool: "recompositions",
      why: "the per-node counts and the state keys written just before",
    },
  };

  function withFollowUp(finding: Finding) {
    const next = FOLLOW_UP[finding.id];
    return next
      ? { ...finding, next: { tool: next.tool, window: "quote `window` above", shows: next.why } }
      : finding;
  }

  // ---------------------------------------------------------------------------
  // tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "porthole_status",
    {
      title: "Porthole status",
      description:
        "Whether the porthole is connected to a running app, which collectors are active, and what to " +
        "do if it is not. Call this when another tool reports it cannot reach the device.\n\n" +
        "This tool answers 'is it plugged in', not 'is anything wrong'. For that, call `findings`.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (): Promise<ToolResult> => {
      // GRA-119 AC5: name which SDK and which project root this run resolved
      // to, and where each came from, so "adb resolved to the wrong SDK" is
      // something this tool can actually diagnose instead of something an
      // agent has to take on faith. resolveSdkDir()/resolveProjectRoot() in
      // adb.ts already compute both; this just reports them.
      const sdkDir = resolveSdkDir();
      const projectRoot = resolveProjectRoot();
      const payload = {
        state: device.state,
        host: HOST,
        port: PORT,
        app: device.hello,
        timelineUi: timeline.isRunning() ? timeline.url() : null,
        bufferedEvents: timeline.buffer().length,
        lastError: device.lastError,
        // GRA-96: null on a healthy handshake, otherwise the same sentence
        // `summary` uses below — reported in the payload too so a caller
        // reading structured data (not just the text) can branch on it
        // without string-matching `summary`.
        protocolMismatch: device.protocolMismatch,
        sdkDir: sdkDir.directory,
        sdkDirSource: sdkDir.source,
        projectRoot: projectRoot.directory,
        projectRootSource: projectRoot.source,
      };
      // GRA-157: DeviceClient now has a "handshaking" ConnectionState for the
      // gap between the socket connecting and hello resolving, so this reads
      // `device.state` alone — pendingMessage() names the disconnected and
      // handshaking stories the same way `findings` does (AC3), and returns
      // null only when state === "connected", which now guarantees `hello`
      // is set, so the non-null assertion below is the invariant, not a hope.
      const pending = device.pendingMessage();
      // GRA-96: a protocol mismatch takes priority over the normal "here is
      // what's connected" sentence — hello did land and the socket is fine,
      // but the one thing worth saying is that the two sides disagree on the
      // wire format, not the collector list a mismatched build may not even
      // be able to report honestly. This is what turns AC1's "specific,
      // actionable message... not a generic failure" into the actual summary
      // text an agent reads, rather than a field it has to know to check.
      const summary =
        pending ??
        device.protocolMismatch ??
        `Connected to ${device.hello!.packageName} on ${device.hello!.device} ` +
          `(API ${device.hello!.sdkInt}). Collectors: ${device.hello!.collectors.join(", ")}.`;
      return ok(summary, payload);
    },
  );

  server.registerTool(
    "findings",
    {
      title: "What is wrong right now",
      description:
        "Start here. Everything the porthole can currently say is wrong, ranked, each with how " +
        "strongly it can be claimed and which tool shows its evidence.\n\n" +
        "The other tools return measurements and leave the conclusion to you. This one draws the " +
        "conclusions the data actually supports, which is a shorter list than it looks: queries on " +
        "the main thread, stalls, failed calls, dropped frames, blocking collections, memory trims, " +
        "retried jobs, recomposition hotspots.\n\n" +
        "`confidence` is load-bearing and worth repeating to whoever reads your answer. 'observed' " +
        "means the device reported it: a query ran on the main thread, a frame missed its deadline. " +
        "'correlated' means two things happened close together, which is ordering and not " +
        "causation. Do not upgrade a correlated finding to a cause because it is the only one you " +
        "have.\n\n" +
        "`clippedMs` says how much of the window asked for fell outside what is still buffered. " +
        "Non-zero means part of the question was never examined, which is a different answer from " +
        "there being nothing there.\n\n" +
        "An empty list means nothing crossed a threshold in this window. It does not mean the app " +
        "is fast, and it does not mean the window contained the problem — check `window` against " +
        "the moment you care about before concluding anything from silence.",
      inputSchema: windowShape,
      annotations: { readOnlyHint: true },
    },
    async ({ sinceMs, from, to }): Promise<ToolResult> => {
      const span = resolveWindow({ sinceMs, from, to });
      // GRA-157: "connected" here is the loose sense porthole_status also
      // uses — the socket is up, whether or not hello has landed — because
      // that is the fact an agent deciding whether to keep polling actually
      // wants, and it is what keeps this field agreeing with the summary
      // text below (both handshaking and connected get the non-wall story).
      // buildTrace(), further down, wants the strict sense instead — hello
      // itself, not a boolean — and asks device.hello directly for it.
      // GRA-162: isAttached() replaces the inline `=== "handshaking" ||
      // === "connected"` so a fifth ConnectionState fails `tsc` here instead
      // of silently reading as not-connected. Same boolean, no behaviour
      // change — GRA-163 (pending) is the ticket that may change what this
      // field actually means.
      const connected = isAttached(device.state);
      if (!span) {
        // resolveWindow returns null whenever the ring is empty, which is not
        // the same thing as the device being unreachable — hello can have
        // landed seconds ago with nothing collected yet. Printing the full
        // troubleshooting wall in that case sends the first call after every
        // install chasing a socket that was never the problem.
        const pending = device.pendingMessage();
        if (pending !== null) {
          return ok(pending, { window: null, findings: [], connected });
        }
        const summary = `Connected to ${device.hello!.packageName}, nothing buffered yet. Ask again in a moment.`;
        return ok(summary, { window: null, findings: [], connected });
      }

      const buffered = timeline.buffer();
      const events = buffered.filter((e) => e.t >= span.from && e.t <= span.to);

      // Asking about a moment the ring no longer holds returns nothing, which is
      // indistinguishable from a moment when nothing happened. They are opposite
      // answers and only one of them is about the app.
      const oldest = buffered[0]?.t ?? span.from;
      const newest = buffered[buffered.length - 1]?.t ?? span.to;
      const clipped = {
        start: span.from < oldest ? oldest - span.from : 0,
        end: span.to > newest ? span.to - newest : 0,
      };
      const trace = buildTrace({
        // The same analyser the headless capture runs, pointed at the live
        // buffer instead of a recorded scenario. One analyser, so a finding
        // means the same thing in CI as it does in an editor.
        scenario: "live",
        events,
        hello: (device.hello as unknown as Record<string, unknown>) ?? null,
        durationMs: span.ms,
        withEvents: false,
      });

      const findings = trace.findings.map(withFollowUp);
      const payload = {
        window: { from: span.from, to: span.to, ms: span.ms },
        examined: { from: Math.max(span.from, oldest), to: Math.min(span.to, newest) },
        buffered: { from: oldest, to: newest, events: buffered.length },
        clippedMs: clipped,
        eventsExamined: events.length,
        metrics: trace.metrics,
        findings,
        connected,
      };

      const shortfall = clipped.start + clipped.end;
      const missing =
        shortfall > 0
          ? ` ${Math.round(shortfall / 100) / 10}s of the window asked for is older or newer than ` +
            "anything buffered, so it was not examined at all."
          : "";

      if (findings.length === 0) {
        return ok(
          shortfall > span.ms * 0.5
            ? `Almost none of that window is in the buffer${missing} This is not a quiet app; ` +
                "it is a question the buffer cannot answer."
            : `Nothing crossed a threshold in the ${Math.round(span.ms / 1000)}s examined ` +
                `(${events.length} events). That is not the same as the app being fast.${missing}`,
          payload,
        );
      }

      const worst = trace.findings[0];
      const bySeverity = trace.findings.reduce<Record<string, number>>((acc, f) => {
        acc[f.severity] = (acc[f.severity] ?? 0) + 1;
        return acc;
      }, {});
      const tally = Object.entries(bySeverity)
        .map(([severity, n]) => `${n} ${severity}`)
        .join(", ");

      return ok(
        `${findings.length} finding(s) over ${Math.round(span.ms / 1000)}s (${tally}). ` +
          `Worst: ${worst.title} [${worst.confidence}].${missing}`,
        payload,
      );
    },
  );

  server.registerTool(
    "system_context",
    {
      title: "What the rest of the device was doing",
      description:
        "Thermal state, CPU governor and clock, the busiest processes, and system memory pressure. " +
        "Read straight off the device over adb.\n\n" +
        "This is the half Porthole cannot see. It watches one process, so when `blocking` reports a " +
        "stall whose stack bottoms out in a native read, or `frames` blames swapBuffers, the reason " +
        "is usually below the app and none of the other tools can reach it. A throttled device, a " +
        "governor holding the cores down, or another process eating the CPU explains a regression " +
        "that no code change accounts for.\n\n" +
        "Reports only what it read. Values are current, not historical — this says what is true now, " +
        "not what was true during a window you are investigating, so take it while the problem is " +
        "happening. Sources it could not parse are listed in `unavailable` rather than omitted, " +
        "because a missing thermal reading and a cool device are not the same thing.\n\n" +
        "It draws no conclusions. Two cores below maximum is a fact; that it is why your app is " +
        "slow is a guess, and this tool does not know what your app was doing.",
      inputSchema: {
        serial: z
          .string()
          .optional()
          .describe("Device serial, when more than one is attached. `adb devices` lists them."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ serial }): Promise<ToolResult> => {
      const unavailable: SystemContext["unavailable"] = [];

      const read = (source: string, args: string[]): string | null => {
        const result = runAdb(args, serial);
        if (!result.ok) {
          unavailable.push({ source, reason: result.output.split("\n")[0].slice(0, 160) });
          return null;
        }
        return result.output;
      };

      const thermalOut = read("thermalservice", ["shell", "dumpsys", "thermalservice"]);
      const cpuOut = read("cpufreq", ["shell", CPU_PROBE]);
      const topOut = read("cpuinfo", ["shell", "dumpsys", "cpuinfo"]);
      const memOut = read("meminfo", ["shell", "dumpsys", "meminfo"]);

      const context: SystemContext = {
        thermal: thermalOut === null ? null : parseThermal(thermalOut),
        cpu: cpuOut === null ? null : parseCpu(cpuOut),
        top: topOut === null ? [] : parseTop(topOut),
        memory: memOut === null ? null : parseMemory(memOut),
        unavailable,
      };

      return ok(describeSystem(context), context);
    },
  );

  server.registerTool(
    "ask_system_trace",
    {
      title: "Ask a system trace about a window",
      description:
        "Runs a fixed set of questions against a recorded trace, scoped to one window and one " +
        "process, and returns findings in the same vocabulary as everything else here.\n\n" +
        "It performs, without a person, the steps someone otherwise does by hand in a trace " +
        "viewer: find the moment worth looking at, drag out the window, pick the app out of the " +
        "process list, and export. Porthole already holds all four — the window comes from a " +
        "finding, the package from the handshake with the device — which is the only reason this " +
        "can be automated at all.\n\n" +
        "What it is for is ruling causes out. `findings` can say a frame was late and that " +
        "composition dominated it. It cannot say whether the device was starving the app of CPU, " +
        "blocking it on I/O, or compiling its own bytecode in the background. Answering no to " +
        "each of those is what turns a suspicion into a conclusion, and answering yes to one " +
        "means the app's own work was never the whole story.\n\n" +
        "Deliberately not a SQL interface. The questions are fixed, because an agent handed a " +
        "hundred tables and no guidance assembles an answer from whichever guess came back " +
        "non-empty — which is the failure this whole surface was reshaped to avoid.\n\n" +
        "Needs `trace_processor_shell`, which is not bundled — it is a large platform-specific " +
        "binary — but is fetched on request: `./gradlew portholeTraceProcessor` downloads the " +
        "pinned release, checks its SHA-256 and caches it where this tool looks.",
      inputSchema: {
        trace: z.string().describe("Path to a .pftrace, as returned by capture_system_trace."),
        from: z
          .number()
          .int()
          .optional()
          .describe("Window start on the device uptime clock. Quote a finding's `window`."),
        to: z.number().int().optional().describe("Window end, same clock."),
        packageName: z
          .string()
          .optional()
          .describe("Defaults to the app the porthole is attached to."),
        traceProcessor: z.string().optional().describe("Path to trace_processor_shell."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ trace, from, to, packageName, traceProcessor }): Promise<ToolResult> => {
      // GRA-157: connection state checked before the trace_processor lookup,
      // not after. A device still mid-handshake is not the caller's fault and
      // not fixed by anything on this machine, so naming that first means a
      // caller who has not connected yet is never told to go install a
      // binary when the real, more immediate blocker is the device.
      const app = packageName ?? device.hello?.packageName;
      if (!app) {
        // "Connect to the app" was printed even while the socket was already
        // connected and just waiting on hello — telling someone to do a
        // thing that is already in progress. Naming the handshake instead of
        // the generic advice is the whole fix; the advice itself (pass
        // `packageName`) still applies either way.
        // GRA-162: isHandshaking() instead of `=== "handshaking"` — same
        // exhaustiveness argument as isAttached() above.
        const because =
          isHandshaking(device.state)
            ? "the app is still waiting on its first check-in — try again in a moment, "
            : "connect to the app, ";
        return fail(
          `No package to scope to: ${because}or pass \`packageName\` — without it the questions ` +
            "answer for the whole device, which is a different question.",
        );
      }

      const binary = traceProcessor ?? process.env.PORTHOLE_TRACE_PROCESSOR ?? findTraceProcessor();
      if (!binary) {
        return fail(
          "No trace_processor_shell found. Run `./gradlew portholeTraceProcessor` in the app's " +
            "project: it downloads the pinned Perfetto release, verifies its checksum and caches " +
            "it where this tool looks, so nothing further needs configuring. An existing copy " +
            "works too — set PORTHOLE_TRACE_PROCESSOR or pass `traceProcessor`. Either way the " +
            "trace itself is already readable at ui.perfetto.dev.",
        );
      }

      // The window arrives in Porthole's clock and the trace is stamped in the
      // boot clock, so it has to be converted before it means anything here.
      const events = timeline.buffer();
      const span = resolveWindow({ from, to });
      if (!span) {
        // GRA-154 (absorbed into GRA-157 AC7): this used to say "Nothing
        // buffered" unconditionally — a third, different vocabulary from
        // findings/what_was_happening for the identical empty-ring
        // condition. pendingMessage() brings the wording in line with
        // theirs. This one stays an error result rather than switching to
        // `ok` like the other two: there is genuinely no window here to ask
        // trace_processor about, nothing partial to return the way an empty
        // findings list or a "nothing happened here" moment still can.
        const pending = device.pendingMessage();
        return fail(
          pending ??
            "Connected, but nothing buffered yet, so there is no window to scope the trace to. " +
              "Ask again in a moment.",
        );
      }
      const sample = events.find((e) => e.event === "clocks");
      const sleepMs = sample ? Number(sample.data.sleepMs) || 0 : 0;
      const bounds = {
        fromNs: (span.from + sleepMs) * 1e6,
        toNs: (span.to + sleepMs) * 1e6,
      };

      const { findings: traceFindings, unanswered } = await askTrace({
        binary,
        trace,
        packageName: app,
        fromNs: bounds.fromNs,
        toNs: bounds.toNs,
      });

      const findings = traceFindings.map(withFollowUp);
      const payload = {
        trace,
        app,
        window: { from: span.from, to: span.to, sleepMs },
        asked: QUESTIONS.map((q) => q.asks),
        unanswered,
        findings,
      };

      const failures = unanswered;
      const summary = findings.length
        ? `${findings.length} finding(s) from the trace. ${findings[0].title}.`
        : "The trace had nothing to add about that window.";
      return ok(
        summary + (failures.length ? ` ${failures.length} question(s) failed.` : ""),
        payload,
      );
    },
  );

  server.registerTool(
    "capture_system_trace",
    {
      title: "Record a Perfetto trace",
      description:
        "Records a system trace on the device, pulls it to disk, and returns the path. Does not " +
        "return the trace itself: a ten-second capture is tens of megabytes of protobuf, and it is " +
        "not something to read — it is something to open.\n\n" +
        "The reason to take one here rather than by hand is that the app's own spans are already " +
        "inside it. The runtime writes navigations, HTTP calls, queries and main-thread stalls as " +
        "atrace sections, so the capture arrives annotated with what the app was doing and not only " +
        "what the kernel was doing. The result says how many Porthole labels it found, which is how " +
        "you know the annotation actually happened.\n\n" +
        "Use it when Porthole has found something it cannot explain — a stall whose stack bottoms " +
        "out below the app, or jank blamed on swapBuffers — and you need to see what the rest of " +
        "the system was doing at that moment. `findings` gives you the window worth looking at; " +
        "this gives you the depth at it.\n\n" +
        "Blocks for the requested duration. Reproduce the problem while it runs.",
      inputSchema: {
        seconds: z
          .number()
          .int()
          .positive()
          .max(120)
          .optional()
          .describe("How long to record. Default 10."),
        categories: z
          .array(z.string())
          .optional()
          .describe(
            "atrace categories. Defaults to a set aimed at jank. `app` is always included, " +
              "since without it none of Porthole's own sections are recorded.",
          ),
        outputDir: z
          .string()
          .optional()
          .describe("Where to write it. Defaults to .porthole/traces under the working directory."),
        packages: z
          .array(z.string())
          .optional()
          .describe(
            "Packages whose app-tag sections to record. Defaults to the app the porthole is " +
              "attached to. Without one, the trace has no Porthole slices in it.",
          ),
        serial: z.string().optional().describe("Device serial, when more than one is attached."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ seconds, categories, outputDir, packages, serial }): Promise<ToolResult> => {
      // GRA-157: `device.hello ? [...] : []` used to fall through to an
      // unscoped capture — silently, with nothing in the result saying so —
      // whenever this landed in the handshake window, since state was
      // already "connected" there under the old model. An unscoped capture
      // has none of Porthole's own slices in it, which defeats the point of
      // this tool, so when we can name the actual reason (a hello is
      // genuinely on its way) this fails and says so instead of guessing.
      // Fully disconnected keeps the old permissive behaviour: apps: []
      // captures the whole device, same as always.
      // GRA-162: isHandshaking() instead of `=== "handshaking"`.
      if (!packages?.length && isHandshaking(device.state)) {
        return fail(
          "Still waiting on the app's first check-in, so there is no package to scope this " +
            "capture to yet. Try again in a moment, or pass `packages` explicitly to capture " +
            "unscoped right now.",
        );
      }
      // Default to whatever app the porthole is attached to: that is the one
      // whose sections are worth recording, and asking for it again is friction.
      const apps = packages?.length ? packages : device.hello ? [device.hello.packageName] : [];
      const plan = planCapture({ seconds, categories, apps });

      const recorded = runAdb(captureArgs(plan), serial);
      if (!recorded.ok) {
        return fail(
          `Could not record: ${recorded.output}\n` +
            "On-device Perfetto needs Android 9 or newer, and the traced service must be running.",
        );
      }

      // Default under .porthole/, which the project's gitignore already covers —
      // a multi-megabyte trace should not be a candidate for committing.
      const dir = resolve(outputDir ?? join(process.cwd(), ".porthole", "traces"));
      mkdirSync(dir, { recursive: true });
      const local = join(dir, plan.devicePath.split("/").pop() as string);

      const pulled = runAdb(["pull", plan.devicePath, local], serial);
      // Tidy up regardless: the device's trace directory is not ours to fill.
      runAdb(["shell", "rm", "-f", plan.devicePath], serial);

      if (!pulled.ok) return fail(`Recorded, but could not pull it: ${pulled.output}`);

      const bytes = statSync(local).size;
      const result = {
        path: local,
        bytes,
        seconds: plan.seconds,
        categories: plan.categories,
        portholeLabels: countPortholeLabels(readFileSync(local)),
        notes: plan.notes,
      };
      return ok(describeCapture(result), result);
    },
  );

  server.registerTool(
    "what_was_happening",
    {
      title: "What was happening at a moment",
      description:
        "The narrative for one instant: which screen, with what arguments, what was in flight, what " +
        "the main thread was doing, and what state had just been written.\n\n" +
        "Built for the question a system trace cannot answer. Perfetto will tell you which threads " +
        "ran at 00:42.318 and for how long; it has no idea that you had just opened the cart, that " +
        "a checkout call had been open for 600ms, or that the query blocking the frame was on the " +
        "main thread. Paste the timestamp here and get the part Perfetto is missing.\n\n" +
        "Give it `at` in the device uptime clock every Porthole event carries, or `bootMs` for a " +
        "CLOCK_BOOTTIME reading taken from a Perfetto trace — the two differ by however long the " +
        "device has been in deep sleep, and the conversion uses the clock sample in force at that " +
        "moment rather than the newest one.\n\n" +
        "Durations are as they were then, not as they turned out. A call open for 600ms at the " +
        "moment asked about reports 600ms even if it ran for four seconds, because the question is " +
        "what was true then. A span that never finished says so.\n\n" +
        "Bounded by what the timeline server still holds. A moment older than the buffer cannot be " +
        "answered and will say so rather than return an empty one, which would read as 'nothing " +
        "was happening'.",
      inputSchema: {
        at: z
          .number()
          .int()
          .optional()
          .describe("The moment, in the device uptime clock. Omit if giving `bootMs`."),
        bootMs: z
          .number()
          .int()
          .optional()
          .describe(
            "The moment as CLOCK_BOOTTIME milliseconds, which is what a Perfetto trace stamps with.",
          ),
        spreadMs: z
          .number()
          .int()
          .positive()
          .max(60_000)
          .optional()
          .describe("How far either side to look for context. Default 2000."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ at, bootMs, spreadMs }): Promise<ToolResult> => {
      // GRA-166 item 3: computed once, up front, so every branch below
      // shares one answer instead of some branches computing it and others
      // omitting the key outright. That omission was the actual bug: a
      // consumer reading `json.connected` got `false`, `true` or `undefined`
      // depending on which branch answered, and `undefined` is falsy — a
      // caller doing the obvious thing silently read "not connected" from a
      // response that never made that claim. `connected` mirrors findings'
      // loose sense exactly (handshaking or connected, not just connected) —
      // see GRA-162's isAttached() and the note on findings' own `connected`
      // above for why this is not the inline `===` pair it used to be.
      const connected = isAttached(device.state);
      const events = timeline.buffer();
      if (events.length === 0) {
        // GRA-154, absorbed into GRA-157 as AC7: an empty ring is not the
        // same as a disconnected device — hello can have landed seconds ago
        // with nothing collected yet, and printing the "Not connected" wall
        // in that case blames the connection for a buffer that is merely
        // young. Same distinction `findings` and `porthole_status` make,
        // through the same method, so all three tell the same story about
        // an empty-but-attached device instead of each guessing separately.
        const pending = device.pendingMessage();
        if (pending !== null) {
          return ok(pending, { moment: null, connected });
        }
        return ok(
          `Connected to ${device.hello!.packageName}, nothing buffered yet. Ask again in a moment.`,
          { moment: null, connected },
        );
      }

      let moment_at = at;
      let clock: { bootMs: number; sleepMs: number; sampledAt: number } | null = null;

      if (moment_at === undefined && bootMs !== undefined) {
        const converted = fromBootMs(events, bootMs);
        if (!converted) {
          return ok(
            "No clock sample in the buffer, so a boot-clock timestamp cannot be placed. " +
              "The app must have been running with Porthole attached for that to exist.",
            { moment: null, bootMs, connected },
          );
        }
        moment_at = converted.at;
        // Keep the boot reading that was asked about, so the answer shows both
        // ends of the conversion rather than only the result.
        clock = { bootMs, sleepMs: converted.sleepMs, sampledAt: converted.sampledAt };
      }

      if (moment_at === undefined) {
        return ok("Give either `at` or `bootMs`.", { moment: null, connected });
      }

      // Outside the buffer is a different answer from "nothing happened", and
      // conflating them is how an agent concludes the app was idle.
      const oldest = events[0].t;
      const newest = events[events.length - 1].t;
      if (moment_at < oldest || moment_at > newest) {
        return ok(
          `That moment is outside what is buffered (${oldest}–${newest} on the uptime clock). ` +
            "Not that nothing was happening — it is no longer held.",
          { moment: null, asked: moment_at, buffered: { from: oldest, to: newest }, clock, connected },
        );
      }

      const moment = { ...momentOf(events, moment_at, spreadMs ?? 2_000), clock };
      return ok(describeMoment(moment), { ...moment, connected });
    },
  );

  server.registerTool(
    "recompositions",
    {
      title: "Recomposition counts",
      description:
        "How many times each instrumented composable recomposed, and which state keys were written " +
        "just before each recomposition. Use it to find the composable doing needless work and the " +
        "state that keeps invalidating it.\n\n" +
        "Two limits worth holding in mind: only call sites wrapped in PortholeScreen or " +
        "Modifier.portholeNode are counted, so an absent composable is uninstrumented rather than " +
        "idle; and triggeredBy is a temporal correlation within a ~32ms window, not a causal read " +
        "of the invalidation graph, so several states changing in one frame all get listed.\n\n" +
        "Keys like 'unnamed#3f2a1c' are state objects nobody named. In a Compose app most of them " +
        "belong to the framework — ripples, scroll offsets, focus, animation clocks — and are not " +
        "worth chasing. A key that is yours and still unnamed means its owner was never registered: " +
        "Porthole.registerViewModel for a ViewModel, collectAsNamedState for a Flow, " +
        "rememberNamedState for state a composable creates for itself.\n\n" +
        "A key carrying 'holds' is anonymous state that was found holding one of the app's own " +
        "types, so it is definitely the app's and definitely unregistered — that one is worth " +
        "chasing. Its absence proves nothing: an unregistered Int is indistinguishable from a " +
        "ripple, so most of the app's own unnamed state will not be flagged.",
      inputSchema: {
        screen: z
          .string()
          .optional()
          .describe(
            "Only nodes on this screen, matched against the enclosing PortholeScreen name.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Busiest N nodes. Default 50; the tail is rarely what you are looking for."),
        ...windowShape,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ screen, sinceMs, from, to, limit }): Promise<ToolResult> =>
      call<{
        nodes: Array<{
          name: string;
          count: number;
          triggeredBy: Array<{ key: string; count: number }>;
        }>;
        totalNodes?: number;
        truncated?: boolean;
        unattributedWrites: Array<{ key: string; count: number }>;
      }>("recompositions", { screen, sinceMs, from, to, limit: limit ?? 50 }, (report) => {
        if (report.nodes.length === 0) {
          return "No instrumented composable recomposed in that window.";
        }
        const top = report.nodes[0];
        const cause = top.triggeredBy[0];
        const total = report.nodes.reduce((sum, node) => sum + node.count, 0);
        // A capped list that does not say it is capped reads as the whole
        // truth, which is how "only three composables recomposed" gets believed.
        const cut = report.truncated
          ? ` Busiest ${report.nodes.length} of ${report.totalNodes ?? report.nodes.length} nodes shown.`
          : "";
        return (
          `${total} recompositions across ${report.nodes.length} nodes. ` +
          `Worst: ${top.name} at ${top.count}` +
          (cause ? `, most often after a write to ${cause.key} (${cause.count} of them).` : ".") +
          cut
        );
      }),
  );

  server.registerTool(
    "semantics_tree",
    {
      title: "Semantics tree",
      description:
        "The Compose semantics tree with a stable id per node. stableId is a structural path hash: " +
        "the same UI produces the same id across captures and across process restarts, so two " +
        "captures can be diffed. Nodes carrying a porthole node id line up with the ids in the " +
        "recompositions report.\n\n" +
        "A snapshot of what is on screen now. It says nothing about cost — a large tree is not a slow one — so do not infer performance from its shape; use `frames` for that.",
      inputSchema: {
        merged: z
          .boolean()
          .optional()
          .describe("Merged tree (what accessibility services see). Default true."),
        maxDepth: z.number().int().positive().optional().describe("Depth cap. Default 40."),
        maxNodes: z.number().int().positive().optional().describe("Node budget. Default 1500."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ merged, maxDepth, maxNodes }): Promise<ToolResult> =>
      call<{ root: unknown; error?: string }>(
        "semantics_tree",
        { merged, maxDepth, maxNodes },
        (tree) =>
          tree.error ? tree.error : tree.root ? "Captured the semantics tree." : "Empty tree.",
      ),
  );

  server.registerTool(
    "nav_state",
    {
      title: "Navigation state",
      description:
        "The current back stack with each entry's route, arguments and lifecycle state, plus the " +
        "deep link that opened the app if there was one. Answers 'how did I get to this screen' " +
        "and 'what arguments is it actually holding', which is usually where the bug is.\n\n" +
        'Present tense only. This is the stack as it is now, not how it got that way — for the order things happened in, ask `timeline` with kinds: ["nav"].',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (): Promise<ToolResult> =>
      call<{ current?: { route?: string } | null; backStack: unknown[]; error?: string }>(
        "nav_state",
        {},
        (nav) =>
          nav.error ??
          `At ${nav.current?.route ?? "an unnamed destination"} with ${nav.backStack.length} entries on the stack.`,
      ),
  );

  server.registerTool(
    "state",
    {
      title: "ViewModel state",
      description:
        "Current values of the state held by registered ViewModels. Each field says whether writes " +
        "to it are attributable — meaning snapshot state the recomposition report can name. A " +
        "StateFlow is never attributable on its own; collectAsNamedState is what makes the State " +
        "it produces nameable.\n\n" +
        "Only registered owners appear. An empty result means nothing was registered, not that the app holds no state, so do not read absence here as evidence about the app.",
      inputSchema: {
        viewModel: z
          .string()
          .optional()
          .describe("Registered name or class name. Omit for every registered owner."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ viewModel }): Promise<ToolResult> =>
      call<{ owners: Array<{ name: string; fields: unknown[] }> }>(
        "state",
        { viewModel },
        (dump) => {
          if (dump.owners.length === 0) {
            return 'No ViewModels registered. Call Porthole.registerViewModel("CartViewModel", vm) where you obtain it.';
          }
          return dump.owners
            .map((owner) => `${owner.name} (${owner.fields.length} fields)`)
            .join(", ");
        },
      ),
  );

  server.registerTool(
    "inflight",
    {
      title: "In-flight work",
      description:
        "Open HTTP calls with the phase each is stuck in, database queries currently executing and " +
        "the thread running them, and enqueued or running WorkManager jobs. This is the tool for " +
        "'why is this screen still spinning'.\n\n" +
        "Also returns recentHttp: the last 25 finished calls with status, headers and — when the " +
        "app opted in via BodyCapture — request and response body previews. A body with text:null " +
        "carries an omittedReason saying why it was not captured (disabled, wrong content type, " +
        "one-shot stream); that is different from the call having had no body at all.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (): Promise<ToolResult> =>
      call<{
        http: Array<{ method: string; url: string; phase: string; elapsedMs: number }>;
        queries: Array<{ sql: string; kind: string; elapsedMs: number; thread: string }>;
        work: Array<{ name: string; state: string }>;
        recentHttp?: Array<{
          method: string;
          url: string;
          status: number | null;
          elapsedMs: number;
        }>;
      }>("inflight", {}, (flight) => {
        const parts: string[] = [];
        if (flight.http.length) {
          const worst = flight.http[0];
          parts.push(
            `${flight.http.length} HTTP call(s), oldest ${worst.method} ${worst.url} ` +
              `in '${worst.phase}' for ${worst.elapsedMs}ms`,
          );
        }
        if (flight.queries.length) {
          const writes = flight.queries.filter((q) => q.kind === "write").length;
          parts.push(
            `${flight.queries.length} query(ies) running on ${flight.queries[0].thread}` +
              (writes ? ` (${writes} write)` : ""),
          );
        }
        if (flight.work.length) parts.push(`${flight.work.length} work job(s)`);

        const recent = flight.recentHttp ?? [];
        const failed = recent.filter((c) => c.status !== null && c.status >= 400);
        if (recent.length) {
          parts.push(
            `${recent.length} recent call(s)` +
              (failed.length ? `, ${failed.length} with a ${failed[0].status}` : ""),
          );
        }
        return parts.length ? parts.join("; ") : "Nothing in flight.";
      }),
  );

  server.registerTool(
    "frames",
    {
      title: "Frame timing",
      description:
        "How many frames the app dropped, and where the time went in the worst ones. This is the " +
        "outcome every other collector is a proxy for: a recomposition count only matters because " +
        "of what it does to frame time.\n\n" +
        "worstPhase names the stage that dominated a janky frame, which is what decides where to " +
        "look: layoutMeasure or draw points at composition doing too much, gpu or swapBuffers at " +
        "overdraw or an expensive shader, unknownDelay at the main thread being busy with " +
        "something that is not drawing at all. Pair a jank cluster with recompositions over the " +
        "same from/to window to see whether recomposition is the cause.\n\n" +
        "Frames with firstDraw are a window being drawn for the first time and are expected to be " +
        "slow. Needs API 24 or newer.",
      inputSchema: {
        ...windowShape,
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Worst N frames. Default 20."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceMs, from, to, limit }): Promise<ToolResult> =>
      call<{
        totalFrames: number;
        jankyFrames: number;
        frameIntervalMs: number;
        worst: Array<{
          totalMs: number;
          missedFrames: number;
          worstPhase: string;
          firstDraw: boolean;
        }>;
      }>("frames", { sinceMs, from, to, limit }, (report) => {
        if (report.totalFrames === 0) return "No frames observed yet.";
        const rate = ((report.jankyFrames / report.totalFrames) * 100).toFixed(1);
        const worst = report.worst[0];
        const byPhase: Record<string, number> = {};
        for (const frame of report.worst) {
          byPhase[frame.worstPhase] = (byPhase[frame.worstPhase] ?? 0) + 1;
        }
        const phases = Object.entries(byPhase)
          .sort((a, b) => b[1] - a[1])
          .map(([phase, n]) => `${phase} ${n}`)
          .join(", ");
        return (
          `${report.jankyFrames} of ${report.totalFrames} frames janky (${rate}%), ` +
          `budget ${report.frameIntervalMs}ms.` +
          (worst
            ? ` Worst ${worst.totalMs}ms, ${worst.missedFrames} refresh(es) missed, mostly ` +
              `${worst.worstPhase}. Across the worst frames: ${phases}.`
            : "")
        );
      }),
  );

  server.registerTool(
    "blocking",
    {
      title: "Main thread blocking",
      description:
        "What held the main thread: stalls longer than the threshold, with the stack the main " +
        "thread was in at the time, and any database query that ran on it.\n\n" +
        "Stalls are found by pinging the main looper and timing the reply, so the duration is how " +
        "long everything queued ahead of the ping took. The stack is sampled once, when the ping " +
        "goes overdue, and app frames are listed first because the top frame is usually a native " +
        "read and the line you can change is a few frames down.\n\n" +
        "Database work on the main thread is reported however fast it was: a 4ms disk read in the " +
        "frame loop is a defect that has not bitten yet. For hitches shorter than the threshold, " +
        "use `frames` instead — that measures every frame, this one catches the big stops.",
      inputSchema: {
        ...windowShape,
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Worst N of each. Default 20."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceMs, from, to, limit }): Promise<ToolResult> =>
      call<{
        stalls: Array<{ durationMs: number; stack: string }>;
        mainThreadQueries: Array<{ sql: string; elapsedMs: number; kind: string }>;
        stallThresholdMs: number;
      }>("blocking", { sinceMs, from, to, limit }, (report) => {
        const parts: string[] = [];
        if (report.stalls.length) {
          const worst = report.stalls[0];
          parts.push(
            `${report.stalls.length} stall(s) over ${report.stallThresholdMs}ms, worst ` +
              `${worst.durationMs}ms in ${worst.stack.split("\n")[0]}`,
          );
        }
        if (report.mainThreadQueries.length) {
          const worst = report.mainThreadQueries[0];
          parts.push(
            `${report.mainThreadQueries.length} database ${report.mainThreadQueries.length === 1 ? "query" : "queries"} ` +
              `on the main thread, worst ${worst.elapsedMs}ms: ${worst.sql.slice(0, 80)}`,
          );
        }
        return parts.length ? parts.join(". ") : "Nothing blocked the main thread in this window.";
      }),
  );

  server.registerTool(
    "logs",
    {
      title: "App logs",
      description:
        "The app's own logcat output, captured in-process and streamed over the same socket as " +
        "everything else — no adb needed. Stack traces arrive attached to the line that started " +
        "them rather than as loose fragments.\n\n" +
        "Entries carry the same uptime clock as the timeline, so a log line can be placed against " +
        "a recomposition burst or an HTTP call. Only the app's own output is visible, and the " +
        "porthole's own tag is excluded.",
      inputSchema: {
        level: z
          .enum(["V", "D", "I", "W", "E", "F"])
          .optional()
          .describe("Minimum level. 'W' for warnings and worse, which is usually what you want."),
        tag: z.string().optional().describe("Substring match on the tag."),
        contains: z.string().optional().describe("Substring match on the message."),
        ...windowShape,
        limit: z
          .number()
          .int()
          .positive()
          .max(2000)
          .optional()
          .describe("Newest N entries. Default 200."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ level, tag, contains, sinceMs, from, to, limit }): Promise<ToolResult> =>
      call<{
        entries: Array<{ level: string; tag: string; message: string; wallTime: string }>;
        capturing: boolean;
        evicted: number;
        notes: string[];
      }>("logs", { level, tag, contains, sinceMs, from, to, limit }, (page) => {
        if (!page.capturing) {
          return page.notes.join(" ") || "Log capture is not running.";
        }
        if (page.entries.length === 0) {
          return page.notes.join(" ") || "No log entries matched.";
        }
        const counts: Record<string, number> = {};
        for (const entry of page.entries) counts[entry.level] = (counts[entry.level] ?? 0) + 1;
        const worst = page.entries
          .filter((entry) => entry.level === "E" || entry.level === "F")
          .at(-1);
        return (
          `${page.entries.length} entries (` +
          Object.entries(counts)
            .map(([level, count]) => `${level} ${count}`)
            .join(", ") +
          ")" +
          (worst
            ? `. Latest error: ${worst.tag}: ${worst.message.split("\n")[0].slice(0, 120)}`
            : ".")
        );
      }),
  );

  server.registerTool(
    "timeline",
    {
      title: "Event timeline",
      description:
        "Raw event stream: recompositions, state writes, navigation, HTTP and database start/end. " +
        "Use it to order events relative to each other — which write came before which navigation, " +
        "what the app was doing while a call was open.",
      inputSchema: {
        ...windowShape,
        kinds: z
          .array(z.string())
          .optional()
          .describe(
            "Filter by event name: recompose, state_write, frame, nav, http_start, http_end, " +
              "db_start, db_end, log.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe("Newest N events. Default 500."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceMs, from, to, kinds, limit }): Promise<ToolResult> => {
      try {
        // Prefer the local buffer: it holds more history than the device ring and
        // survives the app being restarted underneath us.
        let events: DeviceEvent[] = timeline.buffer();
        if (events.length === 0) {
          const page = await device.request<{ events: DeviceEvent[] }>("timeline", {
            limit: limit ?? 500,
          });
          events = page.events;
        }

        // Absolute bounds first, so a window quoted from another tool selects the
        // same span here. sinceMs stays as the convenience for "recently".
        const span = resolveWindow({ sinceMs, from, to });
        if (span) {
          events = events.filter((event) => event.t >= span.from && event.t <= span.to);
        }
        if (kinds?.length) {
          const wanted = new Set(kinds);
          events = events.filter((event) => wanted.has(event.event));
        }

        const matched = events.length;
        const cap = limit ?? 500;
        events = events.slice(-cap);
        const truncated = matched > events.length;

        const counts: Record<string, number> = {};
        for (const event of events) counts[event.event] = (counts[event.event] ?? 0) + 1;
        const covered = events.length > 1 ? events[events.length - 1].t - events[0].t : 0;

        // Say when the answer was cut. Silent truncation is how an agent
        // concludes something did not happen when it simply fell off the end.
        const note = truncated
          ? ` ${matched} matched, newest ${events.length} returned — raise \`limit\` or narrow the window.`
          : "";
        const summary =
          events.length === 0
            ? "No events matched. Interact with the app, widen the window, or check `kinds`."
            : `${events.length} events over ${covered}ms: ` +
              Object.entries(counts)
                .map(([kind, count]) => `${kind} ${count}`)
                .join(", ") +
              "." +
              note;
        return ok(summary, {
          window: span ? { from: span.from, to: span.to, ms: span.ms } : null,
          matched,
          returned: events.length,
          truncated,
          events,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "open_timeline",
    {
      title: "Open the timeline UI",
      description:
        "Starts the local timeline UI and returns its URL. Lanes for recompositions, state writes, " +
        "navigation, network and database, on a shared time axis. Open it in a browser; it updates " +
        "live over a WebSocket.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        const url = await timeline.start();
        return ok(`Timeline UI running at ${url}`, { url, events: timeline.buffer().length });
      } catch (error) {
        return fail(error);
      }
    },
  );

  return { server, device, timeline };
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

/**
 * True only when this file is the process's actual entry point (`node
 * dist/index.js`, or the `porthole-mcp` bin it is published as) — never when
 * it is merely imported, which is what every test does, and what `cli.ts`
 * now does too (it calls `bootPortholeServer()` explicitly instead of
 * relying on this guard). Importing this module must never open a socket,
 * attach to stdio, or install signal handlers; only running it as a program,
 * or explicitly asking it to boot, may.
 */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

/**
 * The one boot path: create the server, start the device, wire shutdown, and
 * connect stdio. `node dist/index.js` and `porthole mcp` (`cli.ts`) both call
 * this instead of each having their own copy — `porthole mcp` used to boot by
 * `import("./index.js")`ing this module for its side effect, which broke the
 * moment that side effect moved behind `isMainModule()`: `argv[1]` is
 * `cli.js` when the CLI does the importing, so the guard can never see
 * itself as the entry point and nothing started. Calling this function is
 * the boot; the `isMainModule()` block below is just the one caller that
 * also happens to be `node dist/index.js` itself.
 */
export async function bootPortholeServer(
  options: PortholeServerOptions = {},
): Promise<PortholeServer> {
  const rig = createPortholeServer(options);
  const { server, device, timeline } = rig;

  device.start();

  // stdout belongs to the MCP transport; anything we say goes to stderr.
  device.on("state", (state: string) => process.stderr.write(`[porthole] device ${state}\n`));

  const shutdown = () => {
    device.stop();
    timeline.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[porthole] MCP server ready, device target ${HOST}:${PORT}\n`);

  return rig;
}

if (isMainModule()) {
  await bootPortholeServer();
}
