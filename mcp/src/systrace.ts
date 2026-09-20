// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { open } from "node:fs/promises";
import { statSync } from "node:fs";
import { runAdbAsync, type RunAdbAsyncOptions } from "./adb.js";

/**
 * Recording a Perfetto trace from the device, and saying what is in it.
 *
 * Deliberately does not return the trace. A ten-second capture is tens of
 * megabytes of protobuf, and the instinct to hand that to a model is the wrong
 * one — it is not summarisable by reading it, and the useful form is a file you
 * open in a trace viewer plus a sentence saying whether it is worth opening.
 *
 * What makes this worth having at all is that the app's own spans are already
 * inside it. The runtime writes its navigations, HTTP calls, queries and stalls
 * as atrace sections, so a capture arrives annotated with what the app was
 * doing rather than only what the kernel was doing.
 */

/**
 * A useful default for looking at jank.
 *
 * Note what is *not* here: `app`. The runtime's sections are written under
 * ATRACE_TAG_APP, and that tag is not a category — it is enabled per package
 * with perfetto's `--app`. Passing "app" in this list enables nothing, which
 * was verified by reading debug.atrace.tags.enableflags during a capture and
 * finding 0xa: VIEW and GRAPHICS set, ATRACE_TAG_APP (0x1000) clear. The
 * capture succeeded and contained no Porthole slices at all.
 */
export const DEFAULT_CATEGORIES = [
  "sched",
  "freq",
  "idle",
  "gfx",
  "view",
  "wm",
  "am",
  "binder_driver",
  "dalvik",
];

export interface CapturePlan {
  categories: string[];
  /** Packages whose ATRACE_TAG_APP sections are recorded. */
  apps: string[];
  seconds: number;
  devicePath: string;
  /** Warnings about the plan itself, before anything is recorded. */
  notes: string[];
}

/**
 * Drops `app` from a requested category list, with the same warning either
 * caller would otherwise have to write out itself.
 *
 * Shared by `planCapture` and `planRing` (GRA-57): both take a `categories`
 * list from the same place (an agent's request, defaulting to
 * `DEFAULT_CATEGORIES`), and both need the identical "app is not a category"
 * correction — see this file's own top-of-file doc comment for why passing
 * it is a silent no-op rather than a rejected input. Factored out so the two
 * planners cannot drift into two different wordings of the same warning.
 */
function sanitizeCategories(categories: string[], notes: string[]): string[] {
  return categories.filter((c) => {
    if (c === "app") {
      notes.push(
        "Dropped the `app` category: it is not one. App sections come from " +
          "ATRACE_TAG_APP, which is enabled per package — pass the package in `apps`.",
      );
      return false;
    }
    return true;
  });
}

/**
 * Works out what to record, and says when the request undercuts itself.
 *
 * Without a package in `apps`, the capture contains no Porthole sections and
 * gives no indication why — it simply succeeds and is unannotated, which reads
 * as the runtime being broken. So the absence is called out rather than left to
 * be discovered in a trace viewer.
 */
export function planCapture(options: {
  seconds?: number;
  categories?: string[];
  apps?: string[];
  now?: number;
}): CapturePlan {
  const notes: string[] = [];

  const seconds = Math.min(Math.max(Math.round(options.seconds ?? 10), 1), 120);
  if (options.seconds !== undefined && seconds !== Math.round(options.seconds)) {
    notes.push(`Duration clamped to ${seconds}s; 1 to 120 is the supported range.`);
  }

  const categories = sanitizeCategories(
    options.categories?.length ? [...options.categories] : [...DEFAULT_CATEGORIES],
    notes,
  );

  const apps = options.apps?.filter((a) => a.trim().length > 0) ?? [];
  if (apps.length === 0) {
    notes.push(
      "No app named, so this trace will have no Porthole sections in it. Pass the " +
        "package under test in `apps` to record the runtime's navigations, calls and stalls.",
    );
  }

  const stamp = options.now ?? Date.now();
  return {
    categories,
    apps,
    seconds,
    // The traced service writes here; a path under /sdcard is not writable by it.
    devicePath: `/data/misc/perfetto-traces/porthole-${stamp}.pftrace`,
    notes,
  };
}

/** The on-device command, in Perfetto's shorthand form. */
export function captureArgs(plan: CapturePlan): string[] {
  return [
    "shell",
    "perfetto",
    "-o",
    plan.devicePath,
    "-t",
    `${plan.seconds}s`,
    // One --app per package. This, not a category, is what turns on the tag
    // the runtime's sections are written under.
    ...plan.apps.flatMap((app) => ["--app", app]),
    ...plan.categories,
  ];
}

