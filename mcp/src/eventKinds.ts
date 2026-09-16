// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Every value `EventFrame.event` can carry — the runtime's own
 * `EventKinds` object (`runtime/src/main/kotlin/live/gravitylabs/porthole/
 * protocol/Protocol.kt`), mirrored on this side of the wire.
 *
 * This is the one list `timeline`'s `kinds` filter can be asked about (see
 * `index.ts`'s `kinds` zod param, generated from this array so the
 * description text cannot list a kind the filter does not actually accept,
 * or omit one it does) and the one `eventKinds.test.ts` compares against
 * Protocol.kt's own source, so a kind added on only one side of the wire
 * fails a test instead of one side silently not recognising it. Order here
 * is the order the description groups them in: the nine kinds a UI lane
 * already showed before GRA-200, then the rest.
 *
 * Deliberately does NOT include `DeviceCollector`'s own sub-kinds
 * (`profile`, `trimMemory`, `foreground`, …) — those travel inside a
 * `device` event's `data.kind` field, never as `EventFrame.event` itself,
 * so `kinds: ["trimMemory"]` would silently match nothing. `trace.ts`'s
 * `resolveProfile`/`findingsOf` read them by their own literal strings,
 * matching Protocol.kt's separate `DeviceEventKinds` object.
 */
export const EVENT_KINDS = [
  "recompose",
  "state_write",
  "frame",
  "nav",
  "http_start",
  "http_end",
  "db_start",
  "db_end",
  "log",
  "log_append",
  "mark",
  "device",
  "exit",
  "work_start",
  "work_end",
  "blocked",
  "gc",
  "memory",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];
