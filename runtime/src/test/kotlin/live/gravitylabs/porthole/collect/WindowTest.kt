// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The window semantics, as a table.
 *
 * There were five of these in the tree and no two of them agreed. The point of
 * the table is that the disagreements are now visible in one place: if somebody
 * decides the ceiling should be open again, or that a floor may go negative,
 * exactly one set of assertions changes and every collector changes with it.
 */
class WindowTest {

    private val now = 10_000L

    // -- the arguments, one at a time --------------------------------------

    @Test
    fun `sinceMs alone counts back from now and ends at now`() {
        assertEquals(7_000L..10_000L, Window.resolve(sinceMs = 3_000, from = null, to = null, now = now))
    }

    @Test
    fun `from alone runs to now`() {
        assertEquals(4_200L..10_000L, Window.resolve(sinceMs = null, from = 4_200, to = null, now = now))
    }

    @Test
    fun `from wins over sinceMs`() {
        // Absolute beats approximate: `from` names a moment on the timeline,
        // `sinceMs` can only gesture at one.
        assertEquals(4_200L..10_000L, Window.resolve(sinceMs = 3_000, from = 4_200, to = null, now = now))
    }

    @Test
    fun `to alone opens at the start of uptime`() {
        assertEquals(0L..8_000L, Window.resolve(sinceMs = null, from = null, to = 8_000, now = now))
    }

    @Test
    fun `neither bound means everything up to now`() {
        // Not everything full stop: the ceiling is now even here, which is the
        // part the log collector used to get wrong.
        assertEquals(0L..10_000L, Window.resolve(sinceMs = null, from = null, to = null, now = now))
    }

    @Test
    fun `to in the past ends there, not at now`() {
        assertEquals(4_000L..6_000L, Window.resolve(sinceMs = null, from = 4_000, to = 6_000, now = now))
    }

    // -- the arguments in combinations that cannot be satisfied ------------

    @Test
    fun `from after to is an empty window, not a widened one`() {
        val window = Window.resolve(sinceMs = null, from = 9_000, to = 2_000, now = now)
        assertTrue(window.isEmpty())
        assertFalse(5_000L in window)
    }

    @Test
    fun `to in the past with a sinceMs that does not reach it is empty`() {
        // "The last second, ending nine seconds ago" is a span containing no
        // moments, and saying so is better than quietly answering a different
        // question.
        val window = Window.resolve(sinceMs = 1_000, from = null, to = 1_000, now = now)
        assertTrue(window.isEmpty())
    }

    @Test
    fun `an empty window matches no span either`() {
        val window = Window.resolve(sinceMs = null, from = 9_000, to = 2_000, now = now)
        assertFalse(Window.overlaps(window, startedAt = 0, endedAt = null))
    }

    // -- the floor cannot go negative --------------------------------------

    @Test
    fun `sinceMs larger than uptime clamps the floor at zero`() {
        // A caller asking for the last twenty-four hours on a phone booted ten
        // seconds ago means "everything", not a window starting before the
        // device existed.
        assertEquals(0L..10_000L, Window.resolve(sinceMs = 86_400_000, from = null, to = null, now = now))
    }

    @Test
    fun `a negative from is clamped too`() {
        assertEquals(0L..10_000L, Window.resolve(sinceMs = null, from = -5_000, to = null, now = now))
    }

    @Test
    fun `sinceMs exactly equal to uptime still starts at zero`() {
        assertEquals(0L..10_000L, Window.resolve(sinceMs = 10_000, from = null, to = null, now = now))
    }

    // -- the overlap rule ---------------------------------------------------

    @Test
    fun `a span that began before the window and ran into it is in`() {
        val window = Window.resolve(sinceMs = null, from = 5_000, to = 6_000, now = now)
        assertTrue(Window.overlaps(window, startedAt = 4_000, endedAt = 5_500))
    }

    @Test
    fun `a span that began before the window and never ended is in`() {
        val window = Window.resolve(sinceMs = null, from = 5_000, to = 6_000, now = now)
        assertTrue(Window.overlaps(window, startedAt = 4_000, endedAt = null))
    }

    @Test
    fun `a span that straddles the whole window is in`() {
        val window = Window.resolve(sinceMs = null, from = 5_000, to = 6_000, now = now)
        assertTrue(Window.overlaps(window, startedAt = 1_000, endedAt = 9_000))
    }

    @Test
    fun `a span that ended before the window opened is out`() {
        val window = Window.resolve(sinceMs = null, from = 5_000, to = 6_000, now = now)
        assertFalse(Window.overlaps(window, startedAt = 4_000, endedAt = 4_999))
    }

    @Test
    fun `a span that began after the window closed is out`() {
        val window = Window.resolve(sinceMs = null, from = 5_000, to = 6_000, now = now)
        assertFalse(Window.overlaps(window, startedAt = 6_001, endedAt = null))
    }

    @Test
    fun `both ends are inclusive`() {
        val window = Window.resolve(sinceMs = null, from = 5_000, to = 6_000, now = now)
        assertTrue(Window.overlaps(window, startedAt = 4_000, endedAt = 5_000))
        assertTrue(Window.overlaps(window, startedAt = 6_000, endedAt = 6_000))
        assertTrue(5_000L in window)
        assertTrue(6_000L in window)
    }

    // -- one reading of the clock ------------------------------------------

    @Test
    fun `two readings of a moving clock give two different windows`() {
        // The defect this whole change exists to remove, stated as a test so
        // the shape of it is on record: `now` is a parameter precisely so that
        // one answer cannot be assembled from two readings.
        var tick = 10_000L
        val clock = { tick++ }

        val first = Window.resolve(sinceMs = 3_000, from = null, to = null, now = clock())
        val second = Window.resolve(sinceMs = 3_000, from = null, to = null, now = clock())
        assertFalse(first == second)

        val once = clock()
        assertEquals(
            Window.resolve(sinceMs = 3_000, from = null, to = null, now = once),
            Window.resolve(sinceMs = 3_000, from = null, to = null, now = once),
        )
    }
}
