// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { resolveProjectRoot } from "./adb.js";
import { whereForName, type Where } from "./sources.js";

/**
 * GRA-69: joins a recomposition count against what the Compose compiler
 * already knows.
 *
 * `recompose-hotspot` (trace.ts) has always been able to say a composable
 * recomposed a lot and, loosely, what state it recomposed near — "ordering,
 * not proof", in its own words. It has never been able to say *why* that is
 * a problem worth fixing, because nothing about a device-side event stream
 * can prove a composable is not skippable — that is a fact about the
 * compiled code, not about anything that happened at runtime. The Compose
 * compiler already computes it (`composeCompiler { reportsDestination }`,
 * enabled by the Gradle plugin's `portholeComposeReport` task — see
 * `ComposeCompilerWiring.kt` and `ComposeReportTask.kt`) and writes it to
 * `<module>/build/porthole/compose-report.json`. This module reads that
 * file and answers the one question `trace.ts` and `index.ts` cannot answer
 * on their own: is the composable this device saw recompose 900 times the
 * same one the compiler is talking about, and if so, what did it say.
 *
 * **The join's crux.** `recompose` events carry the string literal a
 * developer gave `PortholeScreen`/`Modifier.portholeNode`
 * (`PortholeCompose.kt`, GRA-201's own doc comment on `sources.ts` explains
 * why that string, not a Kotlin symbol, is what gets reported) —
 * `"Cart.ItemRow"`, not `LeakyRow`. The compose compiler's report, by
 * contrast, is keyed by the enclosing Kotlin function's own name — `
 * LeakyRow`, never having heard of the string literal inside it. Three ways
 * to bridge that were on the table (GRA-69's own open question 3):
 *
 *  (a) have the runtime capture the enclosing function at the call site —
 *      rejected: nothing cheap identifies "the @Composable fun this call is
 *      textually inside" from inside a running composition; the nearest
 *      approximation (a stack walk off `currentCompositeKeyHash`) is
 *      expensive per the ticket's own framing, and would have to run on
 *      every recomposition, not once per lookup.
 *  (b) **(chosen)** reuse GRA-201's own source index: `whereForName(label)`
 *      already resolves the label to the `{path, line}` where
 *      `portholeNode("Cart.ItemRow")` textually appears — that already-built
 *      index is the expensive part, and it is not paid twice. From there,
 *      [enclosingFunctionName] reads that one file and finds the nearest
 *      `fun` declaration at or before that line, with the same tolerant,
 *      one-regex-per-line philosophy `sources.ts`'s own name index uses
 *      rather than a real parser (GRA-201 precedent, not a new decision).
 *  (c) require the label to equal the function name — rejected outright:
 *      every label already in this codebase's own sample
 *      (`Cart.ItemRow`, `Cart.PromoField`) fails that test, so the rule
 *      would join almost nothing in the one app available to prove it
 *      against.
 *
 * **What does and does not join.** (b) resolves cleanly when
 * `whereForName` resolves to exactly one file (GRA-201's own "never guess"
 * rule already refuses ambiguity there) *and* the nearest preceding `fun`
 * line is unambiguous *and* that function's simple name appears in exactly
 * one loaded report's `composables` list, narrowed by package when more
 * than one candidate shares a name (same package-narrowing discipline
 * `sources.ts` already applies — see `narrowToOne` below). Every other
 * outcome — the label does not resolve, no `fun` line precedes it, the
 * name is not in any report, the name is in more than one report and
 * narrowing does not land on exactly one — is `matched: false`, with a
 * `reason` and, where there is more than one thing it could have been, the
 * `candidates` themselves. Nothing here ever guesses: an unmatched node
 * says so, in those words, rather than picking the alphabetically-first
 * same-named function and being wrong under everyone's nose.
 *
 * **Staleness.** A report is only ever joined against when its own
 * `sourceFingerprint` (written by `PortholeComposeReportTask` — see that
 * file's KDoc, "Staleness", for exactly what it hashes and why) matches a
 * fingerprint recomputed, the same way, over the live tree right now. A
 * report built five minutes ago against source that has since changed is
 * refused, not joined — see [staleness] — because a join against code that
 * no longer exists is worse than no join at all: it would name a parameter
 * that may have already been fixed.
 *
 * **Multi-module.** `PORTHOLE_PROJECT_ROOT` is a Gradle root, and a Gradle
 * root can have any number of Android modules, each with its own
 * `build/porthole/compose-report.json` (GRA-69's own open question 4). This
 * finds every one of them under the root (bounded to `build/porthole/`
 * itself, never recursing further into a build directory — see
 * [findComposeReportPaths]) and joins against the union: a composable
 * declared in a library module is exactly as joinable as one in the app
 * module, and a same-named composable in two different modules is exactly
 * the ambiguous case `narrowToOne` already refuses to guess between. The
 * alternative on the table — a single path written into `.mcp.json`'s env
 * by the plugin — was not taken: it would need a *second* plugin task
 * output (which module's report is "the" one, in a build where more than
 * one module has Compose UI) for no real gain over a bounded directory
 * search that already has to exist for the single-module case anyway.
 */

