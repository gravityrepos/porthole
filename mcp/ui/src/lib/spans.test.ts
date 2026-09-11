// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { buildSpans, isYours, shortUrl } from "./spans";
import type { DeviceEvent } from "../types";

function event(name: string, t: number, data: Record<string, unknown> = {}): DeviceEvent {
  return { event: name, t, seq: t, data };
}

describe("buildSpans", () => {
  it("pairs a start with its end by id", () => {
    const spans = buildSpans(
      [
        event("http_start", 100, { id: "http-1", method: "GET" }),
        event("http_end", 400, { id: "http-1", status: 200 }),
      ],
      "http",
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ id: "http-1", start: 100, end: 400, open: false });
    // The end's fields win, but the start's survive alongside them.
    expect(spans[0].data).toMatchObject({ method: "GET", status: 200 });
  });

  it("keeps interleaved calls apart rather than pairing by order", () => {
    const spans = buildSpans(
      [
        event("http_start", 0, { id: "a" }),
        event("http_start", 10, { id: "b" }),
        event("http_end", 20, { id: "b" }),
        event("http_end", 30, { id: "a" }),
      ],
      "http",
    );

    expect(spans.map((span) => [span.id, span.start, span.end])).toEqual([
      ["a", 0, 30],
      ["b", 10, 20],
    ]);
  });

  it("runs an unfinished span to the newest event and marks it open", () => {
    const spans = buildSpans(
      [event("http_start", 100, { id: "open-1" }), event("log", 900, {})],
      "http",
    );

    expect(spans[0]).toMatchObject({ open: true, start: 100, end: 900 });
  });

  it("reconstructs a start time from elapsedMs when the start was evicted", () => {
    const spans = buildSpans([event("db_end", 500, { id: "db-9", elapsedMs: 120 })], "db");

    expect(spans[0]).toMatchObject({ start: 380, end: 500, open: false });
  });

  it("ignores other lanes sharing the event stream", () => {
    const events = [
      event("db_start", 0, { id: "db-1" }),
      event("db_end", 5, { id: "db-1" }),
      event("http_start", 1, { id: "http-1" }),
      event("http_end", 9, { id: "http-1" }),
    ];

    expect(buildSpans(events, "http").map((span) => span.id)).toEqual(["http-1"]);
    expect(buildSpans(events, "db").map((span) => span.id)).toEqual(["db-1"]);
  });
});

describe("isYours", () => {
  it("counts a write with a named key", () => {
    expect(isYours(event("state_write", 0, { named: ["CartViewModel.tick"] }))).toBe(true);
  });

  it("counts an anonymous write that carries one of your own types", () => {
    expect(isYours(event("state_write", 0, { named: [], yours: ["com.example.Cart"] }))).toBe(true);
  });

  it("does not count a write that is neither", () => {
    expect(isYours(event("state_write", 0, { named: [], yours: [], unnamed: 3 }))).toBe(false);
  });
});

describe("shortUrl", () => {
  it("keeps the path and marks a dropped query", () => {
    expect(shortUrl("http://localhost:4000/v1/carts/99001?include=items")).toBe(
      "/v1/carts/99001?…",
    );
  });

  it("keeps the path alone when there is no query", () => {
    expect(shortUrl("https://api.example.com/v1/checkout")).toBe("/v1/checkout");
  });

  it("hands back anything it cannot parse", () => {
    expect(shortUrl("not a url")).toBe("not a url");
  });
});
