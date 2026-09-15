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

    private fun androidProject(sdk: String, agp: String) {
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

    private fun prepare(): Boolean {
        val agp = agpVersion ?: return false
        assumeTrue("no plugin version; the build did not publish one", pluginVersion.isNotBlank())
        val sdk = sdkDirectory()
        assumeTrue("no Android SDK; set ANDROID_HOME", sdk != null)
        androidProject(sdk!!, agp)
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
}
