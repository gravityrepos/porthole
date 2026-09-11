// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.store

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ring is what every collector writes into and what a late-attaching client
 * backfills from, and until the clock was substitutable none of it could be
 * tested: it reached for an Android clock that a unit test does not have.
 */
class EventRingTest {

    private var clock = 0L
    private fun ring(capacity: Int = 8) = EventRing(capacity) { clock }

    private fun EventRing.put(name: String) =
        emit(name, JsonObject(mapOf("n" to JsonPrimitive(name))))

    @Test
    fun `stamps an event with the clock it was given`() {
        val ring = ring()
        clock = 1234
        assertEquals(1234, ring.put("a").t)
    }

    @Test
    fun `numbers events from zero, in order`() {
        val ring = ring()
        assertEquals(listOf(0L, 1L, 2L), listOf(ring.put("a"), ring.put("b"), ring.put("c")).map { it.seq })
    }

    @Test
    fun `hands back everything since a sequence number`() {
        val ring = ring()
        repeat(4) { ring.put("e$it") }

        assertEquals(listOf(1L, 2L, 3L), ring.since(1).map { it.seq })
    }

    @Test
    fun `asking from the head gives nothing rather than throwing`() {
        val ring = ring()
        ring.put("a")
        assertEquals(emptyList<Any>(), ring.since(1))
        assertEquals(emptyList<Any>(), ring.since(99))
    }

    @Test
    fun `drops the oldest once it is full`() {
        val ring = ring(capacity = 4)
        repeat(6) { ring.put("e$it") }

        // Six in, room for four: the first two are gone and the ring says so.
        assertEquals(2L, ring.oldestSeq())
        assertEquals(listOf(2L, 3L, 4L, 5L), ring.since(0).map { it.seq })
    }

    @Test
    fun `a request for evicted events returns what survives, not an error`() {
        val ring = ring(capacity = 4)
        repeat(6) { ring.put("e$it") }

        // A client that was away longer than the ring is deep asks for seq 0.
        // Losing the start of the trace is expected; failing the call is not.
        assertEquals(4, ring.since(0).size)
    }

    @Test
    fun `respects a limit`() {
        val ring = ring()
        repeat(5) { ring.put("e$it") }
        assertEquals(2, ring.since(0, limit = 2).size)
    }

    @Test
    fun `selects a window by time, not by sequence`() {
        val ring = ring()
        for (t in listOf(10L, 20L, 30L, 40L)) {
            clock = t
            ring.put("t$t")
        }

        assertEquals(listOf(20L, 30L), ring.between(20, 30).map { it.t })
        assertEquals(listOf(30L, 40L), ring.sinceTime(30).map { it.t })
    }

    @Test
    fun `a time window with nothing in it is empty`() {
        val ring = ring()
        clock = 10
        ring.put("a")
        assertEquals(emptyList<Any>(), ring.between(100, 200))
    }

    @Test
    fun `tells listeners about each event as it lands`() {
        val ring = ring()
        val seen = mutableListOf<String>()
        ring.addListener { seen += it.event }

        ring.put("a")
        ring.put("b")
        assertEquals(listOf("a", "b"), seen)
    }

    @Test
    fun `a listener that throws does not take the emitter down with it`() {
        // The listeners are socket writers. One failing client must not stop
        // the app's own collectors from recording.
        val ring = ring()
        val seen = mutableListOf<String>()
        ring.addListener { error("this client is broken") }
        ring.addListener { seen += it.event }

        ring.put("a")
        assertEquals(listOf("a"), seen)
    }

    @Test
    fun `a removed listener stops hearing`() {
        val ring = ring()
        val seen = mutableListOf<String>()
        val listener: (live.gravitylabs.porthole.protocol.EventFrame) -> Unit = { seen += it.event }

        ring.addListener(listener)
        ring.put("a")
        ring.removeListener(listener)
        ring.put("b")

        assertEquals(listOf("a"), seen)
    }

    @Test
    fun `survives being written to from several threads at once`() {
        // Collectors emit from the main thread, a frame thread, a watchdog and
        // OkHttp's pool, so the sequence has to stay unique under contention.
        val ring = ring(capacity = 4096)
        val threads = (0 until 8).map { worker ->
            Thread { repeat(100) { ring.put("w$worker") } }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }

        val seqs = ring.since(0, limit = 4096).map { it.seq }
        assertEquals(800, seqs.size)
        assertEquals(800, seqs.toSet().size)
        assertTrue(seqs.zipWithNext().all { (a, b) -> a < b })
    }
}
