// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RETENTION,
  SessionWriter,
  UNKNOWN_DEVICE_ID,
  clippedMsOf,
  enforceRetention,
  fillWindowFromDisk,
  findSessionsForIdentity,
  listAllSessions,
  readSessionWindow,
  retentionOptionsFromEnv,
  sessionDirName,
  sessionIdentity,
  sessionSizeBytes,
  sessionsEnabled,
  sessionsRoot,
  type SessionEvent,
} from "./sessions.js";

const HELLO = {
  packageName: "com.example.shop",
  startedAt: 47_213,
  device: "Test Device",
  sdkInt: 34,
  versionName: "1.0.0-test",
  deviceId: "abc123",
};

function event(seq: number, t: number, name = "recompose"): SessionEvent {
  return { event: name, t, seq, data: { n: seq } };
}

const roots: string[] = [];
async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "porthole-sessions-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

describe("session identity", () => {
  it("falls back to a named sentinel when hello carries no deviceId", () => {
    const { deviceId } = sessionIdentity({ ...HELLO, deviceId: undefined });
    expect(deviceId).toBe(UNKNOWN_DEVICE_ID);
  });

  it("keeps a real deviceId verbatim", () => {
    expect(sessionIdentity(HELLO).deviceId).toBe("abc123");
  });

  it("sanitizes characters a filesystem or the prefix filter would choke on", () => {
    const name = sessionDirName({ packageName: "com.example/shop", deviceId: "a b:c", startedAt: 1 });
    expect(name).toBe("com.example_shop_a_b_c_1");
  });

  it("never produces an empty or filesystem-unsafe path segment for an all-unsafe value", () => {
    const name = sessionDirName({ packageName: "***", deviceId: "///", startedAt: 1 });
    expect(name.length).toBeGreaterThan(0);
    expect(name).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(name.endsWith("_1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the writer
// ---------------------------------------------------------------------------

describe("SessionWriter", () => {
  it("does nothing before open() — no throw, no directory (missing-input case, BRIEFING self-check a)", async () => {
    const root = await tmpRoot();
    const writer = new SessionWriter(root, 5);
    expect(() => writer.append(event(0, 100))).not.toThrow();
    await writer.flush();
    // The root itself always exists (mkdtemp made it); what must not exist is
    // any session directory inside it — append() before open() had nowhere
    // to write and must not have invented somewhere.
    expect(await readdir(root)).toEqual([]);
  });

  it("queues on append() and only writes on flush() — never inline (AC4's premise)", async () => {
    const root = await tmpRoot();
    const writer = new SessionWriter(root, 60_000); // long interval: nothing should fire on its own during this test
    await writer.open(HELLO);
    const dir = writer.currentDir()!;
    writer.append(event(0, 1_000));

    // The event is queued, not yet on disk — appendFile has not run.
    const beforeFlush = await readFile(path.join(dir, "events.ndjson"), "utf8").catch(() => "");
    expect(beforeFlush).toBe("");

    await writer.flush();
    const afterFlush = await readFile(path.join(dir, "events.ndjson"), "utf8");
    expect(afterFlush.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(afterFlush.trim())).toMatchObject({ seq: 0, t: 1_000 });
  });

  it("flushes on its own after the interval elapses, with no explicit flush() call", async () => {
    const root = await tmpRoot();
    const writer = new SessionWriter(root, 20);
    await writer.open(HELLO);
    const dir = writer.currentDir()!;
    writer.append(event(0, 1_000));

    await new Promise((resolve) => setTimeout(resolve, 200));
    const content = await readFile(path.join(dir, "events.ndjson"), "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
  });

  it("writes meta.json with counts and the first/last t on the device's own clock", async () => {
    const root = await tmpRoot();
    const writer = new SessionWriter(root, 5);
    await writer.open(HELLO);
    writer.append(event(0, 1_000, "recompose"));
    writer.append(event(1, 2_500, "recompose"));
    writer.append(event(2, 1_500, "http_start"));
    await writer.flush();

    const meta = JSON.parse(await readFile(path.join(writer.currentDir()!, "meta.json"), "utf8"));
    expect(meta.packageName).toBe("com.example.shop");
    expect(meta.deviceId).toBe("abc123");
    expect(meta.startedAt).toBe(47_213);
    expect(meta.firstT).toBe(1_000);
    expect(meta.lastT).toBe(2_500);
    expect(meta.eventCounts).toEqual({ recompose: 2, http_start: 1 });
  });

  it("resumes the same session across two writer instances sharing an identity — 'append, do not fork'", async () => {
    const root = await tmpRoot();
    const first = new SessionWriter(root, 5);
    await first.open(HELLO);
    first.append(event(0, 1_000));
    await first.flush();

    const second = new SessionWriter(root, 5);
    await second.open(HELLO); // a second MCP server attaching to the same app
    expect(second.currentDir()).toBe(first.currentDir());
    second.append(event(1, 2_000));
    await second.flush();

    const content = await readFile(path.join(first.currentDir()!, "events.ndjson"), "utf8");
    expect(content.trim().split("\n")).toHaveLength(2);
    const meta = JSON.parse(await readFile(path.join(first.currentDir()!, "meta.json"), "utf8"));
    // Read back, not overwritten: the second writer's meta still knows about
    // the first writer's event.
    expect(meta.eventCounts).toEqual({ recompose: 2 });
  });

  it("a new hello (different startedAt) opens a distinct directory and flushes the old one first", async () => {
    const root = await tmpRoot();
    const writer = new SessionWriter(root, 60_000);
    await writer.open(HELLO);
    writer.append(event(0, 1_000));
    const firstDir = writer.currentDir()!;

    await writer.open({ ...HELLO, startedAt: 99_999 }); // process restarted
    expect(writer.currentDir()).not.toBe(firstDir);

    // The old session's queued event was flushed by the switch, not lost.
    const oldContent = await readFile(path.join(firstDir, "events.ndjson"), "utf8");
    expect(oldContent.trim().split("\n")).toHaveLength(1);
  });

  it("re-opening the identity already open is a no-op (a reconnect, not a new session)", async () => {
    const root = await tmpRoot();
    const writer = new SessionWriter(root, 60_000);
    await writer.open(HELLO);
    writer.append(event(0, 1_000));
    const dirBefore = writer.currentDir();
    await writer.open(HELLO);
    expect(writer.currentDir()).toBe(dirBefore);
    // The queued event survived the second open() (it did not treat this as
    // a switch and flush/reset anything).
    await writer.flush();
    const content = await readFile(path.join(dirBefore!, "events.ndjson"), "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
  });

  it(
    "creates the session directory and files owner-only on POSIX; on Windows, mode bits are not set " +
      "(NTFS has no such concept — see sessions.ts's isPosix comment)",
    async () => {
      const root = await tmpRoot();
      const writer = new SessionWriter(root, 60_000);
      await writer.open(HELLO);
      const dir = writer.currentDir()!;
      writer.append(event(0, 1_000));
      await writer.flush();

      const dirStat = await stat(dir);
      const metaStat = await stat(path.join(dir, "meta.json"));
      const eventsStat = await stat(path.join(dir, "events.ndjson"));

      // Branched rather than `it.skipIf`, per this project's own lesson
      // (adb.test.ts): a skipped-on-one-platform test means that platform's
      // behaviour is never actually exercised anywhere, and nothing notices
      // if it silently regresses. Both branches run and both assert
      // something real for their platform.
      if (process.platform === "win32") {
        expect(dirStat.isDirectory()).toBe(true);
        expect(eventsStat.isFile()).toBe(true);
      } else {
        expect(dirStat.mode & 0o777).toBe(0o700);
        expect(metaStat.mode & 0o777).toBe(0o600);
        expect(eventsStat.mode & 0o777).toBe(0o600);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// fallback read — Q1
// ---------------------------------------------------------------------------

describe("readSessionWindow", () => {
  it("returns nothing for a session directory that was never written to", async () => {
    const root = await tmpRoot();
    expect(await readSessionWindow(path.join(root, "nothing-here"), 0, 100)).toEqual([]);
  });

  it("filters to the requested window and skips a torn last line", async () => {
    const root = await tmpRoot();
    const dir = path.join(root, "session");
    await mkdir(dir, { recursive: true });
    const lines = [event(0, 100), event(1, 200), event(2, 300)].map((e) => JSON.stringify(e)).join("\n");
    await writeFile(path.join(dir, "events.ndjson"), lines + '\n{"event":"recompose","t":4' /* torn */);

    const found = await readSessionWindow(dir, 150, 300);
    expect(found.map((e) => e.seq)).toEqual([1, 2]);
  });

  /**
   * GRA-53 Q1: "Does the fallback read need an index, or is a scan with a
   * byte offset per minute enough for a 30-minute session? Measure before
   * building one." This writes a real ~30-minute-equivalent NDJSON file
   * (54,000 lines at 30 events/sec — see EventRing's own "busy screen" rate)
   * and times a real window read against it. No index is built anywhere in
   * this module; this is the measurement that says that was the right call
   * for this size, not an assumption.
   */
  it("scans a 30-minute-equivalent session (54,000 events) well within a second", async () => {
    const root = await tmpRoot();
    const dir = path.join(root, "big-session");
    await mkdir(dir, { recursive: true });

    const totalEvents = 54_000; // 30 min * 60s * 30 events/s
    const chunkSize = 2_000;
    for (let start = 0; start < totalEvents; start += chunkSize) {
      const chunk: string[] = [];
      for (let seq = start; seq < Math.min(start + chunkSize, totalEvents); seq++) {
        chunk.push(JSON.stringify(event(seq, seq * 33 /* ~30/s */, seq % 7 === 0 ? "http_start" : "recompose")));
      }
      await appendFile(path.join(dir, "events.ndjson"), chunk.join("\n") + "\n");
    }

    const windowFrom = 10 * 60 * 1000; // minute 10
    const windowTo = 11 * 60 * 1000; // minute 11
    const start = performance.now();
    const found = await readSessionWindow(dir, windowFrom, windowTo);
    const elapsedMs = performance.now() - start;

    // Real measurement, not a fixed expectation dressed up as one: printed so
    // it shows up in CI logs on every platform this suite runs on.
    // eslint-disable-next-line no-console
    console.log(`[GRA-53 Q1] scanned ${totalEvents} events in ${elapsedMs.toFixed(1)}ms for a 1-minute window`);

    expect(found.length).toBeGreaterThan(0);
    expect(found.every((e) => e.t >= windowFrom && e.t <= windowTo)).toBe(true);
    // Generous on purpose — this asserts "a scan is obviously fine", not a
    // tight performance budget that would make the suite flaky on a loaded
    // CI runner.
    expect(elapsedMs).toBeLessThan(3_000);
  });
});

// ---------------------------------------------------------------------------
// cross-session lookup
// ---------------------------------------------------------------------------

describe("findSessionsForIdentity", () => {
  it("finds only sessions matching the identity prefix, oldest first", async () => {
    const root = await tmpRoot();
    const writerA1 = new SessionWriter(root, 5);
    await writerA1.open({ ...HELLO, startedAt: 200 });
    writerA1.append(event(0, 200));
    await writerA1.flush();

    const writerA0 = new SessionWriter(root, 5);
    await writerA0.open({ ...HELLO, startedAt: 100 });
    writerA0.append(event(0, 100));
    await writerA0.flush();

    const writerOther = new SessionWriter(root, 5);
    await writerOther.open({ ...HELLO, packageName: "com.other.app", startedAt: 150 });
    writerOther.append(event(0, 150));
    await writerOther.flush();

    const found = await findSessionsForIdentity(root, HELLO.packageName, HELLO.deviceId);
    expect(found.map((s) => s.startedAt)).toEqual([100, 200]);
  });

  it("returns nothing for a root that does not exist yet", async () => {
    const found = await findSessionsForIdentity(path.join(await tmpRoot(), "nope"), "x", "y");
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the restart-boundary merge
// ---------------------------------------------------------------------------

describe("fillWindowFromDisk", () => {
  it("merges disk and memory across a restart boundary placed inside the window: one axis, in order, no duplicates", async () => {
    const root = await tmpRoot();

    // The old process's session, entirely on disk (this is what the MCP
    // server restarting throws away from memory).
    const oldWriter = new SessionWriter(root, 5);
    await oldWriter.open({ ...HELLO, startedAt: 0 });
    oldWriter.append(event(0, 1_000, "recompose"));
    oldWriter.append(event(1, 2_000, "recompose"));
    await oldWriter.flush();

    // The new process's session: some of it flushed to disk already, the
    // rest still only in the live buffer — the ordinary state of affairs a
    // moment after the app restarted.
    const newWriter = new SessionWriter(root, 60_000);
    await newWriter.open({ ...HELLO, startedAt: 3_000 });
    newWriter.append(event(0, 3_000, "nav"));
    await newWriter.flush(); // this one made it to disk
    newWriter.append(event(1, 4_000, "nav")); // this one has not yet

    const buffered: SessionEvent[] = [
      // The live buffer holds everything the new process has produced,
      // including the one already flushed — flush() does not remove it from
      // memory, only from the queue, so an overlap is the normal case, not
      // an edge case.
      event(0, 3_000, "nav"),
      event(1, 4_000, "nav"),
    ];

    // The window straddles the boundary rather than sitting on either edge:
    // it starts before the old session's last event and ends after the new
    // session's last one.
    const result = await fillWindowFromDisk({
      root,
      identity: { packageName: HELLO.packageName, deviceId: HELLO.deviceId! },
      buffered,
      currentSessionDir: newWriter.currentDir(),
      from: 1_500,
      to: 5_000,
    });

    expect(result.events.map((e) => e.t)).toEqual([2_000, 3_000, 4_000]);
    expect(result.oldest).toBe(2_000);
    expect(result.newest).toBe(4_000);
    // No duplicates despite t=3000 existing both on disk (flushed) and in
    // the live buffer for the current session.
    expect(result.events).toHaveLength(3);
  });

  it("does not report a quiet stretch inside a recorded session as clipped coverage", async () => {
    const root = await tmpRoot();
    const writer = new SessionWriter(root, 5);
    await writer.open(HELLO);
    // A session that ran from t=0 to t=10_000 but only emitted two events,
    // five seconds apart in the middle — a busy app can be quiet for a
    // stretch without that stretch being unrecorded.
    writer.append(event(0, 0));
    writer.append(event(1, 10_000));
    await writer.flush();

    const result = await fillWindowFromDisk({
      root,
      identity: { packageName: HELLO.packageName, deviceId: HELLO.deviceId! },
      buffered: [],
      currentSessionDir: null,
      from: 3_000,
      to: 7_000, // a quiet middle stretch with no events in it at all
    });

    expect(result.events).toEqual([]);
    // Coverage still spans the whole requested window: the session's own
    // [firstT, lastT] is [0, 10_000], which contains [3000, 7000] entirely.
    expect(result.coveredFrom).toBe(3_000);
    expect(result.coveredTo).toBe(7_000);
  });

  it("reports no coverage at all for a window nothing overlaps", async () => {
    const root = await tmpRoot();
    const result = await fillWindowFromDisk({
      root,
      identity: { packageName: "com.nothing", deviceId: "x" },
      buffered: [],
      currentSessionDir: null,
      from: 0,
      to: 1_000,
    });
    expect(result.coveredFrom).toBeNull();
    expect(result.coveredTo).toBeNull();
  });

  it("returns nothing on disk when identity is null (never connected) but still reports the live buffer", async () => {
    const root = await tmpRoot();
    const result = await fillWindowFromDisk({
      root,
      identity: null,
      buffered: [event(0, 100)],
      currentSessionDir: null,
      from: 0,
      to: 1_000,
    });
    expect(result.events.map((e) => e.seq)).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

describe("enforceRetention", () => {
  async function makeSession(root: string, name: string, bytes: number, ageMs: number): Promise<string> {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "events.ndjson"), "x".repeat(bytes));
    const updatedAt = Date.now() - ageMs;
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({
        packageName: "com.example.shop",
        deviceId: "abc123",
        startedAt: 0,
        device: "d",
        sdkInt: 1,
        versionName: null,
        firstT: 0,
        lastT: 0,
        eventCounts: {},
        createdAt: updatedAt,
        updatedAt,
      }),
    );
    return dir;
  }

  it("prunes a session older than maxAgeMs and keeps a recent one", async () => {
    const root = await tmpRoot();
    const old = await makeSession(root, "old", 10, 8 * 24 * 60 * 60 * 1000);
    const recent = await makeSession(root, "recent", 10, 1_000);

    const { prunedDirs } = await enforceRetention(root, { maxBytes: 10_000_000, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });

    expect(prunedDirs).toEqual([old]);
    await expect(stat(recent)).resolves.toBeDefined();
    await expect(stat(old)).rejects.toThrow();
  });

  it("prunes the oldest-updated sessions first once the total exceeds maxBytes", async () => {
    const root = await tmpRoot();
    const oldest = await makeSession(root, "oldest", 1_000, 3_000);
    const middle = await makeSession(root, "middle", 1_000, 2_000);
    const newest = await makeSession(root, "newest", 1_000, 1_000);

    // Computed from the real files rather than guessed, since each session's
    // true size includes meta.json too, not just the ndjson bytes passed
    // above. A budget set just above "everything but the oldest" means
    // exactly one prune should be enough to get under it.
    const sizeOf = async (dir: string) =>
      (await stat(path.join(dir, "events.ndjson"))).size + (await stat(path.join(dir, "meta.json"))).size;
    const [oldestBytes, middleBytes, newestBytes] = await Promise.all([oldest, middle, newest].map(sizeOf));
    const maxBytes = middleBytes + newestBytes + 1;
    void oldestBytes;

    const { prunedDirs } = await enforceRetention(root, { maxBytes, maxAgeMs: Number.MAX_SAFE_INTEGER });

    expect(prunedDirs).toEqual([oldest]);
    await expect(stat(middle)).resolves.toBeDefined();
    await expect(stat(newest)).resolves.toBeDefined();
  });

  it("never prunes the session currently being written, even when it is the oldest and largest — proved by trying", async () => {
    const root = await tmpRoot();
    const active = await makeSession(root, "active", 10_000, 30 * 24 * 60 * 60 * 1000); // huge and ancient
    await makeSession(root, "innocent-bystander", 10, 1_000);

    const { prunedDirs } = await enforceRetention(
      root,
      { maxBytes: 1, maxAgeMs: 1 }, // budgets that would prune everything else that exists
      active,
    );

    expect(prunedDirs).not.toContain(active);
    await expect(stat(active)).resolves.toBeDefined();
  });

  it("does nothing, without throwing, when the sessions root does not exist (missing-input case)", async () => {
    const root = await tmpRoot();
    const result = await enforceRetention(path.join(root, "does-not-exist"), DEFAULT_RETENTION);
    expect(result.prunedDirs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// env wiring: the off switch and the retention overrides SessionWriter.open()
// actually applies (not just what enforceRetention accepts as a parameter)
// ---------------------------------------------------------------------------

describe("env wiring", () => {
  const ENV_KEYS = ["PORTHOLE_SESSIONS", "PORTHOLE_SESSIONS_MAX_BYTES", "PORTHOLE_SESSIONS_MAX_AGE_DAYS"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  async function makeOldSession(root: string, name: string, ageMs: number): Promise<string> {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "events.ndjson"), "x".repeat(10));
    const updatedAt = Date.now() - ageMs;
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({
        packageName: "com.example.shop",
        deviceId: "abc123",
        startedAt: 0,
        device: "d",
        sdkInt: 1,
        versionName: null,
        firstT: 0,
        lastT: 0,
        eventCounts: {},
        createdAt: updatedAt,
        updatedAt,
      }),
    );
    return dir;
  }

  describe("retentionOptionsFromEnv (malformed/missing/empty input, self-check a)", () => {
    it("falls back to DEFAULT_RETENTION when neither var is set", () => {
      expect(retentionOptionsFromEnv()).toEqual(DEFAULT_RETENTION);
    });

    it("falls back on an empty string", () => {
      process.env.PORTHOLE_SESSIONS_MAX_BYTES = "";
      expect(retentionOptionsFromEnv().maxBytes).toBe(DEFAULT_RETENTION.maxBytes);
    });

    it("falls back on a non-numeric value", () => {
      process.env.PORTHOLE_SESSIONS_MAX_AGE_DAYS = "banana";
      expect(retentionOptionsFromEnv().maxAgeMs).toBe(DEFAULT_RETENTION.maxAgeMs);
    });

    it("falls back on zero and on a negative number — a 0-byte or negative budget is not a real policy", () => {
      process.env.PORTHOLE_SESSIONS_MAX_BYTES = "0";
      expect(retentionOptionsFromEnv().maxBytes).toBe(DEFAULT_RETENTION.maxBytes);
      process.env.PORTHOLE_SESSIONS_MAX_BYTES = "-5";
      expect(retentionOptionsFromEnv().maxBytes).toBe(DEFAULT_RETENTION.maxBytes);
    });

    it("honours a real override, converting days to milliseconds", () => {
      process.env.PORTHOLE_SESSIONS_MAX_AGE_DAYS = "1";
      expect(retentionOptionsFromEnv().maxAgeMs).toBe(24 * 60 * 60 * 1000);
    });

    it("honours a real byte-budget override verbatim, no unit conversion", () => {
      process.env.PORTHOLE_SESSIONS_MAX_BYTES = "1000";
      expect(retentionOptionsFromEnv().maxBytes).toBe(1000);
    });
  });

  describe("sessionsEnabled", () => {
    it("is enabled when unset", () => {
      expect(sessionsEnabled()).toBe(true);
    });

    it("is disabled only by the literal string \"0\"", () => {
      process.env.PORTHOLE_SESSIONS = "0";
      expect(sessionsEnabled()).toBe(false);
    });

    it("stays enabled for any other value, including a falsy-looking one like \"false\"", () => {
      process.env.PORTHOLE_SESSIONS = "false";
      expect(sessionsEnabled()).toBe(true);
    });
  });

  it("PORTHOLE_SESSIONS=0 makes open() a no-op: no directory, no meta.json, nothing to append into", async () => {
    process.env.PORTHOLE_SESSIONS = "0";
    const root = await tmpRoot();
    const writer = new SessionWriter(root, 5);

    await writer.open(HELLO);

    expect(writer.currentDir()).toBeNull();
    expect(await readdir(root)).toEqual([]);
    // append() after a disabled open() must stay the same silent no-op it
    // already is before any open() at all — proved above, re-proved here so
    // the off switch is shown to actually reach that guard, not bypass it.
    expect(() => writer.append(event(0, 100))).not.toThrow();
    await writer.flush();
    expect(await readdir(root)).toEqual([]);
  });

  it(
    "open() applies PORTHOLE_SESSIONS_MAX_AGE_DAYS to its own retention sweep, not just to a caller of " +
      "enforceRetention directly",
    async () => {
      const root = await tmpRoot();
      const old = await makeOldSession(root, "ancient", 3 * 24 * 60 * 60 * 1000); // 3 days old
      process.env.PORTHOLE_SESSIONS_MAX_AGE_DAYS = "1"; // narrower than the 7-day default

      const writer = new SessionWriter(root, 60_000);
      await writer.open(HELLO); // a new, distinct session -- "ancient" is not its own activeDir

      await expect(stat(old)).rejects.toThrow();
      // The session open() itself just created must survive its own sweep.
      await expect(stat(writer.currentDir()!)).resolves.toBeDefined();
    },
  );
});

// ---------------------------------------------------------------------------
// sessionsRoot
// ---------------------------------------------------------------------------

describe("sessionsRoot", () => {
  it("lives under .porthole/sessions of the project root", () => {
    expect(sessionsRoot("/home/dev/app")).toBe(path.join("/home/dev/app", ".porthole", "sessions"));
  });
});

// ---------------------------------------------------------------------------
// GRA-54: listAllSessions, sessionSizeBytes, clippedMsOf
// ---------------------------------------------------------------------------

describe("listAllSessions", () => {
  it("returns [] for a root that does not exist yet (missing-input case, BRIEFING self-check a)", async () => {
    const root = path.join(await tmpRoot(), "does-not-exist");
    expect(await listAllSessions(root)).toEqual([]);
  });

  it("returns [] for a root that exists but is empty", async () => {
    const root = await tmpRoot();
    expect(await listAllSessions(root)).toEqual([]);
  });

  it("finds sessions across different apps and devices, not scoped to one identity", async () => {
    const root = await tmpRoot();
    const shop = new SessionWriter(root, 60_000);
    await shop.open(HELLO);
    shop.append(event(0, 1_000));
    await shop.flush();

    const otherHello = { ...HELLO, packageName: "com.example.other", deviceId: "xyz789", startedAt: 5_000 };
    const other = new SessionWriter(root, 60_000);
    await other.open(otherHello);
    other.append(event(0, 2_000));
    await other.flush();

    const all = await listAllSessions(root);
    expect(all.map((s) => s.packageName).sort()).toEqual(["com.example.other", "com.example.shop"]);
  });

  it("sorts newest-started first", async () => {
    const root = await tmpRoot();
    const older = new SessionWriter(root, 60_000);
    await older.open({ ...HELLO, startedAt: 1_000 });
    older.append(event(0, 1_000));
    await older.flush();

    const newer = new SessionWriter(root, 60_000);
    await newer.open({ ...HELLO, packageName: "com.example.other", startedAt: 99_000 });
    newer.append(event(0, 1_000));
    await newer.flush();

    const all = await listAllSessions(root);
    expect(all.map((s) => s.startedAt)).toEqual([99_000, 1_000]);
  });
});

describe("sessionSizeBytes", () => {
  it("is 0 for a directory with neither file (missing-input case)", async () => {
    const root = await tmpRoot();
    const dir = path.join(root, "nothing-here");
    expect(await sessionSizeBytes(dir)).toBe(0);
  });

  it("sums events.ndjson and meta.json, and grows as more is appended", async () => {
    const root = await tmpRoot();
    const writer = new SessionWriter(root, 60_000);
    await writer.open(HELLO);
    const dir = writer.currentDir()!;
    const before = await sessionSizeBytes(dir);
    expect(before).toBeGreaterThan(0); // meta.json alone already has bytes

    writer.append(event(0, 1_000));
    await writer.flush();
    const after = await sessionSizeBytes(dir);
    expect(after).toBeGreaterThan(before);
  });
});

describe("clippedMsOf", () => {
  it("reports the whole window clipped when nothing is covered at all", () => {
    expect(clippedMsOf(1_000, 5_000, null, null)).toEqual({ start: 4_000, end: 0 });
  });

  it("is zero on both ends when coverage exactly matches the window", () => {
    expect(clippedMsOf(1_000, 5_000, 1_000, 5_000)).toEqual({ start: 0, end: 0 });
  });

  it("is zero when coverage extends past the window on both sides (a quiet stretch inside a recorded session)", () => {
    expect(clippedMsOf(3_000, 7_000, 0, 10_000)).toEqual({ start: 0, end: 0 });
  });

  it("reports only the start as clipped when the window reaches before what is covered", () => {
    expect(clippedMsOf(0, 5_000, 2_000, 5_000)).toEqual({ start: 2_000, end: 0 });
  });

  it("reports only the end as clipped when the window reaches after what is covered", () => {
    expect(clippedMsOf(1_000, 8_000, 1_000, 5_000)).toEqual({ start: 0, end: 3_000 });
  });

  it("reports both ends clipped when coverage is a strict sub-range of the window", () => {
    expect(clippedMsOf(0, 10_000, 3_000, 7_000)).toEqual({ start: 3_000, end: 3_000 });
  });

  // Vacuous-assertion check (self-check c): a constant `() => ({ start: 0, end: 0 })`
  // would satisfy the exact-match test above but fails every test here, since
  // each one asserts a *non-trivial* value on at least one field.
});
