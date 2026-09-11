// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.store

import kotlinx.serialization.json.JsonElement
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.EventFrame
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong

/**
 * Fixed-size ring of recent events. Everything the collectors emit lands here
 * first, then fans out to whoever is connected. A late-attaching client calls
 * `timeline` to backfill from the ring, so you do not lose the interesting part
 * of the trace just because the UI was not open yet.
 */
internal class EventRing(
    private val capacity: Int = DEFAULT_CAPACITY,
    /** Substitutable so the ring can be tested without a device clock. */
    private val now: () -> Long = ::nowMs,
) {

    private val slots = arrayOfNulls<EventFrame>(capacity)
    private val seq = AtomicLong(0)
    private val lock = Any()

    /** Sequence of the oldest event still in the ring. */
    @Volatile
    private var oldest: Long = 0

    private val listeners = CopyOnWriteArrayList<(EventFrame) -> Unit>()

    /**
     * @param at overrides the stamp for events that know when they happened
     *   better than we do. Frame metrics arrive a few milliseconds late, and a
     *   few milliseconds is most of a frame.
     */
    fun emit(event: String, data: JsonElement, at: Long = now()): EventFrame {
        val frame: EventFrame
        synchronized(lock) {
            val n = seq.getAndIncrement()
            frame = EventFrame(event = event, t = at, seq = n, data = data)
            slots[(n % capacity).toInt()] = frame
            if (n >= capacity) oldest = n - capacity + 1
        }
        // Listeners are the socket writers; they must not block the emitter.
        listeners.forEach { runCatching { it(frame) } }
        return frame
    }

    /** Events at or after [sinceSeq], oldest first, capped at [limit]. */
    fun since(sinceSeq: Long, limit: Int = capacity): List<EventFrame> = synchronized(lock) {
        val head = seq.get()
        val from = maxOf(sinceSeq, oldest)
        if (from >= head) return emptyList()
        val out = ArrayList<EventFrame>(minOf(limit, (head - from).toInt()))
        var i = from
        while (i < head && out.size < limit) {
            val slot = slots[(i % capacity).toInt()]
            if (slot != null && slot.seq >= from) out += slot
            i++
        }
        out
    }

    /** Events whose timestamp falls in `[from, to]`, oldest first. */
    fun between(from: Long, to: Long, limit: Int = capacity): List<EventFrame> =
        since(oldest, capacity).filter { it.t in from..to }.takeLast(limit)

    /** Events with a timestamp at or after [uptimeMs]. */
    fun sinceTime(uptimeMs: Long, limit: Int = capacity): List<EventFrame> =
        since(oldest, capacity).filter { it.t >= uptimeMs }.takeLast(limit)

    fun oldestSeq(): Long = oldest

    fun addListener(listener: (EventFrame) -> Unit) {
        listeners += listener
    }

    fun removeListener(listener: (EventFrame) -> Unit) {
        listeners -= listener
    }

    companion object {
        /** ~4k events is a couple of minutes of a busy screen, a few hundred KB. */
        const val DEFAULT_CAPACITY = 4096
    }
}
