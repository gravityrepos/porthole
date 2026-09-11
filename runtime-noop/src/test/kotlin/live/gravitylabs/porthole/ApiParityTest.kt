// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The no-op module has to offer everything the real runtime does.
 *
 * If it does not, a debug build compiles and the release build fails — which is
 * the worst time to find out, because it happens to whoever is cutting the
 * release rather than to whoever added the integration. This has already caught
 * it once: SqlitePorthole and KtorPorthole were added to the runtime and the
 * sample's release variant stopped compiling.
 *
 * Source text rather than reflection, because the two modules declare the same
 * fully-qualified names and cannot both be on one classpath.
 */
class ApiParityTest {

    private val runtime = File("../runtime/src/main/kotlin/live/gravitylabs/porthole")
    private val noop = File("src/main/kotlin/live/gravitylabs/porthole")

    private fun publicApi(root: File): Set<String> =
        root.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .flatMap { file ->
                val text = file.readText()
                DECLARATION.findAll(text).map { it.groupValues[1] } +
                    TOP_LEVEL_FUN.findAll(text).map { it.groupValues[1] + "()" }
            }
            .toSet()

    @Test
    fun `the runtime source tree is where this test thinks it is`() {
        // A wrong relative path would make every assertion below vacuously pass.
        assertTrue("runtime sources not found at ${runtime.absolutePath}", runtime.isDirectory)
        assertTrue("noop sources not found at ${noop.absolutePath}", noop.isDirectory)
    }

    @Test
    fun `every public declaration in the runtime has a no-op counterpart`() {
        val missing = publicApi(runtime) - publicApi(noop) - ALLOWED_TO_DIFFER

        assertTrue(
            "These are public in the runtime but missing from runtime-noop, so a release " +
                "build using them will not compile: $missing",
            missing.isEmpty(),
        )
    }

    private companion object {
        /**
         * The startup initializer is named by the debug manifest and built by
         * androidx.startup, so it has to be public — and there is nothing for it
         * to initialise in a release build, which is why no-op has no manifest
         * entry and needs no counterpart.
         */
        val ALLOWED_TO_DIFFER = setOf("PortholeInitializer")

        /** Top-level `object Name {` and `class Name(`, ignoring internal and private. */
        val DECLARATION = Regex("^(?!internal |private )(?:object|class) (\\w+)", RegexOption.MULTILINE)

        /**
         * Top-level functions, including extensions.
         *
         * Added after this test watched three of them ship without a no-op and
         * break the release build anyway: it was only comparing types, and an
         * extension function is not one.
         */
        val TOP_LEVEL_FUN = Regex(
            "^(?!internal |private )fun (?:<[^>]+> )?(?:[\\w.<>?]+\\.)?(\\w+)\\(",
            RegexOption.MULTILINE,
        )
    }
}
