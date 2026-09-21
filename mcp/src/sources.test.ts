// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CACHE_TTL_MS,
  parseFrame,
  resetSourceIndexForTests,
  setClockForTests,
  setWalkFileCapForTests,
  sourceIndexStats,
  whereForFrame,
  whereForName,
  type Where,
} from "./sources.js";

/**
 * GRA-201's fixture tree: two modules (`app`, `core/network`) under one
 * project root, exactly the shape the ticket's own example is about — "the
 * file is in `core/network`, not `app`". `app/build/` carries a decoy
 * `FixtureCartViewModel.kt` with the same basename as the real one, which
 * every test implicitly relies on being excluded (a walk that did not skip
 * `build/` would make every "resolves to exactly one" assertion below
 * false).
 *
 * Named `FixtureCartViewModel`/`Fixture.PromoField`, not the sample app's
 * own `CartViewModel`/`Cart.PromoField` (`../../sample/src/main/kotlin/
 * com/example/shop/ui/`) — this directory sits under `mcp/src/`, itself a
 * `src/` segment, so a walk rooted at the whole worktree (exactly what
 * `sources.sample.test.ts` runs) would otherwise find this fixture and the
 * real sample file at once and call every one of them ambiguous.
 */
const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/sources", import.meta.url));

let roots: string[] = [];
let savedProjectRoot: string | undefined;

function temporaryRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "porthole-sources-"));
  roots.push(directory);
  return directory;
}

function writeSource(root: string, modulePath: string, contents: string): string {
  const full = path.join(root, ...modulePath.split("/"));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
  return modulePath;
}

function useProjectRoot(root: string | undefined): void {
  if (root === undefined) delete process.env.PORTHOLE_PROJECT_ROOT;
  else process.env.PORTHOLE_PROJECT_ROOT = root;
}

beforeEach(() => {
  savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
  resetSourceIndexForTests();
});

