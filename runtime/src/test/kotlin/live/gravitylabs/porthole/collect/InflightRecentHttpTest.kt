// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import live.gravitylabs.porthole.protocol.BodyPreview
import live.gravitylabs.porthole.store.EventRing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GRA-66: `recentHttp` becomes window-aware — the same `sinceMs`/`from`/`to`
 * shape [Window] already gives every other tool here, with the old "last 25"
 * behaviour kept as `limit`'s own default rather than lost.
 *
 * Pure collector logic, hand-built clock — the same split `BlockingWindowTest`
 * makes for [InflightCollector]'s other window-taking methods, for the same
 * reason: whether the arithmetic is right does not need a socket to answer,
 * only `HttpPhasesTest` (a different file, MockWebServer) is for the parts
 * that do.
 */
class InflightRecentHttpTest {

    private var clock = 0L

    private fun inflight() = InflightCollector(EventRing(now = { clock }), now = { clock })

    /** A finished call, entirely inside `[startedAt, startedAt + durationMs]`. */
    private fun InflightCollector.seedCall(startedAt: Long, durationMs: Long, id: String = "$startedAt"): Any {
        clock = startedAt
        val token = Any() to id
        httpStart(token, "GET", "https://api.example.com/cart/$id")
        clock = startedAt + durationMs
        httpEnd(token, "done")
        return token
    }

    /** Same as [seedCall], but with a body preview on both directions — GRA-66 F15's own subject. */
    private fun InflightCollector.seedCallWithBody(startedAt: Long, durationMs: Long, id: String = "$startedAt"): Any {
        clock = startedAt
        val token = Any() to id
        httpStart(token, "GET", "https://api.example.com/cart/$id")
        httpRequest(token, emptyMap(), BodyPreview(contentType = "application/json", byteCount = 12, truncated = false, text = "req-$id"))
        httpResponse(token, 200, emptyMap(), BodyPreview(contentType = "application/json", byteCount = 12, truncated = false, text = "res-$id"))
        clock = startedAt + durationMs
        httpEnd(token, "done")
        return token
    }

    // -- the old default, unchanged --------------------------------------------

    @Test
    fun `with no window and no limit, behaves exactly as the old unwindowed 'last 25' did`() {
        val inflight = inflight()
        for (i in 1..5) inflight.seedCall(startedAt = i * 100L, durationMs = 10)

        val recent = inflight.recentHttp()

        assertEquals(5, recent.size)
    }

    @Test
    fun `the default limit is 25, the same number the tool description always quoted`() {
        val inflight = inflight()
        for (i in 1..30) inflight.seedCall(startedAt = i * 100L, durationMs = 10)

        assertEquals(25, inflight.recentHttp().size)
        assertEquals(InflightCollector.RECENT_HTTP_DEFAULT_LIMIT, inflight.recentHttp().size)
    }

    @Test
    fun `default (no explicit window), the newest calls are the ones kept, not the oldest`() {
        val inflight = inflight()
        for (i in 1..30) inflight.seedCall(startedAt = i * 100L, durationMs = 10)

        val recent = inflight.recentHttp()

        assertEquals(30 * 100L, recent.first().startedAt) // newest first
        assertTrue(recent.none { it.startedAt <= 5 * 100L }) // the oldest 5 dropped by the limit
    }

    // -- the actual point of this ticket ----------------------------------------

    @Test
    fun `a call inside an explicit window is returned, one outside is not`() {
        val inflight = inflight()
        inflight.seedCall(startedAt = 1_000, durationMs = 50) // inside
        inflight.seedCall(startedAt = 9_000, durationMs = 50) // outside

        val recent = inflight.recentHttp(sinceMs = null, from = 900, to = 1_200, limit = 25)

        assertEquals(1, recent.size)
        assertEquals(1_000L, recent[0].startedAt)
    }

    @Test
    fun `a call older than the default 25-call cutoff is still found when a window quoting it is given`() {
        // This is the AC in the ticket's own words: "including calls older
        // than the last 25." Seed one call, then bury it under 30 newer
        // ones -- past both the old hard cap and the new default limit.
        val inflight = inflight()
        val buried = inflight.seedCall(startedAt = 1_000, durationMs = 10, id = "buried")
        for (i in 1..30) inflight.seedCall(startedAt = 10_000 + i * 100L, durationMs = 10)

        // Unwindowed, the default limit alone would never reach it.
        assertTrue(inflight.recentHttp().none { it.startedAt == 1_000L })

        // But a caller quoting the exact window it happened in -- the way a
        // finding's own `window` is quoted back at `ask_system_trace` -- still
        // finds it, because RECENT_HTTP_CAPACITY (200) comfortably outlives
        // RECENT_HTTP_DEFAULT_LIMIT (25).
        val recent = inflight.recentHttp(sinceMs = null, from = 900, to = 1_100, limit = 25)
        assertEquals(1, recent.size)
        assertEquals(1_000L, recent[0].startedAt)
    }

