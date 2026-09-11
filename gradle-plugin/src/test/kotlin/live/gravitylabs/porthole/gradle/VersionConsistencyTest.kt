// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Everything Porthole publishes carries the same version, and this proves it.
 *
 * The plugin does not merely have a version — it hands two of them to other
 * people. `runtimeVersion` becomes a dependency in the consumer's build, and
 * `uiPackageVersion` becomes the npm package `portholeUi` launches. Both used
 * to be literals in [PortholePlugin], and a literal that disagrees with what
 * was actually published breaks nothing here: this build compiles, the publish
 * succeeds, and the failure surfaces later as an unresolvable artifact in the
 * build of whoever applied the plugin, with nothing pointing at the cause.
 *
 * Two of the three are now generated from `porthole` in the version catalog, so
 * they cannot drift. The npm package is the one that still has to be edited by
 * hand, which is what most of this test is for.
 */
class VersionConsistencyTest {

    /** Tests run from the included build's directory, so the root is one up. */
    private val root = File(System.getProperty("user.dir")).parentFile!!

    private fun read(path: String): String {
        val file = File(root, path)
        assertTrue("expected to find $path at ${file.absolutePath}", file.isFile)
        return file.readText()
    }

    /** The `porthole` entry under `[versions]`, which is the source of truth. */
    private val catalogVersion: String by lazy {
        val toml = read("gradle/libs.versions.toml")
        val match = Regex("""^porthole\s*=\s*"([^"]+)"""", RegexOption.MULTILINE).find(toml)
        requireNotNull(match) { "no `porthole` entry under [versions] in the catalog" }
            .groupValues[1]
    }

    @Test
    fun `the catalog names a version at all`() {
        // Guards the regexes below: a parse that silently found nothing would
        // make every other assertion here compare two empty strings.
        assertTrue("catalog version looks empty", catalogVersion.isNotBlank())
        assertTrue(
            "expected a dotted version, got '$catalogVersion'",
            catalogVersion.matches(Regex("""\d+\.\d+\.\d+(-.+)?""")),
        )
    }

    @Test
    fun `the version the plugin hands consumers is the published one`() {
        // Generated, so this is really asserting that generation is wired up.
        assertEquals(catalogVersion, PortholePlugin.PLUGIN_VERSION)
    }

    @Test
    fun `the npm package the ui task launches is the published one`() {
        val packageJson = read("mcp/package.json")
        val match = Regex("""^ {2}"version":\s*"([^"]+)"""", RegexOption.MULTILINE)
            .find(packageJson)
        val npmVersion = requireNotNull(match) { "no top-level version in mcp/package.json" }
            .groupValues[1]

        assertEquals(
            "mcp/package.json is on $npmVersion but the catalog says $catalogVersion. " +
                "portholeUi runs `npx --package @gravitylabs/porthole@${PortholePlugin.UI_PACKAGE_VERSION}`, " +
                "so a mismatch here means the task fetches a version that was never published.",
            catalogVersion,
            npmVersion,
        )
    }

    @Test
    fun `a release is not published from a snapshot`() {
        // Maven Central rejects -SNAPSHOT outright, but the Plugin Portal and
        // the generated constant would carry it happily.
        assertTrue(
            "version is $catalogVersion; Maven Central will not take a snapshot",
            !catalogVersion.endsWith("-SNAPSHOT"),
        )
    }
}