afterEach(() => {
  useProjectRoot(savedProjectRoot);
  setWalkFileCapForTests(null);
  setClockForTests(null);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("parseFrame", () => {
  it("reads the file and line off StackFormat.kt's own rendering", () => {
    expect(
      parseFrame("com.example.shop.ui.CartViewModel.blockTheMainThread(CartViewModel.kt:148)"),
    ).toEqual({ file: "CartViewModel.kt", line: 148, packageName: "com.example.shop.ui" });
  });

  it("returns null for a native frame -- StackFormat renders fileName ?? \"?\" -- rather than inventing a file called '?'", () => {
    expect(parseFrame("java.lang.Object.wait(?:-2)")).toBeNull();
  });

  it("returns null for an unknown-source frame (lineNumber -1)", () => {
    expect(parseFrame("com.example.Foo.bar(?:-1)")).toBeNull();
  });

  it("returns null for a line with nothing resembling a stack frame", () => {
    expect(parseFrame("not a stack frame at all")).toBeNull();
  });

  it("returns a null line, not a throw, when the frame has no usable line number", () => {
    expect(parseFrame("com.example.Foo.bar(Foo.kt:0)")).toEqual({
      file: "Foo.kt",
      line: null,
      packageName: "com.example",
    });
  });

  it("returns a null packageName for a bare, unqualified frame -- nothing lowercase at the front to be a package", () => {
    expect(parseFrame("CartViewModel.blockTheMainThread(CartViewModel.kt:1)")).toEqual({
      file: "CartViewModel.kt",
      line: 1,
      packageName: null,
    });
  });

  it("QA F20: a package segment may carry uppercase letters past its first character -- com.exampleApp.shop, not truncated to com", () => {
    // Before F20, packageFromQualifiedFrame required every character of a
    // package segment to be lowercase, so `exampleApp` failed the test and
    // the split stopped one segment early -- `packageName` came back "com"
    // instead of "com.exampleApp.shop", silently wrong rather than null.
    expect(
      parseFrame("com.exampleApp.shop.CartViewModel.blockTheMainThread(CartViewModel.kt:1)"),
    ).toEqual({
      file: "CartViewModel.kt",
      line: 1,
      packageName: "com.exampleApp.shop",
    });
  });
});

describe("whereForFrame against the two-module fixture", () => {
  beforeEach(() => useProjectRoot(FIXTURE_ROOT));

  it("resolves a top frame naming a file that exists once, with its line", () => {
    const where = whereForFrame(
      "com.example.shop.ui.FixtureCartViewModel.blockTheMainThread(FixtureCartViewModel.kt:11)",
    );
    expect(where).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/com/example/shop/ui/FixtureCartViewModel.kt",
      line: 11,
      kind: "frame",
    });
  });

  it("finds the file in core/network, not app -- the ticket's own example", () => {
    const where = whereForFrame("com.example.network.ApiClient.fetchCart(ApiClient.kt:4)");
    expect(where).toEqual({
      resolved: true,
      path: "core/network/src/main/kotlin/com/example/network/ApiClient.kt",
      line: 4,
      kind: "frame",
    });
  });

  it("never resolves into build/ -- the decoy FixtureCartViewModel.kt there does not make the real one ambiguous", () => {
    // If build/ were walked, this would come back ambiguous instead of
    // resolved (two FixtureCartViewModel.kt on disk) -- the mutation this
    // proves: deleting `if (SKIP_DIRS.has(entry.name)) continue;` from the
    // directory branch of sources.ts's walk() turns this "resolved: true"
    // into "resolved: false, reason: ambiguous".
    const where = whereForFrame("x.FixtureCartViewModel.blockTheMainThread(FixtureCartViewModel.kt:11)");
    expect(where).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/com/example/shop/ui/FixtureCartViewModel.kt",
      line: 11,
      kind: "frame",
    });
  });

  it("says 'not found' for a file genuinely not under the root", () => {
    // Bare, unqualified frame -- deliberately no package prefix, so this
    // proves the plain basename-miss path rather than GRA-205's
    // package-aware "not in project" (see the "not in project" describe
    // block below for that one).
    expect(whereForFrame("Ghost.method(Ghost.kt:1)")).toEqual({
      resolved: false,
      reason: "not found",
    });
  });

  it("says 'synthetic' for a frame StackFormat itself could not source-map", () => {
    expect(whereForFrame("java.lang.Thread.sleep(?:-2)")).toEqual({
      resolved: false,
      reason: "synthetic",
    });
  });

  it("attaches no where at all for an absent frame -- undefined, not a resolved: false object", () => {
    expect(whereForFrame(undefined)).toBeUndefined();
    expect(whereForFrame("")).toBeUndefined();
  });
});

describe("whereForFrame: ambiguous when a name exists twice under src/", () => {
  it("resolved: false, reason: ambiguous -- two CartViewModel.kt, neither under build/, both candidates listed (GRA-205)", () => {
    const root = temporaryRoot();
    writeSource(root, "app/src/main/kotlin/CartViewModel.kt", "class CartViewModel");
    writeSource(root, "legacy/src/main/kotlin/CartViewModel.kt", "class CartViewModel");
    useProjectRoot(root);

    // Mutation quoted (final report): replacing `candidates: [...matches]`
    // with `candidates: []` in resolveFile's ambiguous branch leaves this
    // assertion failing on an empty array instead of both paths.
    expect(whereForFrame("x.CartViewModel.blockTheMainThread(CartViewModel.kt:1)")).toEqual({
      resolved: false,
      reason: "ambiguous",
      candidates: ["app/src/main/kotlin/CartViewModel.kt", "legacy/src/main/kotlin/CartViewModel.kt"],
    });
  });
});

/**
 * GRA-201 follow-up: the multi-module case this ticket exists for. Two
 * `Repository.kt` in the fixture, one per module, in different packages
 * (`com.example.shop.data`, `com.example.network.data`) -- the fully
 * qualified name a stack frame or a registered `state` owner may carry is
 * enough to tell them apart even though the bare file/class name alone
 * cannot.
 */
