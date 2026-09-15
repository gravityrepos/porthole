// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BANNER_MAX_CHARS,
  Watermark,
  buildBanner,
  classificationSummary,
  classify,
  emptyState,
  windowsComparable,
  type FindingsDigest,
} from "./watermark.js";
import type { Finding } from "./trace.js";
import { buildRig } from "./testing/harness.js";
import { DeviceClient, type Hello } from "./device.js";
import { TimelineServer } from "./timeline.js";
import { createPortholeServer } from "./index.js";
import { FakeDevice, connect, waitUntil, type TestClient } from "./testing/harness.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "main-thread-stall",
  severity: "error",
  confidence: "observed",
  title: "main thread blocked for 420ms",
  count: 1,
  ...over,
});

// ---------------------------------------------------------------------------
// Watermark: persist/load round trip, monotonic guards, reset
// ---------------------------------------------------------------------------

describe("Watermark", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("round-trips through watermark.json: a second instance opened on the same directory reads back what the first wrote", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "porthole-watermark-"));
    roots.push(dir);

    const first = new Watermark();
    await first.open(dir);
    await first.recordExamined(500);
    const digest: FindingsDigest = {
      findings: [{ id: "main-thread-stall", count: 2 }],
      window: { from: 0, to: 500 },
      sinceLast: true,
    };
    await first.recordDigest(digest);
    await first.recordReportedErrorT(480);

    // Read the file directly too — proves this is really `<dir>/watermark.json`
    // beside `events.ndjson`, the exact layout the ticket's ruling names, not
    // merely some file somewhere.
    const raw = JSON.parse(await readFile(path.join(dir, "watermark.json"), "utf8"));
    expect(raw).toEqual({ lastExaminedT: 500, lastReportedErrorT: 480, digest });

    const second = new Watermark();
    await second.open(dir);
    expect(second.get()).toEqual({ lastExaminedT: 500, lastReportedErrorT: 480, digest });
  });

  it("a missing watermark.json (a session directory that never got one) loads as empty, not an error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "porthole-watermark-"));
    roots.push(dir);
    const wm = new Watermark();
    await wm.open(dir);
    expect(wm.get()).toEqual(emptyState());
  });

  it("a corrupt watermark.json degrades to empty rather than throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "porthole-watermark-"));
    roots.push(dir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "watermark.json"), "{ not valid json", "utf8");
    const wm = new Watermark();
    await wm.open(dir);
    expect(wm.get()).toEqual(emptyState());
  });

  it("recordExamined only ever moves lastExaminedT forward", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "porthole-watermark-"));
    roots.push(dir);
    const wm = new Watermark();
    await wm.open(dir);
    await wm.recordExamined(500);
    await wm.recordExamined(200); // smaller — must not move it backward
    expect(wm.get().lastExaminedT).toBe(500);
    await wm.recordExamined(500); // equal — also a no-op, not just "not smaller"
    expect(wm.get().lastExaminedT).toBe(500);
    await wm.recordExamined(900);
    expect(wm.get().lastExaminedT).toBe(900);
  });

  it("recordReportedErrorT only ever moves forward — the mechanism behind 'the banner never repeats'", async () => {
    const wm = new Watermark();
    await wm.open(null);
    await wm.recordReportedErrorT(1_000);
    await wm.recordReportedErrorT(1); // must not un-report what was already reported
    expect(wm.get().lastReportedErrorT).toBe(1_000);
  });

  it("reset() clears every field", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "porthole-watermark-"));
    roots.push(dir);
    const wm = new Watermark();
    await wm.open(dir);
    await wm.recordExamined(500);
    await wm.recordReportedErrorT(400);
    await wm.recordDigest({ findings: [], window: { from: 0, to: 1 }, sinceLast: true });
    await wm.reset();
    expect(wm.get()).toEqual(emptyState());
    // The reset persists too — a fresh instance opened on the same dir sees it.
    const second = new Watermark();
    await second.open(dir);
    expect(second.get()).toEqual(emptyState());
  });

  it("open(null) tracks state in memory for the process's life without touching disk", async () => {
    const wm = new Watermark();
    await wm.open(null);
    await wm.recordExamined(123);
    expect(wm.get().lastExaminedT).toBe(123);
    // Calling open(null) again (a later tool call, same "no session" state) is
    // a no-op — it must not reset what is already tracked in memory.
    await wm.open(null);
    expect(wm.get().lastExaminedT).toBe(123);
  });

  it("switching to a different directory reloads from that directory's own watermark.json", async () => {
    const dirA = await mkdtemp(path.join(tmpdir(), "porthole-watermark-"));
    const dirB = await mkdtemp(path.join(tmpdir(), "porthole-watermark-"));
    roots.push(dirA, dirB);
    const wm = new Watermark();
    await wm.open(dirA);
    await wm.recordExamined(111);
    await wm.open(dirB); // a different session directory — empty until written
    expect(wm.get()).toEqual(emptyState());
    await wm.recordExamined(222);
    await wm.open(dirA); // back to A — its own value survives independently
    expect(wm.get().lastExaminedT).toBe(111);
  });
});

