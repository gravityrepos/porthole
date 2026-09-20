// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetSourceIndexForTests, setClockForTests } from "./sources.js";
import {
  currentSourceFingerprint,
  enclosingFunctionName,
  explainNotRestartable,
  explainNotSkippable,
  explainSkippableButUnstable,
  findComposeReportPaths,
  joinComposableNode,
  resetComposeReportCacheForTests,
  setComposeReportClockForTests,
  staleness,
  type ComposeJoin,
  type ComposeReportClass,
  type ComposeReportComposable,
  type ComposeReportFile,
} from "./composeReport.js";

const WORKTREE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

let roots: string[] = [];
let savedProjectRoot: string | undefined;

function temporaryRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "porthole-compose-report-"));
  roots.push(directory);
  return directory;
}

function write(root: string, relPath: string, contents: string): void {
  const full = path.join(root, ...relPath.split("/"));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function writeReport(root: string, modulePath: string, report: Record<string, unknown>): void {
  write(root, `${modulePath}/build/porthole/compose-report.json`, JSON.stringify(report));
}

function baseReport(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    generatedAt: "2026-09-19T00:00:00.000Z",
    variant: "debug",
    module: "app",
    kotlinVersion: "2.1.0",
    gitHead: "abc123",
    sourceFingerprint: "deadbeef",
    composables: [],
    classes: [],
    ...overrides,
  };
}

function useProjectRoot(root: string | undefined): void {
  if (root === undefined) delete process.env.PORTHOLE_PROJECT_ROOT;
  else process.env.PORTHOLE_PROJECT_ROOT = root;
}

beforeEach(() => {
  savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
  resetSourceIndexForTests();
  resetComposeReportCacheForTests();
});

