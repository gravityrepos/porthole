// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.integration

import android.content.Context
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkQuery
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.collect.InflightCollector
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.WorkJob
import live.gravitylabs.porthole.store.EventRing
import java.util.concurrent.TimeUnit

/**
 * WorkManager integration.
 *
 * Two questions, so two mechanisms. `inflight` asks what is pending right now,
 * which is a query against WorkManager's database. The timeline asks what ran
 * and when, which a query cannot answer honestly — a job that starts and
 * finishes between two calls leaves no trace of having existed.
 *
 * So the timeline side observes WorkManager's own change feed and opens a span
 * per attempt. Per attempt, not per job: a retry is usually the thing you are
 * hunting, and folding it into one long bar is exactly what hides it.
 *
 * An instance, not the stateless object this used to be. `observe()` used to
 * build its CoroutineScope as a local variable inside a top-level function and
 * `launch` a collector against it; nothing kept that scope, so nothing —
 * shutdown() included — could ever cancel it, and the flow subscription plus
 * the `inflight.workSupplier` closure it installed simply outlived every
 * session that created them. Holding scope and inflight as fields is what
 * gives [stop] something to undo, and constructing this only after
 * `androidx.work.WorkManager` is confirmed present (see [live.gravitylabs.porthole.Porthole.install])
 * is what keeps that safe: [allStates] touches [WorkInfo.State] in its
 * initializer, so building an instance in an app without work-runtime on the
 * classpath would throw before anything else ran.
 */
internal class WorkManagerPorthole {

    private val allStates = listOf(
        WorkInfo.State.ENQUEUED,
        WorkInfo.State.RUNNING,
        WorkInfo.State.SUCCEEDED,
        WorkInfo.State.FAILED,
        WorkInfo.State.BLOCKED,
        WorkInfo.State.CANCELLED,
    )

    private var scope: CoroutineScope? = null
    private var inflight: InflightCollector? = null

    fun install(context: Context, inflight: InflightCollector, ring: EventRing): Boolean {
        val manager = runCatching { WorkManager.getInstance(context) }.getOrNull() ?: return false
        this.inflight = inflight
        inflight.workSupplier = { query(manager) }
        // getWorkInfosFlow arrived in work 2.9. On an older version the app
        // still gets `inflight`; it just does not get the lane.
        runCatching { observe(manager, ring) }
        return true
    }

    /**
     * Undoes [install]: cancels the flow subscription this opened and detaches
     * the `inflight` query, so neither outlives the session that started them.
     * Safe to call whether or not [install] ever got as far as [observe] —
     * both fields are null until it does.
     */
    fun stop() {
        scope?.cancel()
        scope = null
        inflight?.workSupplier = null
        inflight = null
    }

    private fun observe(manager: WorkManager, ring: EventRing) {
        val newScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        scope = newScope
        val query = WorkQuery.Builder.fromStates(allStates).build()
        val tracker = AttemptTracker(ring)
        newScope.launch {
            manager.getWorkInfosFlow(query).collect { infos -> tracker.update(infos) }
        }
    }

    /**
     * Turns "here is every job and its state" into the edges between them.
     *
     * The first emission carries everything the database still remembers,
     * including jobs that finished long ago. Only a transition *into* RUNNING
     * opens a span, so that history seeds the tracker without inventing events.
     */
    private class Open(val spanId: String, val startedAt: Long, val attempt: Int)

    private inner class AttemptTracker(private val ring: EventRing) {

        private val states = HashMap<String, WorkInfo.State>()
        private val running = HashMap<String, Open>()

        fun update(infos: List<WorkInfo>) {
            val present = HashSet<String>()

            for (info in infos) {
                val key = info.id.toString()
                present += key
                states[key] = info.state
                val open = running[key]
                val restarted = open != null && open.attempt != info.runAttemptCount

                if (info.state == WorkInfo.State.RUNNING && (open == null || restarted)) {
                    if (open != null) close(key, open, info.state.name, info.runAttemptCount)
                    start(key, info)
                } else if (open != null && info.state != WorkInfo.State.RUNNING) {
                    close(key, open, info.state.name, info.runAttemptCount)
                }
            }

            // Pruned from the database while we still thought it was running.
            for (key in running.keys.toList()) {
                if (key !in present) close(key, running.getValue(key), "UNKNOWN", -1)
            }
        }

        private fun start(key: String, info: WorkInfo) {
            val open = Open(
                spanId = "work-$key-${info.runAttemptCount}",
                startedAt = nowMs(),
                attempt = info.runAttemptCount,
            )
            running[key] = open
            emit(
                "work_start",
                open.spanId,
                buildMap {
                    put("name", nameOf(info))
                    put("state", info.state.name)
                    put("attempt", info.runAttemptCount.toString())
                    put("workId", key)
                    tagsOf(info)?.let { put("tags", it) }
                },
            )
        }

        private fun close(key: String, open: Open, state: String, attempt: Int) {
            running.remove(key)
            emit(
                "work_end",
                open.spanId,
                buildMap {
                    put("state", state)
                    put("elapsedMs", (nowMs() - open.startedAt).toString())
                    // The span's own attempt, not the live one. WorkManager has
                    // already incremented the counter by the time a retry is
                    // observed, which would label the run that failed with the
                    // number of the run that replaces it.
                    put("attempt", open.attempt.toString())
                    if (attempt >= 0 && attempt != open.attempt) put("nextAttempt", attempt.toString())
                    put("workId", key)
                    // Back to ENQUEUED after running is WorkManager's Result.retry().
                    if (state == "ENQUEUED") put("retrying", "true")
                },
            )
        }

        private fun emit(event: String, id: String, fields: Map<String, String>) {
            ring.emit(
                event,
                JsonObject(
                    buildMap {
                        put("id", JsonPrimitive(id))
                        fields.forEach { (k, v) -> put(k, JsonPrimitive(v)) }
                    },
                ),
            )
        }
    }

    /** WorkManager tags every request with its worker class; that is the useful name. */
    private fun nameOf(info: WorkInfo): String =
        info.tags.firstOrNull { it.contains('.') }?.substringAfterLast('.')
            ?: info.tags.firstOrNull()
            ?: info.id.toString().take(8)

    /** The tags the app chose, as opposed to the class name WorkManager adds. */
    private fun tagsOf(info: WorkInfo): String? =
        info.tags.filterNot { it.contains('.') }.takeIf { it.isNotEmpty() }?.joinToString(", ")

    private fun query(manager: WorkManager): List<WorkJob> {
        val query = WorkQuery.Builder
            .fromStates(listOf(WorkInfo.State.ENQUEUED, WorkInfo.State.RUNNING, WorkInfo.State.BLOCKED))
            .build()
        val infos = manager.getWorkInfos(query).get(QUERY_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        return infos.map { info ->
            WorkJob(
                id = info.id.toString(),
                name = nameOf(info),
                state = info.state.name,
                tags = info.tags.toList(),
                runAttemptCount = info.runAttemptCount,
            )
        }
    }

    private companion object {
        const val QUERY_TIMEOUT_MS = 750L
    }
}
