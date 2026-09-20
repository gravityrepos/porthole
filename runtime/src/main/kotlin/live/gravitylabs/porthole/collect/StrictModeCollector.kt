// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.os.Build
import android.os.StrictMode
import androidx.annotation.RequiresApi
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.EventKinds
import live.gravitylabs.porthole.store.EventRing
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * `db-on-main-thread` only ever sees Room and SQLDelight going through the
 * support layer. `StrictMode` sees the whole class of the same mistake — disk
 * on main, network on main, a leaked cursor or closeable, unbuffered I/O, a
 * file URI handed to another app — from any source, because the platform
 * itself is the one watching. This turns that watch into events instead of a
 * logcat line and a dialog nobody reads.
 *
 * Opt-in, off by default (EM re-scope of GRA-59): `StrictMode.getThreadPolicy()`
 * and `getVmPolicy()` return opaque objects with no accessors, so there is no
 * public API to detect a policy the app already installed, let alone chain
 * onto it. Installing ours unconditionally would silently discard a debug
 * build's own `penaltyDeath` the first time this module loaded. `install()`
 * therefore only runs when `porthole { strictMode.set(true) }` asked for it —
 * see [Setup]'s `strictmode` entry for how that is disclosed at runtime, in
 * exactly those terms: replaced, not chained.
 *
 * Never installs `penaltyDeath`, on either policy, ever — that is the one
 * penalty this module is not allowed to add to an app's behaviour.
 *
 * The default check set deliberately excludes `detectDiskReads()`: it is the
 * single noisiest check StrictMode has (a `SharedPreferences` read on
 * `Context` creation trips it before an app's own code has run at all), and
 * `db-on-main-thread` already covers the read that actually matters —
 * categorically, with the SQL. Also excluded, post-QA (GRA-59 fixup):
 * `detectUntaggedSockets()`. It fired on the sample's own ordinary startup
 * (an untagged socket from OkHttp's own connection pool, nothing the app
 * code did wrong) and will on essentially every networking app — a standing
 * `note` from launch that names no fix an agent can make, since the fix is
 * `TrafficStats.setThreadStatsTag()` around traffic accounting this project
 * has no opinion about. Also excluded: `detectNonSdkApiUsage()` (explicitly
 * out of scope for this ticket) and anything requiring per-class
 * configuration ([StrictMode.VmPolicy.Builder.setClassInstanceLimit]).
 *
 * The filter, not the listener, is the deliverable here: a violation whose
 * stack names no frame from the app's own package — the platform tripping
 * its own policy during startup, say — is dropped before it is counted or
 * emitted. That rule is what makes "ordinary startup produces no false
 * findings" true by construction rather than by a device-specific denylist
 * (see the ticket's own acceptance criteria for why one was rejected).
 *
 * Counting (GRA-59 fixup): the first violation at a site is reported
 * immediately. Every repeat after that is *counted*, not reported, and a
 * scheduled tick — [flushPending], run every [UPDATE_INTERVAL_MS] by the
 * same single-thread executor the `penaltyListener`s report on — is what
 * puts an updated, exact count on the wire for every site that moved since
 * its own last report; [stop] runs it once more, synchronously, so nothing
 * is left stale when the session ends before the next tick. This used to be
 * a per-violation check instead of a real scheduler (`count == 1 ||
 * elapsed >= UPDATE_INTERVAL_MS` at the moment each violation arrived), which
 * is exactly what QA's repro caught: a site that stops violating gets no
 * more calls into that check at all, so a live session that never calls
 * [stop] would sit on a stale count forever, not just for one interval.
 * A real scheduler ticks regardless of whether anything violates again.
 */
internal class StrictModeCollector(
    private val ring: EventRing,
    /** Package prefixes belonging to the app — see [StackFormat] for the same idea used elsewhere. */
    private val appPackages: List<String> = emptyList(),
    private val now: () -> Long = ::nowMs,
) {

    /**
     * One call site's running total, the count as of its last report (so
     * [flushPending] knows whether there is anything new to say), and the
     * last violation seen there (so a flush has something to describe even
     * when it isn't the violation that triggered it). Also the monitor
     * [onViolation] and [flushPending] serialize updates on.
     */
    private class SiteState {
        var count: Int = 0
        var lastEmittedCount: Int = 0
        var category: String = CATEGORY_OTHER
        var type: String = ""
        var thread: String = ""
        var stack: String = ""
    }

    private val sites = ConcurrentHashMap<String, SiteState>()

    private var executor: ScheduledExecutorService? = null
    private var flushTask: ScheduledFuture<*>? = null
    private var previousThreadPolicy: StrictMode.ThreadPolicy? = null
    private var previousVmPolicy: StrictMode.VmPolicy? = null

    /** True once this instance's [install] actually replaced the process's policies. */
    @Volatile var installed: Boolean = false
        private set

    /**
     * Below API 28, `penaltyListener` does not exist — there is no way to get
     * a `Violation` object instead of a logcat line, and this falls back to
     * doing nothing at all rather than scraping logcat for what StrictMode
     * already prints there. Returns whether it actually installed anything;
     * the caller (`Porthole.install`) uses that to decide what `setup` says.
     *
     * No `Application` parameter: unlike every other collector here,
     * `StrictMode`'s policies are process-global, not tied to a `Context` —
     * there is nothing this needs to look up on one.
     */
    fun install(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
        installPolicies()
        return true
    }

    @RequiresApi(Build.VERSION_CODES.P)
    private fun installPolicies() {
        previousThreadPolicy = StrictMode.getThreadPolicy()
        previousVmPolicy = StrictMode.getVmPolicy()

        // Violations are reported on this executor, never inline on the
        // thread that tripped the check — a listener that itself touches
        // disk or the socket synchronously would be exactly the mistake this
        // collector exists to catch. One thread is enough for both jobs it
        // does — reporting a violation and, periodically, flushing pending
        // counts (below) — violation handling is a map lookup and an
        // occasional ring write, not something that benefits from
        // parallelism, and a single thread keeps every emit in the order
        // things actually happened in, including a flush relative to the
        // violation that triggered it.
        val worker = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "porthole-strictmode").apply { isDaemon = true }
        }
        executor = worker
        flushTask = worker.scheduleWithFixedDelay(
            ::flushPending,
            UPDATE_INTERVAL_MS,
            UPDATE_INTERVAL_MS,
            TimeUnit.MILLISECONDS,
        )

        StrictMode.setThreadPolicy(
            StrictMode.ThreadPolicy.Builder()
                .detectDiskWrites()
                .detectNetwork()
                .detectUnbufferedIo()
                .detectCustomSlowCalls()
                .penaltyListener(worker) { violation -> onViolation(violation, fromThreadPolicy = true) }
                .build(),
        )

        StrictMode.setVmPolicy(
            StrictMode.VmPolicy.Builder()
                .detectLeakedSqlLiteObjects()
                .detectLeakedClosableObjects()
                .detectLeakedRegistrationObjects()
                .detectFileUriExposure()
                .detectContentUriWithoutPermission()
                .detectCleartextNetwork()
                .apply {
                    // API 31+ only; the builder method itself does not exist below that.
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) detectUnsafeIntentLaunch()
                }
                .penaltyListener(worker) { violation -> onViolation(violation, fromThreadPolicy = false) }
                .build(),
        )

        installed = true
    }

    /**
     * Restores whatever policy was in effect before [install] — not a blank
     * policy, which would itself be a behaviour change on shutdown, and not
     * "the platform default", which is not necessarily what [previousThreadPolicy]
     * and [previousVmPolicy] actually held (a debug build's own `Application`
     * may have set something before Porthole ever ran).
     *
     * Flushes first, unconditionally — even when [installed] is false, so a
     * test can drive [onViolation] directly and call this only to force the
     * flush, the same way it already relies on `stop()` tolerating a missing
     * [install]. Cancelling [flushTask] before that final flush, rather than
     * after, closes the one race shutting the executor down otherwise leaves
     * open: a scheduled tick and this synchronous call both reaching
     * [flushPending] for the same site is harmless (the second one finds
     * nothing pending and no-ops), but a tick landing *after* the executor
     * has already been told to shut down is not guaranteed to run at all,
     * which would make this the only flush that actually happens.
     */
    fun stop() {
        flushTask?.cancel(false)
        flushTask = null
        flushPending()
        executor?.shutdown()
        executor = null
        if (installed) {
            previousThreadPolicy?.let { runCatching { StrictMode.setThreadPolicy(it) } }
            previousVmPolicy?.let { runCatching { StrictMode.setVmPolicy(it) } }
        }
        installed = false
        previousThreadPolicy = null
        previousVmPolicy = null
    }

    /**
     * Runs on [executor], never on the thread that tripped the check.
     *
     * Internal rather than private so [StrictModeTest] can hand this a
     * synthetic `Violation` directly — a real one only ever comes from
     * `StrictMode` itself, and manufacturing one that way from a test would
     * mean actually tripping the check on a Robolectric JVM with no real
     * disk/network policy underneath it, which proves nothing about this
     * class's own logic.
     */
    internal fun onViolation(violation: Throwable, fromThreadPolicy: Boolean) {
        val ordered = StackFormat.order(violation.stackTrace.toList(), appPackages)
        // The filter this ticket exists to add: a violation the app's own
        // stack never touches — the platform tripping its own policy before
        // any app code ran, most often — is not counted and not emitted.
        val topAppFrame = ordered.firstOrNull { frame -> appPackages.any { frame.className.startsWith(it) } }
            ?: return

        val site = qualifiedSite(topAppFrame)
        val category = categoryOf(violation, fromThreadPolicy)
        val type = violation.javaClass.simpleName
        val thread = if (fromThreadPolicy) "main" else "other"
        val stack = renderStack(violation, ordered)

        val state = sites.computeIfAbsent(site) { SiteState() }
        val count: Int
        val firstSighting: Boolean
        synchronized(state) {
            state.count += 1
            count = state.count
            // The latest shape of this site's violation, kept even when this
            // particular one isn't the one reported — so the next scheduled
            // flush (or stop()) has something accurate to describe rather
            // than replaying whichever violation happened to be the last one
            // actually put on the wire.
            state.category = category
            state.type = type
            state.thread = thread
            state.stack = stack

            // GRA-59 QA fixup: this used to decide per violation, first via a
            // count-based cap (`count == 1 || count % 50 == 0`) and then via
            // an elapsed-time check at the moment each violation arrived.
            // Both share the same defect: a site that stops violating stops
            // getting calls into this method at all, so a live session that
            // never calls stop() would sit on a stale count forever — QA's
            // repro (six taps, one event, count 1, then silence). Only the
            // first sighting reports itself here now; a real scheduler
            // ([flushPending], ticking on its own in [installPolicies])
            // is what reports every count after that, regardless of whether
            // anything violates again.
            firstSighting = count == 1
            if (firstSighting) state.lastEmittedCount = count
        }
        if (!firstSighting) return

        emit(site, count, category, type, thread, stack)
    }

    /**
     * The exact count for every site that has moved since its last report.
     * Scheduled every [UPDATE_INTERVAL_MS] while installed ([installPolicies]
     * hands this to a `ScheduledExecutorService`), and run once more,
     * synchronously, by [stop] so nothing is left stale when a session ends
     * between ticks. `internal` rather than `private` for exactly one other
     * caller: [StrictModeTest], which calls this directly to simulate a
     * scheduled tick without a real timer — the same reason [onViolation] is
     * internal for a synthetic violation. Safe to call with nothing pending
     * (a no-op) and safe to call more than once.
     */
    internal fun flushPending() {
        sites.forEach { (site, state) ->
            var count = 0
            var category = CATEGORY_OTHER
            var type = ""
            var thread = ""
            var stack = ""
            var shouldEmit = false
            synchronized(state) {
                shouldEmit = state.count != state.lastEmittedCount
                if (shouldEmit) state.lastEmittedCount = state.count
                count = state.count
                category = state.category
                type = state.type
                thread = state.thread
                stack = state.stack
            }
            if (shouldEmit) emit(site, count, category, type, thread, stack)
        }
    }

    private fun emit(site: String, count: Int, category: String, type: String, thread: String, stack: String) {
        ring.emit(
            EventKinds.STRICT_VIOLATION,
            JsonObject(
                mapOf(
                    "category" to JsonPrimitive(category),
                    "type" to JsonPrimitive(type),
                    "thread" to JsonPrimitive(thread),
                    "site" to JsonPrimitive(site),
                    "count" to JsonPrimitive(count),
                    "stack" to JsonPrimitive(stack),
                ),
            ),
            at = now(),
        )
    }

    /**
     * The violation's own message first (redacted the same way every other
     * URL-shaped string in this codebase is — see [Redaction]), then the
     * app-frames-first stack. A few violation types carry real information
     * in their message (`FileUriExposedViolation` names the exposed URI,
     * `CleartextNetworkViolation` names the host); most do not, and this is
     * a no-op for those. Either way it is the same path `ExitInfoCollector`
     * already sends every trace line through, applied here rather than
     * skipped because a stack trace "shouldn't" have anything to redact —
     * that assumption is exactly what a silent redaction regression would
     * hide.
     */
    private fun renderStack(violation: Throwable, ordered: List<StackTraceElement>): String {
        val header = violation.message?.takeIf { it.isNotBlank() }?.let(Redaction::url)
        val body = StackFormat.render(ordered)
        return if (header != null) "$header\n$body" else body
    }

    private fun qualifiedSite(frame: StackTraceElement): String =
        "${frame.className}.${frame.methodName}:${frame.lineNumber}"

    /**
     * `findings`' severity mapping (`trace.ts`) reads this string, not the
     * violation's own class — the wire only ever carries a JSON string, so
     * the category has to be decided once, here, rather than re-derived from
     * a type name on the other side of the socket.
     *
     * Thread-policy violations are main-thread by construction: the policy
     * this collector installs is set from the thread that calls [install]
     * (`Porthole.install()`, always the main thread), and `StrictMode`'s
     * thread policy is per-thread — only the thread that set it is bound by
     * it. A VM-policy violation carries no thread distinction; it is process-wide.
     */
    private fun categoryOf(violation: Throwable, fromThreadPolicy: Boolean): String {
        val name = violation.javaClass.simpleName
        return when {
            fromThreadPolicy && (name == "DiskReadViolation" || name == "DiskWriteViolation") -> CATEGORY_MAIN_THREAD_DISK
            fromThreadPolicy && name == "NetworkViolation" -> CATEGORY_MAIN_THREAD_NETWORK
            name in LEAK_VIOLATION_TYPES -> CATEGORY_LEAK
            else -> CATEGORY_OTHER
        }
    }

    internal companion object {
        /** See [onViolation]'s own comment for what this bounds. */
        const val UPDATE_INTERVAL_MS = 1_000L

        const val CATEGORY_MAIN_THREAD_DISK = "main_thread_disk"
        const val CATEGORY_MAIN_THREAD_NETWORK = "main_thread_network"
        const val CATEGORY_LEAK = "leak"
        const val CATEGORY_OTHER = "other"

        val LEAK_VIOLATION_TYPES = setOf(
            "LeakedClosableViolation",
            "SqliteObjectLeakedViolation",
            "ServiceConnectionLeakedViolation",
            "IntentReceiverLeakedViolation",
            "InstanceCountViolation",
        )
    }
}
