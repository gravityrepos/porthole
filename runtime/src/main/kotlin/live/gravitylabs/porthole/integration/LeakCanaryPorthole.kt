// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.integration

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import leakcanary.LeakCanary
import leakcanary.OnHeapAnalyzedListener
import live.gravitylabs.porthole.clockOffsets
import live.gravitylabs.porthole.collect.Redaction
import live.gravitylabs.porthole.collect.Setup
import live.gravitylabs.porthole.protocol.EventKinds
import live.gravitylabs.porthole.store.EventRing
import shark.HeapAnalysis
import shark.HeapAnalysisSuccess
import shark.Leak

/**
 * LeakCanary's own answer, delivered where the agent is already looking
 * (GRA-64).
 *
 * LeakCanary already finds the leak and already writes the trace; this does
 * not reimplement any of that. What it adds is getting the result onto
 * Porthole's timeline instead of only into LeakCanary's own notification and
 * on-device UI, which an agent reading a capture never sees.
 *
 * `compileOnly`, the same pattern [OkHttpPorthole] uses: this module never
 * ships LeakCanary, an app opts in with its own `debugImplementation`, and
 * [install] probes the classpath before touching a single LeakCanary type —
 * touching [leakcanary.LeakCanary] itself (even just to read a field) before
 * that probe passes would throw `NoClassDefFoundError` in an app that never
 * added the dependency, the same risk [WorkManagerPorthole]'s own doc
 * comment describes for why that class is a nullable, presence-gated field
 * on [live.gravitylabs.porthole.Porthole]'s session rather than something
 * touched unconditionally.
 *
 * No app code is required beyond the dependency: LeakCanary installs its own
 * `ContentProvider` and starts watching automatically, the same
 * zero-configuration shape [live.gravitylabs.porthole.collect.StartupCollector]
 * relies on for `ComponentActivity.fullyDrawnReporter`. This hooks the one
 * seam LeakCanary offers for "a heap was analyzed":
 * `LeakCanary.config.onHeapAnalyzedListener`.
 */
// LeakCanary 2.14 deprecated OnHeapAnalyzedListener in favour of a list of
// EventListeners, but the ticket this file implements named this exact seam
// (LeakCanary.config.copy(onHeapAnalyzedListener = ...)) as the one to hook,
// and the floor version this module compiles against still honours it —
// suppressed rather than migrated, since following the newer API would be a
// second, unrequested behaviour change riding along with this one.
@Suppress("DEPRECATION")
internal object LeakCanaryPorthole {

    private const val PROBE_CLASS = "leakcanary.LeakCanary"

    /**
     * The version this module compiled against — not a floor enforced at
     * build time (nothing here would notice a lower one at compile time,
     * since `leakcanary-android` is `compileOnly`), but the number the
     * `setup` hint quotes when a present LeakCanary's own API did not match
     * what this file expected. Keep this in step with
     * `gradle/libs.versions.toml`'s own `leakcanaryAndroid` entry and the
     * README's LeakCanary row.
     */
    internal const val FLOOR_VERSION = "2.14"

    /** Whatever [hook] found already configured, so [uninstall] can hand it back. */
    @Volatile private var chained: OnHeapAnalyzedListener? = null

    /**
     * The name of the thread that last actually ran [hook]'s body — read by
     * `LeakCanaryTest` to prove it is never `"main"`. A real app never reads
     * this; it exists because the property under test ("this ran off the
     * main thread") has no other observable trace once the call returns.
     */
    @Volatile internal var lastHookThreadName: String? = null

    /**
     * The most recent background hook thread [install] started, so a test
     * can `join()` it instead of polling [Setup.report] — whose `leakcanary`
     * row is process-wide state that survives from one test to the next,
     * and so says "hooked" before *this* install's thread has run at all.
     */
    @Volatile internal var lastHookThread: Thread? = null

    /**
     * Bumped by every [install] and every [uninstall]. The hook thread
     * captures the value at launch and [hook] refuses to touch
     * `LeakCanary.config` if it has moved on since — an uninstall (or a
     * re-install) that overtook a still-pending thread must not have that
     * thread come back later and chain a stale listener over the top.
     */
    private var generation = 0L