afterEach(() => {
  useProjectRoot(savedProjectRoot);
  resetSourceIndexForTests();
  resetComposeReportCacheForTests();
  setClockForTests(null);
  setComposeReportClockForTests(null);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("findComposeReportPaths", () => {
  it("finds a report under one module's build directory", () => {
    const root = temporaryRoot();
    writeReport(root, "app", baseReport());
    expect(findComposeReportPaths(root)).toEqual([
      path.join(root, "app", "build", "porthole", "compose-report.json"),
    ]);
  });

  it("finds one report per module, in a multi-module tree", () => {
    const root = temporaryRoot();
    writeReport(root, "app", baseReport({ module: "app" }));
    writeReport(root, "core/network", baseReport({ module: "network" }));
    const found = findComposeReportPaths(root).sort();
    expect(found).toEqual(
      [
        path.join(root, "app", "build", "porthole", "compose-report.json"),
        path.join(root, "core", "network", "build", "porthole", "compose-report.json"),
      ].sort(),
    );
  });

  it("never recurses into a build directory beyond the one candidate path", () => {
    const root = temporaryRoot();
    // A decoy report buried deeper inside build output — real Gradle output
    // never puts one here, but this proves the walk does not go looking.
    write(
      root,
      "app/build/intermediates/porthole/compose-report.json",
      JSON.stringify(baseReport()),
    );
    expect(findComposeReportPaths(root)).toEqual([]);
  });

  it("finds nothing under a tree with no report at all", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Foo.kt", "class Foo\n");
    expect(findComposeReportPaths(root)).toEqual([]);
  });
});

describe("currentSourceFingerprint", () => {
  it("is deterministic across calls against the same tree", () => {
    const root = temporaryRoot();
    write(root, "src/main/kotlin/A.kt", "class A\n");
    write(root, "src/main/kotlin/B.kt", "class B\n");
    expect(currentSourceFingerprint(root)).toEqual(currentSourceFingerprint(root));
  });

  it("changes when a source file's content changes", () => {
    const root = temporaryRoot();
    write(root, "src/main/kotlin/A.kt", "class A\n");
    const before = currentSourceFingerprint(root);
    write(root, "src/main/kotlin/A.kt", "class A { val x = 1 }\n");
    expect(currentSourceFingerprint(root)).not.toEqual(before);
  });

  it("is unaffected by a non-.kt file changing", () => {
    const root = temporaryRoot();
    write(root, "src/main/kotlin/A.kt", "class A\n");
    write(root, "src/main/AndroidManifest.xml", "<manifest/>");
    const before = currentSourceFingerprint(root);
    write(root, "src/main/AndroidManifest.xml", "<manifest package=\"x\"/>");
    expect(currentSourceFingerprint(root)).toEqual(before);
  });

  it("is empty-but-well-formed for a module with no src/ directory at all", () => {
    const root = temporaryRoot();
    expect(currentSourceFingerprint(root)).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * The load-bearing proof: this is not merely internally consistent, it is
   * the *same algorithm* `PortholeComposeReportTask.kt`'s `sourceFingerprint`
   * runs — verified by comparing this function's output, run against this
   * repo's own real `sample/` module, against the fingerprint a real Gradle
   * build actually wrote into `sample/build/porthole/compose-report.json`
   * (re-captured for GRA-72: `Screens.kt` gained the IconButton/tiny-target
   * accessibility fixtures, re-verified against a fresh
   * `./gradlew :sample:portholeComposeReport -Pporthole.variant=roomDebug`
   * run — see `composeReportFixtures/PROVENANCE.md` on the Gradle-plugin
   * side for the matching half of this proof, which is unaffected: that
   * fixture is a frozen, hand-captured `*.txt` pair, not a hash of the live
   * tree). If this ever goes red on an unrelated PR, the two implementations
   * have drifted — a real bug, not a fixture that needs a bump — unless
   * `sample/`'s own `.kt` sources genuinely changed, which is exactly the
   * case this pin exists to force a human to notice and re-verify against a
   * fresh `./gradlew :sample:portholeComposeReport` run.
   */
  it("matches the real Gradle-computed fingerprint for this repo's own sample module", () => {
    const sampleRoot = path.join(WORKTREE_ROOT, "sample");
    expect(currentSourceFingerprint(sampleRoot)).toBe(
      "1f08d5e0b5d902f0627e634e636801a50410a2ebc3e5d9b7ba6521a8a020eaaa",
    );
  });
});

describe("staleness", () => {
  it("is fresh when the recorded fingerprint matches the live tree", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/A.kt", "class A\n");
    const fingerprint = currentSourceFingerprint(path.join(root, "app"));
    const report: ComposeReportFile = {
      reportPath: path.join(root, "app/build/porthole/compose-report.json"),
      moduleRoot: path.join(root, "app"),
      generatedAt: "2026-09-19T00:00:00.000Z",
      variant: "debug",
      module: "app",
      kotlinVersion: "2.1.0",
      gitHead: "abc123",
      sourceFingerprint: fingerprint,
      composables: [],
      classes: [],
    };
    expect(staleness(report).stale).toBe(false);
  });

  it("is stale once a source file changes after the report was generated", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/A.kt", "class A\n");
    const fingerprint = currentSourceFingerprint(path.join(root, "app"));
    write(root, "app/src/main/kotlin/A.kt", "class A { val x = 1 }\n");
    const report: ComposeReportFile = {
      reportPath: path.join(root, "app/build/porthole/compose-report.json"),
      moduleRoot: path.join(root, "app"),
      generatedAt: "2026-09-19T00:00:00.000Z",
      variant: "debug",
      module: "app",
      kotlinVersion: "2.1.0",
      gitHead: "abc123",
      sourceFingerprint: fingerprint,
      composables: [],
      classes: [],
    };
    expect(staleness(report).stale).toBe(true);
  });
});

describe("enclosingFunctionName", () => {
  it("finds the fun declaration on the same line as the label", () => {
    const root = temporaryRoot();
    write(root, "Screens.kt", '@Composable\nfun LeakyRow() { Modifier.portholeNode("Cart.ItemRow") }\n');
    expect(enclosingFunctionName(root, "Screens.kt", 2)).toBe("LeakyRow");
  });

  it("finds the nearest fun declaration above a label on its own line", () => {
    const root = temporaryRoot();
    write(
      root,
      "Screens.kt",
      "@Composable\nfun LeakyRow(highlight: RowHighlight) {\n" +
        '  Modifier.portholeNode("Cart.ItemRow")\n' +
        "}\n",
    );
    expect(enclosingFunctionName(root, "Screens.kt", 3)).toBe("LeakyRow");
  });

  it("returns null when no fun declaration precedes the line at all", () => {
    const root = temporaryRoot();
    write(root, "Screens.kt", 'val x = "Modifier.portholeNode(\\"Cart.ItemRow\\")"\n');
    expect(enclosingFunctionName(root, "Screens.kt", 1)).toBeNull();
  });

  it("returns null for a file that does not exist", () => {
    const root = temporaryRoot();
    expect(enclosingFunctionName(root, "Nowhere.kt", 5)).toBeNull();
  });
});

/** `parameters`/`properties` default to `[]` so a test only has to spell out what it actually cares about. */
function composable(overrides: Partial<ComposeReportComposable>): ComposeReportComposable {
  return { name: "X", packageName: null, restartable: true, skippable: true, parameters: [], ...overrides };
}

describe("joinComposableNode", () => {
  it("is off entirely when PORTHOLE_PROJECT_ROOT is unset", () => {
    useProjectRoot(undefined);
    const join = joinComposableNode("Cart.ItemRow");
    expect(join).toEqual({ matched: false, reason: "source resolution is off (PORTHOLE_PROJECT_ROOT is unset)" });
  });

  it("does not match when the label never resolves to a source location", () => {
    const root = temporaryRoot();
    useProjectRoot(root);
    const join = joinComposableNode("NoSuchLabel");
    expect(join.matched).toBe(false);
    expect((join as { reason: string }).reason).toBe("the node's label did not resolve to a source location");
  });

  it("does not match when no report exists under the root at all", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Screens.kt", '@Composable\nfun LeakyRow() { Modifier.portholeNode("Cart.ItemRow") }\n');
    useProjectRoot(root);
    const join = joinComposableNode("Cart.ItemRow");
    expect(join).toEqual({ matched: false, reason: "no report found under the project root" });
  });

  it("joins a restartable-but-not-skippable composable and names the unstable parameter", () => {
    const root = temporaryRoot();
    write(
      root,
      "app/src/main/kotlin/com/example/shop/ui/Screens.kt",
      "package com.example.shop.ui\n" +
        "@Composable\n" +
        "fun LeakyRow(item: CartItem, highlight: RowHighlight) {\n" +
        '  Modifier.portholeNode("Cart.ItemRow")\n' +
        "}\n",
    );
    // The real fingerprint of this fixture's own app/src tree — not the
    // stale-by-construction default `baseReport()` leaves in place, since
    // this test is specifically about the fresh, joined path (there is a
    // dedicated test below for the stale-refusal path).
    const realFingerprint = currentSourceFingerprint(path.join(root, "app"));
    writeReport(
      root,
      "app",
      baseReport({
        module: "app",
        sourceFingerprint: realFingerprint,
        composables: [
          composable({
            name: "LeakyRow",
            packageName: "com.example.shop.ui",
            skippable: false,
            parameters: [
              { name: "item", type: "CartItem", stable: true, unused: false },
              { name: "highlight", type: "RowHighlight", stable: false, unused: false },
            ],
          }),
        ],
        classes: [
          {
            name: "RowHighlight",
            stable: false,
            runtimeStability: "Unstable",
            properties: [{ name: "tappedAt", mutable: true, stable: true, type: "Long" }],
          },
        ],
      }),
    );
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    expect(join.matched).toBe(true);
    if (!join.matched) throw new Error("expected a match");
    expect(join.stale).toBe(false);
    expect(join.enclosingFunction).toBe("LeakyRow");
    expect(join.composable.skippable).toBe(false);

    const explanation = explainNotSkippable(join as ComposeJoin & { matched: true });
    expect(explanation).toBe(
      "`LeakyRow` is restartable but not skippable: parameter `highlight: RowHighlight` is unstable. " +
        "`RowHighlight` is unstable because it has a `var` property (`tappedAt`). Annotate it " +
        "`@Immutable`/`@Stable`, or make the property `val`.",
    );
    expect(explainSkippableButUnstable(join as ComposeJoin & { matched: true })).toBeNull();
  });

  it("joins a skippable-but-unstable composable differently from a not-skippable one", () => {
    const root = temporaryRoot();
    write(
      root,
      "app/src/main/kotlin/Screens.kt",
      '@Composable\nfun Busy(items: List<String>) { Modifier.portholeNode("Cart.ItemRow") }\n',
    );
    writeReport(
      root,
      "app",
      baseReport({
        composables: [
          composable({
            name: "Busy",
            skippable: true,
            parameters: [{ name: "items", type: "List<String>", stable: false, unused: false }],
          }),
        ],
      }),
    );
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    expect(join.matched).toBe(true);
    if (!join.matched) throw new Error("expected a match");
    expect(explainNotSkippable(join as ComposeJoin & { matched: true })).toBeNull();
    expect(explainSkippableButUnstable(join as ComposeJoin & { matched: true })).toBe(
      "`Busy` is skippable, but parameter `items: List<String>` is unstable — a fresh instance " +
        "still fails the skip check, so this is busy rather than broken: a different, less urgent " +
        "problem than a composable the compiler could not make skippable at all.",
    );
  });

  it("neither explanation fires for a skippable composable with every parameter stable", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Screens.kt", '@Composable\nfun Fine(n: Int) { Modifier.portholeNode("Cart.ItemRow") }\n');
    writeReport(
      root,
      "app",
      baseReport({
        composables: [
          composable({ name: "Fine", skippable: true, parameters: [{ name: "n", type: "Int", stable: true, unused: false }] }),
        ],
      }),
    );
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    expect(join.matched).toBe(true);
    if (!join.matched) throw new Error("expected a match");
    expect(explainNotSkippable(join as ComposeJoin & { matched: true })).toBeNull();
    expect(explainSkippableButUnstable(join as ComposeJoin & { matched: true })).toBeNull();
  });

  it("does not match when the function name is not in any report", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Screens.kt", '@Composable\nfun LeakyRow() { Modifier.portholeNode("Cart.ItemRow") }\n');
    writeReport(root, "app", baseReport({ composables: [composable({ name: "SomethingElse" })] }));
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    expect(join).toEqual({ matched: false, reason: "no report entry matched" });
  });

  it("never guesses between two same-named composables in different modules with no package to narrow by", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Screens.kt", '@Composable\nfun Row() { Modifier.portholeNode("Cart.ItemRow") }\n');
    writeReport(root, "app", baseReport({ module: "app", composables: [composable({ name: "Row", packageName: "com.a" })] }));
    writeReport(
      root,
      "core/other",
      baseReport({ module: "other", composables: [composable({ name: "Row", packageName: "com.b" })] }),
    );
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    expect(join.matched).toBe(false);
    if (join.matched) throw new Error("expected no match");
    expect(join.reason).toBe("matched more than one report entry");
    // `signature` (B1 nit, QA) is what would tell two same-module,
    // same-package overloads apart — both zero-parameter here, so both
    // read "()", but the field is always present.
    expect(join.candidates).toEqual(
      expect.arrayContaining([
        { module: "app", packageName: "com.a", signature: "()" },
        { module: "other", packageName: "com.b", signature: "()" },
      ]),
    );
    expect(join.declarationPackage).toBeNull();
  });

  it("narrows to one candidate by the resolved file's own package declaration", () => {
    const root = temporaryRoot();
    write(
      root,
      "app/src/main/kotlin/Screens.kt",
      'package com.example.shop.ui\n@Composable\nfun Row() { Modifier.portholeNode("Cart.ItemRow") }\n',
    );
    writeReport(
      root,
      "app",
      baseReport({
        module: "app",
        composables: [composable({ name: "Row", packageName: "com.example.shop.ui", skippable: true })],
      }),
    );
    writeReport(
      root,
      "core/other",
      baseReport({ module: "other", composables: [composable({ name: "Row", packageName: "com.other" })] }),
    );
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    expect(join.matched).toBe(true);
    if (!join.matched) throw new Error("expected a match");
    expect(join.report.module).toBe("app");
  });

  it("B1 (QA blocker): a single same-named candidate in the WRONG package is refused, not joined — the realistic multi-module shape where only one module ran the report", () => {
    // The exact bug: `com.example.feature.ItemRow` is where the label
    // actually resolves (that module never ran portholeComposeReport —
    // realistic: only the app module has). `com.example.app`'s own report
    // happens to have an unrelated `ItemRow` too. Before the fix,
    // `narrowToOne` returned this single candidate unconditionally the
    // moment there was only one, never checking its package against the
    // declaration's own — joining the wrong composable and handing back a
    // parameter list that does not exist on the one that actually
    // recomposed. Mutation: delete the `if (packageName)` branch in
    // `narrowToOne` (restore `if (candidates.length === 1) return
    // candidates[0]` first) and this test starts asserting `matched: true`
    // against the wrong module.
    const root = temporaryRoot();
    write(
      root,
      "feature/src/main/kotlin/com/example/feature/ItemRow.kt",
      "package com.example.feature\n@Composable\nfun ItemRow() { Modifier.portholeNode(\"Cart.ItemRow\") }\n",
    );
    writeReport(
      root,
      "app",
      baseReport({
        module: "app",
        composables: [
          composable({
            name: "ItemRow",
            packageName: "com.example.app",
            skippable: false,
            parameters: [{ name: "totallyUnrelated", type: "SomethingElse", stable: false, unused: false }],
          }),
        ],
      }),
    );
    // Deliberately no report at all under feature/ — that module has never
    // run portholeComposeReport, which is the whole point of the fixture.
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    expect(join.matched).toBe(false);
    if (join.matched) throw new Error("expected no match — joining com.example.app's ItemRow would be wrong");
    expect(join.reason).toBe("no report entry matched");
    expect(join.declarationPackage).toBe("com.example.feature");
    expect(join.candidates).toEqual([
      { module: "app", packageName: "com.example.app", signature: "(totallyUnrelated: SomethingElse)" },
    ]);
  });

  it("a single candidate is still accepted when the declaration's own package could not be determined at all", () => {
    // The narrow half of "when the declaration is known" (QA's own
    // parenthetical) — no `package` line in this file at all, so there is
    // nothing to check the one candidate against, and refusing it too would
    // regress every single-module, default-package project this already
    // worked for.
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Screens.kt", '@Composable\nfun ItemRow() { Modifier.portholeNode("Cart.ItemRow") }\n');
    writeReport(root, "app", baseReport({ composables: [composable({ name: "ItemRow", packageName: "com.example.app" })] }));
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    expect(join.matched).toBe(true);
  });

  it("refuses to join against a stale report rather than joining silently", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Screens.kt", '@Composable\nfun LeakyRow() { Modifier.portholeNode("Cart.ItemRow") }\n');
    // sourceFingerprint left at baseReport()'s literal "deadbeef" — never
    // equal to a real computed hash, so this report reads as stale by
    // construction.
    writeReport(root, "app", baseReport({ composables: [composable({ name: "LeakyRow", skippable: false })] }));
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    expect(join.matched).toBe(true);
    if (!join.matched) throw new Error("expected a match");
    expect(join.stale).toBe(true);
    // A stale match still carries the composable it found, but findings and
    // recompositions must never build prose from it — the two explain
    // functions are the caller-side guard trace.ts/index.ts apply (only
    // called when `!join.stale`), not something joinComposableNode enforces
    // on its own.
  });
});

