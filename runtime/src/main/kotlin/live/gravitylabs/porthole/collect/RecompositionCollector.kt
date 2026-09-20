// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.nowMs
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import live.gravitylabs.porthole.protocol.EventKinds
import live.gravitylabs.porthole.protocol.RecompositionNode
import live.gravitylabs.porthole.protocol.RecompositionReport
import live.gravitylabs.porthole.protocol.StateWriteCount
import live.gravitylabs.porthole.store.EventRing
import java.util.ArrayDeque

/**
 * Counts recompositions at instrumented call sites and correlates each one with
 * the snapshot writes that immediately preceded it.
 *
 * What this can and cannot see, stated plainly because an agent reading the
 * output should not over-trust it:
 *
 *  - Without [CompositionTreeCollector] (Compose < 1.6, or the tooling API
 *    otherwise unavailable): it counts the scopes you wrapped in
 *    `PortholeScreen` / `Modifier.portholeNode` only, and an uninstrumented
 *    subtree is invisible, not zero.
 *  - With it: every recompose scope in the tree is counted (GRA-235),
 *    wrapped or not, merged on scope identity so a wrapped call site is
 *    never reported twice — see [CompositionTreeCollector]'s own doc comment
 *    for exactly how that merge works and what it does not guarantee.
 *  - Attribution is causal when [CompositionTreeCollector] supplies the
 *    actual state objects that invalidated a scope (`attribution: "observer"`
 *    on the node), and falls back to a temporal correlation — state written
 *    in the window before a recomposition, not proven to be what invalidated
 *    it — when it cannot (`attribution: "temporal"`). When several states
 *    change in the same frame, a temporal correlation lists all of them.
 */
