// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import androidx.compose.runtime.Composition
import androidx.compose.runtime.ExperimentalComposeRuntimeApi
import androidx.compose.runtime.RecomposeScope
import androidx.compose.runtime.tooling.CompositionData
import androidx.compose.runtime.tooling.CompositionObserver
import androidx.compose.runtime.tooling.CompositionObserverHandle
import androidx.compose.runtime.tooling.observe
import androidx.compose.ui.platform.AbstractComposeView
import androidx.compose.ui.tooling.data.Group
import androidx.compose.ui.tooling.data.UiToolingDataApi
import androidx.compose.ui.tooling.data.asTree
import live.gravitylabs.porthole.nowMs
import java.util.Collections
import java.util.IdentityHashMap
import java.util.WeakHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Counts every recomposition Compose will admit to, not only the ones an app
 * wrapped in `PortholeScreen` / `Modifier.portholeNode` — GRA-235, following on
 * from the GRA-70 spike (`docs/spikes/GRA-70-recomposition-counts.md`).
 *
 * Three jobs, all of them optional and all of them independent of whether the
 * other two work:
 *
 *  1. **Attach.** `androidx.compose.runtime.tooling.CompositionObserver`
 *     handed to every `Composition` reachable from an Activity's decor view,
 *     via a reflective read of `AbstractComposeView.composition` — the one
 *     private field the spike found no public way around. Requires Compose
 *     1.6 (`CompositionObserver` does not exist before `1.6.0-alpha07`); on
 *     an older Compose this whole class is inert, see [available].
 *  2. **Count and attribute.** Every scope in `onBeginComposition`'s
 *     invalidation map is one recomposition, whether or not the app ever
 *     named it, and the map's values are the actual state objects that
 *     invalidated each scope — a causal answer, not the 32ms correlation
 *     [RecompositionCollector.onRecompose] falls back to when this class is
 *     unavailable.
 *  3. **Name, opt-in only.** Off by default: resolving a scope's name needs
 *     Compose's own `collectParameterInformation()`, which is what the Layout
 *     Inspector uses, and which sets `forceRecomposeScopes = true` — every
 *     composable gets a recompose scope, not only the ones that need one, so
 *     turning this on changes the shape of the program being measured. The
 *     README says so and so does `RecompositionReport.notes`.
 *
 * ## Merging with the wrapped call sites, and why reconciliation is deferred
 *
 * A `Modifier.portholeNode`-wrapped composable is *also* a scope this class
 * sees in the invalidation map — the same recomposition, told to us twice, by
 * two different mechanisms. Rather than identify which specific map entry is
 * the wrapped one (the only API that hands over an object identity clean
 * enough for that, `currentRecomposeScope`, is itself new enough to carry the
 * same version risk this class already carries once, and doubling that risk
 * inside `PortholeCompose.kt` — which every wrapped call site, on every
 * Compose version, already depends on — was judged the worse trade), this
 * class reconciles at the *pass* level instead: [notifyWrappedFired] counts
 * how many wrapped `SideEffect`s fired for a pass, and that many entries are
 * dropped off the pass's own invalidation map before what's left becomes
 * whole-tree samples.
 *
 * The one thing that cost an emulator run to learn: **`SideEffect` does not
 * run before [onEndComposition]. It runs after** — Compose applies the
 * pass's changes and dispatches its queued effects only once the observer
 * has already been told the pass ended. Reconciling from inside
 * [onEndComposition] itself, the first version of this class did, therefore
 * saw `wrappedFired == 0` for every pass, no matter how many wrapped call
 * sites were actually in it, and either double-reported them as spurious
 * `"observer"` nodes or — once forceRecomposeScopes was in the mix and a
 * keystroke spanned several small passes — silently dropped real ones,
 * whichever a given pass's arithmetic happened to produce. What is
 * guaranteed, because the Composer/Recomposer loop is single-threaded and
 * sequential, is that a pass's effects have all run by the time the *next*
 * pass begins. So a pass is not reconciled when it ends; it is marked
 * "settled," and reconciled — via [reconcileSettledPass] — at the earliest
 * of two points that both guarantee its effects already ran: the next
 * [onBeginComposition], or, for the last pass of a burst (nothing else ever
 * composes again to trigger that), a short quiet check on [flushExecutor].
 * [currentPassTriggers] follows the same shape: it hands a firing
 * `SideEffect` the *settled* pass's causal triggers when one is waiting,
 * falling back to the currently-open pass's only before anything has
 * settled yet.
 *
 * For the common case — a pass invalidates exactly the scopes it invalidates,
 * and a wrapped scope in it fires its `SideEffect` exactly once before the
 * next pass begins — this is exact, not approximate: 1 wrapped fire against a
 * 1-scope settled pass drops the one entry and reports nothing extra; 0
 * wrapped fires against an N-scope pass reports all N. The one case it cannot
 * resolve precisely is a single pass that mixes a wrapped scope's own
 * invalidation with unrelated scopes invalidated in the exact same pass —
 * there, the specific entry dropped is arbitrary, but the *total* count is
 * still right, and the wrapped node's own count is never affected: it always
 * comes from its own `SideEffect`, never derived from this reconciliation.
 */