describe("compose-report cache", () => {
  it("does not re-walk within the TTL", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Screens.kt", '@Composable\nfun LeakyRow() { Modifier.portholeNode("Cart.ItemRow") }\n');
    writeReport(root, "app", baseReport({ composables: [composable({ name: "LeakyRow" })] }));
    useProjectRoot(root);

    let now = 1_000;
    setComposeReportClockForTests(() => now);
    const first = joinComposableNode("Cart.ItemRow");

    // A second report appears, but the cached listing (well inside the TTL)
    // must still answer from what it already found.
    writeReport(root, "core/other", baseReport({ module: "other", composables: [composable({ name: "Other" })] }));
    now += 1_000;
    const second = joinComposableNode("Cart.ItemRow");
    expect(second).toEqual(first);

    now += 10_000; // past CACHE_TTL_MS
    resetSourceIndexForTests(); // the source-name index has its own TTL; only the report cache is under test
    const third = joinComposableNode("Cart.ItemRow");
    expect(third.matched).toBe(true);
  });
});

/**
 * B2 (QA blocker): `CartViewModel`'s own real `classes.txt` block, copied
 * verbatim from `gradle-plugin/src/test/resources/composeReportFixtures/
 * sample_roomDebug-classes.txt` — the exact shape that made the old
 * `stabilityReason` (picks the *first* `var`, full stop) pick
 * `lastResponse$delegate` — a `stable var` backed by `MutableState<String>`,
 * a recognised Compose-observable delegate that is never the real cause —
 * over `api: CartApi`, the field the compiler actually proved unstable.
 */
