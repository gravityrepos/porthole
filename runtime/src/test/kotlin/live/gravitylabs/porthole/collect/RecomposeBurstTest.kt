// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Coalescing is the whole job here.
 *
 * A recomposition is sub-millisecond and can happen thousands of times a
 * second, so the interesting properties are all about what does *not* get
 * emitted: one span per burst, no span left open, and no span stretched across
 * the silence that ended it.
 */
class RecomposeBurstTest {

    private var clock = 0L
    private val events = mutableListOf<String>()

    private fun burst(quietMs: Long = 120, maxMs: Long = 3_000) = RecomposeBurst(
        quietMs = quietMs,
        maxMs = maxMs,
        now = { clock },
        begin = { name, cookie -> events += "begin $name#$cookie@$clock" },
        end = { name, cookie -> events += "end $name#$cookie@$clock" },
        nextCookie = { events.count { it.startsWith("begin") } + 1 },
    )

    @Test
    fun `a run of recompositions is one span, not one each`() {
        val b = burst()
        repeat(500) {
            clock += 2
            b.onRecompose()
        }
        clock += 200
        b.tick()

        assertEquals(listOf("begin recompose#1@2", "end recompose#1@1200"), events)
    }

    @Test
    fun `silence ends the burst, and the span stops there`() {
        val b = burst(quietMs = 100)
        b.onRecompose()
        clock += 10
        b.onRecompose()

        clock += 100
        b.tick()
        assertFalse(b.isOpen())
        // Ends when the tick found it quiet, not when the next one arrives.
        assertTrue(events.last().endsWith("@110"))
    }

    @Test
    fun `a later burst opens a new span rather than reviving the old one`() {
        val b = burst(quietMs = 100)
        b.onRecompose()
        clock += 200
        b.tick()
        b.onRecompose()
        clock += 200
        b.tick()

        assertEquals(
            listOf(
                "begin recompose#1@0",
                "end recompose#1@200",
                "begin recompose#2@200",
                "end recompose#2@400",
            ),
            events,
        )
    }

    @Test
    fun `a tick while churn continues leaves the span open`() {
        val b = burst(quietMs = 100)
        b.onRecompose()
        clock += 50
        b.tick()
        assertTrue(b.isOpen())
        assertEquals(1, events.size)
    }

    @Test
    fun `an endless burst is cut rather than running away with the trace`() {
        val b = burst(maxMs = 500)
        repeat(400) {
            clock += 5
            b.onRecompose()
        }
        // 2000ms of continuous churn at the 500ms cap: four spans, not one.
        assertEquals(4, events.count { it.startsWith("begin") })
    }

    @Test
    fun `closing ends an open span, since one left open runs to the capture end`() {
        val b = burst()
        b.onRecompose()
        b.close()
        assertFalse(b.isOpen())
        assertTrue(events.last().startsWith("end recompose"))
    }

    @Test
    fun `closing when nothing is open does nothing`() {
        val b = burst()
        b.close()
        b.close()
        assertEquals(emptyList<String>(), events)
    }

    @Test
    fun `every burst shares one track, whatever recomposed`() {
        // Named after the opener it said `recompose root` on a device, because
        // the outermost composable is the one that gets there first. One name.
        val b = burst(quietMs = 10)
        repeat(3) {
            b.onRecompose()
            clock += 20
            b.tick()
        }
        val names = events.filter { it.startsWith("begin") }.map { it.substringBefore('#') }.toSet()
        assertEquals(setOf("begin recompose"), names)
    }
}
