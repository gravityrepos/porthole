// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * GRA-228/GRA-65: the ranking and snippet logic behind the `setup` MCP
 * tool, kept out of `index.ts` on purpose — that file is registration only,
 * this is the part worth testing on its own without a running MCP server.
 *
 * The runtime's `setup` RPC (`Setup.kt`) answers one question per entry:
 * is this library on the classpath, and did anything actually attach a
 * porthole to it. That is already enough for the timeline UI's setup panel
 * (`mcp/ui/src/lib/setup.ts`) to tell an empty lane apart from an
 * unwired integration. What it does not carry is what an *agent* needs to
 * act on that: the exact line to add, and what stays dark without it. This
 * module builds both, plus GRA-65's EM-mandated ranking (a gap that leaves
 * more of the surface dark outranks one that leaves less) and the
 * "everything present is wired" case for an already fully-instrumented
 * project.
 *
 * GRA-65's EM cut the source scan (grepping the project for the
 * `OkHttpClient.Builder` to point at) — a real app has several builders,
 * and guessing which one is wrong more often than it is right. What is
 * left is exactly what the runtime can say with certainty: present or not,
 * wired or not, and — from this module — what wiring it would unlock.
 */

/** Mirrors `protocol/Protocol.kt`'s `SetupEntry`, verbatim off the wire. */
export interface SetupEntry {
  name: string;
  onClasspath: boolean;
  instrumented: boolean;
  hint?: string | null;
}

/**
 * What wiring one integration unlocks, named the way a person reading the
 * tool table would recognise them: timeline lanes (`README.md`'s "What the
 * timeline shows") and MCP tool names.
 *
 * `tools` is not "every tool that could theoretically mention this
 * integration" — it is the tools whose *fields go empty specifically
 * because this integration is unwired*, each traceable to a README claim:
 *
 *  - `inflight` carries `http`/`queries` straight from the interceptor
 *    each integration installs (tool table: "open HTTP calls ..., running
 *    queries").
 *  - `blocking` also depends on the same interceptors — "HTTP is checked
 *    in the interceptor, not the event listener" and "Room's thread is
 *    checked by identity" (the "Main thread blocking" section) both name
 *    the instrumentation point `blocking` reads, the same one `okhttp`/
 *    `ktor`/`room`/`sqlite` install.
 *  - `nav_state` is the back stack itself — nothing to check, it is simply
 *    empty without `registerNavController`.
 *
 * `okhttp`/`ktor` share the `http` lane and `room`/`sqlite` share `db`
 * because either is enough to light the lane up (README: "Instrument HTTP
 * and not the database, or neither" — the *pair* is the independent unit,
 * not either library alone), which is also why they carry the same
 * `unlocks` here rather than a half-credit split.
 */
export interface Unlock {
  lanes: string[];
  tools: string[];
  /** Noun phrase for "nothing to show for ___" in the generated sentence. */
  data: string;
}

const UNLOCKS: Record<string, Unlock> = {
  okhttp: { lanes: ["http"], tools: ["inflight", "blocking"], data: "HTTP calls" },
  ktor: { lanes: ["http"], tools: ["inflight", "blocking"], data: "HTTP calls" },
  room: { lanes: ["db"], tools: ["inflight", "blocking"], data: "queries" },
  sqlite: { lanes: ["db"], tools: ["inflight", "blocking"], data: "queries" },
  navigation: { lanes: ["navigation"], tools: ["nav_state"], data: "the back stack" },
};

/** How a gap's integration name reads in prose. */
const DISPLAY_NAMES: Record<string, string> = {
  okhttp: "OkHttp",
  ktor: "Ktor",
  room: "Room",
  sqlite: "SQLDelight",
  navigation: "Navigation",
};

/**
 * The exact line README.md's "Instrument the clients you care about" and
 * "Register your NavController" steps give for each integration — a
 * CONSTANT per GRA-65's EM note, not regenerated from the runtime's own
 * short `hint` (which names the fix in a sentence fragment, not code an
 * agent can paste). `setup.test.ts` keeps these in sync with README.md by
 * asserting each one, whitespace-collapsed, is a substring of the
 * whitespace-collapsed README — the closest a test gets to "the snippet
 * really is what the docs say" without executing Kotlin.
 */
