// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineStore } from "./TimelineStore";
import type { DeviceEvent, Hello } from "../types";

/**
 * The store notifies on an animation frame, and these tests run in node. The
 * stub keeps the callbacks so a test can decide when the frame happens, which
 * is the only way to say anything about coalescing.
 */
let frames: Array<() => void> = [];

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.push(callback);
    return frames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function runFrame(): void {
  const pending = frames;
  frames = [];
  for (const callback of pending) callback();
}

let nextSeq = 0;

/** A `log`, in the shape LogCollector emits: level, tag, tid, wallTime, message. */
function log(message: string, seq = nextSeq++): DeviceEvent {
  return {
    event: "log",
    t: seq * 3,
    seq,
    data: {
      level: "E",
      tag: "CartRepository",
      tid: 6499,
      wallTime: "09-10 21:32:33.196",
      message,
    },
  };
}

/** A `log_append`: the trace line, and the sequence of the entry it belongs to. */
function append(parentSeq: number, text: string, seq = nextSeq++): DeviceEvent {
  return { event: "log_append", t: seq * 3, seq, data: { seq: parentSeq, text } };
}

function other(name: string, seq = nextSeq++): DeviceEvent {
  return { event: name, t: seq * 3, seq, data: { count: 3 } };
}

function message(store: TimelineStore, seq: number): string {
  const entry = store.events.find((event) => event.event === "log" && event.seq === seq);
  return String(entry?.data.message);
}

beforeEach(() => {
  nextSeq = 0;
});

const hello: Hello = {
  protocol: 1,
  packageName: "com.example.shop",
  processName: "com.example.shop",
  versionName: "1.0",
  device: "Pixel 8",
  sdkInt: 34,
  startedAt: 1_000,
  collectors: ["log", "frames"],
};

describe("apply", () => {
  it("takes the buffer, connection and hello from a backfill", () => {
    const store = new TimelineStore();
    store.apply({ type: "init", events: [log("boom")], state: "connected", hello });

    expect(store.events).toHaveLength(1);
    expect(store.connection).toBe("connected");
    expect(store.hello?.packageName).toBe("com.example.shop");
  });

  it("treats a backfill with no events as an empty buffer rather than a crash", () => {
    const store = new TimelineStore();
    store.apply({ type: "init" });
    expect(store.events).toEqual([]);
  });

  it("appends streamed events and leaves hello alone", () => {
    const store = new TimelineStore();
    store.apply({ type: "init", events: [], hello });
    store.apply({ type: "event", event: other("recompose") });

    expect(store.events).toHaveLength(1);
    expect(store.hello).toBe(hello);
  });

  it("drops the oldest events once the buffer is full", () => {
    const store = new TimelineStore();
    const events: DeviceEvent[] = [];
    for (let i = 0; i < 20_000; i++) events.push(other("recompose"));
    store.apply({ type: "init", events });

    const newest = other("recompose");
    store.apply({ type: "event", event: newest });

    expect(store.events).toHaveLength(20_000);
    expect(store.events[19_999]).toBe(newest);
    expect(store.events[0].seq).toBe(1);
  });

  it("records connection state and hello sent on their own", () => {
    const store = new TimelineStore();
    store.apply({ type: "state", state: "disconnected" });
    expect(store.connection).toBe("disconnected");

    store.apply({ type: "hello", hello: null, packageMismatch: null });
    expect(store.hello).toBeNull();
  });
});

describe("packageMismatch (GRA-197)", () => {
  it("is taken from a 'hello' message, alongside hello itself", () => {
    const store = new TimelineStore();
    store.apply({ type: "hello", hello, packageMismatch: "Connected to `com.example.shop`, but ..." });
    expect(store.packageMismatch).toBe("Connected to `com.example.shop`, but ...");
  });

  it("is taken from 'init' when the server sends one, and left alone when it does not (reset)", () => {
    const store = new TimelineStore();
    store.apply({ type: "init", hello, packageMismatch: "mismatched at boot" });
    expect(store.packageMismatch).toBe("mismatched at boot");

    // A reset (post-reconnect backfill) carries no packageMismatch field at
    // all in production (timeline.ts's own broadcast) — undefined must not
    // clobber whatever the most recent "hello" already established.
    store.apply({ type: "reset", events: [] });
    expect(store.packageMismatch).toBe("mismatched at boot");
  });

  it("clears when a 'state' message reports anything other than connected — a fact about a hello that is itself going stale", () => {
    const store = new TimelineStore();
    store.apply({ type: "hello", hello, packageMismatch: "mismatched" });
    expect(store.packageMismatch).not.toBeNull();

    store.apply({ type: "state", state: "disconnected" });
    expect(store.packageMismatch).toBeNull();
  });

  it("clears via setConnection too — the path the WebSocket's own 'close' handler uses, not a server message", () => {
    const store = new TimelineStore();
    store.apply({ type: "hello", hello, packageMismatch: "mismatched" });

    store.setConnection("disconnected");
    expect(store.packageMismatch).toBeNull();
  });

  it("a fresh 'hello' with no mismatch clears a previous one", () => {
    const store = new TimelineStore();
    store.apply({ type: "hello", hello, packageMismatch: "mismatched" });
    expect(store.packageMismatch).not.toBeNull();

    store.apply({ type: "hello", hello, packageMismatch: null });
    expect(store.packageMismatch).toBeNull();
  });
});