// ---------------------------------------------------------------------------
// windowsComparable / classify — the digest-comparison and comparability rule
// ---------------------------------------------------------------------------

describe("windowsComparable", () => {
  const digest = (over: Partial<FindingsDigest> = {}): FindingsDigest => ({
    findings: [],
    window: { from: 0, to: 1_000 },
    sinceLast: true,
    ...over,
  });

  it("is comparable when both the previous and the current call were since:\"last\"-shaped, regardless of how the windows line up", () => {
    // Deliberately non-overlapping windows — this is the branch that must
    // NOT need overlap: two calls each picking up where the last left off.
    const previous = digest({ window: { from: 0, to: 100 }, sinceLast: true });
    expect(windowsComparable(previous, true, { from: 5_000, to: 5_100 })).toBe(true);
  });

  it("is not comparable when only one side is since:\"last\" and the windows barely overlap", () => {
    const previous = digest({ window: { from: 0, to: 100 }, sinceLast: false });
    expect(windowsComparable(previous, false, { from: 99, to: 200 })).toBe(false);
  });

  it("falls back to the overlap rule (>= half the shorter window) when neither call chains from the other", () => {
    const previous = digest({ window: { from: 0, to: 100 }, sinceLast: false });
    // shorter window length is 100; overlap here is 60 (40..100) — exactly
    // the boundary the ticket's own wording ("at least half") requires to pass.
    expect(windowsComparable(previous, false, { from: 40, to: 140 })).toBe(true);
  });

  it("fails the overlap rule just under half", () => {
    const previous = digest({ window: { from: 0, to: 100 }, sinceLast: false });
    // overlap is 49 (51..100 of a 100-long previous window) — just short of half.
    expect(windowsComparable(previous, false, { from: 51, to: 151 })).toBe(false);
  });
});

describe("classify", () => {
  it("with no previous digest at all: no status on any finding, and no skip note (an ordinary first call, not an anomaly)", () => {
    const current = [finding({ id: "a" })];
    const result = classify(current, null, true, { from: 0, to: 100 });
    expect(result.findings).toEqual(current);
    expect(result.counts).toBeNull();
    expect(result.skippedNote).toBeNull();
  });

  it("marks a finding present in both calls as ongoing, with the count delta", () => {
    const previous: FindingsDigest = {
      findings: [{ id: "a", count: 3 }],
      window: { from: 0, to: 100 },
      sinceLast: true,
    };
    const current = [finding({ id: "a", count: 5 })];
    const result = classify(current, previous, true, { from: 101, to: 200 });
    expect(result.counts).toEqual({ new: 0, ongoing: 1, resolved: 0 });
    const [a] = result.findings as Array<{ id: string; status?: string; delta?: number }>;
    expect(a.status).toBe("ongoing");
    expect(a.delta).toBe(2); // 5 now minus 3 in the digest
  });

  it("marks a finding absent from the previous digest as new", () => {
    const previous: FindingsDigest = { findings: [], window: { from: 0, to: 100 }, sinceLast: true };
    const current = [finding({ id: "b" })];
    const result = classify(current, previous, true, { from: 101, to: 200 });
    expect(result.counts).toEqual({ new: 1, ongoing: 0, resolved: 0 });
    const [b] = result.findings as Array<{ id: string; status?: string }>;
    expect(b.status).toBe("new");
  });

  it("emits a resolved entry, exactly once, for an id present in the digest and absent now", () => {
    const previous: FindingsDigest = {
      findings: [{ id: "gone", count: 4 }],
      window: { from: 0, to: 100 },
      sinceLast: true,
    };
    const result = classify([], previous, true, { from: 101, to: 200 });
    expect(result.counts).toEqual({ new: 0, ongoing: 0, resolved: 1 });
    expect(result.findings).toEqual([{ id: "gone", status: "resolved", previousCount: 4 }]);
  });

  it("suppresses classification, with a note, when the previous digest exists but the windows are not comparable", () => {
    const previous: FindingsDigest = {
      findings: [{ id: "a", count: 1 }],
      window: { from: 0, to: 100 },
      sinceLast: false,
    };
    const current = [finding({ id: "a" })];
    const result = classify(current, previous, false, { from: 100_000, to: 100_100 });
    expect(result.counts).toBeNull();
    expect(result.skippedNote).toMatch(/skipped/);
    // No status field anywhere — the current findings pass through untouched.
    expect(result.findings).toEqual(current);
  });
});