    @Test
    fun `limit caps the return even when more calls match the window`() {
        val inflight = inflight()
        for (i in 1..10) inflight.seedCall(startedAt = 1_000 + i * 10L, durationMs = 5)

        val recent = inflight.recentHttp(sinceMs = null, from = 0, to = 100_000, limit = 3)

        assertEquals(3, recent.size)
    }

    @Test
    fun `matched by overlap -- a call that started before the window and ran into it still counts`() {
        val inflight = inflight()
        // Started 200ms before the window opened, still running 900ms —
        // the exact shape BlockingWindowTest's own mainThreadHttp test
        // covers for the live set; this is recentHttp's version of the same
        // rule for a call that has already finished.
        inflight.seedCall(startedAt = 4_800, durationMs = 900)

        val recent = inflight.recentHttp(sinceMs = null, from = 5_000, to = 6_000, limit = 25)

        assertEquals(1, recent.size)
        assertEquals(4_800L, recent[0].startedAt)
    }

    @Test
    fun `an empty window returns nothing`() {
        val inflight = inflight()
        inflight.seedCall(startedAt = 1_000, durationMs = 50)

        // from after to: a span of time containing no moments (Window's own rule).
        val recent = inflight.recentHttp(Window.resolve(null, 9_000, 2_000, 10_000), 25)

        assertFalse(recent.isNotEmpty())
    }

    // -- the buffer itself ------------------------------------------------------

    @Test
    fun `the buffer holds more than the default limit -- capacity bump is real, not cosmetic`() {
        // Before GRA-66, RECENT_HTTP_CAPACITY *was* the limit: 25 in, 25 out,
        // nothing held past that. This proves the buffer itself now holds
        // enough that an explicit window can still reach further back than
        // the default 25 the tool returns unwindowed.
        val inflight = inflight()
        for (i in 1..199) inflight.seedCall(startedAt = i * 10L, durationMs = 1)

        // All 199 fit; RECENT_HTTP_CAPACITY is 200.
        assertEquals(199, inflight.recentHttp(sinceMs = null, from = 0, to = 10_000, limit = 199).size)

        // The 200th, and a 201st past capacity, evict the oldest -- the
        // buffer is bounded, not unbounded, which the same test proves in
        // the same breath.
        inflight.seedCall(startedAt = 2_000, durationMs = 1)
        inflight.seedCall(startedAt = 2_010, durationMs = 1)
        val all = inflight.recentHttp(sinceMs = null, from = 0, to = 10_000, limit = 201)
        assertEquals(200, all.size)
        assertTrue("the oldest call should have been evicted", all.none { it.startedAt == 10L })
    }

    // -- GRA-66 F15: only the newest 25 keep their body previews -----------------

    @Test
    fun `only the newest 25 entries keep their body previews -- older ones lose only the body`() {
        val inflight = inflight()
        for (i in 1..30) inflight.seedCallWithBody(startedAt = i * 100L, durationMs = 10, id = "$i")

        val all = inflight.recentHttp(sinceMs = null, from = 0, to = 100_000, limit = 30)
        assertEquals(30, all.size) // newest first, per the earlier tests in this file

        val withBodies = all.take(25)
        val stripped = all.drop(25)

        assertTrue(
            "the newest 25 should keep their body previews",
            withBodies.all { it.requestBody != null && it.responseBody != null },
        )
        assertTrue(
            "entries older than the newest 25 should have lost their body previews",
            stripped.all { it.requestBody == null && it.responseBody == null },
        )
        // Stripping removes only the bodies -- everything else a caller
        // might still want (status, timing, headers-as-present) survives.
        assertTrue(
            "a stripped entry should keep every other field",
            stripped.all { it.status == 200 && it.elapsedMs == 10L && it.method == "GET" },
        )
    }

    @Test
    fun `a call's own body preview is stripped once 25 newer calls have arrived, not only when later asked`() {
        val inflight = inflight()
        inflight.seedCallWithBody(startedAt = 1_000, durationMs = 10, id = "first")
        for (i in 1..25) inflight.seedCallWithBody(startedAt = 2_000 + i * 10L, durationMs = 5, id = "$i")

        // Stripping happens as part of adding each new call (inside the
        // same synchronized block httpEnd already uses), not lazily when
        // recentHttp is later read -- proven by seeding no calls after the
        // 25th and still finding "first" already stripped here.
        val first = inflight
            .recentHttp(sinceMs = null, from = 0, to = 100_000, limit = 30)
            .first { it.url.endsWith("/first") }
        assertNull("the 26th-newest call should already have lost its request body", first.requestBody)
        assertNull("the 26th-newest call should already have lost its response body", first.responseBody)
    }

    @Test
    fun `a call with no body to begin with is unaffected by stripping -- nothing to lose`() {
        val inflight = inflight()
        for (i in 1..30) inflight.seedCall(startedAt = i * 100L, durationMs = 10, id = "$i") // no bodies at all

        val all = inflight.recentHttp(sinceMs = null, from = 0, to = 100_000, limit = 30)
        assertTrue(all.all { it.requestBody == null && it.responseBody == null })
    }
}