const CART_VIEW_MODEL: ComposeReportClass = {
  name: "CartViewModel",
  stable: false,
  runtimeStability: "Unstable",
  properties: [
    { name: "dao", mutable: false, stable: false, stability: "runtime", type: "CartStore" },
    { name: "api", mutable: false, stable: false, stability: "unstable", type: "CartApi" },
    { name: "cartId", mutable: false, stable: true, stability: "stable", type: "String" },
    { name: "lastResponse$delegate", mutable: true, stable: true, stability: "stable", type: "MutableState<String>" },
    { name: "promoCode$delegate", mutable: true, stable: true, stability: "stable", type: "MutableState<String>" },
    { name: "tick$delegate", mutable: true, stable: true, stability: "stable", type: "MutableIntState" },
    { name: "animating$delegate", mutable: true, stable: true, stability: "stable", type: "MutableState<Boolean>" },
    { name: "scopedReads$delegate", mutable: true, stable: true, stability: "stable", type: "MutableState<Boolean>" },
    { name: "items", mutable: false, stable: false, stability: "unstable", type: "StateFlow<List<CartItem>>" },
    { name: "status", mutable: false, stable: false, stability: "unstable", type: "MutableStateFlow<String>" },
    { name: "statusFlow", mutable: false, stable: false, stability: "unstable", type: "StateFlow<String>" },
    { name: "ktor", mutable: false, stable: false, stability: "unstable", type: "KtorApi" },
  ],
};

