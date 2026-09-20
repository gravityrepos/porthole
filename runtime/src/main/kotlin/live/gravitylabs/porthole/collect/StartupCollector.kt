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
import live.gravitylabs.porthole.integration.ComponentActivityPorthole
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.EventKinds
import live.gravitylabs.porthole.store.EventRing

/**
 * Where the time went before the first frame — and again, for every launch
 * after the first one this process sees.
 *
 * Every other collector attaches after the process is already up. This one
 * measures the part that ran before any of them could: the fork, whatever
 * [Application.onCreate] did, and the gap from there to the first pixel. A
 * process only forks once, so only the *first* `startup` event carries that
 * and an `Application.onCreate` phase — every launch after it, while the
 * process stays alive, gets its own `startup` event too, classified warm (a
 * fresh Activity, no fresh `onCreate`) or hot (the same Activity, just
 * brought back), keyed off the activity lifecycle callbacks already
 * registered below rather than anything only a fresh process has.
 *
 * No app code is required for any of this except a fallback: androidx.activity
 * 1.7's `ComponentActivity.fullyDrawnReporter` makes `Activity.reportFullyDrawn()`
 * observable for free — every Compose app already extends `ComponentActivity`
 * — and [live.gravitylabs.porthole.Porthole.reportFullyDrawn] exists only for
 * the app that does not. See [ComponentActivityPorthole]'s own doc comment.
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

    /**
     * Started, not yet stopped — [DeviceCollector]'s own `started` counter,
     * duplicated rather than shared, for the same reason [ShutdownTest]'s
     * doc comment gives for keeping `LogCollectorTest`'s stub local to each
     * ticket: this collector should not have to change because that one's
     * counting rule does. A 0-to-1 transition, once the first (cold)
     * `startup` event has already been emitted, is a new launch — the app
     * had nothing running in the foreground and now does.
     */
    @Volatile private var startedCount = 0

    /** Set only between a detected 0-to-1 transition and the frame that ends it — see [startPendingLaunch]. */
    @Volatile private var pendingLaunch: PendingLaunch? = null

    private val lock = Any()

    private var lifecycleCallbacks: Application.ActivityLifecycleCallbacks? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val emitTask = Runnable { emit() }

    /**
     * [FrameCollector.armNextFrame]'s counterpart, set by
     * [live.gravitylabs.porthole.Porthole.install] once both collectors
     * exist — the same shape [FrameCollector.onFirstDraw] already uses to
     * reach this class, the other direction. A post-cold (warm/hot) launch
     * has no first-draw frame of its own to key off: that flag is spent,
     * once, by the process's very first window, so this arms a plain
     * one-shot "whatever frame comes next" hook instead, the moment a
     * pending launch is detected.
     */
    var armNextFrame: ((callback: (atMs: Long) -> Unit) -> Unit)? = null

    /** Cached: `Class.forName` is not free, and every Activity's `onCreate` asks. */
    @Volatile private var componentActivityPresent: Boolean? = null

    /** One in-flight warm/hot launch's raw material, mutated in place until its ending frame arrives. */
    private class PendingLaunch(val originMs: Long) {
        var onCreateMs: Long? = null
        var onStartMs: Long? = null
        var onResumeMs: Long? = null
        /** QA 60-B: recorded here too, not only on the cold launch's own [reportFullyDrawnAt] — see [onReportFullyDrawn]. */
        var reportFullyDrawnMs: Long? = null
    }

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
            override fun onActivityCreated(activity: Activity, state: Bundle?) {
                val now = nowMs()
                synchronized(lock) {
                    if (activityOnCreateAt == null) {
                        // The process's first Activity ever — part of the
                        // cold launch already being assembled in [emit].
                        activityOnCreateAt = now
                    } else if (emitted && startedCount == 0 && pendingLaunch == null) {
                        // A fresh Activity instance, with nothing else
                        // running: the process survived, but this specific
                        // screen did not — warm, once its onStart/onResume
                        // arrive with no onCreate of their own is what would
                        // instead mark it hot (see onActivityStarted).
                        startPendingLaunch(onCreateMs = now)
                    }
                }
                attachFullyDrawnReporter(activity)
            }

            override fun onActivityStarted(activity: Activity) {
                val now = nowMs()
                synchronized(lock) {
                    if (activityOnStartAt == null) activityOnStartAt = now
                    val wasEmpty = startedCount == 0
                    startedCount += 1
                    if (!emitted || !wasEmpty) return@synchronized
                    // The 0-to-1 transition this class exists to catch. If
                    // onActivityCreated already opened a pendingLaunch (the
                    // warm case) this only fills in its onStartMs; if not —
                    // the same Activity instance was merely restarted, never
                    // recreated — this *is* the first callback of the
                    // transition, and the launch is hot.
                    val launch = pendingLaunch
                    if (launch == null) {
                        startPendingLaunch(onStartMs = now)
                    } else if (launch.onStartMs == null) {
                        launch.onStartMs = now
                    }
                }
            }

            override fun onActivityResumed(activity: Activity) {
                val now = nowMs()
                synchronized(lock) {
                    if (activityOnResumeAt == null) activityOnResumeAt = now
                    pendingLaunch?.let { if (it.onResumeMs == null) it.onResumeMs = now }
                }
            }

            override fun onActivityStopped(activity: Activity) {
                synchronized(lock) { startedCount = (startedCount - 1).coerceAtLeast(0) }
            }

            override fun onActivityPaused(activity: Activity) = Unit
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
        synchronized(lock) {
            startedCount = 0
            pendingLaunch = null
        }
    }

    /**
     * Opens [pendingLaunch] and arms the ending frame in the same breath —
     * must be called with [lock] already held, since every caller above
     * already holds it while deciding this is a new launch at all.
     */
    private fun startPendingLaunch(onCreateMs: Long? = null, onStartMs: Long? = null) {
        val origin = onCreateMs ?: onStartMs ?: nowMs()
        val launch = PendingLaunch(originMs = origin).apply {
            this.onCreateMs = onCreateMs
            this.onStartMs = onStartMs
        }
        pendingLaunch = launch
        armNextFrame?.invoke { atMs -> onPendingLaunchFrame(launch, atMs) }
    }

    /**
     * [FrameCollector.armNextFrame]'s callback — a frame arrived after
     * [startPendingLaunch] armed it, ending exactly one pending launch.
     * Compares by identity against the current [pendingLaunch] rather than
     * assuming it: nothing today can re-arm a second launch before the first
     * one's frame arrives (there is nowhere in the app for a second 0-to-1
     * transition to come from before this one closes), but a callback firing
     * for a launch this class has already moved on from is a stale signal
     * either way, not a real one.
     */
    private fun onPendingLaunchFrame(launch: PendingLaunch, atMs: Long) {
        val reportFullyDrawnMs: Long?
        synchronized(lock) {
            if (pendingLaunch !== launch) return
            pendingLaunch = null
            reportFullyDrawnMs = launch.reportFullyDrawnMs
        }
        val timestamps = StartupAssembly.Timestamps(
            originMs = launch.originMs,
            // QA 60-C: `originAssumed`'s own contract (see [StartupAssembly.Timestamps]'s
            // doc comment) is "not the real fork time" — which a pending
            // launch's origin never is, by construction (there is no fork
            // for a warm or hot relaunch). `false` here was dishonest by
            // that same contract, not merely inconsistent with it.
            originAssumed = true,
            originKind = StartupAssembly.OriginKind.ACTIVITY,
            activityOnCreateMs = launch.onCreateMs,
            activityOnStartMs = launch.onStartMs,
            activityOnResumeMs = launch.onResumeMs,
            firstFrameMs = atMs,
            reportFullyDrawnMs = reportFullyDrawnMs,
        )
        ring.emit(EventKinds.STARTUP, StartupAssembly.toEvent(timestamps), at = nowMs())
    }

    /**
     * androidx.activity's own signal for `Activity.reportFullyDrawn()` — see
     * [ComponentActivityPorthole]'s doc comment. Guarded by a presence check
     * the same way [live.gravitylabs.porthole.Porthole]'s own optional
     * integrations are: touching [ComponentActivityPorthole] at all before
     * confirming `androidx.activity.ComponentActivity` is on the classpath
     * would throw in an app that never depended on it.
     *
     * Attached for every Activity, not only the process's first: the field
     * this feeds ([reportFullyDrawnAt]) belongs to the cold launch only
     * today (see [onReportFullyDrawn]'s own doc comment), so a later
     * Activity's callback is presently a harmless no-op once [emitted] is
     * already true — attaching unconditionally is what a later, per-launch
     * reportFullyDrawn (not part of this ticket) would need already in place.
     */
    private fun attachFullyDrawnReporter(activity: Activity) {
        val present = componentActivityPresent
            ?: classPresent("androidx.activity.ComponentActivity").also { componentActivityPresent = it }
        if (!present) return
        runCatching { ComponentActivityPorthole.attach(activity) { onReportFullyDrawn() } }
    }

    private fun classPresent(name: String): Boolean =
        runCatching { Class.forName(name, false, javaClass.classLoader) }.isSuccess

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

    /**
     * Fed from two places: [attachFullyDrawnReporter]'s own automatic
     * `ComponentActivity` hook — every Compose app, no app code — and
     * [live.gravitylabs.porthole.Porthole.reportFullyDrawn], the documented
     * fallback for an Activity that is not one. Whichever gets here first
     * wins; both are the same fact observed two different ways.
     */
    fun onReportFullyDrawn() {
        synchronized(lock) {
            if (reportFullyDrawnAt == null) reportFullyDrawnAt = nowMs()
            // QA 60-B: a later Activity's own reportFullyDrawn() call — see
            // [attachFullyDrawnReporter]'s doc comment on why this is wired
            // to every Activity, not only the process's first — used to land
            // nowhere once the cold event had already emitted, so a warm/hot
            // launch that genuinely did report was indistinguishable from
            // one that never did. `pendingLaunch` is non-null only while a
            // warm/hot launch is still in flight, so this can never
            // misattribute a report to the wrong one of the two.
            pendingLaunch?.let { if (it.reportFullyDrawnMs == null) it.reportFullyDrawnMs = nowMs() }
        }
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
            originKind = StartupAssembly.OriginKind.FORK,
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
     * QA 60-C: what kind of instant [Timestamps.originMs] actually is —
     * carried on the wire (`toEvent`'s `originKind`) because the MCP side
     * needs it to decide which launches a vitals-shaped threshold can
     * honestly be applied to at all, not only whether the number looks big.
     */
    internal object OriginKind {
        /** The process fork — the one cold launch gets this. */
        const val FORK = "fork"
        /** The relaunched Activity's own first lifecycle callback — every warm/hot launch. */
        const val ACTIVITY = "activity"
    }

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
        /**
         * True when [originMs] cannot be read as the precise instant its own
         * [originKind] promises: for [OriginKind.FORK], only the Robolectric
         * fallback case (see [StartupCollector]'s own doc comment); for
         * [OriginKind.ACTIVITY], always — a lifecycle-callback timestamp is a
         * real measurement of its own moment, but it is never the launch
         * request the system (and `am start -W`) time from, which is what
         * this flag is about, not whether the reading itself is trustworthy.
         */
        val originAssumed: Boolean = false,
        val originKind: String = OriginKind.FORK,
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
     * with no `onCreate` at all. [StartupCollector]'s live wiring produces
     * all three: cold from the process's own fork and first Activity, warm
     * and hot from the 0-to-1 started-activity transition
     * `startPendingLaunch` detects after the cold event has already been
     * emitted. A subsequent [Timestamps] never carries `onCreateEntryMs`/
     * `onCreateExitMs` — those belong only to the one process-wide
     * `Application.onCreate` — which is what keeps this classifier from ever
     * calling a second launch cold, structurally rather than by convention.
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
            put("originKind", JsonPrimitive(timestamps.originKind))
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
