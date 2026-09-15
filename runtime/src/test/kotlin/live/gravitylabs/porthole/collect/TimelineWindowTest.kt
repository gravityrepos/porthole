// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import kotlinx.serialization.json.JsonObject
import live.gravitylabs.porthole.timelineEvents
import live.gravitylabs.porthole.store.EventRing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `timeline`'s window handling, brought into line with every other
 * collector by GRA-120.
 *
 * GRA-84 unified five window resolvers behind [Window.resolve] and
 * deliberately left `timeline` alone: it pages by sequence as well as by
 * time, carries a `sinceSeq` cursor `Window` has no concept of, and folding
 * all of that in at once would have been a fourth behaviour change outside
 * that ticket's scope. This is that follow-up. Before it, `timeline` tested
 * `from != null || to != null` first, so a caller who sent both `sinceMs`
 * and `to` — exactly what happens when an agent quotes a `findings` window
 * into `timeline` — had `sinceMs` silently dropped and got a wider answer
 * than it asked for, with nothing in the result saying so.
 */
class TimelineWindowTest {

    private val now = 10_000L

    private fun ring(): EventRing {
        val r = EventRing(now = { now })
        return r
    }

    private fun EventRing.seed(vararg atTimes: Long) {
        for (t in atTimes) emit("recompose", JsonObject(emptyMap()), at = t)
    }

    // -- the same three shapes `frames` resolves, resolving to the same range --
    //
    // `FrameCollector.report(sinceMs, from, to, limit)` calls
    // `Window.resolve(sinceMs, from, to, nowMs())` directly (see
    // FrameCollector.kt) — the identical call `timelineEvents` makes below.
    // Because both collectors are thin wrappers around the one shared
    // resolver, proving `timelineEvents` honours [Window.resolve]'s
    // documented boundaries (which `WindowTest` already pins independently)
    // is exactly what proves agreement with `frames`; there is no second
    // implementation here to drift out of step with it.

    @Test
    fun `sinceMs only resolves the same range as frames`() {
        val ring = ring()
        ring.seed(2_000, 4_000, 6_000, 9_000)

        val events = timelineEvents(ring, sinceSeq = null, sinceMs = 5_000, from = null, to = null, limit = 100, now = now)
        // Window.resolve(sinceMs=5_000, to=null, now=10_000) = 5_000..10_000:
        // only the events at or after 5_000.
        assertEquals(listOf(6_000L, 9_000L), events.map { it.t })
    }

    @Test
    fun `to only resolves the same range as frames`() {
        val ring = ring()
        ring.seed(2_000, 4_000, 6_000, 9_000)

        val events = timelineEvents(ring, sinceSeq = null, sinceMs = null, from = null, to = 5_000, limit = 100, now = now)
        // Window.resolve(sinceMs=null, to=5_000, now=10_000) = 0..5_000: only
        // the events at or before 5_000.
        assertEquals(listOf(2_000L, 4_000L), events.map { it.t })
    }

    @Test
    fun `sinceMs and to together resolve the same range as frames, and sinceMs is not dropped`() {
        val ring = ring()
        ring.seed(1_000, 4_000, 6_000, 7_999, 8_000)

        // This is the exact bug report: timeline(sinceMs=5000, to=8000) used to
        // silently drop sinceMs and answer between(0, 8000) instead.
        // Window.resolve(sinceMs=5_000, to=8_000, now=10_000): floor is
        // now - sinceMs = 5_000 (never to - sinceMs), ceiling is 8_000.
        assertEquals(5_000L..8_000L, Window.resolve(sinceMs = 5_000, from = null, to = 8_000, now = now))

        val events = timelineEvents(ring, sinceSeq = null, sinceMs = 5_000, from = null, to = 8_000, limit = 100, now = now)
        assertEquals(listOf(6_000L, 7_999L, 8_000L), events.map { it.t })
        // The event at 4_000 is proof sinceMs was consulted: between(0, 8000)
        // (the old, buggy behaviour) would have included it.
        assertTrue(events.none { it.t == 4_000L })
    }

    // -- the ceiling and the negative clamp, on the sinceMs-only branch ------