describe("B2 (QA blocker): stabilityReason against CartViewModel's real fixture", () => {
  it("names api: CartApi — a proven-unstable val — never a stable, delegate-backed var", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Screens.kt", '@Composable\nfun Controls(viewModel: CartViewModel) { Modifier.portholeNode("Cart.ItemRow") }\n');
    writeReport(
      root,
      "app",
      baseReport({
        composables: [
          composable({
            name: "Controls",
            skippable: false,
            parameters: [{ name: "viewModel", type: "CartViewModel", stable: false, unused: false }],
          }),
        ],
        classes: [CART_VIEW_MODEL],
      }),
    );
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    expect(join.matched).toBe(true);
    if (!join.matched) throw new Error("expected a match");
    const explanation = explainNotSkippable(join as ComposeJoin & { matched: true });
    // Mutation quoted: `cls.properties.find((p) => p.mutable)` in place of
    // the current `find((p) => p.mutable && !isRecognizedStateDelegate(p))`
    // is the one-line change that makes this assertion fail — it would pick
    // `lastResponse$delegate` again and print "has a `var` property
    // (`lastResponse`)" instead.
    expect(explanation).toContain("has a property of unstable type `CartApi` (`api`)");
    expect(explanation).not.toContain("var");
    expect(explanation).not.toContain("lastResponse");
    expect(explanation).not.toContain("$delegate");
  });

  it("prefers a proven-unstable field over one the compiler only calls runtime/uncertain", () => {
    // Same fixture, every genuinely `"unstable"` field removed (`api`,
    // `items`, `status`, `statusFlow`, `ktor`) — only `dao: CartStore`
    // ("runtime": the compiler cannot see through the interface) is left to
    // explain CartViewModel's own instability, so the honest, hedged
    // sentence is the only one this can truthfully say.
    const withoutApi: ComposeReportClass = {
      ...CART_VIEW_MODEL,
      properties: CART_VIEW_MODEL.properties.filter((p) => p.stability !== "unstable"),
    };
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Screens.kt", '@Composable\nfun Controls(viewModel: CartViewModel) { Modifier.portholeNode("Cart.ItemRow") }\n');
    writeReport(
      root,
      "app",
      baseReport({
        composables: [
          composable({
            name: "Controls",
            skippable: false,
            parameters: [{ name: "viewModel", type: "CartViewModel", stable: false, unused: false }],
          }),
        ],
        classes: [withoutApi],
      }),
    );
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    expect(join.matched).toBe(true);
    if (!join.matched) throw new Error("expected a match");
    const explanation = explainNotSkippable(join as ComposeJoin & { matched: true });
    expect(explanation).toContain("dao: CartStore");
    expect(explanation).toContain("could not be determined at compile time");
  });
});

