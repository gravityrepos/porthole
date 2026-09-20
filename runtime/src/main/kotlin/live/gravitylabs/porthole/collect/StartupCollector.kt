// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.EventKinds
import live.gravitylabs.porthole.store.EventRing

/**
 * Where the time went before the first frame.
 *
 * Every other collector attaches after the process is already up. This one
 * measures the part that ran before any of them could: the fork, whatever
 * [Application.onCreate] did, and the gap from there to the first pixel.
 *
 * No app code is required for any of this except [Porthole.reportFullyDrawn] —
 * see that function's own doc comment for why the one Android API that
 * exists for this (`Activity.reportFullyDrawn()`) cannot be observed from
 * outside the app that calls it.
 *
 * Constructed as early in the process as [Porthole.install] itself runs:
 * `PortholeInitializer.create()`, called by androidx.startup from
 * `InitializationProvider.onCreate()`, executes while `ActivityThread` is
 * still installing content providers — which the framework has done before
 * calling `Application.onCreate()` since Ice Cream Sandwich (API 14), well
 * below this module's own `minSdk = 26`. That ordering is what [onCreateEntryAt]
 * relies on: it is not stamped from inside `onCreate()` (nothing here
 * subclasses `Application`), but immediately before it, in the same
 * synchronous call chain, which is close enough that the difference is not
 * something this collector — or anything running on the same thread — could
 * ever observe.
 */
internal class StartupCollector(private val ring: EventRing) {

    /**
     * Stamped at construction, which happens before [Application.onCreate]
     * runs — see the class doc comment. Not literally the entry, but nothing
     * on the main thread runs between this line and that call, so nothing
     * can tell the difference.
     */
    private val onCreateEntryAt: Long = nowMs()

    /**
     * The fork, from `Process.getStartUptimeMillis()` (API 24, this module's
     * `minSdk` is 26): "Return the SystemClock#uptimeMillis() at which this
     * process was started" — the framework's own javadoc, which settles
     * GRA-60's first open question directly: this is the same monotonic
     * clock [nowMs] already reads, not a second one that would need its own
     * offset the way [live.gravitylabs.porthole.ClockOffsets] exists for
     * CLOCK_BOOTTIME. `runCatching` and the sanity check below are for a
     * host that does not really implement it (Robolectric's default shadow
     * returns 0) rather than for a real device, where the contract is exact.
     */
    private val originMs: Long
    private val originAssumed: Boolean

    init {
        val fork = runCatching { Process.getStartUptimeMillis() }.getOrNull()
        if (fork != null && fork in 1..onCreateEntryAt) {
            originMs = fork
            originAssumed = false
        } else {
            // 0, negative, or later than our own entry stamp are all things
            // the real contract cannot produce — only a host that does not
            // implement the call at all. Falling back to onCreateEntryAt
            // keeps `totalMs` a real, if slightly short, duration instead of
            // a nonsense one built from a bad origin.
            originMs = onCreateEntryAt
            originAssumed = true
        }
    }

    @Volatile private var onCreateExitAt: Long? = null
    @Volatile private var activityOnCreateAt: Long? = null
    @Volatile private var activityOnStartAt: Long? = null
    @Volatile private var activityOnResumeAt: Long? = null
    @Volatile private var firstFrameAt: Long? = null
    @Volatile private var reportFullyDrawnAt: Long? = null
    @Volatile private var emitted = false
    private val lock = Any()

    private var lifecycleCallbacks: Application.ActivityLifecycleCallbacks? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val emitTask = Runnable { emit() }

