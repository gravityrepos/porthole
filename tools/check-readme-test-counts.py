#!/usr/bin/env python3
"""Fail when README.md's stated JVM test count drifts from the JUnit XML
`./gradlew check` just wrote under **/build/test-results/, or when
README.md's own headline total disagrees with the arithmetic of its three
per-suite figures.

GRA-164: the README's total/passed/failed/skipped figure for the JVM suite
has gone stale three times in one day because it was maintained by hand.
This reads the same JUnit XML GRA-159's summary step already parses (Gradle's
own trusted output from this job, not attacker-controlled input) and compares
it against the four numbers README.md states for "on the JVM".

Lives here, not as a vitest test, because Python is already what the
`gradle` job's own summary step uses for this same XML, so this reuses the
tool already proven to work there rather than adding Node to a job that has
none. It also owns the one comparison that needs no suite's XML at all — the
headline "N tests" total against the sum of the three per-suite totals — so
that a change to the total or to any one suite's figure, without updating
the other, fails even though only two of the three figures ever get checked
against real output in this job.

The CI job that runs this only ever runs on ubuntu-latest, but this script
is also meant to be run by hand on whatever machine an implementer has, and
the JVM suite has the same platform-shaped skip set the server suite does
(measured: 366/363/0/3 on Windows, 366/359/0/7 on ubuntu — see BRIEFING "A
test count is meaningless without the machine it came from"). So, like
mcp/scripts/check-readme-vitest-counts.mjs, this always checks the total
but only checks the passed/failed/skipped split on Linux, where README's
split-figure is pinned; elsewhere it says so instead of failing for a reason
that has nothing to do with drift.

A missing or empty JUnit XML directory is treated as a failure, not a
skip: a check that shrugs at "no evidence" and exits 0 is a false green
waiting to happen — measured for real, `cd mcp && npm test` (the exact
command README documents for a human to run) writes no JUnit XML at all,
so a version of this script that tolerated a missing artifact would report
"OK" against a suite it never actually looked at.

What this does NOT catch (true when run, not aspirational):
  - A test renamed or moved without the total changing.
  - A test that runs and asserts nothing: the XML says "passed" and this
    check has no way to know the assertion inside it was empty.
  - The passed/failed/skipped split on any non-Linux machine — see above.
  - Any drift in the server or timeline-UI suites against their OWN JUnit
    XML — see mcp/scripts/check-readme-vitest-counts.mjs, which the `node`
    job runs against that XML instead. This script reads their README
    figures only far enough to sum the totals for the headline check below;
    it does not verify them against reality itself.
  - Prose elsewhere in the README (skip reasons, device claims, etc.) — only
    the four counted numbers per suite, and the headline total's arithmetic,
    are compared.

Usage: python3 tools/check-readme-test-counts.py
Exits 0 with the reconciled figures, or non-zero naming README's figure next
to the suite's (or the components), so the fix is a one-line diff.
"""
import glob
import os
import platform
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


def readme_suite_figure(md, label_regex):
    # Matches e.g. "366 on the JVM (...— 359 passed, 0 failed, 7 skipped)".
    # The parenthetical in README's own prose never nests parens, so a
    # non-greedy [^)]* is enough — if a future edit adds a nested paren this
    # will stop matching and fail loudly (returns None; callers exit
    # non-zero), which is drift this check should surface, not hide.
    #
    # \s+ instead of literal spaces throughout: README is hand-wrapped
    # prose, so a rewrap can land a line break wherever a space was —
    # measured for real, right before the closing number of this sentence.
    #
    # (?<![\d,]) before every captured number: without it, a stray
    # thousands-separated figure like "1,451 in the MCP server" matches
    # starting at "451" and silently reports 451 — a truncated number
    # parsed as if it were correct, not a missing one. The lookbehind
    # refuses to start a match on a digit that follows another digit or a
    # comma, so a comma-grouped number instead fails the whole pattern and
    # is reported as "could not find a figure", which is the loud failure
    # a bad parse should produce, not a plausible-looking wrong answer.
    pat = re.compile(
        r"(?<![\d,])(\d+)\s+" + label_regex + r"\s*\("
        r"[^)]*?(?<![\d,])(\d+)\s+passed,\s+(?<![\d,])(\d+)\s+failed,\s+(?<![\d,])(\d+)\s+skipped\)",
        re.DOTALL,
    )
    m = pat.search(md)
    if not m:
        return None
    return tuple(int(g) for g in m.groups())


def readme_headline_total(md):
    # Matches "**951 tests, measured on ubuntu-latest CI**". Same
    # anti-truncation guard as readme_suite_figure, for the same reason.
    pat = re.compile(
        r"\*\*(?<![\d,])(\d+)\s+tests,\s+measured\s+on\s+ubuntu-latest\s+CI\*\*"
    )
    m = pat.search(md)
    if not m:
        return None
    return int(m.group(1))


