// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.os.Looper
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.BodyPreview
import live.gravitylabs.porthole.protocol.DbQuery
import live.gravitylabs.porthole.protocol.HttpCall
import live.gravitylabs.porthole.protocol.Inflight
import live.gravitylabs.porthole.protocol.WorkJob
import live.gravitylabs.porthole.store.EventRing
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * The "what is this screen actually waiting on" collector.
 *
 * HTTP calls and database queries are tracked open-to-close, so the answer is a
 * live set rather than a log you have to reconstruct. WorkManager is polled at
 * request time because its state lives in another process anyway.
 */
internal class InflightCollector(private val ring: EventRing) {

    private class OpenHttp(
        val id: String,
        val method: String,
        val url: String,
        val startedAt: Long,
        @Volatile var phase: String,
    ) {
        @Volatile var status: Int? = null
        @Volatile var requestHeaders: Map<String, String> = emptyMap()
        @Volatile var responseHeaders: Map<String, String> = emptyMap()
        @Volatile var onMainThread: Boolean = false
        @Volatile var requestBody: BodyPreview? = null
        @Volatile var responseBody: BodyPreview? = null

        /** Identity of the system-trace slice. Matched on both at end. */
        @Volatile var traceName: String = ""
        @Volatile var traceCookie: Int = 0

        /**
         * A request body is observed as it is written to the socket, so its
         * preview is not final until the upload is. This resolves the current
         * state on demand, which is what makes "stuck halfway through a 2MB
         * upload" visible while it is still happening.
         *
         * It is a lambda rather than a type so that okio stays on the OkHttp
         * side of the fence; this class must stay loadable without it.
         */
        @Volatile var requestBodyProvider: (() -> BodyPreview?)? = null

        fun resolvedRequestBody(): BodyPreview? =
            requestBodyProvider?.let { runCatching(it).getOrNull() } ?: requestBody

        fun toDto(now: Long, phase: String = this.phase) = HttpCall(
            id = id,
            method = method,
            url = url,
            startedAt = startedAt,
            elapsedMs = now - startedAt,
            phase = phase,
            onMainThread = onMainThread,
            status = status,
            requestHeaders = requestHeaders,
            responseHeaders = responseHeaders,
            requestBody = resolvedRequestBody(),
            responseBody = responseBody,
        )
    }

    private class OpenQuery(
        val id: String,
        val sql: String,
        val args: List<String>,
        val startedAt: Long,
        val thread: String,
        val kind: String,
        val onMainThread: Boolean,
    ) {
        /** Identity of the system-trace slice. Matched on both at end. */
        @Volatile var traceName: String = ""
        @Volatile var traceCookie: Int = 0
    }

    private val http = ConcurrentHashMap<Any, OpenHttp>()
    private val queries = ConcurrentHashMap<String, OpenQuery>()
    private val recentHttp = ArrayDeque<HttpCall>()
    /** Queries that ran on the main thread, kept because each one is a defect. */
    private val mainThreadQueries = ArrayDeque<DbQuery>()
    private val mainThreadHttp = ArrayDeque<HttpCall>()
    private val mainThreadLock = Any()
    private val recentLock = Any()
    private val ids = AtomicLong(0)

    fun mainThreadQueries(from: Long?, to: Long?, limit: Int): List<DbQuery> = synchronized(mainThreadLock) {
        mainThreadQueries.filter { (from == null || it.startedAt >= from) && (to == null || it.startedAt <= to) }
    }.sortedByDescending { it.elapsedMs }.take(limit)

    fun clearMainThreadQueries() {
        synchronized(mainThreadLock) {
            mainThreadQueries.clear()
            mainThreadHttp.clear()
        }
    }

    /** Set by WorkManagerPorthole when androidx.work is present and initialised. */
    @Volatile
    var workSupplier: (() -> List<WorkJob>)? = null

    fun nextId(prefix: String): String = prefix + "-" + ids.incrementAndGet()