    fun install(app: Application): Boolean {
        // GRA-60 open question 2: `Application.onCreate()` runs synchronously
        // inside ActivityThread's single BIND_APPLICATION message — it is not
        // itself a separate looper message — so nothing else can run on the
        // main thread until that whole dispatch returns. Posting to the
        // front of the queue *now*, before onCreate has even been called,
        // still lands after it: postAtFrontOfQueue splices onto the head of
        // the queue's linked list unconditionally, so it wins regardless of
        // what else arrived (a LAUNCH_ACTIVITY message from a concurrent
        // binder thread, say) while onCreate was running. Failure mode: this
        // reads slightly *later* than the true exit, never earlier — if the
        // framework does further work between onCreate() returning and
        // handleBindApplication's own dispatch finishing, that work is
        // counted too. It can never make onCreate look faster than it was.
        mainHandler.postAtFrontOfQueue { onCreateExitAt = nowMs() }

        val callbacks = object : Application.ActivityLifecycleCallbacks {
            // Only the *first* Activity's timestamps are kept — see the
            // class doc comment on why a later Activity in this same process
            // (a warm or hot re-launch) is out of scope for this collector's
            // live wiring today, even though [StartupAssembly] already knows
            // how to classify one.
            override fun onActivityCreated(activity: Activity, state: Bundle?) {
                synchronized(lock) { if (activityOnCreateAt == null) activityOnCreateAt = nowMs() }
            }

            override fun onActivityStarted(activity: Activity) {
                synchronized(lock) { if (activityOnStartAt == null) activityOnStartAt = nowMs() }
            }

            override fun onActivityResumed(activity: Activity) {
                synchronized(lock) { if (activityOnResumeAt == null) activityOnResumeAt = nowMs() }
            }

            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, out: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        }
        lifecycleCallbacks = callbacks
        app.registerActivityLifecycleCallbacks(callbacks)
        return true
    }

    fun stop(app: Application) {
        lifecycleCallbacks?.let { runCatching { app.unregisterActivityLifecycleCallbacks(it) } }
        lifecycleCallbacks = null
        mainHandler.removeCallbacksAndMessages(null)
    }

    /**
     * [FrameCollector.onFirstDraw]'s hook. Schedules emission [REPORT_FULLY_DRAWN_GRACE_MS]
     * later rather than emitting immediately, so a [onReportFullyDrawn] call
     * that follows close behind the first frame — the common case, once
     * initial data has loaded — lands in the same event instead of being
     * silently too late for it.
     */
    fun onFirstFrame(atMs: Long) {
        synchronized(lock) {
            if (firstFrameAt != null) return
            firstFrameAt = atMs
        }
        mainHandler.postDelayed(emitTask, REPORT_FULLY_DRAWN_GRACE_MS)
    }

    /** [live.gravitylabs.porthole.Porthole.reportFullyDrawn]'s hook. */
    fun onReportFullyDrawn() {
        synchronized(lock) { if (reportFullyDrawnAt == null) reportFullyDrawnAt = nowMs() }
        // Beats the grace window rather than waiting the rest of it out —
        // only meaningful once the first frame has already scheduled emit().
        if (firstFrameAt != null) {
            mainHandler.removeCallbacks(emitTask)
            emit()
        }
    }

    private fun emit() {
        synchronized(lock) {
            if (emitted) return
            emitted = true
        }
        val timestamps = StartupAssembly.Timestamps(
            originMs = originMs,
            originAssumed = originAssumed,
            onCreateEntryMs = onCreateEntryAt,
            onCreateExitMs = onCreateExitAt,
            activityOnCreateMs = activityOnCreateAt,
            activityOnStartMs = activityOnStartAt,
            activityOnResumeMs = activityOnResumeAt,
            firstFrameMs = firstFrameAt,
            reportFullyDrawnMs = reportFullyDrawnAt,
        )
        ring.emit(EventKinds.STARTUP, StartupAssembly.toEvent(timestamps), at = nowMs())
    }

    private companion object {
        /**
         * How long after the first frame this waits for [onReportFullyDrawn]
         * before emitting without it. Below Android vitals' own 1.5s "hot
         * startup" threshold on purpose: waiting longer would let a slow app
         * delay the finding that says it is slow.
         */
        const val REPORT_FULLY_DRAWN_GRACE_MS = 1_200L
    }
}

/**
 * The arithmetic and classification behind the `startup` event, kept apart
 * from [StartupCollector]'s Android wiring so it can be checked with
 * hand-built timestamps and no device — the same split [FrameMath] makes for
 * the frame lane, for the same reason: this has an ordering and a
 * classification rule worth pinning independently of whether the Handler
 * plumbing around it is exercised.
 */
internal object StartupAssembly {

    /**
     * One launch's raw material. Every field but [originMs] is nullable
     * because a real launch may not have all of them — a warm or hot start
     * never gets an `onCreate*` pair, an app that never calls
     * [live.gravitylabs.porthole.Porthole.reportFullyDrawn] never gets
     * [reportFullyDrawnMs] — and that absence is the signal [classify] and
     * the MCP-side `startup-not-fully-drawn` finding both read.
     */
    internal data class Timestamps(
        val originMs: Long,
        /** True when [originMs] is a fallback (see [StartupCollector]'s own doc comment), not the real fork time. */
        val originAssumed: Boolean = false,
        val onCreateEntryMs: Long? = null,
        val onCreateExitMs: Long? = null,
        val activityOnCreateMs: Long? = null,
        val activityOnStartMs: Long? = null,
        val activityOnResumeMs: Long? = null,
        val firstFrameMs: Long? = null,
        val reportFullyDrawnMs: Long? = null,
    )

