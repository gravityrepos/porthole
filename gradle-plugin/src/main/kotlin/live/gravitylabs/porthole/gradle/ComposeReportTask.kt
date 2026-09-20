// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import groovy.json.JsonOutput
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import javax.inject.Inject

/**
 * `portholeComposeReport`'s own task name. Whether it was actually
 * *requested* this invocation is no longer answered by a string match
 * against this constant (D4, QA GRA-69): an earlier version of this file
 * had a `composeReportRequested(project): Boolean` here, checking
 * `project.gradle.startParameter.taskNames` for this literal string — which
 * a Gradle task-name abbreviation (`./gradlew :sample:pCR`) never satisfies
 * even though the task genuinely runs, letting the report task parse and
 * re-fingerprint a *previous* run's stale `.txt` output as though it were
 * fresh. [PortholePlugin.registerComposeReportTask] now gates on
 * `project.gradle.taskGraph.whenReady { graph.hasTask(reportTask) }` — a
 * check against the already-abbreviation-resolved execution graph — instead;
 * see that function's own KDoc.
 */
internal const val TASK_NAME = "portholeComposeReport"

/**
 * The same variant-selection rule [resolveInstallTask] uses for
 * `portholeStart`, reused here rather than re-invented: auto-select when
 * there is exactly one debug variant, otherwise require
 * `-Pporthole.variant=<name>` and validate it against the real candidates.
 * Returns the bare variant name (`"roomDebug"`), not a task name — callers
 * build `compile<Variant>Kotlin` from it themselves, since that is the one
 * piece [resolveInstallTask]'s own `"install" + ...` does not share.
 */
internal fun resolveComposeReportVariant(variants: List<String>, requestedVariant: String?): String {
    val candidates = variants.distinct().sorted()
    return when {
        candidates.isEmpty() -> throw GradleException(
            "portholeComposeReport found no debug variant on this module. Check that " +
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
                "(${candidates.joinToString(", ")}); portholeComposeReport needs to know which " +
                "one. Pass -Pporthole.variant=<name>, for example " +
                "-Pporthole.variant=${candidates.first()}.",
        )
    }
}

/** The Kotlin compile task AGP+Kotlin register for [variant] — `compileRoomDebugKotlin`, `compileDebugKotlin`. */
internal fun kotlinCompileTaskName(variant: String): String = "compile" + variant.replaceFirstChar { it.uppercase() } + "Kotlin"

/**
 * Whether the *consuming module's real build* — never this task's own
 * forced-off diagnostic recompile — has strong skipping on, from the two
 * signals that need no Compose-compiler-plugin type at all (the third,
 * `composeCompiler { enableStrongSkippingMode }` explicitly set on the
 * consuming module, is [ComposeCompilerWiring.explicitStrongSkippingSetting]
 * — AGP/Compose-compiler-plugin isolated, same reasoning as everything else
 * that object holds, and checked by the caller *after* this one so an
 * explicit DSL setting always wins):
 *
 *  1. `android.experimental.enableStrongSkipping` in `gradle.properties` —
 *     the older, AGP-level opt-in flag, still the one place a project can
 *     name this without touching a build script at all, and (via Gradle's
 *     own project-property inheritance) visible from a subproject even when
 *     only the *root* `gradle.properties` sets it.
 *  2. The Kotlin compiler version's own default: the Kotlin-plugin-hosted
 *     compose compiler defaults strong skipping to *on* from Kotlin 2.0
 *     onward (confirmed against the real 2.1.0 plugin — see
 *     `ComposeCompilerWiring.configure`'s own KDoc); the older, standalone
 *     `androidx.compose.compiler` Gradle plugin defaulted it *off*
 *     (opt-in only) below that.
 *
 * `null` ("unknown" once this reaches the report's own JSON) only when
 * [kotlinVersion] itself does not parse as a leading `MAJOR.MINOR` pair —
 * should not happen in practice (it is read from the same catalog entry
 * this plugin's own build depends on), but never assumed rather than
 * checked.
 */