describe("log folding", () => {
  it("assembles a stack trace onto its parent across a backfill", () => {
    const parent = log("cart sync failed");
    const store = new TimelineStore();
    store.apply({
      type: "init",
      events: [
        parent,
        append(parent.seq, "java.io.IOException: unexpected end of stream"),
        append(parent.seq, "\tat com.example.shop.cart.CartRepository.load(CartRepository.kt:41)"),
      ],
    });

    expect(message(store, parent.seq)).toBe(
      "cart sync failed\n" +
        "java.io.IOException: unexpected end of stream\n" +
        "\tat com.example.shop.cart.CartRepository.load(CartRepository.kt:41)",
    );
  });

  it("keeps the frames of a trace in the order they arrived", () => {
    // Two appends for one parent whose own sequence numbers run backwards.
    // Arrival order is what the device meant; the numbers on them are not.
    const parent = log("boom", 10);
    const store = new TimelineStore();
    store.apply({
      type: "init",
      events: [parent, append(10, "first", 99), append(10, "second", 12)],
    });

    expect(message(store, 10)).toBe("boom\nfirst\nsecond");
  });

  it("folds an append that sits before its parent in the array", () => {
    const store = new TimelineStore();
    store.apply({ type: "init", events: [append(7, "\tat Foo.bar(Foo.kt:9)", 8), log("boom", 7)] });

    expect(message(store, 7)).toBe("boom\n\tat Foo.bar(Foo.kt:9)");
  });

  it("drops an append whose parent has been evicted, without throwing", () => {
    const store = new TimelineStore();
    // Sequence 4 is older than anything still in the buffer.
    expect(() => {
      store.apply({ type: "init", events: [log("later", 9), append(4, "orphan", 10)] });
    }).not.toThrow();

    expect(store.events).toHaveLength(2);
    expect(message(store, 9)).toBe("later");
  });

  it("drops two thousand appends with no parents at all", () => {
    const events: DeviceEvent[] = [];
    for (let i = 0; i < 2_000; i++) events.push(append(-99, "orphan " + i));

    const store = new TimelineStore();
    expect(() => store.apply({ type: "init", events })).not.toThrow();
    expect(store.events).toHaveLength(2_000);
  });

  it("drops an append carrying no sequence at all", () => {
    const store = new TimelineStore();
    const stray: DeviceEvent = { event: "log_append", t: 30, seq: 11, data: { text: "orphan" } };
    store.apply({ type: "init", events: [log("boom", 10), stray] });

    expect(message(store, 10)).toBe("boom");
  });

  it("does not duplicate lines when a reset follows an init over the same buffer", () => {
    const parent = log("boom");
    const events = [parent, append(parent.seq, "\tat Foo.bar(Foo.kt:9)")];

    const store = new TimelineStore();
    store.apply({ type: "init", events });
    store.apply({ type: "reset", events });

    expect(message(store, parent.seq)).toBe("boom\n\tat Foo.bar(Foo.kt:9)");
  });

  it("assembles a trace that arrives in the backfill after a reconnect", () => {
    // What actually happens when the app is reinstalled: the socket drops
    // mid-trace, and the whole buffer comes back as `reset` with the parent and
    // its trace lines together — freshly parsed, so nothing is marked applied.
    const store = new TimelineStore();
    store.apply({ type: "init", events: [log("cart sync failed", 40)], state: "connected" });
    store.setConnection("disconnected");

    store.apply({
      type: "reset",
      state: "connected",
      events: [
        log("cart sync failed", 40),
        append(40, "java.io.IOException: unexpected end of stream", 41),
        append(40, "\tat com.example.shop.cart.CartRepository.load(CartRepository.kt:41)", 42),
      ],
    });

    expect(store.connection).toBe("connected");
    expect(message(store, 40)).toBe(
      "cart sync failed\n" +
        "java.io.IOException: unexpected end of stream\n" +
        "\tat com.example.shop.cart.CartRepository.load(CartRepository.kt:41)",
    );
  });

  it("folds an append that arrives live, one event at a time", () => {
    const store = new TimelineStore();
    store.apply({ type: "init", events: [log("boom", 3)] });
    store.apply({ type: "event", event: append(3, "\tat Foo.bar(Foo.kt:9)", 4) });
    store.apply({ type: "event", event: append(3, "\t... 12 more", 5) });

    expect(message(store, 3)).toBe("boom\n\tat Foo.bar(Foo.kt:9)\n\t... 12 more");
  });

  it("drops a live append whose parent is not in the buffer", () => {
    const store = new TimelineStore();
    store.apply({ type: "init", events: [log("boom", 3)] });
    expect(() => {
      store.apply({ type: "event", event: append(999, "orphan", 4) });
    }).not.toThrow();

    expect(message(store, 3)).toBe("boom");
  });

  it("does not re-fold a live append when a later backfill replays it", () => {
    const store = new TimelineStore();
    const parent = log("boom", 3);
    store.apply({ type: "init", events: [parent] });
    const line = append(3, "\tat Foo.bar(Foo.kt:9)", 4);
    store.apply({ type: "event", event: line });
    store.apply({ type: "init", events: [parent, line] });

    expect(message(store, 3)).toBe("boom\n\tat Foo.bar(Foo.kt:9)");
  });
});

