// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.view.FrameMetrics
// Aliased because this package now has a `Window` of its own — the resolver
// that says what a time window means. The platform's Window is the one an
// Activity draws into; they are unrelated and should not read as if they were.
import android.view.Window as AndroidWindow
import androidx.annotation.RequiresApi
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.FrameReport
import live.gravitylabs.porthole.protocol.JankyFrame
import live.gravitylabs.porthole.store.EventRing
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicLong

/**
 * Records how long each frame actually took, and where the time went.
 *
 * This is the outcome every other collector is a proxy for. A recomposition
 * count is only interesting because of what it does to frame time, and until
 * now the tool measured the cause and left you to infer the effect.
 *
 * Uses [AndroidWindow.addOnFrameMetricsAvailableListener], which reports on
 * frames the system actually drew. The obvious alternative — reposting a Choreographer
 * frame callback — requests a vsync on every frame, so an idle app never idles
 * and the measurement changes the thing being measured.
 *
 * Needs no instrumentation from the developer: it attaches to each Activity's
 * window as it starts.
 */
internal class FrameCollector(private val ring: EventRing) {

    private val recent = ArrayDeque<JankyFrame>()
    private val lock = Any()

    private val total = AtomicLong(0)
    private val janky = AtomicLong(0)
    private val dropped = AtomicLong(0)

    @Volatile private var thread: HandlerThread? = null
    @Volatile private var handler: Handler? = null
    @Volatile private var frameIntervalNanos: Long = DEFAULT_INTERVAL_NANOS

