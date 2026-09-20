// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveProjectRoot } from "./adb.js";

/**
 * GRA-201: resolving a finding's evidence to where it lives in the project's
 * own source — never the other way around. The server already runs inside
 * the project's root (`resolveProjectRoot()`, `adb.ts`); every finding
 * already carries the symbol that caused it — a stall's top frame, an exit's
 * `topAppFrame`, a recomposition's composable name — and the agent's next
 * move is always the same grep. This module does that grep once, so the
 * answer travels with the finding instead of being rebuilt by every caller.
 *
 * `where` is a fact, not a conclusion: it never changes what a finding says,
 * only where the thing it is talking about lives. Kept out of trace.ts,
 * index.ts and report.ts — which other tickets edit in parallel — so this
 * whole feature lives in one place and those files only ever gain the one or
 * two lines that attach the result.
 *
 * Two lookups, both gated the same way (see `rootForResolution` below):
 *
 *  - `whereForFrame` — slice 1, no index needed. A stack frame's last line
 *    already names a file and a line (`StackFormat.kt#render`:
 *    `Class.method(File.kt:42)`); this only has to find the one file under
 *    the root with that name.
 *  - `whereForName` — slice 2. A composable's name is not a declared Kotlin
 *    symbol at all — `PortholeScreen("Cart")` and
 *    `Modifier.portholeNode("Cart.PromoField")` (`PortholeCompose.kt`) take
 *    a developer-chosen string literal, and that string, not the enclosing
 *    function's name, is what `recompositions` reports and what
 *    `Porthole.registerViewModel("CartViewModel", vm)` reports for `state`.
 *    So the index this builds indexes exactly what a reader would grep for:
 *    those string-literal labels, alongside plain class/function
 *    declarations for names that are not labels (an owner named after its
 *    class, unregistered).
 *
 * Both return `undefined` — no `where` key at all — when there is nothing to
 * say: the feature is off (see below), or there was no name/frame to look up
 * in the first place. Once there is something to look up and the feature is
 * on, they always return a `Where`, resolved or not — an unresolved `Where`
 * is itself the useful fact ("ambiguous", "not found", "synthetic").
 *
 * Follow-up: a same-named file or label in two modules is the case this
 * exists for and used to always read "ambiguous" — the multi-module app
 * the ticket's own example is about. When the evidence carries a package
 * too (a stack frame's fully qualified class, or a fully qualified
 * `state`/recomposition name), both lookups narrow their candidates to the
 * ones declared under that package before falling back to "ambiguous" —
 * see `narrowByPackage`. Narrowing only ever picks a result when it lands
 * on exactly one candidate; zero or several and this reports exactly what
 * it would have without a package at all, never a guess.
 */

/** Why a lookup did not resolve to exactly one place. Exactly what the wire carries under `where.reason` — see this module's own doc comment for what distinguishes them. */
export type WhereUnresolvedReason =
  | "not found"
  | "ambiguous"
  | "synthetic"
  | "too many source files under the project root to search them all";

export type Where = { resolved: true; path: string; line?: number } | { resolved: false; reason: WhereUnresolvedReason };

/**
 * Directories a walk never descends into, symlink or not: build output
 * (regenerated, and can be enormous), Gradle's own cache, node_modules (the
 * UI lives beside the server in this repo) and .git. None of the three kinds
 * of source this resolves — a Kotlin/Java class, a Compose label, a
 * ViewModel registration — is ever authored inside one of these.
 */
const SKIP_DIRS = new Set(["build", ".gradle", "node_modules", ".git"]);

/**
 * Hard cap on how many source files one walk will collect.
 *
 * A repo this large is not a case anyone has measured against, and an
 * unbounded walk turning every `findings` call into a multi-second stall
 * would be a worse outcome than the feature simply admitting it stopped
 * early. `capped` (on the cache entry) is what turns into `reason: "too
 * many source files…"` on a lookup that could not be answered with
 * confidence because of it — a file this walk never reached might have been
 * the real (or the second, ambiguity-causing) match.
 */
export const DEFAULT_WALK_FILE_CAP = 20_000;
let walkFileCap = DEFAULT_WALK_FILE_CAP;

/** Test-only: shrink the cap so a walk-cap test does not need 20,000 real files on disk. */
export function setWalkFileCapForTests(cap: number | null): void {
  walkFileCap = cap ?? DEFAULT_WALK_FILE_CAP;
}

