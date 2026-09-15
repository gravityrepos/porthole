#!/usr/bin/env node
// Fail when README.md's stated server/timeline-UI test counts drift from the
// JUnit XML the `node` job's own vitest runs just wrote.
//
// GRA-164: these two figures have gone stale three times in one day because
// they were maintained by hand. This reads the same JUnit XML GRA-159's
// summary step already parses (vitest's own trusted output from this job,
// not attacker-controlled input) and compares it against README.md.
//
// Deliberately a script run by `node <path>` in a CI step, not a vitest test
// file under mcp/src/: this suite's own JUnit XML (mcp/test-results/
// server-junit.xml) is written by vitest's junit reporter only after the
// whole run finishes. A test file living inside that same run would be
// asking to read an output that does not exist yet — or, on a rerun, reads
// the PREVIOUS run's file and silently "passes" against stale data. Running
// this after the suite, as its own step, is the only ordering that reads a
// file vitest has actually finished writing.
//
// Usage: node mcp/scripts/check-readme-vitest-counts.mjs <server|ui>
//
// A missing or empty JUnit XML file is treated as a failure, not a skip: a
// check that shrugs at "no evidence" and exits 0 is a false green waiting to
// happen — measured for real, plain `cd mcp && npm test` (the exact command
// README documents for a human to run) writes no JUnit XML at all, so a
// version of this script that tolerated a missing file would report "OK"
// against a suite it never actually looked at.
//
// What this does NOT catch (true when run, not aspirational):
//   - A test renamed or moved without the total changing.
//   - A test that runs and asserts nothing: the XML says "passed" and this
//     check has no way to know the assertion inside it was empty.
//   - Any drift in the JVM suite — see tools/check-readme-test-counts.py,
//     which the `gradle` job runs against its own JUnit XML instead. That
//     script also verifies the README's headline total against the sum of
//     all three suites' README figures; this one does not.
//   - The passed/failed/skipped SPLIT on windows-latest or macos-latest.
//     README's split figure names ubuntu-latest specifically, because the
//     skip set is not the same on every platform (perfetto-stdout skips
//     without a cached trace_processor capture; GRA-160's host-gated case is
//     Windows-only). On those two legs this checks only the total — the one
//     number that IS the same everywhere — and says so rather than failing
//     for a reason that has nothing to do with drift.
//   - Prose elsewhere in the README (skip reasons, device claims, etc.) —
//     only the four counted numbers in the suite's own sentence are compared.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", ".."); // mcp/scripts -> mcp -> repo root
const README = path.join(ROOT, "README.md");

const SUITES = {
  server: { label: "in the MCP server", xml: path.join(ROOT, "mcp", "test-results", "server-junit.xml") },
  ui: { label: "in the timeline UI", xml: path.join(ROOT, "mcp", "test-results", "ui-junit.xml") },
};

function decode(s) {
  return s
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Regex-based, matching the style GRA-159's own "Print vitest test summary"
// step already uses in pr.yml for this exact file shape: one flat
// <testcase> per test with an optional nested <skipped/> or <failure>.
function countsFromJunit(xmlPath) {
  const xml = readFileSync(xmlPath, "utf8");
  let total = 0, passed = 0, failed = 0, skipped = 0;
  const testcaseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = testcaseRe.exec(xml))) {
    const body = m[3] || "";
    total++;
    if (/<skipped\b/.test(body)) skipped++;
    else if (/<failure\b/.test(body) || /<error\b/.test(body)) failed++;
    else passed++;
  }
  return { total, passed, failed, skipped };
}

// A test count has no decimal reading, unlike a general number — so unlike
// most "comma in a number" ambiguity, there is no locale in which stripping
// it is wrong. Parses "1,451" as 1451, not 451 and not a rejection.
function parseCount(digits) {
  return Number.parseInt(digits.replace(/,/g, ""), 10);
}

