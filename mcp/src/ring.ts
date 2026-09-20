// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdbAsync, type RunAdbAsyncOptions } from "./adb.js";
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
 * what makes that possible without relying on `--query`'s output (which
 * reports a session, not the OS pid of the process that owns it) or on
 * `pgrep -f` matching a command line that says nothing unique about which
 * ring is "ours".
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
 */
const DEVICE_OUT_PATH = "/data/misc/perfetto-traces/porthole-ring.pftrace";

const DEVICE_TRACE_DIR = "/data/misc/perfetto-traces";

function deviceSnapshotPath(stamp: number, auto: boolean): string {
  return `${DEVICE_TRACE_DIR}/porthole-ring-${auto ? "auto-" : ""}${stamp}.pftrace`;
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
 * re-reads `DEVICE_PID_PATH` off the device rather than trusting
 * `this.pid`, specifically so it still works after this process restarts
 * and no longer remembers starting anything (GRA-57 AC: "stop leaves
 * nothing running and no files behind" has to hold even then).
 */
export class RingController {
  private running = false;
  private plan: RingPlan | null = null;
  private pid: number | null = null;
  private startedAt: number | null = null;
  private snapshotCount = 0;
  private lastSnapshotAt: number | null = null;
  private lastAutoSnapshotAt: number | null = null;

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

    const dir = mkdtempSync(join(tmpdir(), "porthole-ring-"));
    const localConfigPath = join(dir, "config.pbtxt");
    writeFileSync(localConfigPath, ringConfigText(plan));

    try {
      const pushed = await runAdbAsync(["push", localConfigPath, DEVICE_CONFIG_PATH], adbOptions(options));
      if (!pushed.ok) return { ok: false, message: `Could not push the ring config: ${pushed.output}` };

      const started = await runAdbAsync(
        ["shell", `cat ${DEVICE_CONFIG_PATH} | perfetto --txt -c - --background -o ${DEVICE_OUT_PATH}`],
        adbOptions(options),
      );
      if (!started.ok) {
        return { ok: false, message: `Could not start the ring: ${started.output}` };
      }

      // `--background`'s PID is the first line of stdout; a PTY warning
      // perfetto writes to stderr on some hosts lands after it once
      // runAdbAsync merges the two streams (stdout first, stderr appended —
      // see adb.ts). Scanning every line for the first one that is purely
      // digits is robust to that warning appearing, or not, on a given host.
      const pidLine = started.output.split("\n").find((line) => /^\d+$/.test(line.trim()));
      const pid = pidLine ? Number(pidLine.trim()) : NaN;
      if (!Number.isInteger(pid) || pid <= 0) {
        return {
          ok: false,
          message: `Started, but could not read back a PID from perfetto's own output: ${started.output}`,
        };
      }

      // Best-effort: a failure to record the PID marker or clean up the
      // pushed config does not undo a session that is genuinely running —
      // `stop` still finds the process by PID if this write landed, and the
      // config file left behind is harmless (it is overwritten by the next
      // `start`, and `stop` also removes it defensively).
      await runAdbAsync(["shell", `printf %s ${pid} > ${DEVICE_PID_PATH}`], adbOptions(options));
      await runAdbAsync(["shell", `rm -f ${DEVICE_CONFIG_PATH}`], adbOptions(options));

      this.running = true;
      this.plan = plan;
      this.pid = pid;
      this.startedAt = Date.now();
      this.snapshotCount = 0;
      this.lastSnapshotAt = null;
      this.lastAutoSnapshotAt = null;

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
   * GRA-57: called from `findings` (in `index.ts`) whenever this call's own
   * result contains an error-severity finding and the ring is running.
   * Cooldown-gated (`AUTO_SNAPSHOT_COOLDOWN_MS`) and best-effort — a failed
   * auto-snapshot is swallowed rather than surfaced, because `findings`
   * itself must not start failing just because the ring happened to be
   * mid-restart or the device hiccuped; the finding is still reported either
   * way, just without a trace attached.
   */
  async maybeAutoSnapshotOnError(
    hasErrorFinding: boolean,
    options: RingAdbOptions & { outputDir?: string },
  ): Promise<{ path: string; bytes: number } | null> {
    if (!hasErrorFinding || !this.running) return null;
    const now = Date.now();
    if (this.lastAutoSnapshotAt !== null && now - this.lastAutoSnapshotAt < AUTO_SNAPSHOT_COOLDOWN_MS) return null;
    this.lastAutoSnapshotAt = now;

    const result = await this.snapshot({ ...options, auto: true });
    return result.ok ? { path: result.path, bytes: result.bytes } : null;
  }

  async stop(options: RingAdbOptions): Promise<RingStopResult> {
    // Re-read the device's own record of the pid rather than trusting
    // `this.pid` — see this class's own doc comment for why: a `stop` from
    // a process that never called `start` (an MCP restart in between) must
    // still be able to find and kill the real session.
    const catResult = await runAdbAsync(["shell", `cat ${DEVICE_PID_PATH}`], adbOptions(options));
    const devicePidLine = catResult.ok ? catResult.output.split("\n").find((l) => /^\d+$/.test(l.trim())) : undefined;
    const devicePid = devicePidLine ? Number(devicePidLine.trim()) : null;
    const pid = devicePid ?? this.pid;

    const wasRunning = this.running || devicePid !== null;

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
      overhead: MEASURED_OVERHEAD,
    };
  }
}

function resolveOutputDir(outputDir?: string): string {
  return outputDir ? outputDir : join(process.cwd(), ".porthole", "traces");
}
