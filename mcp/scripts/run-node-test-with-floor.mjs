#!/usr/bin/env node
// GRA-175: `node --test <file>` treats a file that registers ZERO real
// test() calls as if the FILE ITSELF were one passing test -- a 0-byte file,
// or one containing only an unused import and a comment, both report
// "tests 1, pass 1", EXIT 0. No CLI flag exists to ask for the opposite
// (unlike vitest's `passWithNoTests`, which covers this gap from the other
// direction). So a rename, a moved file, a botched merge that empties a
// describe block, or a caught-and-swallowed import error can all leave this
// file's own checker self-test green while defending nothing.
//
// A bare "# tests <= 1" floor is NOT the fix, even though it looks like one
// (an earlier version of this file used exactly that, and QA correctly
// failed it): a file with exactly one genuine test also reports "# tests 1"
// -- byte-identical to the zero-real-test case -- so that floor rejects
// correct single-test input, which is worse than the defect it closes: a
// guard that cries wolf on a clean tree is the guard the next person deletes,
// taking the coverage with it.
//
// node's reporter DOES distinguish the two cases; it is just not in the
// count. Under --test-reporter=tap, the sole result line is named after
// WHAT RAN: "ok 1 - <the test's own description>" when a real test() call
// executed, versus "ok 1 - <the file's own path>" when nothing was
// registered and node fell back to treating the file's own successful
// execution as the result. So the fix reads that name, not just the count.
//
// The path form node uses for the fallback is NOT stable across versions --
// measured directly: node 25.8.1 renders it exactly as the argument was
// given (e.g. "./foo.test.mjs" or "scripts/foo.test.mjs", OS-native
// separators); node 20.20.2, the version pr.yml actually pins, renders the
// fully resolved ABSOLUTE path instead ("C:\Users\...\scripts\foo.test.mjs")
// for the identical input and identical file. Comparing the rendered name
// against a re-derived form of the argument (relative vs. absolute,
// separator style) chases a moving target across node versions. Comparing
// BASENAMES only sidesteps all of that: the fallback's name always ends in
// the file's own basename on both versions, and a real test's own
// description essentially never does.
//
// Only when exactly one result comes back do we compare basename(that
// name) against basename(file) -- an exact match means "this is node's
// fallback, not a real test", and anything else (a real test description)
// passes.
//
// What this does NOT defend: a file with 2+ tests where all but one silently
// stop being collected (e.g. a typo'd `test.skip` applied to every case but
// one) -- this only catches a *total* collapse to zero, the same limitation
// the JVM/README total check has (see tools/check-readme-test-counts.py's
// own docstring). And in the exceedingly unlikely case a real test's own
// description is written to read exactly as the file's own basename, this
// would misread it as the fallback and fail a correct file -- not defended
// against, and not expected to matter in practice.
//
// Usage: node scripts/run-node-test-with-floor.mjs <file...>
import { spawnSync } from "node:child_process";
import { posix } from "node:path";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node run-node-test-with-floor.mjs <file...>");
  process.exit(2);
}

// The name TAP printed for result #1, reduced to a basename for comparison.
// TAP escapes a literal backslash by doubling it (measured on a Windows
// path: "C:\\Users\\...\\foo.test.mjs" in the raw text is one escaped
// backslash per pair); this undoes that first, then folds any remaining
// single backslash to a forward slash too, so `posix.basename` (which only
// ever splits on "/", unlike the default OS-dependent `basename`) sees real
// separators regardless of which OS produced the path or which form
// (relative or absolute) this node version chose to render.
function tapNameBasename(s) {
  return posix.basename(s.replace(/\\\\/g, "/").replace(/\\/g, "/"));
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

  const output = result.stdout ?? "";

  // TAP's own summary line, e.g. "# tests 5". Present on every run node
  // --test produces via this reporter, pass or fail, so its absence here
  // (an undefined match) is itself worth failing on rather than silently
  // treating as zero and reporting the same message twice.
  const countMatch = /^# tests (\d+)$/m.exec(output);
  if (!countMatch) {
    console.error(`${file}: could not find node --test's own "# tests N" summary line in its output.`);
    exitCode = 1;
    continue;
  }

  const collected = Number(countMatch[1]);
  if (collected < 1) {
    // Not observed in practice (node's own fallback always produces exactly
    // 1), but if it ever does, it is unambiguous: nothing ran at all.
    console.error(`${file}: node --test reports 0 tests collected, exit 0. Nothing was collected.`);
    exitCode = 1;
    continue;
  }

  if (collected === 1) {
    // Only at exactly 1 is the count itself ambiguous -- 2+ can only mean
    // real tests ran (node's fallback never produces more than one result).
    const nameMatch = /^(?:not )?ok 1 - (.+)$/m.exec(output);
    const resultBasename = nameMatch ? tapNameBasename(nameMatch[1]) : null;
    const fileBasename = posix.basename(file.replace(/\\/g, "/"));
    const isFallback = resultBasename !== null && resultBasename === fileBasename;
    if (isFallback) {
      console.error(
        `${file}: node --test collected exactly 1 result, and it is named after the FILE ` +
          `("${nameMatch[1]}"), not after a test -- this is node's "nothing registered" fallback, not ` +
          "a real test. A rename, a moved file, a changed import, or a syntax/import error most " +
          "likely emptied this file's test() calls.",
      );
      exitCode = 1;
      continue;
    }
    // Named after an actual test description, not the file -- a genuine
    // single-test file. Nothing wrong here.
  }
}

process.exit(exitCode);
