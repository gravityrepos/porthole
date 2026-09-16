// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.os.Handler
import android.os.Looper
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.EventKinds
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
    /**
     * The line between a hitch and a stall, in milliseconds.
     *
     * Held here rather than reached for as a constant at the point of use,
     * because the number is also *reported*: `blocking` carries it as
     * `stallThresholdMs`, and that field is what tells an agent what "nothing
     * blocked the main thread in this window" actually means. It used to be
     * written out twice — once here and once as a literal in the report — so
     * changing the watchdog left the report quietly lying about it.
     */
    val stallThresholdMs: Long = STALL_MS,
    /** Substitutable for the same reason the event ring's clock is. */
    private val now: () -> Long = ::nowMs,
) {

    // Lazy so that constructing a watchdog does not need a main looper. Nothing
    // here is touched until start() runs, and deferring them is what lets the
    // reporting side be exercised off a device.
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }
    private val mainThread by lazy { Looper.getMainLooper().thread }

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

    /** Identity of the open stall slice, matched at both ends. */
    private var stallCookie = 0

    private fun loop() {
        while (running) {
            val postedAt = now()
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
                waited = now() - postedAt
                // Sampled once, at the moment it becomes a stall. Sampling
                // repeatedly would mostly re-capture the same frames, and
                // Thread.getStackTrace on a running thread is not free.
                if (waited >= stallThresholdMs && stack == null) {
                    stack = captureMainStack()
                    // Opened at detection rather than at the start of the stall,
                    // which has already passed and cannot be drawn. The slice
                    // therefore covers detection to recovery — a true subset of
                    // the stall, and visible, which an instant at the end would
                    // not have been.
                    stallCookie = Atrace.nextCookie()
                    Atrace.begin(STALL_SLICE, stallCookie)
                }
            }

            if (stack != null) {
                Atrace.end(STALL_SLICE, stallCookie)
                record(postedAt, waited, stack)
            }

            val remaining = INTERVAL_MS - (now() - postedAt)
            if (remaining > 0) {
                try {
                    Thread.sleep(remaining)
                } catch (_: InterruptedException) {
                    return
                }
            }
        }
    }

    internal fun record(startedAt: Long, durationMs: Long, stack: String) {
        val stall = MainThreadStall(at = startedAt, durationMs = durationMs, stack = stack)
        synchronized(lock) {
            stalls.addLast(stall)
            while (stalls.size > CAPACITY) stalls.removeFirst()
        }
        ring.emit(
            EventKinds.BLOCKED,
            JsonObject(
                mapOf(
                    "durationMs" to JsonPrimitive(durationMs),
                    "top" to JsonPrimitive(stack.lineSequence().firstOrNull().orEmpty()),
                    "stack" to JsonPrimitive(stack),
                ),
            ),
            at = startedAt,
        )

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

    /** See [Window.resolve] for what the three window arguments mean. */
    fun report(sinceMs: Long?, from: Long?, to: Long?, limit: Int): List<MainThreadStall> =
        report(Window.resolve(sinceMs, from, to, now()), limit)

    /**
     * A stall is a span, not an instant, so it is matched by overlap: one that
     * began just before the window and was still holding the main thread inside
     * it is the whole reason the window was drawn there. `at` is when the ping
     * was posted and `durationMs` how long it went unanswered, so the span runs
     * from one to the other. Every stall recorded here has ended by definition —
     * it is only recorded once the main thread answers.
     */
    fun report(window: LongRange, limit: Int): List<MainThreadStall> =
        synchronized(lock) {
            stalls.filter { Window.overlaps(window, it.at, it.at + it.durationMs) }
        }.sortedByDescending { it.durationMs }.take(limit)

    fun reset() {
        synchronized(lock) { stalls.clear() }
    }

    internal companion object {
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

        /** One name for every stall slice; its width carries the duration. */
        const val STALL_SLICE = "main thread stalled"
    }
}