/**
 * How many bytes `countPortholeLabels` reads at once.
 *
 * Large enough that a hundred-megabyte capture is a hundred `read()` calls,
 * not a hundred thousand; small enough that peak memory while scanning stays
 * a handful of megabytes rather than growing with the file. This is the
 * whole fix for GRA-89's heap-exhaustion half: the code this replaced read
 * the entire capture into a `Buffer` and then decoded the entire buffer into
 * a second, same-sized string before scanning either — two copies of
 * whatever the file's size happened to be, all at once.
 */
export const CHUNK_BYTES = 1024 * 1024;

/**
 * How much of one chunk's tail is re-scanned as part of the next.
 *
 * The marker is `porthole: ` (10 characters) plus the capture group's own
 * bound of up to 110 more, 120 characters at the outside. 128 bytes of
 * overlap — one byte per latin1 character — covers that with eight to
 * spare, so a marker whose bytes straddle a chunk boundary is always whole
 * in at least one of the two scans that see it: incomplete (and so
 * unmatched) in the chunk it starts in, complete once its own tail is
 * carried into the front of the next chunk's text.
 */
export const OVERLAP_BYTES = 128;

const PORTHOLE_MARKER = /porthole: ([^|\x00-\x1f]{1,110})/g;

/**
 * Whether the app's own sections made it into the capture — read a chunk at
 * a time rather than all at once.
 *
 * `index.ts` used to `readFileSync` the whole trace and hand this function
 * the resulting `Buffer`, which this then decoded whole with
 * `.toString("latin1")` before scanning it. At the tool's own 120s maximum a
 * real capture is hundreds of megabytes; doubling that into a same-sized JS
 * string is exactly the shape that exhausts Node's heap before the tool can
 * report anything. This reads and decodes `CHUNK_BYTES` at a time instead,
 * so peak memory is a small, fixed multiple of one chunk no matter how large
 * the capture is — see `systrace.test.ts`'s RSS-bound case, which measures
 * this rather than asserting it by argument.
 *
 * A byte search for the prefix, not a parse, exactly as before: slice names
 * are interned as plain strings in the protobuf, so finding one is good
 * evidence it is there and not finding it is good evidence it is not.
 *
 * Counting matches would overstate it — a name is referenced many times, not
 * interned once — so this keeps the same `Set` of distinct names the
 * non-streaming version used, which is also what makes the chunk overlap
 * cheap to get slightly too generous rather than exactly right: a name
 * re-matched out of the carried tail, because it happened to sit wholly
 * inside the last `OVERLAP_BYTES` of the previous chunk rather than
 * straddling the boundary, is a duplicate insert into a `Set`, not a double
 * count. Only a marker that is never matched in full, in either chunk, would
 * be missed — which is exactly what the overlap exists to prevent.
 */
