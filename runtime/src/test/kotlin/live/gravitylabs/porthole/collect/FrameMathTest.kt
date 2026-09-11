// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import org.junit.Assert.assertEquals
import org.junit.Test

private const val HZ_60 = 16_666_666L
private const val HZ_120 = 8_333_333L

/**
 * The regression this exists for: a 398ms freeze once reported as one missed
 * frame, because the divisor was the system's relaxed deadline instead of the
 * refresh interval.
 */
class FrameMathTest {

    @Test
    fun `a frame barely over budget costs one refresh`() {
        assertEquals(1, FrameMath.missedFrames(HZ_60 + 1, HZ_60))
    }

    @Test
    fun `a long freeze is counted in refreshes, not in ones`() {
        // 398ms at 60Hz is roughly 24 refreshes; 23 of them beyond its own.
        assertEquals(23, FrameMath.missedFrames(398_000_000L, HZ_60))
    }

    @Test
    fun `the same freeze costs twice as much on a 120Hz display`() {
        // The user waited the same 398ms, but that is twice as many frames.
        assertEquals(47, FrameMath.missedFrames(398_000_000L, HZ_120))
    }

    @Test
    fun `a frame inside its budget still reports at least one`() {
        // Only called for frames already known to have overrun their deadline,
        // which the system may have relaxed below a whole refresh. Reporting
        // zero would contradict the fact that got us here.
        assertEquals(1, FrameMath.missedFrames(1_000_000L, HZ_60))
    }

    @Test
    fun `part of a refresh still costs the whole refresh`() {
        // 1.5 intervals: the display showed the old frame for two refreshes.
        assertEquals(1, FrameMath.missedFrames(HZ_60 * 3 / 2, HZ_60))
    }

    @Test
    fun `an unusable interval falls back to a plausible one`() {
        // Not merely safe from dividing by zero: clamping the interval to one
        // nanosecond would answer "16 million frames missed", which is worse
        // than admitting the refresh rate is unknown and assuming 60Hz.
        assertEquals(1, FrameMath.missedFrames(HZ_60, 0L))
        assertEquals(23, FrameMath.missedFrames(398_000_000L, 0L))
    }

    @Test
    fun `an unreadable refresh rate leaves the interval alone`() {
        assertEquals(HZ_60, FrameMath.intervalNanos(0f, HZ_60))
        assertEquals(HZ_60, FrameMath.intervalNanos(1f, HZ_60))
    }

    @Test
    fun `a real refresh rate replaces it`() {
        assertEquals(HZ_120, FrameMath.intervalNanos(120f, HZ_60))
    }

    @Test
    fun `nanoseconds report as whole milliseconds`() {
        assertEquals(16, FrameMath.toMillis(16_999_999L))
    }
}
