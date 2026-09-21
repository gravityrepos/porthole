// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// GRA-53: each test here spins up two full rigs in sequence — two real
// loopback sockets, two MCP servers. Comfortably fits vitest's default 5s
// test timeout run alone (well under 1s in practice), but real-socket event
// delivery competes for the OS scheduler with 17 other parallel test files'
// own sockets on this machine, and has been measured missing even a 10s
// `waitUntil()` under that load — timing flakiness from real contention on
// this machine, not a logic bug: every failure seen was a `waitUntil`
// timeout waiting on the OS to deliver a loopback event, never a wrong
// assertion once the wait succeeded. `retry: 2` is the honest tool for that
// specific shape (environment-induced timing, not correctness) — it would
// not hide a real logic bug, which fails identically on every attempt.
vi.setConfig({ testTimeout: 20_000, retry: 2 });
import { DeviceClient, type Hello } from "./device.js";
import { TimelineServer } from "./timeline.js";
import { createPortholeServer } from "./index.js";
import { FakeDevice, connect, waitUntil, type TestClient } from "./testing/harness.js";

/**
 * GRA-53's tool-surface AC, proven end to end rather than only at the
 * `sessions.ts` library level: 23 unit tests under `sessions.test.ts` show
 * the disk-backed machinery works; this file is the one place that shows a
 * real MCP tool call actually benefits from it. New file rather than an
 * addition to `index.test.ts` — `index.test.ts` is outside this ticket's
 * `Owns`, and this AC is expressible entirely through the same public
 * harness (`testing/harness.ts`) that file already uses, with no need to
 * touch it.
 *
 * The scenario is literally the ticket's own: "the MCP server killed and
 * restarted mid-session, `what_was_happening` at a timestamp from before the
 * restart returns the moment, not 'no longer held'." Simulated by building
 * two independent rigs — two `DeviceClient`s, two `TimelineServer`s, two
 * `createPortholeServer` calls, exactly as two separate process lifetimes
 * would be — sharing one `sessionsRoot` directory and one `FakeDevice` whose
 * `hello` reports a *fixed* `startedAt` (the app process itself never
 * restarted; only the thing connecting to it did).
 */
