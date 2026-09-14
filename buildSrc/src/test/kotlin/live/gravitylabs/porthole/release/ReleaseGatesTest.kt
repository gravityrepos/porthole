package live.gravitylabs.porthole.release

import org.gradle.api.GradleException
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class ReleaseGatesTest {

    @Test fun `a well-formed version passes through unchanged`() {
        assertEquals("0.2.0", validateReleaseVersion("0.2.0"))
        assertEquals("1.2.3-rc1", validateReleaseVersion("1.2.3-rc1"))
    }

    @Test fun `a missing version refuses`() {
        assertRefuses("release needs -Pversion=X.Y.Z") { validateReleaseVersion(null) }
    }

    @Test fun `a malformed version refuses`() {
        assertRefuses("version must look like X.Y.Z or X.Y.Z-suffix; got 'abc'") { validateReleaseVersion("abc") }
        assertRefuses("version must look like X.Y.Z or X.Y.Z-suffix; got '0.2'") { validateReleaseVersion("0.2") }
    }

    @Test fun `a -SNAPSHOT version refuses up front, at the same gate as the pattern`() {
        assertRefuses("version must not be a -SNAPSHOT; releases are not snapshots, got '0.2.0-SNAPSHOT'") {
            validateReleaseVersion("0.2.0-SNAPSHOT")
        }
        // Case-insensitively, since the pattern match itself is not case-sensitive about the suffix.
        assertRefuses("version must not be a -SNAPSHOT; releases are not snapshots, got '0.2.0-snapshot'") {
            validateReleaseVersion("0.2.0-snapshot")
        }
    }

    @Test fun `main is the only branch release runs on`() {
        validateReleaseBranch("main") // does not throw
        assertRefuses("release only runs on main; the current branch is 'GRA-100'") {
            validateReleaseBranch("GRA-100")
        }
    }

    @Test fun `a dirty tree refuses`() {
        validateCleanTree("") // does not throw
        assertRefuses("release needs a clean working tree; 'git status --porcelain' is not empty") {
            validateCleanTree(" M gradle/libs.versions.toml\n")
        }
    }

    @Test fun `an empty Unreleased section refuses, naming the version that would have been released`() {
        validateHasReleasableChanges("\n### Added\n\n- something\n", "0.2.0") // does not throw
        assertRefuses("CHANGELOG.md's Unreleased section has no entries; add one before releasing 0.2.0") {
            validateHasReleasableChanges("\n### Added\n\n### Fixed\n\n", "0.2.0")
        }
    }

    private fun assertRefuses(message: String, block: () -> Unit) {
        try {
            block()
            fail("expected a GradleException")
        } catch (e: GradleException) {
            assertEquals(message, e.message)
        }
    }
}