describe("package disambiguation: a fully qualified frame narrows an otherwise-ambiguous file", () => {
  beforeEach(() => useProjectRoot(FIXTURE_ROOT));

  const REPOSITORY_CANDIDATES = [
    "app/src/main/kotlin/com/example/shop/data/Repository.kt",
    "core/network/src/main/kotlin/com/example/network/data/Repository.kt",
  ];

  it("resolves the app module's Repository.kt from its own package", () => {
    const where = whereForFrame(
      "com.example.shop.data.Repository.fetch(Repository.kt:9)",
    );
    expect(where).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/com/example/shop/data/Repository.kt",
      line: 9,
      kind: "frame",
    });
  });

  it("resolves core/network's Repository.kt from its own, different package", () => {
    const where = whereForFrame(
      "com.example.network.data.Repository.fetch(Repository.kt:6)",
    );
    expect(where).toEqual({
      resolved: true,
      path: "core/network/src/main/kotlin/com/example/network/data/Repository.kt",
      line: 6,
      kind: "frame",
    });
  });

  it("falls back to plain ambiguous when the frame's package matches neither file -- never picks one of several", () => {
    const where = whereForFrame("com.example.other.Repository.fetch(Repository.kt:1)");
    expect(where).toEqual({ resolved: false, reason: "ambiguous", candidates: REPOSITORY_CANDIDATES });
  });

  it("stays ambiguous with no package at all in the frame -- the pre-follow-up baseline is unchanged", () => {
    const where = whereForFrame("x.Repository.fetch(Repository.kt:1)");
    expect(where).toEqual({ resolved: false, reason: "ambiguous", candidates: REPOSITORY_CANDIDATES });
  });

  it("whereForName resolves a fully qualified class name the same way", () => {
    expect(whereForName("com.example.shop.data.Repository")).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/com/example/shop/data/Repository.kt",
      line: 8,
      kind: "declaration",
    });
    expect(whereForName("com.example.network.data.Repository")).toEqual({
      resolved: true,
      path: "core/network/src/main/kotlin/com/example/network/data/Repository.kt",
      line: 5,
      kind: "declaration",
    });
  });

  it("whereForName stays ambiguous for the bare class name -- unqualified evidence is unaffected", () => {
    expect(whereForName("Repository")).toEqual({
      resolved: false,
      reason: "ambiguous",
      candidates: REPOSITORY_CANDIDATES,
    });
  });

  it("does not mistake a composable label for a qualified class name -- Cart.PromoField still resolves as a label", () => {
    // Regression guard for splitQualifiedClassName: "Cart" is capitalised,
    // so it must fail the all-lowercase-package test and this must resolve
    // exactly as the label-index tests above already prove it does, not
    // fall through to a package-filtered (and therefore "not found") path.
    expect(whereForName("Fixture.PromoField")).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/com/example/shop/ui/FixtureScreens.kt",
      line: 14,
      kind: "declaration",
    });
  });
});

describe("the off switch: PORTHOLE_PROJECT_ROOT unset", () => {
  it("whereForFrame returns undefined even for a frame that would otherwise resolve", () => {
    useProjectRoot(undefined);
    expect(
      whereForFrame(
        "com.example.shop.ui.FixtureCartViewModel.blockTheMainThread(FixtureCartViewModel.kt:11)",
      ),
    ).toBeUndefined();
  });

  it("whereForName returns undefined too", () => {
    useProjectRoot(undefined);
    expect(whereForName("Fixture.PromoField")).toBeUndefined();
  });

  it("never walks the filesystem at all when the feature is off", () => {
    useProjectRoot(undefined);
    whereForFrame("x.Foo.bar(Foo.kt:1)");
    whereForName("Fixture.PromoField");
    expect(sourceIndexStats.walks).toBe(0);
  });
});

