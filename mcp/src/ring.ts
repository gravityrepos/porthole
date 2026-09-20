// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectRoot, runAdbAsync, type RunAdbAsyncOptions } from "./adb.js";
import { planRing, ringConfigText, RING_SESSION_NAME, type RingPlan } from "./systrace.js";

/**
 * GRA-57: a detached Perfetto ring buffer, recording continuously so the
 * system trace of a problem that already happened is still there to ask
 * about — see `systrace.ts`'s `#ring-config` section for the config this
 * starts from and why it looks the way it does. This file is the other
 * half: everything that actually talks to adb (start, snapshot, stop) and
 * the state a running session needs to remember between those three calls.
 *
 * Shipped opt-in only, per the coordinator's ruling on this ticket: nothing
 * here runs unless `system_trace_start` is called, and there is no
 * default-on path anywhere in `index.ts`. The EM's own re-scope named the
 * reason — continuous `sched` tracing was unproven to be cheap enough to run
 * by default — and the spike this ticket's report documents measured it on
 * an emulator (0.45% of one core combined across `traced`/`traced_probes`/
 * the detached `perfetto` process, under a light synthetic input workload;
 * see `MEASURED_OVERHEAD` below) without ever promising that number holds on
 * hardware under real load. `porthole_status`'s `ring` field carries that
 * same number so an agent deciding whether to turn this on sees it before
 * asking, not after.
 *
 * The device-side mechanism, discovered by the spike rather than assumed
 * from the ticket text: `perfetto --detach=<key>` turned out to require
 * `write_into_file: true` in the TraceConfig — which turns the *file* into a
 * monotonically growing stream, not a ring, defeating the point. `--background`
 * (`-d`) is what this uses instead: the `perfetto` command forks, is
 * reparented to init, and keeps running with a pure in-memory `RING_BUFFER`
 * central buffer — no `--detach` key needed at all, because
 * `unique_session_name` in the config is what makes the session
 * discoverable afterward, by any adb connection, across an MCP server
 * restart. `--clone-by-name` is the snapshot mechanism: it reads the
 * session's *current* buffer into a brand new file without touching the
 * original session, so a snapshot never interrupts the ring the way
 * `--attach=key --stop` (the mechanism the ticket text named) would have —
 * the spike measured this directly: the source `perfetto` process's PID was
 * still present in `ps` immediately after a `--clone-by-name` pull. See the
 * ticket's report for the full transcript.
 */

// ---------------------------------------------------------------------------
// device-side paths
// ---------------------------------------------------------------------------

/** Where the pushed TraceConfig lives while `--background` reads it from stdin (`cat <path> | perfetto --txt -c - ...`), removed again immediately after the session starts — it is not needed for the session's lifetime. */
const DEVICE_CONFIG_PATH = "/data/local/tmp/porthole-ring-config.pbtxt";

/**
 * Where `start` writes the backgrounded `perfetto` process's PID, on the
 * device, not just in this process's memory.
 *
 * `stop` has to work even when nothing in this MCP process remembers
 * starting the ring — a server restart, or a `system_trace_stop` call from a
 * different process than the one that started it. Reading this file back is
 * the fast path for that.
 *
 * QA (R2) on this ticket's first pass: this write is itself best-effort (a
 * dropped adb call, or an MCP process killed between the write and the
 * process it named), so it cannot be the *only* way to find the session —
 * `findRunningRingPid` below is the real source of truth, a device-side
 * process-table scan that needs nothing written anywhere in advance. The
 * marker still exists because it is cheaper than a scan on the common path
 * (`stop` right after `start`, same process, nothing has had a chance to
 * fail yet), not because anything here still assumes it landed.
 */
const DEVICE_PID_PATH = "/data/local/tmp/porthole-ring.pid";