    // -- http --------------------------------------------------------------

    fun httpStart(token: Any, method: String, url: String) {
        val call = OpenHttp(nextId("http"), method, redact(url), nowMs(), "queued")
        http[token] = call
        emit("http_start", call.id, mapOf("method" to method, "url" to call.url))

        // Also into the system trace, so this call is visible in a Perfetto
        // capture rather than only in Porthole's own timeline.
        call.traceName = method + " " + call.url
        call.traceCookie = Atrace.nextCookie()
        Atrace.begin(call.traceName, call.traceCookie)
    }

    fun httpPhase(token: Any, phase: String) {
        http[token]?.let { it.phase = phase }
    }

    /** Called from the interceptor, which is the only place the body is reachable. */
    fun httpRequest(token: Any, headers: Map<String, String>, body: BodyPreview?) {
        http[token]?.let {
            it.requestHeaders = headers
            it.requestBody = body
        }
    }

    /**
     * Recorded from inside the interceptor rather than from callStart.
     *
     * callStart runs on whoever called enqueue, which is routinely the main
     * thread and says nothing about where the IO goes. The interceptor chain
     * runs on the thread actually doing the work, so this is the only point at
     * which the question has a meaningful answer.
     */
    fun httpThread(token: Any, onMainThread: Boolean) {
        val call = http[token] ?: return
        call.onMainThread = onMainThread
        if (onMainThread) {
            synchronized(mainThreadLock) {
                mainThreadHttp.addLast(call.toDto(nowMs()))
                while (mainThreadHttp.size > MAIN_THREAD_CAPACITY) mainThreadHttp.removeFirst()
            }
        }
    }

    fun mainThreadHttp(from: Long?, to: Long?, limit: Int): List<HttpCall> = synchronized(mainThreadLock) {
        mainThreadHttp.filter { (from == null || it.startedAt >= from) && (to == null || it.startedAt <= to) }
    }.sortedByDescending { it.elapsedMs }.take(limit)

    /**
     * Registers a body that is still being written. The provider is asked each
     * time the call is reported, so an upload in progress shows what has gone
     * out so far rather than nothing at all.
     */
    fun httpRequestBodyProvider(token: Any, provider: () -> BodyPreview?) {
        http[token]?.requestBodyProvider = provider
    }

    fun httpResponse(token: Any, status: Int, headers: Map<String, String>, body: BodyPreview?) {
        http[token]?.let {
            it.status = status
            it.responseHeaders = headers
            it.responseBody = body
        }
    }

    fun httpEnd(token: Any, phase: String, detail: String? = null) {
        val call = http.remove(token) ?: return
        Atrace.end(call.traceName, call.traceCookie)
        val now = nowMs()
        val dto = call.toDto(now, phase)

        synchronized(recentLock) {
            recentHttp.addLast(dto)
            while (recentHttp.size > RECENT_HTTP_CAPACITY) recentHttp.removeFirst()
        }

        emit(
            "http_end",
            call.id,
            buildMap {
                put("method", call.method)
                put("url", call.url)
                put("phase", phase)
                put("elapsedMs", (now - call.startedAt).toString())
                call.status?.let { put("status", it.toString()) }
                // Only a snippet on the timeline: full previews live in
                // `inflight.recentHttp`, so the event ring stays small.
                call.resolvedRequestBody()?.let { put("requestBody", it.snippet()) }
                call.responseBody?.let { put("responseBody", it.snippet()) }
                if (detail != null) put("detail", detail)
            },
        )
    }

    // -- db ----------------------------------------------------------------