describe("whereForName: the composable/state-owner label index", () => {
  beforeEach(() => useProjectRoot(FIXTURE_ROOT));

  it("resolves a portholeNode label to where it is written, not to a declared function", () => {
    expect(whereForName("Fixture.PromoField")).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/com/example/shop/ui/FixtureScreens.kt",
      line: 14,
      kind: "declaration",
    });
  });

  it("resolves a plain class name -- a `state` owner registered under its own class name", () => {
    expect(whereForName("FixtureCartViewModel")).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/com/example/shop/ui/FixtureCartViewModel.kt",
      line: 8,
      kind: "declaration",
    });
  });

  it("says 'not found' for a name nothing in source declares or labels", () => {
    expect(whereForName("Checkout.NoSuchField")).toEqual({ resolved: false, reason: "not found" });
  });

  it("says 'synthetic' for a name the collector invented, without touching the filesystem", () => {
    expect(whereForName("<unnamed:SnapshotMutableStateImpl#3f2a>")).toEqual({
      resolved: false,
      reason: "synthetic",
    });
    // Provably never walked for this one -- a synthetic name is rejected
    // before the index is even asked for.
    expect(sourceIndexStats.walks).toBe(0);
  });

  it("attaches no where at all for an absent name", () => {
    expect(whereForName(undefined)).toBeUndefined();
    expect(whereForName("")).toBeUndefined();
  });
});

describe("whereForName: ambiguous when a label is written twice", () => {
  it("resolved: false, reason: ambiguous", () => {
    const root = temporaryRoot();
    writeSource(
      root,
      "app/src/main/kotlin/Screens.kt",
      '@Composable\nfun A() { Modifier.portholeNode("Cart.PromoField") }\n',
    );
    writeSource(
      root,
      "app/src/main/kotlin/OtherScreens.kt",
      '@Composable\nfun B() { Modifier.portholeNode("Cart.PromoField") }\n',
    );
    useProjectRoot(root);

    expect(whereForName("Cart.PromoField")).toEqual({
      resolved: false,
      reason: "ambiguous",
      candidates: ["app/src/main/kotlin/OtherScreens.kt", "app/src/main/kotlin/Screens.kt"],
    });
  });
});

describe("the index is built once and reused across calls", () => {
  beforeEach(() => useProjectRoot(FIXTURE_ROOT));

  it("a second whereForFrame call against the same root does not re-walk", () => {
    whereForFrame("x.FixtureCartViewModel.blockTheMainThread(FixtureCartViewModel.kt:11)");
    whereForFrame("x.ApiClient.fetchCart(ApiClient.kt:4)");
    expect(sourceIndexStats.walks).toBe(1);
  });

  it("whereForName reuses the same walk whereForFrame already paid for", () => {
    whereForFrame("x.FixtureCartViewModel.blockTheMainThread(FixtureCartViewModel.kt:11)");
    whereForName("Fixture.PromoField");
    expect(sourceIndexStats.walks).toBe(1);
  });

  it("the name index itself is parsed once, even across many whereForName calls", () => {
    whereForName("Fixture.PromoField");
    whereForName("FixtureCartViewModel");
    whereForName("Checkout.NoSuchField");
    expect(sourceIndexStats.nameIndexBuilds).toBe(1);
  });
});

describe("201-B: the TTL actually expires and re-walks", () => {
  it("re-walks once the clock has moved past CACHE_TTL_MS, not merely on the next call", () => {
    const root = temporaryRoot();
    writeSource(root, "app/src/main/kotlin/Foo.kt", "class Foo");
    useProjectRoot(root);

    // The clock is injected rather than slept on: `getEntry` reads `clock()`
    // instead of `Date.now()` under test, so "time has passed" is a plain
    // variable assignment, not a real wait this suite would otherwise pay
    // for on every run.
    let now = 1_000_000_000;
    setClockForTests(() => now);

    whereForFrame("x.Foo.method(Foo.kt:1)");
    expect(sourceIndexStats.walks).toBe(1);

    // Still inside the TTL: reused, not re-walked.
    now += CACHE_TTL_MS - 1;
    whereForFrame("x.Foo.method(Foo.kt:1)");
    expect(sourceIndexStats.walks).toBe(1);

    // Past it: the next lookup re-walks.
    now += 2;
    whereForFrame("x.Foo.method(Foo.kt:1)");
    expect(sourceIndexStats.walks).toBe(2);
  });
});