describe("D1 (QA): a non-restartable composable is never described as restartable but not skippable", () => {
  it("explainNotSkippable returns null for restartable: false, skippable: false — the inline/@NonRestartableComposable shape", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Screens.kt", '@Composable\ninline fun ProbeInline(items: List<String>) { Modifier.portholeNode("Cart.ItemRow") }\n');
    writeReport(
      root,
      "app",
      baseReport({
        composables: [
          composable({
            name: "ProbeInline",
            restartable: false,
            skippable: false,
            parameters: [{ name: "items", type: "List<String>", stable: false, unused: false }],
          }),
        ],
      }),
    );
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    expect(join.matched).toBe(true);
    if (!join.matched) throw new Error("expected a match");
    // Mutation quoted: removing the `if (!composable.restartable) return
    // null;` guard from explainNotSkippable is what makes this assertion
    // fail — it would go back to claiming "is restartable but not
    // skippable" about a composable the compiler never called restartable.
    expect(explainNotSkippable(join as ComposeJoin & { matched: true })).toBeNull();
  });

  it("explainNotRestartable describes it truthfully instead, and is null for a restartable composable", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Screens.kt", '@Composable\ninline fun ProbeInline(items: List<String>) { Modifier.portholeNode("Cart.ItemRow") }\n');
    writeReport(
      root,
      "app",
      baseReport({
        composables: [composable({ name: "ProbeInline", restartable: false, skippable: false })],
      }),
    );
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    expect(join.matched).toBe(true);
    if (!join.matched) throw new Error("expected a match");
    const explanation = explainNotRestartable(join as ComposeJoin & { matched: true });
    expect(explanation).toContain("`ProbeInline` is not restartable");
    expect(explanation).toContain("always recomposes together with whatever composed it");

    const restartableJoin: ComposeJoin & { matched: true } = {
      ...(join as ComposeJoin & { matched: true }),
      composable: { ...join.composable, restartable: true },
    };
    expect(explainNotRestartable(restartableJoin)).toBeNull();
  });
});

