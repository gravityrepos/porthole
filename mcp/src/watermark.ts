// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "./trace.js";

/**
 * GRA-55: "every answer leads with what happened while the agent was not
 * looking."
 *
 * MCP has no push. An agent asks a question, thinks for ninety seconds, asks
 * another — and in between, the app ANR'd, with nothing to say so. The fix
 * has two halves, both keyed off one small piece of state this module owns:
 *
 *  - `since: "last"` (index.ts's `windowShape`) lets a window-taking tool
 *    pick up where the agent's own last look left off, instead of the agent
 *    guessing a lookback and either missing the gap or re-reading it.
 *  - the banner (index.ts's `ok()`) tells every tool's caller, unprompted,
 *    about anything of `error` severity that happened since the last call —
 *    this is push as far as the protocol allows: the agent finds out at the
 *    first opportunity it gives us, not the first opportunity it thinks to
 *    ask.
 *
 * **Scope, decided (GRA-55 EM assessment, open question 1): one watermark
 * per MCP server process, keyed by the session identity currently open.**
 * Not per MCP connection in the sense of "shared across every session that
 * process ever sees" — `open()` below reloads from a different session
 * directory's `watermark.json` the moment the identity changes, the same
 * shape `SessionWriter.open()` already uses and for the same reason
 * (`sessions.ts`'s module doc comment).
 *
 * **Two live processes sharing one session (GRA-56 QA, W1): supported, to
 * within one poll interval — not full mutual exclusion.** `open()` used to
 * read the file exactly once per directory (a no-op on every later call for
 * the same, already-open directory), so a second writer's update was
 * invisible to this instance for the rest of its life — `get()` served a
 * cache from whenever `open()` first ran, "whichever writes last wins" in
 * the least useful sense: not "the most recent value wins," but "the value
 * this instance loaded once, however stale, keeps winning against its own
 * reads." `refresh()` below fixes that half: `open()` on an unchanged
 * directory now stats `watermark.json` and re-reads it when its mtime moved
 * since this instance last loaded it, and every write (`recordExamined`,
 * `recordReportedErrorT`, `recordDigest`, `reset`) refreshes first too, so a
 * decision is never made against a value staler than one on-disk write.
 * `persist()` writes through a temp file and `rename()`s it into place —
 * atomic on every OS this ships for — so a concurrent `refresh()` always
 * sees either the old, complete file or the new, complete one, never a
 * torn write from one that raced it.
 *
 * What this does **not** provide is a lock: two processes that both decide,
 * in the same poll interval, that a given `t` is unreported can both still
 * report it — refresh-then-decide-then-write is three steps, not one
 * atomic compare-and-swap, and nothing here blocks a second writer between
 * them. `watch`'s own README section says this precisely (a `watch` and the
 * MCP surface's banner "can both report the same error within one poll
 * interval; neither will keep repeating it once each has seen the other's
 * write") rather than promising exclusion this module cannot give.
 *
 * Written through to `<session dir>/watermark.json`, beside `events.ndjson`,
 * on every update — this is what "survives an MCP server restart, sitting
 * on the session store" means concretely, and why there is no separate
 * on/off switch: it inherits `PORTHOLE_SESSIONS=0` for free, because
 * without a session directory there is nowhere to write it and `open(null)`
 * degrades to an in-memory-only watermark for that process's lifetime, same
 * as `SessionWriter` degrades to not writing at all.
 */

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** One finding's identity and size, as carried in a digest — nothing else. Deliberately not a `Finding`: the digest is compared across calls, possibly across a restart, and a `Finding`'s `title`/`detail` text is free to reword without changing what the digest needs to answer ("is this the same finding, and how big is it now"). */
export interface FindingDigestEntry {
  id: string;
  count: number;
}

/** What `findings` remembers about its own last call, for classifying the next one. */
export interface FindingsDigest {
  findings: FindingDigestEntry[];
  window: { from: number; to: number };
  /** Whether the call that produced this digest was itself `since: "last"`-shaped — see `windowsComparable()`. */
  sinceLast: boolean;
}

export interface WatermarkState {
  /** Max `t` examined by any window-taking tool, including `save_moment`. */
  lastExaminedT: number | null;
  /** The newest error-severity event the banner has already reported — never repeated after this. */
  lastReportedErrorT: number | null;
  digest: FindingsDigest | null;
}

export function emptyState(): WatermarkState {
  return { lastExaminedT: null, lastReportedErrorT: null, digest: null };
}

function watermarkPath(dir: string): string {
  return path.join(dir, "watermark.json");
}

/**
 * A best-effort read: a missing file (no session yet, or a session that
 * never got a watermark written) and a corrupt or hand-edited one are the
 * same to a caller — there is no watermark to trust, so start fresh rather
 * than throwing and taking down every tool call on a session directory.
 */