describe("the walk cap", () => {
  it("stops collecting once the cap is reached, and says so instead of 'not found'", () => {
    const root = temporaryRoot();
    writeSource(root, "app/src/main/kotlin/AAA.kt", "class AAA");
    writeSource(root, "app/src/main/kotlin/BBB.kt", "class BBB");
    writeSource(root, "app/src/main/kotlin/CCC.kt", "class CCC");
    useProjectRoot(root);
    setWalkFileCapForTests(2);

    // Whichever two of the three the walk reached, a name that is
    // definitely not among them must say the walk was capped, not that it
    // searched everywhere and came up empty -- those are different claims,
    // and only one of them is true here.
    expect(whereForFrame("x.Ghost.method(ZZZ_never_written.kt:1)")).toEqual({
      resolved: false,
      reason: "too many source files under the project root to search them all",
    });
  });
});

/**
 * 201-B: `build/` already has a decoy proving exclusion (the committed
 * fixture's `app/build/src/.../FixtureCartViewModel.kt`) -- these are the
 * same proof for the other three SKIP_DIRS entries, which had none. Each
 * decoy shares a basename with a real file elsewhere in the same tree, so
 * a walk that failed to skip it would turn "resolved" into "ambiguous" --
 * the identical failure mode the `build/` test already relies on.
 */
describe("the walk skips node_modules/, .gradle/ and .git/, not only build/", () => {
  it("node_modules/ is never walked", () => {
    const root = temporaryRoot();
    writeSource(root, "app/src/main/kotlin/RealOnly.kt", "class RealOnly");
    writeSource(root, "node_modules/some-package/src/RealOnly.kt", "class RealOnly");
    useProjectRoot(root);

    expect(whereForFrame("x.RealOnly.method(RealOnly.kt:1)")).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/RealOnly.kt",
      line: 1,
      kind: "frame",
    });
  });

  it(".gradle/ is never walked", () => {
    const root = temporaryRoot();
    writeSource(root, "app/src/main/kotlin/RealOnly.kt", "class RealOnly");
    writeSource(root, ".gradle/caches/src/RealOnly.kt", "class RealOnly");
    useProjectRoot(root);

    expect(whereForFrame("x.RealOnly.method(RealOnly.kt:1)")).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/RealOnly.kt",
      line: 1,
      kind: "frame",
    });
  });

  it(".git/ is never walked", () => {
    const root = temporaryRoot();
    writeSource(root, "app/src/main/kotlin/RealOnly.kt", "class RealOnly");
    writeSource(root, ".git/objects/src/RealOnly.kt", "class RealOnly");
    useProjectRoot(root);

    expect(whereForFrame("x.RealOnly.method(RealOnly.kt:1)")).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/RealOnly.kt",
      line: 1,
      kind: "frame",
    });
  });
});

describe("a symlink that escapes the project root", () => {
  it.skipIf(process.platform === "win32")(
    "is never followed -- a file only reachable through it is not found",
    () => {
      const root = temporaryRoot();
      const outside = temporaryRoot();
      writeSource(outside, "src/main/kotlin/Outside.kt", "class Outside");
      try {
        symlinkSync(path.join(outside, "src"), path.join(root, "escaped"), "dir");
      } catch {
        return; // no permission to create symlinks on this machine -- nothing to assert
      }
      mkdirSync(path.join(root, "app/src/main/kotlin"), { recursive: true });
      useProjectRoot(root);

      // Bare, unqualified frame -- no package prefix, so this stays a pure
      // basename-miss proof (the escaped symlink is never walked, so the
      // file is never found) rather than exercising GRA-205's
      // package-aware "not in project", which is proved separately.
      expect(whereForFrame("Outside.method(Outside.kt:1)")).toEqual({
        resolved: false,
        reason: "not found",
      });
    },
  );
});

