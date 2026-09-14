package live.gravitylabs.porthole.release

import org.gradle.api.GradleException

// The refusal gates `release` checks before it writes anything, extracted
// (GRA-100 fix pass) so they can be unit tested against strings instead of a
// real git checkout. Each one throws the same `GradleException` with the
// same one-line message the inline version did, so `release`'s own output is
// unchanged — only where the check lives moved.

private val releaseVersionPattern = Regex("""\d+\.\d+\.\d+(-.+)?""")

/**
 * `-Pversion` must look like `X.Y.Z` or `X.Y.Z-suffix`, and must not be a
 * `-SNAPSHOT`. A snapshot used to pass this pattern, bump the catalog, and
 * get caught only much later by `VersionConsistencyTest` inside `check` —
 * after `release` had already left the tree dirty (GRA-100 QA).
 */
fun validateReleaseVersion(version: String?): String {
    if (version == null) throw GradleException("release needs -Pversion=X.Y.Z")
    if (!releaseVersionPattern.matches(version)) {
        throw GradleException("version must look like X.Y.Z or X.Y.Z-suffix; got '$version'")
    }
    if (version.contains("SNAPSHOT", ignoreCase = true)) {
        throw GradleException("version must not be a -SNAPSHOT; releases are not snapshots, got '$version'")
    }
    return version
}

/** `release` only ever runs from `main`; its next steps assume history no other branch has. */
fun validateReleaseBranch(branch: String) {
    if (branch != "main") {
        throw GradleException("release only runs on main; the current branch is '$branch'")
    }
}

/** A dirty tree means `release`'s own catalog/changelog writes would land on top of unrelated changes. */
fun validateCleanTree(gitStatusPorcelain: String) {
    if (gitStatusPorcelain.isNotBlank()) {
        throw GradleException("release needs a clean working tree; 'git status --porcelain' is not empty")
    }
}

/** `release` refuses when there is nothing to release — an Unreleased section that parses but carries no `- ` entries. */
fun validateHasReleasableChanges(unreleasedBody: String, newVersion: String) {
    if (!hasReleasableChanges(unreleasedBody)) {
        throw GradleException("CHANGELOG.md's Unreleased section has no entries; add one before releasing $newVersion")
    }
}
