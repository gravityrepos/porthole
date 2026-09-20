// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.api.Project
import org.jetbrains.kotlin.compose.compiler.gradle.ComposeCompilerGradlePluginExtension
import org.jetbrains.kotlin.compose.compiler.gradle.ComposeFeatureFlag

/**
 * Everything that names a Compose-compiler-Gradle-plugin type, kept away
 * from [PortholePlugin] and [PortholeComposeReportTask] for the same reason
 * [AndroidWiring] keeps AGP types away from them (see that file's own KDoc):
 * `org.jetbrains.kotlin.plugin.compose` is applied by the *consumer's* build
 * script, never a dependency of this one, so on a module that never applies
 * it — a pure-JVM module, or an Android module with no Compose UI at all —
 * [ComposeCompilerGradlePluginExtension] is simply not on the classpath.
 * [configure] is called from inside a
 * `plugins.withId("org.jetbrains.kotlin.plugin.compose")` callback, which
 * fires only once that plugin is actually applied, so this object's class is
 * never loaded on a module that lacks it.
 */
internal object ComposeCompilerWiring {

    /** Directory `portholeComposeReport` points the compiler's human-readable reports at, relative to `layout.buildDirectory` — never a raw `projectDir/build` path (QA nit): the build directory can be relocated, and only `layout.buildDirectory` tracks that. */
    const val REPORTS_DIR = "porthole/composeReports"

    /** Directory it points the compiler's machine-readable metrics at, same base — not parsed by this ticket, but free to set alongside reportsDestination. */
    const val METRICS_DIR = "porthole/composeMetrics"

    /**
     * Sets `composeCompiler { reportsDestination / metricsDestination }` and
     * forces classic (non-strong) skipping. Callers — [PortholePlugin]'s own
     * `registerComposeReportTask` — call this only once
     * `project.gradle.taskGraph.whenReady` has confirmed `portholeComposeReport`
     * is actually part of the *resolved* execution graph for this build, not
     * merely named (literally or by Gradle's own task-name abbreviation,
     * `pCR` for `portholeComposeReport`) on the command line — see that
     * function's own KDoc, and GRA-69's QA D4, for why a
     * `startParameter.taskNames` string check this function tried first is
     * not that proof: an abbreviated invocation runs the real task without
     * ever matching the literal name, so a caller gated on the command line
     * alone would silently skip configuring this and let the report task
     * parse and re-fingerprint whatever `.txt` a *previous* run happened to
     * leave on disk — a stale report that reads as fresh. An ordinary build
     * — `assembleDebug`, `test`, CI's usual `check` — never puts
     * `portholeComposeReport` in its graph at all, so it never runs this:
     * `reportsDestination` stays at whatever (if anything) the app's own
     * `composeCompiler {}` block already set. This ticket's answer to its
     * own open question 2 ("does it need a separate variant so ordinary
     * builds don't slow") is "no separate variant" — gating on graph
     * membership already buys "ordinary builds pay nothing" without
     * doubling the variant matrix. One caveat worth being honest about
     * (QA nit): the recompile this enables is not free forever — the *next*
     * ordinary build after running `portholeComposeReport` recompiles again
     * too, since the Kotlin compile task this shares was told never to
     * track its state while reports were on (see
     * [PortholeComposeReportTask]'s own KDoc) and that untracked run leaves
     * nothing for the next invocation's up-to-date check to compare against.
     *
     * `taskGraph.whenReady` fires once the graph is finalised — after
     * Gradle's own abbreviation resolution, and after every project's
     * configuration phase, but still strictly before any task executes.
     * That is still in time: `composeCompiler {}`'s properties are ordinary
     * lazy Gradle `Property`s, and the Kotlin compose subplugin reads them
     * through `map`/`flatMap` providers at the Kotlin compile task's own
     * execution time (verified against the real plugin jar for 2.1.0 —
     * `ComposeCompilerGradleSubplugin.applyToCompilation` wires each option
     * from `project.provider { ... }`, never an eagerly-captured value), so
     * anything set here is still live by the time that compile task runs.
     *
     * Disabling strong skipping (`featureFlags.add(ComposeFeatureFlag
     * .StrongSkipping.disabled())` below — the non-deprecated spelling;
     * `enableStrongSkippingMode.set(false)` still exists on the extension
     * but is soft-deprecated in 2.1.0's plugin in favour of this) is the
     * part that is not obvious. Kotlin 2.1's compose compiler defaults
     * strong skipping to *on* (confirmed against the real plugin: none of
     * this repo's own `composeCompiler {}` blocks set it either way, and
     * every composable in the sample was `skippable` regardless of whether
     * its parameters were stable). Under strong skipping, a composable with
     * an unstable parameter is still reported `skippable: true` — it falls
     * back to an identity comparison instead of failing to skip at all —
     * which means the compiler's own `skippable` flag, the exact signal
     * this whole ticket joins against, never goes false because of an
     * unstable parameter under the modern default. Forced off here, for
     * this diagnostic recompile only, never for the module's real build:
     * what comes back is the classic-skipping verdict, which is what
     * actually explains whether stabilising a parameter would let the
     * composable skip at all — a fact worth surfacing even for an app that
     * ships with strong skipping on, since a caller-side List rebuilt every
     * recomposition still fails strong skipping's own identity check in
     * practice, just less visibly.
     */
    fun configure(project: Project) {
        val extension = project.extensions.getByType(ComposeCompilerGradlePluginExtension::class.java)
        extension.reportsDestination.set(project.layout.buildDirectory.dir(REPORTS_DIR))
        extension.metricsDestination.set(project.layout.buildDirectory.dir(METRICS_DIR))
        extension.featureFlags.add(ComposeFeatureFlag.StrongSkipping.disabled())
    }
}