internal fun strongSkippingFromPropertyOrKotlinVersion(project: Project, kotlinVersion: String): Boolean? {
    val fromProperty = (project.findProperty("android.experimental.enableStrongSkipping") as? String)
        ?.toBooleanStrictOrNull()
    if (fromProperty != null) return fromProperty

    val parts = kotlinVersion.split(".")
    val major = parts.getOrNull(0)?.toIntOrNull() ?: return null
    val minor = parts.getOrNull(1)?.toIntOrNull() ?: return null
    return major > 2 || (major == 2 && minor >= 0)
}

/**
 * Parses the compose compiler's own reports (`composeCompiler {
 * reportsDestination }`, pointed here by [ComposeCompilerWiring] — see that
 * object's KDoc for exactly when and why, including why it forces classic
 * skipping) into one JSON file the MCP server's `mcp/src/composeReport.ts`
 * reads (`build/porthole/compose-report.json`, GRA-69's own acceptance
 * criterion for where it lives).
 *
 * **Why the upstream Kotlin compile task has to be forced to actually run.**
 * `reportsDestination` and `enableStrongSkippingMode` are compiler-plugin
 * options, not declared `@Input`s of the generated `KotlinCompile` task (this
 * was verified the hard way: pointing `reportsDestination` at a fresh
 * directory and running `compileRoomDebugKotlin` restored the task
 * `FROM-CACHE` with zero report files written — a prior cache entry, built
 * with reports off, satisfied a cache key that never accounted for where
 * reports should go). Left alone, enabling reports here would routinely do
 * nothing on a warm cache — silently, since the task still reports success.
 * [AndroidWiring] is what forces the fix: whenever [composeReportRequested]
 * is true, it calls `doNotTrackState` on the resolved variant's own Kotlin
 * compile task, so it always actually executes for this invocation. This
 * task `dependsOn` that same compile task by name so Gradle always runs it
 * first.
 *
 * **Staleness.** [outputFile]'s JSON carries a `sourceFingerprint` — a
 * SHA-256 over every `.kt` file under the module's `src/` directory, sorted
 * by path, hashing (path, content) rather than (path, mtime): a checkout, a
 * `git clean`, or CI's own cache restore all touch mtimes for reasons that
 * have nothing to do with whether the code changed, and a fingerprint that
 * moved for that reason alone would make every fresh checkout report a
 * report as stale it was not. Deliberately coarse — every `.kt` file under
 * `src/`, not only the resolved variant's own source sets — trading a false
 * "stale" (another flavor's source moved) for never a false "fresh" (this
 * variant's own source moved and the fingerprint failed to notice), which is
 * the safe direction for a check whose whole job is refusing to join a
 * report against sources it no longer describes. `mcp/src/composeReport.ts`
 * recomputes the same hash over the live tree at query time and refuses the
 * join outright when the two disagree — see that module's own doc comment.
 * `gitHead` rides along for a human's own use (which commit was this taken
 * against) but is not what staleness is decided on: two builds of the exact
 * same sources at two different commits (a rebase, a cherry-pick) should
 * still join cleanly, and `sourceFingerprint` alone is what makes that true.
 */
abstract class PortholeComposeReportTask : DefaultTask() {

    /**
     * D5 (QA): `@Internal`, not `@InputFile` — a strict `@InputFile` makes
     * Gradle refuse to even start this task when the file does not exist
     * yet ("file does not exist"), which ran *before* [generate]'s own
     * "compose-compiler reports were not actually enabled" diagnostic ever
     * got a chance to — the better error, and the one this task exists to
     * give, was unreachable. [reportFiles] below is the real tracked input;
     * these three exist only so [generate] knows which exact paths to read.
     */
    @get:Internal
    abstract val composablesTxt: RegularFileProperty

    @get:Internal
    abstract val composablesCsv: RegularFileProperty

