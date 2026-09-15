// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { fieldsFor, groupFields, rawText, type FieldableHit } from "./fields";
import { LANES } from "../timeline/lanes";
import type { DeviceEvent, Span } from "../types";

const lane = (key: string) => LANES.find((entry) => entry.key === key)!;

function eventHit(name: string, data: Record<string, unknown>, laneKey = name): FieldableHit {
  const event: DeviceEvent = { event: name, t: 0, seq: 1, data };
  return { kind: "event", lane: lane(laneKey), event };
}

function spanHit(laneKey: string, data: Record<string, unknown>, start = 0, end = 100): FieldableHit {
  const span: Span = { id: "x", start, end, open: false, data };
  return { kind: "span", lane: lane(laneKey), span };
}

const labels = (hit: FieldableHit) => fieldsFor(hit).map((field) => field.label);
const find = (hit: FieldableHit, key: string) => fieldsFor(hit).find((field) => field.key === key);

describe("fieldsFor ordering", () => {
  it("puts a known kind in its declared order", () => {
    const hit = spanHit("http", {
      status: 201,
      url: "http://h/v1/x",
      method: "POST",
      phase: "done",
    });
    expect(labels(hit)).toEqual(["method", "url", "status", "duration", "phase"]);
  });

  it("appends a field the runtime added but the UI does not know", () => {
    const hit = eventHit("nav", { route: "cart", depth: 2, somethingNew: "yes" });
    expect(labels(hit)).toEqual(["route", "depth", "somethingNew"]);
  });

  it("drops identifiers that belong in raw rather than the summary", () => {
    const hit = eventHit("nav", { route: "cart", id: "nav-1", seq: 4 });
    expect(labels(hit)).toEqual(["route"]);
  });

  it("omits empty and absent values instead of rendering blanks", () => {
    const hit = eventHit("nav", { route: "cart", deepLink: "", extra: undefined });
    expect(labels(hit)).toEqual(["route"]);
  });
});

describe("fieldsFor redundancy", () => {
  it("drops elapsedMs when the span already measured its own duration", () => {
    const hit = spanHit("db", { sql: "SELECT 1", elapsedMs: 3 }, 0, 42);
    const duration = find(hit, "durationMs");
    expect(duration).toMatchObject({ shape: "inline", value: "42ms" });
    expect(find(hit, "elapsedMs")).toBeUndefined();
  });

  it("drops top when the stack it came from is present", () => {
    const hit = eventHit("blocked", {
      durationMs: 120,
      top: "a.B.c(B.kt:1)",
      stack: "a.B.c(B.kt:1)\na.B.d(B.kt:2)",
    });
    expect(find(hit, "top")).toBeUndefined();
    expect(find(hit, "stack")).toBeDefined();
  });

  it("keeps top when there is no stack to replace it", () => {
    const hit = eventHit("blocked", { durationMs: 120, top: "a.B.c(B.kt:1)" });
    expect(find(hit, "top")).toBeDefined();
  });
});

describe("fieldsFor shapes", () => {
  it("parses a navigation bundle into key/value pairs", () => {
    const field = find(eventHit("nav", { route: "cart", args: "{cartId=88123}" }), "args");
    expect(field).toMatchObject({ shape: "pairs", pairs: [["cartId", "88123"]] });
  });

  it("keeps an equals sign inside a bundle value", () => {
    const field = find(eventHit("nav", { route: "r", args: "{token=a=b}" }), "args");
    expect(field).toMatchObject({ pairs: [["token", "a=b"]] });
  });

  it("treats positional query arguments as a list, not pairs", () => {
    const field = find(spanHit("db", { sql: "SELECT 1", args: "99001, Mug, 3" }), "args");
    expect(field).toMatchObject({ shape: "chips", items: ["99001", "Mug", "3"] });
  });

  it("drops an empty bundle rather than showing an empty table", () => {
    expect(find(eventHit("nav", { route: "r", args: "{}" }), "args")).toBeUndefined();
  });

  it("pretty-prints a JSON body and leaves a non-JSON one alone", () => {
    const hit = spanHit("http", { requestBody: '{"a":1}', responseBody: "not json" });
    expect(find(hit, "requestBody")).toMatchObject({
      shape: "block",
      label: "request",
      value: '{\n  "a": 1\n}',
    });
    expect(find(hit, "responseBody")).toMatchObject({ value: "not json" });
  });

  it("renders string arrays as chips and skips empty ones", () => {
    const hit = eventHit("state_write", { named: ["A.b"], yours: [], unnamed: 0 });
    expect(find(hit, "named")).toMatchObject({ shape: "chips", items: ["A.b"] });
    expect(find(hit, "yours")).toBeUndefined();
  });
});