describe("classificationSummary", () => {
  it("joins only the non-zero counts", () => {
    expect(classificationSummary({ new: 2, ongoing: 0, resolved: 1 })).toBe("2 new, 1 resolved");
    expect(classificationSummary({ new: 0, ongoing: 3, resolved: 0 })).toBe("3 ongoing");
  });

  it("says so explicitly when every count is zero, rather than an empty string", () => {
    expect(classificationSummary({ new: 0, ongoing: 0, resolved: 0 })).toBe(
      "nothing new, ongoing or resolved",
    );
  });
});

// ---------------------------------------------------------------------------
// buildBanner — the cap
// ---------------------------------------------------------------------------

describe("buildBanner", () => {
  it("returns null for no error findings — no banner, not an empty one", () => {
    expect(buildBanner([])).toBeNull();
  });

  it("names each kind by its own (already count-bearing) title, not a per-event enumeration", () => {
    const banner = buildBanner([
      finding({ id: "a", title: "1 ANR: main thread blocked for 6200ms" }),
      finding({ id: "b", title: "3 HTTP calls failed" }),
    ]);
    expect(banner).toContain("1 ANR: main thread blocked for 6200ms");
    expect(banner).toContain("3 HTTP calls failed");
    expect(banner).toMatch(/^⚠ Since your last call:/);
    expect(banner).toContain('findings {"since":"last"}');
  });

  it("never exceeds the 240-character hard cap, truncating with '…and N more kinds'", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      finding({ id: `k${i}`, title: `finding number ${i} with a moderately long descriptive title` }),
    );
    const banner = buildBanner(many);
    expect(banner).not.toBeNull();
    expect((banner as string).length).toBeLessThanOrEqual(BANNER_MAX_CHARS);
    expect(banner).toMatch(/…and \d+ more kinds?/);
  });

  it("the cap is the coordinator's literal number, two lines and 240 characters — not whatever the constant says today", () => {
    // QA round 1 raised the constant to 1000 and nothing went red: the test
    // above measures against the constant, so it moves with it. This one
    // pins the number the ruling named.
    expect(BANNER_MAX_CHARS).toBe(240);
    const many = Array.from({ length: 40 }, (_, i) =>
      finding({ id: `k${i}`, title: `finding number ${i} with a moderately long descriptive title` }),
    );
    const banner = buildBanner(many) as string;
    expect(banner.length).toBeLessThanOrEqual(240);
    expect(banner.split("\n").length).toBeLessThanOrEqual(2);
  });

  it("the mutation-obvious case: a single very ordinary finding stays comfortably under the cap unmodified", () => {
    // A constant "true" cap check would still pass every test above; this
    // pins the untruncated shape too, so a mutant that always truncates (or
    // never does) has something concrete to fail against.
    const banner = buildBanner([finding()]) as string;
    expect(banner).toBe(
      '⚠ Since your last call: main thread blocked for 420ms. Call `findings {"since":"last"}`.',
    );
    expect(banner).not.toContain("more kind");
  });
});

