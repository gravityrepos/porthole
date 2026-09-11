#!/usr/bin/env node
// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DeviceClient, type DeviceEvent } from "./device.js";
import { TimelineServer } from "./timeline.js";
import { readFileSync } from "node:fs";
import { buildTrace, type Finding } from "./trace.js";

/** Read, not retyped: a hardcoded version here drifts from the package. */
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const HOST = process.env.PORTHOLE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORTHOLE_PORT ?? 8677);
const UI_PORT = Number(process.env.PORTHOLE_UI_PORT ?? 8678);

const device = new DeviceClient(HOST, PORT);
const timeline = new TimelineServer(device, UI_PORT);

const server = new McpServer({
  name: "porthole",
  version: pkg.version,
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
  to: z.number().int().optional().describe("Absolute end, same clock. Defaults to the latest event."),
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
  "blocking-gc": { tool: "timeline", why: "what allocated around each collection (kinds: [\"gc\"])" },
  "trim-memory": { tool: "timeline", why: "the memory series around the trim (kinds: [\"memory\"])" },
  "work-retried": { tool: "inflight", why: "the jobs and their attempt counts" },
  "recompose-hotspot": {
    tool: "recompositions",
    why: "the per-node counts and the state keys written just before",
  },
};

function withFollowUp(finding: Finding) {
  const next = FOLLOW_UP[finding.id];
  return next ? { ...finding, next: { tool: next.tool, window: "quote `window` above", shows: next.why } } : finding;
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
    const payload = {
      state: device.state,
      host: HOST,
      port: PORT,
      app: device.hello,
      timelineUi: timeline.isRunning() ? timeline.url() : null,
      bufferedEvents: timeline.buffer().length,
      lastError: device.lastError,
    };
    const summary =
      device.state === "connected" && device.hello
        ? `Connected to ${device.hello.packageName} on ${device.hello.device} ` +
          `(API ${device.hello.sdkInt}). Collectors: ${device.hello.collectors.join(", ")}.`
        : device.notConnectedMessage();
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
      "An empty list means nothing crossed a threshold in this window. It does not mean the app " +
      "is fast, and it does not mean the window contained the problem — check `window` against " +
      "the moment you care about before concluding anything from silence.",
    inputSchema: windowShape,
    annotations: { readOnlyHint: true },
  },
  async ({ sinceMs, from, to }): Promise<ToolResult> => {
    const span = resolveWindow({ sinceMs, from, to });
    if (!span) {
      return ok(device.notConnectedMessage(), { window: null, findings: [], connected: false });
    }

    const events = timeline.buffer().filter((e) => e.t >= span.from && e.t <= span.to);
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
      eventsExamined: events.length,
      metrics: trace.metrics,
      findings,
    };

    if (findings.length === 0) {
      return ok(
        `Nothing crossed a threshold in the ${Math.round(span.ms / 1000)}s examined ` +
          `(${events.length} events). That is not the same as the app being fast.`,
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
        `Worst: ${worst.title} [${worst.confidence}].`,
      payload,
    );
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
        .describe("Only nodes on this screen, matched against the enclosing PortholeScreen name."),
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
      unattributedWrites: Array<{ key: string; count: number }>;
    }>("recompositions", { screen, sinceMs, from, to, limit: limit ?? 50 }, (report) => {
      if (report.nodes.length === 0) {
        return "No instrumented composable recomposed in that window.";
      }
      const top = report.nodes[0];
      const cause = top.triggeredBy[0];
      const total = report.nodes.reduce((sum, node) => sum + node.count, 0);
      return (
        `${total} recompositions across ${report.nodes.length} nodes. ` +
        `Worst: ${top.name} at ${top.count}` +
        (cause ? `, most often after a write to ${cause.key} (${cause.count} of them).` : ".")
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
      "Present tense only. This is the stack as it is now, not how it got that way — for the order things happened in, ask `timeline` with kinds: [\"nav\"].",
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
    call<{ owners: Array<{ name: string; fields: unknown[] }> }>("state", { viewModel }, (dump) => {
      if (dump.owners.length === 0) {
        return 'No ViewModels registered. Call Porthole.registerViewModel("CartViewModel", vm) where you obtain it.';
      }
      return dump.owners.map((owner) => `${owner.name} (${owner.fields.length} fields)`).join(", ");
    }),
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
      recentHttp?: Array<{ method: string; url: string; status: number | null; elapsedMs: number }>;
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

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

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