/**
 * How long a cached walk is trusted before the next lookup re-walks.
 *
 * The alternative this ticket weighed was a directory-mtime check on the
 * cached listing. That is cheaper per lookup but blind to the common case
 * that actually matters here — an editor saving a file two directories down
 * touches that file's own mtime, not every ancestor directory's, so a
 * root-level (or even module-level) mtime check would not notice most
 * edits without recursing the tree to find them, which is the walk this
 * exists to avoid. A short TTL is simpler, bounded, and matches how this is
 * actually used: one MCP server process, a burst of tool calls a few
 * hundred milliseconds apart while an agent investigates one moment, then a
 * pause while it edits code. Five seconds reuses the index for that whole
 * burst — which is the "built once, reused across calls" the tests hold
 * this to — and never leaves a stale answer live for more than one edit-run
 * cycle.
 */
const CACHE_TTL_MS = 5_000;

interface Declaration {
  path: string;
  line: number;
}

interface CacheEntry {
  builtAt: number;
  files: string[];
  capped: boolean;
  byBaseName: Map<string, string[]>;
  /** Built lazily — most sessions call `whereForFrame` far more than `whereForName`, and a session that never asks about a composable should never pay to parse one. */
  names: Map<string, Declaration[]> | null;
  /**
   * `package` line per file, filled lazily and only for files that actually
   * come up as a disambiguation candidate — reading and regexing every file
   * under the root just in case two of them later share a basename would
   * turn the cheap, no-index slice-1 path into a full-tree read on every
   * lookup. `null` means read and found no `package` declaration (the
   * default package, or a parse miss); a file only ever ends up in this map
   * once, whichever of `whereForFrame`/`whereForName` asks for it first.
   */
  packageByFile: Map<string, string | null>;
}

const cache = new Map<string, CacheEntry>();

/**
 * Bumped once per actual directory walk (a cache miss or an expired entry),
 * never on a cache hit. Test-only visibility into "the index is built once
 * and reused across calls" — counting walks, not lookups, is what actually
 * proves reuse; two lookups that both hit the cache are indistinguishable
 * from one lookup by any observable *except* this counter.
 */
export const sourceIndexStats = { walks: 0, nameIndexBuilds: 0 };

/** Test-only: clears the cache and the counters above, so one test's index never answers another's lookup. */
export function resetSourceIndexForTests(): void {
  cache.clear();
  sourceIndexStats.walks = 0;
  sourceIndexStats.nameIndexBuilds = 0;
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * *.kt and *.java under a `src/` segment, root-relative and POSIX-separated
 * (so a lookup result reads the same on Windows and everywhere else).
 *
 * A symlink is followed only when it resolves inside `root` — one that
 * escapes it (a source checked out elsewhere and linked in, `/etc`, a
 * dangling link) is skipped outright rather than either followed blind or
 * silently making the walk non-deterministic across machines.
 */
function walk(root: string): { files: string[]; capped: boolean } {
  const files: string[] = [];
  let capped = false;

  const visit = (dir: string, segments: string[]): void => {
    if (capped) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — not this module's problem to raise
    }
    for (const entry of entries) {
      if (capped) return;
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          continue; // broken link
        }
        if (!isInside(root, real)) continue; // escapes the declared root
        let target;
        try {
          target = statSync(real);
        } catch {
          continue;
        }
        isDir = target.isDirectory();
        isFile = target.isFile();
      }

      if (isDir) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(full, [...segments, entry.name]);
      } else if (isFile) {
        if (!/\.(kt|java)$/.test(entry.name)) continue;
        if (!segments.includes("src")) continue;
        if (files.length >= walkFileCap) {
          capped = true;
          return;
        }
        files.push([...segments, entry.name].join("/"));
      }
    }
  };

  visit(root, []);
  return { files, capped };
}

function getEntry(root: string): CacheEntry {
  const absolute = path.resolve(root);
  const cached = cache.get(absolute);
  if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) return cached;

  sourceIndexStats.walks++;
  const { files, capped } = walk(absolute);
  const byBaseName = new Map<string, string[]>();
  for (const file of files) {
    const base = file.slice(file.lastIndexOf("/") + 1);
    const existing = byBaseName.get(base);
    if (existing) existing.push(file);
    else byBaseName.set(base, [file]);
  }
  const entry: CacheEntry = { builtAt: Date.now(), files, capped, byBaseName, names: null, packageByFile: new Map() };
  cache.set(absolute, entry);
  return entry;
}