export async function countPortholeLabels(filePath: string): Promise<number> {
  const names = new Set<string>();
  const handle = await open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let position = 0;
    let carry = "";
    while (position < size) {
      const toRead = Math.min(CHUNK_BYTES, size - position);
      const { bytesRead } = await handle.read(buffer, 0, toRead, position);
      if (bytesRead === 0) break; // defensive: a file truncated out from under this scan, not a loop forever re-reading zero bytes
      const text = carry + buffer.toString("latin1", 0, bytesRead);
      for (const match of text.matchAll(PORTHOLE_MARKER)) names.add(match[1].trimEnd());
      carry = text.slice(-OVERLAP_BYTES);
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return names.size;
}

export interface CaptureResult {
  path: string;
  bytes: number;
  seconds: number;
  categories: string[];
  /**
   * The packages `--app` was actually run with. GRA-186: `describeCapture`
   * needs this to tell "no package was named" (the app tag was never
   * enabled — nothing to investigate) apart from "a package was named and
   * the trace still came back unannotated" (the two are different problems
   * with different remedies, and conflating them is what GRA-186 was filed
   * against).
   */
  apps: string[];
  portholeLabels: number;
  /**
   * Whether the tool force-stopped and relaunched the target app for this
   * capture (`restartApp: true` in `index.ts`'s `capture_system_trace`).
   * `describeCapture` uses it only to warn that the trace contains a cold
   * start — it says nothing about whether the restart made labels appear.
   */
  restarted: boolean;
  notes: string[];
}

/** One sentence: whether it worked, how big, and whether it is annotated. */
export function describeCapture(result: CaptureResult): string {
  const mb = (result.bytes / (1024 * 1024)).toFixed(1);
  const parts = [`Captured ${result.seconds}s to ${result.path} (${mb}MB).`];

  parts.push(
    result.portholeLabels > 0
      ? `${result.portholeLabels} Porthole track(s) in it, so the app's own navigations, ` +
          "calls and queries are on the timeline."
      : result.apps.length === 0
        ? "No Porthole labels found — either no package was named, so the app tag was never " +
          "enabled, or the app was not running with the runtime attached. The trace is still " +
          "valid, it is just not annotated."
        : // GRA-186: on the Pixel 9 Pro Fold (Android 17) a process already
          // running when the session starts never picks up the newly-enabled
          // app tag — it is consulted once, at process attach, not re-read
          // live. Naming that here, rather than the old generic "package or
          // runtime is wrong" wording, is what turns a false "something is
          // misconfigured" reading into the actual, actionable remedy.
          `No Porthole labels found even though ${result.apps.join(", ")} was targeted — this ` +
          "device/build only reads the app trace tag when its process starts, so a process " +
          "already running before the capture began is never marked (seen on a Pixel 9 Pro " +
          "Fold, Android 17). Pass `restartApp: true`, or launch the app after the capture " +
          "starts, to catch it.",
  );

  if (result.restarted) {
    parts.push("The app was restarted for this capture, so it contains a cold start.");
  }

  parts.push("Open it at ui.perfetto.dev; nothing here reads it for you.");
  return [...parts, ...result.notes].join(" ");
}

// ---------------------------------------------------------------------------
// #ring-config (GRA-57): a detached, continuously-recording ring buffer
// ---------------------------------------------------------------------------

/**
 * The system trace of the problem that already happened.
 *
 * `capture_system_trace` above answers "record while I reproduce this" — it
 * blocks for a fixed duration and needs a human standing by. Most of what is
 * worth a system trace already happened by the time anyone thinks to ask for
 * one. Perfetto's own ring-buffer session, run detached so it survives the
 * adb shell that started it, is what makes "capture the last 30 seconds, now,
 * of something I already saw" possible instead of "reproduce it again with a
 * recording running."
 *
 * `planRing`/`ringConfigText` are the pure half — building the TraceConfig
 * text `ring.ts` pushes to the device — kept here beside `planCapture` and
 * `captureArgs` for the same reason those two are pure: a plan can be
 * asserted on without a device, an adb binary, or a running trace daemon.
 * `ring.ts` owns everything that actually talks to adb (start, snapshot,
 * stop, and the state a running session needs between those three calls).
 */

/**
 * 32MB, matching perfetto's own light-config default (`--buffer`'s own
 * documented default). Sized "for ~30s of the sample app" per the ticket,
 * but that duration is a property of *throughput*, not a fixed constant this
 * function can promise: the spike's own emulator measurement (see the
 * ticket's report) held several minutes of a near-idle device at this size,
 * and a device under real load — active gfx/view/wm/binder/dalvik churn —
 * fills it far faster. 32MB is offered as a reasonable starting point an
 * agent can override with `bufferKb`, not a guarantee of any particular
 * span; `ring.ts`'s snapshot result says so rather than quoting a precise
 * "last 30s" this host has no way to verify from outside the trace itself.
 */
export const DEFAULT_RING_BUFFER_KB = 32 * 1024;

/**
 * Floor and ceiling for `bufferKb` — GRA-57's stated "traces larger than the
 * device can hold" is out of scope, but an unbounded number here would let a
 * single call ask for more RAM than most devices running a debug build can
 * spare for one ftrace buffer. 4MB is small enough to be nearly useless (a
 * few seconds under any real load) without being zero; 256MB is a large
 * fraction of a typical device's usable memory for a debug tool that is
 * meant to run continuously in the background, not the whole point of the
 * session.
 */
export const MIN_RING_BUFFER_KB = 4 * 1024;
export const MAX_RING_BUFFER_KB = 256 * 1024;

/**
 * Every detached ring session this file's tools ever start carries this
 * exact name — not one per call, and not derived from the package under
 * test. `perfetto --clone-by-name`/`--query --long` (see `ring.ts`) both key
 * off it, and a fixed name is what makes "is Porthole's ring already
 * running" answerable after an MCP server restart, when nothing in this
 * process remembers starting it. The trade-off, stated plainly rather than
 * discovered by surprise: only one Porthole ring can run on a given device
 * at a time, whatever app it is scoped to — a second `system_trace_start`
 * while one is already running is refused (see `ring.ts`), not silently
 * layered on top of the first.
 */
export const RING_SESSION_NAME = "porthole-ring";

export interface RingPlan {
  sessionName: string;
  categories: string[];
  /** The one package whose ATRACE_TAG_APP sections are recorded — a ring session is always scoped to exactly one app, unlike `capture_system_trace`'s `apps` list. */
  app: string;
  bufferKb: number;
  notes: string[];
}

/**
 * Works out what a ring session should record — the same shape of decision
 * `planCapture` makes for a one-shot capture, with two differences a ring
 * session's own nature forces: no `seconds` (it runs until
 * `system_trace_stop` says otherwise), and exactly one `app` rather than a
 * list (`unique_session_name`/`--clone-by-name` key off one fixed name, and
 * a session scoped to more than one package at a time is not something this
 * first cut supports — see the ticket's report for why that is a deliberate
 * narrowing, not an oversight).
 */
export function planRing(options: { app: string; categories?: string[]; bufferKb?: number }): RingPlan {
  const notes: string[] = [];

  const categories = sanitizeCategories(
    options.categories?.length ? [...options.categories] : [...DEFAULT_CATEGORIES],
    notes,
  );

  const requestedKb = options.bufferKb ?? DEFAULT_RING_BUFFER_KB;
  const bufferKb = Math.min(Math.max(Math.round(requestedKb), MIN_RING_BUFFER_KB), MAX_RING_BUFFER_KB);
  if (bufferKb !== Math.round(requestedKb)) {
    notes.push(
      `Buffer clamped to ${bufferKb}KB; ${MIN_RING_BUFFER_KB} to ${MAX_RING_BUFFER_KB}KB is the supported range.`,
    );
  }

  return { sessionName: RING_SESSION_NAME, categories, app: options.app.trim(), bufferKb, notes };
}

/**
 * The TraceConfig text `ring.ts` pushes to the device and starts with
 * `perfetto --txt -c - --background-wait`.
 *
 * `fill_policy: RING_BUFFER` is the whole point — the central buffer drops
 * its oldest, not-yet-read packets once full rather than blocking or
 * stopping the session, so a session with nothing reading it continuously
 * (nothing here calls `--clone-by-name` on a timer) still runs forever
 * instead of wedging. `unique_session_name` is what makes the session
 * discoverable by name later — by `system_trace_snapshot`'s
 * `--clone-by-name`, and by `porthole_status`/`system_trace_stop`'s
 * `perfetto --query --long`, which prints it in a `NAME` column — without
 * either of those needing to remember a `--detach` key across MCP server
 * restarts. `atrace_apps`, not `--app`, is the config-file equivalent of
 * `capture_system_trace`'s per-package `--app` flag; the two enable the
 * exact same thing (`ATRACE_TAG_APP` for that package), just spelled for a
 * config file instead of a command line.
 *
 * QA (F20) on this ticket's second pass: this used to declare `linux.ftrace`
 * alone, and a controlled comparison — the same moment on the same device,
 * once via `capture_system_trace`, once via a ring snapshot — found
 * `ask_system_trace` got real findings from the first and nothing at all
 * from the second, across all eight questions. `captureArgs` in this file
 * invokes `perfetto` in its "light config" shorthand (bare category names on
 * the command line, no `-c`), and that shorthand silently expands to more
 * than `linux.ftrace`: read back with `trace_processor_shell`'s own
 * `SELECT str_value FROM metadata WHERE name = 'trace_config_pbtxt'` against
 * a real capture, it resolves to four data sources —
 * `android.surfaceflinger.frametimeline` (what `jank`'s own frame-timeline
 * detail comes from), `linux.ftrace` with `symbolize_ksyms: true` set,
 * `linux.process_stats` and `linux.system_info` (thread/process names most
 * questions need to say anything human-readable at all). The ring's own
 * config now declares the same four, verified the same way rather than
 * assumed from Perfetto's own docs — see the ticket's spike writeup
 * (`docs/spikes/GRA-57-perfetto-ring.md`) for the full transcript and the
 * before/after `ask_system_trace` comparison this fixed.
 */
export function ringConfigText(plan: RingPlan): string {
  const lines = [
    `unique_session_name: "${plan.sessionName}"`,
    "buffers {",
    `  size_kb: ${plan.bufferKb}`,
    "  fill_policy: RING_BUFFER",
    "}",
    "data_sources {",
    "  config {",
    '    name: "android.surfaceflinger.frametimeline"',
    "  }",
    "}",
    "data_sources {",
    "  config {",
    '    name: "linux.ftrace"',
    "    ftrace_config {",
    ...plan.categories.map((c) => `      atrace_categories: "${c}"`),
    `      atrace_apps: "${plan.app}"`,
    "      symbolize_ksyms: true",
    "    }",
    "  }",
    "}",
    "data_sources {",
    "  config {",
    '    name: "linux.process_stats"',
    "    target_buffer: 0",
    "  }",
    "}",
    "data_sources {",
    "  config {",
    '    name: "linux.system_info"',
    "    target_buffer: 0",
    "  }",
    "}",
  ];
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// #capture-integration (GRA-103): `porthole capture --systrace`
// ---------------------------------------------------------------------------
//
// `capture_system_trace` (index.ts) blocks for a fixed duration someone asks
// for up front. `porthole capture --systrace` cannot do that: the command it
// wraps is the capture window (see capture.ts's own top-of-file doc comment),
// and its length is not known in advance. The shape that reconciles the two
// is the same one `ring.ts` already proved out for a different reason —
// `perfetto --background-wait` (`-D`) forks the recording, reparents it to
// init, and returns as soon as the session is confirmed running, so the
// caller is never blocked waiting on it. Unlike the ring, this is not a
// `RING_BUFFER` session recording forever: it is `captureArgs`'s own
// light-config shorthand with a `-t Ns` duration, backgrounded — a plain,
// bounded, complete recording that just happens to start without blocking.
// `-t` is the safety ceiling (planCapture's 1-120s clamp) for a child that
// hangs or overruns; the *intended* stop is `stopAndPullSystraceCapture`
// killing it the moment the child actually exits, whichever comes first.

/** The on-device command for a backgrounded, `captureArgs`-shaped recording — see this section's own doc comment for why `--background-wait` rather than a blocking capture. */
export function backgroundCaptureArgs(plan: CapturePlan): string[] {
  return [
    "shell",
    "perfetto",
    "--background-wait",
    "-o",
    plan.devicePath,
    "-t",
    `${plan.seconds}s`,
    ...plan.apps.flatMap((app) => ["--app", app]),
    ...plan.categories,
  ];
}

/** `--background-wait` blocks on-device until every data source has confirmed it started — up to 30s, the same bound `ring.ts` documents for the identical flag. */
const BACKGROUND_WAIT_TIMEOUT_MS = 30_000;

/**
 * `ps -A -o PID,ARGS`, matched against `devicePath` rather than a fixed name.
 *
 * `ring.ts`'s `findRunningRingPid` matches on `DEVICE_OUT_PATH`, a single
 * constant shared by every ring session this controller ever starts, because
 * a ring needs to be discoverable by a *different* process (after an MCP
 * server restart) with no other identifying information. A `--systrace`
 * capture has no such requirement — it is found, stopped and pulled by the
 * same `capture()` call that started it — but it does need a match string
 * that cannot collide with an unrelated perfetto invocation running at the
 * same time, which `planCapture`'s own `devicePath` (stamped with `Date.now()`
 * per call) already guarantees is unique.
 */
async function findRunningCapturePid(devicePath: string, adbOptions: RunAdbAsyncOptions): Promise<number | null> {
  const result = await runAdbAsync(["shell", "ps", "-A", "-o", "PID,ARGS"], adbOptions);
  if (!result.ok) return null;
  for (const line of result.output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pidText, args] = match;
    if (args.includes("perfetto") && args.includes(devicePath)) {
      const pid = Number(pidText);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  }
  return null;
}

export interface SystraceCaptureHandle {
  plan: CapturePlan;
  pid: number;
}

export type SystraceStartResult =
  | { ok: true; handle: SystraceCaptureHandle }
  | { ok: false; message: string };

/**
 * Starts the backgrounded, on-device recording `capture()` scopes to a child
 * command's lifetime. Bounded by `plan.seconds` — see this section's own doc
 * comment — but meant to be stopped sooner, by [stopAndPullSystraceCapture],
 * once the command it is watching actually exits.
 *
 * Failure here is never fatal to `porthole capture` as a whole: the caller's
 * own porthole-sourced trace still gets written either way, with a note
 * saying the system trace could not be started (capture.ts's own `#systrace`
 * section is what decides that; this function only reports what happened).
 */
export async function startSystraceCapture(
  plan: CapturePlan,
  adbOptions: RunAdbAsyncOptions,
): Promise<SystraceStartResult> {
  const started = await runAdbAsync(backgroundCaptureArgs(plan), {
    ...adbOptions,
    timeoutMs: BACKGROUND_WAIT_TIMEOUT_MS,
  });
  if (!started.ok) {
    return { ok: false, message: `could not start the on-device capture: ${started.output}` };
  }

  const pid = await findRunningCapturePid(plan.devicePath, adbOptions);
  if (pid === null) {
    return {
      ok: false,
      message:
        `perfetto --background-wait reported success, but no running session could be found ` +
        `afterward: ${started.output}`,
    };
  }
  return { ok: true, handle: { plan, pid } };
}

/** How long `stopAndPullSystraceCapture` polls for the backgrounded process to actually exit after `kill -TERM`, before pulling regardless — perfetto needs a moment to flush the file on the way out. */
const STOP_POLL_TIMEOUT_MS = 5_000;
const STOP_POLL_INTERVAL_MS = 150;

/**
 * Whether the backgrounded process is still there, by re-scanning `ps` for
 * `devicePath` — the same mechanism [findRunningCapturePid] uses to find it
 * in the first place, deliberately, rather than `kill -0 pid`.
 *
 * Found against a real emulator, not assumed: `perfetto --background-wait`'s
 * child runs in the `u:r:perfetto:s0` SELinux domain, not `u:r:shell:s0`,
 * and `kill -0 <its pid>` from an `adb shell` (`u:r:shell:s0`, same uid —
 * 2000/shell either side) came back `Permission denied` *even while the
 * process was genuinely still running* — confirmed by cross-checking `ps`
 * at the same instant. `kill -TERM` against the same pid, moments earlier,
 * had succeeded (SELinux evidently draws the line at the liveness probe,
 * not the signal this function actually needs to send). Reading that denial
 * as "the process is gone" is exactly backwards: it made every real
 * `stopAndPullSystraceCapture` call return instantly, pull whatever 0-byte
 * or half-written file happened to be on disk at that moment, and then
 * `rm -f` it out from under the recording that was still running — the
 * `.pftrace` this ticket's own AC asks for came back empty every time,
 * silently, because the poll that was supposed to wait for the flush never
 * actually waited. `ps` needs no such permission — it is exactly what
 * `findRunningCapturePid` already uses to find the pid before this function
 * is ever called, over the one channel this session's own SELinux policy
 * does not gate.
 */
async function waitForCaptureToExit(devicePath: string, adbOptions: RunAdbAsyncOptions): Promise<void> {
  const deadline = Date.now() + STOP_POLL_TIMEOUT_MS;
  for (;;) {
    const pid = await findRunningCapturePid(devicePath, adbOptions);
    if (pid === null) return;
    if (Date.now() >= deadline) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, STOP_POLL_INTERVAL_MS));
  }
}

