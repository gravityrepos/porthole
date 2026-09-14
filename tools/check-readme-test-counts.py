#!/usr/bin/env python3
"""Fail when README.md's stated JVM test count drifts from the JUnit XML
`./gradlew check` just wrote under **/build/test-results/.

GRA-164: the README's total/passed/failed/skipped figure for the JVM suite
has gone stale three times in one day because it was maintained by hand.
This reads the same JUnit XML GRA-159's summary step already parses (Gradle's
own trusted output from this job, not attacker-controlled input) and compares
it against the four numbers README.md states for "on the JVM".

Lives here, not as a vitest test, because it only ever runs once, on
ubuntu-latest, in the `gradle` job — there is no cross-platform split to
reason about for this suite, and Python is already what that job's summary
step uses for the same XML, so this reuses the tool already proven to work
there rather than adding Node to a job that has none.

What this does NOT catch (true when run, not aspirational):
  - A test renamed or moved without the total changing.
  - A test that runs and asserts nothing: the XML says "passed" and this
    check has no way to know the assertion inside it was empty.
  - Any drift in the server or timeline-UI suites — see
    mcp/scripts/check-readme-vitest-counts.mjs, which the `node` job runs
    against their own JUnit XML instead.
  - Prose elsewhere in the README (skip reasons, device claims, etc.) — only
    the four counted numbers in the "on the JVM (...)" sentence are compared.
  - A drift introduced by the merge that lands this PR: this step reads the
    branch's own build, not the merge commit's.

Usage: python3 tools/check-readme-test-counts.py
Exits 0 with the reconciled figure, or non-zero naming README's figure next
to the suite's, so the fix is a one-line diff.
"""
import glob
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
README = os.path.join(ROOT, "README.md")


def suite_totals_from_junit(paths):
    total = passed = failed = skipped = 0
    for path in paths:
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError:
            continue
        # Walk every <testcase> regardless of whether the root IS a
        # <testsuite> (Gradle's shape) or wraps <testsuite> children
        # (vitest's) — .iter() does not care which, so this does not have to
        # assume a shape ahead of reading it.
        for tc in root.iter("testcase"):
            total += 1
            if tc.find("skipped") is not None:
                skipped += 1
            elif tc.find("failure") is not None or tc.find("error") is not None:
                failed += 1
            else:
                passed += 1
    return total, passed, failed, skipped


def readme_figure(md):
    # Matches "366 on the JVM (...— 359 passed, 0 failed, 7 skipped)". The
    # parenthetical in README's own prose never nests parens, so a
    # non-greedy [^)]* is enough — if a future edit adds a nested paren this
    # will stop matching and fail loudly (see the "could not find" branch
    # below), which is drift this check should surface, not hide.
    pat = re.compile(
        r"(\d+)\s+on the JVM\s*\([^)]*?(\d+) passed, (\d+) failed, (\d+) skipped\)",
        re.DOTALL,
    )
    m = pat.search(md)
    if not m:
        print(
            "README drift check (jvm): could not find a figure in README.md matching "
            "'N on the JVM (... P passed, F failed, S skipped)'. Either the wording "
            "moved and this regex needs updating, or the figure was deleted outright "
            "— both are drift this check exists to catch."
        )
        sys.exit(1)
    return tuple(int(g) for g in m.groups())


def main():
    paths = sorted(
        glob.glob(os.path.join(ROOT, "**", "build", "test-results", "**", "*.xml"), recursive=True)
    )
    if not paths:
        print(
            "README drift check (jvm): no JUnit XML found under **/build/test-results/ "
            "— run ./gradlew test (or check) first. Not a drift finding; there is "
            "nothing to compare yet."
        )
        return
    actual = suite_totals_from_junit(paths)
    with open(README, encoding="utf-8") as f:
        md = f.read()
    expected = readme_figure(md)
    if actual != expected:
        exp_total, exp_passed, exp_failed, exp_skipped = expected
        act_total, act_passed, act_failed, act_skipped = actual
        print(
            "README drift (jvm): README says "
            f"{exp_total} total / {exp_passed} passed / {exp_failed} failed / {exp_skipped} skipped, "
            "the suite's own JUnit XML says "
            f"{act_total} total / {act_passed} passed / {act_failed} failed / {act_skipped} skipped. "
            "Update README.md's JVM figure to match."
        )
        sys.exit(1)
    print(f"README drift check (jvm): OK — {actual[0]} total / {actual[1]} passed / {actual[2]} failed / {actual[3]} skipped")


if __name__ == "__main__":
    main()
