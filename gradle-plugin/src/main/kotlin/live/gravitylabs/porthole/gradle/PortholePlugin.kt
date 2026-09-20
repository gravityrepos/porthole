// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.provider.Provider
import org.gradle.kotlin.dsl.register

/**
 * Wires Porthole into an Android module.
 *
 * Three jobs:
 *  1. put the real runtime on debug build types and the no-op on the rest
 *  2. generate the `porthole_port` resource so the port lives in one place
 *  3. own the `adb forward` and record it to a connection file (see
 *     [PortholeConnectTask.connectionFile]) — as of now nothing reads that
 *     file back automatically
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
            ringCapacity.convention(DEFAULT_RING_CAPACITY)
            debugBuildTypes.convention(listOf("debug"))
            runtimeVersion.convention(PLUGIN_VERSION)
            useProjectDependencies.convention(false)
            uiPackageVersion.convention(UI_PACKAGE_VERSION)
            uiCommand.convention(emptyList())
            mcpCommand.convention(emptyList())
            enabled.convention(true)
        }

        var configured = false
        fun once(wireAndRegister: () -> Unit) {
            if (configured) return
            configured = true
            wireAndRegister()
        }

        // Delegated to [AndroidWiring], which is the only class here allowed to
        // name an AGP type. Nothing in this file may, or applying the plugin to
        // a project without the Android plugin fails while Gradle is still
        // decorating the class — see that file for why.
        target.plugins.withId("com.android.application") {
            once {
                // Only an application module gets portholeStart (GRA-174):
                // there is no install task on a library to depend on, so
                // AndroidWiring.library below hands registerTasks no variant
                // names at all and it registers nothing extra.
                val debugVariants = AndroidWiring.application(target, extension)
                registerTasks(target, extension, debugVariants)
            }
        }
        target.plugins.withId("com.android.library") {
            once {
                AndroidWiring.library(target, extension)
                registerTasks(target, extension, debugVariants = null)
            }
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

    /**
     * [debugVariants] is non-null only for an application module (see
     * [AndroidWiring.application]) and is what lets `portholeStart` exist at
     * all: a library module has no `install<Variant>` task, so there is
     * nothing for a start task to depend on and none is registered.
     */
    private fun registerTasks(project: Project, extension: PortholeExtension, debugVariants: Provider<List<String>>?) {
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

        project.tasks.register<PortholeTraceProcessorTask>("portholeTraceProcessor") {
            group = GROUP
            description = "Downloads and verifies Perfetto's trace_processor, so trace questions can be answered."
            refresh.set(
                project.providers.gradleProperty("porthole.refresh").map { it == "true" },
            )
        }

        project.tasks.register<PortholeMcpConfigTask>("portholeMcpConfig") {
            group = GROUP
            description = "Writes the MCP server entry into .mcp.json."
            port.set(extension.port)
            projectName.set(project.rootProject.name)
            applicationId.set(extension.applicationId)
            // GRA-195: the version this build knows the npm package as, so the
            // written entry cannot drift from what portholeUi and the runtime
            // AAR resolve to.
            packageVersion.set(extension.uiPackageVersion)
            mcpCommand.set(extension.mcpCommand)
            // The root of the build, which is where an MCP client looks.
            configFile.set(project.rootProject.layout.projectDirectory.file(".mcp.json"))
            overwrite.set(
                project.providers.gradleProperty("porthole.overwrite").map { it == "true" },
            )
        }

        if (debugVariants != null) {
            registerPortholeStart(
                project = project,
                variants = debugVariants,
                requestedVariant = project.providers.gradleProperty("porthole.variant"),
                openUi = project.providers.gradleProperty("porthole.open").map { it != "false" },
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

        // resolveSdkDir lives in PortholeTasks.kt (GRA-150): one resolver,
        // shared with PortholeMcpConfigTask, instead of a second copy kept in
        // step by hand.
        val sdk = resolveSdkDir(project.rootDir)
        val binary = if (isWindows()) "adb.exe" else "adb"
        val candidate = sdk?.resolve("platform-tools")?.resolve(binary)
        if (candidate != null && candidate.isFile) candidate.absolutePath else binary
    }

    private fun isWindows(): Boolean =
        System.getProperty("os.name").orEmpty().lowercase().contains("win")

    companion object {
        const val GROUP = "compose porthole"
        const val DEFAULT_PORT = 8677

        /** See [PortholeExtension.ringCapacity]'s KDoc for the arithmetic behind this number. */
        const val DEFAULT_RING_CAPACITY = 2048

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