/** `^package\s+([\w.]+)` — the same tolerant single-pass-per-line regex the name index already uses for declarations, applied here to just the one line that matters. */
const PACKAGE_DECLARATION = /^\s*package\s+([\w.]+)/m;

/**
 * The declared package of `relPath`, read and cached at most once per file
 * per walk. Reading is deliberately lazy and scoped to disambiguation
 * candidates only — see `CacheEntry.packageByFile`'s own comment.
 */
function packageOf(root: string, entry: CacheEntry, relPath: string): string | null {
  const cached = entry.packageByFile.get(relPath);
  if (cached !== undefined) return cached;
  let declared: string | null = null;
  try {
    const text = readFileSync(path.join(root, ...relPath.split("/")), "utf8");
    const match = PACKAGE_DECLARATION.exec(text);
    if (match) declared = match[1];
  } catch {
    // removed between the walk and here, or unreadable — no package to report
  }
  entry.packageByFile.set(relPath, declared);
  return declared;
}

/**
 * Narrows `candidates` to the ones declared under `packageName`, when the
 * evidence supplied one. GRA-201 follow-up: "never pick one of several" —
 * filtering to zero or to more than one is not an answer this returns,
 * only a filter down to exactly one is; the caller falls back to its
 * ordinary ambiguous/ not-found handling on every other outcome, using the
 * *unfiltered* candidate list, exactly as it did before package-awareness
 * existed.
 */
function narrowByPackage<T extends { path: string }>(
  root: string,
  entry: CacheEntry,
  candidates: T[],
  packageName: string | null,
): T | null {
  if (!packageName) return null;
  const filtered = candidates.filter((c) => packageOf(root, entry, c.path) === packageName);
  return filtered.length === 1 ? filtered[0] : null;
}

function resolveFile(root: string, fileName: string, packageName: string | null): Where {
  const entry = getEntry(root);
  const matches = entry.byBaseName.get(fileName) ?? [];
  if (matches.length === 1) return { resolved: true, path: matches[0] };
  if (matches.length > 1) {
    const narrowed = narrowByPackage(
      root,
      entry,
      matches.map((path) => ({ path })),
      packageName,
    );
    if (narrowed) return { resolved: true, path: narrowed.path };
    return { resolved: false, reason: "ambiguous" };
  }
  if (entry.capped) {
    return { resolved: false, reason: "too many source files under the project root to search them all" };
  }
  return { resolved: false, reason: "not found" };
}

// ---------------------------------------------------------------------------
// slice 1: a stack frame's own file:line
// ---------------------------------------------------------------------------

/**
 * Splits a qualified prefix (everything before the trailing
 * `(File.kt:NN)`, e.g. `com.example.shop.ui.CartViewModel.blockTheMainThread`)
 * into a package, on the one convention the JVM actually guarantees: a
 * package segment is lowercase, a class is not (`CartViewModel`, or a
 * top-level Kotlin file's own `ScreensKt`). The longest lowercase-segment
 * prefix is the package; the first non-lowercase segment after it — a class
 * name, possibly followed by more (a method, `$1`, a nested class) — is
 * everything else, which this function has no use for. Returns `null` when
 * there is no such split to make: nothing lowercase at the front (a
 * default-package frame, or a bare dummy prefix in a test that names no
 * real package), or lowercase all the way through (nothing left to be the
 * class/method that would confirm the split is real).
 */
function packageFromQualifiedFrame(qualified: string): string | null {
  const segments = qualified.split(".").filter(Boolean);
  let i = 0;
  while (i < segments.length && /^[a-z_][a-z0-9_]*$/.test(segments[i])) i++;
  if (i === 0 || i >= segments.length) return null;
  return segments.slice(0, i).join(".");
}

/**
 * Extracts `{file, line, packageName}` from one rendered stack-frame line —
 * `com.example.CartViewModel.blockTheMainThread(CartViewModel.kt:148)`, the
 * exact shape `StackFormat.kt#render` produces on the runtime side. Returns
 * `null` for anything that is not, in fact, a source-mapped frame:
 * `(?:-1)` (unknown source) and `(?:-2)` (a native method) are
 * `StackFormat`'s own way of saying "nothing to point at" — not a file this
 * walk simply has not found yet — and a line missing its trailing
 * `(File.kt:NN)` entirely (already-truncated text, a non-JVM frame) is the
 * same story. `packageName` is best-effort (see `packageFromQualifiedFrame`)
 * and only ever narrows an otherwise-ambiguous match, never widens one.
 * Exported for its own tests; callers should reach for `whereForFrame`
 * instead.
 */
