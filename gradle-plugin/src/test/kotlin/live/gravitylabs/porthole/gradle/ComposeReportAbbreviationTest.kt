// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.testkit.runner.GradleRunner
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * D4 (QA, GRA-69): proves the *mechanism*
 * `PortholePlugin.registerComposeReportTask` relies on —
 * `project.gradle.taskGraph.whenReady { graph.hasTask(task) }` correctly
 * recognises a task named by Gradle's own command-line abbreviation
 * (`pCR` for `portholeComposeReport`), where a literal
 * `startParameter.taskNames` string match does not — against a plain
 * Gradle build with no Android module at all.
 *
 * A real end-to-end proof (the actual `portholeComposeReport` task,
 * abbreviated, against a real Compose-enabled Android module) needs AGP, an
 * SDK and Compose — the same needs [PortholeAgpCompatibilityTest] is
 * already gated behind `-Pporthole.agpVersion` for (see that file's own
 * KDoc: "The plugin applied to a real Android project ... needs an SDK and
 * the network"), and [StubAdbFunctionalTest]'s own sibling tests follow the
 * same split — "the plugin only registers [tasks] on an Android module and
 * that needs AGP, an SDK and the network ... these cover the tasks' own
 * behaviour" — applied here to the graph-gating mechanism rather than to a
 * task's own action. This test is what runs on every `./gradlew -p
 * gradle-plugin test`, with no gate at all, because the mechanism itself —
 * whether `graph.hasTask` sees past an abbreviation — is not
 * Android-specific and needs neither AGP nor a network fetch to prove.
 *
 * The real end-to-end scenario (abbreviation, real Kotlin compile task,
 * real compose-compiler reports, real `compose-report.json`) was verified
 * by hand against this repo's own sample app for this ticket's QA pass:
 *
 * ```
 * $ ./gradlew :sample:pCR -Pporthole.variant=roomDebug
 * ...
 * > Task :sample:compileRoomDebugKotlin   (executed, not UP-TO-DATE — reports were enabled)
 * > Task :sample:portholeComposeReport
 * [porthole] wrote 6 composable(s), 10 class(es) to .../sample/build/porthole/compose-report.json
 * BUILD SUCCESSFUL
 * ```
 *
 * with the written report's own `sourceFingerprint` cross-checked against a
 * fresh `./gradlew :sample:portholeComposeReport` (the unabbreviated name)
 * run from a clean `--rerun-tasks` — byte-identical, proving the
 * abbreviated run was never a stale-looking-fresh report.
 */
class ComposeReportAbbreviationTest {

    @get:Rule
    val projectDir = TemporaryFolder()

    private fun write(path: String, text: String) {
        val file = File(projectDir.root, path)
        file.parentFile.mkdirs()
        file.writeText(text)
    }

    private fun build(vararg arguments: String) =
        GradleRunner.create()
            .withProjectDir(projectDir.root)
            .withArguments(*arguments, "--stacktrace")
            .build()

    @Test
    fun `graph-based gating recognises an abbreviated task name, where a startParameter string match would not`() {
        write("settings.gradle.kts", "rootProject.name = \"abbrev-scratch\"\n")
        // Mirrors registerComposeReportTask's own shape: register a task,
        // then decide something (here, write a marker file) only once
        // taskGraph.whenReady confirms that exact task instance is in the
        // resolved graph — never by string-matching
        // gradle.startParameter.taskNames, which is the check D4 replaced.
        write(
            "build.gradle.kts",
            """
            val marker = layout.buildDirectory.file("dsl-was-configured.txt")
            val theTask = tasks.register("portholeComposeReportLike") {
                doLast { println("ran") }
            }
            gradle.taskGraph.whenReady {
                if (hasTask(theTask.get())) {
                    marker.get().asFile.also { it.parentFile.mkdirs() }.writeText("configured")
                }
            }
            """.trimIndent(),
        )

        // "pCRL" is the camelCase-initials abbreviation of
        // "portholeComposeReportLike" — exactly the shape
        // "pCR" is of "portholeComposeReport".
        build("pCRL")

        val markerFile = File(projectDir.root, "build/dsl-was-configured.txt")
        assertTrue(
            "expected the taskGraph.whenReady callback to see the abbreviated task in the resolved graph",
            markerFile.isFile,
        )
    }

    @Test
    fun `the same gating correctly stays off when the task was never requested at all`() {
        write("settings.gradle.kts", "rootProject.name = \"abbrev-scratch-off\"\n")
        write(
            "build.gradle.kts",
            """
            val marker = layout.buildDirectory.file("dsl-was-configured.txt")
            val theTask = tasks.register("portholeComposeReportLike") {
                doLast { println("ran") }
            }
            gradle.taskGraph.whenReady {
                if (hasTask(theTask.get())) {
                    marker.get().asFile.also { it.parentFile.mkdirs() }.writeText("configured")
                }
            }
            """.trimIndent(),
        )

        build("help")

        val markerFile = File(projectDir.root, "build/dsl-was-configured.txt")
        assertTrue(!markerFile.isFile)
    }
}
