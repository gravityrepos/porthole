// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

/**
 * GRA-53: sessions on disk.
 *
 * A session is one contiguous run of one app process, identified by
 * `(packageName, startedAt, deviceId)` — the triple `TimelineServer` already
 * uses `startedAt` alone to decide when to clear its in-memory ring on a new
 * `hello` (see `timeline.ts`). Everything here is a leaf module on purpose:
 * it does not import from `device.ts`, so it can be exercised and reviewed in
 * total isolation, and the type shapes below (`SessionEvent`, `HelloLike`)
 * are deliberately structural subsets of `DeviceEvent`/`Hello` rather than
 * imports of them — `device.ts` hands its own values to these functions
 * without conversion once it is wired up, but nothing here needs to know
 * that `device.ts` exists at all.
 *
 * Layout: `<root>/<packageName>_<deviceId>_<startedAt>/events.ndjson` (one
 * JSON object per line, append-only) plus `meta.json` (identity, device
 * profile, first/last `t`, per-kind event counts). NDJSON because it is
 * crash-safe by construction — a partial last line from a write that never
 * finished is the only thing a reader can lose — and `tail`-able by a human.
 *
 * Redaction is unchanged and non-negotiable: whatever lands in `events.ndjson`
 * is exactly the event stream that already crossed the socket, which is
 * already starred, redacted and body-capture-gated in-process before it ever
 * reaches here. This module records the wire, verbatim; it does not look
 * inside `data` and does not add a second redaction pass — a second pass
 * would be a second place for the rule to be implemented correctly or not.
 */

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/** The event shape this module stores. Structurally `DeviceEvent`. */
export interface SessionEvent {
  event: string;
  /** Device uptime in ms — see the module doc comment on why sessions merge on this clock. */
  t: number;
  seq: number;
  data: unknown;
}

/** The subset of `Hello` a session's identity and `meta.json` are built from. */
export interface HelloLike {
  packageName: string;
  startedAt: number;
  device: string;
  sdkInt: number;
  versionName: string | null;
  /**
   * GRA-53 Q4/open-question-2: not adb's own device serial (that is known
   * host-side — see `PortholeConnectTask.connectionFile`'s `deviceSerial`
   * field in the Gradle plugin, a wholly different mechanism GRA-119 owns —
   * and an app cannot read it without a permission this debug-only library
   * has no business requesting). This is deliberately optional: existing
   * `hello` fixtures across the test suite do not set it, and a device/build
   * that has not been updated to send one must not break session identity,
   * only degrade it — see `UNKNOWN_DEVICE_ID` below.
   */
  deviceId?: string;
}

/** Stand-in for `deviceId` when a `hello` did not carry one. */
export const UNKNOWN_DEVICE_ID = "unknown-device";

export interface SessionIdentity {
  packageName: string;
  deviceId: string;
  startedAt: number;
}

export function sessionIdentity(hello: HelloLike): SessionIdentity {
  return {
    packageName: hello.packageName,
    deviceId: hello.deviceId ?? UNKNOWN_DEVICE_ID,
    startedAt: hello.startedAt,
  };
}

/**
 * A filesystem-safe fragment: anything outside a conservative allowlist
 * becomes `_`. `packageName` is always dotted-identifier-shaped in practice,
 * but `deviceId` is whatever a future device sends, and this directory name
 * doubles as `findSessionsForIdentity`'s prefix filter — an unsanitised
 * separator character in either value could make one identity's directory
 * look like a prefix of another's.
 */
function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "_");
  return cleaned.length > 0 ? cleaned : "_";
}

export function sessionDirName(identity: SessionIdentity): string {
  return `${sanitize(identity.packageName)}_${sanitize(identity.deviceId)}_${identity.startedAt}`;
}

export function sessionsRoot(projectRoot: string): string {
  return path.join(projectRoot, ".porthole", "sessions");
}

function metaPath(dir: string): string {
  return path.join(dir, "meta.json");
}

function eventsPath(dir: string): string {
  return path.join(dir, "events.ndjson");
}