export function parseFrame(
  frameLine: string,
): { file: string; line: number | null; packageName: string | null } | null {
  const trimmed = frameLine.trim();
  const match = /\(([^()]+):(-?\d+)\)\s*$/.exec(trimmed);
  if (!match) return null;
  const [, file, lineText] = match;
  if (!file || file === "?" || !/\.(kt|java)$/i.test(file)) return null;
  const line = Number(lineText);
  const packageName = packageFromQualifiedFrame(trimmed.slice(0, match.index));
  return { file, line: Number.isInteger(line) && line > 0 ? line : null, packageName };
}

/**
 * Resolves a single stack-frame line to where it lives under the project
 * root. `undefined` — no `where` key at all — when the feature is off (see
 * `rootForResolution`) or there was no frame to look at; otherwise always a
 * `Where`, because "this frame is not resolvable" (a native frame, an
 * obfuscated one, a file the walk genuinely could not find) is itself the
 * fact worth reporting.
 */
export function whereForFrame(frameLine: string | undefined | null): Where | undefined {
  if (!frameLine) return undefined;
  const root = rootForResolution();
  if (!root) return undefined;

  const parsed = parseFrame(frameLine);
  if (!parsed) return { resolved: false, reason: "synthetic" };

  const fileResult = resolveFile(root, parsed.file, parsed.packageName);
  if (!fileResult.resolved) return fileResult;
  return parsed.line ? { resolved: true, path: fileResult.path, line: parsed.line } : fileResult;
}

// ---------------------------------------------------------------------------
// slice 2: a name index, for names that are not stack frames at all
// ---------------------------------------------------------------------------

/** A name is synthetic — Compose or the collector's own naming, never the app's — exactly when `SnapshotWatcher.kt#unnamedKey` produced it: `<unnamed:Type#identity>`. Never worth a file walk, and never worth reporting as merely "not found", which would suggest a real name simply was not located. */
function isSyntheticName(name: string): boolean {
  return name.startsWith("<") || /unnamed[:#]/i.test(name);
}

// Tolerant on purpose — a regex pass over source text, not a parser, per
// GRA-201's own scope. Each is checked against one line at a time, which is
// what keeps a line number attached to every match with no separate offset
// bookkeeping; a declaration split across lines (a multi-line parameter
// list before `{`) still has its own `class`/`fun`/label keyword on one
// line, which is the line recorded.
const CLASS_OR_OBJECT = /\b(?:class|object|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const FUNCTION = /\bfun\s+(?:<[^>]*>\s*)?(?:[A-Za-z_][A-Za-z0-9_.<>]*\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
// portholeNode/PortholeScreen (PortholeCompose.kt) and
// collectAsNamedState/rememberNamedState (same file) all take the name as
// their first string-literal argument; Porthole.registerViewModel(name, vm)
// (Porthole.kt) is the same shape for a ViewModel's `state` owner name.
const LABEL =
  /\b(?:portholeNode|PortholeScreen|collectAsNamedState|rememberNamedState|registerViewModel)\s*\(\s*"((?:[^"\\]|\\.)*)"/;

function addDeclaration(names: Map<string, Declaration[]>, name: string, file: string, line: number): void {
  const existing = names.get(name);
  if (!existing) {
    names.set(name, [{ path: file, line }]);
    return;
  }
  // The same name can legitimately match more than one pattern on the same
  // line (a class also named in an inherited-looking `fun`-shaped match is
  // not realistic, but a label and a class sharing one line is not either) —
  // deduped by location so one declaration never counts as two and
  // manufactures an "ambiguous" that is not real.
  if (!existing.some((d) => d.path === file && d.line === line)) existing.push({ path: file, line });
}

function buildNameIndex(root: string, files: string[]): Map<string, Declaration[]> {
  const names = new Map<string, Declaration[]>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(path.join(root, ...file.split("/")), "utf8");
    } catch {
      continue; // removed between the walk and here
    }
    const lines = text.split(/\r\n|\n|\r/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const classMatch = CLASS_OR_OBJECT.exec(line);
      if (classMatch) addDeclaration(names, classMatch[1], file, i + 1);
      const functionMatch = FUNCTION.exec(line);
      if (functionMatch) addDeclaration(names, functionMatch[1], file, i + 1);
      const labelMatch = LABEL.exec(line);
      if (labelMatch) addDeclaration(names, labelMatch[1], file, i + 1);
    }
  }
  return names;
}