// ---------------------------------------------------------------------------
// The ACs, through real tool calls in a rig
// ---------------------------------------------------------------------------

const blocked = (t: number, durationMs = 6_200) => ({
  event: "blocked",
  t,
  data: { durationMs, stack: "com.example.shop.Thing.work(Thing.kt:1)" },
});

describe("GRA-55 acceptance criteria", () => {
  it("AC1: two consecutive findings calls with nothing between them mark everything ongoing, and the summary says so", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents([blocked(1_000)]);

      const first = await rig.client.callTool("findings", {});
      expect(first.isError).toBeFalsy();
      const firstPayload = first.json as { findings: Array<{ id: string; status?: string }> };
      const firstFinding = firstPayload.findings.find((f) => f.id === "main-thread-stall");
      expect(firstFinding).toBeDefined();
      expect(firstFinding?.status).toBeUndefined(); // nothing to classify against yet

      const second = await rig.client.callTool("findings", {});
      expect(second.isError).toBeFalsy();
      const secondPayload = second.json as {
        findings: Array<{ id: string; status?: string; delta?: number }>;
      };
      const secondFinding = secondPayload.findings.find((f) => f.id === "main-thread-stall");
      expect(secondFinding?.status).toBe("ongoing");
      expect(secondFinding?.delta).toBe(0);
      expect(second.text).toMatch(/ongoing/);
      expect(second.text).not.toMatch(/resolved/);
    } finally {
      await rig.close();
    }
  });

  it("AC2: a finding that stops occurring is reported resolved exactly once, and is gone by the third call", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents([blocked(1_000)]);
      const first = await rig.client.callTool("findings", {});
      expect(first.isError).toBeFalsy();

      // Something unrelated happens — the stall itself does not recur.
      await rig.pushEvents([{ event: "recompose", t: 2_000, data: { name: "Cart" } }]);
      const second = await rig.client.callTool("findings", { since: "last" });
      expect(second.isError).toBeFalsy();
      const secondPayload = second.json as {
        findings: Array<{ id: string; status?: string; previousCount?: number }>;
      };
      const resolvedOnSecond = secondPayload.findings.filter(
        (f) => f.id === "main-thread-stall" && f.status === "resolved",
      );
      expect(resolvedOnSecond).toHaveLength(1);
      expect(resolvedOnSecond[0].previousCount).toBe(1);
      expect(second.text).toMatch(/resolved/);

      // Nothing new again — the third call must not re-report the same resolution.
      await rig.pushEvents([{ event: "recompose", t: 3_000, data: { name: "Cart" } }]);
      const third = await rig.client.callTool("findings", { since: "last" });
      const thirdPayload = third.json as { findings: Array<{ id: string; status?: string }> };
      expect(thirdPayload.findings.some((f) => f.id === "main-thread-stall")).toBe(false);
    } finally {
      await rig.close();
    }
  });

  it("AC3: an error event occurring between two calls appears in the banner of whichever unrelated tool is called next", async () => {
    const rig = await buildRig();
    try {
      // Establish a baseline with no error yet — the very first call this
      // process makes to anything must not itself carry a banner.
      const seed = await rig.client.callTool("porthole_status", {});
      expect(seed.text).not.toMatch(/⚠/);

      let t = 2_000;
      for (const tool of ["nav_state", "state", "semantics_tree"] as const) {
        await rig.pushEvents([blocked(t)]);
        const result = await rig.client.callTool(tool, {});
        expect(result.text, `${tool} did not carry the banner for a new error`).toMatch(
          /⚠ Since your last call/,
        );
        expect(result.text).toContain('findings {"since":"last"}');
        const payload = result.json as { sinceLast: { errors: number } | null };
        expect(payload.sinceLast).not.toBeNull();
        expect(payload.sinceLast?.errors).toBeGreaterThan(0);
        t += 1_000;
      }
    } finally {
      await rig.close();
    }
  });

  it("AC4: the banner never repeats an event", async () => {
    const rig = await buildRig();
    try {
      await rig.client.callTool("porthole_status", {}); // seed
      await rig.pushEvents([blocked(3_000)]);

      const first = await rig.client.callTool("nav_state", {});
      expect(first.text).toMatch(/⚠/);

      const second = await rig.client.callTool("state", {});
      expect(second.text).not.toMatch(/⚠/);
      const secondPayload = second.json as { sinceLast: unknown };
      expect(secondPayload.sinceLast).toBeNull();
    } finally {
      await rig.close();
    }
  });

  it("AC5: since: \"last\" on a first-ever call behaves exactly like today's default, and says so", async () => {
    const rigA = await buildRig();
    const rigB = await buildRig();
    try {
      await rigA.pushEvents([blocked(1_000)]);
      await rigB.pushEvents([blocked(1_000)]);

      const withSince = await rigA.client.callTool("findings", { since: "last" });
      const withoutAnyWindow = await rigB.client.callTool("findings", {});

      expect(withSince.isError).toBeFalsy();
      expect(withoutAnyWindow.isError).toBeFalsy();
      const payloadA = withSince.json as { window: { from: number; to: number } };
      const payloadB = withoutAnyWindow.json as { window: { from: number; to: number } };
      expect(payloadA.window).toEqual(payloadB.window);
      expect(withSince.text).toMatch(/first call this session/i);
    } finally {
      await rigA.close();
      await rigB.close();
    }
  });

  it("AC5, on a tool other than findings: the first-ever call says so too, and only once", async () => {
    // QA round 1: the narration lived in `findings` alone, so the other six
    // window-taking tools defaulted silently. It is now attached in `ok()`.
    const rig = await buildRig();
    try {
      await rig.pushEvents([blocked(1_000)]);
      const first = await rig.client.callTool("timeline", {});
      expect(first.isError).toBeFalsy();
      expect(first.text).toMatch(/first call this session/i);
      const second = await rig.client.callTool("timeline", {});
      expect(second.isError).toBeFalsy();
      expect(second.text).not.toMatch(/first call this session/i);
    } finally {
      await rig.close();
    }
  });

  // GRA-189: device pass, 2026-09-15 — `findings` resolved a zero-length
  // window and reported "0s examined (1 events)" on the *first* call a
  // process ever made, because a different window-taking tool (`frames`,
  // on the device) had already advanced the watermark with no digest for
  // `findings` to re-ask. The fix: `since: "last"` resolving to nothing new
  // and no digest to fall back to must say "nothing new," never analyse a
  // 0s window, and never claim to be a first call.
  it("GRA-189: since:\"last\" says 'nothing new', not 'first call' or '0s examined', when a different tool already advanced the watermark", async () => {
    const rig = await buildRig();
    try {
      await rig.pushEvents([blocked(1_000)]);
      // `timeline` advances the watermark's lastExaminedT without ever
      // recording a findings digest — the exact device shape.
      const setup = await rig.client.callTool("timeline", {});
      expect(setup.isError).toBeFalsy();

      // Nothing new happens. The buffer still holds the one old event.
      const result = await rig.client.callTool("findings", { since: "last" });
      expect(result.isError).toBeFalsy();
      expect(result.text).not.toMatch(/first call this session/i);
      expect(result.text).not.toMatch(/crossed a threshold/i); // not "nothing crossed a threshold in the 0s examined"
      expect(result.text).toMatch(/nothing new/i);
      const payload = result.json as {
        window: { from: number; to: number; ms: number };
        eventsExamined: number;
        findings: unknown[];
      };
      expect(payload.eventsExamined).toBe(0);
      expect(payload.window.ms).toBe(0);
      expect(payload.window.from).toBe(payload.window.to);
      expect(payload.findings).toEqual([]);
    } finally {
      await rig.close();
    }
  });

  it("GRA-55 AC1 still holds: two consecutive findings calls re-derive 'ongoing' even though the re-asked window is also zero-width", async () => {
    // The case GRA-189's fix must not break: back-to-back findings calls on
    // a single-instant buffer land on the exact same `from === to` shape the
    // "nothing new" branch above checks for, but here there IS a previous
    // findings digest to reclassify against, and that must still run.
    const rig = await buildRig();
    try {
      await rig.pushEvents([blocked(1_000)]);
      const first = await rig.client.callTool("findings", {});
      expect(first.isError).toBeFalsy();
      const firstPayload = first.json as { window: { from: number; to: number } };
      expect(firstPayload.window.from).toBe(firstPayload.window.to); // single event, zero-width

      const second = await rig.client.callTool("findings", {});
      expect(second.isError).toBeFalsy();
      expect(second.text).not.toMatch(/nothing new/i);
      const secondPayload = second.json as { findings: Array<{ id: string; status?: string }> };
      const finding = secondPayload.findings.find((f) => f.id === "main-thread-stall");
      expect(finding?.status).toBe("ongoing");
    } finally {
      await rig.close();
    }
  });
});