describe("D7 (QA): owned vs foreign unstable types get different remedies", () => {
  it("owned — the type has its own entry in a report under the root — gets the annotate/val remedy", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Screens.kt", '@Composable\nfun LeakyRow(highlight: RowHighlight) { Modifier.portholeNode("Cart.ItemRow") }\n');
    writeReport(
      root,
      "app",
      baseReport({
        composables: [
          composable({
            name: "LeakyRow",
            skippable: false,
            parameters: [{ name: "highlight", type: "RowHighlight", stable: false, unused: false }],
          }),
        ],
        classes: [
          {
            name: "RowHighlight",
            stable: false,
            runtimeStability: "Unstable",
            properties: [{ name: "tappedAt", mutable: true, stable: true, stability: "stable", type: "Long" }],
          },
        ],
      }),
    );
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    if (!join.matched) throw new Error("expected a match");
    const explanation = explainNotSkippable(join as ComposeJoin & { matched: true });
    expect(explanation).toContain("Annotate it `@Immutable`/`@Stable`, or make the property `val`.");
  });

  it("foreign — no report anywhere mentions the type — gets the stabilityConfigurationFile remedy, not a bare 'is unstable'", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Screens.kt", '@Composable\nfun LeakyRow(items: List<CartItem>) { Modifier.portholeNode("Cart.ItemRow") }\n');
    writeReport(
      root,
      "app",
      baseReport({
        composables: [
          composable({
            name: "LeakyRow",
            skippable: false,
            parameters: [{ name: "items", type: "List<CartItem>", stable: false, unused: false }],
          }),
        ],
        classes: [], // CartItem/List never shows up in any report — a foreign, library-shaped type
      }),
    );
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    if (!join.matched) throw new Error("expected a match");
    // Mutation quoted: before D7's fix, an unmatched `findClass` produced no
    // second sentence at all — this assertion is what "a bare 'is unstable'
    // with no remedy" fails.
    const explanation = explainNotSkippable(join as ComposeJoin & { matched: true });
    expect(explanation).toContain(
      "`List` was not compiled with the Compose compiler in this build; declare it stable in a " +
        "stability configuration file (compose compiler `stabilityConfigurationFile`).",
    );
  });

  it("owned in a DIFFERENT module's report than the composable's own still counts as owned", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/Screens.kt", '@Composable\nfun LeakyRow(highlight: RowHighlight) { Modifier.portholeNode("Cart.ItemRow") }\n');
    writeReport(
      root,
      "app",
      baseReport({
        module: "app",
        composables: [
          composable({
            name: "LeakyRow",
            skippable: false,
            parameters: [{ name: "highlight", type: "RowHighlight", stable: false, unused: false }],
          }),
        ],
        classes: [], // RowHighlight is declared in a different module's report
      }),
    );
    writeReport(
      root,
      "core/design",
      baseReport({
        module: "design",
        composables: [],
        classes: [
          {
            name: "RowHighlight",
            stable: false,
            runtimeStability: "Unstable",
            properties: [{ name: "tappedAt", mutable: true, stable: true, stability: "stable", type: "Long" }],
          },
        ],
      }),
    );
    useProjectRoot(root);

    const join = joinComposableNode("Cart.ItemRow");
    if (!join.matched) throw new Error("expected a match");
    const explanation = explainNotSkippable(join as ComposeJoin & { matched: true });
    expect(explanation).toContain("Annotate it `@Immutable`/`@Stable`");
    expect(explanation).not.toContain("stabilityConfigurationFile");
  });
});