function getNameIndex(root: string): Map<string, Declaration[]> {
  const entry = getEntry(root);
  if (!entry.names) {
    sourceIndexStats.nameIndexBuilds++;
    entry.names = buildNameIndex(path.resolve(root), entry.files);
  }
  return entry.names;
}

/**
 * Splits a fully qualified class name (`com.example.shop.ui.CartViewModel`)
 * into its package and simple name — the same lowercase-package/capitalised-
 * class convention `packageFromQualifiedFrame` leans on, but total rather
 * than longest-prefix: every segment before the last must look like a
 * package, or this is not a qualified name at all. That distinction is what
 * keeps a plain composable label like `Cart.PromoField` from being
 * misparsed as package `Cart` / class `PromoField` — `Cart` is capitalised,
 * so it fails the package test and `whereForName` looks it up unfiltered,
 * exactly as it did before this function existed.
 */
function splitQualifiedClassName(name: string): { packageName: string; simpleName: string } | null {
  const segments = name.split(".");
  if (segments.length < 2) return null;
  const simpleName = segments[segments.length - 1];
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(simpleName)) return null;
  const packageSegments = segments.slice(0, -1);
  if (!packageSegments.every((s) => /^[a-z_][a-z0-9_]*$/.test(s))) return null;
  return { packageName: packageSegments.join("."), simpleName };
}

/**
 * Resolves a composable's name, a `state` owner's registered name, or a
 * class name to where it is declared or labelled in source. Same `undefined`
 * -vs-`Where` contract as `whereForFrame` — see that function's own comment.
 *
 * `name` may be fully qualified (a `state` owner registered with its class's
 * own qualified name, say) — `splitQualifiedClassName` recognises that case
 * and narrows by package the same way `whereForFrame` does; an unqualified
 * name (every composable label, most registered names) resolves exactly as
 * before.
 */
export function whereForName(name: string | undefined | null): Where | undefined {
  if (!name) return undefined;
  const root = rootForResolution();
  if (!root) return undefined;
  if (isSyntheticName(name)) return { resolved: false, reason: "synthetic" };

  const qualified = splitQualifiedClassName(name);
  const lookupName = qualified ? qualified.simpleName : name;

  const entry = getEntry(root);
  const matches = getNameIndex(root).get(lookupName) ?? [];
  if (matches.length === 1) return { resolved: true, path: matches[0].path, line: matches[0].line };
  if (matches.length > 1) {
    const narrowed = narrowByPackage(root, entry, matches, qualified?.packageName ?? null);
    if (narrowed) return { resolved: true, path: narrowed.path, line: narrowed.line };
    return { resolved: false, reason: "ambiguous" };
  }
  if (entry.capped) {
    return { resolved: false, reason: "too many source files under the project root to search them all" };
  }
  return { resolved: false, reason: "not found" };
}

// ---------------------------------------------------------------------------
// the off switch
// ---------------------------------------------------------------------------

/**
 * The root to resolve against, or `null` to mean "resolution is off
 * entirely" — not merely "nothing found".
 *
 * `resolveProjectRoot()` (adb.ts) falls back to `process.cwd()` when
 * `PORTHOLE_PROJECT_ROOT` is not set, on the documented assumption that an
 * MCP client launched the server from the workspace root — a guess GRA-119
 * already exists to stop relying on for the SDK lookup, and one this
 * feature has no business compounding: reading a whole tree of source files
 * under a directory that only *might* be the project, and then telling an
 * agent "this is where the bug is" against files that might belong to some
 * other project entirely, is a worse outcome than saying nothing. So this
 * only ever resolves against a root the generated `.mcp.json` actually
 * declared. See the env-var table in README's Setup section — this is
 * exactly the "nothing changes for the cwd fallback" GRA-201 promises.
 */
function rootForResolution(): string | null {
  const resolved = resolveProjectRoot();
  return resolved.source === "PORTHOLE_PROJECT_ROOT" ? resolved.directory : null;
}
