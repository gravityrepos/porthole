// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.testkit.runner.GradleRunner
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The scratch project and the stub adb that [PortholeConnectTaskFunctionalTest]
 * and [PortholeDisconnectTaskFunctionalTest] both run against.
 *
 * The stub is the whole point of both. Asserting a task's outcome alone would
 * pass against a task that runs and does nothing; what has to be true is that
 * adb was invoked again, so the stub records every invocation and the tests
 * count them. A real adb is never involved — these must give the same answer on
 * a machine with no SDK and no device as on one with both.
 *
 * The tasks are registered directly rather than through the plugin, because the
 * plugin only registers them on an Android module and that needs AGP, an SDK
 * and the network. [PortholeAgpCompatibilityTest] covers the wiring; these
 * cover the tasks' own behaviour.
 */
abstract class StubAdbFunctionalTest {

    @get:Rule
    val projectDir = TemporaryFolder()

    /** Where [stubAdb] writes what it was asked to do. */
    protected val log: File
        get() = File(projectDir.root, "adb.log")

    private val gradleVersion: String? =
        System.getProperty("porthole.gradleVersion")?.takeIf(String::isNotBlank)

    protected fun build(vararg arguments: String) =
        GradleRunner.create()
            .withProjectDir(projectDir.root)
            .withPluginClasspath()
            .withArguments(*arguments, "--stacktrace")
            .apply { gradleVersion?.let(::withGradleVersion) }
            .build()

    protected fun write(path: String, text: String): File {
        val file = File(projectDir.root, path)
        file.parentFile.mkdirs()
        file.writeText(text)
        return file
    }

    private fun isWindows(): Boolean =
        System.getProperty("os.name").orEmpty().lowercase().contains("win")

    /**
     * An adb that appends its arguments to [log] and exits with [exitValue].
     *
     * A batch file on Windows and a shell script elsewhere, because that is
     * what the two platforms can actually execute; the recorded line is the
     * same either way. The exit code is a parameter because `adb forward
     * --remove` fails on some platform-tools versions when there was no forward
     * to remove, and that case has to be tested rather than assumed away.
     */
    protected fun stubAdb(exitValue: Int = 0): File {
        val path = log.absolutePath.replace('\\', '/')
        return if (isWindows()) {
            write("stub/adb.bat", "@echo off\r\necho %* >> \"$path\"\r\nexit /b $exitValue\r\n")
        } else {
            val script = write("stub/adb", "#!/bin/sh\necho \"$@\" >> \"$path\"\nexit $exitValue\n")
            script.setExecutable(true)
            script
        }
    }

    /** Lines the stub recorded, ignoring the blank ones `echo` can leave. */
    protected fun invocations(): List<String> =
        if (log.isFile) log.readLines().map(String::trim).filter(String::isNotEmpty) else emptyList()

    /** A Kotlin string literal for a Windows path, backslashes and all. */
    protected fun quoted(path: String): String = "\"" + path.replace("\\", "\\\\") + "\""

    /**
     * A scratch project whose build script is [body], with the porthole task
     * types imported and the plugin applied.
     *
     * Applying it is what gets TestKit's injected classpath into the build
     * script so the task types below resolve. On a project with no Android
     * plugin it registers nothing and only warns, which is why [body] registers
     * by hand whatever the test is about to run.
     */
    protected fun scratchProject(body: String) {
        write("settings.gradle.kts", "rootProject.name = \"scratch\"\n")
        write(
            "build.gradle.kts",
            """
            @file:Suppress("UNUSED_IMPORT")

            import live.gravitylabs.porthole.gradle.PortholeConnectTask
            import live.gravitylabs.porthole.gradle.PortholeDisconnectTask

            plugins { id("live.gravitylabs.porthole") }

            """.trimIndent() + "\n" + body.trimIndent() + "\n",
        )
    }

    /** The connection file both tasks are pointed at. */
    protected val connectionFile: File
        get() = File(projectDir.root, "build/porthole/connection.json")

    /** `portholeConnect`, wired to [adb] and the usual port. */
    protected fun connectTask(adb: File): String =
        """
        tasks.register<PortholeConnectTask>("portholeConnect") {
            adbExecutable.set(${quoted(adb.absolutePath)})
            port.set(8677)
            connectionFile.set(layout.buildDirectory.file("porthole/connection.json"))
        }
        """

    /** `portholeDisconnect`, wired to the same adb, port and file. */
    protected fun disconnectTask(adb: File): String =
        """
        tasks.register<PortholeDisconnectTask>("portholeDisconnect") {
            adbExecutable.set(${quoted(adb.absolutePath)})
            port.set(8677)
            connectionFile.set(layout.buildDirectory.file("porthole/connection.json"))
        }
        """
}
