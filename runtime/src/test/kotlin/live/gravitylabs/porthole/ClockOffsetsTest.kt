// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The arithmetic that lets a timestamp from a system trace be found here.
 *
 * Porthole stamps with CLOCK_MONOTONIC, which stops in deep sleep. Perfetto
 * stamps with CLOCK_BOOTTIME, which does not. Everything below is the
 * consequence of that one difference, and getting the sign wrong would put
 * every lookup off by however long the device had been asleep — a quiet error
 * that looks like data simply not being there.
 */
class ClockOffsetsTest {

    @Test
    fun `sleep is what the two clocks disagree by`() {
        val clocks = ClockOffsets(uptimeMs = 10_000, bootMs = 25_000, wallMs = 0)
        assertEquals(15_000, clocks.sleepMs)
    }

    @Test
    fun `a device that never slept has the clocks agreeing`() {
        val clocks = ClockOffsets(uptimeMs = 8_000, bootMs = 8_000, wallMs = 0)
        assertEquals(0, clocks.sleepMs)
        assertEquals(8_000, clocks.fromBootMs(8_000))
    }

    @Test
    fun `a perfetto timestamp converts into porthole's clock`() {
        val clocks = ClockOffsets(uptimeMs = 10_000, bootMs = 25_000, wallMs = 0)
        // A slice at boot-time 20s happened at uptime 5s, because 15s of the
        // boot clock's 20 were spent asleep and Porthole's clock did not run.
        assertEquals(5_000, clocks.fromBootMs(20_000))
    }

    @Test
    fun `and back again`() {
        val clocks = ClockOffsets(uptimeMs = 10_000, bootMs = 25_000, wallMs = 0)
        assertEquals(20_000, clocks.toBootMs(5_000))
        assertEquals(5_000, clocks.fromBootMs(clocks.toBootMs(5_000)))
    }

    @Test
    fun `the reading itself is consistent`() {
        // The pair is sampled together, so converting the sample's own uptime
        // must give back its own boot reading. If this fails the two fields
        // were read at different moments.
        val clocks = ClockOffsets(uptimeMs = 10_000, bootMs = 25_000, wallMs = 0)
        assertEquals(clocks.bootMs, clocks.toBootMs(clocks.uptimeMs))
    }
}
