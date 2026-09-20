// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.app.Application
import android.os.Build
import android.os.StrictMode
import androidx.annotation.RequiresApi
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.EventKinds
import live.gravitylabs.porthole.store.EventRing
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * `db-on-main-thread` only ever sees Room and SQLDelight going through the
 * support layer. `StrictMode` sees the whole class of the same mistake — disk
 * on main, network on main, a leaked cursor or closeable, unbuffered I/O, an
 * untagged socket, a file URI handed to another app — from any source,
 * because the platform itself is the one watching. This turns that watch
 * into events instead of a logcat line and a dialog nobody reads.
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
 * categorically, with the SQL. Also excluded: `detectNonSdkApiUsage()`
 * (explicitly out of scope for this ticket) and anything requiring
 * per-class configuration ([StrictMode.VmPolicy.Builder.setClassInstanceLimit]).
 *
 * The filter, not the listener, is the deliverable here: a violation whose
 * stack names no frame from the app's own package — the platform tripping
 * its own policy during startup, say — is dropped before it is counted or
 * emitted. That rule is what makes "ordinary startup produces no false
 * findings" true by construction rather than by a device-specific denylist
 * (see the ticket's own acceptance criteria for why one was rejected).
 */
internal class StrictModeCollector(
    private val ring: EventRing,
    /** Package prefixes belonging to the app — see [StackFormat] for the same idea used elsewhere. */
    private val appPackages: List<String> = emptyList(),
    private val now: () -> Long = ::nowMs,
) {

    /** One call site's running total. Also the monitor [onViolation] serializes updates on. */
    private class SiteState {
        var count: Int = 0
    }

    private val sites = ConcurrentHashMap<String, SiteState>()

    private var executor: ExecutorService? = null
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
     */
    fun install(app: Application): Boolean {
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
        // collector exists to catch. One thread is enough: violation
        // handling is a map lookup and an occasional ring write, not
        // something that benefits from parallelism, and a single thread
        // keeps the emitted order matching the order violations actually
        // happened in.
        val worker = Executors.newSingleThreadExecutor { r ->
            Thread(r, "porthole-strictmode").apply { isDaemon = true }
        }
        executor = worker

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
                .detectUntaggedSockets()
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
     */
    fun stop() {
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
        val state = sites.computeIfAbsent(site) { SiteState() }

        val count: Int
        val shouldEmit: Boolean
        synchronized(state) {
            state.count += 1
            count = state.count
            // Emitted on the first sighting of a site, and again only every
            // UPDATE_EVERY occurrences after that — a scrolling list doing a
            // disk read per row would otherwise flood the ring with one event
            // per violation. 200 violations at one site therefore produce 5
            // ring events (1, 50, 100, 150, 200), each carrying the running
            // total, not 200 — and findingsOf() in trace.ts collapses same-site
            // events to the latest one regardless, so this is one finding
            // either way. A count-based cap rather than a wall-clock interval:
            // it needs no injected clock to test deterministically, and its
            // bound (ring events per site) is exactly the number this ticket's
            // acceptance criterion asks about.
            shouldEmit = count == 1 || count % UPDATE_EVERY == 0
        }
        if (!shouldEmit) return

        ring.emit(
            EventKinds.STRICT_VIOLATION,
            JsonObject(
                mapOf(
                    "category" to JsonPrimitive(categoryOf(violation, fromThreadPolicy)),
                    "type" to JsonPrimitive(violation.javaClass.simpleName),
                    "thread" to JsonPrimitive(if (fromThreadPolicy) "main" else "other"),
                    "site" to JsonPrimitive(site),
                    "count" to JsonPrimitive(count),
                    "stack" to JsonPrimitive(renderStack(violation, ordered)),
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
        /** See [onViolation]'s own comment for the arithmetic this bounds. */
        const val UPDATE_EVERY = 50

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
