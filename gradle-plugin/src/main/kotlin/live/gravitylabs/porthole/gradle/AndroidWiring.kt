// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import com.android.build.api.dsl.BuildFeatures
import com.android.build.api.dsl.BuildType
import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import com.android.build.api.variant.LibraryAndroidComponentsExtension
import org.gradle.api.NamedDomainObjectContainer
import org.gradle.api.Project
import org.gradle.api.provider.Provider

/**
 * Everything that names an AGP type, kept away from [PortholePlugin].
 *
 * Not organisation — a load-bearing separation. AGP is a `compileOnly`
 * dependency, so on a project with no Android plugin its classes are simply not
 * there, and Gradle generates a decorated subclass of the plugin class on apply.
 * Decoration walks the declared methods, so one method signature mentioning
 * `BuildFeatures` is enough to fail the whole apply with `NoClassDefFoundError`
 * before any of this plugin's own code runs — including the warning that is
 * supposed to explain the mistake.
 *
 * The JVM loads a class on first use. Every entry point here is called from
 * inside a `plugins.withId` callback, which only fires once the Android plugin
 * is applied, so this class is never loaded unless AGP is present to load it.
 *
 * The previous arrangement survived by accident: it asked for the raw
 * `AndroidComponentsExtension`, and erasure kept AGP types out of the
 * signatures. It also stopped compiling against AGP 8.13, whose `gradle-api`
 * artifact no longer carries those DSL types.
 */
internal object AndroidWiring {

    /**
     * Wires the app module the same way [library] does, and additionally
     * returns the names of its debug variants — `"debug"` with no flavors,
     * `"roomDebug"`/`"sqldelightDebug"` with a flavor dimension — for
     * [PortholePlugin] to hand to `portholeStart` (GRA-174), which needs to
     * know which `install<Variant>` task to depend on.
     *
     * Collected via `onVariants` rather than read off the DSL directly,
     * because a variant's *name* — the thing `install` tasks are suffixed
     * with — is AGP's own computation over build types, flavors and their
     * dimension order, and `onVariants` is the one place that answer is
     * final. The list is read back through the returned [Provider] rather
     * than handed over directly, because `onVariants` callbacks are still
     * firing (once per variant) when this method returns; by the time
     * anything resolves the provider — building the task graph, well after
     * this project has finished evaluating — every variant has arrived.
     */
    fun application(project: Project, extension: PortholeExtension): Provider<List<String>> {
        val components = project.extensions.getByType(ApplicationAndroidComponentsExtension::class.java)
        components.finalizeDsl { dsl ->
            // A convention, not a set: this only takes effect if the build
            // script never called `porthole { applicationId.set(...) }`
            // itself, which is exactly the "AGP knows it, but an explicit
            // override still wins" rule GRA-197 asks for. finalizeDsl fires
            // after the build script has already run, so by the time this
            // executes any explicit .set() has already happened and
            // .convention() here cannot clobber it.
            dsl.defaultConfig.applicationId?.let { extension.applicationId.convention(it) }
            wire(project, extension, dsl.buildTypes, dsl.buildFeatures)
        }

        val debugVariantNames = mutableListOf<String>()
        components.onVariants { variant ->
            val buildType = variant.buildType
            if (buildType != null && buildType in extension.debugBuildTypes.get()) {
                debugVariantNames += variant.name
                forceComposeReportRecompile(project, variant.name)
            }
        }
        return project.provider { debugVariantNames.toList() }
    }

    /**
     * Wires the library module the same way [application] does, and —
     * unlike before GRA-69 — also returns its debug variant names, the same
     * shape [application] returns, so `portholeComposeReport` can be
     * registered on a library module too: Compose UI lives in design-system
     * and feature libraries at least as often as in the app module itself,
     * and GRA-69's own multi-module answer ("per-module reports; the server
     * joins across every one it finds under the root") only makes sense if
     * every module that can have composables can also produce a report.
     * [PortholePlugin] does not register `portholeStart` from this — a
     * library has no `install<Variant>` task — but it does now register
     * `portholeComposeReport` from it.
     */
    fun library(project: Project, extension: PortholeExtension): Provider<List<String>> {
        val components = project.extensions.getByType(LibraryAndroidComponentsExtension::class.java)
        components.finalizeDsl { dsl -> wire(project, extension, dsl.buildTypes, dsl.buildFeatures) }

        val debugVariantNames = mutableListOf<String>()
        components.onVariants { variant ->
            val buildType = variant.buildType
            if (buildType != null && buildType in extension.debugBuildTypes.get()) {
                debugVariantNames += variant.name
                forceComposeReportRecompile(project, variant.name)
            }
        }
        return project.provider { debugVariantNames.toList() }
    }