/**
 * This directory holds redacted-but-real app data (logcat lines, SQL bind
 * values, HTTP headers) sitting on disk for up to [DEFAULT_RETENTION]'s
 * `maxAgeMs`, rather than in a process's memory that dies with it — a
 * different promise to a user than the in-memory ring ever made, per the
 * ticket's own security note. Owner-only permissions are the cheap half of
 * making that true.
 *
 * POSIX only. `fs`'s `mode` option is Unix permission bits; Windows/NTFS has
 * no such concept (it uses ACLs instead), and Node's own docs say `mode` is
 * "Not supported on Windows" — passing one there is not wrong, just inert,
 * so every call site below gates on this rather than silently no-op'ing on
 * one platform without saying so.
 */
const isPosix = process.platform !== "win32";

/** Owner rwx only — the sessions root and every session directory under it (recursive `mkdir` applies this to each level it creates). */
const SESSION_DIR_MODE = 0o700;
/** Owner rw only — `meta.json` and `events.ndjson`. Applied at file creation; an already-existing file keeps whatever mode it was created with. */
const SESSION_FILE_MODE = 0o600;

function dirOptions(): { recursive: true; mode?: number } {
  return isPosix ? { recursive: true, mode: SESSION_DIR_MODE } : { recursive: true };
}

function fileOptions(): { mode?: number } {
  return isPosix ? { mode: SESSION_FILE_MODE } : {};
}

// ---------------------------------------------------------------------------
// meta.json
// ---------------------------------------------------------------------------

export interface SessionMeta {
  packageName: string;
  deviceId: string;
  startedAt: number;
  device: string;
  sdkInt: number;
  versionName: string | null;
  /** Null until at least one event has been written. Device-uptime `t`, not wall clock. */
  firstT: number | null;
  lastT: number | null;
  eventCounts: Record<string, number>;
  /** Wall clock (`Date.now()`) the session directory was created. */
  createdAt: number;
  /** Wall clock of the most recent flush. What retention ages a session by. */
  updatedAt: number;
}

async function readMeta(dir: string): Promise<SessionMeta | null> {
  try {
    return JSON.parse(await readFile(metaPath(dir), "utf8")) as SessionMeta;
  } catch {
    // Absent, unreadable or corrupt are all the same to a caller: there is no
    // meta to report, so callers that need one (retention, cross-session
    // lookup) skip the directory rather than guessing at its contents.
    return null;
  }
}

// ---------------------------------------------------------------------------
// the writer
// ---------------------------------------------------------------------------

/**
 * Appends one session's events to disk, off the socket callback and on an
 * interval — never a synchronous write per event, which is what "must not
 * touch the socket read path" (AC4) means concretely: `append()` only ever
 * pushes to an in-memory array and arms a timer; the actual `fs` write
 * happens later, on `flush()`, awaited by nothing on the hot path.
 *
 * One writer instance is meant to live as long as one `DeviceClient` — see
 * that file's `#session-writer` section once it is wired up — so `open()` is
 * called once per `hello` and `append()` once per event in between.
 */
