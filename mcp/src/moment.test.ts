// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe as suite, expect, it } from "vitest";
import type { DeviceEvent } from "./device.js";
import { describe, fromBootMs, momentOf } from "./moment.js";

const at = (t: number, event: string, data: Record<string, unknown> = {}): DeviceEvent =>
  ({ t, seq: t, event, data }) as DeviceEvent;

/** A session: land on cart, fire a checkout call, block the main thread. */
const session: DeviceEvent[] = [
  at(0, "clocks", { uptimeMs: 0, bootMs: 5_000, wallMs: 1, sleepMs: 5_000 }),
  at(1_000, "nav", { route: "cart/{id}", args: "{id=99001}", depth: "2" }),
  at(5_000, "http_start", { id: "http-1", method: "POST", url: "https://api/checkout" }),
  at(5_200, "db_start", { id: "db-1", sql: "SELECT * FROM items", onMainThread: "true" }),
  at(5_400, "db_end", { id: "db-1", elapsedMs: "200" }),
  at(5_500, "state_write", { key: "CartViewModel.total" }),
  at(5_600, "blocked", { durationMs: "412", top: "CartViewModel.block(CartViewModel.kt:146)" }),
  at(5_700, "frame", { totalMs: "276", missedFrames: "16" }),
  at(9_000, "http_end", { id: "http-1", status: "200" }),
  at(20_000, "nav", { route: "settings", args: "" }),
];

suite("locating a moment", () => {
  it("names the screen you were on, not one you reached later", () => {
    const moment = momentOf(session, 5_600);
    expect(moment.screen?.route).toBe("cart/{id}");
    expect(moment.screen?.args).toBe("{id=99001}");
    // Entered 4.6s earlier, well outside the window — a screen you sit on
    // longer than the spread is still the screen you are on.
    expect(moment.screen?.agoMs).toBe(4_600);
  });

  it("reports a call that was open across the moment, not its full duration", () => {
    const moment = momentOf(session, 5_600);
    const http = moment.inFlight.find((s) => s.kind === "http");
    expect(http?.label).toContain("POST https://api/checkout");
    // Started at 5000, asked about 5600: it had been open 600ms at that point,
    // even though it ran for 4000ms in total. The question is what was true
    // then, not what turned out to be true later.
    expect(http?.openForMs).toBe(600);
  });

  it("flags a query that ran on the main thread", () => {
    const moment = momentOf(session, 5_300);
    const db = moment.inFlight.find((s) => s.kind === "db");
    expect(db?.label).toContain("(main thread)");
  });

  it("carries the stall, the frames and the writes just before", () => {
    const moment = momentOf(session, 5_600);
    expect(moment.stalls[0].durationMs).toBe(412);
    expect(moment.frames.missed).toBe(16);
    expect(moment.stateWrites.map((w) => w.key)).toContain("CartViewModel.total");
  });

  it("does not invent context from a quiet moment", () => {
    const moment = momentOf(session, 15_000);
    expect(moment.inFlight).toEqual([]);
    expect(moment.stalls).toEqual([]);
    expect(moment.recompositions).toBe(0);
    // Still knows the screen: silence is not the same as being nowhere.
    expect(moment.screen?.route).toBe("cart/{id}");
  });

  it("says so when a span never finished", () => {
    const stuck = [...session.filter((e) => e.event !== "http_end")];
    const moment = momentOf(stuck, 9_000);
    const http = moment.inFlight.find((s) => s.kind === "http");
    expect(http?.endedAt).toBeNull();
    expect(describe(moment)).toContain("never finished");
  });
});

suite("arriving from another clock", () => {
  it("converts a boot-clock timestamp into porthole's", () => {
    // The device slept 5s before the trace began, so a Perfetto slice at
    // boot-time 10600 is Porthole's 5600 — the moment of the stall.
    const converted = fromBootMs(session, 10_600);
    expect(converted?.at).toBe(5_600);
    expect(converted?.sleepMs).toBe(5_000);
  });

  it("uses the sample in force at that moment, not the newest one", () => {
    // A device that dozes mid-session has two different offsets, and applying
    // the later one to an earlier moment silently shifts the answer by however
    // long it slept.
    const dozed = [
      ...session,
      at(30_000, "clocks", { uptimeMs: 30_000, bootMs: 95_000, wallMs: 2, sleepMs: 65_000 }),
    ];
    expect(fromBootMs(dozed, 10_600)?.at).toBe(5_600);
    expect(fromBootMs(dozed, 95_000)?.at).toBe(30_000);
  });

  it("admits when it cannot convert", () => {
    const noClocks = session.filter((e) => e.event !== "clocks");
    expect(fromBootMs(noClocks, 10_600)).toBeNull();
  });
});

suite("the summary", () => {
  it("reads as an answer to the question that was asked", () => {
    const line = describe(momentOf(session, 5_600));
    expect(line).toContain("cart/{id}");
    expect(line).toContain("POST https://api/checkout");
    expect(line).toContain("412ms");
  });

  it("says plainly when there was no navigation at all", () => {
    expect(describe(momentOf([at(10, "frame", {})], 10))).toContain("No navigation recorded");
  });
});
