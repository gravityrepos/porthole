// Tests for readmeFigure's parsing, not for the CLI end to end (that is
// exercised for real by pr.yml running the script against real JUnit XML).
// Node's built-in test runner, not vitest: this file lives in mcp/scripts/,
// which mcp/vitest.config.ts's `include: ["src/**/*.test.ts"]` deliberately
// does not reach — a check script counted among the tests it checks would
// inflate the very total README states, and "run `npm test`" would then
// silently stop matching what this file tests. `node --test` needs no
// config and no dependency to run this on its own.
//
// Run: node --test mcp/scripts/check-readme-vitest-counts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readmeFigure } from "./check-readme-vitest-counts.mjs";

const LABEL = "in the MCP server";

test("readmeFigure parses a plain integer figure", () => {
  const md = "451 in the MCP server (`cd mcp && npm test` — 449 passed, 0 failed, 2 skipped)";
  assert.deepEqual(readmeFigure(md, LABEL), { total: 451, passed: 449, failed: 0, skipped: 2 });
});

// The bug QA found: this regex used to match "1,451 in the MCP server (...)"
// starting at "451", silently reporting 451 as the total instead of the
// real 1451. The founder's call, overriding this file's first fix: reject
// the input, or the good error message it needs, was worse than making it
// correct — the total crosses 1,000 the day GRA-174 lands, "1,451" becomes
// the natural way to write it, and a check that fails a correct edit is a
// check people learn to route around. A test count has no decimal reading,
// so unlike most "comma in a number" ambiguity there is no locale where
// stripping it is the wrong call. This pins the CORRECT VALUE, not a
// refusal — a stronger assertion than "returns null", because a check that
// only tests for null would also pass a checker that rejects everything.
test("readmeFigure parses a thousands-separated figure as its real value, not a truncation", () => {
  const md = "1,451 in the MCP server (`cd mcp && npm test` — 449 passed, 0 failed, 2 skipped)";
  assert.deepEqual(readmeFigure(md, LABEL), { total: 1451, passed: 449, failed: 0, skipped: 2 });
});

// Same case, inside the parenthetical rather than the headline number: must
// parse the real value there too, not silently drop the leading digit group.
test("readmeFigure parses a thousands-separated passed count as its real value", () => {
  const md = "451 in the MCP server (`cd mcp && npm test` — 1,449 passed, 0 failed, 2 skipped)";
  assert.deepEqual(readmeFigure(md, LABEL), { total: 451, passed: 1449, failed: 0, skipped: 2 });
});

test("readmeFigure tolerates README's own line-wrapping between the numbers and words", () => {
  const md = "451 in the MCP server (`cd mcp && npm\nrun test` — 449 passed, 0 failed, 0\nskipped)";
  assert.deepEqual(readmeFigure(md, LABEL), { total: 451, passed: 449, failed: 0, skipped: 0 });
});

test("readmeFigure returns null when the sentence is missing entirely", () => {
  assert.equal(readmeFigure("nothing relevant here", LABEL), null);
});
