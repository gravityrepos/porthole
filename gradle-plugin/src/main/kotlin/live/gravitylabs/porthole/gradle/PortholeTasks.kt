// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations
import java.io.ByteArrayOutputStream
import java.io.File
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
 * Writes the MCP server entry into `.mcp.json`.
 *
 * It used to print a snippet to paste, on the reasoning that `.mcp.json` is
 * usually checked in and a build task should not rewrite a shared file behind
 * your back. That reasoning is sound and this keeps it: the file is only
 * changed when the change is unambiguous, and the task says exactly what it
 * did and where.
 *
 *  - no file          create it
 *  - no porthole key  add it, keeping every other server untouched
 *  - same entry       say so and touch nothing
 *  - different entry  refuse, print the difference, and wait to be told
 *
 * That last case is the one worth refusing. A porthole entry that disagrees
 * with this project was put there on purpose — a different port, a pinned
 * version, a local build — and silently correcting it would be the behaviour
 * the original comment was guarding against. `-Pporthole.overwrite=true`
 * replaces it.
 */
abstract class PortholeMcpConfigTask : DefaultTask() {

    @get:Input
    abstract val port: Property<Int>

    @get:Input
    abstract val projectName: Property<String>

    /**
     * Deliberately not an `@OutputFile`. It lives in the source tree, not the
     * build directory, and letting Gradle treat it as task output would invite
     * `clean` to delete a file the project owns.
     */
    @get:Internal
    abstract val configFile: RegularFileProperty

    @get:Input
    @get:Optional
    abstract val overwrite: Property<Boolean>

    private fun entry(): String =
        """
        {
          "command": "npx",
          "args": ["-y", "$PORTHOLE_UI_PACKAGE"],
          "env": {
            "PORTHOLE_PORT": "${port.get()}"
          }
        }
        """.trimIndent()

    @TaskAction
    fun write() {
        val file = configFile.get().asFile
        val json = JsonSlurper()

        @Suppress("UNCHECKED_CAST")
        val root: MutableMap<String, Any?> =
            if (file.isFile && file.readText().isNotBlank()) {
                (json.parseText(file.readText()) as? Map<String, Any?>)?.toMutableMap()
                    ?: throw GradleException("${file.name} is not a JSON object; leaving it alone.")
            } else {
                mutableMapOf()
            }

        @Suppress("UNCHECKED_CAST")
        val servers =
            (root["mcpServers"] as? Map<String, Any?>)?.toMutableMap() ?: mutableMapOf()

        @Suppress("UNCHECKED_CAST")
        val wanted = json.parseText(entry()) as Map<String, Any?>
        val existing = servers["porthole"]

        if (existing == wanted) {
            logger.lifecycle("[porthole] ${file.name} already has a matching entry. Nothing to do.")
            return
        }

        if (existing != null && overwrite.getOrElse(false) != true) {
            logger.lifecycle("[porthole] ${file.name} already defines 'porthole', and it differs:")
            logger.lifecycle("  there: ${JsonOutput.toJson(existing)}")
            logger.lifecycle("  here:  ${JsonOutput.toJson(wanted)}")
            logger.lifecycle(
                "Left as it is — a different entry is usually deliberate. " +
                    "Re-run with -Pporthole.overwrite=true to replace it.",
            )
            return
        }

        servers["porthole"] = wanted
        root["mcpServers"] = servers

        // Back the file up before rewriting it. Merging reformats the whole
        // document, and someone should be able to get their formatting back.
        if (file.isFile) {
            file.copyTo(File(file.parentFile, "${file.name}.bak"), overwrite = true)
        }
        file.parentFile?.mkdirs()
        file.writeText(JsonOutput.prettyPrint(JsonOutput.toJson(root)) + "\n")

        val what = if (existing != null) "replaced the entry in" else "added porthole to"
        logger.lifecycle("[porthole] $what ${file.path}")
        if (file.resolveSibling("${file.name}.bak").isFile) {
            logger.lifecycle("[porthole] previous contents: ${file.name}.bak")
        }
        logger.lifecycle(
            "[porthole] next: ./gradlew portholeConnect, launch the debug build, " +
                "and the tools go live in ${projectName.get()}.",
        )
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
