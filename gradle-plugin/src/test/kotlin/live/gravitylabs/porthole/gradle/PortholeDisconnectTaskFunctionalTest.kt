// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.testkit.runner.TaskOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `portholeDisconnect` run twice, against an adb that is a script.
 *
 * The same fault as [PortholeConnectTaskFunctionalTest] guards against, on the
 * task nobody checked. It was thought immune because it deletes the file it
 * declared as an output — but an output that is absent after the run is absent
 * before the next one too, so with the inputs unchanged Gradle skipped it, and
 * the second `portholeDisconnect` reported success without asking adb to remove
 * anything. Someone switching devices is then told the forward is gone while it
 * is still in the adb server, and nothing on the file system disagrees.
 *
 * The harness — the stub adb, why it is a stub, and why the task is registered
 * by hand — is [StubAdbFunctionalTest].
 */
class PortholeDisconnectTaskFunctionalTest : StubAdbFunctionalTest() {

    private fun scratchProject(exitValue: Int = 0) =
        scratchProject(disconnectTask(stubAdb(exitValue)))

    @Test
    fun `runs adb again on the second invocation instead of reporting up to date`() {
        scratchProject()

        val first = build("portholeDisconnect")
        assertEquals(TaskOutcome.SUCCESS, first.task(":portholeDisconnect")?.outcome)

        val second = build("portholeDisconnect")
        assertEquals(
            "the forward lives in the adb server, so this task must never be up to date:\n" +
                second.output,
            TaskOutcome.SUCCESS,
            second.task(":portholeDisconnect")?.outcome,
        )

        val recorded = invocations()
        assertEquals("expected two adb invocations, got $recorded", 2, recorded.size)
        for (line in recorded) {
            assertTrue("expected a removal, got: $line", line.contains("forward --remove tcp:8677"))
        }
    }

    @Test
    fun `removes the forward again when there is a connection file to delete`() {
        // The run that had something to clean up, and the run that did not,
        // both ask adb. The file is the only thing that differs between them,
        // and it is deliberately not what decides.
        scratchProject(connectTask(stubAdb()) + "\n" + disconnectTask(stubAdb()))

        build("portholeConnect")
        assertTrue("expected a connection file at ${connectionFile.absolutePath}", connectionFile.isFile)

        build("portholeDisconnect")
        assertFalse("the connection file should be gone", connectionFile.isFile)

        build("portholeDisconnect")

        val recorded = invocations()
        assertEquals("expected three adb invocations, got $recorded", 3, recorded.size)
        assertEquals(2, recorded.count { it.contains("forward --remove tcp:8677") })
    }

    @Test
    fun `connecting after a disconnect brings the connection file back`() {
        // The sequence a device switch actually takes. Nothing about the
        // disconnect leaves the connect unable to run or up to date.
        scratchProject(connectTask(stubAdb()) + "\n" + disconnectTask(stubAdb()))

        build("portholeConnect")
        build("portholeDisconnect")
        val again = build("portholeConnect")

        assertEquals(TaskOutcome.SUCCESS, again.task(":portholeConnect")?.outcome)
        assertTrue("expected the connection file back", connectionFile.isFile)
        assertEquals(3, invocations().size)
    }

    @Test
    fun `an adb that fails to remove a forward is not a build failure`() {
        // `adb forward --remove` exits non-zero on some platform-tools versions
        // when there was no forward on the port. The request was that there be
        // none, and there is none; a disconnect that fails because there was
        // nothing to disconnect would be its own small lie, and would punish
        // running this before switching devices, which is when to run it.
        scratchProject(exitValue = 1)

        val result = build("portholeDisconnect")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeDisconnect")?.outcome)
        assertEquals(1, invocations().size)

        // And it still says so, and still clears the record.
        assertTrue(
            "expected the task to report the port clear, got:\n${result.output}",
            result.output.contains("no forward left on tcp:8677"),
        )
        assertFalse("the connection file should be gone", connectionFile.isFile)
    }

    @Test
    fun `stays compatible with the configuration cache`() {
        scratchProject()

        val first = build("portholeDisconnect", "--configuration-cache")
        assertTrue(
            "expected the configuration cache to be stored, got:\n${first.output}",
            first.output.contains("Configuration cache entry stored"),
        )
        assertEquals(TaskOutcome.SUCCESS, first.task(":portholeDisconnect")?.outcome)

        // Reused, not re-stored: nothing about the task captures state that
        // only exists at configuration time, so the second run is served from
        // the cache and still executes.
        val second = build("portholeDisconnect", "--configuration-cache")
        assertTrue(
            "expected the configuration cache to be reused, got:\n${second.output}",
            second.output.contains("Configuration cache entry reused"),
        )
        assertEquals(TaskOutcome.SUCCESS, second.task(":portholeDisconnect")?.outcome)
        assertEquals(2, invocations().size)
    }
}
