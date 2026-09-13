// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import live.gravitylabs.porthole.blockingReport
import live.gravitylabs.porthole.store.EventRing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The `blocking` answer, over one window, with the threshold it actually used.
 *
 * Both halves of this report are drawn from the same buffers by two different
 * collectors, and until now each of them worked out the window for itself from
 * its own reading of the clock. The two readings were milliseconds apart, so a
 * stall and a query that happened at the same instant could land inside one
 * half's window and outside the other's — an inconsistency nobody was ever
 * going to spot in the output, since the output does not say what window it
 * used.
 */
class BlockingWindowTest {

    private var clock = 10_000L

    private fun ring() = EventRing(now = { clock })

    private fun watchdog(threshold: Long = MainThreadWatchdog.STALL_MS) =
        MainThreadWatchdog(ring(), emptyList(), stallThresholdMs = threshold, now = { clock })

    /** onMainThread forced: a JVM test has no looper to be identical to. */
    private fun inflight() = InflightCollector(ring(), now = { clock }, isMainThread = { true })

    /** A main-thread query that ran from [startedAt] for [durationMs]. */
    private fun InflightCollector.seedQuery(startedAt: Long, durationMs: Long) {
        clock = startedAt
        val id = queryStart("SELECT * FROM cart_items", emptyList())
        clock = startedAt + durationMs
        queryEnd(id, result = 1)
    }

    /** A main-thread HTTP call that started at [startedAt] and has not ended. */
    private fun InflightCollector.seedOpenCall(startedAt: Long): Any {
        clock = startedAt
        val token = Any()
        httpStart(token, "GET", "https://api.example.com/cart")
        httpThread(token, onMainThread = true)
        return token
    }

    // -- one window, both halves -------------------------------------------

    @Test
    fun `a stall and a query at the same instant are answered the same way`() {
        // Swept across the membership boundary rather than tested at one point,
        // because the defect this guards against is a few milliseconds wide and
        // a single sample would walk straight past it. Which means the sweep is
        // only worth anything if it is centred on the boundary, so: the seeded
        // stall and query both span [t, t + 100], and Window.overlaps puts a
        // span in 5_000..6_000 when it began at or before 6_000 and had not
        // ended before 5_000 — that is, when t is in [4_900, 6_000]. The
        // boundary is therefore 4_900, one span-length below the window's
        // floor, and 4_900 is what this sweep straddles.
        //
        // It has been 5_000 before now and must be re-derived whenever the
        // membership rule or the seeded duration moves. This sweep originally
        // ran 4_980..5_020, which was centred on the boundary under the old
        // start-time rule and stopped being centred on anything when matching
        // changed to overlap: every sampled t sat comfortably inside the window
        // on both halves, and the sweep could not see a window skew below 81ms.
        // Centred here it separates the two halves at a skew of 1ms.
        for (t in 4_880L..4_920L) {
            val watchdog = watchdog()
            val inflight = inflight()
            watchdog.record(t, 100, "at com.example.shop.Cart.load")
            inflight.seedQuery(startedAt = t, durationMs = 100)

            val report = blockingReport(watchdog, inflight, 5_000L..6_000L, 10)

            assertEquals(
                "stalls and queries disagreed at t=$t",
                report.stalls.isNotEmpty(),
                report.mainThreadQueries.isNotEmpty(),
            )
        }
    }

    @Test
    fun `an empty window returns nothing from either half`() {
        val watchdog = watchdog()
        val inflight = inflight()
        watchdog.record(5_000, 100, "at com.example.shop.Cart.load")
        inflight.seedQuery(startedAt = 5_000, durationMs = 100)
        inflight.seedOpenCall(startedAt = 5_000)

        // `from` after `to`: a span of time containing no moments.
        val report = blockingReport(watchdog, inflight, Window.resolve(null, 9_000, 2_000, 10_000), 10)

        assertTrue(report.stalls.isEmpty())
        assertTrue(report.mainThreadQueries.isEmpty())
        assertTrue(report.mainThreadHttp.isEmpty())
        assertTrue(report.notes.any { it.startsWith("Nothing blocked the main thread") })
    }

    // -- the threshold comes off the watchdog -------------------------------