    @Test
    fun `sinceMs only has a ceiling at now`() {
        val ring = ring()
        ring.seed(9_500, 9_999, 10_000, 10_001, 50_000)

        val events = timelineEvents(ring, sinceSeq = null, sinceMs = 5_000, from = null, to = null, limit = 100, now = now)
        // The old code used sinceTime(now - sinceMs) with no upper bound at
        // all, so 10_001 and 50_000 — both stamped after `now` here — would
        // have leaked in. A real device never stamps the future, but nothing
        // stopped a test double, or a clock that moved between reads, from
        // producing exactly that.
        assertEquals(listOf(9_500L, 9_999L, 10_000L), events.map { it.t })
        assertTrue(events.none { it.t > now })
    }

    @Test
    fun `sinceMs larger than uptime asks for everything, not a negative floor`() {
        val ring = ring()
        ring.seed(0, 50, 9_999)

        val events = timelineEvents(
            ring,
            sinceSeq = null,
            sinceMs = 86_400_000,
            from = null,
            to = null,
            limit = 100,
            now = now,
        )
        assertEquals(listOf(0L, 50L, 9_999L), events.map { it.t })
    }

    // -- no branch uses Long.MAX_VALUE ----------------------------------------

    @Test
    fun `from alone does not reach Long MAX_VALUE — it ceilings at now`() {
        val ring = ring()
        ring.seed(1_000, 5_000, 50_000)

        // The old from/to branch used `to ?: Long.MAX_VALUE`, so `from` alone
        // (with `to` absent) answered as if there were no ceiling at all —
        // GRA-84's unbounded-ceiling defect, reproduced in this handler.
        val events = timelineEvents(ring, sinceSeq = null, sinceMs = null, from = 1_000, to = null, limit = 100, now = now)
        assertEquals(listOf(1_000L, 5_000L), events.map { it.t })
        assertTrue(events.none { it.t == 50_000L })
    }

    // -- an inverted window is empty, not widened -----------------------------

    @Test
    fun `to in the past with a sinceMs that does not reach it returns nothing`() {
        val ring = ring()
        ring.seed(1_000, 4_000, 5_005)

        val events = timelineEvents(ring, sinceSeq = null, sinceMs = 1_000, from = null, to = 5_005, limit = 100, now = now)
        // floor = now - sinceMs = 9_000, ceiling = 5_005: an empty window.
        assertTrue(events.isEmpty())
    }

    // -- the sinceSeq cursor mode is untouched, pinned byte-for-byte ---------

    @Test
    fun `sinceSeq alone is still a cursor over sequence, unaffected by the clock`() {
        val ring = ring()
        // Seeded with timestamps that would all fall outside a 0-width or
        // small sinceMs-shaped window, to prove sinceSeq mode never touches
        // Window at all.
        ring.seed(50_000, 60_000, 70_000)
        val secondSeq = 1L // seq is 0-indexed per emit() call, so the second event is seq 1.

        val events = timelineEvents(
            ring,
            sinceSeq = secondSeq,
            sinceMs = null,
            from = null,
            to = null,
            limit = 100,
            now = now,
        )
        // since(sinceSeq, limit): both events at and after seq 1, oldest first
        // — exactly EventRing.since's own contract, unmediated by Window.
        assertEquals(listOf(60_000L, 70_000L), events.map { it.t })
    }

    @Test
    fun `sinceSeq ranks below any time-bounded argument, exactly as from-to did before`() {
        val ring = ring()
        ring.seed(1_000, 5_000, 9_000)

        // Before this change, `from`/`to` already outranked `sinceSeq` — the
        // very first branch tested `from != null || to != null`. sinceMs now
        // shares that same rank, so this is not a precedence change for any
        // shape a caller has ever actually sent (mcp/src/index.ts never sends
        // sinceSeq at all); it just keeps the rule "any time bound wins" true
        // uniformly across all three time-bounded arguments.
        val events = timelineEvents(
            ring,
            sinceSeq = 0L,
            sinceMs = null,
            from = 5_000,
            to = null,
            limit = 100,
            now = now,
        )
        assertEquals(listOf(5_000L, 9_000L), events.map { it.t })
    }

    // -- the default (nothing given at all) is unchanged: everything, oldest first --

    @Test
    fun `nothing given at all still means everything buffered`() {
        val ring = ring()
        ring.seed(1_000, 5_000, 9_000)

        val events = timelineEvents(ring, sinceSeq = null, sinceMs = null, from = null, to = null, limit = 100, now = now)
        assertEquals(listOf(1_000L, 5_000L, 9_000L), events.map { it.t })
    }
}
