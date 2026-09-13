// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.testkit.runner.TaskOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `portholeConnect` run twice, against an adb that is a script.
 *
 * The bug this guards against is silent and total: the task declared the
 * connection file as an output, so its second run was up to date, and Gradle
 * printed success without running adb. The forward it claims to have made lives
 * in the adb server, so a stale one is invisible from the file system — every
 * MCP tool then reports not-connected and tells the user to run the command
 * that just lied to them.
 *
 * The harness — the stub adb, why it is a stub, and why the task is registered
 * by hand — is [StubAdbFunctionalTest].
 */
class PortholeConnectTaskFunctionalTest : StubAdbFunctionalTest() {

    private fun scratchProject() = scratchProject(connectTask(stubAdb()))

    @Test
    fun `runs adb again on the second invocation instead of reporting up to date`() {
        scratchProject()

        val first = build("portholeConnect")
        assertEquals(TaskOutcome.SUCCESS, first.task(":portholeConnect")?.outcome)

        val second = build("portholeConnect")
        assertEquals(
            "the forward lives in the adb server, so this task must never be up to date:\n" +
                second.output,
            TaskOutcome.SUCCESS,
            second.task(":portholeConnect")?.outcome,
        )

        val recorded = invocations()
        assertEquals("expected two adb invocations, got $recorded", 2, recorded.size)
        for (line in recorded) {
            assertTrue("expected a forward, got: $line", line.contains("forward tcp:8677 tcp:8677"))
        }
    }

    @Test
    fun `runs adb again even when the connection file was left untouched`() {
        // The narrower statement of the same thing: nothing is deleted between
        // the runs, the inputs do not move, and adb is still asked twice.
        scratchProject()

        build("portholeConnect")
        assertTrue("expected a connection file at ${connectionFile.absolutePath}", connectionFile.isFile)
        val written = connectionFile.readText()

        build("portholeConnect")

        assertEquals(2, invocations().size)
        assertEquals("the connection file should be rewritten identically", written, connectionFile.readText())
    }

    @Test
    fun `stays compatible with the configuration cache`() {
        scratchProject()

        val first = build("portholeConnect", "--configuration-cache")
        assertTrue(
            "expected the configuration cache to be stored, got:\n${first.output}",
            first.output.contains("Configuration cache entry stored"),
        )

        // Reused, not re-stored: nothing about the task captures state that
        // only exists at configuration time, so the second run is served from
        // the cache and still executes.
        val second = build("portholeConnect", "--configuration-cache")
        assertTrue(
            "expected the configuration cache to be reused, got:\n${second.output}",
            second.output.contains("Configuration cache entry reused"),
        )
        assertEquals(TaskOutcome.SUCCESS, second.task(":portholeConnect")?.outcome)
        assertEquals(2, invocations().size)
    }
}
