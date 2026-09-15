// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.Task
import org.gradle.api.provider.Provider
import org.gradle.api.tasks.TaskProvider
import java.util.concurrent.Callable

/**
 * `portholeStart` (GRA-174): the one task a new user needs, instead of the
 * three or four they had to learn the order of.
 *
 * It is a pure lifecycle task — no `@TaskAction` of its own, only
 * `dependsOn` — because a parent task that re-implements any part of what it
 * orchestrates is worse than the commands it replaces: it drifts silently the
 * next time one of those tasks changes, and nothing notices. Every behaviour
 * still lives in the narrow tasks; this file only decides *which* of them,
 * and for *which* variant. See [portholeStartDependencies] for the exact set
 * — GRA-174's acceptance criterion 2 asserts it is exactly the narrow tasks,
 * nothing more.
 *
 * Registered only for application modules, from [PortholePlugin], because
 * there is no `install*` task on a library module to depend on.
 */

/**
 * Picks the `install<Variant>` task for [variants] — the module's debug
 * variant names, named the way AGP names them: `"debug"` with no flavors,
 * `"roomDebug"`/`"sqldelightDebug"` with the sample's `storage` dimension.
 *
 * Auto-selects when there is exactly one. Otherwise [requestedVariant] (from
 * `-Pporthole.variant=<name>`) must name one of the candidates — guessing
 * wrong is worse than asking, so an ambiguous module with no request fails
 * loudly with every candidate named, rather than picking one silently. An
 * explicit request is validated even when the module was not actually
 * ambiguous, so a typo naming the wrong single variant is caught rather than
 * silently ignored in favour of the one real candidate.
 */
internal fun resolveInstallTask(variants: List<String>, requestedVariant: String?): String {
    val candidates = variants.distinct().sorted()
    val chosen = when {
        candidates.isEmpty() -> throw GradleException(
            "portholeStart found no debug variant to install on this module. Check that " +
                "porthole.debugBuildTypes names a build type that actually exists.",
        )
        requestedVariant != null && requestedVariant !in candidates -> throw GradleException(
            "porthole.variant=\"$requestedVariant\" is not one of this module's debug " +
                "variants: ${candidates.joinToString(", ")}.",
        )
        requestedVariant != null -> requestedVariant
        candidates.size == 1 -> candidates.single()
        else -> throw GradleException(
            "This module has ${candidates.size} debug variants " +
                "(${candidates.joinToString(", ")}); portholeStart needs to know which one. " +
                "Pass -Pporthole.variant=<name>, for example -Pporthole.variant=${candidates.first()}.",
        )
    }
    return "install" + chosen.replaceFirstChar { it.uppercase() }
}

/**
 * The same variant resolution as [resolveInstallTask], but for *ordering*
 * rather than for *what to install* — which means it must never throw.
 *
 * `portholeMcpConfig`, `portholeTraceProcessor`, `portholeConnect` and
 * `portholeUi` each get a `mustRunAfter` naming the install task, so that
 * `portholeStart`'s order is a real Gradle constraint rather than an
 * accident of task-name alphabetising (see [registerPortholeStart]'s ordering
 * block). Those `mustRunAfter` declarations are attached unconditionally —
 * they do nothing unless the install task is *also* in the graph being run,
 * but Gradle still has to evaluate them for a standalone run of, say,
 * `./gradlew portholeMcpConfig` on an ambiguous module. [resolveInstallTask]
 * throwing there would break AC3 (the narrow tasks keep working on their
 * own) for a module `portholeStart` was never involved in. Returning `null` —
 * "no install task to order against" — instead of guessing or failing is the
 * only answer that keeps a standalone run exactly as it always behaved.
 */
internal fun installTaskForOrdering(variants: List<String>, requestedVariant: String?): String? {
    val candidates = variants.distinct().sorted()
    val chosen = requestedVariant?.takeIf { it in candidates } ?: candidates.singleOrNull() ?: return null
    return "install" + chosen.replaceFirstChar { it.uppercase() }
}

