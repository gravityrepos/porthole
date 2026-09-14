package live.gravitylabs.porthole.release

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ReleaseChangelogTest {

    private val simple = """
        |# Changelog
        |
        |## [Unreleased]
        |
        |### Added
        |
        |- A new thing
        |
        |### Fixed
        |
        |- A bug
        |
        |## [0.1.0] - 2026-09-11
        |
        |### Added
        |
        |- Initial release
        |
    """.trimMargin()

    @Test fun `body is the text between Unreleased and the next version heading`() {
        val body = changelogUnreleasedBody(simple)
        assertTrue(body.contains("A new thing"))
        assertTrue(body.contains("A bug"))
        assertFalse(body.contains("Initial release"))
    }

    @Test fun `body runs to EOF when Unreleased is the only heading`() {
        val noOlderVersions = "## [Unreleased]\n\n- only entry\n"
        assertEquals("\n- only entry\n", changelogUnreleasedBody(noOlderVersions))
    }

    @Test fun `no Unreleased heading refuses with the documented sentence`() {
        try {
            changelogUnreleasedBody("# Changelog\n\n## [0.1.0] - 2026-09-11\n\n- x\n")
            fail("expected an exception")
        } catch (e: IllegalArgumentException) {
            assertEquals("CHANGELOG.md has no '## [Unreleased]' heading at the start of a line", e.message)
        }
    }

    @Test fun `a mid-line mention of the heading text does not count as the heading`() {
        val text = "The format uses `## [Unreleased]` as its heading.\n\n## [Unreleased]\n\n- real entry\n"
        assertEquals("\n- real entry\n", changelogUnreleasedBody(text))
    }

    @Test fun `two Unreleased headings use the first, and refuse if it is empty`() {
        val text = "## [Unreleased]\n\n## [Unreleased]\n\n- entry under the second\n"
        assertFalse(hasReleasableChanges(changelogUnreleasedBody(text)))
    }

    @Test fun `empty Unreleased has no releasable changes`() {
        assertFalse(hasReleasableChanges("\n### Added\n\n### Fixed\n\n"))
    }

    @Test fun `comment-only Unreleased has no releasable changes`() {
        assertFalse(hasReleasableChanges("\n<!-- nothing yet -->\n"))
    }

    @Test fun `whitespace-only Unreleased has no releasable changes`() {
        assertFalse(hasReleasableChanges("\n   \n\t\n"))
    }

    @Test fun `a real bullet is a releasable change`() {
        assertTrue(hasReleasableChanges("\n### Added\n\n- something shipped\n"))
    }

    // --- GRA-100 QA: fenced code blocks in both directions ---

    @Test fun `a heading inside a fence is not read as a section boundary`() {
        val text = """
            |## [Unreleased]
            |
            |### Added
            |
            |Documenting the dated-section format:
            |
            |```markdown
            |## [0.2.0] - 2026-09-14
            |```
            |
            |- the actual entry
            |
        """.trimMargin()
        val body = changelogUnreleasedBody(text)
        // The fenced "## [0.2.0]" must not have ended the Unreleased body early.
        assertTrue(body.contains("the actual entry"))
        assertTrue(hasReleasableChanges(body))
    }

    @Test fun `a bullet inside a fence in an otherwise empty Unreleased is not a releasable change`() {
        val body = """
            |
            |### Added
            |
            |Example of the format:
            |
            |```markdown
            |- not a real entry, just documentation
            |```
            |
        """.trimMargin()
        assertFalse(hasReleasableChanges(body))
    }

    @Test fun `cutChangelog does not mangle a fenced example spanning entries`() {
        val text = """
            |# Changelog
            |
            |## [Unreleased]
            |
            |### Added
            |
            |The dated section this becomes looks like:
            |
            |```markdown
            |## [0.2.0] - 2026-09-14
            |
            |### Added
            |
            |- example
            |```
            |
            |- a real added entry
            |
            |### Changed
            |
            |- a real changed entry
            |
            |## [0.1.0] - 2026-09-11
            |
            |### Added
            |
            |- Initial release
            |
        """.trimMargin()

        val result = cutChangelog(text, "0.2.0", "2026-09-14")

        // The real entries survive, under their real subsections.
        assertTrue(result.contains("- a real added entry"))
        assertTrue(result.contains("- a real changed entry"))
        assertTrue(result.contains("### Changed"))

        // Exactly one *real* dated section for 0.2.0 — identified by the text
        // that follows only the genuine heading, never the fenced example,
        // which is followed by different text ("- example" then the closing
        // fence). A naive line-start regex can't tell the two `## [0.2.0]`
        // occurrences apart; this can, which is the point.
        val realHeadingOccurrences =
            result.split("## [0.2.0] - 2026-09-14\n\n### Added\n\nThe dated section").size - 1
        assertEquals(1, realHeadingOccurrences)

        // The fence's own text is preserved intact rather than split across
        // the cut boundary.
        assertTrue(result.contains("```markdown\n## [0.2.0] - 2026-09-14\n\n### Added\n\n- example\n```"))

        // A fresh, empty Unreleased is left behind.
        assertTrue(result.contains("## [Unreleased]\n\n### Added\n\n### Changed\n\n### Fixed\n\n"))

        // 0.1.0 is untouched.
        assertTrue(result.contains("## [0.1.0] - 2026-09-11"))
        assertTrue(result.contains("- Initial release"))
    }

    @Test fun `cutChangelog drops subsections with no entries and keeps the ones with entries`() {
        val text = "## [Unreleased]\n\n### Added\n\n- a\n\n### Fixed\n\n### Changed\n\n- b\n\n## [0.1.0] - x\n"
        val result = cutChangelog(text, "0.2.0", "2026-09-14")
        assertTrue(result.contains("## [0.2.0] - 2026-09-14"))
        assertTrue(result.contains("- a"))
        assertTrue(result.contains("- b"))
        // "### Fixed" carried nothing and must not appear in the cut, dated section.
        val dated = result.substringAfter("## [0.2.0] - 2026-09-14").substringBefore("## [0.1.0]")
        assertFalse(dated.contains("### Fixed"))
    }

    @Test fun `cutChangelog never leaves three or more consecutive newlines`() {
        val text = "## [Unreleased]\n\n### Added\n\n- a\n\n## [0.1.0] - x\n"
        val result = cutChangelog(text, "0.2.0", "2026-09-14")
        assertFalse(result.contains("\n\n\n"))
    }
}