internal class RecompositionCollector(
    private val ring: EventRing,
    private val snapshots: SnapshotWatcher,
    private val attributionWindowMs: Long = SnapshotWatcher.DEFAULT_ATTRIBUTION_WINDOW_MS,
    /**
     * Substitutable for the same reason the event ring's is: a clock reached
     * for statically cannot be replaced, and a collector that calls
     * SystemClock directly cannot be unit tested at all.
     */
    private val now: () -> Long = ::nowMs,
    /** Whether `porthole { composableNames.set(true) }` is on for this build. */
    private val composableNamesEnabled: Boolean = false,
) {
    /**
     * How [CompositionTreeCollector] turns an `"obs:..."` node id into a
     * display name once a report is actually being built — never on the
     * recompose hot path. Set by `Porthole.install()`; left null when whole
     * -tree counting is unavailable, in which case no node ever carries that
     * id prefix and this is simply never consulted.
     */
    var observerNames: ObserverNames? = null

    /**
     * Whether `androidx.compose.runtime.tooling.CompositionObserver` is
     * available this session (Compose >= 1.6). Set once by `Porthole.install()`
     * right after constructing [CompositionTreeCollector] — a `var`, not a
     * constructor argument, because the two collectors are built in sequence
     * and this one needs to know the other's [CompositionTreeCollector.available]
     * before the first `report()` call, not before its own construction.
     */
    var wholeTreeAvailable: Boolean = false

    internal interface ObserverNames {
        /** Re-walks the live composition tree, refreshing every name it can resolve. */
        fun refresh()

        /** The best known display name for an `"obs:..."` node id, or null. */
        fun displayName(id: String): String?
    }

    private class Sample(
        val nodeId: String,
        val name: String,
        val screen: String?,
        val t: Long,
        val triggers: List<String>,
        val source: String,
        val attribution: String,
    )

    private val samples = ArrayDeque<Sample>()
    private val lock = Any()

    /** Recomposition churn as spans in the system trace. See RecomposeBurst. */
    private val burst = RecomposeBurst(now = now)

    /**
     * Closes a burst once recompositions stop.
     *
     * Nothing happens when churn ends, so something has to come looking.
     * A daemon thread, so it never holds the process open, and one tick
     * rather than a task per recomposition: the hot path only writes a
     * field.
     */
    private val closer: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "porthole-recompose").apply { isDaemon = true }
        }.also {
            it.scheduleWithFixedDelay(
                { runCatching { burst.tick() } },
                BURST_TICK_MS,
                BURST_TICK_MS,
                TimeUnit.MILLISECONDS,
            )
        }

    /**
     * Called from a SideEffect, so: on the composition thread, once per pass.
     *
     * @param causalTriggers When [CompositionTreeCollector] is attached, the
     *   state names it says invalidated the composition pass this recompose
     *   belongs to (GRA-235) — a causal answer, not a guess. Null (its
     *   default) falls back to the original temporal correlation, which is
     *   also what happens automatically whenever the observer is unavailable
     *   or has not opened a pass, with no special-casing needed here.
     */
    fun onRecompose(nodeId: String, name: String, screen: String?, passCount: Int, causalTriggers: List<String>? = null) {
        val t = now()
        // Before the attribution walk: this is two field writes, and it is
        // the part that has to survive being called thousands of times.
        burst.onRecompose()
        val triggers = causalTriggers ?: snapshots.writesBefore(t, attributionWindowMs)
        val attribution = if (causalTriggers != null) "observer" else "temporal"
        synchronized(lock) {
            samples.addLast(Sample(nodeId, name, screen, t, triggers, source = "wrapped", attribution = attribution))
            while (samples.size > SAMPLE_CAPACITY) samples.removeFirst()
        }
        ring.emit(
            EventKinds.RECOMPOSE,
            JsonObject(
                mapOf(
                    "id" to JsonPrimitive(nodeId),
                    "name" to JsonPrimitive(name),
                    "screen" to (screen?.let { JsonPrimitive(it) } ?: JsonPrimitive("")),
                    "pass" to JsonPrimitive(passCount),
                    "triggeredBy" to JsonArray(triggers.map { JsonPrimitive(it) }),
                    "source" to JsonPrimitive("wrapped"),
                    "attribution" to JsonPrimitive(attribution),
                ),
            ),
        )
    }

    /**
     * A whole-tree scope [CompositionTreeCollector] saw recompose, that no
     * `PortholeScreen`/`Modifier.portholeNode` call site already accounted
     * for this pass (GRA-235). Unlike [onRecompose], this never touches the
     * ring: whole-tree coverage means every scope in the tree, which on a
     * busy screen is far more of them than the app ever wrapped, and the JSON
     * construction plus ring write [onRecompose] pays is exactly the cost the
     * GRA-70 spike found was *not* free — only the observer callback itself
     * was. The `recompositions` report still sees every sample; `timeline`
     * and `findings` see only wrapped call sites, same as before this
     * ticket — a deliberate scope limit, not an oversight.
     */
    fun onRecomposeObserved(nodeId: String, name: String, causalTriggers: List<String>) {
        val t = now()
        burst.onRecompose()
        synchronized(lock) {
            samples.addLast(Sample(nodeId, name, screen = null, t, causalTriggers, source = "observer", attribution = "observer"))
            while (samples.size > SAMPLE_CAPACITY) samples.removeFirst()
        }
    }

    /**
     * @param screen only report nodes on this screen, matched against the
     *   enclosing `PortholeScreen` name or the node name itself.
     * @param sinceMs how far back to look. Null means everything still held.
     * @param from absolute uptime, inclusive. Wins over [sinceMs] when set.
     * @param to absolute uptime, inclusive. Defaults to now.
     *
     * Absolute bounds exist so that a moment seen on the timeline can be named
     * rather than approximated: every event carries the same uptime clock, so
     * "the spike at t=24100" is expressible instead of "about twenty seconds
     * ago, roughly". [Window.resolve] is where those three arguments are turned
     * into a span, for every tool on the surface rather than only this one.
     */
    fun report(
        screen: String?,
        sinceMs: Long?,
        from: Long? = null,
        to: Long? = null,
        /** Busiest N nodes. The tail of a recomposition report is rarely the answer. */
        limit: Int? = null,
    ): RecompositionReport {
        val window = Window.resolve(sinceMs, from, to, now())

        // Off the hot path by construction (see ObserverNames.refresh's own
        // comment) — this is the one point a report pays for it, once per
        // call, not once per recomposition.
        observerNames?.refresh()

        val inWindow = synchronized(lock) {
            samples.filter { it.t in window && (screen == null || matches(it, screen)) }
        }

        val byNode = LinkedHashMap<String, MutableList<Sample>>()
        for (s in inWindow) byNode.getOrPut(s.nodeId) { mutableListOf() } += s

        val nodes = byNode.values
            .map { group ->
                val counts = LinkedHashMap<String, Int>()
                for (s in group) for (k in s.triggers) counts[k] = (counts[k] ?: 0) + 1
                val head = group.first()
                val resolvedName = if (head.source == "observer") {
                    observerNames?.displayName(head.nodeId) ?: head.name
                } else {
                    head.name
                }
                RecompositionNode(
                    id = head.nodeId,
                    name = resolvedName,
                    screen = head.screen,
                    count = group.size,
                    firstAt = group.minOf { it.t },
                    lastAt = group.maxOf { it.t },
                    triggeredBy = counts.toWriteCounts(),
                    source = head.source,
                    // Not head.attribution: the observer can attach a few
                    // milliseconds into a session, after this node's first
                    // sample or two already fell back to temporal — "any
                    // causal sample in this window" is a truer answer than
                    // "whatever the earliest one happened to be."
                    attribution = if (group.any { it.attribution == "observer" }) "observer" else "temporal",
                )
            }
            .sortedByDescending { it.count }

        // Applied after sorting, so a limit keeps the busiest rather than
        // whichever nodes happened to be recorded first.
        val cap = limit?.coerceAtLeast(1) ?: DEFAULT_NODE_LIMIT
        val kept = nodes.take(cap)
        val dropped = nodes.size - kept.size

        val attributed = inWindow.flatMapTo(HashSet()) { it.triggers }
        val unattributed = snapshots.writesBetween(window.first, window.last)
            .filterKeys { it !in attributed }
            .toWriteCounts()

        return RecompositionReport(
            since = window.first,
            now = window.last,
            nodes = kept,
            totalNodes = nodes.size,
            truncated = dropped > 0,
            unattributedWrites = unattributed,
            notes = buildNotes(nodes.isEmpty(), unattributed.isNotEmpty(), nodes, unattributed, screenFiltered = screen != null),
            wholeTreeCoverage = wholeTreeAvailable,
            composableNames = composableNamesEnabled,
        )
    }

    /** Stops the closer and ends any open span. */
    fun stop() {
        burst.close()
        closer.shutdownNow()
    }

    fun reset() {
        synchronized(lock) { samples.clear() }
        snapshots.clear()
    }

    fun instrumentedNodeCount(): Int = synchronized(lock) { samples.distinctBy { it.nodeId }.size }

    private fun matches(sample: Sample, screen: String): Boolean =
        sample.screen.equals(screen, ignoreCase = true) ||
            sample.name.equals(screen, ignoreCase = true) ||
            sample.name.startsWith("$screen.", ignoreCase = true)

    private fun Map<String, Int>.toWriteCounts(): List<StateWriteCount> =
        entries.sortedByDescending { it.value }
            .map {
                val named = !SnapshotWatcher.isUnnamed(it.key)
                StateWriteCount(
                    key = it.key,
                    count = it.value,
                    named = named,
                    holds = if (named) null else snapshots.hintFor(it.key),
                )
            }

    private fun buildNotes(
        noNodes: Boolean,
        hasUnattributed: Boolean,
        nodes: List<RecompositionNode>,
        unattributed: List<StateWriteCount>,
        screenFiltered: Boolean = false,
    ): List<String> = buildList {
        if (wholeTreeAvailable) {
            add(
                "Whole-tree coverage: every recompose scope Compose invalidated is counted here " +
                    "(GRA-235), not only PortholeScreen/Modifier.portholeNode call sites — 'source' " +
                    "on each node says 'wrapped' (an explicit name you gave it) or 'observer' " +
                    "(found, not wrapped). A wrapped call site is never counted twice: the same " +
                    "scope's observer entry is merged into it.",
            )
        } else {
            add(
                "Counts cover instrumented call sites only (PortholeScreen / Modifier.portholeNode). " +
                    "An absent composable means uninstrumented, not zero recompositions — this build's " +
                    "Compose runtime is below 1.6, or androidx.compose.runtime.tooling.CompositionObserver " +
                    "was otherwise unavailable, so whole-tree counting could not attach; see the " +
                    "README's recompositions section.",
            )
        }
        if (wholeTreeAvailable && nodes.any { it.attribution == "observer" }) {
            add(
                "triggeredBy on an 'attribution: observer' node names the actual state objects " +
                    "Compose says invalidated that composition pass — causal, not a guess. A " +
                    "'temporal' node (or every node, when whole-tree coverage is off) falls back to " +
                    "state written within " + attributionWindowMs + "ms before the recomposition, " +
                    "which is a correlation: several states changing in one frame all get listed.",
            )
        } else {
            add(
                "triggeredBy is a temporal correlation: state written within " +
                    attributionWindowMs + "ms before the recomposition. " +
                    "Several states changing in one frame all get listed.",
            )
        }
        if (composableNamesEnabled) {
            add(
                "composableNames is on: Compose is running with forceRecomposeScopes, which gives " +
                    "every composable its own recompose scope rather than only the ones that need " +
                    "one — this build recomposes measurably differently than it would with " +
                    "composableNames off. Turn it off to measure the app as it ships.",
            )
        } else if (wholeTreeAvailable) {
            add(
                "composableNames is off (the default): observer-only nodes are counted but not " +
                    "named — their 'name' is a placeholder like '<uninstrumented:1a>'. " +
                    "porthole { composableNames.set(true) } resolves real names, at the cost above.",
            )
        }
        if (wholeTreeAvailable && screenFiltered) {
            add(
                "The 'screen' filter matches wrapped nodes' explicit names only — observer-only " +
                    "nodes have no screen of their own and are omitted whenever 'screen' is set. " +
                    "Ask unfiltered to see them.",
            )
        }
        if (noNodes) {
            add("No instrumented nodes recomposed in this window. Wrap a screen in PortholeScreen(\"Name\") { }.")
        }
        if (unattributed.any { it.holds != null } || nodes.any { n -> n.triggeredBy.any { it.holds != null } }) {
            add(
                "A key marked 'holds' is anonymous state carrying one of the app's own types, " +
                    "so it belongs to the app and was never registered. Register its owner and it " +
                    "gets a real name. Anonymous keys without 'holds' are usually Compose internals.",
            )
        }
        if (hasUnattributed) {
            add(
                "unattributedWrites are snapshot writes that no instrumented node followed. " +
                    "Usually state read by an uninstrumented subtree, or state nothing reads at all.",
            )
        }
    }

    companion object {
        private const val SAMPLE_CAPACITY = 8192

        /**
         * How often to look for a burst that has gone quiet.
         *
         * Half the burst's own quiet threshold, so a span closes within about
         * one threshold of the churn actually stopping rather than up to two.
         */
        private const val BURST_TICK_MS = 60L

        /**
         * Nodes returned when the caller does not say.
         *
         * A busy screen has hundreds of instrumented call sites and the
         * answer is always in the first few; the rest is weight on whoever
         * reads it.
         */
        private const val DEFAULT_NODE_LIMIT = 50
    }
}