export interface ComposeReportParameter {
  name: string;
  type: string;
  stable: boolean;
  unused: boolean;
}

export interface ComposeReportComposable {
  name: string;
  packageName: string | null;
  restartable: boolean;
  skippable: boolean;
  parameters: ComposeReportParameter[];
}

export interface ComposeReportProperty {
  name: string;
  mutable: boolean;
  stable: boolean;
  type: string;
}

export interface ComposeReportClass {
  name: string;
  stable: boolean;
  runtimeStability: string | null;
  properties: ComposeReportProperty[];
}

export interface ComposeReportFile {
  /** Absolute path to the `compose-report.json` itself — for prose, and for re-reading on demand. */
  reportPath: string;
  /** The module directory the report was generated for — `dirname(dirname(dirname(reportPath)))`, i.e. one level above `build/`. */
  moduleRoot: string;
  generatedAt: string;
  variant: string;
  module: string;
  kotlinVersion: string;
  gitHead: string | null;
  sourceFingerprint: string;
  composables: ComposeReportComposable[];
  classes: ComposeReportClass[];
}

/**
 * Directories a report search never descends into. Unlike `sources.ts`'s
 * walk, `build` is not skipped wholesale here — the report this module is
 * looking for lives inside one — but nothing is ever read from *inside* a
 * `build` directory beyond the one candidate path checked; see
 * [findComposeReportPaths].
 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".idea"]);

/** How many directories deep a report search will look — a build root's own modules, not an unbounded disk walk. */
const MAX_SEARCH_DEPTH = 8;

/**
 * Finds every `build/porthole/compose-report.json` under [root] — one per
 * module that has run `portholeComposeReport` at least once since its last
 * `clean`. A `build` directory is recognised and checked (one path,
 * `<dir>/porthole/compose-report.json`) but never recursed into any
 * further — Gradle's own build output under it is enormous and none of it
 * is what this is looking for.
 */
export function findComposeReportPaths(root: string): string[] {
  const found: string[] = [];

  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_SEARCH_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "build") {
        const candidate = path.join(full, "porthole", "compose-report.json");
        if (existsSync(candidate)) found.push(candidate);
        continue; // never recurse into build/ any further
      }
      visit(full, depth + 1);
    }
  };

  visit(root, 0);
  return found;
}

/**
 * Loads and minimally shape-checks one report file. Tolerant, not
 * validating (same stance `trace.ts`'s own `TRACE_VERSION` comment takes on
 * the trace file it reads): a field this reads as the wrong type is treated
 * as absent rather than thrown over, since this is this repo's own Gradle
 * plugin's output, not developer-authored JSON that could be anything.
 * Returns `null` on anything unreadable or unparseable.
 */
function loadReport(reportPath: string): ComposeReportFile | null {
  let text: string;
  try {
    text = readFileSync(reportPath, "utf8");
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.sourceFingerprint !== "string" || !Array.isArray(r.composables) || !Array.isArray(r.classes)) {
    return null;
  }
  // build/porthole/compose-report.json -> build/porthole -> build -> module root
  const moduleRoot = path.dirname(path.dirname(path.dirname(reportPath)));
  return {
    reportPath,
    moduleRoot,
    generatedAt: typeof r.generatedAt === "string" ? r.generatedAt : "",
    variant: typeof r.variant === "string" ? r.variant : "",
    module: typeof r.module === "string" ? r.module : "",
    kotlinVersion: typeof r.kotlinVersion === "string" ? r.kotlinVersion : "",
    gitHead: typeof r.gitHead === "string" ? r.gitHead : null,
    sourceFingerprint: r.sourceFingerprint,
    composables: r.composables as ComposeReportComposable[],
    classes: r.classes as ComposeReportClass[],
  };
}

/**
 * How long a discovered report list is trusted before the next call re-walks
 * — the same TTL reasoning `sources.ts`'s own cache comment gives, applied
 * to the same usage pattern (a burst of tool calls seconds apart).
 */
