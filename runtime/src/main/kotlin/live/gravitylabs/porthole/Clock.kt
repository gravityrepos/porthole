// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import android.os.SystemClock

/**
 * The one clock everything in the porthole is stamped against.
 *
 * Monotonic on purpose. Wall time goes backwards — a network time correction, a
 * user changing the date — and a timeline that goes backwards is not a timeline.
 * Every event, every report and every mark shares this reading, which is what
 * makes the timeline and the MCP tools able to talk about the same moment.
 *
 * Gathered behind one function rather than called for directly in thirty places,
 * for two reasons. It is the only thing standing between most of the collectors
 * and a common source set, so when the runtime splits for Multiplatform this
 * becomes an `expect` and the platforms supply an `actual`. And a clock reached
 * for statically cannot be substituted, which is why the event ring had no test.
 */
internal fun nowMs(): Long = SystemClock.uptimeMillis()

/**
 * What this clock reads against the two the rest of the system uses.
 *
 * [nowMs] is CLOCK_MONOTONIC, which stops while the device is in deep sleep.
 * Perfetto timestamps its events against CLOCK_BOOTTIME, which does not. The
 * two therefore drift apart by exactly the time the device spent asleep, and a
 * timestamp read off a Perfetto trace cannot be located in a Porthole capture
 * without knowing that difference.
 *
 * So record it. `bootMs - uptimeMs` is the accumulated sleep at the moment of
 * the reading, which is what converts between them:
 *
 *     porthole_ms = perfetto_boot_ms - (bootMs - uptimeMs)
 *
 * Sampled rather than computed once, because the difference grows every time
 * the device sleeps — and doze is a thing this runtime deliberately reports on,
 * so a session that sleeps mid-capture is expected rather than exotic.
 *
 * `wallMs` is here for a different reason: it is the only one a person can read
 * off a clock on the wall, which is how someone says which moment they meant.
 */
internal data class ClockOffsets(
    val uptimeMs: Long,
    val bootMs: Long,
    val wallMs: Long,
) {
    /** Time the device spent in deep sleep. The gap between the two clocks. */
    val sleepMs: Long get() = bootMs - uptimeMs

    /**
     * A CLOCK_BOOTTIME reading — the clock Perfetto stamps with — expressed in
     * the clock Porthole stamps with. This is what turns a timestamp read off a
     * system trace into a window that can be asked about here.
     */
    fun fromBootMs(bootMs: Long): Long = bootMs - sleepMs

    /** The reverse: a Porthole timestamp, as a system trace would have stamped it. */
    fun toBootMs(uptimeMs: Long): Long = uptimeMs + sleepMs
}

internal fun clockOffsets(): ClockOffsets = ClockOffsets(
    uptimeMs = SystemClock.uptimeMillis(),
    bootMs = SystemClock.elapsedRealtime(),
    wallMs = System.currentTimeMillis(),
)