    /**
     * Probes the classpath and, if LeakCanary is there, hooks it — off the
     * main thread.
     *
     * Called by [live.gravitylabs.porthole.Porthole.install] the same way it
     * calls into [WorkManagerPorthole] — only after confirming [PROBE_CLASS]
     * is present, so nothing here ever runs in an app that never added
     * LeakCanary. Absent, this returns `false` immediately and — deliberately
     * — never calls [Setup.recordLeakCanary] at all: the EM was explicit that
     * a debug-only, opt-in library like this one should never be recommended,
     * and [live.gravitylabs.porthole.collect.Setup.report]'s `leakcanary`
     * entry exists only once something is known to say about it.
     *
     * GRA-64 QA: this used to call [hook] synchronously, from the main
     * thread, inside [live.gravitylabs.porthole.Porthole.install] — which
     * runs during process start, before `Application.onCreate`. The first
     * touch of `LeakCanary.config` builds `shark.AndroidReferenceMatchers`'
     * full reference-pattern list, measured at roughly a second on a cold
     * launch: Porthole's own integration was producing the exact
     * `main-thread-stall` finding it exists to report. Dispatched to a
     * dedicated daemon thread instead — the same shape every other
     * collector's own background work already takes (`porthole-memory`,
     * `porthole-watchdog`, `porthole-*`), not a `Handler.postDelayed` onto
     * the main thread, which would only move the cost later rather than off
     * it.
     *
     * A leak analyzed in the narrow window between this call and the
     * background thread actually attaching would only reach whatever
     * listener LeakCanary already had (its own default: a logcat dump and a
     * notification, or the app's own, if it set one) — never Porthole's
     * timeline, since nothing has chained onto it yet. This is not a
     * practical race: LeakCanary's own `AppWatcher` will not even consider a
     * destroyed object "retained" (the necessary precondition for a heap
     * dump) until it has watched that object for `retainedDelayMillis`
     * (default 5 seconds) with no sign it was collected, so a real analysis
     * cannot complete in under several seconds — orders of magnitude longer
     * than a freshly-scheduled daemon thread takes to start running. Nothing
     * here re-queries LeakCanary for an analysis that finished before the
     * hook attached, because nothing plausibly can.
     *
     * @return true once an attempt has been launched — not once hooked;
     *   whether it actually succeeded is [Setup.report]'s `leakcanary` row,
     *   filled in asynchronously by the background thread this starts.
     */
    fun install(ring: EventRing): Boolean {
        if (!classPresent(PROBE_CLASS)) return false
        val launched = synchronized(this) { ++generation }
        val thread = Thread({
            lastHookThreadName = Thread.currentThread().name
            runCatching { hook(ring, launched) }
                .onSuccess { Setup.recordLeakCanary(present = true, hooked = true, hint = null) }
                .onFailure { t ->
                    // leakcanary-android is on the classpath (the probe
                    // above already proved that) but calling its own real
                    // API threw — the one shape this can take once
                    // presence is settled is a signature this file's
                    // compileOnly floor did not predict:
                    // NoSuchMethodError/NoSuchFieldError for a renamed
                    // member, LinkageError for an incompatible class file.
                    // The EM asked for this to say so explicitly rather
                    // than the generic "not hooked" the rest of Setup's
                    // entries fall back to.
                    Setup.recordLeakCanary(
                        present = true,
                        hooked = false,
                        hint = "leakcanary-android is on the classpath but its LeakCanary.config/" +
                            "OnHeapAnalyzedListener API did not match what Porthole compiled against " +
                            "(floor: leakcanary-android $FLOOR_VERSION) — " +
                            "${t.javaClass.simpleName}: ${t.message}",
                    )
                }
        }, "porthole-leakcanary-hook").apply {
            isDaemon = true
        }
        lastHookThread = thread
        thread.start()
        return true
    }

    /**
     * Chains onto whatever listener LeakCanary (or the app) already had
     * configured — the same reasoning [OkHttpPorthole.installPorthole]'s own
     * doc comment gives for chaining rather than replacing: an app that set
     * its own `onHeapAnalyzedListener` (to also show its own UI, say) should
     * keep hearing about every analysis, not silently lose it the moment
     * Porthole is added.
     */
    // GRA-64 QA: hook() now runs on its own background thread (install()'s
    // own doc comment says why) while uninstall() can run concurrently, on
    // whatever thread Porthole.shutdown() is called from — a real
    // possibility now that the two are no longer serialised by both running
    // on the main thread. Synchronized on this object (a single, uncontended
    // lock in the overwhelmingly common case: shutdown() is a test/reinstall
    // path, not a hot one) so `chained` and `LeakCanary.config` are never
    // read and written from both at once.
    private fun hook(ring: EventRing, launched: Long): Unit = synchronized(this) {
        // Overtaken by an uninstall() or a later install(): do nothing, and
        // leave no trace — Setup's row is the newer call's to fill in.
        if (launched != generation) return
        val existing = LeakCanary.config.onHeapAnalyzedListener
        chained = existing
        LeakCanary.config = LeakCanary.config.copy(
            onHeapAnalyzedListener = OnHeapAnalyzedListener { analysis ->
                existing.onHeapAnalyzed(analysis)
                // A malformed analysis must never take the app's own
                // listener down with it — chained above this line runs
                // regardless of what happens below.
                runCatching { onHeapAnalyzed(ring, analysis) }
            },
        )
    }

    /**
     * Hands the previously-chained listener back, undoing [hook]. A no-op
     * when [install] was never called, or its background thread has not
     * reached [hook] yet, or it never got far enough to hook anything —
     * [live.gravitylabs.porthole.Porthole.shutdown] calls this
     * unconditionally, the same way it calls every other collector's own
     * `stop()` regardless of whether that collector ever started.
     */
    fun uninstall(): Unit = synchronized(this) {
        generation++
        val previous = chained ?: return
        chained = null
        runCatching { LeakCanary.config = LeakCanary.config.copy(onHeapAnalyzedListener = previous) }
        Unit
    }