async function loadState(dir: string): Promise<WatermarkState | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(watermarkPath(dir), "utf8"));
  } catch {
    return null;
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("lastExaminedT" in raw) ||
    !("lastReportedErrorT" in raw) ||
    !("digest" in raw)
  ) {
    return null;
  }
  return raw as WatermarkState;
}

/**
 * The one process-lifetime instance `index.ts` holds. `open()` is idempotent
 * for an unchanged directory — cheap to call at the top of every tool
 * handler, the same way `mergeWithDisk`'s `currentIdentity()` is — so no
 * caller has to know or track whether the session has actually changed.
 */
export class Watermark {
  private dir: string | null = null;
  private state: WatermarkState = emptyState();
  /** Chains writes the same way `SessionWriter.flushing` does, so two updates racing (a tool call and the banner it triggers, say) never interleave two `writeFile` calls on the same file. */
  private writing: Promise<void> = Promise.resolve();
  /** The on-disk mtime (ms) `this.state` was last loaded from — `null` when never loaded (no directory, or the file did not exist yet at the last look). What `refresh()` compares a fresh `stat()` against; see this file's own module comment (W1) for why this exists at all. */
  private loadedMtimeMs: number | null = null;

  /**
   * Switches to `dir`'s watermark, loading it if present. `null` means "no
   * session — track in memory for this process's life and never persist,"
   * matching `PORTHOLE_SESSIONS=0` or a device that has not sent a `hello`
   * yet.
   *
   * GRA-56 QA (W1): an unchanged `dir` used to return immediately, forever,
   * for the life of the instance — the exact bug this ticket's own module
   * comment now documents. It now delegates to `refresh()` instead of
   * skipping straight to a no-op, so a caller that (like every one today)
   * opens once per identity and reads many times still picks up a write
   * another live process made in between.
   */
  async open(dir: string | null): Promise<void> {
    if (dir === this.dir) {
      await this.refresh();
      return;
    }
    this.dir = dir;
    this.loadedMtimeMs = null;
    // Cleared unconditionally on a real switch, not just for `dir === null`:
    // `refresh()` below only ever assigns `this.state` when it actually
    // finds a file to load — a new directory with no watermark.json yet
    // (an ordinary case, not an error; see `refresh()`'s own comment) would
    // otherwise silently keep serving the *previous* directory's state,
    // which is exactly the cross-session leak this method exists to avoid.
    this.state = emptyState();
    if (!dir) return;
    await this.refresh(/* force */ true);
  }

  /**
   * Re-reads `watermark.json` when its on-disk mtime is newer than what
   * `this.state` was last loaded from — a `stat()` always, a `readFile()`
   * only when something has actually changed since. `force` skips the mtime
   * comparison (used by `open()` on a directory switch, where there is
   * nothing yet to compare against) and by every write method below, so a
   * decision that turns into a write is never made against a value staler
   * than the latest on-disk one. A missing file (nobody has written this
   * session's watermark yet) leaves `this.state` exactly as it was —
   * `emptyState()` on a first open, or this instance's own prior value —
   * there being nothing to refresh from is not the same as the value being
   * gone.
   */
  async refresh(force = false): Promise<void> {
    if (!this.dir) return;
    const dir = this.dir;
    let stats: { mtimeMs: number };
    try {
      stats = await stat(watermarkPath(dir));
    } catch {
      return;
    }
    if (!force && this.loadedMtimeMs !== null && stats.mtimeMs <= this.loadedMtimeMs) return;
    const loaded = await loadState(dir);
    if (loaded) this.state = loaded;
    this.loadedMtimeMs = stats.mtimeMs;
  }

  get(): WatermarkState {
    return this.state;
  }

  currentDir(): string | null {
    return this.dir;
  }

  /** Advances the high-water mark of what has been examined. A no-op (no write) when `t` does not move it forward — `lastExaminedT` only ever grows. Refreshes first (W1) so the monotonic guard compares against the latest on-disk value, not a copy from whenever this instance last looked. */
  async recordExamined(t: number): Promise<void> {
    await this.refresh();
    if (this.state.lastExaminedT !== null && t <= this.state.lastExaminedT) return;
    this.state = { ...this.state, lastExaminedT: t };
    await this.persist();
  }

  /** Advances the banner's own high-water mark. Same monotonic guard as `recordExamined`, same refresh-first reasoning — this is the mechanism behind "the banner never repeats an event," now including one it never wrote itself but another live process (an MCP server, a `watch`) already reported. */
  async recordReportedErrorT(t: number): Promise<void> {
    await this.refresh();
    if (this.state.lastReportedErrorT !== null && t <= this.state.lastReportedErrorT) return;
    this.state = { ...this.state, lastReportedErrorT: t };
    await this.persist();
  }

