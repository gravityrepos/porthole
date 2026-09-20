// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.api.Project
import org.jetbrains.kotlin.compose.compiler.gradle.ComposeCompilerGradlePluginExtension
import org.jetbrains.kotlin.compose.compiler.gradle.ComposeFeatureFlag
import java.io.File

/**
 * Everything that names a Compose-compiler-Gradle-plugin type, kept away
 * from [PortholePlugin] and [PortholeComposeReportTask] for the same reason
 * [AndroidWiring] keeps AGP types away from them (see that file's own KDoc):
 * `org.jetbrains.kotlin.plugin.compose` is applied by the *consumer's* build
 * script, never a dependency of this one, so on a module that never applies
 * it — a pure-JVM module, or an Android module with no Compose UI at all —
 * [ComposeCompilerGradlePluginExtension] is simply not on the classpath.
 * [configureForReportIfRequested] is called from inside a
 * `plugins.withId("org.jetbrains.kotlin.plugin.compose")` callback, which
 * fires only once that plugin is actually applied, so this object's class is
 * never loaded on a module that lacks it.
 */
internal object ComposeCompilerWiring {

    /** Directory `portholeComposeReport` points the compiler's human-readable reports at, module-relative. */
    const val REPORTS_DIR = "build/porthole/composeReports"

    /** Directory it points the compiler's machine-readable metrics at — not parsed by this ticket, but free to set alongside reportsDestination. */
    const val METRICS_DIR = "build/porthole/composeMetrics"

    /**
     * Sets `composeCompiler { reportsDestination / metricsDestination }` and
     * forces classic (non-strong) skipping, but **only** when
     * `portholeComposeReport` is one of the tasks this Gradle invocation
     * actually asked for — checked against `startParameter.taskNames`, the
     * same "was this actually requested" idiom [PortholeTraceProcessorTask]
     * already uses to gate its own opt-in network fetch, applied here to an
     * opt-in *compile-time* cost instead. An ordinary build —
     * `assembleDebug`, `test`, CI's usual `check` — never names this task, so
     * it never runs this at all: `reportsDestination` stays at whatever (if
     * anything) the app's own `composeCompiler {}` block already set, and
     * this ticket's answer to its own open question 2 ("does it need a
     * separate variant so ordinary builds don't slow") is "no separate
     * variant" — gating on the requested task name already buys "ordinary
     * builds pay nothing" without doubling the variant matrix, and a variant
     * matrix would only ever run one report at a time anyway.
     *
     * Checked once, at apply time, deliberately not in `taskGraph.whenReady`:
     * `composeCompiler {}`'s properties are ordinary lazy Gradle `Property`s,
     * and the Kotlin compose subplugin reads them through `map`/`flatMap`
     * providers at the Kotlin compile task's own execution time (verified
     * against the real plugin jar for 2.1.0 — `ComposeCompilerGradleSubplugin
     * .applyToCompilation` wires each option from `project.provider { ... }`,
     * never an eagerly-captured value) — so anything set here during this
     * plugin's own `apply()` is still live by the time that compile task
     * runs, with none of `taskGraph.whenReady`'s own timing risk relative to
     * task configuration.
     *
     * Disabling strong skipping (`featureFlags.add(ComposeFeatureFlag
     * .StrongSkipping.disabled())` below — the non-deprecated spelling;
     * `enableStrongSkippingMode.set(false)` still exists on the extension
     * but is soft-deprecated in 2.1.0's plugin in favour of this) is the
     * part that is not obvious. Kotlin 2.1's compose compiler defaults
     * strong skipping to *on*
     * (confirmed against the real plugin: none of this repo's own
     * `composeCompiler {}` blocks set it either way, and every composable in
     * the sample was `skippable` regardless of whether its parameters were
     * stable). Under strong skipping, a composable with an unstable
     * parameter is still reported `skippable: true` — it falls back to an
     * identity comparison instead of failing to skip at all — which means
     * the compiler's own `skippable` flag, the exact signal this whole
     * ticket joins against, never goes false because of an unstable
     * parameter under the modern default. Forced off here, for this
     * diagnostic recompile only, never for the module's real build (this
     * function touches nothing unless `portholeComposeReport` was
     * requested): what comes back is the classic-skipping verdict, which is
     * what actually explains whether stabilising a parameter would let the
     * composable skip at all — a fact worth surfacing even for an app that
     * ships with strong skipping on, since a caller-side List rebuilt every
     * recomposition still fails strong skipping's own identity check in
     * practice, just less visibly.
     */
    fun configureForReportIfRequested(project: Project) {
        if (!composeReportRequested(project)) return

        val extension = project.extensions.getByType(ComposeCompilerGradlePluginExtension::class.java)
        extension.reportsDestination.set(File(project.projectDir, REPORTS_DIR))
        extension.metricsDestination.set(File(project.projectDir, METRICS_DIR))
        extension.featureFlags.add(ComposeFeatureFlag.StrongSkipping.disabled())
    }
}