    /**
     * One event per leak LeakCanary classified, application or library —
     * never one event per analysis. A `HeapAnalysisSuccess` with three
     * application leaks is three separate things to look at, not one, and
     * folding them together would make the worst of the three
     * indistinguishable from the least. A failed analysis
     * ([shark.HeapAnalysisFailure]) has no leaks to report and is silently
     * dropped: LeakCanary already surfaces the failure through its own
     * notification, and nothing here can say anything about a dump it never
     * got to read.
     */
    internal fun onHeapAnalyzed(ring: EventRing, analysis: HeapAnalysis) {
        if (analysis !is HeapAnalysisSuccess) return

        // Open question 2: LeakCanary suspends the VM for the dump itself
        // (createdAtTimeMillis/dumpDurationMillis, both wall-clock — see
        // shark.HeapAnalysis) — long enough that MainThreadWatchdog's own
        // ping-based stall detector cannot tell that pause apart from a real
        // hang once the process resumes. Reconstructed here, on Porthole's
        // own uptime clock, so the MCP side can line a `blocked` event's
        // window up against it and say "heap dump by LeakCanary" instead of
        // reporting LeakCanary's own diagnostic as the app's defect.
        //
        // The conversion assumes uptime and wall clock kept the same offset
        // between the dump ending and this callback running — true unless
        // the device slept in between, which a foreground debug session
        // analyzing a heap it just dumped is not doing. `createdAtTimeMillis`
        // is read as the *end* of the paused window (it also includes
        // shark's own off-thread analysis time, which runs after the VM
        // resumes and does not block anything) — a slight overestimate of
        // the window, and the safe direction for an attribution to err in.
        val offsetMs = clockOffsets().let { it.uptimeMs - it.wallMs }
        val heapDumpEndMs = analysis.createdAtTimeMillis + offsetMs
        val heapDumpStartMs = heapDumpEndMs - analysis.dumpDurationMillis

        for (leak in analysis.applicationLeaks) {
            emitLeak(ring, leak, kind = "application", analysis, heapDumpStartMs, heapDumpEndMs)
        }
        for (leak in analysis.libraryLeaks) {
            emitLeak(ring, leak, kind = "library", analysis, heapDumpStartMs, heapDumpEndMs)
        }
    }

    private fun emitLeak(
        ring: EventRing,
        leak: Leak,
        kind: String,
        analysis: HeapAnalysisSuccess,
        heapDumpStartMs: Long,
        heapDumpEndMs: Long,
    ) {
        val leakingObject = leak.leakTraces.firstOrNull()?.leakingObject
        ring.emit(
            EventKinds.LEAK,
            JsonObject(
                buildMap {
                    // "application" (an app-code reference held a dead
                    // Activity/Fragment/View) or "library" (LeakCanary's own
                    // AndroidReferenceMatchers already knows this one and
                    // classified it as a framework/library defect, not the
                    // app's) — findings.ts reads this to pick a-warning vs a
                    // note, per the EM.
                    put("kind", JsonPrimitive(kind))
                    put("signature", JsonPrimitive(leak.signature))
                    put("shortDescription", JsonPrimitive(leak.shortDescription))
                    leakingObject?.className?.let { put("leakingClass", JsonPrimitive(it)) }
                    leak.totalRetainedHeapByteSize?.let { put("retainedHeapByteSize", JsonPrimitive(it)) }
                    // How many separate occurrences of this exact leak this
                    // one heap dump found — LeakCanary groups repeats of the
                    // same reference path under one Leak rather than
                    // reporting each instance on its own.
                    put("leakCount", JsonPrimitive(leak.leakTraces.size))
                    // leak.toString() is LeakCanary's own rendering — header,
                    // GC root, and the full reference path with retained
                    // size per node, the same text it writes to logcat. See
                    // Redaction.leakTrace for why this goes through the
                    // shared redaction path rather than straight onto the
                    // wire.
                    put("traceText", JsonPrimitive(Redaction.leakTrace(leak.toString())))
                    put("createdAtTimeMillis", JsonPrimitive(analysis.createdAtTimeMillis))
                    put("dumpDurationMillis", JsonPrimitive(analysis.dumpDurationMillis))
                    put("analysisDurationMillis", JsonPrimitive(analysis.analysisDurationMillis))
                    put("heapDumpStartMs", JsonPrimitive(heapDumpStartMs))
                    put("heapDumpEndMs", JsonPrimitive(heapDumpEndMs))
                },
            ),
            at = heapDumpEndMs,
        )
    }

    private fun classPresent(name: String): Boolean =
        runCatching { Class.forName(name, false, LeakCanaryPorthole::class.java.classLoader) }.isSuccess
}