const CACHE_TTL_MS = 5_000;
let clock: () => number = Date.now;
let cached: { root: string; builtAt: number; reports: ComposeReportFile[] } | null = null;

/** Test-only: a fake clock, matching `sources.ts`'s own `setClockForTests`. */
export function setComposeReportClockForTests(fn: (() => number) | null): void {
  clock = fn ?? Date.now;
}

/** Test-only: forces the next call to re-discover reports rather than reusing a cached list. */
export function resetComposeReportCacheForTests(): void {
  cached = null;
}

function discoverReports(root: string): ComposeReportFile[] {
  if (cached && cached.root === root && clock() - cached.builtAt < CACHE_TTL_MS) return cached.reports;
  const reports = findComposeReportPaths(root)
    .map(loadReport)
    .filter((r): r is ComposeReportFile => r !== null);
  cached = { root, builtAt: clock(), reports };
  return reports;
}

// ---------------------------------------------------------------------------
// staleness
// ---------------------------------------------------------------------------

/**
 * The exact same hash [PortholeComposeReportTask.kt]'s `sourceFingerprint`
 * computes on the Gradle side — SHA-256 over every `.kt` file under
 * `<moduleRoot>/src`, sorted by path relative to `moduleRoot`, each entry
 * feeding (path bytes, a `0` separator byte, file content bytes) into the
 * digest in that order. Has to match bit for bit or every report would read
 * as stale the instant it was written; the Kotlin and TypeScript
 * implementations are only provably the same algorithm by being tested
 * against the same fixture inputs — see `composeReport.test.ts`.
 */
export function currentSourceFingerprint(moduleRoot: string): string {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith(".kt")) files.push(full);
    }
  };
  const srcDir = path.join(moduleRoot, "src");
  if (existsSync(srcDir)) visit(srcDir);

  const relPaths = files
    .map((f) => path.relative(moduleRoot, f).split(path.sep).join("/"))
    .sort();
  const hash = createHash("sha256");
  for (const rel of relPaths) {
    const full = path.join(moduleRoot, ...rel.split("/"));
    hash.update(Buffer.from(rel, "utf8"));
    hash.update(Buffer.from([0]));
    try {
      hash.update(readFileSync(full));
    } catch {
      // removed between listing and reading — the Gradle side has no
      // equivalent race (it reads what Gradle already snapshotted as task
      // inputs), so this can only make the two fingerprints disagree in
      // the safe direction: reported as stale, never as falsely fresh.
    }
  }
  return hash.digest("hex");
}

export interface Staleness {
  stale: boolean;
  /** The report's own recorded fingerprint. */
  reportFingerprint: string;
  /** Recomputed over the live tree just now. Equal to `reportFingerprint` exactly when `stale` is false. */
  currentFingerprint: string;
  generatedAt: string;
  gitHead: string | null;
}

export function staleness(report: ComposeReportFile): Staleness {
  const currentFingerprint = currentSourceFingerprint(report.moduleRoot);
  return {
    stale: currentFingerprint !== report.sourceFingerprint,
    reportFingerprint: report.sourceFingerprint,
    currentFingerprint,
    generatedAt: report.generatedAt,
    gitHead: report.gitHead,
  };
}

// ---------------------------------------------------------------------------
// the join
// ---------------------------------------------------------------------------

/** `^\s*package\s+([\w.]+)` — same convention `sources.ts`'s own `packageOf` reads, duplicated rather than imported since that one is private to the source-index cache it belongs to. */
const PACKAGE_DECLARATION = /^\s*package\s+([\w.]+)/m;