export class SessionWriter {
  private dir: string | null = null;
  private meta: SessionMeta | null = null;
  private queue: SessionEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Chains flushes so an interval tick and an explicit flush() never interleave two appendFile calls on the same file. */
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    readonly root: string,
    private readonly flushIntervalMs: number = 250,
  ) {}

  /**
   * Begins (or resumes) the session named by `hello`'s identity.
   *
   * Idempotent for an unchanged identity — a reconnect that gets the same
   * `hello` back (GRA-163: the same process, socket dropped and reattached)
   * must not re-open anything or lose queued events. A *new* identity first
   * flushes whatever the previous session still owed: `device.ts` only calls
   * `open()` from the `hello` handler, and a new `hello` always means a new
   * process (or a distinct device) — nothing more will ever arrive for the
   * one just left behind, so this is the only chance to flush it promptly
   * rather than waiting on a timer that a new session's own events would
   * otherwise keep resetting.
   *
   * "A second MCP server attaching to the same app appends to the same
   * session" (the ticket's own words): the directory name is a pure function
   * of identity, so a second writer computes the same path and finds the
   * directory (and `meta.json`) already there — this reads it back rather
   * than overwriting it, so the counts and `firstT` it reports are the whole
   * session's, not just what this instance has seen.
   */
  async open(hello: HelloLike): Promise<void> {
    // PORTHOLE_SESSIONS=0 is the off switch: `dir` is left null, exactly the
    // "no root configured" shape `append()` already treats as a silent
    // no-op, and neither `mkdir` nor a retention sweep ever touches the
    // sessions root. Checked first, and every time — not cached at
    // construction — so it stays cheap to reason about (one env read, one
    // branch) rather than a second piece of state that could drift from the
    // environment it mirrors.
    if (!sessionsEnabled()) return;

    const identity = sessionIdentity(hello);
    const dir = path.join(this.root, sessionDirName(identity));
    if (this.dir === dir) return;

    await this.flush();

    this.dir = dir;
    await mkdir(dir, dirOptions());
    this.meta = (await readMeta(dir)) ?? {
      packageName: identity.packageName,
      deviceId: identity.deviceId,
      startedAt: identity.startedAt,
      device: hello.device,
      sdkInt: hello.sdkInt,
      versionName: hello.versionName,
      firstT: null,
      lastT: null,
      eventCounts: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await writeFile(metaPath(dir), JSON.stringify(this.meta, null, 2), fileOptions());

    // Every new (or resumed) session is a natural, cheap point to sweep: it
    // is already the moment this writer is about to grow the directory it
    // would prune from, and it means retention runs on the same cadence a
    // long-lived MCP server actually sees `hello`s, not on a separate timer
    // this ticket does not need. `activeDir` is *this* session, just opened
    // above — never the one about to be pruned, no matter its age or size.
    await enforceRetention(this.root, retentionOptionsFromEnv(), this.currentDir());
  }

  /**
   * Queues an event. The actual disk write happens on the next `flush()`,
   * arranged on a timer here — never inline, which is the whole point (AC4).
   *
   * Silently does nothing without an open session: persistence being off (no
   * root configured — see `device.ts`) or `hello` not having landed yet both
   * look like this from the caller's side, and neither is an error.
   */
  append(event: SessionEvent): void {
    if (!this.dir) return;
    this.queue.push(event);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, this.flushIntervalMs);
      // Node-only guard: a raw `setTimeout` return value in a browser bundle
      // has no `.unref`. This module never runs in a browser, but `.unref?.()`
      // costs nothing and stops a lingering timer from being the reason a
      // short-lived script (a test, a one-shot CLI invocation) hangs on exit.
      (this.flushTimer as { unref?: () => void }).unref?.();
    }
  }

  /** Writes whatever is queued. Safe to call at any time; a no-op with nothing queued. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.doFlush());
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dir || this.queue.length === 0) return;

    const dir = this.dir;
    const batch = this.queue;
    this.queue = [];

    const lines = batch.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await mkdir(dir, dirOptions());
    await appendFile(eventsPath(dir), lines, { encoding: "utf8", ...fileOptions() });

    const meta = this.meta ?? (await readMeta(dir));
    if (meta) {
      for (const event of batch) {
        meta.eventCounts[event.event] = (meta.eventCounts[event.event] ?? 0) + 1;
        meta.firstT = meta.firstT === null ? event.t : Math.min(meta.firstT, event.t);
        meta.lastT = meta.lastT === null ? event.t : Math.max(meta.lastT, event.t);
      }
      meta.updatedAt = Date.now();
      this.meta = meta;
      await writeFile(metaPath(dir), JSON.stringify(meta, null, 2), fileOptions());
    }
  }

  currentDir(): string | null {
    return this.dir;
  }

  currentMeta(): SessionMeta | null {
    return this.meta;
  }
}

// ---------------------------------------------------------------------------
// fallback read — GRA-53 Q1: a scan, not an index
// ---------------------------------------------------------------------------

/**
 * Streams `events.ndjson` and returns the events whose `t` falls in
 * `[from, to]`, oldest first.
 *
 * **Q1, answered by measurement, not assumption**: does the fallback read
 * need an index, or is a per-minute byte-offset scan enough for a 30-minute
 * session? `sessions.test.ts` writes a real ~30-minute-equivalent NDJSON file
 * (54,000 lines at 30 events/sec, this module's own estimate of "a busy
 * app" — see `EventRing.DEFAULT_CAPACITY`'s comment for where that rate
 * comes from) and asserts a window read completes well inside a second on
 * ordinary hardware. A plain sequential scan was fast enough that building
 * and maintaining a byte-offset index — one more structure that can disagree
 * with the file it indexes — was not worth the ticket's own warning: "an
 * index you did not need is cost you cannot remove later."
 *
 * Streams rather than reading the whole file into memory (the device AC
 * asks for exactly this): `createReadStream` plus `readline` never holds
 * more than one line at a time, so this scales past whatever `--max-old-
 * space-size` a long session's file would otherwise threaten.
 */