    @get:Internal
    abstract val classesTxt: RegularFileProperty

    /**
     * The real `@InputFiles` for [composablesTxt]/[composablesCsv]/
     * [classesTxt] — a `ConfigurableFileCollection`, which (unlike a
     * `RegularFileProperty` marked `@InputFile`) does not require any of its
     * entries to exist. Whatever is actually there gets hashed for
     * up-to-date purposes; a build where reports were never enabled sees an
     * empty collection, and this task still runs and gives its own honest
     * diagnostic rather than Gradle's generic one.
     */
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val reportFiles: ConfigurableFileCollection

    @get:Input
    abstract val variant: Property<String>

    @get:Input
    abstract val moduleName: Property<String>

    @get:Input
    abstract val kotlinVersion: Property<String>

    /**
     * `"true"`, `"false"`, or `"unknown"` — whether the *consuming module's
     * real build* has strong skipping on, from
     * [strongSkippingFromPropertyOrKotlinVersion] and
     * [ComposeCompilerWiring.explicitStrongSkippingSetting] (set by
     * `PortholePlugin.registerComposeReportTask`, which is the one place
     * both are in scope). Stored as a plain `String` rather than a nullable
     * `Property<Boolean>` — Gradle's own `Property<Boolean>` cannot
     * represent "no value" distinctly from "never configured" in a way this
     * task's own tests can rely on either way, and a three-way string is
     * simpler than a `Property<Boolean>` plus a separate `@Optional` flag
     * for the same three states.
     */
    @get:Input
    abstract val strongSkippingInBuild: Property<String>

    /** Every `.kt` file under the module's `src/` — see the class KDoc for why this is deliberately coarser than "this variant's own source sets". */
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val kotlinSources: ConfigurableFileCollection

    /** Used only to compute [kotlinSources]' *relative* paths for the fingerprint, and as `git rev-parse`'s own working directory — not itself hashed, so not `@InputFiles`. */
    @get:Internal
    abstract val moduleRoot: DirectoryProperty

    @get:Inject
    abstract val exec: ExecOperations

    @get:OutputFile
    abstract val outputFile: RegularFileProperty