    @Test
    fun `the reported threshold is the one the watchdog enforces`() {
        // Changed here rather than asserted against the literal 100: the point
        // is that moving the watchdog's threshold moves the reported one, which
        // an assertEquals(100L, ...) would pass while the report lied.
        val watchdog = watchdog(threshold = 250L)

        val report = blockingReport(watchdog, inflight(), 0L..10_000L, 10)

        assertEquals(250L, report.stallThresholdMs)
        assertEquals(250L, watchdog.stallThresholdMs)
    }

    @Test
    fun `the default threshold is the watchdog's own constant`() {
        val report = blockingReport(watchdog(), inflight(), 0L..10_000L, 10)
        assertEquals(MainThreadWatchdog.STALL_MS, report.stallThresholdMs)
    }

    // -- work that began before the window ----------------------------------

    @Test
    fun `a query that started before the window and ran into it appears`() {
        val inflight = inflight()
        // Started 200ms before the window opened, held the main thread for
        // 900ms. This is the query the window was drawn around, and filtering
        // on startedAt alone made it the one thing guaranteed to be missing.
        inflight.seedQuery(startedAt = 4_800, durationMs = 900)

        val report = blockingReport(watchdog(), inflight, 5_000L..6_000L, 10)

        assertEquals(1, report.mainThreadQueries.size)
        assertEquals(4_800L, report.mainThreadQueries[0].startedAt)
        assertEquals(900L, report.mainThreadQueries[0].elapsedMs)
    }

    @Test
    fun `a query that finished before the window opened does not`() {
        val inflight = inflight()
        inflight.seedQuery(startedAt = 4_000, durationMs = 100)

        val report = blockingReport(watchdog(), inflight, 5_000L..6_000L, 10)

        assertTrue(report.mainThreadQueries.isEmpty())
    }

    @Test
    fun `an HTTP call still in flight when the window closed appears, with its real cost`() {
        val inflight = inflight()
        inflight.seedOpenCall(startedAt = 4_800)
        clock = 12_000

        val report = blockingReport(watchdog(), inflight, 5_000L..6_000L, 10)

        assertEquals(1, report.mainThreadHttp.size)
        assertEquals(4_800L, report.mainThreadHttp[0].startedAt)
        // Not zero: the DTO used to be frozen at the moment the call was
        // noticed, which is a few microseconds after it started, so every
        // main-thread call reported an elapsed time of about nothing and the
        // "worst first" ordering meant nothing either.
        assertEquals(7_200L, report.mainThreadHttp[0].elapsedMs)
    }

    @Test
    fun `a stall that began before the window and ran into it appears`() {
        val watchdog = watchdog()
        watchdog.record(4_800, 900, "at com.example.shop.Cart.load")

        val report = blockingReport(watchdog, inflight(), 5_000L..6_000L, 10)

        assertEquals(1, report.stalls.size)
        assertEquals(4_800L, report.stalls[0].at)
    }

    // -- the convenience signature, which both collectors now share ---------

    @Test
    fun `sinceMs larger than uptime asks for everything, not a negative floor`() {
        val inflight = inflight()
        inflight.seedQuery(startedAt = 50, durationMs = 10)
        clock = 20_000

        val queries = inflight.mainThreadQueries(sinceMs = 86_400_000, from = null, to = null, limit = 10)

        assertEquals(1, queries.size)
    }

    @Test
    fun `a to in the past with a sinceMs that does not reach it returns nothing`() {
        val inflight = inflight()
        inflight.seedQuery(startedAt = 5_000, durationMs = 10)
        clock = 20_000

        val queries = inflight.mainThreadQueries(sinceMs = 1_000, from = null, to = 5_005, limit = 10)

        assertTrue(queries.isEmpty())
    }

    @Test
    fun `from wins over sinceMs on the collectors too`() {
        val inflight = inflight()
        inflight.seedQuery(startedAt = 5_000, durationMs = 10)
        clock = 20_000

        // sinceMs alone would start at 19_000 and miss it; `from` does not.
        assertTrue(inflight.mainThreadQueries(sinceMs = 1_000, from = null, to = null, limit = 10).isEmpty())
        assertFalse(inflight.mainThreadQueries(sinceMs = 1_000, from = 4_000, to = null, limit = 10).isEmpty())
    }
}