describe("a symlink cycle inside the project root", () => {
  it.skipIf(process.platform === "win32")(
    "does not multiply a file's matches -- 201-A: a real declaration still resolves, not 'ambiguous'",
    () => {
      const root = temporaryRoot();
      const kotlinDir = path.join(root, "app/src/main/kotlin");
      writeSource(root, "app/src/main/kotlin/UniqueClass.kt", "class UniqueClass");
      try {
        // The ticket's own example: app/src/main/kotlin/loop -> .. (the
        // directory's own parent, `app/src/main`) -- walking into `loop`
        // reaches `main`, which contains `kotlin` again, which contains
        // `loop` again, forever, without the visited-directories guard.
        symlinkSync("..", path.join(kotlinDir, "loop"), "dir");
      } catch {
        return; // no permission to create symlinks on this machine -- nothing to assert
      }
      useProjectRoot(root);

      // Mutation quoted (final report): removing
      // `if (visitedDirs.has(real)) continue;` from sources.ts's walk()
      // turns this into "ambiguous" -- UniqueClass.kt collected once per
      // lap around the cycle before readdirSync finally throws on a path
      // too long for the OS to open.
      expect(whereForFrame("x.UniqueClass.method(UniqueClass.kt:1)")).toEqual({
        resolved: true,
        path: "app/src/main/kotlin/UniqueClass.kt",
        line: 1,
        kind: "frame",
      });
    },
  );
});

/**
 * GRA-205: "a resolved `where` carries a line and refuses ambiguity, so it
 * is a breakpoint address." Two things this addendum to GRA-201 adds:
 *
 *  - every `resolved: true` carries a real, numeric `line` and says whether
 *    it came from the evidence itself (`kind: "frame"`) or from the
 *    declaration `whereForName` found for a name that never had a line to
 *    begin with (`kind: "declaration"`) -- proved once per producer below,
 *    against the same two-module fixture the rest of this file uses;
 *  - a lookup that matched nothing distinguishes "genuinely not in this
 *    project" (a library frame -- the evidence named a package, and nothing
 *    under the root is authored in it) from a plain "not found" -- proved
 *    against a fabricated `okhttp3.internal.connection.RealCall` frame and
 *    class name, neither of which the fixture (or any real project) ever
 *    contains.
 */
describe("GRA-205: a resolved where is a breakpoint address", () => {
  beforeEach(() => useProjectRoot(FIXTURE_ROOT));

  /**
   * whereForFrame and whereForName are the only two producers of a `Where`
   * in this module -- every finding in trace.ts/index.ts attaches one or
   * the other, never constructs one itself (see their own call sites). One
   * resolvable case per producer is enough to prove the invariant holds at
   * its source, rather than trusting it by resemblance at every call site.
   *
   * Mutation quoted (final report): dropping `kind: "frame"` from
   * whereForFrame's `resolved: true` return, or `kind: "declaration"` from
   * either of whereForName's, still type-checks against the pre-GRA-205
   * `Where` shape but fails the `kind` assertion here; dropping `line:` (or
   * returning `line: 0`) fails the `typeof line === "number" && line > 0`
   * assertion instead.
   */
  const producers: Array<[string, () => Where | undefined]> = [
    [
      "whereForFrame",
      () =>
        whereForFrame(
          "com.example.shop.ui.FixtureCartViewModel.blockTheMainThread(FixtureCartViewModel.kt:11)",
        ),
    ],
    ["whereForName", () => whereForName("Fixture.PromoField")],
  ];

  it.each(producers)("%s: resolved: true always carries a numeric line and its kind", (_label, produce) => {
    const where = produce();
    if (!where?.resolved) throw new Error("expected a resolved Where to test the invariant against");
    expect(typeof where.line).toBe("number");
    expect(where.line).toBeGreaterThan(0);
    expect(["frame", "declaration"]).toContain(where.kind);
  });

  it("whereForFrame: a library frame -- source not under the root at all -- says 'not in project', not 'not found'", () => {
    // okhttp3 is never vendored into this fixture (or any project this
    // resolves against); its own package owns no directory anywhere under
    // the root, which is exactly the fact "not in project" reports.
    // Mutation quoted (final report): deleting the
    // `if (packageName && packageLooksExternal(...))` branch from
    // resolveFile turns this into "not found" instead.
    expect(
      whereForFrame("okhttp3.internal.connection.RealCall.execute(RealCall.kt:255)"),
    ).toEqual({ resolved: false, reason: "not in project" });
  });

  it("whereForName: a fully qualified library class says 'not in project' the same way", () => {
    expect(whereForName("okhttp3.internal.connection.RealCall")).toEqual({
      resolved: false,
      reason: "not in project",
    });
  });

  it("unqualified evidence never triggers the heuristic -- both stay plain 'not found'", () => {
    // No package to check a directory for, so this is exactly the
    // pre-GRA-205 behaviour.
    expect(whereForFrame("Ghost.method(Ghost.kt:1)")).toEqual({ resolved: false, reason: "not found" });
    expect(whereForName("Checkout.NoSuchField")).toEqual({ resolved: false, reason: "not found" });
  });
});

