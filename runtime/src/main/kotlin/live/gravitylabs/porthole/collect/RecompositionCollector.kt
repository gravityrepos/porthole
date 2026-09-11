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
 *  - It counts the scopes you wrapped in `PortholeScreen` / `Modifier.portholeNode`.
 *    Compose exposes no public hook for "every recomposition in the tree", so
 *    an uninstrumented subtree is invisible, not zero.
 *  - Attribution is temporal, not causal. We know which state objects were
 *    written in the window before a recomposition, not which read of which
 *    state actually invalidated the scope. When several states change in the
 *    same frame, all of them are listed.
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
) {
    private class Sample(
        val nodeId: String,
        val name: String,
        val screen: String?,
        val t: Long,
        val triggers: List<String>,
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

    /** Called from a SideEffect, so: on the composition thread, once per pass. */
    fun onRecompose(nodeId: String, name: String, screen: String?, passCount: Int) {
        val t = now()
        // Before the attribution walk: this is two field writes, and it is
        // the part that has to survive being called thousands of times.
        burst.onRecompose()
        val triggers = snapshots.writesBefore(t, attributionWindowMs)
        synchronized(lock) {
            samples.addLast(Sample(nodeId, name, screen, t, triggers))
            while (samples.size > SAMPLE_CAPACITY) samples.removeFirst()
        }
        ring.emit(
            "recompose",
            JsonObject(
                mapOf(
                    "id" to JsonPrimitive(nodeId),
                    "name" to JsonPrimitive(name),
                    "screen" to (screen?.let { JsonPrimitive(it) } ?: JsonPrimitive("")),
                    "pass" to JsonPrimitive(passCount),
                    "triggeredBy" to JsonArray(triggers.map { JsonPrimitive(it) }),
                ),
            ),
        )
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
     * ago, roughly".
     */
    fun report(
        screen: String?,
        sinceMs: Long?,
        from: Long? = null,
        to: Long? = null,
        /** Busiest N nodes. The tail of a recomposition report is rarely the answer. */
        limit: Int? = null,
    ): RecompositionReport {
        val current = now()
        val start = when {
            from != null -> from
            sinceMs != null -> (current - sinceMs).coerceAtLeast(0L)
            else -> 0L
        }
        val end = to ?: current

        val window = synchronized(lock) {
            samples.filter { it.t >= start && it.t <= end && (screen == null || matches(it, screen)) }
        }

        val byNode = LinkedHashMap<String, MutableList<Sample>>()
        for (s in window) byNode.getOrPut(s.nodeId) { mutableListOf() } += s

        val nodes = byNode.values
            .map { group ->
                val counts = LinkedHashMap<String, Int>()
                for (s in group) for (k in s.triggers) counts[k] = (counts[k] ?: 0) + 1
                val head = group.first()
                RecompositionNode(
                    id = head.nodeId,
                    name = head.name,
                    screen = head.screen,
                    count = group.size,
                    firstAt = group.minOf { it.t },
                    lastAt = group.maxOf { it.t },
                    triggeredBy = counts.toWriteCounts(),
                )
            }
            .sortedByDescending { it.count }

        // Applied after sorting, so a limit keeps the busiest rather than
        // whichever nodes happened to be recorded first.
        val cap = limit?.coerceAtLeast(1) ?: DEFAULT_NODE_LIMIT
        val kept = nodes.take(cap)
        val dropped = nodes.size - kept.size

        val attributed = window.flatMapTo(HashSet()) { it.triggers }
        val unattributed = snapshots.writesBetween(start, end)
            .filterKeys { it !in attributed }
            .toWriteCounts()

        return RecompositionReport(
            since = start,
            now = end,
            nodes = kept,
            totalNodes = nodes.size,
            truncated = dropped > 0,
            unattributedWrites = unattributed,
            notes = buildNotes(nodes.isEmpty(), unattributed.isNotEmpty(), nodes, unattributed),
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
    ): List<String> = buildList {
        add(
            "Counts cover instrumented call sites only (PortholeScreen / Modifier.portholeNode). " +
                "An absent composable means uninstrumented, not zero recompositions.",
        )
        add(
            "triggeredBy is a temporal correlation: state written within " +
                attributionWindowMs + "ms before the recomposition. " +
                "Several states changing in one frame all get listed.",
        )
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