/**
 * The `-o` target the background session was started with. Nothing reads
 * this while the ring is running — snapshots go through `--clone-by-name`
 * to their own, separate files instead (see `deviceSnapshotPath`) — but
 * `perfetto` still needs *a* path to satisfy `-o`, and `kill -TERM`ing the
 * backgrounded process (`stop`'s own mechanism, see its doc comment) flushes
 * the session's final buffer contents here before exiting. `stop` deletes it
 * immediately after: `system_trace_stop` promises "no files behind", and a
 * flush nobody asked to keep is not an exception to that.
 *
 * QA (R2): also doubles as `findRunningRingPid`'s search tag below — it is
 * the one string, fixed across every ring session this controller ever
 * starts, that is guaranteed to appear in the argv of the exact process
 * this file starts and nothing else, since `-o <this path>` is literally
 * part of the command line `--background` was invoked with.
 */
const DEVICE_OUT_PATH = "/data/misc/perfetto-traces/porthole-ring.pftrace";

const DEVICE_TRACE_DIR = "/data/misc/perfetto-traces";

function deviceSnapshotPath(stamp: number, auto: boolean): string {
  return `${DEVICE_TRACE_DIR}/porthole-ring-${auto ? "auto-" : ""}${stamp}.pftrace`;
}

/**
 * Scans the device's own process table for a running `perfetto --background`
 * this controller started, returning its OS pid — or null when none is
 * found. adb itself failing is also null: a scan that could not run is not
 * proof of absence, but every caller here already treats "could not
 * confirm" and "confirmed absent" the same way (nothing more to kill, or
 * nothing blocking a fresh start).
 *
 * QA (R2): this is the fallback `stop` needs when `DEVICE_PID_PATH` was
 * never written (the marker write is itself best-effort — see its own doc
 * comment) or this process restarted before reading it, and the mechanism
 * `start` uses to refuse a second session it did not itself start (a
 * previous MCP process's ring, still running). `ps -A -o PID,ARGS` is
 * toybox's own format string (every Android version this project already
 * requires supports it); PID is the first column, ARGS is everything after
 * it, matched against `DEVICE_OUT_PATH` — see that constant's own doc
 * comment for why that string, not `unique_session_name`, is what a `ps`
 * listing can actually see.
 */