  /** Replaces the findings digest wholesale — there is only ever one, the most recent. */
  async recordDigest(digest: FindingsDigest): Promise<void> {
    await this.refresh();
    this.state = { ...this.state, digest };
    await this.persist();
  }

  /** `since: "all"` — the reset. Clears every field, so a subsequent `since: "last"` behaves as a first-ever call again. */
  async reset(): Promise<void> {
    this.state = emptyState();
    await this.persist();
  }

  /**
   * Writes through a temp file and `rename()`s it into place — atomic on
   * every OS this ships for (POSIX `rename(2)`; Windows' `MoveFileEx` with
   * the same all-or-nothing guarantee, which is what Node's `fs.rename`
   * uses there) — so a concurrent `refresh()` in another process always
   * sees either the complete old file or the complete new one, never a
   * partial write interleaved with its own read (GRA-56 QA, W1). The temp
   * name includes this process's pid: two processes writing at once must
   * not `rename()` over each other's still-in-flight temp file.
   */
  private persist(): Promise<void> {
    if (!this.dir) return Promise.resolve();
    const dir = this.dir;
    const data = JSON.stringify(this.state, null, 2);
    this.writing = this.writing.then(async () => {
      const finalPath = watermarkPath(dir);
      const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmpPath, data, "utf8");
      await rename(tmpPath, finalPath);
      // The rename this instance just performed is itself the freshest
      // possible mtime — recorded here rather than left for the next
      // refresh()'s stat() to discover, so this instance never re-reads its
      // own write back as though some other process had made it.
      const stats = await stat(finalPath);
      this.loadedMtimeMs = stats.mtimeMs;
    });
    return this.writing;
  }
}

// ---------------------------------------------------------------------------
// the banner — index.ts's `ok()` calls this once, for every tool
// ---------------------------------------------------------------------------

/** Hard cap (GRA-55 EM assessment, answering open question 2): "two lines and 240 characters." Enforced as one character budget — nothing here inserts a line break of its own, so "two lines" is honoured as roughly the length two lines of prose hold, not as a literal `\n`. */
export const BANNER_MAX_CHARS = 240;

export const BANNER_PREFIX = "⚠ Since your last call: ";
export const BANNER_SUFFIX = ' Call `findings {"since":"last"}`.';

/**
 * Assembles the banner from error-severity findings, in the order given
 * (worst first, same as `findings` itself sorts), truncating with
 * "…and N more kinds" rather than exceeding [BANNER_MAX_CHARS]. `title` is
 * already "counts by kind, not enumeration" for every finding this
 * repository produces (`"${n} HTTP calls failed"`, not a list of the
 * calls), so no separate count needs prepending here — doing so would
 * double it for findings whose own title already opens with a number.
 *
 * Returns null for an empty list: no error findings means no banner, not an
 * empty one.
 */
