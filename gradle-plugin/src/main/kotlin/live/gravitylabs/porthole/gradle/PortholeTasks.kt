// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations
import java.io.ByteArrayOutputStream
import javax.inject.Inject

/**
 * `adb forward tcp:PORT tcp:PORT`, then writes the connection file.
 *
 * The forward is what makes the device's loopback socket reachable from the
 * workstation, and it is deliberately the only bridge: nothing is exposed on a
 * network interface at any point.
 */
abstract class PortholeConnectTask : DefaultTask() {

    @get:Inject
    abstract val exec: ExecOperations

    @get:Input
    abstract val adbExecutable: Property<String>

    @get:Input
    abstract val port: Property<Int>

    @get:Input
    @get:Optional
    abstract val serial: Property<String>

    @get:Input
    @get:Optional
    abstract val applicationId: Property<String>

    @get:OutputFile
    abstract val connectionFile: RegularFileProperty

    @TaskAction
    fun connect() {
        val port = port.get()
        val output = ByteArrayOutputStream()
        val result = exec.exec {
            commandLine(adbArgs(adbExecutable.get(), serial.orNull, "forward", "tcp:$port", "tcp:$port"))
            standardOutput = output
            errorOutput = output
            isIgnoreExitValue = true
        }

        val text = output.toString().trim()
        if (result.exitValue != 0) {
            throw GradleException(
                "adb forward failed (exit ${result.exitValue}): $text\n" +
                    "Check that a device is attached (adb devices) and that the debug build is installed.",
            )
        }

        val file = connectionFile.get().asFile
        file.parentFile.mkdirs()
        file.writeText(
            buildString {
                append("{\n")
                append("  \"port\": ").append(port).append(",\n")
                append("  \"host\": \"127.0.0.1\",\n")
                append("  \"applicationId\": ").append(quote(applicationId.orNull)).append(",\n")
                append("  \"deviceSerial\": ").append(quote(serial.orNull)).append(",\n")
                append("  \"protocol\": 1\n")
                append("}\n")
            },
        )

        logger.lifecycle("[porthole] forwarded 127.0.0.1:$port to the device")
        logger.lifecycle("[porthole] connection file: ${file.absolutePath}")
    }

    private fun quote(value: String?): String = if (value == null) "null" else "\"$value\""
}

/** Removes the forward. Worth running before switching devices. */
abstract class PortholeDisconnectTask : DefaultTask() {

    @get:Inject
    abstract val exec: ExecOperations

    @get:Input
    abstract val adbExecutable: Property<String>

    @get:Input
    abstract val port: Property<Int>

    @get:Input
    @get:Optional
    abstract val serial: Property<String>

    @get:OutputFile
    abstract val connectionFile: RegularFileProperty

    @TaskAction
    fun disconnect() {
        val port = port.get()
        exec.exec {
            commandLine(adbArgs(adbExecutable.get(), serial.orNull, "forward", "--remove", "tcp:$port"))
            isIgnoreExitValue = true
        }
        connectionFile.get().asFile.delete()
        logger.lifecycle("[porthole] removed the forward on tcp:$port")
    }
}

/**
 * Prints the MCP entry. Printing rather than editing `.mcp.json` in place: that
 * file is usually checked in and shared, and a build task should not be
 * rewriting it behind your back.
 */
abstract class PortholeMcpConfigTask : DefaultTask() {

    @get:Input
    abstract val port: Property<Int>

    @get:Input
    abstract val projectName: Property<String>

    @TaskAction
    fun print() {
        val snippet = """
            {
              "mcpServers": {
                "porthole": {
                  "command": "npx",
                  "args": ["-y", "$PORTHOLE_UI_PACKAGE"],
                  "env": {
                    "PORTHOLE_PORT": "${port.get()}"
                  }
                }
              }
            }
        """.trimIndent()

        logger.lifecycle("Add this to .mcp.json in ${projectName.get()}:\n")
        logger.lifecycle(snippet)
        logger.lifecycle("\nThen: ./gradlew portholeConnect, launch the debug build, and the tools go live.")
    }
}

/**
 * Runs the timeline UI, which lives in the npm package alongside the MCP server.
 *
 * It blocks until you stop it, the way a run task does, because the thing it
 * starts is a server you are meant to be watching. Node is required: the UI is
 * a web app, and duplicating it into the AAR to avoid one `npx` would mean
 * shipping a second copy of it inside every debug build.
 */
abstract class PortholeUiTask : DefaultTask() {

    @get:Inject
    abstract val exec: ExecOperations

    @get:Input
    abstract val port: Property<Int>

    @get:Input
    @get:Optional
    abstract val serial: Property<String>

    @get:Input
    abstract val packageVersion: Property<String>

    @get:Input
    abstract val overrideCommand: ListProperty<String>

    @TaskAction
    fun run() {
        val launcher = overrideCommand.get().ifEmpty {
            listOf(
                if (isWindows()) "npx.cmd" else "npx",
                "-y",
                "--package",
                "$PORTHOLE_UI_PACKAGE@" + packageVersion.get(),
                "porthole",
                "ui",
            )
        }

        val command = buildList {
            addAll(launcher)
            add("--port")
            add(port.get().toString())
            serial.orNull?.let {
                add("--serial")
                add(it)
            }
        }

        logger.lifecycle("[porthole] starting the timeline UI; ctrl-c to stop")
        val result = exec.exec {
            commandLine(command)
            isIgnoreExitValue = true
        }
        if (result.exitValue != 0) {
            throw GradleException(
                "The timeline UI exited with " + result.exitValue + ".\n" +
                    "It needs Node on your PATH. Without it, run the tools through your " +
                    "agent instead, or install Node and try again.",
            )
        }
    }

    private fun isWindows(): Boolean =
        System.getProperty("os.name").orEmpty().lowercase().contains("win")
}

internal fun adbArgs(adb: String, serial: String?, vararg rest: String): List<String> = buildList {
    add(adb)
    if (!serial.isNullOrBlank()) {
        add("-s")
        add(serial)
    }
    addAll(rest)
}