async function findRunningRingPid(options: RingAdbOptions): Promise<number | null> {
  const result = await runAdbAsync(["shell", "ps", "-A", "-o", "PID,ARGS"], adbOptions(options));
  if (!result.ok) return null;
  for (const line of result.output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pidText, args] = match;
    if (args.includes("perfetto") && args.includes(DEVICE_OUT_PATH)) {
      const pid = Number(pidText);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// measured overhead (GRA-57's spike; see the ticket report for the transcript)
// ---------------------------------------------------------------------------

/**
 * What the spike measured, baked in as a constant rather than computed live.
 *
 * A genuinely live number would mean shelling out to `top`/`/proc` on every
 * `porthole_status` call, which is a cost of its own and one this ticket
 * never asked for — "status reports the measured overhead" (the ticket's own
 * acceptance criterion) is satisfied by reporting what was actually
 * measured, honestly labelled by where it came from, not by re-measuring on
 * every call. `device: "emulator"` is load-bearing: every number here is
 * from `porthole-gra57` (Pixel 6 profile, API 36, arm64-v8a) under a light
 * synthetic input workload (20s of alternating `input swipe`/`input tap`
 * against the sample app, full `DEFAULT_CATEGORIES` plus `ATRACE_TAG_APP`,
 * default 32MB buffer) — never hardware, which the ticket leaves to a
 * separate physical-device pass.
 */
export const MEASURED_OVERHEAD = {
  device: "emulator",
  workload:
    "20s of synthetic input (alternating swipe/tap) against sample/, full DEFAULT_CATEGORIES + " +
    "ATRACE_TAG_APP, default 32MB ring buffer",
  cpuPercentOfOneCore: 0.45,
  note:
    "Combined traced + traced_probes + perfetto CPU-time delta (/proc/<pid>/stat utime+stime) " +
    "over 20s of wall time, against a measured 0% baseline with no session running. Hardware " +
    "measurement is a separate pass; this number is emulator-only and should not be read as a " +
    "device guarantee.",
} as const;

// ---------------------------------------------------------------------------
// controller
// ---------------------------------------------------------------------------

export interface RingAdbOptions {
  serial?: string;
  env?: NodeJS.ProcessEnv;
  binary?: string;
}

function adbOptions(o: RingAdbOptions, extra?: Partial<RunAdbAsyncOptions>): RunAdbAsyncOptions {
  return { serial: o.serial, env: o.env, binary: o.binary, ...extra };
}

export interface RingStartOptions extends RingAdbOptions {
  app: string;
  categories?: string[];
  bufferKb?: number;
}

export interface RingStartResult {
  ok: true;
  plan: RingPlan;
  pid: number;
  startedAt: number;
}

export interface RingFailure {
  ok: false;
  message: string;
}

export interface RingSnapshotOptions extends RingAdbOptions {
  outputDir?: string;
  /** Internal: true when `findings` triggered this rather than an explicit `system_trace_snapshot` call — only changes the on-device filename prefix, so an auto-snapshot cannot collide with, or be mistaken for, one a caller asked for by name. */
  auto?: boolean;
}

export interface RingSnapshotResult {
  ok: true;
  path: string;
  bytes: number;
  startedAt: number;
  requestedAt: number;
  elapsedMs: number;
  bufferKb: number;
  /** Honest, not precise: see `DEFAULT_RING_BUFFER_KB`'s own doc comment in systrace.ts for why this cannot promise an exact "last N seconds". */
  note: string;
}

export interface RingStopResult {
  ok: true;
  wasRunning: boolean;
  snapshotsTaken: number;
  message: string;
}

export interface RingStatus {
  running: boolean;
  startedAt: string | null;
  elapsedMs: number | null;
  app: string | null;
  categories: string[] | null;
  bufferKb: number | null;
  snapshots: number;
  lastSnapshotAt: string | null;
  /** QA (R4): the most recent completed snapshot's path/bytes — manual or auto, and set even though an auto-snapshot from `findings` is never awaited there. Null until the first snapshot completes. */
  lastSnapshot: { path: string; bytes: number; auto: boolean } | null;
  overhead: typeof MEASURED_OVERHEAD;
}

/** How long after an auto-snapshot another error-severity finding can trigger a second one. Not "once ever": a second, later error is worth its own evidence. Not "every call": an agent polling `findings` every few seconds while chasing the same still-ongoing error should not re-pull a multi-megabyte trace every time it asks. */
const AUTO_SNAPSHOT_COOLDOWN_MS = 10_000;

/**
 * Holds the one ring session this MCP server process knows about, and does
 * the three things `index.ts`'s `system_trace_*` tools need doing: start it,
 * pull a snapshot without stopping it, stop it and leave nothing behind.
 *
 * One instance per `createPortholeServer` call (see `index.ts`), the same
 * pattern `Watermark` already uses — not a module-level singleton, so two
 * rigs built in the same test process (or, in principle, two porthole
 * servers pointed at two devices) never share state neither asked to share.
 *
 * In-memory state is an optimisation, not the source of truth: `stop` always
 * re-reads `DEVICE_PID_PATH` off the device rather than trusting `this.pid`,
 * and falls back to `findRunningRingPid`'s process-table scan when that file
 * is missing or unreadable (QA's R2 finding on this ticket's first pass: the
 * marker write is itself best-effort, so it cannot be the only way `stop`
 * has of finding the session) — specifically so `stop` still works after
 * this process restarts and no longer remembers starting anything, or after
 * a marker write that simply never landed (GRA-57 AC: "stop leaves nothing
 * running and no files behind" has to hold even then).
 */
export class RingController {
  private running = false;
  private plan: RingPlan | null = null;
  private pid: number | null = null;
  private startedAt: number | null = null;
  private snapshotCount = 0;
  private lastSnapshotAt: number | null = null;
  private lastAutoSnapshotAt: number | null = null;
  /** QA (R4): the most recent snapshot's path/bytes, manual or auto — what `status()` reports as `lastSnapshot`. */
  private lastSnapshotResult: { path: string; bytes: number; auto: boolean } | null = null;
  /** QA (R4): a completed fire-and-forget auto-snapshot, waiting for the next `findings` call to attach it — consumed (read once, then cleared) by `triggerAutoSnapshotOnError`. */
  private pendingAutoSnapshot: { path: string; bytes: number } | null = null;
  /** QA (R4): true while a fire-and-forget auto-snapshot's own `snapshot()` call is still running — `triggerAutoSnapshotOnError` reads this instead of starting a second one on top of it. */
  private autoSnapshotInFlight = false;

  /**
   * QA (R1) on this ticket's first pass: every post-launch failure in this
   * function used to `return { ok: false, ... }` directly, with the
   * backgrounded session already recording on the device — reproduced with
   * a PID line the parse step could not read, which left a live `sched`
   * session running until reboot while both `this.running` and the device's
   * own pid marker stayed unset, so `system_trace_stop` reported "nothing
   * was running" about a session that very much was.
   *
   * This is the one exit path every failure *after* the launch command has
   * actually run goes through, so a session cannot be left behind by a
   * future failure branch that forgets to clean up — the same reasoning as
   * `joinSummaryAndPayload` in `index.ts` being the one place a result is
   * assembled. It scans for and kills whatever is running (R2's
   * `findRunningRingPid`, not a pid this function may not have — the launch
   * failing to hand one back cleanly is exactly the case this exists for)
   * before ever returning the failure, so a caller reading `ok: false` can
   * trust the device is clean, not merely reported as such.
   */
  private async failAfterLaunch(message: string, options: RingAdbOptions): Promise<RingFailure> {
    const pid = await findRunningRingPid(options);
    if (pid !== null) {
      await runAdbAsync(["shell", `kill -TERM ${pid}`], adbOptions(options));
    }
    // R3: a failed launch must not leave the pushed config behind either —
    // every failure path from here on removes it, not only the happy path.
    await runAdbAsync(["shell", `rm -f ${DEVICE_CONFIG_PATH}`], adbOptions(options));
    return { ok: false, message };
  }

  async start(options: RingStartOptions): Promise<RingStartResult | RingFailure> {
    if (this.running) {
      return {
        ok: false,
        message:
          `Already running, scoped to ${this.plan?.app}, since ${new Date(this.startedAt!).toISOString()}. ` +
          "Call system_trace_stop first if you want to change the app or categories.",
      };
    }

    const plan = planRing({ app: options.app, categories: options.categories, bufferKb: options.bufferKb });
    if (!plan.app) {
      return {
        ok: false,
        message:
          "No package to scope the ring to: connect to the app, or pass `app` explicitly — an " +
          "unscoped ring records no Porthole sections, defeating the reason to have one.",
      };
    }

    // QA (R2): refuses a session this process did not itself start, not
    // only a second call within the same process — an MCP server restart
    // leaves `this.running` false while a real session is still recording.
    const alreadyRunning = await findRunningRingPid(options);
    if (alreadyRunning !== null) {
      return {
        ok: false,
        message:
          `Already running on the device (pid ${alreadyRunning}), started by a process this one has ` +
          "no memory of. Call system_trace_stop first if you want to change the app or categories.",
      };
    }

    const dir = mkdtempSync(join(tmpdir(), "porthole-ring-"));
    const localConfigPath = join(dir, "config.pbtxt");
    writeFileSync(localConfigPath, ringConfigText(plan));

    try {
      const pushed = await runAdbAsync(["push", localConfigPath, DEVICE_CONFIG_PATH], adbOptions(options));
      // Nothing has launched yet — `failAfterLaunch` would scan for nothing
      // to kill, but going through it anyway costs an extra, pointless adb
      // round trip on the single most common failure shape (adb itself
      // unreachable). Returned directly, same as before.
      if (!pushed.ok) return { ok: false, message: `Could not push the ring config: ${pushed.output}` };

      // `--background-wait` (`-D`), not `--background` (`-d`): it blocks
      // until perfetto's own data sources have confirmed they started (up
      // to 30s) before the shell command returns, so a `started.ok` result
      // means the session is genuinely up and registered with `traced` —
      // not merely that a fork happened moments before adb's shell command
      // raced ahead of it. This is what makes the ps-scan immediately below
      // reliable rather than a hope that the fork has become visible yet.
      const started = await runAdbAsync(
        ["shell", `cat ${DEVICE_CONFIG_PATH} | perfetto --txt -c - --background-wait -o ${DEVICE_OUT_PATH}`],
        adbOptions(options),
      );
      if (!started.ok) {
        return this.failAfterLaunch(`Could not start the ring: ${started.output}`, options);
      }

      // QA (R1): the pid comes from the same device-side scan `stop` and
      // the already-running check above use, not from parsing perfetto's
      // own stdout — that used to be the *only* source, and it was also the
      // single point of failure R1 was filed against: a launch that
      // genuinely succeeded but whose pid could not be read back out of
      // stdout used to be reported as a failure with the session still
      // running. A scan of the device's own process table cannot be
      // "unparseable" the way one specific line of one process's stdout
      // can — it either finds the process or it does not.
      const pid = await findRunningRingPid(options);
      if (pid === null) {
        return this.failAfterLaunch(
          `perfetto --background-wait reported success, but no running session could be found ` +
            `afterward: ${started.output}`,
          options,
        );
      }

      // The marker is written from this same scanned pid, immediately —
      // "before the parse-dependent step" (QA's own words): there is no
      // longer a parse of perfetto's own stdout standing between "the
      // session is confirmed running" and "the device knows its own pid",
      // the way there used to be. Still best-effort: a failure to write it
      // does not undo a session that is genuinely running and already
      // discoverable by `findRunningRingPid` regardless — `stop` falls back
      // to that scan when this file is missing (see its own doc comment).
      await runAdbAsync(["shell", `printf %s ${pid} > ${DEVICE_PID_PATH}`], adbOptions(options));
      await runAdbAsync(["shell", `rm -f ${DEVICE_CONFIG_PATH}`], adbOptions(options));

      this.running = true;
      this.plan = plan;
      this.pid = pid;
      this.startedAt = Date.now();
      this.snapshotCount = 0;
      this.lastSnapshotAt = null;
      this.lastAutoSnapshotAt = null;
      this.pendingAutoSnapshot = null;
      this.autoSnapshotInFlight = false;

      return { ok: true, plan, pid, startedAt: this.startedAt };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async snapshot(options: RingSnapshotOptions): Promise<RingSnapshotResult | RingFailure> {
    if (!this.running || !this.plan || this.startedAt === null) {
      return { ok: false, message: "The ring is not running. Call system_trace_start first." };
    }

    const requestedAt = Date.now();
    const devicePath = deviceSnapshotPath(requestedAt, options.auto === true);

    const cloned = await runAdbAsync(
      ["shell", `perfetto --clone-by-name ${RING_SESSION_NAME} -o ${devicePath}`],
      adbOptions(options),
    );
    if (!cloned.ok) {
      // Perfetto's own message for "no session with this name" — seen on
      // the spike device when the backgrounded process had already died
      // (killed externally, or the device rebooted). Distinguishing this
      // from an ordinary adb hiccup is what lets a caller be told the ring
      // is not actually there any more, rather than "try again" advice for
      // a session that no longer exists.
      const died = /no.*session|not found|failed to find/i.test(cloned.output);
      if (died) {
        this.running = false;
        this.plan = null;
        this.pid = null;
        this.startedAt = null;
      }
      return {
        ok: false,
        message: died
          ? `The ring is no longer running on the device (it was, as of this server's own state) — ${cloned.output}`
          : `Could not clone the ring's current buffer: ${cloned.output}`,
      };
    }

    const dir = resolveOutputDir(options.outputDir);
    mkdirSync(dir, { recursive: true });
    const localPath = join(dir, devicePath.split("/").pop() as string);
    const pulled = await runAdbAsync(["pull", devicePath, localPath], adbOptions(options));
    // Tidy up regardless, the same as `capture_system_trace`'s own pull —
    // the device's trace directory is not ours to fill, snapshot or not.
    await runAdbAsync(["shell", `rm -f ${devicePath}`], adbOptions(options));
    if (!pulled.ok) return { ok: false, message: `Cloned, but could not pull it: ${pulled.output}` };

    const bytes = statSync(localPath).size;
    this.snapshotCount++;
    this.lastSnapshotAt = requestedAt;
    this.lastSnapshotResult = { path: localPath, bytes, auto: options.auto === true };
    const elapsedMs = requestedAt - this.startedAt;

    return {
      ok: true,
      path: localPath,
      bytes,
      startedAt: this.startedAt,
      requestedAt,
      elapsedMs,
      bufferKb: this.plan.bufferKb,
      note:
        `Covers up to the last ${Math.round(elapsedMs / 1000)}s, or less if the ${this.plan.bufferKb}KB ` +
        "ring had already filled and wrapped at some point before now — this host has no way to " +
        "verify the actual span from outside the trace itself.",
    };
  }

  /**
   * QA (R4) on this ticket's first pass: called from `findings` (in
   * `index.ts`) whenever this call's own result contains an error-severity
   * finding and the ring is running. Deliberately synchronous and deliberately
   * does not await the snapshot itself — cloning the ring and pulling up to
   * `bufferKb` worth of trace off the device is exactly the adb work GRA-89
   * made `capture_system_trace` non-blocking for, and `findings` reporting a
   * fresh error was not a reason to reintroduce that block on the very next
   * call. Three outcomes, none of which wait on adb:
   *
   *  - A previous fire-and-forget snapshot finished since the last time this
   *    was called: its path is handed back now (`attached`) and cleared, so
   *    it is reported exactly once — "the next findings call" the ticket
   *    describes.
   *  - One is still running (`autoSnapshotInFlight`): `inProgress: true`,
   *    nothing new started.
   *  - Neither, and the cooldown allows it: a new one is kicked off with
   *    `void this.snapshot(...)` — not `await`ed — and `inProgress: true` is
   *    returned for *this* call, since it has not landed yet either.
   *
   * A snapshot that fails (device hiccup, ring died mid-restart) is
   * swallowed in the `.catch` below the same way the old awaited version
   * already promised: `findings` itself must never fail because of this.
   */
  triggerAutoSnapshotOnError(
    hasErrorFinding: boolean,
    options: RingAdbOptions & { outputDir?: string },
  ): { attached: { path: string; bytes: number } | null; inProgress: boolean } {
    if (!hasErrorFinding || !this.running) return { attached: null, inProgress: false };

    if (this.pendingAutoSnapshot) {
      const attached = this.pendingAutoSnapshot;
      this.pendingAutoSnapshot = null;
      return { attached, inProgress: false };
    }
    if (this.autoSnapshotInFlight) return { attached: null, inProgress: true };

    const now = Date.now();
    if (this.lastAutoSnapshotAt !== null && now - this.lastAutoSnapshotAt < AUTO_SNAPSHOT_COOLDOWN_MS) {
      return { attached: null, inProgress: false };
    }
    this.lastAutoSnapshotAt = now;
    this.autoSnapshotInFlight = true;
    void this.snapshot({ ...options, auto: true })
      .then((result) => {
        if (result.ok) this.pendingAutoSnapshot = { path: result.path, bytes: result.bytes };
      })
      .catch(() => {
        // Best-effort, per this method's own doc comment: nothing to attach,
        // and nothing for a caller of `findings` to see beyond that.
      })
      .finally(() => {
        this.autoSnapshotInFlight = false;
      });
    return { attached: null, inProgress: true };
  }

  async stop(options: RingAdbOptions): Promise<RingStopResult> {
    // Re-read the device's own record of the pid rather than trusting
    // `this.pid` — see `DEVICE_PID_PATH`'s own doc comment for why: a `stop`
    // from a process that never called `start` (an MCP restart in between)
    // must still be able to find and kill the real session.
    const catResult = await runAdbAsync(["shell", `cat ${DEVICE_PID_PATH}`], adbOptions(options));
    const devicePidLine = catResult.ok ? catResult.output.split("\n").find((l) => /^\d+$/.test(l.trim())) : undefined;
    const devicePid = devicePidLine ? Number(devicePidLine.trim()) : null;

    // QA (R2): the marker is itself best-effort (see `DEVICE_PID_PATH`'s doc
    // comment) — when it is missing or unreadable, fall back to the same
    // process-table scan `start` uses to refuse a second session, rather
    // than concluding "nothing to stop" from the absence of one file that
    // was never the actual source of truth.
    const scannedPid = devicePid === null ? await findRunningRingPid(options) : null;
    const pid = devicePid ?? scannedPid ?? this.pid;

    const wasRunning = this.running || devicePid !== null || scannedPid !== null;

    if (pid !== null) {
      // Best-effort: a process that already exited (crashed, or a previous
      // stop half-completed) makes this fail harmlessly, which is fine —
      // the cleanup below removes whatever files it left regardless.
      await runAdbAsync(["shell", `kill -TERM ${pid}`], adbOptions(options));
    }

    // Tidy up every path this controller could possibly have created,
    // whether or not this particular stop found a live process — a marker
    // file, a config file, or a flushed-but-unwanted output from a previous
    // half-finished start/stop must not survive a stop that runs after them.
    await runAdbAsync(
      [
        "shell",
        `rm -f ${DEVICE_PID_PATH} ${DEVICE_CONFIG_PATH} ${DEVICE_OUT_PATH} ` +
          `${DEVICE_TRACE_DIR}/porthole-ring-*.pftrace ${DEVICE_TRACE_DIR}/porthole-ring-auto-*.pftrace`,
      ],
      adbOptions(options),
    );

    const snapshotsTaken = this.snapshotCount;
    this.running = false;
    this.plan = null;
    this.pid = null;
    this.startedAt = null;
    this.lastSnapshotAt = null;
    this.lastSnapshotResult = null;
    this.pendingAutoSnapshot = null;
    // Deliberately NOT resetting `autoSnapshotInFlight`: a fire-and-forget
    // snapshot already in flight when `stop` runs cannot be cancelled, only
    // left to fail quietly against a session that is now gone (its own
    // `.catch` already handles that) once it settles.

    return {
      ok: true,
      wasRunning,
      snapshotsTaken,
      message: wasRunning
        ? `Stopped the ring${snapshotsTaken > 0 ? ` (${snapshotsTaken} snapshot(s) were taken while it ran)` : ""}.`
        : "Nothing was running.",
    };
  }

  status(): RingStatus {
    return {
      running: this.running,
      startedAt: this.startedAt !== null ? new Date(this.startedAt).toISOString() : null,
      elapsedMs: this.startedAt !== null ? Date.now() - this.startedAt : null,
      app: this.plan?.app ?? null,
      categories: this.plan?.categories ?? null,
      bufferKb: this.plan?.bufferKb ?? null,
      snapshots: this.snapshotCount,
      lastSnapshotAt: this.lastSnapshotAt !== null ? new Date(this.lastSnapshotAt).toISOString() : null,
      // QA (R4): the most recent snapshot's path/bytes, manual or auto — so
      // an auto-snapshot fired from `findings` (never awaited there, see
      // `triggerAutoSnapshotOnError`) is still discoverable from here even
      // before the next `findings` call happens to ask again.
      lastSnapshot: this.lastSnapshotResult,
      overhead: MEASURED_OVERHEAD,
    };
  }
}

/**
 * QA (R5): anchored on `resolveProjectRoot()`, not `process.cwd()` — the
 * same root `save.ts`'s `defaultOutPath` (line 77) is given by its caller in
 * `index.ts`, and what `sessions.ts` resolves session storage under: an MCP
 * server's working directory is whatever launched it, not necessarily the
 * project it is attached to. This used to read `process.cwd()` directly,
 * the one place among this project's several `.porthole/traces` writers
 * that did not already agree with `save_moment`'s and the session store's
 * own choice of root.
 */
function resolveOutputDir(outputDir?: string): string {
  return outputDir ? outputDir : join(resolveProjectRoot().directory, ".porthole", "traces");
}
