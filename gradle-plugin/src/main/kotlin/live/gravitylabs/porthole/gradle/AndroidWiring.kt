// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import com.android.build.api.dsl.BuildFeatures
import com.android.build.api.dsl.BuildType
import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import com.android.build.api.variant.LibraryAndroidComponentsExtension
import org.gradle.api.NamedDomainObjectContainer
import org.gradle.api.Project

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

    fun application(project: Project, extension: PortholeExtension) {
        project.extensions.getByType(ApplicationAndroidComponentsExtension::class.java)
            .finalizeDsl { dsl -> wire(project, extension, dsl.buildTypes, dsl.buildFeatures) }
    }

    fun library(project: Project, extension: PortholeExtension) {
        project.extensions.getByType(LibraryAndroidComponentsExtension::class.java)
            .finalizeDsl { dsl -> wire(project, extension, dsl.buildTypes, dsl.buildFeatures) }
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
