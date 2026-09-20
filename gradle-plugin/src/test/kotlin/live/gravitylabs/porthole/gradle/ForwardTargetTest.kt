// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.api.GradleException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GRA-199: [forwardTarget] decides the far end of `adb forward tcp:PORT
 * <target>` — the abstract socket keyed by `applicationId` by default, the
 * old shared TCP port when `legacyTcpPort` opts back into it. Both
 * [PortholeConnectTask] and [PortholeUiTask] (through the CLI it launches)
 * depend on this one function agreeing with itself, so it is pinned here on
 * its own, the same way [AdbArgsTest] pins `adbArgs` on its own.
 */
class ForwardTargetTest {

    @Test
    fun `defaults to the abstract socket named for applicationId`() {
        assertEquals("localabstract:porthole.com.example.shop", forwardTarget(8677, "com.example.shop", legacyTcpPort = false))
    }

    @Test
    fun `legacyTcpPort forwards to the port itself, applicationId or not`() {
        assertEquals("tcp:8677", forwardTarget(8677, "com.example.shop", legacyTcpPort = true))
        assertEquals("tcp:8677", forwardTarget(8677, null, legacyTcpPort = true))
    }

    @Test
    fun `refuses a null applicationId rather than build a blank socket name`() {
        val error = assertThrows(GradleException::class.java) {
            forwardTarget(8677, null, legacyTcpPort = false)
        }
        assertTrue(error.message.orEmpty().contains("porthole { applicationId }"))
        assertTrue("expected the legacyTcpPort escape hatch named too", error.message.orEmpty().contains("legacyTcpPort"))
    }

    @Test
    fun `refuses a blank applicationId the same way as a null one`() {
        // An unset Gradle Property's String value can arrive as "" rather
        // than null depending on how a caller reads it - same shape adbArgs'
        // own "treats a blank serial as no serial" test guards against for
        // the serial argument.
        val error = assertThrows(GradleException::class.java) {
            forwardTarget(8677, "   ", legacyTcpPort = false)
        }
        assertTrue(error.message.orEmpty().contains("porthole { applicationId }"))
    }

    @Test
    fun `the port changes the host side of the forward but never the target`() {
        assertEquals("localabstract:porthole.com.example.shop", forwardTarget(9999, "com.example.shop", legacyTcpPort = false))
    }

    // -- GRA-199 QA (F3): trimmed, not just checked for blankness -----------

    @Test
    fun `trims surrounding whitespace on applicationId before building the target`() {
        // Not merely "does not refuse" - the built string must be identical
        // to what an untouched value would produce, so this side's target
        // agrees byte for byte with mcp devices ts's own forwardTarget for
        // the same nominal id, which already trims.
        assertEquals(
            "localabstract:porthole.com.example.shop",
            forwardTarget(8677, "  com.example.shop  ", legacyTcpPort = false),
        )
        assertEquals(
            "localabstract:porthole.com.example.shop",
            forwardTarget(8677, "\tcom.example.shop\n", legacyTcpPort = false),
        )
    }

    @Test
    fun `whitespace-only applicationId is the same refusal as a genuinely blank one`() {
        // "   " already covers this via isNotBlank, but this pins that trim()
        // is what actually clears the value now, not merely that isNotBlank
        // still catches it - removing the trim() call while leaving isNotBlank
        // in place would still pass the pre-existing blank test above but
        // would let "  com.example.shop  " through untrimmed, which is
        // exactly the drift this file's other new test catches.
        val error = assertThrows(GradleException::class.java) {
            forwardTarget(8677, "\t\n  ", legacyTcpPort = false)
        }
        assertTrue(error.message.orEmpty().contains("porthole { applicationId }"))
    }
}