function readmeFigure(md, label) {
  // e.g. "451 in the MCP server (...— 449 passed, 0 failed, 2 skipped)".
  // The parenthetical in README's own prose never nests parens, so a
  // non-greedy [^)]* is enough — if a future edit adds a nested paren this
  // stops matching and fails loudly below, which is drift too. \s+ instead
  // of literal spaces throughout (label included): README is hand-wrapped
  // prose, so a run of markdown-editor rewrapping can land a line break
  // wherever a space was — including, as measured, right before the closing
  // number of the sentence.
  //
  // [\d,]+ instead of \d+, parsed through parseCount: this used to be \d+
  // with a (?<![\d,]) lookbehind that REJECTED a thousands-separated figure
  // like "1,451" (it matched starting at "451" without the guard, silently
  // truncating it). Rejecting was wrong, not just less friendly: once the
  // total crosses 1,000, "1,451" is the correct way to write it, and a
  // check that fails a correct edit teaches people to stop trusting or to
  // delete the check. [\d,]+ greedily captures the WHOLE run including its
  // commas from the leftmost possible start — regex search tries the
  // earliest starting position first, and starting at "1" already yields a
  // full match ("1,451" then whitespace then the label), so the engine
  // never falls back to the later, truncated starting position the old bug
  // depended on. parseCount then strips the commas and parses the real
  // number.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  const re = new RegExp(
    `([\\d,]+)\\s+${escaped}\\s*\\([^)]*?` +
      `([\\d,]+)\\s+passed,\\s+([\\d,]+)\\s+failed,\\s+([\\d,]+)\\s+skipped\\)`,
    "s"
  );
  const m = decode(md).match(re);
  if (!m) return null;
  return {
    total: parseCount(m[1]),
    passed: parseCount(m[2]),
    failed: parseCount(m[3]),
    skipped: parseCount(m[4]),
  };
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function main() {
  const which = process.argv[2];
  const suite = SUITES[which];
  if (!suite) {
    console.error("usage: node mcp/scripts/check-readme-vitest-counts.mjs <server|ui>");
    process.exitCode = 2;
    return;
  }
  if (!existsSync(suite.xml)) {
    fail(
      `README drift check (${which}): FAIL — no ${path.relative(ROOT, suite.xml)}. This is not ` +
        "treated as 'nothing to compare yet': a missing artifact is not evidence the README is " +
        "correct, and plain 'cd mcp && npm test' (the command README itself documents) writes no " +
        "JUnit XML at all, so silently passing here would make the by-hand path permanently " +
        "unchecked. Run the suite with --reporter=junit --outputFile=... first, with real output, " +
        "before this can say anything."
    );
    return;
  }
  const actual = countsFromJunit(suite.xml);
  const md = readFileSync(README, "utf8");
  const expected = readmeFigure(md, suite.label);
  if (!expected) {
    fail(
      `README drift check (${which}): could not find a figure in README.md matching ` +
        `'N ${suite.label} (... P passed, F failed, S skipped)'. Either the wording moved ` +
        "and this regex needs updating, or the figure was deleted outright — both are " +
        "drift this check exists to catch."
    );
    return;
  }
  if (actual.total !== expected.total) {
    fail(
      `README drift (${which} total): README says ${expected.total}, the suite's own JUnit ` +
        `XML says ${actual.total}. Update README.md's ${which} total to match.`
    );
    return;
  }
  const isUbuntu = os.platform() === "linux";
  if (!isUbuntu) {
    console.log(
      `README drift check (${which}): total OK (${actual.total}). Not checking the ` +
        `passed/failed/skipped split on ${os.platform()} — README's split names ` +
        "ubuntu-latest specifically, because the skip set is not the same on every platform."
    );
    return;
  }
  if (
    actual.passed !== expected.passed ||
    actual.failed !== expected.failed ||
    actual.skipped !== expected.skipped
  ) {
    fail(
      `README drift (${which} passed/failed/skipped, README names ubuntu-latest): README says ` +
        `${expected.passed} passed / ${expected.failed} failed / ${expected.skipped} skipped, ` +
        `the suite's own JUnit XML says ${actual.passed} passed / ${actual.failed} failed / ` +
        `${actual.skipped} skipped. Update README.md's ${which} figure to match.`
    );
    return;
  }
  console.log(
    `README drift check (${which}): OK — ${actual.total} total / ${actual.passed} passed / ` +
      `${actual.failed} failed / ${actual.skipped} skipped`
  );
}

export { readmeFigure, countsFromJunit };

// Guard, not a bare `main()` call: check-readme-vitest-counts.test.mjs
// imports readmeFigure/countsFromJunit from this same file to test the
// parsing directly, and an unguarded call would run the full CLI (reading
// README.md, exiting the process) as a side effect of that import.
// pathToFileURL, not a raw `file://${process.argv[1]}` template: on Windows
// process.argv[1] is a backslash path ("C:\...\x.mjs"), which does not
// equal the forward-slash "file:///C:/.../x.mjs" that import.meta.url uses
// — the naive comparison is false even when running this file directly,
// which would silently skip main() entirely on every Windows invocation.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
  process.exit(process.exitCode ?? 0);
}