    @TaskAction
    fun generate() {
        val composablesFile = composablesTxt.get().asFile
        val classesFile = classesTxt.get().asFile
        if (!composablesFile.isFile || !classesFile.isFile) {
            throw GradleException(
                "portholeComposeReport found no compiler report at ${composablesFile.parentFile}. " +
                    "Expected ${composablesFile.name} and ${classesFile.name} — the Kotlin compile " +
                    "task that should have produced them may have failed, or compose-compiler " +
                    "reports were not actually enabled for this run (see ComposeCompilerWiring's " +
                    "own KDoc for when they are).",
            )
        }

        val parsed = ComposeReportParser.parse(
            composablesTxt = composablesFile.readText(),
            composablesCsv = composablesCsv.orNull?.asFile?.takeIf { it.isFile }?.readText(),
            classesTxt = classesFile.readText(),
        )

        val root = moduleRoot.get().asFile
        // Run here, at execution time, through the injected ExecOperations —
        // not as a config-time Provider (an earlier version tried
        // `providers.exec {}` wired to an `@Input`, which the configuration
        // cache refuses outright: "Starting an external process ... during
        // configuration time is unsupported" — a provider that backs a task
        // `@Input` gets resolved while the cache entry is being *stored*,
        // which counts as configuration time even though the code reads as
        // lazy). Not itself an `@Input`, so it does not gate this task's own
        // up-to-date check — see the class KDoc, "Staleness", for why that
        // is deliberate: `sourceFingerprint` is the field the join actually
        // relies on, and it comes from `kotlinSources`, which is a real
        // `@Input`.
        val gitHead = resolveGitHead(exec, root)
        val json = linkedMapOf<String, Any?>(
            "generatedAt" to Instant.now().toString(),
            "variant" to variant.get(),
            "module" to moduleName.get(),
            "kotlinVersion" to kotlinVersion.get(),
            "gitHead" to gitHead,
            "sourceFingerprint" to sourceFingerprint(kotlinSources.files, root),
            // `true`/`false` as real JSON booleans when known, the string
            // `"unknown"` otherwise — see strongSkippingInBuild's own KDoc.
            "strongSkippingInBuild" to when (strongSkippingInBuild.get()) {
                "true" -> true
                "false" -> false
                else -> "unknown"
            },
            "composables" to parsed.composables.map { c ->
                linkedMapOf(
                    "name" to c.name,
                    "packageName" to c.packageName,
                    "restartable" to c.restartable,
                    "skippable" to c.skippable,
                    "parameters" to c.parameters.map { p ->
                        linkedMapOf(
                            "name" to p.name,
                            "type" to p.type,
                            "stable" to p.stable,
                            "unused" to p.unused,
                        )
                    },
                )
            },
            "classes" to parsed.classes.map { c ->
                linkedMapOf(
                    "name" to c.name,
                    "stable" to c.stable,
                    "runtimeStability" to c.runtimeStability,
                    "properties" to c.properties.map { p ->
                        linkedMapOf(
                            "name" to p.name,
                            "mutable" to p.mutable,
                            "stable" to p.stable,
                            "type" to p.type,
                            "stability" to p.stability,
                        )
                    },
                )
            },
        )

        val out = outputFile.get().asFile
        out.parentFile.mkdirs()
        out.writeText(JsonOutput.prettyPrint(JsonOutput.toJson(json)) + "\n")

        logger.lifecycle(
            "[porthole] wrote ${parsed.composables.size} composable(s), ${parsed.classes.size} " +
                "class(es) to ${out.absolutePath}",
        )
    }
}

/**
 * SHA-256 over every file in [files], sorted by path relative to [root] —
 * deterministic regardless of filesystem iteration order, and stable across
 * machines/checkouts since it hashes content, never mtime. See
 * [PortholeComposeReportTask]'s own KDoc, "Staleness", for why content
 * rather than mtime and why the whole module's `src/` rather than one
 * variant's own source sets.
 */
internal fun sourceFingerprint(files: Set<File>, root: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    files
        .sortedBy { it.relativeTo(root).path }
        .forEach { file ->
            digest.update(file.relativeTo(root).path.toByteArray(Charsets.UTF_8))
            digest.update(0)
            digest.update(file.readBytes())
        }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

/**
 * `git rev-parse HEAD` from [dir], through the injected [exec] — the
 * configuration-cache-safe way to start a process from inside a task action
 * (unlike `ProviderFactory.exec`, wiring this to a config-time `@Input`
 * `Property` is what actually failed here: see
 * [PortholeComposeReportTask.generate]'s own comment). Null when this is not
 * a git checkout, git is not on the PATH, or the command otherwise fails —
 * every one of those is a normal state (a published artifact, an extracted
 * tarball, CI with a shallow or absent `.git`) and none of them should fail
 * the build over a field this report's own staleness check does not rely on
 * (see [PortholeComposeReportTask]'s own KDoc, "Staleness").
 */
internal fun resolveGitHead(exec: ExecOperations, dir: File): String? = try {
    val output = java.io.ByteArrayOutputStream()
    val result = exec.exec {
        commandLine("git", "rev-parse", "HEAD")
        workingDir = dir
        standardOutput = output
        errorOutput = output
        isIgnoreExitValue = true
    }
    val text = output.toString(Charsets.UTF_8).trim()
    if (result.exitValue == 0 && text.isNotEmpty()) text else null
} catch (e: RuntimeException) {
    // Gradle wraps "git not on PATH" as its own internal ExecException
    // (not a public type this module can name) — caught as its public
    // RuntimeException supertype instead.
    null
} catch (e: java.io.IOException) {
    null
}
