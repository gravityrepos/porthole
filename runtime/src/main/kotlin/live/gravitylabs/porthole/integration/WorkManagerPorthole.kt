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
 */
internal object WorkManagerPorthole {

    private val ALL_STATES = listOf(
        WorkInfo.State.ENQUEUED,
        WorkInfo.State.RUNNING,
        WorkInfo.State.SUCCEEDED,
        WorkInfo.State.FAILED,
        WorkInfo.State.BLOCKED,
        WorkInfo.State.CANCELLED,
    )

    fun install(context: Context, inflight: InflightCollector, ring: EventRing): Boolean {
        val manager = runCatching { WorkManager.getInstance(context) }.getOrNull() ?: return false
        inflight.workSupplier = { query(manager) }
        // getWorkInfosFlow arrived in work 2.9. On an older version the app
        // still gets `inflight`; it just does not get the lane.
        runCatching { observe(manager, ring) }
        return true
    }

    private fun observe(manager: WorkManager, ring: EventRing) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val query = WorkQuery.Builder.fromStates(ALL_STATES).build()
        val tracker = AttemptTracker(ring)
        scope.launch {
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
    private class AttemptTracker(private val ring: EventRing) {

        private class Open(val spanId: String, val startedAt: Long, val attempt: Int)

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

    private const val QUERY_TIMEOUT_MS = 750L
}
