// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.testkit.runner.TaskOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `portholeUi` launches the npm CLI's `ui` command, which does its own `adb
 * forward` (see `mcp/src/cli.ts`). GRA-199 changed what that forward targets,
 * so the plugin now has to pass `applicationId`/`legacyTcpPort` through as
 * CLI flags rather than leaving the CLI to guess them — this pins that
 * hand-off the same way [PortholeConnectTaskFunctionalTest] pins the
 * forward's own target, using [uiCommand] in place of a real `npx` launch,
 * the same "stub the process, record its argv" technique
 * [StubAdbFunctionalTest] uses for adb.
 */
class PortholeUiTaskFunctionalTest : StubAdbFunctionalTest() {

    /** `portholeUi`, wired to a stub launcher recorded the same way [stubAdb] records adb. */
    private fun uiTask(launcher: java.io.File, applicationId: String? = "com.example.scratch", legacyTcpPort: Boolean = false): String =
        """
        tasks.register<PortholeUiTask>("portholeUi") {
            port.set(8677)
            packageVersion.set("0.0.0")
            overrideCommand.set(listOf(${quoted(launcher.absolutePath)}))
            ${applicationId?.let { "applicationId.set(${quoted(it)})" } ?: ""}
            legacyTcpPort.set($legacyTcpPort)
        }
        """

    @Test
    fun `passes applicationId through as --application-id`() {
        scratchProject(uiTask(stubAdb()))

        val result = build("portholeUi")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeUi")?.outcome)

        val recorded = invocations().single()
        assertTrue("expected --application-id in: $recorded", recorded.contains("--application-id com.example.scratch"))
        assertFalse("legacyTcpPort is off, so --legacy-tcp-port must not appear: $recorded", recorded.contains("--legacy-tcp-port"))
    }

    @Test
    fun `passes --legacy-tcp-port only when the extension asked for it`() {
        scratchProject(uiTask(stubAdb(), applicationId = null, legacyTcpPort = true))

        val result = build("portholeUi")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeUi")?.outcome)

        val recorded = invocations().single()
        assertTrue("expected --legacy-tcp-port in: $recorded", recorded.contains("--legacy-tcp-port"))
        assertFalse("no applicationId was set, so --application-id must not appear: $recorded", recorded.contains("--application-id"))
    }

    @Test
    fun `omits both flags when applicationId is unset and legacyTcpPort is off`() {
        scratchProject(uiTask(stubAdb(), applicationId = null, legacyTcpPort = false))

        build("portholeUi")

        val recorded = invocations().single()
        assertFalse(recorded.contains("--application-id"))
        assertFalse(recorded.contains("--legacy-tcp-port"))
    }
}