    fun install(app: Application): Boolean {
        val worker = HandlerThread("porthole-frames").apply { start() }
        thread = worker
        handler = Handler(worker.looper)

        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) = attach(activity)
            override fun onActivityStopped(activity: Activity) = detach(activity)
            override fun onActivityCreated(activity: Activity, bundle: Bundle?) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, bundle: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
        return true
    }

    fun stop() {
        thread?.quitSafely()
        thread = null
        handler = null
    }

    @RequiresApi(Build.VERSION_CODES.N)
    private fun attach(activity: Activity) {
        val worker = handler ?: return
        refreshInterval(activity)
        runCatching { activity.window.addOnFrameMetricsAvailableListener(listener, worker) }
    }

    @RequiresApi(Build.VERSION_CODES.N)
    private fun detach(activity: Activity) {
        runCatching { activity.window.removeOnFrameMetricsAvailableListener(listener) }
    }

    @Suppress("DEPRECATION")
    private fun refreshInterval(activity: Activity) {
        val hz = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                activity.display?.refreshRate
            } else {
                activity.windowManager.defaultDisplay.refreshRate
            }
        }.getOrNull() ?: return
        frameIntervalNanos = FrameMath.intervalNanos(hz, frameIntervalNanos)
    }

    @RequiresApi(Build.VERSION_CODES.N)
    private val listener = AndroidWindow.OnFrameMetricsAvailableListener { _, metrics, droppedSoFar ->
        // The FrameMetrics instance is recycled after this returns, so every
        // value has to be read now rather than held on to.
        val totalNanos = metrics.getMetric(FrameMetrics.TOTAL_DURATION)
        if (totalNanos <= 0) return@OnFrameMetricsAvailableListener

        total.incrementAndGet()
        if (droppedSoFar > 0) dropped.addAndGet(droppedSoFar.toLong())

        // Two different questions, and they need two different numbers. Whether
        // a frame was late is judged against its own deadline, which the system
        // may relax. How much of the display it cost is always measured in
        // refreshes — dividing by a relaxed deadline reports a 400ms freeze as
        // one missed frame.
        val deadline = deadlineNanos(metrics)
        if (totalNanos <= deadline) return@OnFrameMetricsAvailableListener

        val missed = FrameMath.missedFrames(totalNanos, frameIntervalNanos)
        janky.incrementAndGet()

        val frame = JankyFrame(
            at = vsyncUptimeMs(metrics),
            totalMs = totalNanos.toMillis(),
            missedFrames = missed,
            // Which phase dominated is the whole point: "41ms, 30 of it in
            // layout" and "41ms, 30 of it waiting on the GPU" are different bugs.
            worstPhase = worstPhase(metrics),
            phases = phaseBreakdown(metrics),
            firstDraw = metrics.getMetric(FrameMetrics.FIRST_DRAW_FRAME) == 1L,
        )

        synchronized(lock) {
            recent.addLast(frame)
            while (recent.size > RECENT_CAPACITY) recent.removeFirst()
        }

        ring.emit(
            "frame",
            JsonObject(
                mapOf(
                    "totalMs" to JsonPrimitive(frame.totalMs),
                    "missedFrames" to JsonPrimitive(frame.missedFrames),
                    "worstPhase" to JsonPrimitive(frame.worstPhase),
                    "firstDraw" to JsonPrimitive(frame.firstDraw),
                ),
            ),
            at = frame.at,
        )
    }

    @RequiresApi(Build.VERSION_CODES.N)
    private fun deadlineNanos(metrics: FrameMetrics): Long {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val deadline = runCatching { metrics.getMetric(FrameMetrics.DEADLINE) }.getOrDefault(0L)
            if (deadline > 0) return deadline
        }
        return frameIntervalNanos
    }

    /**
     * FrameMetrics timestamps share System.nanoTime's monotonic base, which is
     * the same clock uptimeMillis counts in, so this lines up with every other
     * event on the timeline.
     */
    @RequiresApi(Build.VERSION_CODES.N)
    private fun vsyncUptimeMs(metrics: FrameMetrics): Long = runCatching {
        val vsync = metrics.getMetric(FrameMetrics.VSYNC_TIMESTAMP)
        if (vsync > 0) vsync / 1_000_000L else nowMs()
    }.getOrDefault(nowMs())

    @RequiresApi(Build.VERSION_CODES.N)
    private fun phaseBreakdown(metrics: FrameMetrics): Map<String, Long> {
        val out = LinkedHashMap<String, Long>()
        for ((name, id) in PHASES) {
            val nanos = runCatching { metrics.getMetric(id) }.getOrDefault(0L)
            if (nanos > 0) out[name] = nanos.toMillis()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val gpu = runCatching { metrics.getMetric(FrameMetrics.GPU_DURATION) }.getOrDefault(0L)
            if (gpu > 0) out["gpu"] = gpu.toMillis()
        }
        return out
    }

    @RequiresApi(Build.VERSION_CODES.N)
    private fun worstPhase(metrics: FrameMetrics): String {
        var name = "unknown"
        var worst = 0L
        for ((phase, id) in PHASES) {
            val nanos = runCatching { metrics.getMetric(id) }.getOrDefault(0L)
            if (nanos > worst) {
                worst = nanos
                name = phase
            }
        }
        return name
    }

    /** See [Window.resolve] for what the three window arguments mean. */
    fun report(sinceMs: Long?, from: Long?, to: Long?, limit: Int): FrameReport =
        report(Window.resolve(sinceMs, from, to, nowMs()), limit)

    fun report(window: LongRange, limit: Int): FrameReport {
        // A frame is stamped at its vsync, which is when it was, so membership
        // is the plain one: was this frame drawn inside the window.
        val inWindow = synchronized(lock) { recent.filter { it.at in window } }

        val notes = buildList {
            if (total.get() == 0L) {
                add("No frames observed yet. The listener attaches when an Activity starts.")
            }
            add(
                "A frame counts as janky when it overran the display's deadline. missedFrames is " +
                    "how many refreshes it ate, so 1 is a single dropped frame.",
            )
        }

        return FrameReport(
            totalFrames = total.get(),
            jankyFrames = janky.get(),
            droppedBySystem = dropped.get(),
            frameIntervalMs = frameIntervalNanos.toMillis(),
            worst = inWindow.sortedByDescending { it.totalMs }.take(limit),
            notes = notes,
        )
    }

    fun reset() {
        synchronized(lock) { recent.clear() }
        total.set(0)
        janky.set(0)
        dropped.set(0)
    }

    private fun Long.toMillis(): Long = this / 1_000_000L

    companion object {
        /** 60Hz, until a real display tells us otherwise. */
        private const val DEFAULT_INTERVAL_NANOS = 16_666_666L
        private const val RECENT_CAPACITY = 300

        @RequiresApi(Build.VERSION_CODES.N)
        private val PHASES: List<Pair<String, Int>> = listOf(
            "unknownDelay" to FrameMetrics.UNKNOWN_DELAY_DURATION,
            "input" to FrameMetrics.INPUT_HANDLING_DURATION,
            "animation" to FrameMetrics.ANIMATION_DURATION,
            "layoutMeasure" to FrameMetrics.LAYOUT_MEASURE_DURATION,
            "draw" to FrameMetrics.DRAW_DURATION,
            "sync" to FrameMetrics.SYNC_DURATION,
            "commandIssue" to FrameMetrics.COMMAND_ISSUE_DURATION,
            "swapBuffers" to FrameMetrics.SWAP_BUFFERS_DURATION,
        )
    }
}
