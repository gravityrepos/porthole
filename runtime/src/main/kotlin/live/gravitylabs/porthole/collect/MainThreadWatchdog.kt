// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.os.Handler
import android.os.Looper
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.MainThreadStall
import live.gravitylabs.porthole.store.EventRing
import java.util.ArrayDeque

/**
 * Notices when the main thread stops answering, and captures what it is stuck in.
 *
 * The mechanism is a ping: a background thread posts a message to the main
 * looper and times how long it takes to run. Since the message goes to the back
 * of the queue, its latency is exactly how long the main thread was busy with
 * everything ahead of it. When the ping is overdue, the main thread's stack is
 * captured — which is the part that matters, because "blocked for 340ms" is a
 * symptom and `SQLiteConnection.nativeExecuteForCursorWindow` is a cause.
 *
 * The cheaper-looking alternative, `Looper.setMessageLogging`, makes the looper
 * build a log string for every message it dispatches, allocating on the main
 * thread forever to find the rare occasion when it is slow. One ping every
 * [INTERVAL_MS] costs nothing by comparison.
 */
internal class MainThreadWatchdog(
    private val ring: EventRing,
    /** Package prefixes belonging to the app, so its frames can be shown first. */
    private val appPackages: List<String> = emptyList(),
) {

    private val mainHandler = Handler(Looper.getMainLooper())
    private val mainThread = Looper.getMainLooper().thread

    private val stalls = ArrayDeque<MainThreadStall>()
    private val lock = Any()

    @Volatile private var worker: Thread? = null
    @Volatile private var running = false

    fun start() {
        if (running) return
        running = true
        worker = Thread(::loop, "porthole-watchdog").apply {
            isDaemon = true
            start()
        }
    }

    fun stop() {
        running = false
        worker?.interrupt()
        worker = null
    }

    private fun loop() {
        while (running) {
            val postedAt = nowMs()
            val answered = booleanArrayOf(false)
            mainHandler.post { answered[0] = true }

            var stack: String? = null
            var waited = 0L

            while (running && !answered[0]) {
                try {
                    Thread.sleep(POLL_MS)
                } catch (_: InterruptedException) {
                    return
                }
                waited = nowMs() - postedAt
                // Sampled once, at the moment it becomes a stall. Sampling
                // repeatedly would mostly re-capture the same frames, and
                // Thread.getStackTrace on a running thread is not free.
                if (waited >= STALL_MS && stack == null) stack = captureMainStack()
            }

            if (stack != null) record(postedAt, waited, stack)

            val remaining = INTERVAL_MS - (nowMs() - postedAt)
            if (remaining > 0) {
                try {
                    Thread.sleep(remaining)
                } catch (_: InterruptedException) {
                    return
                }
            }
        }
    }

    private fun record(startedAt: Long, durationMs: Long, stack: String) {
        val stall = MainThreadStall(at = startedAt, durationMs = durationMs, stack = stack)
        synchronized(lock) {
            stalls.addLast(stall)
            while (stalls.size > CAPACITY) stalls.removeFirst()
        }
        ring.emit(
            "blocked",
            JsonObject(
                mapOf(
                    "durationMs" to JsonPrimitive(durationMs),
                    "top" to JsonPrimitive(stack.lineSequence().firstOrNull().orEmpty()),
                    "stack" to JsonPrimitive(stack),
                ),
            ),
            at = startedAt,
        )

        // A marker rather than a span: the stall is detected after the fact, so
        // there is no moment to have opened a slice at. It lands where the
        // watchdog noticed, which is the end of the stall, and carries the
        // duration so the start can be read off it.
        Atrace.event("stalled ${durationMs}ms — " + stack.lineSequence().firstOrNull().orEmpty())
    }

    /**
     * The app's own frames first, because the interesting line is almost never
     * the top one: the top is a native read or a lock, and the line you can
     * change is a few frames down.
     */
    private fun captureMainStack(): String = runCatching {
        val frames = mainThread.stackTrace
        if (frames.isEmpty()) return "(no stack available)"
        StackFormat.render(StackFormat.order(frames.toList(), appPackages))
    }.getOrDefault("(stack capture failed)")

    fun report(sinceMs: Long?, from: Long?, to: Long?, limit: Int): List<MainThreadStall> {
        val now = nowMs()
        val start = from ?: sinceMs?.let { now - it }
        val end = to ?: now
        return synchronized(lock) {
            stalls.filter { (start == null || it.at >= start) && it.at <= end }
        }.sortedByDescending { it.durationMs }.take(limit)
    }

    fun reset() {
        synchronized(lock) { stalls.clear() }
    }

    private companion object {
        /** One ping per this long. Cheap enough to leave on for a whole session. */
        const val INTERVAL_MS = 300L

        /** How often the waiter wakes to check. Bounds the error on durationMs. */
        const val POLL_MS = 20L

        /**
         * Past this, the main thread has eaten several frames and the user can
         * feel it. Below it, the frame collector is the better instrument.
         */
        const val STALL_MS = 100L

        const val CAPACITY = 120
    }
}
