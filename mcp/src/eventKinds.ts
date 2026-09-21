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
  "strict_violation",
  "startup",
  "leak",
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
export interface KindGroup {
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
  {
    kinds: ["strict_violation"],
    narrated:
      "raw here; `findings` turns one into an entry at `error` (main-thread disk writes and network " +
      "calls), `warning` (leaked closeables/cursors), or `note` (everything else) — only ever for a " +
      "violation whose stack names a frame in the app's own package, so a platform-only violation is " +
      "not a finding at all",
  },
  {
    // GRA-60: one per launch — cold (process fork + Application.onCreate)
    // the first time, warm or hot (no fork, no onCreate) for every
    // relaunch after — see StartupCollector.kt for what each field means.
    kinds: ["startup"],
    narrated:
      "raw here; `findings` turns a slow one into a `startup-slow` entry naming the dominant phase and " +
      "cross-referencing any `db-on-main-thread`/`main-thread-stall` finding that fell inside the " +
      "startup window, and a `startup-not-fully-drawn` note when `Activity.reportFullyDrawn()` " +
      "(caught automatically in a Compose/ComponentActivity app) was never observed",
  },
  {
    // GRA-64: one per leak LeakCanary classified, application or library —
    // see LeakCanaryPorthole.kt for why never one per heap analysis.
    kinds: ["leak"],
    narrated:
      "raw here; `findings` promotes an application leak (an app-code reference holding a dead " +
      "Activity/Fragment/View) to `warning` with the retained size and the head of the reference " +
      "path, and leaves a library leak LeakCanary already classifies as known at `note` — only " +
      "ever emitted once a present LeakCanary is actually hooked, see the `setup` tool's " +
      "`leakcanary` row",
  },
];

/**
 * Refuses to describe a set of groups that silently drops or invents a
 * kind — a clause removed from `groups` without removing its kind from
 * `kinds` (or the reverse) throws here rather than shipping a description
 * that quietly stopped matching the filter it documents. Exported (rather
 * than inlined into [timelineKindsDescription]) so a test can hand it a
 * synthetic, deliberately-broken group list without having to break the
 * real [KIND_GROUPS]/[EVENT_KINDS] to prove the check works at all.
 */
export function validateKindCoverage<K extends string>(
  groups: readonly { kinds: readonly K[] }[],
  kinds: readonly K[],
): void {
  const covered = groups.flatMap((g) => g.kinds);
  const coveredSet = new Set(covered);
  const missing = kinds.filter((k) => !coveredSet.has(k));
  if (missing.length > 0) {
    throw new Error(`timelineKindsDescription() does not narrate: ${missing.join(", ")}`);
  }
  if (covered.length !== coveredSet.size) {
    throw new Error("timelineKindsDescription() lists the same kind in more than one group.");
  }
  const known = new Set(kinds);
  const unknown = covered.filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Error(`timelineKindsDescription() narrates a kind EVENT_KINDS does not have: ${unknown.join(", ")}`);
  }
}

/** Builds `timeline`'s `kinds` param description from [KIND_GROUPS] — see [validateKindCoverage]. */
export function timelineKindsDescription(): string {
  validateKindCoverage(KIND_GROUPS, EVENT_KINDS);
  const clauses = KIND_GROUPS.map(
    (g) => `${g.kinds.map((k) => `\`${k}\``).join("/")} — ${g.narrated}`,
  );
  return "Filter by event kind. " + clauses.join("; ") + ".";
}
