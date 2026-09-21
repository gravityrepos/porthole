// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.api.Action
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.execution.TaskExecutionGraph
import org.gradle.api.provider.Provider
import org.gradle.kotlin.dsl.register
import java.io.File
import java.util.concurrent.Callable

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
            strictMode.convention(false)
            legacyTcpPort.convention(false)
            composableNames.convention(false)
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
                // there is no install task on a library to depend on. Every
                // debug variant, application or library, gets
                // portholeComposeReport (GRA-69) — see AndroidWiring.library's
                // own KDoc for why that changed.
                val debugVariants = AndroidWiring.application(target, extension)
                registerTasks(target, extension, startVariants = debugVariants, composeReportVariants = debugVariants)
            }
        }
        target.plugins.withId("com.android.library") {
            once {
                val debugVariants = AndroidWiring.library(target, extension)
                registerTasks(target, extension, startVariants = null, composeReportVariants = debugVariants)
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
     * [startVariants] is non-null only for an application module (see
     * [AndroidWiring.application]) and is what lets `portholeStart` exist at
     * all: a library module has no `install<Variant>` task, so there is
     * nothing for a start task to depend on and none is registered.
     * [composeReportVariants] is never null (GRA-69): both
     * [AndroidWiring.application] and [AndroidWiring.library] return their
     * debug variant names now, so `portholeComposeReport` registers on
     * either kind of module.
     */
    private fun registerTasks(
        project: Project,
        extension: PortholeExtension,
        startVariants: Provider<List<String>>?,
        composeReportVariants: Provider<List<String>>,
    ) {
        val adb = adbProvider(project)
        val connectionPath = project.layout.buildDirectory.file("porthole/connection.json")

        project.tasks.register<PortholeConnectTask>("portholeConnect") {
            group = GROUP
            description = "Forwards the device's porthole port to localhost and writes the connection file."
            adbExecutable.set(adb)
            port.set(extension.port)
            serial.set(extension.deviceSerial)
            applicationId.set(extension.applicationId)
            legacyTcpPort.set(extension.legacyTcpPort)
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
            applicationId.set(extension.applicationId)
            legacyTcpPort.set(extension.legacyTcpPort)
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
            legacyTcpPort.set(extension.legacyTcpPort)
            // The root of the build, which is where an MCP client looks.
            configFile.set(project.rootProject.layout.projectDirectory.file(".mcp.json"))
            overwrite.set(
                project.providers.gradleProperty("porthole.overwrite").map { it == "true" },
            )
        }

        if (startVariants != null) {
            registerPortholeStart(
                project = project,
                variants = startVariants,
                requestedVariant = project.providers.gradleProperty("porthole.variant"),
                openUi = project.providers.gradleProperty("porthole.open").map { it != "false" },
            )
        }

        registerComposeReportTask(
            project = project,
            variants = composeReportVariants,
            requestedVariant = project.providers.gradleProperty("porthole.variant"),
        )
    }

    /**
     * Registers `portholeComposeReport` (GRA-69), `dependsOn` the resolved
     * variant's Kotlin compile task, computed lazily inside a [Callable] the
     * same way [registerPortholeStart]'s own `dependsOn` is — `variants` is
     * not populated until AGP has resolved every variant, well after this
     * function returns, so [resolveComposeReportVariant] cannot run yet when
     * this is called. `-Pporthole.variant` is the exact same property
     * `portholeStart` already reads for the same ambiguous-variant case
     * (GRA-174), not a second flag to learn.
     *
     * D4 (QA, GRA-69): the compiler-report DSL and the resolved compile
     * task's caching are configured from `project.gradle.taskGraph.whenReady`,
     * gated on `graph.hasTask(reportTask.get())` — a check against the
     * *resolved* execution graph, the one place "was this task abbreviation
     * (`pCR`), this exact name, or a `:project:` path actually resolved to
     * this task" is already answered for us, correctly, by Gradle itself.
     * The `startParameter.taskNames` string match this replaced answered a
     * different, narrower question ("was the literal string
     * `portholeComposeReport` typed on the command line") and silently said
     * no to a real, abbreviated invocation — see [ComposeCompilerWiring
     * .configure]'s own KDoc for the failure mode that produced (a stale
     * report stamped with a fresh-looking fingerprint).
     */
    private fun registerComposeReportTask(
        project: Project,
        variants: Provider<List<String>>,
        requestedVariant: Provider<String>,
    ) {
        val reportsDir = project.layout.buildDirectory.dir(ComposeCompilerWiring.REPORTS_DIR)
        val resolvedVariant = project.provider {
            resolveComposeReportVariant(variants.get(), requestedVariant.orNull)
        }

        val composablesTxtProvider = resolvedVariant.flatMap { v ->
            reportsDir.map { it.file("${project.name}_$v-composables.txt") }
        }
        val composablesCsvProvider = resolvedVariant.flatMap { v ->
            reportsDir.map { it.file("${project.name}_$v-composables.csv") }
        }
        val classesTxtProvider = resolvedVariant.flatMap { v ->
            reportsDir.map { it.file("${project.name}_$v-classes.txt") }
        }

        val reportTask = project.tasks.register<PortholeComposeReportTask>(TASK_NAME) {
            group = GROUP
            description = "Enables the compose compiler's metrics/reports for the debug variant, " +
                "compiles it, and parses the result into build/porthole/compose-report.json."
            dependsOn(Callable { listOf(kotlinCompileTaskName(resolvedVariant.get())) })

            variant.set(resolvedVariant)
            moduleName.set(project.name)
            kotlinVersion.set(PORTHOLE_KOTLIN_VERSION)
            // A safety-net default: overwritten below, inside
            // taskGraph.whenReady, on every real run this task actually
            // executes on (the same "in the graph" gate the DSL/caching
            // side of this already depends on) — never left at this value
            // except in a state where the task would not have run anyway.
            strongSkippingInBuild.convention("unknown")
            moduleRoot.set(project.layout.projectDirectory)
            // The whole module's src/ tree — see PortholeComposeReportTask's
            // own KDoc ("Staleness") for why this is deliberately coarser
            // than only the resolved variant's own source sets.
            kotlinSources.setFrom(
                project.fileTree(project.projectDir.resolve("src")) { include("**/*.kt") },
            )
            // D5 (QA): these three are `@Internal` on the task itself — see
            // its own KDoc for why a strict `@InputFile` there made the
            // "reports were not actually enabled" diagnostic unreachable —
            // `reportFiles` below is the real, tolerant `@InputFiles` input.
            composablesTxt.set(composablesTxtProvider)
            composablesCsv.set(composablesCsvProvider)
            classesTxt.set(classesTxtProvider)
            reportFiles.from(composablesTxtProvider, composablesCsvProvider, classesTxtProvider)
            outputFile.set(project.layout.buildDirectory.file("porthole/compose-report.json"))
        }

        // An anonymous Action<TaskExecutionGraph> object, not a bare
        // trailing lambda or the SAM-constructor call syntax: both of those
        // resolve wrong here. `TaskExecutionGraph.whenReady` has both a
        // Groovy `Closure` overload and this `Action` one, and the
        // kotlin-dsl plugin's SAM-with-receiver support (needed elsewhere
        // for Gradle's Groovy-shaped DSL) makes a plain Kotlin lambda
        // resolve to the Closure overload instead of this Action one — a
        // real compile error, not a style preference. `Action<T> { }`
        // SAM-constructor syntax fares no better: kotlin-dsl also defines
        // its own top-level `Action<T>(configuration: T.() -> Unit)` helper
        // with a *receiver*-style body, and Kotlin prefers that real
        // function over the interface's implicit SAM constructor, so a
        // `{ graph -> ... }` body (an explicit parameter, not a receiver)
        // fails to typecheck against it too. An anonymous `object :
        // Action<TaskExecutionGraph>` sidesteps every one of those
        // resolutions — there is only one candidate left to mean.
        project.gradle.taskGraph.whenReady(object : Action<TaskExecutionGraph> {
            override fun execute(graph: TaskExecutionGraph) {
                if (!graph.hasTask(reportTask.get())) return

                // The property/Kotlin-version fallback first, an explicit
                // composeCompiler{} DSL setting overriding it second — see
                // strongSkippingFromPropertyOrKotlinVersion's and
                // explicitStrongSkippingSetting's own KDoc for why that
                // order, and why the second needs the compose-compiler
                // plugin applied to even ask.
                var strongSkipping = strongSkippingFromPropertyOrKotlinVersion(project, PORTHOLE_KOTLIN_VERSION)
                project.plugins.withId("org.jetbrains.kotlin.plugin.compose") {
                    ComposeCompilerWiring.configure(project)
                    ComposeCompilerWiring.explicitStrongSkippingSetting(project)?.let { strongSkipping = it }
                }
                reportTask.get().strongSkippingInBuild.set(
                    when (strongSkipping) {
                        true -> "true"
                        false -> "false"
                        null -> "unknown"
                    },
                )

                // `upToDateWhen { false }` + `cacheIf { false }`, not
                // `doNotTrackState`: see AndroidWiring's own former comment
                // (now folded in here) — `doNotTrackState` made the Kotlin
                // compile task fail outright ("Changes are not tracked,
                // unable determine incremental changes"), because Kotlin's
                // own incremental compiler expects task-history tracking to
                // stay available even when Gradle's up-to-date check is
                // bypassed.
                val compileTask = project.tasks.findByName(kotlinCompileTaskName(resolvedVariant.get()))
                if (compileTask != null) {
                    compileTask.outputs.upToDateWhen { false }
                    compileTask.outputs.cacheIf { false }
                }
            }
        })
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
