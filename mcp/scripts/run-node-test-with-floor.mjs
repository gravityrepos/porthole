#!/usr/bin/env node
// GRA-175: `node --test <file>` treats a file that registers ZERO real
// test() calls exactly like a file that registers one and passes it -- both
// report "tests 1, pass 1" (or, under --test-reporter=tap, a single
// "ok 1 - <filename>" line naming the FILE, not a test) and exit 0. Measured
// directly: a 0-byte file, and a file containing only an unused import and a
// comment, both produced "tests 1, pass 1, EXIT 0" -- there is no daylight
// between "ran the file, found nothing to register" and "ran the file's one
// real test", and no CLI flag exists to ask for one (unlike vitest's
// `passWithNoTests`, which covers the same gap from the opposite direction).
// So a rename, a moved file, a botched merge that empties a describe block,
// or a caught-and-swallowed import error can all leave this file's own
// checker self-test green while defending nothing.
//
// This wraps `node --test` and adds the one thing it lacks: a check that
// more than one test was actually collected. The floor is 1, not any
// specific expected count -- every self-test file in this repo has always
// shipped with several cases (see check-readme-vitest-counts.test.mjs), and
// node's "nothing registered" fallback can only ever produce exactly 1, so
// "collected <= 1" is a structural signal that collection failed, not a
// count anyone has to keep in sync as tests are added or removed. That is
// deliberate: GRA-164 was filed because a hand-maintained total goes stale,
// and a minimum-count assertion here that tried to track "the real number of
// tests in this file" would be exactly that trap one level down.
//
// What this does NOT defend: a file that used to have 2+ tests and drops to
// exactly 1 real one reads identically to "collected nothing" (both are
// "<= 1") -- that is a false positive this project is choosing to accept
// rather than try to tell apart "one real test" from "zero, reported as
// one", which node's own reporter does not distinguish either. It also does
// not defend a file with 2+ tests where all but one silently stop being
// collected (e.g. a typo'd `test.skip` applied to every case but one) -- the
// floor only catches a *total* collapse, the same limitation the JVM/README
// total check has (see tools/check-readme-test-counts.py's own docstring).
//
// Usage: node scripts/run-node-test-with-floor.mjs <file...>
import { spawnSync } from "node:child_process";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node run-node-test-with-floor.mjs <file...>");
  process.exit(2);
}

let exitCode = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], {
    encoding: "utf8",
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");

  if (result.status !== 0) {
    // A real assertion failure (or a crash) inside the file already fails
    // loudly on its own -- node's own non-zero exit code is the signal, and
    // there is nothing this wrapper needs to add to it.
    exitCode = exitCode || result.status || 1;
    continue;
  }

  // TAP's own summary line, e.g. "# tests 5". Present on every run node
  // --test produces via this reporter, pass or fail, so its absence here
  // (an undefined match) is itself worth failing on rather than silently
  // treating as zero and reporting the same message twice.
  const match = /^# tests (\d+)$/m.exec(result.stdout ?? "");
  if (!match) {
    console.error(`${file}: could not find node --test's own "# tests N" summary line in its output.`);
    exitCode = 1;
    continue;
  }

  const collected = Number(match[1]);
  if (collected <= 1) {
    console.error(
      `${file}: node --test reports only ${collected} test(s) collected, exit 0. node's runner ` +
        'reports a file that registers ZERO real test() calls the same way it reports one that ' +
        'registers exactly one -- as "1 test, 1 pass" -- so a count this low almost certainly means ' +
        "nothing was actually collected: a rename, a moved file, a changed import, or a syntax/import " +
        "error node did not raise loudly. This file is expected to collect more than one.",
    );
    exitCode = 1;
  }
}

process.exit(exitCode);