export type SystraceStopResult = { ok: true; bytes: number } | { ok: false; message: string };

/**
 * Stops a capture [startSystraceCapture] started and pulls it to `localPath`.
 *
 * `kill -TERM` is best-effort and deliberately harmless against a session
 * that already finished on its own once `plan.seconds` elapsed — the same
 * idiom `ring.ts`'s own `stop()` uses for the identical reason. The device's
 * trace directory is not this tool's to fill, so the on-device file is
 * removed regardless of whether the pull succeeded, matching
 * `capture_system_trace`'s own "tidy up regardless" pull in index.ts.
 */
export async function stopAndPullSystraceCapture(
  handle: SystraceCaptureHandle,
  localPath: string,
  adbOptions: RunAdbAsyncOptions,
): Promise<SystraceStopResult> {
  await runAdbAsync(["shell", `kill -TERM ${handle.pid}`], adbOptions);
  await waitForCaptureToExit(handle.plan.devicePath, adbOptions);

  const pulled = await runAdbAsync(["pull", handle.plan.devicePath, localPath], adbOptions);
  await runAdbAsync(["shell", "rm", "-f", handle.plan.devicePath], adbOptions);
  if (!pulled.ok) return { ok: false, message: `recorded, but could not pull it: ${pulled.output}` };

  return { ok: true, bytes: statSync(localPath).size };
}