describe("D8 (QA): the source fingerprint is cached per moduleRoot, not recomputed per node", () => {
  it("a second staleness() call within the TTL reuses the cached fingerprint rather than re-walking the tree", () => {
    const root = temporaryRoot();
    write(root, "app/src/main/kotlin/A.kt", "class A\n");
    const report: ComposeReportFile = {
      reportPath: path.join(root, "app/build/porthole/compose-report.json"),
      moduleRoot: path.join(root, "app"),
      generatedAt: "2026-09-19T00:00:00.000Z",
      variant: "debug",
      module: "app",
      kotlinVersion: "2.1.0",
      gitHead: "abc123",
      sourceFingerprint: currentSourceFingerprint(path.join(root, "app")),
      composables: [],
      classes: [],
    };

    let now = 1_000;
    setComposeReportClockForTests(() => now);
    expect(staleness(report).stale).toBe(false);

    // The tree changes, but well inside the TTL — a cached fingerprint,
    // still describing the tree as it was, must be what a second call
    // reuses, not a fresh (and now different) walk.
    write(root, "app/src/main/kotlin/A.kt", "class A { val x = 1 }\n");
    now += 1_000;
    expect(staleness(report).stale).toBe(false);

    // Past the TTL, a fresh walk finally notices the real change.
    now += 10_000;
    expect(staleness(report).stale).toBe(true);
  });
});

/**
 * Coordinator follow-up to GRA-69: the report is *always* compiled with
 * strong skipping forced off (`ComposeCompilerWiring.configure`, Gradle
 * side), so "restartable but not skippable" is not necessarily true of the
 * app as it actually ships once the consuming module's own build leaves
 * Kotlin's modern default (strong skipping on) in place. An agent reads the
 * finding text and the tool description, never the README, so the caveat
 * has to be part of the explanation string itself.
 */
describe("strongSkippingInBuild caveat (coordinator follow-up)", () => {
  function joinWith(strongSkippingInBuild: boolean | "unknown"): ComposeJoin & { matched: true } {
    const root = temporaryRoot();
    write(
      root,
      "app/src/main/kotlin/com/example/shop/ui/Screens.kt",
      "package com.example.shop.ui\n" +
        "@Composable\n" +
        "fun LeakyRow(highlight: RowHighlight) {\n" +
        '  Modifier.portholeNode("Cart.ItemRow")\n' +
        "}\n",
    );
    const realFingerprint = currentSourceFingerprint(path.join(root, "app"));
    writeReport(
      root,
      "app",
      baseReport({
        module: "app",
        sourceFingerprint: realFingerprint,
        strongSkippingInBuild,
        composables: [
          composable({
            name: "LeakyRow",
            packageName: "com.example.shop.ui",
            skippable: false,
            parameters: [{ name: "highlight", type: "RowHighlight", stable: false, unused: false }],
          }),
        ],
      }),
    );
    useProjectRoot(root);
    const join = joinComposableNode("Cart.ItemRow");
    if (!join.matched) throw new Error("expected a match");
    return join as ComposeJoin & { matched: true };
  }

  it("appends the caveat when the report was compiled with strong skipping off but the build has it on", () => {
    const explanation = explainNotSkippable(joinWith(true));
    // Mutation quoted: flipping strongSkippingCaveat's guard from
    // `report.strongSkippingInBuild !== true` to
    // `report.strongSkippingInBuild === true` inverts which branch gets the
    // sentence — this assertion only passes with the guard as written.
    expect(explanation).toContain(
      "Compiled with strong skipping off for this report; your build has it on, so this composable " +
        "is skipped only when the caller passes the same `RowHighlight` instance — a new instance " +
        "per recomposition still recomposes it.",
    );
  });

  it("says nothing extra when the consuming module's own build also has strong skipping off", () => {
    const explanation = explainNotSkippable(joinWith(false));
    expect(explanation).not.toContain("Compiled with strong skipping off for this report");
    expect(explanation).not.toContain("your build has it on");
  });

  it("says nothing extra when whether the build has strong skipping on could not be determined", () => {
    const explanation = explainNotSkippable(joinWith("unknown"));
    expect(explanation).not.toContain("Compiled with strong skipping off for this report");
  });

  it("exposes strongSkippingInBuild on the joined report regardless of whether the caveat fires", () => {
    // The coordinator asked for this to be exposed on the join itself, not
    // just baked into the prose — a caller building its own message needs
    // the raw fact.
    expect(joinWith(true).report.strongSkippingInBuild).toBe(true);
    expect(joinWith(false).report.strongSkippingInBuild).toBe(false);
    expect(joinWith("unknown").report.strongSkippingInBuild).toBe("unknown");
  });
});