export function buildBanner(findings: Finding[]): string | null {
  if (findings.length === 0) return null;

  let shown = 0;
  let body = "";
  for (const finding of findings) {
    const candidateBody = body ? `${body}, ${finding.title}` : finding.title;
    const candidateFull = `${BANNER_PREFIX}${candidateBody}.${BANNER_SUFFIX}`;
    if (candidateFull.length > BANNER_MAX_CHARS) break;
    body = candidateBody;
    shown++;
  }

  const remaining = findings.length - shown;
  if (remaining > 0) {
    const suffix = `…and ${remaining} more kind${remaining === 1 ? "" : "s"}`;
    const withMore = body ? `${BANNER_PREFIX}${body}, ${suffix}.${BANNER_SUFFIX}` : `${BANNER_PREFIX}${suffix}.${BANNER_SUFFIX}`;
    if (withMore.length <= BANNER_MAX_CHARS) return withMore;
    // Even "N kinds" plus the fixed prefix/suffix does not fit (an
    // implausibly long finding title, or a great many kinds) — the fixed
    // parts alone are always within budget in practice, so this is a last
    // resort that favours staying under the cap over a polished sentence.
    return `${BANNER_PREFIX}${suffix}.${BANNER_SUFFIX}`.slice(0, BANNER_MAX_CHARS);
  }
  if (!body) {
    // Not even the first finding's title fit alone (an adversarially long
    // title) — say so rather than emitting an empty, misleading banner.
    return `${BANNER_PREFIX}${findings.length} finding(s), too long to summarise here.${BANNER_SUFFIX}`.slice(
      0,
      BANNER_MAX_CHARS,
    );
  }
  return `${BANNER_PREFIX}${body}.${BANNER_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// classification — `findings`' own new/ongoing/resolved
// ---------------------------------------------------------------------------

export type FindingStatus = "new" | "ongoing" | "resolved";

/** A live finding, classified — `status`/`delta` layered on, nothing removed. */
export type ClassifiedFinding = Finding & { status: FindingStatus; delta?: number };

/** A finding that was in the previous digest and is not any more. There is no `Finding` to show — the digest keeps only `id`/`count` (see `FindingDigestEntry`'s own comment on why) — so this is deliberately a smaller shape, not a padded-out fake `Finding`. */
export interface ResolvedFinding {
  id: string;
  status: "resolved";
  /** What the count was the last time this id was seen. */
  previousCount: number;
}

export interface ClassifyResult {
  /** Current findings (each carrying `status`/`delta`) followed by any `ResolvedFinding`s — every entry has a `status`. Equal to the plain input array, with no `status` on any entry, when classification did not run. */
  findings: Array<ClassifiedFinding | ResolvedFinding> | Finding[];
  counts: { new: number; ongoing: number; resolved: number } | null;
  /** Set only when a previous digest existed but was judged not comparable — never set merely because there was no previous digest at all (an ordinary first call has nothing to say about that). */
  skippedNote: string | null;
}

/**
 * GRA-55 EM assessment: "the comparison must be against the previous call's
 * set at the same severity over a comparable window, and if the windows are
 * not comparable the honest answer is to suppress the classification and
 * say why." This is that gate.
 *
 * Comparable when either call was chained (`since: "last"` on both this
 * call and the one before it — two calls each picking up where the last
 * left off is continuity by construction, regardless of how the resulting
 * spans happen to measure up against each other), or, for two calls with no
 * such chain, when the two windows overlap by at least half of the shorter
 * one — enough that "this finding vanished" is more likely to mean it
 * actually stopped than that the second call simply looked somewhere else.
 */
export function windowsComparable(
  previous: FindingsDigest,
  currentSinceLast: boolean,
  currentWindow: { from: number; to: number },
): boolean {
  if (previous.sinceLast && currentSinceLast) return true;

  const overlapFrom = Math.max(previous.window.from, currentWindow.from);
  const overlapTo = Math.min(previous.window.to, currentWindow.to);
  const overlap = Math.max(0, overlapTo - overlapFrom);
  const previousLen = Math.max(0, previous.window.to - previous.window.from);
  const currentLen = Math.max(0, currentWindow.to - currentWindow.from);
  const shorter = Math.min(previousLen, currentLen);
  if (shorter === 0) return overlap === 0 && previousLen === currentLen; // both zero-width, same instant
  return overlap >= shorter / 2;
}

/**
 * Classifies `current` against `previous` (the last call's digest, or null
 * for "no previous call to compare against"). Never mutates either input.
 */
export function classify(
  current: Finding[],
  previous: FindingsDigest | null,
  currentSinceLast: boolean,
  currentWindow: { from: number; to: number },
): ClassifyResult {
  if (!previous) {
    // Nothing to compare against — an ordinary first call, not an anomaly.
    return { findings: current, counts: null, skippedNote: null };
  }
  if (!windowsComparable(previous, currentSinceLast, currentWindow)) {
    return {
      findings: current,
      counts: null,
      skippedNote:
        "classification skipped: the previous findings call covered a window not comparable to this one",
    };
  }

  const previousById = new Map(previous.findings.map((f) => [f.id, f.count]));
  const currentIds = new Set(current.map((f) => f.id));

  let newCount = 0;
  let ongoingCount = 0;
  const classifiedCurrent: ClassifiedFinding[] = current.map((finding) => {
    const previousCount = previousById.get(finding.id);
    if (previousCount === undefined) {
      newCount++;
      return { ...finding, status: "new" };
    }
    ongoingCount++;
    return { ...finding, status: "ongoing", delta: (finding.count ?? 0) - previousCount };
  });

  const resolved: ResolvedFinding[] = [];
  for (const [id, previousCount] of previousById) {
    if (!currentIds.has(id)) resolved.push({ id, status: "resolved", previousCount });
  }

  return {
    findings: [...classifiedCurrent, ...resolved],
    counts: { new: newCount, ongoing: ongoingCount, resolved: resolved.length },
    skippedNote: null,
  };
}

/** `"N new, M ongoing, K resolved"` — the summary phrase `findings`' description promises in place of restating ongoing findings. Omits a zero count rather than padding every summary with "0 resolved". */
export function classificationSummary(counts: { new: number; ongoing: number; resolved: number }): string {
  const parts: string[] = [];
  if (counts.new > 0) parts.push(`${counts.new} new`);
  if (counts.ongoing > 0) parts.push(`${counts.ongoing} ongoing`);
  if (counts.resolved > 0) parts.push(`${counts.resolved} resolved`);
  return parts.length > 0 ? parts.join(", ") : "nothing new, ongoing or resolved";
}