export async function readSessionWindow(dir: string, from: number, to: number): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(eventsPath(dir), { encoding: "utf8" });
    let settled = false;
    const onError = (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      // No file at all (a session directory with nothing flushed yet, or one
      // that never existed) is not a caller error — it just has nothing to
      // contribute to the window.
      if (error.code === "ENOENT") resolve();
      else reject(error);
    };
    // Both the stream and the readline interface built on it can be the one
    // to actually emit "error" depending on Node's version and exactly when
    // the open() failure lands relative to readline wiring itself up — an
    // ENOENT on a missing session directory reliably surfaced as an
    // *uncaught* exception here until both were listened to, because an
    // EventEmitter with no "error" listener throws rather than swallowing.
    stream.on("error", onError);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("error", onError);
    rl.on("line", (line) => {
      if (!line) return;
      try {
        const event = JSON.parse(line) as SessionEvent;
        if (event.t >= from && event.t <= to) out.push(event);
      } catch {
        // A torn last line — a flush that was killed mid-write — is a
        // possibility this format accepts by design (the ticket's own
        // reasoning for NDJSON: "crash-safe by construction"). Skipping it
        // loses at most one event, never the read.
      }
    });
    rl.on("close", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });
  return out;
}

/** `meta.json`'s content, plus the directory it came from. */
export type SessionMetaWithDir = SessionMeta & { dir: string };

/**
 * Every session on disk for one `(packageName, deviceId)`, oldest first.
 *
 * A directory scan plus one small `meta.json` read per session — not an
 * index, and deliberately not: a working app accumulates a handful of
 * sessions between retention sweeps, not thousands, so this is cheap without
 * needing to be clever. Out of scope (the ticket's own words): "any query
 * language over sessions." This is the one lookup the window-fallback tools
 * need — "which session(s) could this window's data be sitting in" — and no
 * more.
 */
