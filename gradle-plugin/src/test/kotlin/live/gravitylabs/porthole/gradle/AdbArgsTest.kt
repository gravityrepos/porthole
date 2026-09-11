// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Every device command the plugin runs goes through here, so getting the serial
 * wrong means the whole plugin talks to the wrong phone — or, with several
 * attached, refuses to talk to any of them.
 */
class AdbArgsTest {

    @Test
    fun `omits the serial when there is only one device`() {
        assertEquals(
            listOf("adb", "forward", "tcp:8677", "tcp:8677"),
            adbArgs("adb", null, "forward", "tcp:8677", "tcp:8677"),
        )
    }

    @Test
    fun `puts the serial before the command, where adb expects it`() {
        assertEquals(
            listOf("adb", "-s", "emulator-5554", "forward", "tcp:8677", "tcp:8677"),
            adbArgs("adb", "emulator-5554", "forward", "tcp:8677", "tcp:8677"),
        )
    }

    @Test
    fun `treats a blank serial as no serial`() {
        // An unset Gradle property arrives as an empty string, and passing
        // "-s ''" makes adb fail rather than pick the only device.
        assertEquals(listOf("adb", "devices"), adbArgs("adb", "", "devices"))
        assertEquals(listOf("adb", "devices"), adbArgs("adb", "   ", "devices"))
    }

    @Test
    fun `keeps the full path to adb`() {
        val path = "/opt/android/platform-tools/adb"
        assertEquals(path, adbArgs(path, null, "devices").first())
    }

    @Test
    fun `passes a command through with no arguments`() {
        assertEquals(listOf("adb", "-s", "x", "devices"), adbArgs("adb", "x", "devices"))
    }
}