@OptIn(ExperimentalComposeRuntimeApi::class, UiToolingDataApi::class)
internal class CompositionTreeCollector(
    private val snapshots: SnapshotWatcher,
    private val composableNames: Boolean,
    /** Overridable so a test can simulate a pre-1.6 Compose without one on the classpath. */
    val available: Boolean = classPresent(OBSERVER_CLASS),
) : Application.ActivityLifecycleCallbacks, CompositionObserver, RecompositionCollector.ObserverNames {

    private class ScopeState(val id: String) {
        var displayName: String? = null
    }

    private val lock = Any()
    private val scopes = IdentityHashMap<RecomposeScope, ScopeState>()
    private var nextIdSuffix = 0

    private val activities: MutableSet<Activity> =
        Collections.newSetFromMap(WeakHashMap<Activity, Boolean>())
    private val attachedViews: MutableMap<AbstractComposeView, CompositionObserverHandle> =
        Collections.synchronizedMap(WeakHashMap<AbstractComposeView, CompositionObserverHandle>())

    /** One composition pass, captured at [onBeginComposition] and reconciled once its effects have had time to run. See this class's own doc comment. */
    private class Pass(
        val entries: List<Map.Entry<RecomposeScope, Set<Any>?>>,
        val causalTriggers: List<String>,
    )

    // -- per-pass reconciliation state, all guarded by [lock] ---------------
    private var openPass: Pass? = null
    private var settledPass: Pass? = null
    private var settledAtMs: Long = 0
    private var wrappedFiredForSettled = 0

    private var inspectionTagId: Int = 0
    private var callback: RecompositionCollector? = null

    /**
     * The safety net for the last pass of a burst: nothing ever begins
     * another one to trigger [reconcileSettledPass] the normal way, so this
     * checks, on a short fixed delay, whether a settled pass has been
     * waiting long enough that its effects are certain to have run.
     */
    private val flushExecutor = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "porthole-compose-tree").apply { isDaemon = true }
    }

    /** True once at least one [Composition] has actually been handed an observer. */
    @Volatile var attachedAtLeastOnce: Boolean = false
        private set

    fun install(app: Application, recompositions: RecompositionCollector): Boolean {
        if (!available) {
            Log.i(
                TAG,
                "whole-tree recomposition counting needs Compose >= 1.6 " +
                    "(androidx.compose.runtime.tooling.CompositionObserver not found); " +
                    "falling back to PortholeScreen/Modifier.portholeNode counts only.",
            )
            return false
        }
        callback = recompositions
        app.registerActivityLifecycleCallbacks(this)
        flushExecutor.scheduleWithFixedDelay(
            { runCatching { flushSettledPassIfQuiet() } },
            FLUSH_TICK_MS,
            FLUSH_TICK_MS,
            TimeUnit.MILLISECONDS,
        )
        return true
    }

    fun stop(app: Application) {
        if (!available) return
        runCatching { app.unregisterActivityLifecycleCallbacks(this) }
        flushExecutor.shutdownNow()
        synchronized(attachedViews) {
            attachedViews.values.forEach { runCatching { it.dispose() } }
            attachedViews.clear()
        }
        synchronized(activities) { activities.clear() }
        synchronized(lock) {
            scopes.clear()
            openPass = null
            settledPass = null
            wrappedFiredForSettled = 0
        }
    }

    /** Called by `Porthole.onRecompose` when a `PortholeScreen`/`Modifier.portholeNode` fires. */
    fun notifyWrappedFired() {
        synchronized(lock) { wrappedFiredForSettled++ }
    }

    /**
     * The state names that invalidated the composition pass a `SideEffect`
     * firing right now almost certainly belongs to: the *settled* pass's
     * triggers when one is waiting to be reconciled (the normal case — see
     * this class's own doc comment for why `SideEffect` fires after a pass
     * settles, not during it), or the currently-open pass's before anything
     * has settled yet. Null when neither exists, including whenever
     * [available] is false, which is what makes
     * [RecompositionCollector.onRecompose] fall back to its own temporal
     * correlation with no special-casing.
     */
    fun currentPassTriggers(): List<String>? = synchronized(lock) {
        (settledPass ?: openPass)?.causalTriggers
    }

    /** Off the composition thread — called from [onBeginComposition] and from [flushExecutor]. */
    private fun reconcileSettledPass(pass: Pass, wrappedFired: Int) {
        val recompositions = callback ?: return
        // See this class's own doc comment for exactly what this drop does
        // and does not guarantee.
        val remaining = if (wrappedFired > 0) pass.entries.drop(wrappedFired) else pass.entries
        for ((scope, states) in remaining) {
            val info = synchronized(lock) {
                scopes.getOrPut(scope) { ScopeState(id = OBSERVER_ID_PREFIX + (nextIdSuffix++).toString(36)) }
            }
            val causal = (states ?: emptySet()).map(snapshots::nameOf).distinct()
            val placeholder = info.displayName ?: (UNINSTRUMENTED_PREFIX + info.id.removePrefix(OBSERVER_ID_PREFIX) + ">")
            recompositions.onRecomposeObserved(info.id, placeholder, causal)
        }
    }

    private fun flushSettledPassIfQuiet() {
        val toFlush = synchronized(lock) {
            val pass = settledPass ?: return
            if (nowMs() - settledAtMs < FLUSH_TICK_MS) return
            val w = wrappedFiredForSettled
            settledPass = null
            wrappedFiredForSettled = 0
            pass to w
        }
        reconcileSettledPass(toFlush.first, toFlush.second)
    }

    // -- ActivityLifecycleCallbacks -----------------------------------------

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        synchronized(activities) { activities += activity }
        if (composableNames) tagContentViewGroup(activity)
    }

    override fun onActivityResumed(activity: Activity) {
        runCatching { attachAll(activity.window?.decorView) }
            .onFailure { Log.d(TAG, "decor-view walk failed: ${it.message}") }
    }

    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) {
        synchronized(activities) { activities -= activity }
    }

    // -- attach: the one private reflective read -----------------------------

    /**
     * Tagging happens in `onActivityCreated`, which `ActivityLifecycleCallbacks`
     * dispatches from inside the Activity's own `super.onCreate()` — before the
     * app's `setContent` runs and before the decor is attached to a window, so
     * `WrappedComposition.setContent` finds the tag on its very first run and
     * Compose collects source information from the start. No hot reload, unlike
     * the Layout Inspector, which attaches to an already-running app and has to
     * force one.
     */
    private fun tagContentViewGroup(activity: Activity) {
        runCatching {
            val id = resolveInspectionTagId(activity)
            if (id == 0) return@runCatching
            val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return@runCatching
            content.setOnHierarchyChangeListener(
                object : ViewGroup.OnHierarchyChangeListener {
                    override fun onChildViewAdded(parent: View, child: View) {
                        child.setTag(id, Collections.synchronizedSet(HashSet<CompositionData>()))
                    }

                    override fun onChildViewRemoved(parent: View, child: View) = Unit
                },
            )
        }.onFailure { Log.d(TAG, "could not tag content view for composable names: ${it.message}") }
    }

    private fun resolveInspectionTagId(activity: Activity): Int {
        if (inspectionTagId != 0) return inspectionTagId
        val id = activity.resources.getIdentifier("inspection_slot_table_set", "id", activity.packageName)
        inspectionTagId = id
        return id
    }

    private fun attachAll(root: View?) {
        if (root == null) return
        findComposeViews(root).forEach(::attach)
    }

    private fun findComposeViews(view: View, out: MutableList<AbstractComposeView> = ArrayList()): List<AbstractComposeView> {
        if (view is AbstractComposeView) out += view
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) findComposeViews(view.getChildAt(i), out)
        }
        return out
    }

    /**
     * `AbstractComposeView.composition` is `private` with no accessor —
     * confirmed the same way the spike confirmed it, `javap -p`. Everything
     * else this class touches is public API Compose hands over directly.
     *
     * One timing wrinkle the spike's own manifest-declared probe didn't hit,
     * because a `ContentProvider` attaches far earlier than any
     * `ActivityLifecycleCallbacks` does: on this Android/Compose combination,
     * `composition` is still null at `onActivityResumed` — `setContent`'s
     * composition is created lazily, on this view's first layout pass, which
     * can land after resume. A single reflective read at resume is therefore
     * not enough; [tryAttach] is retried from a [ViewTreeObserver.OnGlobalLayoutListener]
     * until it succeeds, then that listener removes itself.
     */
    private fun attach(view: AbstractComposeView) {
        if (tryAttach(view)) return
        val listener = object : ViewTreeObserver.OnGlobalLayoutListener {
            override fun onGlobalLayout() {
                if (tryAttach(view)) {
                    runCatching {
                        view.viewTreeObserver.takeIf { it.isAlive }?.removeOnGlobalLayoutListener(this)
                    }
                }
            }
        }
        runCatching { view.viewTreeObserver.addOnGlobalLayoutListener(listener) }
    }

    private fun tryAttach(view: AbstractComposeView): Boolean {
        if (attachedViews.containsKey(view)) return true
        return runCatching {
            val field = AbstractComposeView::class.java.getDeclaredField("composition")
            field.isAccessible = true
            val composition = field.get(view) as? Composition ?: return@runCatching false
            val handle = composition.observe(this) ?: return@runCatching false
            attachedViews[view] = handle
            attachedAtLeastOnce = true
            true
        }.getOrElse {
            Log.d(TAG, "could not attach CompositionObserver: ${it.message}")
            false
        }
    }

    // -- CompositionObserver --------------------------------------------------

    override fun onBeginComposition(composition: Composition, invalidationMap: Map<RecomposeScope, Set<Any>?>) {
        // Copied once, off whatever live map Compose handed us, so a mutation
        // to it after this callback returns can't race this pass's own
        // eventual reconciliation.
        val entries = invalidationMap.entries.toList()
        val causal = LinkedHashSet<String>()
        for (entry in entries) {
            val states = entry.value ?: continue
            for (state in states) causal += snapshots.nameOf(state)
        }
        val pass = Pass(entries, causal.toList())

        // The pass that was "settled" (closed, awaiting its effects) is now
        // safe to reconcile: this pass could not have begun until the
        // Composer/Recomposer finished applying the previous one's changes
        // and dispatching its effects. See this class's own doc comment.
        val toFlush = synchronized(lock) {
            val prevSettled = settledPass
            val w = wrappedFiredForSettled
            settledPass = null
            wrappedFiredForSettled = 0
            openPass = pass
            if (prevSettled != null) prevSettled to w else null
        }
        toFlush?.let { (prevPass, w) -> reconcileSettledPass(prevPass, w) }
    }

    override fun onEndComposition(composition: Composition) {
        // This pass's SideEffects have not run yet — Compose applies changes
        // and dispatches them only after this callback returns. "Settled",
        // not reconciled: see this class's own doc comment for where that
        // actually happens.
        synchronized(lock) {
            settledPass = openPass
            openPass = null
            settledAtMs = nowMs()
            wrappedFiredForSettled = 0
        }
    }

    // -- RecompositionCollector.ObserverNames --------------------------------

    /**
     * Re-walks every tagged slot table and updates [ScopeState.displayName]
     * for whatever scopes have already recomposed at least once. Deliberately
     * not on the hot path: this only runs when a `recompositions` report is
     * actually being built, not once per composition pass — the
     * `forceRecomposeScopes` cost of turning [composableNames] on at all is
     * unavoidable, but the tree walk that turns it into readable names does
     * not have to be paid on every recomposition on top of that.
     */
    override fun refresh() {
        if (!composableNames) return
        runCatching {
            for (table in collectTaggedCompositionData()) {
                walk(table.asTree())
            }
        }.onFailure { Log.d(TAG, "composable-name walk failed: ${it.message}") }
    }

    override fun displayName(id: String): String? = synchronized(lock) {
        scopes.values.firstOrNull { it.id == id }?.displayName
    }

    private fun collectTaggedCompositionData(): List<CompositionData> {
        if (inspectionTagId == 0) return emptyList()
        val out = ArrayList<CompositionData>()
        val snapshot = synchronized(activities) { activities.toList() }
        for (activity in snapshot) {
            val decor = runCatching { activity.window?.decorView }.getOrNull() ?: continue
            collectTags(decor, out)
        }
        return out
    }

    @Suppress("UNCHECKED_CAST")
    private fun collectTags(view: View, out: MutableList<CompositionData>) {
        val tag = view.getTag(inspectionTagId)
        if (tag is Set<*>) {
            for (item in tag) if (item is CompositionData) out += item
        }
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) collectTags(view.getChildAt(i), out)
        }
    }

    private fun walk(group: Group) {
        val scope = group.data.firstOrNull { it is RecomposeScope } as? RecomposeScope
        if (scope != null) {
            val name = nameOf(group.name, group.location?.sourceFile, group.location?.lineNumber)
            synchronized(lock) {
                scopes[scope]?.let { info ->
                    if (info.displayName == null) info.displayName = name
                }
            }
        }
        for (child in group.children) walk(child)
    }

    /**
     * `name` is the bare composable name Compose's own source information
     * already parsed for us (`SourceInformationContext`, via `group.name`) —
     * a content lambda has none, per the spike's own finding, and falls back
     * to `sourceFile:lineNumber`, which is still enough to point at.
     *
     * Takes the already-extracted primitives rather than a `Group` itself —
     * `androidx.compose.ui.tooling.data.Group`'s own constructor is not
     * accessible outside its module, which would make this untestable
     * otherwise — so `internal`, not `private`, is enough on its own to let a
     * unit test exercise every formatting rule directly, no `Group` required.
     */
    internal fun nameOf(name: String?, sourceFile: String?, lineNumber: Int?): String {
        val cleanName = name?.takeIf { it.isNotBlank() }
        return when {
            cleanName != null && sourceFile != null -> "$cleanName ($sourceFile:$lineNumber)"
            cleanName != null -> cleanName
            sourceFile != null -> "$sourceFile:$lineNumber"
            else -> "<anonymous scope>"
        }
    }

    companion object {
        private const val TAG = "Porthole"
        private const val OBSERVER_CLASS = "androidx.compose.runtime.tooling.CompositionObserverKt"
        const val OBSERVER_ID_PREFIX = "obs:"
        const val UNINSTRUMENTED_PREFIX = "<uninstrumented:"

        /**
         * How often [flushExecutor] checks for a settled pass nothing has
         * reconciled yet, and — doubling as the grace period itself — how
         * long a settled pass sits before that check flushes it. Same order
         * of magnitude as [RecompositionCollector]'s own burst-close tick,
         * for the same reason: long enough that a pass's effects (dispatched
         * synchronously, same frame) have certainly run, short enough that
         * the last pass of a burst doesn't sit unflushed for something a
         * human would notice.
         */
        private const val FLUSH_TICK_MS = 60L

        private fun classPresent(name: String): Boolean =
            runCatching { Class.forName(name, false, CompositionTreeCollector::class.java.classLoader) }.isSuccess
    }
}