describe("fieldsFor tone", () => {
  it("colours an http status by its class", () => {
    const tone = (status: number) => find(spanHit("http", { status }), "status");
    expect(tone(200)).toMatchObject({ value: "200", tone: "good" });
    expect(tone(301)).toMatchObject({ tone: "warn" });
    expect(tone(402)).toMatchObject({ tone: "bad" });
    expect(tone(0)).toMatchObject({ value: "in flight", tone: "warn" });
  });

  it("names a log level and colours the serious ones", () => {
    const level = (value: string) => find(eventHit("log", { level: value }), "level");
    expect(level("W")).toMatchObject({ value: "warn", tone: "warn" });
    expect(level("E")).toMatchObject({ value: "error", tone: "bad" });
    expect(level("I")).toMatchObject({ value: "info", tone: "plain" });
  });

  it("flags a query that ran on the main thread", () => {
    const hit = eventHit("db_end", { onMainThread: true, kind: "read" }, "db");
    expect(find(hit, "onMainThread")).toMatchObject({ value: "main thread", tone: "bad" });
  });

  it("says nothing about a query that did not", () => {
    const hit = eventHit("db_end", { onMainThread: false, kind: "read" }, "db");
    expect(find(hit, "onMainThread")).toBeUndefined();
  });

  it("leaves durations neutral, because slow is a judgement", () => {
    const hit = spanHit("http", { status: 200 }, 0, 9000);
    expect(find(hit, "durationMs")).toMatchObject({ value: "9000ms", tone: "plain" });
  });

  it("counts a dropped frame as bad and a clean one as plain", () => {
    expect(find(eventHit("frame", { missedFrames: 3 }), "missedFrames")).toMatchObject({
      value: "3 frames",
      tone: "bad",
    });
    expect(find(eventHit("frame", { missedFrames: 0 }), "missedFrames")).toMatchObject({
      value: "0 frames",
      tone: "plain",
    });
  });
});

describe("groupFields", () => {
  it("lifts the url out of an http call and leaves bodies at the bottom", () => {
    const hit = spanHit("http", {
      method: "POST",
      url: "http://h/v1/x",
      status: 201,
      requestBody: "{}",
    });
    const { subject, attributes, payloads } = groupFields(hit);

    expect(subject?.key).toBe("url");
    expect(attributes.map((field) => field.key)).toEqual(["method", "status", "durationMs"]);
    expect(payloads.map((field) => field.key)).toEqual(["requestBody"]);
  });

  it("lifts the sql out of a query", () => {
    expect(groupFields(spanHit("db", { sql: "SELECT 1", kind: "read" })).subject?.key).toBe("sql");
  });

  it("has no subject for a kind that does not declare one", () => {
    const { subject, attributes } = groupFields(eventHit("nav", { route: "cart", depth: 1 }));
    expect(subject).toBeNull();
    expect(attributes.map((field) => field.key)).toEqual(["route", "depth"]);
  });
});

describe("rawText", () => {
  it("shows everything the device sent, including what the summary hides", () => {
    const text = rawText(spanHit("db", { id: "db-1", sql: "SELECT 1", elapsedMs: 3 }, 0, 42));
    expect(text).toContain("id: db-1");
    expect(text).toContain("elapsedMs: 3");
    expect(text).toContain("durationMs: 42");
  });

  it("indents a multi-line value under its key", () => {
    const text = rawText(eventHit("log", { message: "line one\nline two" }));
    expect(text).toBe("message:\n  line one\n  line two");
  });
});