export async function findSessionsForIdentity(
  root: string,
  packageName: string,
  deviceId: string,
): Promise<SessionMetaWithDir[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const prefix = `${sanitize(packageName)}_${sanitize(deviceId)}_`;
  const out: SessionMetaWithDir[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const dir = path.join(root, name);
    const meta = await readMeta(dir);
    if (meta) out.push({ ...meta, dir });
  }
  out.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

// ---------------------------------------------------------------------------
// merging memory and disk for one window — GRA-53's restart-boundary AC
// ---------------------------------------------------------------------------

export interface WindowFill {
  /** Sorted by `t`, deduplicated, restricted to `[from, to]`. */
  events: SessionEvent[];
  /** `t` of the earliest event actually returned, or null if the merge found nothing. */
  oldest: number | null;
  newest: number | null;
  /**
   * The honest extent of the window that is actually *recorded* — from the
   * live buffer's own bounds and every overlapping session's `[firstT,
   * lastT]` — clipped to `[from, to]`. Null when nothing (buffer nor disk)
   * overlaps the window at all.
   *
   * Deliberately not derived from `events`/`oldest`/`newest` above: a quiet
   * stretch inside a fully-recorded session (nothing happened for five
   * minutes of a busy app) must not read as "clipped" just because no event
   * landed there — `clippedMs` (index.ts) is a coverage question, not a
   * did-anything-happen question, and answering it from matched events
   * alone would conflate the two. This is the union of coverage ranges that
   * touch the window, which slightly overstates coverage across a genuine
   * gap between two sessions (the device was actually off in between) —
   * the same approximation the pre-ticket code already made using the live
   * buffer's own bounds alone, not a new one introduced here.
   */
  coveredFrom: number | null;
  coveredTo: number | null;
}

/**
 * The one place "what actually happened in this window" is answered from
 * both the live in-memory buffer and whatever sessions on disk overlap it —
 * so `findings`, `what_was_happening` and `timeline` (once `index.ts`'s
 * `#window-fallback` section calls this) all agree, instead of three
 * separately hand-rolled merges that drift the way GRA-163's history warns
 * about.
 *
 * **The restart-boundary case, built deliberately with the boundary inside
 * the window rather than adjacent to it** (this ticket's own instruction):
 * `sessions.test.ts` asks for a window that starts before an old session's
 * last event and ends after a new session's first one, with both sessions
 * present on disk and a live buffer holding only the new session's events —
 * exactly what "the MCP server was killed and restarted mid-session" (AC1)
 * or "the app was reinstalled" (the ticket's own motivating scenario)
 * produce. The assertion is on the *merged* list: both sides present, in
 * `t` order, no event twice.
 *
 * Deduplication key is `(sessionDir, seq)`, not `seq` alone — `seq` is a
 * monotonic counter that restarts at zero in every process (`EventRing.kt`),
 * so two different sessions' events can carry the same `seq` and are not
 * the same event; an event already in `buffered` and *also* already flushed
 * to the current session's own file (a flush landing between the two reads)
 * shares both the directory and the `seq`, and is the same event, so it is
 * kept once. `currentSessionDir` supplies that directory for in-memory
 * events — pass `device.sessions?.currentDir() ?? null`.
 */
export async function fillWindowFromDisk(params: {
  root: string;
  identity: { packageName: string; deviceId: string } | null;
  buffered: SessionEvent[];
  currentSessionDir: string | null;
  from: number;
  to: number;
}): Promise<WindowFill> {
  const seen = new Set<string>();
  const merged: SessionEvent[] = [];
  const keyOf = (dir: string | null, seq: number) => `${dir ?? "?"}:${seq}`;

  const take = (event: SessionEvent, dir: string | null) => {
    const key = keyOf(dir, event.seq);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(event);
  };

  let coveredFrom: number | null = null;
  let coveredTo: number | null = null;
  const widen = (rangeFrom: number, rangeTo: number) => {
    const from = Math.max(params.from, rangeFrom);
    const to = Math.min(params.to, rangeTo);
    if (from > to) return; // this range does not actually touch the window
    coveredFrom = coveredFrom === null ? from : Math.min(coveredFrom, from);
    coveredTo = coveredTo === null ? to : Math.max(coveredTo, to);
  };

  for (const event of params.buffered) {
    if (event.t < params.from || event.t > params.to) continue;
    take(event, params.currentSessionDir);
  }
  if (params.buffered.length > 0) {
    widen(params.buffered[0].t, params.buffered[params.buffered.length - 1].t);
  }

  if (params.identity) {
    const sessions = await findSessionsForIdentity(params.root, params.identity.packageName, params.identity.deviceId);
    for (const session of sessions) {
      if (session.firstT === null || session.lastT === null) continue;
      if (session.lastT < params.from || session.firstT > params.to) continue;
      widen(session.firstT, session.lastT);
      const fromDisk = await readSessionWindow(session.dir, params.from, params.to);
      for (const event of fromDisk) take(event, session.dir);
    }
  }

  merged.sort((a, b) => a.t - b.t || a.seq - b.seq);
  return {
    events: merged,
    oldest: merged.length > 0 ? merged[0].t : null,
    newest: merged.length > 0 ? merged[merged.length - 1].t : null,
    coveredFrom,
    coveredTo,
  };
}

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

export interface RetentionOptions {
  maxBytes: number;
  maxAgeMs: number;
}

/** ~500MB / 7 days: the ticket's own defaults. Configurable via env and the `porthole {}` block once GRA-119 lands a way to carry Gradle config to the MCP server; both are plain numbers here so that wiring is a call-site change, not a rewrite. */
export const DEFAULT_RETENTION: RetentionOptions = {
  maxBytes: 500 * 1024 * 1024,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
};

/**
 * The env half of retention config — `SessionWriter.open()`'s only caller of
 * `enforceRetention`, so this is where the override actually lands. The
 * `porthole {}` DSL half (a Gradle-side setting reaching the MCP server) is
 * explicitly **not** part of this ticket; env vars are the whole mechanism
 * for now, and are not superseded by the DSL arriving later — that would be
 * a second source of truth for the same two numbers.
 *
 * Missing, empty or malformed values (`""`, `"abc"`, a negative number, `0`)
 * all fall back to [DEFAULT_RETENTION] rather than producing a retention
 * policy that prunes everything or nothing by accident — a typo in an env
 * var should degrade to "the documented default", not to undefined
 * behaviour.
 */
export function retentionOptionsFromEnv(): RetentionOptions {
  const maxBytes = parsePositiveInt(process.env.PORTHOLE_SESSIONS_MAX_BYTES);
  const maxAgeDays = parsePositiveInt(process.env.PORTHOLE_SESSIONS_MAX_AGE_DAYS);
  return {
    maxBytes: maxBytes ?? DEFAULT_RETENTION.maxBytes,
    maxAgeMs: maxAgeDays !== undefined ? maxAgeDays * 24 * 60 * 60 * 1000 : DEFAULT_RETENTION.maxAgeMs,
  };
}

/** A positive integer, or `undefined` for anything that is not one — missing, empty, `NaN`, zero, negative or fractional-but-non-finite input all collapse to "no override". */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * `PORTHOLE_SESSIONS=0` is the documented off switch (README's "Sessions on
 * disk" section): any other value, including unset, leaves writing on. This
 * is read fresh on every `open()` call rather than cached, so a test (or a
 * host that changes its own environment) never has to worry about import
 * order.
 */
export function sessionsEnabled(): boolean {
  return process.env.PORTHOLE_SESSIONS !== "0";
}

interface SessionDirInfo {
  dir: string;
  bytes: number;
  updatedAt: number;
}

async function sessionDirInfo(dir: string): Promise<SessionDirInfo | null> {
  let bytes = 0;
  let updatedAt = 0;
  try {
    const eventsStat = await stat(eventsPath(dir));
    bytes += eventsStat.size;
    updatedAt = eventsStat.mtimeMs;
  } catch {
    // No events file at all: not a session directory (or one that was never
    // written to), either way nothing for retention to weigh.
    return null;
  }
  try {
    bytes += (await stat(metaPath(dir))).size;
  } catch {
    // Missing meta.json is odd but not fatal for sizing.
  }
  const meta = await readMeta(dir);
  // meta.updatedAt is the session's own account of when it was last written;
  // preferred over the file's mtime because a session that was recreated
  // (readMeta found nothing so a fresh meta.json was written, but the
  // underlying events.ndjson survived from an earlier, much older run — not
  // a real scenario today, but nothing here should quietly rely on it not
  // happening) would otherwise inherit a misleading age from the wrong file.
  return { dir, bytes, updatedAt: meta?.updatedAt ?? updatedAt };
}

/**
 * Prunes sessions by both age and total size, oldest-updated first, and
 * never touches `activeDir` — the session currently being written — no
 * matter how old or how large it is. That guarantee is the point of taking
 * `activeDir` as a parameter rather than inferring "in progress" from
 * `updatedAt` being recent: a session that has been open for hours without a
 * new event (an idle app) is still the one in progress, and recency of the
 * last write is exactly the signal retention otherwise uses to decide what
 * is safe to delete.
 */
export async function enforceRetention(
  root: string,
  options: RetentionOptions = DEFAULT_RETENTION,
  activeDir: string | null = null,
): Promise<{ prunedDirs: string[] }> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return { prunedDirs: [] };
  }

  const infos: SessionDirInfo[] = [];
  for (const name of names) {
    const info = await sessionDirInfo(path.join(root, name));
    if (info) infos.push(info);
  }

  const active = infos.filter((info) => info.dir === activeDir);
  const prunable = infos.filter((info) => info.dir !== activeDir);
  prunable.sort((a, b) => a.updatedAt - b.updatedAt);

  const now = Date.now();
  const survivors: SessionDirInfo[] = [];
  const pruned: string[] = [];
  for (const info of prunable) {
    if (now - info.updatedAt > options.maxAgeMs) {
      pruned.push(info.dir);
    } else {
      survivors.push(info);
    }
  }

  let total =
    active.reduce((sum, info) => sum + info.bytes, 0) + survivors.reduce((sum, info) => sum + info.bytes, 0);
  let i = 0;
  while (total > options.maxBytes && i < survivors.length) {
    total -= survivors[i].bytes;
    pruned.push(survivors[i].dir);
    i++;
  }

  for (const dir of pruned) {
    await rm(dir, { recursive: true, force: true });
  }
  return { prunedDirs: pruned };
}
