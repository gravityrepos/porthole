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
  explainNotSkippable,
  explainSkippableButUnstable,
  findComposeReportPaths,
  joinComposableNode,
  resetComposeReportCacheForTests,
  setComposeReportClockForTests,
  staleness,
  type ComposeJoin,
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
   * (captured 2026-09-20, `git rev-parse HEAD` `b2477c1` plus GRA-69's own
   * `RowHighlight`/`LeakyRow` edit — see `composeReportFixtures/PROVENANCE.md`
   * on the Gradle-plugin side for the matching half of this proof). If this
   * ever goes red on an unrelated PR, the two implementations have drifted —
   * a real bug, not a fixture that needs a bump — unless `sample/`'s own
   * `.kt` sources genuinely changed, which is exactly the case this pin
   * exists to force a human to notice and re-verify against a fresh
   * `./gradlew :sample:portholeComposeReport` run.
   */
  it("matches the real Gradle-computed fingerprint for this repo's own sample module", () => {
    const sampleRoot = path.join(WORKTREE_ROOT, "sample");
    expect(currentSourceFingerprint(sampleRoot)).toBe(
      "1bc2ebe0281d8c2b86b1900161605640abe9526aeadc60a15c433893ee091c15",
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
        "`RowHighlight` is unstable because it has a `var` property (`tappedAt`).",
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
    expect(join.candidates).toEqual(
      expect.arrayContaining([
        { module: "app", packageName: "com.a" },
        { module: "other", packageName: "com.b" },
      ]),
    );
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