describe("folding cost", () => {
  it("folds a full buffer far faster than a scan would", () => {
    // The ticket's case: 20 000 events from a log-heavy app carrying 2 000
    // trace lines, folded on the frame `init` lands. The thing being guarded
    // is that parents are resolved through an index rather than a scan.
    //
    // Measured against a scan run in the same process rather than against a
    // number of milliseconds: the indexed fold takes ~5ms here and took 14.6ms
    // on a GitHub runner, and any absolute bar is either flaky on the slow
    // machine or meaningless on the fast one. The scan is a fixed multiple
    // slower on both, which is the property that matters.
    const events: DeviceEvent[] = [];
    for (let block = 0; block < 1_000; block++) {
      const parent = log("cart sync failed");
      events.push(parent);
      events.push(append(parent.seq, "\tat com.example.shop.cart.CartRepository.load(C.kt:41)"));
      events.push(append(parent.seq, "\tat com.example.shop.cart.CartViewModel.refresh(V.kt:18)"));
      for (let i = 0; i < 17; i++) events.push(i % 2 === 0 ? log("--> GET /cart") : other("frame"));
    }
    expect(events).toHaveLength(20_000);
    expect(events.filter((event) => event.event === "log_append")).toHaveLength(2_000);

    // What the fold would cost without the index: each appended line finding
    // its parent by walking back through the buffer. Timed here so the bar
    // moves with the machine.
    const scanStarted = performance.now();
    let found = 0;
    for (const event of events) {
      if (event.event !== "log_append") continue;
      const parentSeq = event.data.seq;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].seq === parentSeq) {
          found++;
          break;
        }
      }
    }
    const scanMs = performance.now() - scanStarted;
    expect(found).toBe(2_000);

    // Warmed once so the first-call cost of the JIT does not land on the
    // measured run — that alone is worth several milliseconds on a cold runner.
    new TimelineStore().apply({ type: "init", events });

    const store = new TimelineStore();
    const started = performance.now();
    store.apply({ type: "init", events });
    const elapsed = performance.now() - started;

    // Every parent really did get both of its lines; a fold that quietly did
    // nothing would also be fast.
    const assembled = store.events.filter(
      (event) => event.event === "log" && String(event.data.message).includes("CartViewModel"),
    );
    expect(assembled).toHaveLength(1_000);
    // A fold that had regressed to scanning would be at best on par with the
    // scan; the indexed one is several times under it on every machine tried.
    expect(elapsed).toBeLessThan(scanMs / 2);
  });
});

describe("notification", () => {
  it("wakes subscribers once for everything that arrived in a frame", () => {
    const store = new TimelineStore();
    const listener = vi.fn();
    store.subscribe(listener);

    for (let i = 0; i < 50; i++) store.apply({ type: "event", event: other("recompose") });
    expect(listener).not.toHaveBeenCalled();

    runFrame();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getVersion()).toBe(50);
  });

  it("stops calling a listener that unsubscribed", () => {
    const store = new TimelineStore();
    const listener = vi.fn();
    store.subscribe(listener)();

    store.apply({ type: "event", event: other("recompose") });
    runFrame();
    expect(listener).not.toHaveBeenCalled();
  });

  it("empties the buffer on clear and still reports the change", () => {
    const store = new TimelineStore();
    store.apply({ type: "init", events: [log("boom")] });
    const before = store.getVersion();

    store.clear();
    expect(store.events).toEqual([]);
    expect(store.getVersion()).toBeGreaterThan(before);
  });

  it("records a connection change made outside the message stream", () => {
    const store = new TimelineStore();
    store.setConnection("disconnected");
    expect(store.connection).toBe("disconnected");
  });
});
