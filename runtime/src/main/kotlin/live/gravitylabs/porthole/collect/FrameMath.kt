// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

/**
 * The arithmetic behind the frame lane, kept apart from the listener that feeds
 * it so it can be checked without a display.
 *
 * This has been wrong once already, which is the reason it lives here: a 398ms
 * freeze was reported as a single missed frame because the divisor was the
 * system's relaxed deadline rather than the refresh interval.
 */
internal object FrameMath {

    /** 60Hz, used when the display will not say what it actually runs at. */
    const val DEFAULT_INTERVAL_NANOS = 16_666_666L

    /**
     * How many refreshes a frame cost, beyond the one it was entitled to.
     *
     * Always measured in refresh intervals, never in the deadline. The deadline
     * is what the system decided this frame was allowed to take and it moves;
     * the display's refresh rate is what the user actually waited through.
     *
     * Never returns less than 1 — this is only called for frames already known
     * to have overrun, and reporting "0 missed" for one of those would be
     * stating the opposite of what happened.
     */
    fun missedFrames(totalNanos: Long, frameIntervalNanos: Long): Int {
        // Falls back to a plausible interval rather than to one nanosecond.
        // Clamping to 1 keeps the division safe and answers with sixteen
        // million missed frames, which is worse than no answer.
        val interval = if (frameIntervalNanos > 0L) frameIntervalNanos else DEFAULT_INTERVAL_NANOS
        // Ceiling division: a frame one nanosecond over its second interval has
        // cost the display that whole refresh.
        val refreshes = (totalNanos + interval - 1) / interval
        return (refreshes - 1).toInt().coerceAtLeast(1)
    }

    /** Nanoseconds to whole milliseconds, which is the resolution reported. */
    fun toMillis(nanos: Long): Long = nanos / 1_000_000L

    /** The refresh interval for a rate, falling back when the rate is absurd. */
    fun intervalNanos(refreshHz: Float, fallbackNanos: Long): Long =
        if (refreshHz > 1f) (1_000_000_000L / refreshHz).toLong() else fallbackNanos
}