    /**
     * cold / warm / hot, decided the way Android itself defines them: cold is
     * a process (and therefore `Application.onCreate`) built from scratch;
     * warm is an existing process handed a fresh Activity with no fresh
     * `Application.onCreate`; hot is an existing Activity simply brought back,
     * with no `onCreate` at all. [StartupCollector]'s live wiring only ever
     * produces the first of these today — a process only ever runs
     * `Application.onCreate` once, and with it [StartupCollector]'s own
     * construction — so "warm" and "hot" are reachable only by constructing
     * [Timestamps] directly, which is exactly how [StartupTest] checks them:
     * proven correct ahead of the multi-launch-aware wiring that would be
     * needed to observe one for real, which is left as a follow-up.
     */
    internal fun classify(timestamps: Timestamps): String = when {
        timestamps.onCreateEntryMs != null && timestamps.onCreateExitMs != null -> "cold"
        timestamps.activityOnCreateMs != null -> "warm"
        else -> "hot"
    }

    /** Every phase actually observed, oldest first — the shape [StartupTest]'s ordering assertions read. */
    internal fun phases(timestamps: Timestamps): List<Pair<String, Long>> = buildList {
        add("fork" to timestamps.originMs)
        timestamps.onCreateEntryMs?.let { add("onCreateEntry" to it) }
        timestamps.onCreateExitMs?.let { add("onCreateExit" to it) }
        timestamps.activityOnCreateMs?.let { add("activityOnCreate" to it) }
        timestamps.activityOnStartMs?.let { add("activityOnStart" to it) }
        timestamps.activityOnResumeMs?.let { add("activityOnResume" to it) }
        timestamps.firstFrameMs?.let { add("firstFrame" to it) }
        timestamps.reportFullyDrawnMs?.let { add("reportFullyDrawn" to it) }
    }

    /** Null until the first frame has actually happened — there is no total before then. */
    internal fun totalMs(timestamps: Timestamps): Long? =
        timestamps.firstFrameMs?.let { it - timestamps.originMs }

    /**
     * The name of the two consecutive phases with the widest gap between
     * them — "where to look first," the same job [FrameCollector]'s
     * `worstPhase` does for a single frame. `null` when fewer than two
     * phases were observed, which is not a launch worth attributing at all.
     */
    internal fun dominantPhase(timestamps: Timestamps): String? {
        val observed = phases(timestamps)
        if (observed.size < 2) return null
        var name: String? = null
        var worst = -1L
        for (i in 1 until observed.size) {
            val gap = observed[i].second - observed[i - 1].second
            if (gap > worst) {
                worst = gap
                name = "${observed[i - 1].first}->${observed[i].first}"
            }
        }
        return name
    }

    /** The `startup` event's own `data` payload. */
    internal fun toEvent(timestamps: Timestamps): JsonObject = JsonObject(
        buildMap {
            put("classification", JsonPrimitive(classify(timestamps)))
            put("originMs", JsonPrimitive(timestamps.originMs))
            put("originAssumed", JsonPrimitive(timestamps.originAssumed))
            timestamps.onCreateEntryMs?.let { put("onCreateEntryMs", JsonPrimitive(it)) }
            timestamps.onCreateExitMs?.let { put("onCreateExitMs", JsonPrimitive(it)) }
            timestamps.activityOnCreateMs?.let { put("activityOnCreateMs", JsonPrimitive(it)) }
            timestamps.activityOnStartMs?.let { put("activityOnStartMs", JsonPrimitive(it)) }
            timestamps.activityOnResumeMs?.let { put("activityOnResumeMs", JsonPrimitive(it)) }
            timestamps.firstFrameMs?.let { put("firstFrameMs", JsonPrimitive(it)) }
            timestamps.reportFullyDrawnMs?.let { put("reportFullyDrawnMs", JsonPrimitive(it)) }
            totalMs(timestamps)?.let { put("totalMs", JsonPrimitive(it)) }
            dominantPhase(timestamps)?.let { put("dominantPhase", JsonPrimitive(it)) }
        },
    )
}