/** Same tolerant one-line `fun` regex `sources.ts`'s own name index uses (see that module's `FUNCTION` constant) — kept as its own copy rather than exported and shared, since the two look for slightly different things: this one only cares about the *nearest preceding* match, `sources.ts`'s builds a whole-file index. */
const FUNCTION_DECL = /\bfun\s+(?:<[^>]*>\s*)?(?:[A-Za-z_][A-Za-z0-9_.<>]*\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

/**
 * The simple name of the `@Composable fun` a `portholeNode`/`PortholeScreen`
 * call at `filePath:line` textually sits inside — the nearest `fun`
 * declaration at or before that line. Not a real parser: a regex scan
 * upward, same tolerance `sources.ts`'s whole module is built on. Returns
 * `null` when the file cannot be read or no `fun` line precedes the given
 * line at all (a label at the very top of a file, or a malformed line
 * number).
 */
export function enclosingFunctionName(root: string, filePath: string, line: number): string | null {
  let text: string;
  try {
    text = readFileSync(path.join(root, ...filePath.split("/")), "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const match = FUNCTION_DECL.exec(lines[i]);
    if (match) return match[1];
  }
  return null;
}

/** Same convention `sources.ts`'s `packageOf` uses, applied here to the one file the join already read. */
function packageOfFile(root: string, filePath: string): string | null {
  try {
    const text = readFileSync(path.join(root, ...filePath.split("/")), "utf8");
    const match = PACKAGE_DECLARATION.exec(text);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** One report's composable plus which report it came from, for a candidate list spanning modules. */
interface Candidate {
  report: ComposeReportFile;
  composable: ComposeReportComposable;
}

/**
 * Same "narrow or refuse, never guess" rule `sources.ts`'s own
 * `narrowByPackage` follows: filters to the candidates declared under
 * `packageName` (when known) and returns the single survivor, or `null` on
 * zero or more than one — the caller falls back to reporting every
 * *unfiltered* candidate as ambiguous, exactly as `sources.ts` does.
 */
function narrowToOne(candidates: Candidate[], packageName: string | null): Candidate | null {
  if (candidates.length === 1) return candidates[0];
  if (!packageName) return null;
  const filtered = candidates.filter((c) => c.composable.packageName === packageName);
  return filtered.length === 1 ? filtered[0] : null;
}

export type ComposeJoinReason =
  | "no report found under the project root"
  | "source resolution is off (PORTHOLE_PROJECT_ROOT is unset)"
  | "the node's label did not resolve to a source location"
  | "no function declaration was found enclosing that location"
  | "no report entry matched"
  | "matched more than one report entry";

export type ComposeJoin =
  | {
      matched: true;
      enclosingFunction: string;
      composable: ComposeReportComposable;
      report: ComposeReportFile;
      stale: false;
    }
  | {
      matched: true;
      enclosingFunction: string;
      composable: ComposeReportComposable;
      report: ComposeReportFile;
      /** The matching entry exists, but its report's own source state has moved on — see `staleness`. Never used to build a finding's prose; see `explainInstability`'s own guard. */
      stale: true;
      staleness: Staleness;
    }
  | {
      matched: false;
      reason: ComposeJoinReason;
      /** Every same-named composable this could have been, when there was more than one — present only for the two "more than one" reasons. */
      candidates?: Array<{ module: string; packageName: string | null }>;
      where?: Where;
    };

/**
 * The one entry point `trace.ts` and `index.ts` both call. `nodeName` is a
 * recomposition's own `name` field — the `portholeNode`/`PortholeScreen`
 * label — never a Kotlin symbol. See this module's own doc comment for the
 * full join strategy and what does and does not match.
 */
export function joinComposableNode(nodeName: string): ComposeJoin {
  const resolved = resolveProjectRoot();
  if (resolved.source !== "PORTHOLE_PROJECT_ROOT") {
    return { matched: false, reason: "source resolution is off (PORTHOLE_PROJECT_ROOT is unset)" };
  }
  const root = resolved.directory;

  const where = whereForName(nodeName);
  if (!where || !where.resolved) {
    return { matched: false, reason: "the node's label did not resolve to a source location", where };
  }

  const fn = enclosingFunctionName(root, where.path, where.line ?? 1);
  if (!fn) {
    return { matched: false, reason: "no function declaration was found enclosing that location" };
  }

  const reports = discoverReports(root);
  if (reports.length === 0) {
    return { matched: false, reason: "no report found under the project root" };
  }

  const candidates: Candidate[] = [];
  for (const report of reports) {
    for (const composable of report.composables) {
      if (composable.name === fn) candidates.push({ report, composable });
    }
  }
  if (candidates.length === 0) {
    return { matched: false, reason: "no report entry matched" };
  }

  const packageName = packageOfFile(root, where.path);
  const chosen = narrowToOne(candidates, packageName);
  if (!chosen) {
    return {
      matched: false,
      reason: "matched more than one report entry",
      candidates: candidates.map((c) => ({ module: c.report.module, packageName: c.composable.packageName })),
    };
  }

  const staleCheck = staleness(chosen.report);
  if (staleCheck.stale) {
    return {
      matched: true,
      enclosingFunction: fn,
      composable: chosen.composable,
      report: chosen.report,
      stale: true,
      staleness: staleCheck,
    };
  }
  return {
    matched: true,
    enclosingFunction: fn,
    composable: chosen.composable,
    report: chosen.report,
    stale: false,
  };
}

// ---------------------------------------------------------------------------
// prose, in the compiler's own words
// ---------------------------------------------------------------------------

/**
 * Finds `type`'s own entry in `report.classes` by simple name — the compose
 * compiler's classes.txt has no package either, so this is a best-effort,
 * same-name lookup within one report, not narrowed further. `type` often
 * carries generics (`List<CartItem>`, `StateFlow<String>`); only the bare
 * class name in front of the first `<` is ever looked up, since that is the
 * only part the compiler's own classes list could possibly have an entry
 * for — a container's own unrelated stability is not this parameter's story.
 */
function findClass(report: ComposeReportFile, type: string): ComposeReportClass | undefined {
  const bareName = type.split("<")[0].trim();
  return report.classes.find((c) => c.name === bareName);
}

/**
 * Why `cls` is unstable, in one clause — a `var` property first (the more
 * actionable, more common reason in a hand-written class: see GRA-69's own
 * `RowHighlight` fixture), an unstable-typed field second (the OkHttpClient/
 * MockWebServer/StateFlow shape — GRA-69's own `CartApi` fixture), or, when
 * neither line is found (a class the compiler marked unstable for a reason
 * this report does not break down further — an open superclass, a captured
 * type parameter), a plain fallback that still names the class rather than
 * inventing a property that is not there.
 */
function stabilityReason(cls: ComposeReportClass): string {
  const mutable = cls.properties.find((p) => p.mutable);
  if (mutable) return `\`${cls.name}\` is unstable because it has a \`var\` property (\`${mutable.name}\`)`;
  const unstableField = cls.properties.find((p) => !p.stable);
  if (unstableField) {
    return (
      `\`${cls.name}\` is unstable because its \`${unstableField.name}: ${unstableField.type}\` ` +
      "field is itself unstable"
    );
  }
  return `\`${cls.name}\` is unstable`;
}

/**
 * `"LeakyRow is restartable but not skippable: parameter highlight: RowHighlight is unstable. RowHighlight is unstable because it has a var property (tappedAt)."`
 * — GRA-69's own example (`CartContents`/`items: List<CartItem>`) is the
 * same shape one level up, where `trace.ts` prepends the recomposition
 * count itself: `detail` here is the compiler's own reasoning alone, not
 * the count sentence, so it can be reused verbatim by both `findings` and
 * `recompositions` without either repeating the other's "recomposed N
 * times" clause. Returns `null` when `composable` is in fact skippable
 * (call [explainSkippableButUnstable] instead) or carries no unstable
 * parameter at all (nothing to explain — a composable can be `restartable`
 * and not skippable for a structural reason this report does not break
 * down, e.g. varargs or a context receiver, and inventing an unstable
 * parameter that is not there would be a worse answer than none).
 */
export function explainNotSkippable(join: ComposeJoin & { matched: true }): string | null {
  const { composable, report, enclosingFunction } = join;
  if (composable.skippable) return null;
  const unstable = composable.parameters.find((p) => !p.stable);
  if (!unstable) return null;

  let sentence =
    `\`${enclosingFunction}\` is restartable but not skippable: parameter ` +
    `\`${unstable.name}: ${unstable.type}\` is unstable.`;
  const cls = findClass(report, unstable.type);
  if (cls && !cls.stable) sentence += ` ${stabilityReason(cls)}.`;
  return sentence;
}

/**
 * The "different, less urgent problem" (GRA-69's own words) case: skippable
 * per the compiler, but an unstable parameter means the skip check still
 * relies on identity rather than equality, so a caller that rebuilds that
 * parameter fresh every recomposition (a `List` derived inline, most often)
 * gets no benefit from it in practice. Reported, but never promoted above a
 * genuinely not-skippable finding — see `trace.ts`'s severity choice for
 * the two cases.
 */
export function explainSkippableButUnstable(join: ComposeJoin & { matched: true }): string | null {
  const { composable, enclosingFunction } = join;
  if (!composable.skippable) return null;
  const unstable = composable.parameters.find((p) => !p.stable);
  if (!unstable) return null;

  return (
    `\`${enclosingFunction}\` is skippable, but parameter \`${unstable.name}: ${unstable.type}\` ` +
    "is unstable — a fresh instance still fails the skip check, so this is busy rather than " +
    "broken: a different, less urgent problem than a composable the compiler could not make " +
    "skippable at all."
  );
}
