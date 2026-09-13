// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.testkit.runner.GradleRunner
import org.gradle.testkit.runner.TaskOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * `portholeConnect` run twice, against an adb that is a script.
 *
 * The bug this guards against is silent and total: the task declared the
 * connection file as an output, so its second run was up to date, and Gradle
 * printed success without running adb. The forward it claims to have made lives
 * in the adb server, so a stale one is invisible from the file system — every
 * MCP tool then reports not-connected and tells the user to run the command
 * that just lied to them.
 *
 * The stub is the whole point. Asserting the outcome alone would pass against a
 * task that runs and does nothing; what has to be true is that adb was invoked
 * a second time, so the stub records every invocation and the test counts them.
 * A real adb is never involved — this must give the same answer on a machine
 * with no SDK and no device as on one with both.
 *
 * The task is registered directly rather than through the plugin, because the
 * plugin only registers it on an Android module and that needs AGP, an SDK and
 * the network. [PortholeAgpCompatibilityTest] covers the wiring; this covers the
 * task's own behaviour.
 */
class PortholeConnectTaskFunctionalTest {

    @get:Rule
    val projectDir = TemporaryFolder()

    private val gradleVersion: String? =
        System.getProperty("porthole.gradleVersion")?.takeIf(String::isNotBlank)

    private fun build(vararg arguments: String) =
        GradleRunner.create()
            .withProjectDir(projectDir.root)
            .withPluginClasspath()
            .withArguments(*arguments, "--stacktrace")
            .apply { gradleVersion?.let(::withGradleVersion) }
            .build()

    private fun write(path: String, text: String): File {
        val file = File(projectDir.root, path)
        file.parentFile.mkdirs()
        file.writeText(text)
        return file
    }

    private fun isWindows(): Boolean =
        System.getProperty("os.name").orEmpty().lowercase().contains("win")

    /**
     * An adb that appends its arguments to [log] and succeeds.
     *
     * A batch file on Windows and a shell script elsewhere, because that is
     * what the two platforms can actually execute; the recorded line is the
     * same either way.
     */
    private fun stubAdb(log: File): File {
        val path = log.absolutePath.replace('\\', '/')
        return if (isWindows()) {
            write("stub/adb.bat", "@echo off\r\necho %* >> \"$path\"\r\nexit /b 0\r\n")
        } else {
            val script = write("stub/adb", "#!/bin/sh\necho \"$@\" >> \"$path\"\nexit 0\n")
            script.setExecutable(true)
            script
        }
    }

    /** Lines the stub recorded, ignoring the blank ones `echo` can leave. */
    private fun invocations(log: File): List<String> =
        if (log.isFile) log.readLines().map(String::trim).filter(String::isNotEmpty) else emptyList()

    private fun scratchProject(adb: File) {
        write("settings.gradle.kts", "rootProject.name = \"scratch\"\n")
        write(
            "build.gradle.kts",
            """
            import live.gravitylabs.porthole.gradle.PortholeConnectTask

            // Applied so that TestKit's injected classpath reaches the build
            // script and the task type below resolves. On a project with no
            // Android plugin it registers nothing and only warns.
            plugins { id("live.gravitylabs.porthole") }

            tasks.register<PortholeConnectTask>("portholeConnect") {
                adbExecutable.set(${quoted(adb.absolutePath)})
                port.set(8677)
                connectionFile.set(layout.buildDirectory.file("porthole/connection.json"))
            }
            """.trimIndent(),
        )
    }

    /** A Kotlin string literal for a Windows path, backslashes and all. */
    private fun quoted(path: String): String = "\"" + path.replace("\\", "\\\\") + "\""

    @Test
    fun `runs adb again on the second invocation instead of reporting up to date`() {
        val log = File(projectDir.root, "adb.log")
        scratchProject(stubAdb(log))

        val first = build("portholeConnect")
        assertEquals(TaskOutcome.SUCCESS, first.task(":portholeConnect")?.outcome)

        val second = build("portholeConnect")
        assertEquals(
            "the forward lives in the adb server, so this task must never be up to date:\n" +
                second.output,
            TaskOutcome.SUCCESS,
            second.task(":portholeConnect")?.outcome,
        )

        val recorded = invocations(log)
        assertEquals("expected two adb invocations, got $recorded", 2, recorded.size)
        for (line in recorded) {
            assertTrue("expected a forward, got: $line", line.contains("forward tcp:8677 tcp:8677"))
        }
    }

    @Test
    fun `runs adb again even when the connection file was left untouched`() {
        // The narrower statement of the same thing: nothing is deleted between
        // the runs, the inputs do not move, and adb is still asked twice.
        val log = File(projectDir.root, "adb.log")
        scratchProject(stubAdb(log))

        build("portholeConnect")
        val connection = File(projectDir.root, "build/porthole/connection.json")
        assertTrue("expected a connection file at ${connection.absolutePath}", connection.isFile)
        val written = connection.readText()

        build("portholeConnect")

        assertEquals(2, invocations(log).size)
        assertEquals("the connection file should be rewritten identically", written, connection.readText())
    }

    @Test
    fun `stays compatible with the configuration cache`() {
        val log = File(projectDir.root, "adb.log")
        scratchProject(stubAdb(log))

        val first = build("portholeConnect", "--configuration-cache")
        assertTrue(
            "expected the configuration cache to be stored, got:\n${first.output}",
            first.output.contains("Configuration cache entry stored"),
        )

        // Reused, not re-stored: nothing about the task captures state that
        // only exists at configuration time, so the second run is served from
        // the cache and still executes.
        val second = build("portholeConnect", "--configuration-cache")
        assertTrue(
            "expected the configuration cache to be reused, got:\n${second.output}",
            second.output.contains("Configuration cache entry reused"),
        )
        assertEquals(TaskOutcome.SUCCESS, second.task(":portholeConnect")?.outcome)
        assertEquals(2, invocations(log).size)
    }
}