export const SNIPPETS: Record<string, string> = {
  okhttp: "OkHttpClient.Builder().installPorthole().build()",
  ktor: "HttpClient(CIO) { install(portholeKtor()) }",
  room: 'Room.databaseBuilder(context, AppDb::class.java, "app.db").installPorthole().build()',
  sqlite:
    'AndroidSqliteDriver(schema = Schema, context = context, name = "app.db", factory = portholeSqliteFactory())',
  navigation: "LaunchedEffect(navController) { Porthole.registerNavController(navController) }",
};

/** Lanes + tools an unlock affects — the ranking score (GRA-65 AC1). */
function impact(unlock: Unlock): number {
  return unlock.lanes.length + unlock.tools.length;
}

function sentence(displayName: string, unlock: Unlock): string {
  const lanes = unlock.lanes.map((lane) => `${lane} lane`).join(" and ");
  const tools = unlock.tools.map((tool) => `\`${tool}\``).join(" and ");
  const have = unlock.tools.length > 1 ? "have" : "has";
  return (
    `Nothing is instrumented on ${displayName}, so the ${lanes} is empty and ${tools} ` +
    `${have} nothing to show for ${unlock.data}.`
  );
}

/** One present-but-unwired integration, ranked and ready for an agent to act on. */
export interface Gap {
  name: string;
  displayName: string;
  /** The runtime's own short hint, passed through verbatim (may be null). */
  hint: string | null;
  /** The exact line to add — `SNIPPETS[name]`. */
  add: string;
  lanes: string[];
  tools: string[];
  sentence: string;
}

export interface SetupReport {
  /** Every entry the runtime reported, untouched — including `socket` and `strictmode`. */
  entries: SetupEntry[];
  /** Present-but-unwired integrations this module knows a snippet for, ranked by impact (GRA-65 AC1). */
  gaps: Gap[];
  /** Integrations this module knows about that are present *and* wired. */
  wired: string[];
  summary: string;
}

/**
 * Builds the `setup` tool's payload and summary from the runtime's raw
 * `setup` RPC result.
 *
 * Only entries this module has an `UNLOCKS`/`SNIPPETS` mapping for are
 * ranked or given a snippet — `socket` and `strictmode` are not
 * "integrations" in `Setup.kt`'s own sense (see its module doc comment:
 * one is the bind result, the other an opt-in policy toggle, neither has a
 * builder line to add), so they pass through in `entries` only, exactly as
 * the UI's setup panel shows them, with no fabricated `add`/`unlocks` for
 * something that was never a wiring gap. That is also why a gap here
 * always outranks a bare, unnamed note like `strictmode`'s: only a
 * mapped entry contributes to `gaps` and its ranking at all.
 */
export function buildSetupReport(entries: SetupEntry[]): SetupReport {
  const present = entries.filter((entry) => entry.name in UNLOCKS && entry.onClasspath);

  const gaps: Gap[] = present
    .filter((entry) => !entry.instrumented)
    .map((entry) => {
      const unlock = UNLOCKS[entry.name];
      const displayName = DISPLAY_NAMES[entry.name];
      return {
        name: entry.name,
        displayName,
        hint: entry.hint ?? null,
        add: SNIPPETS[entry.name],
        lanes: unlock.lanes,
        tools: unlock.tools,
        sentence: sentence(displayName, unlock),
      };
    })
    // Stable sort (V8/Node guarantee it since ES2019): ties — every pair
    // sharing a lane today has equal impact — keep `UNLOCKS`' own
    // declaration order rather than an arbitrary one that could reorder
    // between runs.
    .sort((a, b) => impact(UNLOCKS[b.name]) - impact(UNLOCKS[a.name]));

  const wired = present.filter((entry) => entry.instrumented).map((entry) => entry.name);

  const summary = buildSummary(gaps, wired, present.length > 0);

  return { entries, gaps, wired, summary };
}

function buildSummary(gaps: Gap[], wired: string[], anyPresent: boolean): string {
  if (gaps.length > 0) {
    const lead = gaps[0].sentence;
    const rest =
      gaps.length > 1
        ? ` ${gaps.length - 1} more present but unwired: ${gaps
            .slice(1)
            .map((g) => g.displayName)
            .join(", ")}.`
        : "";
    const wiredNote = wired.length > 0 ? ` Already wired: ${wired.join(", ")}.` : "";
    return lead + rest + wiredNote;
  }
  if (anyPresent) {
    return `Everything present is wired: ${wired.join(", ")}.`;
  }
  return "No instrumentable integration (OkHttp, Ktor, Room, SQLDelight, Navigation) is on the classpath yet.";
}