    /**
     * GRA-69: whenever `portholeComposeReport` was actually requested (see
     * [composeReportRequested]'s own KDoc), the Kotlin compile task for
     * [variantName] is told never to track its state at all — not merely
     * "rerun me", `doNotTrackState` also stops a *future* run from caching
     * this one, since a compile with reports on and one with them off would
     * otherwise be indistinguishable cache entries once the reports
     * themselves are int-not-tracked. See
     * [PortholeComposeReportTask]'s own KDoc for the `FROM-CACHE`-with-zero-
     * report-files failure mode this exists to close — measured against the
     * real Kotlin 2.1 compose-compiler plugin, not assumed. Called for every
     * debug variant, not only the one `-Pporthole.variant` will eventually
     * resolve to: which variant that is is not known this early (see
     * `resolveComposeReportVariant`'s own comment on why [application]'s own
     * `debugVariantNames` has to be resolved this same asynchronous way), so
     * this errs toward disabling caching on every candidate — inert on any
     * variant that never actually gets built this run.
     */
    private fun forceComposeReportRecompile(project: Project, variantName: String) {
        if (!composeReportRequested(project)) return
        // `matching { }.configureEach { }`, not `named(name).configure { }`:
        // this callback (AGP's own `onVariants`) can fire before the Kotlin
        // Android plugin — a *different* listener on the same AGP variant
        // API — has registered its own compile task for this variant, and
        // `named()` throws immediately (`UnknownTaskException`) for a task
        // that does not exist yet, `matching` does not — it is the lazy,
        // exists-now-or-added-later form, and is what actually failed
        // without it (measured: `Task with name 'compileRoomDebugKotlin' not
        // found`, calling this from directly inside `onVariants`).
        val taskName = kotlinCompileTaskName(variantName)
        project.tasks.matching { it.name == taskName }.configureEach {
            // Not `doNotTrackState`: tried first, and it makes the Kotlin
            // compile task fail outright — "Changes are not tracked, unable
            // determine incremental changes" — because Kotlin's own
            // incremental compiler expects task-history tracking to still be
            // available even when Gradle's up-to-date check is bypassed.
            // `upToDateWhen { false }` + `cacheIf { false }` gets the same
            // "always actually run" outcome this needs without turning off
            // the tracking Kotlin's own incremental engine still wants.
            outputs.upToDateWhen { false }
            outputs.cacheIf { false }
        }
    }

    /**
     * The part that differs between an application and a library: nothing.
     *
     * Taken as the two DSL pieces actually touched rather than as the extension
     * that holds them, because `ApplicationExtension` and `LibraryExtension`
     * have no supertype that is stable across AGP versions — `CommonExtension`
     * has changed its type-parameter count — while `BuildType` and
     * `BuildFeatures` have not.
     */
    private fun wire(
        project: Project,
        extension: PortholeExtension,
        buildTypes: NamedDomainObjectContainer<out BuildType>,
        buildFeatures: BuildFeatures,
    ) {
        if (!extension.enabled.get()) return

        val debugTypes = extension.debugBuildTypes.get().toSet()
        val port = extension.port.get()
        val ringCapacity = extension.ringCapacity.get()
        val strictMode = extension.strictMode.get()

        if (buildTypes.any { it.name in debugTypes }) {
            // AGP 9 ships resValues off by default, and calling resValue with
            // the feature disabled fails configuration outright: "Build Type
            // debug contains custom resource values, but the feature is
            // disabled." Turning it on is the plugin's business, not the
            // consuming app's — they never asked for the resource, we did. A
            // no-op on AGP 8, where it is already on.
            buildFeatures.resValues = true
        }

        buildTypes.forEach { buildType ->
            val isDebug = buildType.name in debugTypes
            val configuration = buildType.name + "Implementation"
            project.dependencies.add(configuration, dependency(project, extension, isDebug))

            if (isDebug) {
                // A generated resource rather than a manifest placeholder:
                // placeholders have to be declared by the consuming app or the
                // merge fails, and nobody wants that surprise.
                buildType.resValue("integer", "porthole_port", port.toString())
                buildType.resValue("integer", "porthole_ring_capacity", ringCapacity.toString())
                // A `bool` resource, same mechanism, same reason: Porthole.kt
                // reads it with resources.getBoolean, defaulting to false (off)
                // when a build predates this flag and the resource is simply
                // absent — see PortholeExtension.strictMode's own KDoc for why
                // the default is off rather than on.
                buildType.resValue("bool", "porthole_strict_mode", strictMode.toString())
            }
        }
    }

    private fun dependency(project: Project, extension: PortholeExtension, isDebug: Boolean): Any {
        val module = if (isDebug) "runtime" else "runtime-noop"
        return if (extension.useProjectDependencies.get()) {
            project.dependencies.project(mapOf("path" to ":$module"))
        } else {
            "live.gravitylabs.porthole:$module:${extension.runtimeVersion.get()}"
        }
    }
}