/**
 * QA F20 (2026-09-2x round): package narrowing end to end with a mixed-case
 * package segment (`com.exampleApp.shop`, not `com.example.shop`) -- the
 * regression the direct `parseFrame`/`packageFromQualifiedFrame` test above
 * cannot fully prove on its own, since narrowing also depends on
 * `splitQualifiedClassName` (whereForName's own qualified-name path) having
 * the identical fix.
 */
describe("QA F20: mixed-case package segments narrow correctly end to end", () => {
  it("whereForFrame narrows to the right file when the frame's package has an uppercase-carrying segment", () => {
    const root = temporaryRoot();
    writeSource(root, "app/src/main/kotlin/com/exampleApp/shop/Repository.kt", "package com.exampleApp.shop\nclass Repository\n");
    writeSource(root, "legacy/src/main/kotlin/com/example/other/Repository.kt", "package com.example.other\nclass Repository\n");
    useProjectRoot(root);

    const where = whereForFrame("com.exampleApp.shop.Repository.fetch(Repository.kt:2)");
    expect(where).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/com/exampleApp/shop/Repository.kt",
      line: 2,
      kind: "frame",
    });
  });

  it("whereForName narrows a fully qualified name through the same mixed-case package", () => {
    const root = temporaryRoot();
    writeSource(root, "app/src/main/kotlin/com/exampleApp/shop/Repository.kt", "package com.exampleApp.shop\nclass Repository\n");
    writeSource(root, "legacy/src/main/kotlin/com/example/other/Repository.kt", "package com.example.other\nclass Repository\n");
    useProjectRoot(root);

    expect(whereForName("com.exampleApp.shop.Repository")).toEqual({
      resolved: true,
      path: "app/src/main/kotlin/com/exampleApp/shop/Repository.kt",
      line: 2,
      kind: "declaration",
    });
  });
});

/**
 * QA F19: a name declared twice in the *same* file (a class and a function
 * sharing an identifier -- legal Kotlin, different namespaces) must not
 * make that one file count twice in `candidates` when the name is also
 * ambiguous across files.
 */
describe("QA F19: ambiguous candidates are de-duped by path", () => {
  it("whereForName never lists the same path twice, even when that file declares the name twice over", () => {
    const root = temporaryRoot();
    // Both a `class Dup` and a `fun Dup(...)` in the same file -- two
    // Declaration entries, one path.
    writeSource(
      root,
      "app/src/main/kotlin/Dup.kt",
      "class Dup\nfun Dup(): Dup = Dup()\n",
    );
    writeSource(root, "legacy/src/main/kotlin/OtherDup.kt", "class Dup\n");
    useProjectRoot(root);

    const where = whereForName("Dup");
    expect(where).toMatchObject({ resolved: false, reason: "ambiguous" });
    if (where && !where.resolved && where.reason === "ambiguous") {
      expect(where.candidates).toEqual([
        "app/src/main/kotlin/Dup.kt",
        "legacy/src/main/kotlin/OtherDup.kt",
      ]);
      // The load-bearing assertion: no path repeats.
      expect(new Set(where.candidates).size).toBe(where.candidates.length);
    }
  });
});
