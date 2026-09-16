// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe as suite, expect, it } from "vitest";
import type { DeviceEvent } from "./device.js";
import { describe, fromBootMs, fromTraceClockSnapshot, momentOf, toBoot, toBootNs } from "./moment.js";

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

suite("alsoInWindow (GRA-200): what_was_happening says the same sentence findings does", () => {
  it("names a process exit that falls inside this moment's own window", () => {
    const withExit = [
      ...session,
      at(5_650, "exit", { reason: "REASON_SIGNALED", timestamp: 1_700_000_000_000 }),
    ];
    const moment = momentOf(withExit, 5_600);
    expect(moment.alsoInWindow?.exits).toEqual([
      { reason: "REASON_SIGNALED", timestamp: 1_700_000_000_000, at: new Date(1_700_000_000_000).toISOString() },
    ]);
    // Same wording findings' own summary uses for the same fact — see
    // alsoInWindowSentence in trace.ts, which both tools call.
    expect(describe(moment)).toContain(
      "1 process exit (REASON_SIGNALED, full record via `porthole_status { exitTrace: 1700000000000 }`)",
    );
  });

  it("does not name an exit that falls outside this moment's spread", () => {
    // Same session, but the exit is 5s before the moment — well outside the
    // default 2s spread on either side.
    const farExit = [...session, at(600, "exit", { reason: "REASON_SIGNALED", timestamp: 1 })];
    const moment = momentOf(farExit, 5_600);
    expect(moment.alsoInWindow).toBeUndefined();
    expect(describe(moment)).not.toContain("Also in this window");
  });

  it("(missing-input case) a reason-less exit event does not throw, and reports an empty reason rather than crashing", () => {
    const noReason = [...session, at(5_650, "exit", { timestamp: 1_700_000_000_000 })];
    const moment = momentOf(noReason, 5_600);
    expect(moment.alsoInWindow?.exits?.[0].reason).toBe("");
  });
});

suite("toBootNs (GRA-113): the reverse trip, for scoping a trace query", () => {
  it("round-trips through fromBootMs", () => {
    // The stall at Porthole 5_600 is boot-time 10_600 (session slept 5s
    // before it began — see the "arriving from another clock" suite above).
    // Going forward then back should land exactly where it started.
    const bootNs = toBootNs(session, 5_600);
    expect(bootNs).toBe(10_600 * 1e6);
    expect(fromBootMs(session, bootNs / 1e6)?.at).toBe(5_600);
  });

  it("uses the sample in force at the moment asked about, not whichever it finds first", () => {
    // Mirrors fromBootMs's own "does not apply the later offset to an
    // earlier moment" test, in the opposite direction. The open-coded
    // version this replaced read whichever `clocks` sample the search found
    // first, which — for a session with more than one sample — is a
    // different bug than fromBootMs's (that one always used the newest);
    // this pins that the fix is the same *shape* of fix, not a coincidence
    // that happens to pass on a one-sample session.
    const dozed = [
      ...session,
      at(30_000, "clocks", { uptimeMs: 30_000, bootMs: 95_000, wallMs: 2, sleepMs: 65_000 }),
    ];
    expect(toBootNs(dozed, 10_600)).toBe((10_600 + 5_000) * 1e6);
    expect(toBootNs(dozed, 95_000)).toBe((95_000 + 65_000) * 1e6);
  });

  it("assumes no accumulated sleep rather than refusing, when the run has no clocks sample yet", () => {
    const noClocks = session.filter((e) => e.event !== "clocks");
    expect(toBootNs(noClocks, 10_600)).toBe(10_600 * 1e6);
  });
});

suite("toBoot (GRA-113): toBootNs's fuller answer, for a caller that reports the offset back", () => {
  it("is toBootNs's ns, plus the sleepMs and sample it used to get there", () => {
    const full = toBoot(session, 5_600);
    expect(full.ns).toBe(toBootNs(session, 5_600));
    expect(full.sleepMs).toBe(5_000);
    expect(full.sampledAt).toBe(0); // the session's one `clocks` sample, at t=0
  });

  it("picks a different sample's sleepMs for a moment on the other side of a doze, same as toBootNs's own ns does", () => {
    const dozed = [
      ...session,
      at(30_000, "clocks", { uptimeMs: 30_000, bootMs: 95_000, wallMs: 2, sleepMs: 65_000 }),
    ];
    expect(toBoot(dozed, 10_600)).toMatchObject({ sleepMs: 5_000, sampledAt: 0 });
    expect(toBoot(dozed, 95_000)).toMatchObject({ sleepMs: 65_000, sampledAt: 30_000 });
  });

  it("reports sleepMs 0 and a null sampledAt rather than refusing, when there is no clocks sample yet", () => {
    const noClocks = session.filter((e) => e.event !== "clocks");
    expect(toBoot(noClocks, 10_600)).toEqual({ ns: 10_600 * 1e6, sleepMs: 0, sampledAt: null });
  });
});

suite("fromTraceClockSnapshot (GRA-113): coverage's offset, read from a trace instead of a session", () => {
  it("applies the same {boot, monotonic} offset fromBootMs would, taken from the trace's own snapshot", () => {
    // A device that slept 12,272.83s before this trace was captured — the
    // hardware-verified figure from this project's own hard-won facts.
    const sleepNs = 12_272_830_000_000;
    const snapshot = { bootNs: 542_876_016_852_014, monotonicNs: 542_876_016_852_014 - sleepNs };
    const at = snapshot.bootNs + 1_000_000; // 1ms into the trace
    expect(fromTraceClockSnapshot(snapshot, at)).toBe(Math.round((at - sleepNs) / 1e6));
  });

  it("agrees with a zero offset when boot and monotonic were sampled equal", () => {
    const snapshot = { bootNs: 1_000_000_000, monotonicNs: 1_000_000_000 };
    expect(fromTraceClockSnapshot(snapshot, 1_500_000_000)).toBe(1_500);
  });
});
