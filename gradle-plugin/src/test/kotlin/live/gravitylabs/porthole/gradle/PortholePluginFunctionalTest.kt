// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.testkit.runner.GradleRunner
import org.gradle.testkit.runner.TaskOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Applied to a real build, by id, through TestKit.
 *
 * These deliberately use a plain JVM project rather than an Android one. The
 * Android path needs AGP and an SDK, which is an integration test's problem;
 * what matters here is that a build which applies the plugin in the wrong place
 * says so clearly instead of failing somewhere confusing later.
 */
class PortholePluginFunctionalTest {

    @get:Rule
    val projectDir = TemporaryFolder()

    /**
     * The Gradle to run against. Unset means the one running this test; a value
     * makes TestKit fetch that distribution instead, which is how the plugin is
     * checked against Gradle versions newer than the one it was built with.
     *
     *     ./gradlew -p gradle-plugin test -Pporthole.gradleVersion=9.7.1
     */
    private val gradleVersion: String? =
        System.getProperty("porthole.gradleVersion")?.takeIf(String::isNotBlank)

    private fun build(vararg arguments: String) =
        GradleRunner.create()
            .withProjectDir(projectDir.root)
            .withPluginClasspath()
            .withArguments(*arguments, "--stacktrace")
            .apply { gradleVersion?.let(::withGradleVersion) }
            .build()

    private fun write(path: String, text: String) {
        val file = File(projectDir.root, path)
        file.parentFile.mkdirs()
        file.writeText(text)
    }

    private fun scratchProject(extensionBlock: String = "") {
        write("settings.gradle.kts", "rootProject.name = \"scratch\"\n")
        write(
            "build.gradle.kts",
            """
            plugins { id("live.gravitylabs.porthole") }
            $extensionBlock
            """.trimIndent(),
        )
    }

    @Test
    fun `applies cleanly to a project with no android plugin`() {
        scratchProject()
        val result = build("help")

        assertEquals(TaskOutcome.SUCCESS, result.task(":help")?.outcome)
    }

    @Test
    fun `warns when it is applied somewhere it can do nothing`() {
        scratchProject()
        val result = build("help")

        assertTrue(
            "expected a warning naming the project, got:\n${result.output}",
            result.output.contains("[porthole] no Android plugin found"),
        )
    }

    @Test
    fun `registers no tasks without an android plugin, rather than broken ones`() {
        scratchProject()
        val result = build("tasks", "--all")

        // The tasks drive adb against a built app; offering them on a project
        // that has neither would be a trap.
        assertFalse(result.output.contains("portholeConnect"))
        assertFalse(result.output.contains("portholeUi"))
    }

    @Test
    fun `accepts configuration without an android plugin present`() {
        // A build should be able to set its port next to the plugin block
        // without that ordering being load-bearing.
        scratchProject(
            """
            porthole {
                port.set(9123)
                debugBuildTypes.set(listOf("debug", "staging"))
                deviceSerial.set("emulator-5554")
            }
            """.trimIndent(),
        )

        assertEquals(TaskOutcome.SUCCESS, build("help").task(":help")?.outcome)
    }

    @Test
    fun `can be turned off without being removed`() {
        scratchProject("porthole { enabled.set(false) }")

        assertEquals(TaskOutcome.SUCCESS, build("help").task(":help")?.outcome)
    }
}
