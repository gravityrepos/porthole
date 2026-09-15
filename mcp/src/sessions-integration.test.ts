// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    const { server: server1 } = createPortholeServer({ device: device1, timeline: timeline1, version: "0.0.0-test" });

    device1.start();
    await waitUntil(() => device1.hello !== null, 5_000);

    const navAt = 10_000;
    const target = timeline1.buffer().length + 1;
    fakeDevice.emit("nav", navAt, { route: "cart", destinationId: "cart" });
    await waitUntil(() => timeline1.buffer().length >= target);

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
    const { server: server2 } = createPortholeServer({ device: device2, timeline: timeline2, version: "0.0.0-test" });

    device2.start();
    await waitUntil(() => device2.hello !== null, 5_000);
    expect(timeline2.buffer().length).toBe(0); // the live ring really is empty — this is the bug the ticket describes

    const client = await connect(server2);
    clients.push(client);

    const result = await client.callTool("what_was_happening", { at: navAt });

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
});