// GRA-53's `sessions-integration.test.ts` already measured this: two real
// loopback sockets and two MCP servers competing with every other test
// file's own sockets for the OS scheduler produces genuine timing flakiness
// (a `waitUntil` or a same-directory `rm` losing a race), never a wrong
// assertion once the wait or the write actually lands. `retry: 2` is the
// honest tool for that — it would not hide a real logic bug, which fails
// identically every attempt.
vi.setConfig({ testTimeout: 20_000, retry: 2 });

describe("GRA-55 AC6: the watermark survives an MCP server restart", () => {
  const roots: string[] = [];
  const clients: TestClient[] = [];
  const devices: DeviceClient[] = [];
  const timelines: TimelineServer[] = [];
  let fakeDevice: FakeDevice | null = null;

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
    for (const device of devices.splice(0)) device.stop();
    for (const timeline of timelines.splice(0)) timeline.stop();
    await fakeDevice?.close();
    fakeDevice = null;
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("a second process's first findings call classifies against the first process's digest, loaded from disk", async () => {
    const sessionsRoot = await mkdtemp(path.join(tmpdir(), "porthole-watermark-restart-"));
    roots.push(sessionsRoot);

    const hello: Hello = {
      protocol: 1,
      packageName: "com.example.shop",
      processName: "com.example.shop",
      versionName: "1.0.0-test",
      device: "Test Device",
      sdkInt: 34,
      startedAt: 300_000, // the app process's own uptime origin — unchanged across "restarts"
      collectors: [],
      deviceId: "device-under-test",
    };
    fakeDevice = await FakeDevice.start({
      hello: () => hello,
      timeline: () => ({ events: [], droppedBefore: 0, now: Date.now() }),
    });

    // --- process 1: sees the stall, calls findings once ------------------
    const device1 = new DeviceClient("127.0.0.1", fakeDevice.port, sessionsRoot);
    const timeline1 = new TimelineServer(device1, 0);
    devices.push(device1);
    timelines.push(timeline1);
    const { server: server1 } = createPortholeServer({ device: device1, timeline: timeline1, version: "0.0.0-test" });
    device1.start();
    await waitUntil(() => device1.hello !== null, 10_000);

    const target1 = timeline1.buffer().length + 1;
    fakeDevice.emit("blocked", 1_000, { durationMs: 6_200, stack: "x" });
    await waitUntil(() => timeline1.buffer().length >= target1, 10_000);
    await device1.sessions!.flush();

    const client1 = await connect(server1);
    clients.push(client1);
    const first = await client1.callTool("findings", {});
    expect(first.isError).toBeFalsy();
    const firstPayload = first.json as { findings: Array<{ id: string }> };
    expect(firstPayload.findings.some((f) => f.id === "main-thread-stall")).toBe(true);

    // --- the MCP server process is killed ---------------------------------
    device1.stop();
    timeline1.stop();
    server1.close();

    // --- process 2: same app, same device, a fresh MCP server ------------
    const device2 = new DeviceClient("127.0.0.1", fakeDevice.port, sessionsRoot);
    const timeline2 = new TimelineServer(device2, 0);
    devices.push(device2);
    timelines.push(timeline2);
    const { server: server2 } = createPortholeServer({ device: device2, timeline: timeline2, version: "0.0.0-test" });
    device2.start();
    await waitUntil(() => device2.hello !== null, 10_000);
    expect(timeline2.buffer().length).toBe(0); // the live ring really is empty — a fresh process

    // Something unrelated happens after the restart — the stall itself does not recur.
    const target2 = timeline2.buffer().length + 1;
    fakeDevice.emit("recompose", 5_000, { name: "Cart" });
    await waitUntil(() => timeline2.buffer().length >= target2, 10_000);
    // Flushed explicitly, same as process 1 above — otherwise its 250ms
    // flush timer can still be pending when `afterEach` removes the
    // sessions root out from under it (an EPERM on Windows, not a logic bug).
    await device2.sessions!.flush();

    const client2 = await connect(server2);
    clients.push(client2);
    const second = await client2.callTool("findings", { since: "last" });
    expect(second.isError).toBeFalsy();
    const secondPayload = second.json as { findings: Array<{ id: string; status?: string }> };
    const resolved = secondPayload.findings.find((f) => f.id === "main-thread-stall");
    // Loaded from disk, not re-derived in memory: process 2 never saw the
    // stall itself, only `watermark.json`'s record that process 1 had.
    expect(resolved?.status).toBe("resolved");
  });

  // GRA-189: the device pass's own shape — a fresh MCP process whose live
  // ring is genuinely empty (self-check: "the nothing-new branch with an
  // empty buffer") loads a watermark an earlier process left on disk, and
  // nothing has arrived since. This must read as "nothing new," never as
  // "first call" (the watermark is not empty, it just has nothing past it)
  // and never as "0s examined" (no digest exists to reclassify against,
  // because process 1's last window-taking call was `timeline`, not
  // `findings` — exactly the device's own sequence).
  it("GRA-189: a fresh process's first findings call says 'nothing new', not 'first call', when its restored watermark has nothing new past it", async () => {
    const sessionsRoot = await mkdtemp(path.join(tmpdir(), "porthole-watermark-nothing-new-"));
    roots.push(sessionsRoot);

    const hello: Hello = {
      protocol: 1,
      packageName: "com.example.shop",
      processName: "com.example.shop",
      versionName: "1.0.0-test",
      device: "Test Device",
      sdkInt: 34,
      startedAt: 300_000,
      collectors: [],
      deviceId: "device-under-test",
    };
    fakeDevice = await FakeDevice.start({
      hello: () => hello,
      timeline: () => ({ events: [], droppedBefore: 0, now: Date.now() }),
    });

    // --- process 1: sees the stall, calls `timeline` (never `findings`) ---
    const device1 = new DeviceClient("127.0.0.1", fakeDevice.port, sessionsRoot);
    const timeline1 = new TimelineServer(device1, 0);
    devices.push(device1);
    timelines.push(timeline1);
    const { server: server1 } = createPortholeServer({ device: device1, timeline: timeline1, version: "0.0.0-test" });
    device1.start();
    await waitUntil(() => device1.hello !== null, 10_000);

    const target1 = timeline1.buffer().length + 1;
    fakeDevice.emit("blocked", 1_000, { durationMs: 6_200, stack: "x" });
    await waitUntil(() => timeline1.buffer().length >= target1, 10_000);
    await device1.sessions!.flush();

    const client1 = await connect(server1);
    clients.push(client1);
    const setup = await client1.callTool("timeline", {});
    expect(setup.isError).toBeFalsy();

    device1.stop();
    timeline1.stop();
    server1.close();

    // --- process 2: same app, same device, a fresh MCP server, nothing new
    const device2 = new DeviceClient("127.0.0.1", fakeDevice.port, sessionsRoot);
    const timeline2 = new TimelineServer(device2, 0);
    devices.push(device2);
    timelines.push(timeline2);
    const { server: server2 } = createPortholeServer({ device: device2, timeline: timeline2, version: "0.0.0-test" });
    device2.start();
    await waitUntil(() => device2.hello !== null, 10_000);
    expect(timeline2.buffer().length).toBe(0); // the live ring really is empty

    const client2 = await connect(server2);
    clients.push(client2);
    const result = await client2.callTool("findings", { since: "last" });
    expect(result.isError).toBeFalsy();
    expect(result.text).not.toMatch(/first call this session/i);
    expect(result.text).toMatch(/nothing new/i);
    const payload = result.json as { eventsExamined: number; window: { from: number; to: number; ms: number } };
    expect(payload.eventsExamined).toBe(0);
    expect(payload.window.ms).toBe(0);
  });
});
