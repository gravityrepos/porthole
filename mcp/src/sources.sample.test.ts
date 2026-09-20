// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { resetSourceIndexForTests, whereForFrame, whereForName } from "./sources.js";

/**
 * GRA-201 acceptance: "verified on the sample (multi-flavor, one module)".
 *
 * Every other test in sources.test.ts and index.test.ts runs against a
 * fixture tree this ticket wrote. This one runs against the real thing:
 * `PORTHOLE_PROJECT_ROOT` set to the actual worktree root (the same value
 * `portholeMcpConfig` would generate for this checkout — see README's env
 * var table), resolving a frame and a composable label that are genuinely
 * in `sample/src/main/kotlin/com/example/shop/ui/`, not written for this
 * test. If either line number below goes stale (someone edits
 * CartViewModel.kt or Screens.kt without updating this file), this test
 * fails with the resolved line rather than silently passing against the
 * wrong one, because it compares against a computed line, not a literal.
 *
 * This is also why the two-module fixture under `mcp/src/fixtures/sources`
 * is named `FixtureCartViewModel`/`Fixture.PromoField` rather than reusing
 * the sample's own `CartViewModel`/`Cart.PromoField`: this test walks the
 * *whole* worktree, `mcp/src/fixtures` included (it sits under `mcp/src`, a
 * `src/` segment), and a fixture sharing a name with the real sample file
 * would make every lookup below "ambiguous" instead of resolved.
 */
const WORKTREE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

let savedProjectRoot: string | undefined;

beforeEach(() => {
  savedProjectRoot = process.env.PORTHOLE_PROJECT_ROOT;
  resetSourceIndexForTests();
  process.env.PORTHOLE_PROJECT_ROOT = WORKTREE_ROOT;
});

afterEach(() => {
  if (savedProjectRoot === undefined) delete process.env.PORTHOLE_PROJECT_ROOT;
  else process.env.PORTHOLE_PROJECT_ROOT = savedProjectRoot;
  resetSourceIndexForTests();
});

describe("GRA-201 against the real sample app (multi-flavor, one module)", () => {
  it("resolves CartViewModel.blockTheMainThread's real stack frame to sample/src/.../CartViewModel.kt", () => {
    const where = whereForFrame(
      "com.example.shop.ui.CartViewModel.blockTheMainThread(CartViewModel.kt:142)",
    );
    expect(where).toEqual({
      resolved: true,
      path: "sample/src/main/kotlin/com/example/shop/ui/CartViewModel.kt",
      line: 142,
    });
  });

  it("resolves the real Cart.PromoField portholeNode label to Screens.kt, not to a declared function of that name", () => {
    const where = whereForName("Cart.PromoField");
    expect(where).toEqual({
      resolved: true,
      path: "sample/src/main/kotlin/com/example/shop/ui/Screens.kt",
      // GRA-69 added a few lines above this label (the RowHighlight fixture
      // for portholeComposeReport's own join) — this line moving from 83 is
      // exactly what the class doc comment above warns this test is for.
      line: 88,
    });
  });

  it("resolves CartScreen's PortholeScreen label the same way", () => {
    const where = whereForName("Cart");
    expect(where).toEqual({
      resolved: true,
      path: "sample/src/main/kotlin/com/example/shop/ui/Screens.kt",
      line: 60,
    });
  });
});
