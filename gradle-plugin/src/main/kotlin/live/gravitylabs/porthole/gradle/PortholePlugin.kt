// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.provider.Provider
import org.gradle.kotlin.dsl.register
import java.io.File
import java.util.Properties

/**
 * Wires Porthole into an Android module.
 *
 * Three jobs:
 *  1. put the real runtime on debug build types and the no-op on the rest
 *  2. generate the `porthole_port` resource so the port lives in one place
 *  3. own the `adb forward` and the connection file the MCP server reads
 *
 * Apply it to your app module:
 * ```kotlin
 * plugins { id("live.gravitylabs.porthole") }
 * ```
 */
class PortholePlugin : Plugin<Project> {

    override fun apply(target: Project) {
        val extension = target.extensions.create("porthole", PortholeExtension::class.java).apply {
            port.convention(DEFAULT_PORT)
            debugBuildTypes.convention(listOf("debug"))
            runtimeVersion.convention(PLUGIN_VERSION)
            useProjectDependencies.convention(false)
            uiPackageVersion.convention(UI_PACKAGE_VERSION)
            uiCommand.convention(emptyList())
            enabled.convention(true)
        }

        var configured = false
        fun once(finalizeDsl: () -> Unit) {
            if (configured) return
            configured = true
            finalizeDsl()
            registerTasks(target, extension)
        }

        // Delegated to [AndroidWiring], which is the only class here allowed to
        // name an AGP type. Nothing in this file may, or applying the plugin to
        // a project without the Android plugin fails while Gradle is still
        // decorating the class — see that file for why.
        target.plugins.withId("com.android.application") {
            once { AndroidWiring.application(target, extension) }
        }
        target.plugins.withId("com.android.library") {
            once { AndroidWiring.library(target, extension) }
        }

        target.afterEvaluate {
            if (!configured) {
                logger.warn(
                    "[porthole] no Android plugin found on ${target.path}; " +
                        "apply this plugin to your app module.",
                )
            }
        }
    }

    private fun registerTasks(project: Project, extension: PortholeExtension) {
        val adb = adbProvider(project)
        val connectionPath = project.layout.buildDirectory.file("porthole/connection.json")

        project.tasks.register<PortholeConnectTask>("portholeConnect") {
            group = GROUP
            description = "Forwards the device's porthole port to localhost and writes the connection file."
            adbExecutable.set(adb)
            port.set(extension.port)
            serial.set(extension.deviceSerial)
            applicationId.set(extension.applicationId)
            connectionFile.set(connectionPath)
        }

        project.tasks.register<PortholeDisconnectTask>("portholeDisconnect") {
            group = GROUP
            description = "Removes the adb forward created by portholeConnect."
            adbExecutable.set(adb)
            port.set(extension.port)
            serial.set(extension.deviceSerial)
            connectionFile.set(connectionPath)
        }

        project.tasks.register<PortholeUiTask>("portholeUi") {
            group = GROUP
            description = "Opens the live timeline in a browser. Forwards the port itself."
            port.set(extension.port)
            serial.set(extension.deviceSerial)
            packageVersion.set(extension.uiPackageVersion)
            overrideCommand.set(extension.uiCommand)
        }

        project.tasks.register<PortholeMcpConfigTask>("portholeMcpConfig") {
            group = GROUP
            description = "Writes the MCP server entry into .mcp.json."
            port.set(extension.port)
            projectName.set(project.rootProject.name)
            // The root of the build, which is where an MCP client looks.
            configFile.set(project.rootProject.layout.projectDirectory.file(".mcp.json"))
            overwrite.set(
                project.providers.gradleProperty("porthole.overwrite").map { it == "true" },
            )
        }
    }

    /**
     * adb, in the order a developer would look for it: an explicit override,
     * then the SDK location Gradle already knows, then the PATH.
     */
    private fun adbProvider(project: Project): Provider<String> = project.providers.provider {
        val override = project.findProperty("porthole.adb") as String?
        if (!override.isNullOrBlank()) return@provider override

        val sdk = sdkDirectory(project)
        val binary = if (isWindows()) "adb.exe" else "adb"
        val candidate = sdk?.resolve("platform-tools")?.resolve(binary)
        if (candidate != null && candidate.isFile) candidate.absolutePath else binary
    }

    private fun sdkDirectory(project: Project): File? {
        val local = File(project.rootDir, "local.properties")
        if (local.isFile) {
            val props = Properties()
            local.inputStream().use(props::load)
            props.getProperty("sdk.dir")?.let { return File(it) }
        }
        return sequenceOf("ANDROID_HOME", "ANDROID_SDK_ROOT")
            .mapNotNull { System.getenv(it) }
            .map(::File)
            .firstOrNull { it.isDirectory }
    }

    private fun isWindows(): Boolean =
        System.getProperty("os.name").orEmpty().lowercase().contains("win")

    companion object {
        const val GROUP = "compose porthole"
        const val DEFAULT_PORT = 8677

        /**
         * The runtime version handed to consumers, and the npm version
         * `portholeUi` launches. Both are [PORTHOLE_VERSION], generated from
         * the version catalog — everything Porthole publishes ships together,
         * and the failure mode for a stale literal here lands in someone
         * else's build rather than this one.
         */
        const val PLUGIN_VERSION = PORTHOLE_VERSION
        const val UI_PACKAGE_VERSION = PORTHOLE_VERSION
    }
}
