// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.testkit.runner.GradleRunner
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.Properties

/**
 * The plugin applied to a real Android project, on a chosen AGP and Gradle.
 *
 * This exists because of a bug the rest of the suite could not have caught. AGP
 * 9 ships `resValues` disabled by default, and this plugin writes the port as a
 * resource value; an app on AGP 9 therefore failed to configure at all, with
 * "Build Type debug contains custom resource values, but the feature is
 * disabled". Nothing here was wrong — the plugin was simply only ever exercised
 * against the AGP its own build uses, which is a version behind.
 *
 * Skipped unless asked for, because it needs an SDK and the network:
 *
 *     ./gradlew -p gradle-plugin test -Pporthole.agpVersion=9.4.0
 *     ./gradlew -p gradle-plugin test -Pporthole.agpVersion=9.4.0 -Pporthole.gradleVersion=9.7.1
 */
class PortholeAgpCompatibilityTest {

    @get:Rule
    val projectDir = TemporaryFolder()

    private val agpVersion: String? =
        System.getProperty("porthole.agpVersion")?.takeIf(String::isNotBlank)

    private val gradleVersion: String? =
        System.getProperty("porthole.gradleVersion")?.takeIf(String::isNotBlank)

    /**
     * The version published to the local Maven cache for this test to resolve.
     *
     * Resolved rather than injected with `withPluginClasspath()`, because that
     * puts the plugin in a different classloader from the AGP the build script
     * applies, and the plugin then cannot see AGP's own classes. Going through
     * mavenLocal is also what a consumer does, which is the thing being tested.
     */
    private val pluginVersion: String =
        System.getProperty("porthole.pluginVersion").orEmpty()

    private fun write(path: String, text: String) {
        val file = File(projectDir.root, path)
        file.parentFile.mkdirs()
        file.writeText(text)
    }

    /** Where the SDK is, asked for the same way the plugin itself asks. */
    private fun sdkDirectory(): String? {
        val fromEnv = sequenceOf("ANDROID_HOME", "ANDROID_SDK_ROOT")
            .mapNotNull(System::getenv)
            .firstOrNull { File(it).isDirectory }
        if (fromEnv != null) return fromEnv

        // The plugin's own repository has one, and this test usually runs there.
        val local = File(System.getProperty("user.dir")).parentFile?.resolve("local.properties")
        if (local != null && local.isFile) {
            val props = Properties()
            local.inputStream().use(props::load)
            return props.getProperty("sdk.dir")?.takeIf { File(it).isDirectory }
        }
        return null
    }

    private fun androidProject(sdk: String, agp: String, extensionBlock: String = "") {
        write("local.properties", "sdk.dir=${sdk.replace('\\', '/')}\n")
        write(
            "settings.gradle.kts",
            """
            pluginManagement {
                repositories { mavenLocal(); google(); gradlePluginPortal(); mavenCentral() }
            }
            dependencyResolutionManagement {
                repositories { mavenLocal(); google(); mavenCentral() }
            }
            rootProject.name = "compat"
            include(":app")
            """.trimIndent(),
        )
        write(
            "build.gradle.kts",
            """plugins { id("com.android.application") version "$agp" apply false }""",
        )
        write(
            "app/build.gradle.kts",
            """
            plugins {
                id("com.android.application")
                id("live.gravitylabs.porthole") version "$pluginVersion"
            }

            android {
                namespace = "compat.app"
                compileSdk = 36
                defaultConfig { minSdk = 23 }
            }

            $extensionBlock
            """.trimIndent(),
        )
        write("app/src/main/AndroidManifest.xml", "<manifest />\n")
    }

    private fun run(vararg arguments: String) =
        GradleRunner.create()
            .withProjectDir(projectDir.root)
            .withArguments(*arguments, "--stacktrace")
            .apply { gradleVersion?.let(::withGradleVersion) }
            .build()

    private fun prepare(extensionBlock: String = ""): Boolean {
        val agp = agpVersion ?: return false
        assumeTrue("no plugin version; the build did not publish one", pluginVersion.isNotBlank())
        val sdk = sdkDirectory()
        assumeTrue("no Android SDK; set ANDROID_HOME", sdk != null)
        androidProject(sdk!!, agp, extensionBlock)
        return true
    }

    @Test
    fun `configures an android app and registers its tasks`() {
        assumeTrue("set -Pporthole.agpVersion to run", prepare())

        // Configuration is the whole point: the resValues bug was a
        // configuration failure, long before anything was assembled.
        val output = run(":app:tasks", "--group=${PortholePlugin.GROUP}").output

        for (task in listOf(
            "portholeConnect",
            "portholeDisconnect",
            "portholeUi",
            "portholeMcpConfig",
            "portholeTraceProcessor",
            "portholeStart",
        )) {
            assertTrue("expected $task in:\n$output", output.contains(task))
        }
    }

    @Test
    fun `configures under the configuration cache`() {
        assumeTrue("set -Pporthole.agpVersion to run", prepare())

        // Deliberately not portholeConnect: that one runs adb, and a test has
        // no business reaching for whatever device the machine has plugged in.
        val output = run(":app:tasks", "--group=${PortholePlugin.GROUP}", "--configuration-cache").output

        assertTrue(
            "expected the configuration cache to be stored, got:\n$output",
            output.contains("Configuration cache entry stored"),
        )
    }

    /**
     * GRA-53: `ringCapacity` reaches the runtime the same way `port` always
     * has — a generated `resValue`, wired in [AndroidWiring.wire] right next
     * to `porthole_port` — so this is the same proof this file already gives
     * the port, extended to cover the second resource. Both are configured to
     * non-default values so a test that accidentally asserted the *default*
     * instead of the *configured* value would fail.
     *
     * The generated file's exact path has moved between AGP versions, so
     * this walks the whole build output for it rather than hard-coding one —
     * the claim under test is "the value reaches a real generated resource
     * somewhere", not "at this specific path this AGP version happens to use".
     */
    @Test
    fun `emits the ring capacity resValue with the configured value, beside the port`() {
        assumeTrue(
            "set -Pporthole.agpVersion to run",
            prepare(
                """
                porthole {
                    port.set(9234)
                    ringCapacity.set(6000)
                }
                """.trimIndent(),
            ),
        )

        run(":app:generateDebugResValues")

        val generated = File(projectDir.root, "app/build").walkTopDown()
            .filter { it.isFile && it.extension == "xml" }
            .firstOrNull { it.readText().contains("porthole_ring_capacity") }
        assertTrue(
            "expected a generated resValues XML naming porthole_ring_capacity under app/build",
            generated != null,
        )
        val text = generated!!.readText()
        assertTrue("expected the configured ring capacity (6000) in:\n$text", text.contains("6000"))
        assertTrue("expected porthole_port beside it, same mechanism, in:\n$text", text.contains("porthole_port"))
        assertTrue("expected the configured port (9234) in:\n$text", text.contains("9234"))
    }
}