/**
 * The whole dependency graph `portholeStart` has. Exactly these four narrow
 * tasks — nothing re-implemented — which is what GRA-174's acceptance
 * criterion 2 holds this to over time.
 *
 * [openUi] chooses the last one: `portholeUi`, which forwards the port
 * itself and must not be paired with `portholeConnect` doing it a second
 * time; or `portholeConnect` alone, when `-Pporthole.open=false` says not to
 * open a browser. The two are mutually exclusive for that reason — never
 * both.
 */
internal fun portholeStartDependencies(
    variants: List<String>,
    requestedVariant: String?,
    openUi: Boolean,
): List<String> = listOf(
    resolveInstallTask(variants, requestedVariant),
    "portholeMcpConfig",
    "portholeTraceProcessor",
    if (openUi) "portholeUi" else "portholeConnect",
)

/**
 * Registers `portholeStart` and wires [portholeStartDependencies] as its
 * `dependsOn`, computed lazily — inside a [Callable], which Gradle resolves
 * only when it builds the task execution graph — so [variants] (which
 * `AndroidWiring` only finishes collecting once AGP has resolved every
 * variant, well after this function returns) does not have to be ready yet
 * when this is called.
 *
 * `-Pporthole.open=false` skips opening the browser. The default opens it,
 * matching what `portholeUi` alone has always done for a human running it by
 * hand; an agent that does not want a browser window passes the flag. One
 * default cannot serve both audiences — this is the one being defaulted, and
 * the choice is documented here and in the README's Setup section rather
 * than left implicit.
 *
 * `dependsOn` alone only says *that* these four run, not in what order —
 * Gradle is free to schedule an unordered set however it likes, and without
 * more information it tie-breaks alphabetically, which happened to put
 * `portholeUi` last. That was never a guarantee: `portholeUi` blocks until
 * the person watching it stops it, so anything scheduled after it would
 * simply never run if the tie-break ever landed differently. The
 * `mustRunAfter` chain below makes the order — install, then
 * `portholeConnect`, then `portholeMcpConfig`, then `portholeTraceProcessor`,
 * then `portholeUi` — an actual Gradle constraint, independent of task
 * names, so `portholeUi` running last is design rather than luck. A
 * `mustRunAfter` naming a task that is not itself in the graph being run
 * (for instance `portholeUi`'s on `portholeConnect`, when only one of the two
 * is ever a dependency) is simply ignored by Gradle, which is what keeps this
 * safe to declare unconditionally rather than only for whichever branch
 * `openUi` took.
 */
internal fun registerPortholeStart(
    project: Project,
    variants: Provider<List<String>>,
    requestedVariant: Provider<String>,
    openUi: Provider<Boolean>,
): TaskProvider<Task> {
    val installTask = Callable { listOfNotNull(installTaskForOrdering(variants.get(), requestedVariant.orNull)) }

    project.tasks.named("portholeConnect").configure { mustRunAfter(installTask) }
    project.tasks.named("portholeMcpConfig").configure { mustRunAfter(installTask, "portholeConnect") }
    project.tasks.named("portholeTraceProcessor").configure {
        mustRunAfter(installTask, "portholeConnect", "portholeMcpConfig")
    }
    project.tasks.named("portholeUi").configure {
        mustRunAfter(installTask, "portholeConnect", "portholeMcpConfig", "portholeTraceProcessor")
    }

    return project.tasks.register("portholeStart") {
        group = PortholePlugin.GROUP
        description = "Installs the debug build, forwards the port, writes .mcp.json, fetches " +
            "trace_processor if it's missing, and opens the timeline — the narrow tasks below " +
            "run all of it, in that order; this only orders them. -Pporthole.open=false skips " +
            "the browser; -Pporthole.variant=<name> picks the variant when the module has more " +
            "than one debug variant."
        dependsOn(
            Callable {
                portholeStartDependencies(
                    variants = variants.get(),
                    requestedVariant = requestedVariant.orNull,
                    openUi = openUi.getOrElse(true),
                )
            },
        )
    }
}
