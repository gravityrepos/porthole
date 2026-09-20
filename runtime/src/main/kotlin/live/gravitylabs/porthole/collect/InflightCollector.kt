// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.os.Looper
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.BodyPreview
import live.gravitylabs.porthole.protocol.DbQuery
import live.gravitylabs.porthole.protocol.EventKinds
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
internal class InflightCollector(
    private val ring: EventRing,
    /** Substitutable for the same reason the event ring's clock is. */
    private val now: () -> Long = ::nowMs,
    /**
     * Whether the caller is on the main thread. Identity, not the thread's
     * name: a background thread can be called "main" and the name proves
     * nothing either way. Substitutable because a static Looper lookup is the
     * one thing standing between this collector and a unit test.
     */
    private val isMainThread: () -> Boolean = {
        Looper.myLooper() != null && Looper.myLooper() == Looper.getMainLooper()
    },
) {

    private class OpenHttp(
        val id: String,
        val method: String,
        val url: String,
        val startedAt: Long,
        @Volatile var phase: String,
    ) {
        /**
         * When the call finished, or null while it is still running. An open
         * call has no elapsed time of its own — it has however long it has been
         * going by the time somebody asks — and the difference matters to the
         * window: work that has not ended overlaps every window that opened
         * after it began.
         */
        @Volatile var endedAt: Long? = null

        @Volatile var status: Int? = null
        @Volatile var requestHeaders: Map<String, String> = emptyMap()
        @Volatile var responseHeaders: Map<String, String> = emptyMap()
        @Volatile var onMainThread: Boolean = false
        @Volatile var requestBody: BodyPreview? = null
        @Volatile var responseBody: BodyPreview? = null

        /** GRA-66: set once, from [PortholeEventListener], right before [httpEnd] finalises the call. See [HttpCall]'s own doc comments for what each field means. */
        @Volatile var phases: Map<String, Long> = emptyMap()
        @Volatile var reused: Boolean = false
        @Volatile var protocol: String? = null
        @Volatile var requestBytes: Long? = null
        @Volatile var responseBytes: Long? = null
        /** F12: how many `connectStart`s this call made — 1 for an ordinary connect, 2+ for a failover (IPv6 failed, IPv4 succeeded, say), 0 for a reused connection or one [phases] has nothing to say about at all. */
        @Volatile var connectAttempts: Int = 0

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
            elapsedMs = (endedAt ?: now) - startedAt,
            phase = phase,
            onMainThread = onMainThread,
            status = status,
            requestHeaders = requestHeaders,
            responseHeaders = responseHeaders,
            requestBody = resolvedRequestBody(),
            responseBody = responseBody,
            phases = phases,
            reused = reused,
            protocol = protocol,
            requestBytes = requestBytes,
            responseBytes = responseBytes,
            connectAttempts = connectAttempts,
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

    /**
     * The live objects, not snapshots of them.
     *
     * A main-thread call is noticed the moment the interceptor runs, which is
     * long before it finishes, so the DTO taken at that moment recorded an
     * elapsed time of about zero and never learned better — it also predated
     * the response headers and the body. Holding the open call means the report
     * shows what it has cost so far while it is still costing it, which is the
     * whole point of noticing.
     */
    private val mainThreadHttp = ArrayDeque<OpenHttp>()
    private val mainThreadLock = Any()
    private val recentLock = Any()
    private val ids = AtomicLong(0)

    /** See [Window.resolve] for what the three window arguments mean. */
    fun mainThreadQueries(sinceMs: Long?, from: Long?, to: Long?, limit: Int): List<DbQuery> =
        mainThreadQueries(Window.resolve(sinceMs, from, to, now()), limit)

    /**
     * Matched by overlap rather than by start time — see [Window.overlaps].
     * A query is only recorded here once it has ended, so its span is known.
     */
    fun mainThreadQueries(window: LongRange, limit: Int): List<DbQuery> = synchronized(mainThreadLock) {
        mainThreadQueries.filter { Window.overlaps(window, it.startedAt, it.startedAt + it.elapsedMs) }
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
        val call = OpenHttp(nextId("http"), method, redact(url), now(), "queued")
        http[token] = call
        emit(EventKinds.HTTP_START, call.id, mapOf("method" to method, "url" to call.url))

        // Also into the system trace, so this call is visible in a Perfetto
        // capture rather than only in Porthole's own timeline.
        // Endpoint, not request: a query string is per-call and would put every
        // call on a track of its own.
        call.traceName = TraceLabels.http(method, call.url)
        call.traceCookie = Atrace.nextCookie()
        Atrace.begin(call.traceName, call.traceCookie)
    }

    fun httpPhase(token: Any, phase: String) {
        http[token]?.let { it.phase = phase }
    }

    /**
     * F10: whether [httpStart] has already opened a record for [token] —
     * [live.gravitylabs.porthole.integration.PortholeInterceptor]'s own tell
     * that [live.gravitylabs.porthole.integration.PortholeEventListener]
     * actually saw this call's own `callStart`. It always has, unless a
     * later `eventListener()`/`eventListenerFactory()` call on the same
     * builder silently replaced the factory `installPorthole()` installed —
     * OkHttp's own last-call-wins, with no exception or callback to say so.
     */
    fun isTracked(token: Any): Boolean = http.containsKey(token)

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
                mainThreadHttp.addLast(call)
                while (mainThreadHttp.size > MAIN_THREAD_CAPACITY) mainThreadHttp.removeFirst()
            }
        }
    }

    /** See [Window.resolve] for what the three window arguments mean. */
    fun mainThreadHttp(sinceMs: Long?, from: Long?, to: Long?, limit: Int): List<HttpCall> =
        mainThreadHttp(Window.resolve(sinceMs, from, to, now()), limit)

    /**
     * Matched by overlap rather than by start time — see [Window.overlaps]. A
     * call still in flight has no end, so it belongs to every window that had
     * not already closed when it began: the request blocking the main thread
     * right now is not one to hide because it started before you asked.
     */
    fun mainThreadHttp(window: LongRange, limit: Int): List<HttpCall> {
        val at = now()
        return synchronized(mainThreadLock) {
            mainThreadHttp.filter { Window.overlaps(window, it.startedAt, it.endedAt) }.map { it.toDto(at) }
        }.sortedByDescending { it.elapsedMs }.take(limit)
    }

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

    /**
     * GRA-66: the `EventListener` phase breakdown, called from
     * [live.gravitylabs.porthole.integration.PortholeEventListener] once a
     * call is over — the listener is the only place any of this is
     * observable, the same reason [httpRequest]/[httpResponse] are fed from
     * the interceptor rather than computed here. A call with no listener
     * attached (nothing routes through OkHttp's own instrumentation — Ktor
     * without the OkHttp engine, say) simply never calls this, and every
     * field below keeps its default: empty phases, not reused, no protocol,
     * no byte counts — absence, never an invented zero.
     */
    fun httpPhases(
        token: Any,
        phases: Map<String, Long>,
        reused: Boolean,
        protocol: String?,
        requestBytes: Long?,
        responseBytes: Long?,
        connectAttempts: Int = 0,
    ) {
        http[token]?.let {
            it.phases = phases
            it.reused = reused
            it.protocol = protocol
            it.requestBytes = requestBytes
            it.responseBytes = responseBytes
            it.connectAttempts = connectAttempts
        }
    }

    fun httpEnd(token: Any, phase: String, detail: String? = null) {
        val call = http.remove(token) ?: return
        Atrace.end(call.traceName, call.traceCookie)
        val endedAt = now()
        // Freeze the body before the provider goes: it reads a buffer that
        // belongs to a request now over, and the main-thread deque holds this
        // object rather than a copy of it, so the reference would otherwise
        // outlive its usefulness.
        call.requestBody = call.resolvedRequestBody()
        call.requestBodyProvider = null
        call.endedAt = endedAt
        val dto = call.toDto(endedAt, phase)

        synchronized(recentLock) {
            recentHttp.addLast(dto)
            while (recentHttp.size > RECENT_HTTP_CAPACITY) recentHttp.removeFirst()
            stripOldBodies()
        }

        emit(
            EventKinds.HTTP_END,
            call.id,
            buildMap {
                put("method", call.method)
                put("url", call.url)
                put("phase", phase)
                put("elapsedMs", (endedAt - call.startedAt).toString())
                call.status?.let { put("status", it.toString()) }
                // Only a snippet on the timeline: full previews live in
                // `inflight.recentHttp`, so the event ring stays small.
                call.resolvedRequestBody()?.let { put("requestBody", it.snippet()) }
                call.responseBody?.let { put("responseBody", it.snippet()) }
                if (detail != null) put("detail", detail)
                // GRA-66: reused/protocol/byte counts are flat, like every
                // other field here; `phases` alone is nested (see `emit`'s
                // own `nested` parameter) because it is a breakdown, not a
                // single value — flattening it into `phaseDnsMs`,
                // `phaseConnectMs`, ... would just move the structure into
                // the key names instead of removing it.
                if (call.reused) put("reused", "true")
                call.protocol?.let { put("protocol", it) }
                call.requestBytes?.let { put("requestBytes", it.toString()) }
                call.responseBytes?.let { put("responseBytes", it.toString()) }
                // F12: only worth a row once there was more than the one,
                // ordinary attempt to count — 0 or 1 says nothing a reader
                // needs, and 1 is what "connect" alone already implies.
                if (call.connectAttempts > 1) put("connectAttempts", call.connectAttempts.toString())
            },
            nested = if (call.phases.isNotEmpty()) {
                mapOf("phases" to JsonObject(call.phases.mapValues { (_, ms) -> JsonPrimitive(ms) }))
            } else {
                emptyMap()
            },
        )
    }

    /**
     * GRA-66 F15: [RECENT_HTTP_CAPACITY] (200) exists so a window naming an
     * older call can still reach it, but a body preview is the expensive
     * part of an [HttpCall] — up to [BodyCapture.maxBytes] (4KB by default)
     * each way — and holding that for 8x as many calls as `recentHttp` ever
     * returns by default is real memory nobody asked to keep that far back
     * (~1.6MB worst case with [BodyCapture.Text]). Only the newest
     * [RECENT_HTTP_DEFAULT_LIMIT] (25) — what `recentHttp` already returns
     * unwindowed — keep their body previews; every older entry keeps every
     * other field (timings, sizes, headers, status, phases) and loses only
     * `requestBody`/`responseBody`, set back to `null` the same way "never
     * captured" already reads on the wire — absence, not a second, smaller
     * kind of preview.
     *
     * Must be called with [recentLock] already held — every caller here
     * already does, immediately after the size trim above, so this only
     * ever walks entries already known to fit in [RECENT_HTTP_CAPACITY].
     */
    private fun stripOldBodies() {
        val cutoff = recentHttp.size - RECENT_HTTP_DEFAULT_LIMIT
        if (cutoff <= 0) return
        val drained = ArrayList<HttpCall>(recentHttp.size)
        while (recentHttp.isNotEmpty()) drained += recentHttp.removeFirst()
        for ((index, call) in drained.withIndex()) {
            recentHttp.addLast(if (index < cutoff) call.strippedOfBodies() else call)
        }
    }

    private fun HttpCall.strippedOfBodies(): HttpCall =
        if (requestBody == null && responseBody == null) this else copy(requestBody = null, responseBody = null)

    // -- db ----------------------------------------------------------------

    fun queryStart(sql: String, args: List<String>, kind: String = "read"): String {
        val id = nextId("db")
        val onMain = isMainThread()
        val open = OpenQuery(
            id = id,
            sql = sql,
            args = args,
            startedAt = now(),
            thread = Thread.currentThread().name,
            kind = kind,
            onMainThread = onMain,
        )
        queries[id] = open

        // Verb and table rather than the statement. The name of an async
        // section is its track, so naming it after the SQL gave one screen load
        // ten tracks — seven of them Room's own invalidation triggers.
        open.traceName = TraceLabels.db(sql, onMain)
        open.traceCookie = Atrace.nextCookie()
        Atrace.begin(open.traceName, open.traceCookie)

        emit(
            EventKinds.DB_START,
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
        val elapsed = now() - q.startedAt
        if (q.onMainThread) {
            synchronized(mainThreadLock) {
                mainThreadQueries.addLast(q.toDto(elapsed, done = true))
                while (mainThreadQueries.size > MAIN_THREAD_CAPACITY) mainThreadQueries.removeFirst()
            }
        }
        emit(
            EventKinds.DB_END,
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

    /** See [Window.resolve] for what the three window arguments mean. Unwindowed (every default) reproduces the pre-GRA-66 behaviour exactly: the whole buffer, newest `limit` entries. */
    fun recentHttp(sinceMs: Long? = null, from: Long? = null, to: Long? = null, limit: Int = RECENT_HTTP_DEFAULT_LIMIT): List<HttpCall> =
        recentHttp(Window.resolve(sinceMs, from, to, now()), limit)

    /**
     * Matched by overlap, same rule as [mainThreadHttp] — see [Window.overlaps].
     * Every entry here has already ended (only [httpEnd] appends), so a call's
     * span is always known, unlike the still-open set [mainThreadHttp] also has
     * to account for.
     *
     * Newest first: "recent" is the word in the name, and a caller asking for
     * 25 out of a 200-deep buffer almost always means the last 25, not
     * whichever 25 happen to be oldest inside the window.
     */
    fun recentHttp(window: LongRange, limit: Int): List<HttpCall> = synchronized(recentLock) {
        recentHttp.filter { Window.overlaps(window, it.startedAt, it.startedAt + it.elapsedMs) }
    }.sortedByDescending { it.startedAt }.take(limit)

    fun capture(sinceMs: Long? = null, from: Long? = null, to: Long? = null, limit: Int = RECENT_HTTP_DEFAULT_LIMIT): Inflight {
        val at = now()
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
            capturedAt = at,
            http = http.values.sortedBy { it.startedAt }.map { it.toDto(at) },
            queries = queries.values
                .sortedBy { it.startedAt }
                .map { it.toDto(at - it.startedAt, done = false) },
            work = work.getOrDefault(emptyList()),
            // GRA-66: only recentHttp is windowed — `http`/`queries`/`work`
            // above are the live set, "what is happening right now," which a
            // window has no honest meaning for.
            recentHttp = recentHttp(sinceMs, from, to, limit),
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

    private fun emit(event: String, id: String, fields: Map<String, String>, nested: Map<String, JsonElement> = emptyMap()) {
        ring.emit(
            event,
            JsonObject(
                buildMap {
                    put("id", JsonPrimitive(id))
                    fields.forEach { (k, v) -> put(k, JsonPrimitive(v)) }
                    nested.forEach { (k, v) -> put(k, v) }
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
        // GRA-66: was 25 — the whole capacity, with no window on top. `recentHttp`
        // now takes sinceMs/from/to like every other tool here and defaults its
        // *return* to 25, but a caller quoting an older window (from a finding
        // that named it) must still be able to reach a call this deque dropped
        // under the old scheme. 200 is eight defaults' worth of headroom, the
        // same ratio `MAIN_THREAD_CAPACITY` already keeps over its own 25-ish
        // typical ask.
        private const val RECENT_HTTP_CAPACITY = 200
        /** GRA-66: what "the last 25 finished calls" meant before a window existed to ask for something else — still the default `limit` today. */
        const val RECENT_HTTP_DEFAULT_LIMIT = 25
        private const val MAIN_THREAD_CAPACITY = 100
        private const val SNIPPET_CHARS = 512
    }
}
