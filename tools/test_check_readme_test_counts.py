#!/usr/bin/env python3
"""Tests for check-readme-test-counts.py's parsing, not the CLI end to end
(that is exercised for real by pr.yml running the script against real
Gradle JUnit XML). stdlib unittest, no dependency, mirroring
mcp/scripts/check-readme-vitest-counts.test.mjs's coverage of the same
defect class in the sibling script.

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
    # starting at "366", silently reporting 366 instead of failing to find
    # a figure at all. The chosen fix is REJECTION, not comma-aware parsing
    # — no comma-grouped number has ever appeared in this paragraph, so
    # there is no real case to parse correctly, only a wrong answer to stop
    # returning. Must come back None here, same as a missing figure, so the
    # caller reports "could not find a figure" instead of a wrong count.
    def test_rejects_a_thousands_separated_figure_instead_of_truncating_it(self):
        md = "1,366 on the JVM (`./gradlew test` — 359 passed, 0 failed, 7 skipped)"
        self.assertIsNone(readme_suite_figure(md, LABEL))

    def test_rejects_a_thousands_separated_passed_count(self):
        md = "366 on the JVM (`./gradlew test` — 1,359 passed, 0 failed, 7 skipped)"
        self.assertIsNone(readme_suite_figure(md, LABEL))

    def test_tolerates_readmes_own_line_wrapping(self):
        md = "366 on the JVM (`./gradlew\ntest` — 359 passed, 0 failed, 7\nskipped)"
        self.assertEqual(readme_suite_figure(md, LABEL), (366, 359, 0, 7))

    def test_returns_none_when_the_sentence_is_missing_entirely(self):
        self.assertIsNone(readme_suite_figure("nothing relevant here", LABEL))


class ReadmeHeadlineTotalTest(unittest.TestCase):
    def test_parses_the_headline(self):
        md = "**951 tests, measured on ubuntu-latest CI** (details...)"
        self.assertEqual(readme_headline_total(md), 951)

    def test_rejects_a_thousands_separated_headline(self):
        md = "**1,951 tests, measured on ubuntu-latest CI** (details...)"
        self.assertIsNone(readme_headline_total(md))


if __name__ == "__main__":
    unittest.main()