    fun queryStart(sql: String, args: List<String>, kind: String = "read"): String {
        val id = nextId("db")
        // Identity, not the thread's name: a background thread can be called
        // "main" and the name proves nothing either way.
        val onMain = Looper.myLooper() != null && Looper.myLooper() == Looper.getMainLooper()
        val open = OpenQuery(
            id = id,
            sql = sql,
            args = args,
            startedAt = nowMs(),
            thread = Thread.currentThread().name,
            kind = kind,
            onMainThread = onMain,
        )
        queries[id] = open

        // The SQL, not the id: a slice in a Perfetto capture has to say what it
        // is without anything else to look it up in. Marked when it ran on the
        // main thread, since that is the reason anyone would be looking.
        open.traceName = (if (onMain) "db(main) " else "db ") + sql.collapse()
        open.traceCookie = Atrace.nextCookie()
        Atrace.begin(open.traceName, open.traceCookie)

        emit(
            "db_start",
            id,
            buildMap {
                put("sql", sql.collapse())
                put("kind", kind)
                if (onMain) put("onMainThread", "true")
                if (args.isNotEmpty()) put("args", args.joinToString(", "))
            },
        )
        return id
    }

    fun queryEnd(id: String, result: Long? = null, error: String? = null) {
        val q = queries.remove(id) ?: return
        Atrace.end(q.traceName, q.traceCookie)
        val elapsed = nowMs() - q.startedAt
        if (q.onMainThread) {
            synchronized(mainThreadLock) {
                mainThreadQueries.addLast(q.toDto(elapsed, done = true))
                while (mainThreadQueries.size > MAIN_THREAD_CAPACITY) mainThreadQueries.removeFirst()
            }
        }
        emit(
            "db_end",
            id,
            buildMap {
                put("sql", q.sql.collapse())
                put("kind", q.kind)
                put("elapsedMs", elapsed.toString())
                put("thread", q.thread)
                if (q.onMainThread) put("onMainThread", "true")
                if (q.args.isNotEmpty()) put("args", q.args.joinToString(", "))
                if (result != null) put("result", result.toString())
                if (error != null) put("error", error)
            },
        )
    }

    // -- report ------------------------------------------------------------

    fun capture(): Inflight {
        val now = nowMs()
        val work = runCatching { workSupplier?.invoke() ?: emptyList() }
        val notes = buildList {
            if (http.isEmpty() && queries.isEmpty() && work.getOrNull().isNullOrEmpty()) {
                add("Nothing in flight. Finished calls are in recentHttp and on the timeline as http_end / db_end events.")
            }
            if (workSupplier == null) {
                add("WorkManager not tracked: androidx.work is absent, or WorkManager was never initialised.")
            }
            work.exceptionOrNull()?.let { add("WorkManager query failed: " + it.message) }
        }

        return Inflight(
            capturedAt = now,
            http = http.values.sortedBy { it.startedAt }.map { it.toDto(now) },
            queries = queries.values
                .sortedBy { it.startedAt }
                .map { it.toDto(now - it.startedAt, done = false) },
            work = work.getOrDefault(emptyList()),
            recentHttp = synchronized(recentLock) { recentHttp.toList() },
            notes = notes,
        )
    }

    private fun OpenQuery.toDto(elapsedMs: Long, done: Boolean) = DbQuery(
        id = id,
        sql = sql.collapse(),
        args = args,
        startedAt = startedAt,
        elapsedMs = elapsedMs,
        thread = thread,
        done = done,
        onMainThread = onMainThread,
        kind = kind,
    )

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

    private fun BodyPreview.snippet(): String = when {
        text != null -> text.take(SNIPPET_CHARS) + if (text.length > SNIPPET_CHARS) "..." else ""
        omittedReason != null -> "<$omittedReason, $byteCount bytes>"
        else -> "<$byteCount bytes>"
    }

    /**
     * Query strings and URLs both tend to carry things you would not want in a
     * shared trace. Values in the query string go; the shape of the request,
     * which is the part worth seeing, stays.
     */
    private fun redact(url: String): String = Redaction.url(url)

    private fun String.collapse(): String = Redaction.collapseSql(this)

    companion object {
        private const val RECENT_HTTP_CAPACITY = 25
        private const val MAIN_THREAD_CAPACITY = 100
        private const val SNIPPET_CHARS = 512
    }
}
