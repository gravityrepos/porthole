#!/usr/bin/env python3
"""Tests for check-readme-test-counts.py's parsing, not the CLI end to end
(that is exercised for real by pr.yml running the script against real
Gradle JUnit XML). stdlib unittest, no dependency, mirroring
mcp/scripts/check-readme-vitest-counts.test.mjs's coverage of the same
defect class in the sibling script.

GRA-175 audited this file for the same defect its sibling has (a runner that
collects zero tests and still exits 0): measured directly, on the Python this
machine has (3.14.5) and matching exactly how this file is invoked --
`unittest.main()` under `if __name__ == "__main__":`, no discovery, no
`-m unittest` -- emptying every test method out of both classes below prints
"Ran 0 tests ... NO TESTS RAN" and exits **5**, not 0. That is CPython's own
fix (landed in 3.12: unittest returns a non-zero exit code when nothing ran or
everything skipped), not anything in this file, and it needs no wrapper here
the way node --test does (see run-node-test-with-floor.mjs for why that one
does). This is unproven for whatever python3 CI's ubuntu-latest runner
resolves to at the time you read this -- not re-verified there -- but Ubuntu's
shipped default has been >=3.12 since well before this was written, so the
same behaviour is expected, not merely hoped for. If this file is ever run
under an older interpreter, that machine is on its own: no code here
compensates for it.

Run: python3 tools/test_check_readme_test_counts.py
"""
import importlib.util
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "check_readme_test_counts", os.path.join(_HERE, "check-readme-test-counts.py")
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)  # module has no top-level side effects: main() is __main__-guarded

readme_suite_figure = _mod.readme_suite_figure
readme_headline_total = _mod.readme_headline_total

LABEL = r"on\s+the\s+JVM"


class ReadmeSuiteFigureTest(unittest.TestCase):
    def test_parses_a_plain_integer_figure(self):
        md = "366 on the JVM (`./gradlew test` — 359 passed, 0 failed, 7 skipped)"
        self.assertEqual(readme_suite_figure(md, LABEL), (366, 359, 0, 7))

    # The bug QA found: this regex used to match "1,366 on the JVM (...)"
    # starting at "366", silently reporting 366 instead of the real 1366.
    # The founder's call, overriding this file's first fix: rejecting the
    # input, or the good error message it needs, was worse than making it
    # correct — the total crosses 1,000 the day GRA-174 lands, "1,366"
    # becomes the natural way to write it, and a check that fails a correct
    # edit is a check people learn to route around. A test count has no
    # decimal reading, so unlike most "comma in a number" ambiguity there
    # is no locale where stripping it is the wrong call. This pins the
    # CORRECT VALUE, not a refusal — stronger than "returns None", because
    # a check that only tested for None would also pass a checker that
    # rejects everything.
    def test_parses_a_thousands_separated_figure_as_its_real_value(self):
        md = "1,366 on the JVM (`./gradlew test` — 359 passed, 0 failed, 7 skipped)"
        self.assertEqual(readme_suite_figure(md, LABEL), (1366, 359, 0, 7))

    def test_parses_a_thousands_separated_passed_count_as_its_real_value(self):
        md = "366 on the JVM (`./gradlew test` — 1,359 passed, 0 failed, 7 skipped)"
        self.assertEqual(readme_suite_figure(md, LABEL), (366, 1359, 0, 7))

    def test_tolerates_readmes_own_line_wrapping(self):
        md = "366 on the JVM (`./gradlew\ntest` — 359 passed, 0 failed, 7\nskipped)"
        self.assertEqual(readme_suite_figure(md, LABEL), (366, 359, 0, 7))

    def test_returns_none_when_the_sentence_is_missing_entirely(self):
        self.assertIsNone(readme_suite_figure("nothing relevant here", LABEL))


class ReadmeHeadlineTotalTest(unittest.TestCase):
    def test_parses_the_headline(self):
        md = "**951 tests, measured on ubuntu-latest CI** (details...)"
        self.assertEqual(readme_headline_total(md), 951)

    def test_parses_a_thousands_separated_headline_as_its_real_value(self):
        md = "**1,951 tests, measured on ubuntu-latest CI** (details...)"
        self.assertEqual(readme_headline_total(md), 1951)


if __name__ == "__main__":
    unittest.main()
