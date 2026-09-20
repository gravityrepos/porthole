// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.testkit.runner.GradleRunner
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * `PortholeComposeReportTask` registered directly, with no AGP and no
 * `PortholePlugin` involved at all — the same pattern
 * `StubAdbFunctionalTest`'s own KDoc explains for `PortholeConnectTask`/
 * `PortholeDisconnectTask`: "the plugin only registers [tasks] on an
 * Android module and that needs AGP, an SDK and the network ... these cover
 * the tasks' own behaviour."
 */
class PortholeComposeReportTaskFunctionalTest {

    @get:Rule
    val projectDir = TemporaryFolder()

    private fun write(path: String, text: String) {
        val file = File(projectDir.root, path)
        file.parentFile.mkdirs()
        file.writeText(text)
    }

    private fun buildScript(strongSkippingInBuild: String = "unknown"): String =
        """
        @file:Suppress("UNUSED_IMPORT")

        import live.gravitylabs.porthole.gradle.PortholeComposeReportTask

        // Applying the plugin (even on this plain, non-Android project,
        // where it registers nothing and only warns) is what puts TestKit's
        // injected classpath on the build script's own, so the import above
        // resolves — see StubAdbFunctionalTest's own `scratchProject` KDoc
        // for the same pattern applied to the connect/disconnect tasks.
        plugins { id("live.gravitylabs.porthole") }

        tasks.register<PortholeComposeReportTask>("composeReport") {
            variant.set("debug")
            moduleName.set("app")
            kotlinVersion.set("2.1.0")
            strongSkippingInBuild.set("$strongSkippingInBuild")
            moduleRoot.set(layout.projectDirectory)
            kotlinSources.setFrom(fileTree(".") { include("**/*.kt") })
            composablesTxt.set(layout.projectDirectory.file("reports/app_debug-composables.txt"))
            composablesCsv.set(layout.projectDirectory.file("reports/app_debug-composables.csv"))
            classesTxt.set(layout.projectDirectory.file("reports/app_debug-classes.txt"))
            reportFiles.from(composablesTxt, composablesCsv, classesTxt)
            outputFile.set(layout.buildDirectory.file("porthole/compose-report.json"))
        }
        """.trimIndent()

    @Test
    fun `D5 (QA) - a missing report reaches this task's own diagnostic, not Gradle's generic file-does-not-exist error`() {
        write("settings.gradle.kts", "rootProject.name = \"scratch\"\n")
        write("build.gradle.kts", buildScript())
        // Deliberately no reports/ directory at all under projectDir.

        val result = GradleRunner.create()
            .withProjectDir(projectDir.root)
            .withPluginClasspath()
            .withArguments("composeReport", "--stacktrace")
            .buildAndFail()

        // The exact regression: before D5, `@InputFile` on composablesTxt/
        // classesTxt made Gradle refuse the task before its own action ever
        // ran, with a generic "file ... does not exist" message that names
        // neither compose-compiler reports nor how to enable them.
        assertTrue(
            "expected this task's own diagnostic, got:\n${result.output}",
            result.output.contains("portholeComposeReport found no compiler report"),
        )
        assertTrue(result.output.contains("compose-compiler reports were not actually enabled"))
        assertFalse(
            "the generic Gradle validation message means the input-declaration fix regressed",
            result.output.contains("Property 'composablesTxt' specifies file"),
        )
    }

    @Test
    fun `parses and writes a report when the files are actually there`() {
        write("settings.gradle.kts", "rootProject.name = \"scratch\"\n")
        write("build.gradle.kts", buildScript())
        write(
            "reports/app_debug-composables.txt",
            "restartable skippable fun Foo(\n  stable x: Int\n)\n",
        )
        write("reports/app_debug-classes.txt", "")
        write("src/main/kotlin/Foo.kt", "class Foo\n")

        val result = GradleRunner.create()
            .withProjectDir(projectDir.root)
            .withPluginClasspath()
            .withArguments("composeReport", "--stacktrace")
            .build()

        assertTrue(result.output.contains("wrote 1 composable(s)"))
        val out = File(projectDir.root, "build/porthole/compose-report.json")
        assertTrue(out.isFile)
        assertTrue(out.readText().contains("\"Foo\""))
    }

    private fun runWithStrongSkipping(value: String): String {
        write("settings.gradle.kts", "rootProject.name = \"scratch\"\n")
        write("build.gradle.kts", buildScript(strongSkippingInBuild = value))
        write("reports/app_debug-composables.txt", "restartable skippable fun Foo(\n  stable x: Int\n)\n")
        write("reports/app_debug-classes.txt", "")
        GradleRunner.create()
            .withProjectDir(projectDir.root)
            .withPluginClasspath()
            .withArguments("composeReport", "--stacktrace")
            .build()
        return File(projectDir.root, "build/porthole/compose-report.json").readText()
    }

    @Test
    fun `strongSkippingInBuild true serialises as a real JSON boolean, not the string 'true'`() {
        val json = runWithStrongSkipping("true")
        // Mutation quoted: `"strongSkippingInBuild" to strongSkippingInBuild.get()`
        // in place of the `when` in PortholeComposeReportTask.kt's own
        // generate() — the raw "true"/"false"/"unknown" string this task's
        // own property already stores internally — is the one-line change
        // that makes this assertion fail (it would read `"true"`, quoted,
        // instead of the bare `true` a JSON consumer expects for a boolean).
        assertTrue(json.contains("\"strongSkippingInBuild\": true"))
        assertFalse(json.contains("\"strongSkippingInBuild\": \"true\""))
    }

    @Test
    fun `strongSkippingInBuild false serialises as a real JSON boolean`() {
        val json = runWithStrongSkipping("false")
        assertTrue(json.contains("\"strongSkippingInBuild\": false"))
    }

    @Test
    fun `strongSkippingInBuild unknown serialises as the string 'unknown'`() {
        val json = runWithStrongSkipping("unknown")
        assertTrue(json.contains("\"strongSkippingInBuild\": \"unknown\""))
    }
}
