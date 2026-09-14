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
// starting at "451", silently reporting 451 as the total instead of failing
// to find a figure at all. The chosen fix is REJECTION, not correct parsing
// of the comma — a comma-grouped number has never appeared in this
// paragraph, so there is no real case to parse correctly, only a wrong
// answer to stop returning. readmeFigure must come back null here, the same
// as if the number were missing outright, so the caller reports "could not
// find a figure" (a loud failure) instead of a wrong count.
test("readmeFigure rejects a thousands-separated figure instead of truncating it", () => {
  const md = "1,451 in the MCP server (`cd mcp && npm test` — 449 passed, 0 failed, 2 skipped)";
  assert.equal(readmeFigure(md, LABEL), null);
});

// Same failure mode, inside the parenthetical rather than the headline
// number: must not silently drop the leading digit group there either.
test("readmeFigure rejects a thousands-separated passed count", () => {
  const md = "451 in the MCP server (`cd mcp && npm test` — 1,449 passed, 0 failed, 2 skipped)";
  assert.equal(readmeFigure(md, LABEL), null);
});

test("readmeFigure tolerates README's own line-wrapping between the numbers and words", () => {
  const md = "451 in the MCP server (`cd mcp && npm\nrun test` — 449 passed, 0 failed, 0\nskipped)";
  assert.deepEqual(readmeFigure(md, LABEL), { total: 451, passed: 449, failed: 0, skipped: 0 });
});

test("readmeFigure returns null when the sentence is missing entirely", () => {
  assert.equal(readmeFigure("nothing relevant here", LABEL), null);
});