describe("GRA-53: what_was_happening survives an MCP server restart", () => {
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

  it("answers a pre-restart moment from disk once the live ring has been wiped by a fresh MCP process", async () => {
    const sessionsRoot = await mkdtemp(path.join(tmpdir(), "porthole-session-integration-"));
    roots.push(sessionsRoot);

    const FIXED_STARTED_AT = 500_000; // the app process's own uptime origin — unchanged across "restarts"
    const hello: Hello = {
      protocol: 1,
      packageName: "com.example.shop",
      processName: "com.example.shop",
      versionName: "1.0.0-test",
      device: "Test Device",
      sdkInt: 34,
      startedAt: FIXED_STARTED_AT,
      collectors: [],
      deviceId: "device-under-test",
    };

    fakeDevice = await FakeDevice.start({
      hello: () => hello, // fixed — the app process itself never restarts in this scenario
      timeline: () => ({ events: [], droppedBefore: 0, now: Date.now() }),
    });

    // --- "process 1": the MCP server before it gets killed --------------
    const device1 = new DeviceClient("127.0.0.1", fakeDevice.port, sessionsRoot);
    const timeline1 = new TimelineServer(device1, 0);
    devices.push(device1);
    timelines.push(timeline1);
    const { server: server1 } = createPortholeServer({
      device: device1,
      timeline: timeline1,
      version: "0.0.0-test",
    });

    device1.start();
    await waitUntil(() => device1.hello !== null, 10_000);

    const navAt = 10_000;
    const target = timeline1.buffer().length + 1;
    fakeDevice.emit("nav", navAt, { route: "cart", destinationId: "cart" });
    await waitUntil(() => timeline1.buffer().length >= target, 10_000);

    // Flush explicitly rather than waiting on the interval timer — this is
    // testing that the moment survives on disk, not testing the timer.
    await device1.sessions!.flush();
    const sessionDir = device1.sessions!.currentDir();
    expect(sessionDir).not.toBeNull();

    // --- the MCP server process is killed --------------------------------
    device1.stop();
    timeline1.stop();
    server1.close();

    // --- "process 2": the MCP server restarted, same app, same device ----
    // A fresh DeviceClient and a fresh TimelineServer — exactly what a new
    // process gives you. The live ring starts empty; only the sessions
    // directory on disk (same `sessionsRoot`, same identity) carries the
    // nav event across the boundary.
    const device2 = new DeviceClient("127.0.0.1", fakeDevice.port, sessionsRoot);
    const timeline2 = new TimelineServer(device2, 0);
    devices.push(device2);
    timelines.push(timeline2);
    const { server: server2 } = createPortholeServer({
      device: device2,
      timeline: timeline2,
      version: "0.0.0-test",
    });

    device2.start();
    await waitUntil(() => device2.hello !== null, 10_000);
    expect(timeline2.buffer().length).toBe(0); // the live ring really is empty — this is the bug the ticket describes

    const client = await connect(server2);
    clients.push(client);

    const result = await client.callTool("what_was_happening", { detail: "normal", at: navAt });

    expect(result.isError).toBeFalsy();
    // The old failure mode, verbatim from the ticket's own "Why": this must
    // NOT be what comes back any more.
    expect(result.text).not.toContain("no longer held");
    expect(result.text).not.toContain("outside what is buffered");
    // The success shape spreads the moment's own fields directly into the
    // payload (see `ok(notice + describeMoment(moment), { ...moment, ... })`
    // in index.ts) — there is no wrapping `moment` key here, unlike the
    // "could not answer" shapes above it, which return `{ moment: null, ... }`.
    const payload = result.json as { at?: number; window?: { from: number; to: number } };
    expect(payload.at).toBe(navAt);
    expect(payload.window).toBeDefined();
  });

  it("findings' clippedMs shrinks for the part now on disk and stays honest for time never recorded", async () => {
    const sessionsRoot = await mkdtemp(path.join(tmpdir(), "porthole-session-integration-"));
    roots.push(sessionsRoot);

    const FIXED_STARTED_AT = 700_000;
    const hello: Hello = {
      protocol: 1,
      packageName: "com.example.shop",
      processName: "com.example.shop",
      versionName: "1.0.0-test",
      device: "Test Device",
      sdkInt: 34,
      startedAt: FIXED_STARTED_AT,
      collectors: [],
      deviceId: "device-under-test",
    };

    fakeDevice = await FakeDevice.start({
      hello: () => hello,
      timeline: () => ({ events: [], droppedBefore: 0, now: Date.now() }),
    });

    // --- before the restart: two events land and get flushed to disk -----
    const device1 = new DeviceClient("127.0.0.1", fakeDevice.port, sessionsRoot);
    const timeline1 = new TimelineServer(device1, 0);
    devices.push(device1);
    timelines.push(timeline1);
    createPortholeServer({ device: device1, timeline: timeline1, version: "0.0.0-test" });
    device1.start();
    await waitUntil(() => device1.hello !== null, 10_000);

    let target = timeline1.buffer().length + 2;
    fakeDevice.emit("recompose", 1_000, { name: "Cart" });
    fakeDevice.emit("recompose", 2_000, { name: "Cart" });
    await waitUntil(() => timeline1.buffer().length >= target, 10_000);
    await device1.sessions!.flush();
    device1.stop();
    timeline1.stop();

    // --- restart: a fresh rig, same identity, same sessions root ---------
    const device2 = new DeviceClient("127.0.0.1", fakeDevice.port, sessionsRoot);
    const timeline2 = new TimelineServer(device2, 0);
    devices.push(device2);
    timelines.push(timeline2);
    const { server: server2 } = createPortholeServer({
      device: device2,
      timeline: timeline2,
      version: "0.0.0-test",
    });
    device2.start();
    await waitUntil(() => device2.hello !== null, 10_000);

    // One more event after the restart, only ever in the new process's live
    // buffer until this flush — the disk and the live ring each hold a
    // different piece of the story.
    target = timeline2.buffer().length + 1;
    fakeDevice.emit("recompose", 3_000, { name: "Cart" });
    await waitUntil(() => timeline2.buffer().length >= target, 10_000);
    await device2.sessions!.flush();

    const client = await connect(server2);
    clients.push(client);

    // A window that reaches earlier than anything ever recorded (0) and
    // later than anything recorded so far (4000), straddling the restart at
    // 2000-3000 in the middle.
    const result = await client.callTool("findings", { detail: "normal", from: 0, to: 4_000 });
    expect(result.isError).toBeFalsy();
    const payload = result.json as {
      clippedMs: { start: number; end: number };
      eventsExamined: number;
    };

    // The middle (1000-2000, on disk from before the restart; 3000, live
    // after it) is not clipped at all -- this is the part the ticket's own
    // wording ("clippedMs must shrink to zero for what is on disk") is
    // about, and it only shrinks because the disk fallback is doing real
    // work here: the live buffer alone, post-restart, only ever held the
    // one event at t=3000.
    expect(payload.clippedMs.start).toBe(1_000); // 0..1000 genuinely never recorded
    expect(payload.clippedMs.end).toBe(1_000); // 3000..4000 genuinely never recorded (yet)
    expect(payload.eventsExamined).toBe(3); // all three events, from both sides of the restart, once each
  });

  /**
   * The case the coordinator asked to be pinned explicitly, because it is
   * the one a future refactor is most likely to get wrong: "not that
   * nothing was happening, it is no longer held" cuts both ways.
   * `clippedMs` answers a coverage question, not a did-anything-happen
   * question — a five-second stretch with real silence inside a session
   * that plainly recorded it must read as `clippedMs: 0`, exactly like a
   * five-second stretch full of events. Getting this wrong the *other*
   * direction (deriving coverage from which events matched) would make a
   * quiet moment look identical to a moment nobody was ever watching, which
   * is precisely the conflation `findings`' own tool description already
   * warns against for the ordinary empty-findings case.
   */
  it("a genuinely quiet stretch inside a recorded session reports clippedMs zero, not clipped", async () => {
    const sessionsRoot = await mkdtemp(path.join(tmpdir(), "porthole-session-integration-"));
    roots.push(sessionsRoot);

    const hello: Hello = {
      protocol: 1,
      packageName: "com.example.shop",
      processName: "com.example.shop",
      versionName: "1.0.0-test",
      device: "Test Device",
      sdkInt: 34,
      startedAt: 900_000,
      collectors: [],
      deviceId: "device-under-test",
    };

    fakeDevice = await FakeDevice.start({
      hello: () => hello,
      timeline: () => ({ events: [], droppedBefore: 0, now: Date.now() }),
    });

    const device = new DeviceClient("127.0.0.1", fakeDevice.port, sessionsRoot);
    const timeline = new TimelineServer(device, 0);
    devices.push(device);
    timelines.push(timeline);
    const { server } = createPortholeServer({ device, timeline, version: "0.0.0-test" });
    device.start();
    await waitUntil(() => device.hello !== null, 10_000);

    // The session's recorded span runs 0..10_000 (one event at each end);
    // nothing at all happens in the middle third, 3_000..7_000.
    const target = timeline.buffer().length + 2;
    fakeDevice.emit("recompose", 0, { name: "Cart" });
    fakeDevice.emit("recompose", 10_000, { name: "Cart" });
    await waitUntil(() => timeline.buffer().length >= target, 10_000);
    await device.sessions!.flush();

    const client = await connect(server);
    clients.push(client);

    const result = await client.callTool("findings", { detail: "normal", from: 3_000, to: 7_000 });
    expect(result.isError).toBeFalsy();
    const payload = result.json as {
      clippedMs: { start: number; end: number };
      eventsExamined: number;
    };

    expect(payload.eventsExamined).toBe(0); // genuinely nothing happened in this sub-window
    expect(payload.clippedMs).toEqual({ start: 0, end: 0 }); // but it was fully recorded, so it is not clipped
  });

  /**
   * The third consumer of `mergeWithDisk()`/`fillWindowFromDisk()` — the
   * same pattern `what_was_happening` and `findings` above already go
   * through, not a third mechanism. The `timeline` tool's own contract
   * (raw event stream, no `clippedMs`) stays as it was; only where its
   * `events` come from changes.
   */
  it("the timeline tool returns events from both sides of a restart on one axis, in order, with no duplicates", async () => {
    const sessionsRoot = await mkdtemp(path.join(tmpdir(), "porthole-session-integration-"));
    roots.push(sessionsRoot);

    const hello: Hello = {
      protocol: 1,
      packageName: "com.example.shop",
      processName: "com.example.shop",
      versionName: "1.0.0-test",
      device: "Test Device",
      sdkInt: 34,
      startedAt: 1_100_000,
      collectors: [],
      deviceId: "device-under-test",
    };

    fakeDevice = await FakeDevice.start({
      hello: () => hello,
      timeline: () => ({ events: [], droppedBefore: 0, now: Date.now() }),
    });

    // --- before the restart -----------------------------------------------
    const device1 = new DeviceClient("127.0.0.1", fakeDevice.port, sessionsRoot);
    const timeline1 = new TimelineServer(device1, 0);
    devices.push(device1);
    timelines.push(timeline1);
    createPortholeServer({ device: device1, timeline: timeline1, version: "0.0.0-test" });
    device1.start();
    await waitUntil(() => device1.hello !== null, 10_000);

    let target = timeline1.buffer().length + 2;
    fakeDevice.emit("recompose", 1_000, { name: "Cart" });
    fakeDevice.emit("nav", 2_000, { route: "cart" });
    await waitUntil(() => timeline1.buffer().length >= target, 10_000);
    await device1.sessions!.flush();
    device1.stop();
    timeline1.stop();

    // --- the restart --------------------------------------------------------
    const device2 = new DeviceClient("127.0.0.1", fakeDevice.port, sessionsRoot);
    const timeline2 = new TimelineServer(device2, 0);
    devices.push(device2);
    timelines.push(timeline2);
    const { server: server2 } = createPortholeServer({
      device: device2,
      timeline: timeline2,
      version: "0.0.0-test",
    });
    device2.start();
    await waitUntil(() => device2.hello !== null, 10_000);
    expect(timeline2.buffer().length).toBe(0); // the live ring really is empty after the "restart"

    target = timeline2.buffer().length + 1;
    fakeDevice.emit("recompose", 3_000, { name: "Cart" });
    await waitUntil(() => timeline2.buffer().length >= target, 10_000);

    const client = await connect(server2);
    clients.push(client);

    // The boundary (2000-3000) sits inside the window, not at its edge.
    const result = await client.callTool("timeline", { detail: "normal", from: 500, to: 3_500 });
    expect(result.isError).toBeFalsy();
    const payload = result.json as {
      events: Array<{ t: number; seq: number }>;
      matched: number;
      returned: number;
    };

    expect(payload.events.map((e) => e.t)).toEqual([1_000, 2_000, 3_000]);
    expect(payload.returned).toBe(3);
    // No duplicates: t=3000 exists only once even though nothing here forced
    // that — it is a straightforward consequence of `mergeWithDisk`'s own
    // (sessionDir, seq) dedup key, exercised through the real tool call.
    expect(new Set(payload.events.map((e) => e.seq)).size).toBe(payload.events.length);
  });
});