def main():
    paths = sorted(
        glob.glob(os.path.join(ROOT, "**", "build", "test-results", "**", "*.xml"), recursive=True)
    )
    if not paths:
        print(
            "README drift check (jvm): FAIL — no JUnit XML found under "
            "**/build/test-results/. This is not treated as 'nothing to compare yet': "
            "a missing artifact is not evidence the README is correct, and 'cd mcp && "
            "npm test' (the command README itself documents) produces no JUnit XML at "
            "all, so silently passing here would make the by-hand path permanently "
            "unchecked. Run './gradlew test' (or 'check') first, with real output, "
            "before this can say anything."
        )
        sys.exit(1)
    act_total, act_passed, act_failed, act_skipped = suite_totals_from_junit(paths)
    with open(README, encoding="utf-8") as f:
        md = f.read()

    jvm_expected = readme_suite_figure(md, r"on\s+the\s+JVM")
    if jvm_expected is None:
        print(
            "README drift check (jvm): could not find a figure in README.md matching "
            "'N on the JVM (... P passed, F failed, S skipped)'. Either the wording "
            "moved and this regex needs updating, or the figure was deleted outright "
            "— both are drift this check exists to catch."
        )
        sys.exit(1)
    exp_total, exp_passed, exp_failed, exp_skipped = jvm_expected

    if act_total != exp_total:
        print(
            f"README drift (jvm total): README says {exp_total}, the suite's own JUnit XML "
            f"says {act_total}. Update README.md's JVM total to match."
        )
        sys.exit(1)

    split_checked = False
    # The CI job that runs this only ever runs on ubuntu-latest, but this
    # script is also run by hand on whatever machine an implementer has —
    # and the JVM suite has the same platform-shaped skip set the server
    # suite does (measured: 366/363/0/3 on Windows, 366/359/0/7 on ubuntu).
    # README's split names ubuntu-latest specifically, so comparing a
    # non-Linux run's split against it would fail for a reason that has
    # nothing to do with drift — exactly the "hardcodes one machine's skip
    # count" failure mode GRA-164's own acceptance criteria warn against.
    if platform.system() != "Linux":
        print(
            f"README drift check (jvm): total OK ({act_total}). Not checking the "
            f"passed/failed/skipped split on {platform.system()} — README's split names "
            "ubuntu-latest specifically, because the skip set is not the same on every platform."
        )
    elif (act_passed, act_failed, act_skipped) != (exp_passed, exp_failed, exp_skipped):
        print(
            "README drift (jvm passed/failed/skipped, README names ubuntu-latest): README says "
            f"{exp_passed} passed / {exp_failed} failed / {exp_skipped} skipped, the suite's own "
            f"JUnit XML says {act_passed} passed / {act_failed} failed / {act_skipped} skipped. "
            "Update README.md's JVM figure to match."
        )
        sys.exit(1)
    else:
        split_checked = True
        print(
            f"README drift check (jvm): OK — {act_total} total / {act_passed} passed / "
            f"{act_failed} failed / {act_skipped} skipped"
        )

    # The headline total needs none of this job's XML: it is README
    # checking its own arithmetic, so it runs unconditionally, on every
    # platform, regardless of the split branch above.
    server_expected = readme_suite_figure(md, r"in\s+the\s+MCP\s+server")
    ui_expected = readme_suite_figure(md, r"in\s+the\s+timeline\s+UI")
    if server_expected is None or ui_expected is None:
        print(
            "README drift check (headline total): could not find the server or UI figure "
            "needed to sum against the headline total. Either the wording moved and these "
            "regexes need updating, or a figure was deleted outright."
        )
        sys.exit(1)
    headline = readme_headline_total(md)
    if headline is None:
        print(
            "README drift check (headline total): could not find a "
            "'**N tests, measured on ubuntu-latest CI**' headline in README.md."
        )
        sys.exit(1)
    computed = exp_total + server_expected[0] + ui_expected[0]
    if headline != computed:
        print(
            f"README drift (headline total): README's headline says {headline} tests, but its "
            f"own per-suite figures sum to {computed} ({exp_total} JVM + {server_expected[0]} "
            f"server + {ui_expected[0]} UI). Update the headline total to match its components."
        )
        sys.exit(1)
    print(f"README drift check (headline total): OK — {headline} = {exp_total} + {server_expected[0]} + {ui_expected[0]}")

    if not split_checked:
        # Non-fatal reminder, not a failure: the split simply was not this
        # platform's to check.
        pass


if __name__ == "__main__":
    main()
