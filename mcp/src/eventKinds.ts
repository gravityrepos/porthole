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

/**
 * One clause of `timeline`'s `kinds` description: which of [EVENT_KINDS]
 * this covers, and one sentence saying where each is narrated — GRA-200's
 * own requirement, so an agent reading the tool's schema does not have to
 * call `timeline` once per kind to discover that `exit` is better read from
 * `porthole_status` or that `device` is mostly raw but its startup profile
 * feeds two other tools' numbers.
 */
interface KindGroup {
  kinds: readonly EventKind[];
  /** One clause, no leading capital, no trailing period — joined below. */
  narrated: string;
}

const KIND_GROUPS: readonly KindGroup[] = [
  {
    kinds: ["exit"],
    narrated:
      "narrated in `porthole_status` (its `exits` list and `exitTrace` RPC); `findings`' own " +
      "`alsoInWindow` block also inventories every exit in the window it examined, including the " +
      "ones that did not cross a severity worth a finding on their own",
  },
  {
    kinds: ["memory", "gc"],
    narrated:
      "raw here; `gc` becomes a `findings` entry only when a collection blocks the app, and a " +
      "device's `trimMemory` sub-kind (below) becomes one whenever the system actually asks for " +
      "memory back — `memory`'s own periodic samples never do, and stay raw everywhere but " +
      "`findings`' `alsoInWindow` count",
  },
  {
    kinds: ["device"],
    narrated:
      "raw here; its one-time startup profile sub-kind is what `findings` and `frames` read their " +
      "frame budget from, and its other sub-kinds cover lifecycle changes (`foreground`/" +
      "`background`), rotation, theme, font scale, power and network — see `DeviceEventKinds` in " +
      "Protocol.kt for the full set",
  },
  {
    kinds: [
      "recompose",
      "state_write",
      "frame",
      "nav",
      "http_start",
      "http_end",
      "db_start",
      "db_end",
      "log",
    ],
    narrated: "raw here, as before",
  },
  {
    kinds: ["log_append", "mark", "work_start", "work_end", "blocked"],
    narrated: "raw here",
  },
];

/**
 * Builds `timeline`'s `kinds` param description from [KIND_GROUPS], and
 * refuses to build one that silently drops or invents a kind — a clause
 * removed from [KIND_GROUPS] without removing its kind from [EVENT_KINDS]
 * (or the reverse) throws here rather than shipping a description that
 * quietly stopped matching the filter it documents.
 */
export function timelineKindsDescription(): string {
  const covered = KIND_GROUPS.flatMap((g) => g.kinds);
  const coveredSet = new Set(covered);
  const missing = EVENT_KINDS.filter((k) => !coveredSet.has(k));
  if (missing.length > 0) {
    throw new Error(`timelineKindsDescription() does not narrate: ${missing.join(", ")}`);
  }
  if (covered.length !== coveredSet.size) {
    throw new Error("timelineKindsDescription() lists the same kind in more than one group.");
  }
  const known = new Set<string>(EVENT_KINDS);
  const unknown = covered.filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Error(`timelineKindsDescription() narrates a kind EVENT_KINDS does not have: ${unknown.join(", ")}`);
  }

  const clauses = KIND_GROUPS.map(
    (g) => `${g.kinds.map((k) => `\`${k}\``).join("/")} — ${g.narrated}`,
  );
  return "Filter by event kind. " + clauses.join("; ") + ".";
}
