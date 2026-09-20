// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.integration

import android.os.Looper
import live.gravitylabs.porthole.Porthole
import live.gravitylabs.porthole.collect.Setup
import live.gravitylabs.porthole.protocol.BodyPreview
import okhttp3.Call
import okhttp3.Connection
import okhttp3.EventListener
import okhttp3.Handshake
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.Buffer
import okio.BufferedSink
import okio.ForwardingSink
import okio.buffer
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy

/**
 * OkHttp integration.
 *
 * Two hooks, because neither alone is enough:
 *
 *  - an [EventListener] for the phase a call is stuck in. "Waiting on response
 *    headers for 8 seconds" is usually the whole answer, and only the listener
 *    can see it.
 *  - an [Interceptor] for bodies, which the listener only ever sees as byte
 *    counts. Off by default; see [BodyCapture].
 */
object OkHttpPorthole {

    /**
     * Installs the porthole on a builder.
     *
     * A client can hold exactly one event listener factory: `eventListener()`
     * and `eventListenerFactory()` are mutually exclusive on
     * [OkHttpClient.Builder] and whichever was called last wins, silently. If
     * the app already set one before reaching this call, simply calling
     * [OkHttpClient.Builder.eventListenerFactory] here would replace it —
     * turning the app's own listener dark with nothing in the API to say why.
     *
     * [existing] is the explicit override for a caller that already knows its
     * own factory (or is installing [eventListenerFactory] directly, with no
     * builder in hand at all). Left `null` — the common case now — this reads
     * the builder's *own* current factory instead of asking the caller to
     * hand it back: [OkHttpClient.Builder] does not expose its
     * `eventListenerFactory` field itself (it is `internal`, mangled on the
     * JVM, unreachable from outside OkHttp's own module), but the
     * [OkHttpClient] it builds does, publicly. `build()` here is a cheap
     * snapshot of whatever the builder holds so far — it does not consume or
     * lock the builder, which keeps configuring normally afterward — and
     * whatever it returns (the app's own factory, or OkHttp's own
     * `EventListener.NONE`-producing default when nothing was set) becomes
     * the delegate [PortholeEventListener] calls through on every callback,
     * so an app with its own listener keeps receiving every one of them.
     *
     * QA F9: that `build()` is not the free peek it reads as. `OkHttpClient`'s
     * own constructor builds the platform's default trust manager and SSL
     * context — thrown away the instant this local `delegate` value goes out
     * of scope — and ends in a validity check that throws
     * `IllegalStateException` for a builder that is *momentarily* invalid:
     * `connectionSpecs(listOf(ConnectionSpec.CLEARTEXT))` called before a
     * later `protocols(...)` call narrows away the default HTTP/2, say,
     * would be perfectly valid once the app finished configuring the
     * builder, but invalid at the exact instant `installPorthole()` sits
     * between the two calls. Crashing the app's own `build()` from a line
     * that reads as a no-op is the one failure mode worse than losing the
     * app's own listener, so this is wrapped: an exception here means no
     * delegate rather than no client.
     *
     * QA F10: the other half of getting call order wrong — the app calling
     * `eventListener()`/`eventListenerFactory()` *after* this one, rather
     * than before it — cannot be caught here at all: by the time that later
     * call runs, this function has already returned. See
     * [PortholeInterceptor]'s own comment for how that direction is caught
     * instead, at the first request that actually proves it happened.
     */
    fun OkHttpClient.Builder.installPorthole(
        existing: EventListener.Factory? = null,
        bodies: BodyCapture = BodyCapture.Off,
    ): OkHttpClient.Builder {
        val delegate = existing ?: runCatching { build().eventListenerFactory }.getOrNull()
        eventListenerFactory(PortholeEventListener.factory(delegate))
        // Always added, even with bodies off. The interceptor is the only place
        // that runs on the thread doing the IO, so it is the only place that can
        // answer "did this block the UI"; with capture off it does nothing else.
        addInterceptor(PortholeInterceptor(bodies))
        Setup.record("okhttp")
        return this
    }

    /** Use this directly if you build your client somewhere awkward. */
    fun eventListenerFactory(delegate: EventListener.Factory? = null): EventListener.Factory =
        PortholeEventListener.factory(delegate)

    /** The body-capturing half on its own, if you already have a listener wired up. */
    fun bodyInterceptor(bodies: BodyCapture = BodyCapture.Text): Interceptor = PortholeInterceptor(bodies)
}

/**
 * What of a request and response body ends up in a trace.
 *
 * Off by default, and deliberately so. Bodies are the most sensitive thing the
 * porthole can touch and the most likely to end up pasted into a chat window: an
 * auth response carries tokens, a profile response carries personal data. Turn
 * it on per client, for the client you are actually debugging.
 *
 * Even when on, capture is bounded three ways: only text-shaped content types,
 * only the first [maxBytes], and never a one-shot or duplex body, because
 * reading one would consume the stream the call is about to send.
 */
class BodyCapture(
    /** Capture request bodies. */
    val request: Boolean = true,
    /** Capture response bodies. */
    val response: Boolean = true,
    /** Per body. The rest is dropped and the preview is marked truncated. */
    val maxBytes: Long = 4 * 1024,
    /** Header names replaced with `*`, matched case-insensitively. */
    val redactHeaders: Set<String> = DEFAULT_REDACTED_HEADERS,
    /** Content-type prefixes worth reading as text. Anything else is skipped. */
    val textContentTypes: List<String> = DEFAULT_TEXT_TYPES,
    /**
     * Content types never read, whatever [textContentTypes] says, because they
     * have no end. Peeking at a response body blocks until it has the bytes, so
     * peeking at an event stream would hang the call until something happened to
     * be pushed.
     */
    val streamingContentTypes: List<String> = DEFAULT_STREAMING_TYPES,
) {
    /** Whether this captures anything at all. */
    val enabled: Boolean get() = request || response

    internal fun isText(contentType: String?): Boolean {
        if (contentType == null) return false
        val lower = contentType.lowercase()
        if (streamingContentTypes.any { lower.startsWith(it) }) return false
        return textContentTypes.any { lower.startsWith(it) }
    }

    internal fun headers(headers: Headers): Map<String, String> =
        headers.names().associateWith { name ->
            if (name.lowercase() in redactHeaders) "*" else headers.values(name).joinToString(", ")
        }

    /** The presets, and the two ready-made configurations. */
    companion object {
        // Declaration order matters: companion properties initialise top to
        // bottom, so the constants have to exist before anything that reads them
        // as a default argument. With Off first, constructing it read a null
        // DEFAULT_REDACTED_HEADERS and threw on the non-null parameter.
        /**
         * Headers whose values never leave the process, replaced with `*`
         * before the event is built. Pass your own set to [BodyCapture] to
         * add to it; these are the ones that are always wrong to record.
         */
        val DEFAULT_REDACTED_HEADERS: Set<String> = setOf(
            "authorization",
            "proxy-authorization",
            "cookie",
            "set-cookie",
            "x-api-key",
            "x-auth-token",
        )

        /**
         * Content-type prefixes read as text. A body whose type is not one
         * of these is skipped rather than captured as bytes: an image or a
         * protobuf is noise in a timeline, and large.
         */
        val DEFAULT_TEXT_TYPES: List<String> = listOf(
            "application/json",
            "application/xml",
            "application/x-www-form-urlencoded",
            "application/graphql",
            "text/",
        )

        /** Open-ended streams. Reading one waits for traffic that may never come. */
        val DEFAULT_STREAMING_TYPES: List<String> = listOf(
            "text/event-stream",
            "application/grpc",
            "application/x-ndjson",
        )

        /** No bodies at all. Phases, timings, status codes and headers still flow. */
        val Off = BodyCapture(request = false, response = false)

        /** Both directions, text content types, 4KB each. */
        val Text = BodyCapture()
    }
}

internal class PortholeInterceptor(private val capture: BodyCapture) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val inflight = Porthole.inflight()
        // chain.call() is the same Call instance the EventListener keyed on, so
        // the two halves land on the same record without any correlation id.
        val token = chain.call()

        // QA F10: a client holds exactly one EventListener factory, and
        // OkHttpClient.Builder is last-call-wins, silently — if the app
        // called its own eventListener()/eventListenerFactory() *after*
        // installPorthole(), PortholeEventListener's factory was replaced
        // and never told. addInterceptor() (below, at install time) is a
        // *second*, independent builder call that nothing else on the
        // builder can collide with, so this interceptor is the one thing
        // still guaranteed to see every call regardless — and if
        // PortholeEventListener's own callStart never ran for this one
        // (isTracked would be true if it had), that silent replacement is
        // exactly what happened. Checked before this interceptor's own
        // no-op-when-untracked calls below, so the record happens once, on
        // the very first call it is ever true for.
        if (inflight != null && !inflight.isTracked(token)) {
            Setup.recordListenerReplaced()
        }

        // The chain runs on the thread doing the IO, so this is where the
        // question "is this blocking the UI" can actually be answered. OkHttp
        // throws NetworkOnMainThreadException for a synchronous call on the
        // main thread, so this should never fire — and if it does, something
        // has gone around OkHttp's own guard and is worth knowing about.
        inflight?.httpThread(token, Looper.myLooper() != null && Looper.myLooper() == Looper.getMainLooper())
        inflight?.httpRequest(token, capture.headers(request.headers), null)
        val response = chain.proceed(teeRequest(request, token))
        inflight?.httpResponse(
            token,
            response.code,
            capture.headers(response.headers),
            responsePreview(response),
        )
        return response
    }

    /**
     * Swaps the request body for one that copies the first [BodyCapture.maxBytes]
     * as they travel to the socket.
     *
     * Reading a body up front and re-sending it would work for a repeatable body
     * and fail for a one-shot one, and would serialise a large payload twice for
     * no reason. Watching the bytes go past costs one copy of the capped prefix,
     * consumes the source exactly once, and works the same either way.
     */
    private fun teeRequest(request: Request, token: Any): Request {
        if (!capture.request) return request
        val body = request.body ?: return request
        val inflight = Porthole.inflight() ?: return request

        // Duplex is the one genuine exception: the request body is written while
        // the response is being read, so there is no point at which it is a
        // finished thing to report.
        if (body.isDuplex()) {
            inflight.httpRequest(
                token,
                capture.headers(request.headers),
                BodyPreview(
                    body.contentType()?.toString(),
                    runCatching { body.contentLength() }.getOrDefault(-1L),
                    false,
                    null,
                    "duplex body: written while the response is read, never complete",
                ),
            )
            return request
        }

        val tee = TeeRequestBody(body, capture)
        inflight.httpRequestBodyProvider(token) { tee.preview() }
        return runCatching {
            request.newBuilder().method(request.method, tee).build()
        }.getOrDefault(request)
    }

    private fun responsePreview(response: Response): BodyPreview? {
        if (!capture.response) return null
        val body = response.body ?: return null
        val contentType = body.contentType()?.toString()
        val declared = body.contentLength()

        if (!capture.isText(contentType)) {
            return BodyPreview(contentType, declared, false, null, "content type not captured")
        }

        return runCatching {
            // peekBody buffers a copy; the real body is still untouched for the
            // caller to consume. Reading body.string() here would break the call.
            val text = response.peekBody(capture.maxBytes).string()
            BodyPreview(
                contentType = contentType,
                byteCount = if (declared >= 0) declared else text.length.toLong(),
                truncated = declared > capture.maxBytes || text.length.toLong() >= capture.maxBytes,
                text = text,
            )
        }.getOrElse {
            BodyPreview(contentType, declared, false, null, "could not read: " + it.message)
        }
    }
}

/**
 * Forwards a request body untouched while keeping a copy of its opening bytes.
 *
 * The source is read exactly once, by the real write, so a one-shot body is as
 * capturable as any other — the copy is made of bytes already on their way out,
 * not of a second pass over the source.
 */
internal class TeeRequestBody(
    private val delegate: RequestBody,
    private val capture: BodyCapture,
) : RequestBody() {

    private val copy = Buffer()
    private val lock = Any()
    private var total = 0L
    private var complete = false

    /** False for content types we forward without reading, so only the size is reported. */
    private val readable = capture.isText(delegate.contentType()?.toString())

    override fun contentType(): MediaType? = delegate.contentType()

    override fun contentLength(): Long = delegate.contentLength()

    override fun isOneShot(): Boolean = delegate.isOneShot()

    override fun isDuplex(): Boolean = delegate.isDuplex()

    override fun writeTo(sink: BufferedSink) {
        synchronized(lock) {
            // A retry (auth challenge, redirect, reused-connection failure) writes
            // the body again. Start clean so the preview is of this attempt.
            copy.clear()
            total = 0L
            complete = false
        }

        val tee = object : ForwardingSink(sink) {
            override fun write(source: Buffer, byteCount: Long) {
                synchronized(lock) {
                    val room = capture.maxBytes - copy.size
                    // copyTo is non-destructive: the bytes still go to the socket.
                    if (readable && room > 0) source.copyTo(copy, 0, minOf(room, byteCount))
                    total += byteCount
                }
                super.write(source, byteCount)
            }

            /** The caller owns the real sink; closing it here would end the request. */
            override fun close() = Unit
        }

        val buffered = tee.buffer()
        delegate.writeTo(buffered)
        // Flushes whatever is still buffered through write() above, then hits the
        // no-op close, leaving the caller's sink open.
        buffered.close()
        synchronized(lock) { complete = true }
    }

    fun preview(): BodyPreview = synchronized(lock) {
        val contentType = delegate.contentType()
        BodyPreview(
            contentType = contentType?.toString(),
            byteCount = total,
            truncated = total > copy.size,
            text = if (readable) {
                copy.clone().readString(contentType?.charset(Charsets.UTF_8) ?: Charsets.UTF_8)
            } else {
                null
            },
            omittedReason = when {
                !readable -> "content type not captured"
                !complete -> "still uploading"
                else -> null
            },
        )
    }
}

/**
 * GRA-66: DNS, connect, secure connect, header/body write and read timings,
 * connection reuse, protocol and byte counts — everything [EventListener]
 * itself can see, one call at a time.
 *
 * One instance per call: OkHttp's own contract for [EventListener.Factory]
 * is `create(call)` once per [Call], never reused across calls, so the phase
 * timestamps below are plain instance fields, not a map keyed by call the
 * way [Porthole.inflight]'s own [live.gravitylabs.porthole.collect.InflightCollector]
 * has to keep (it outlives any one call). `@Volatile` because OkHttp's own
 * contract only promises these callbacks run one at a time for a given call
 * — never that they run on the *same* thread throughout it (a redirect can
 * resume its next leg on a different connection's thread) — so a plain field
 * write is not guaranteed visible to a later read without it.
 *
 * QA F8: every one of [EventListener]'s 29 public callbacks is overridden
 * and delegated below, not only the 13 this class actually times. Seven were
 * missing before this fix — `connectionReleased`, `proxySelectStart`/`End`,
 * `satisfactionFailure`, `cacheHit`/`Miss`/`ConditionalHit` — and an app
 * chaining its own metrics listener onto this one (see `installPorthole`'s
 * own doc comment) simply never heard them: `connectionReleased` alone
 * unbalances every acquired/released pair such a listener keeps. See
 * `HttpPhasesTest`'s own reflective coverage test, which enumerates
 * [EventListener]'s public methods and fails if a future OkHttp version
 * adds one this class does not yet know about, rather than the two of them
 * silently drifting apart the way the named-13 version of that test could
 * not detect.
 *
 * `connect` and `secureConnect` are one pair that needs care: OkHttp fires
 * `secureConnectStart`/`secureConnectEnd` *between* `connectStart` and
 * `connectEnd`, so a naive `connectEnd - connectStart` would already include
 * the TLS handshake, and adding `secureConnectMs` on top would double-count
 * it. `connectMs` is therefore closed at `secureConnectStart` when there is
 * one (the raw TCP portion only) and left for `connectEnd`/`connectFailed`
 * to close otherwise (a plain HTTP connect, where there is no TLS phase to
 * subtract).
 *
 * QA F12: `dns` and `connect` are *accumulated* across every attempt, not
 * latched to the first or the last. `connectStart`/`connectEnd`/
 * `connectFailed` can each fire more than once for one call — a route
 * selector trying an IPv6 address, failing, then succeeding over IPv4 is
 * routine on cellular — and the old, latch-once version either kept a
 * failed attempt's own short duration (whichever failed first) or silently
 * discarded a real, successful attempt's time depending on which fired
 * first. [connectAttempts] on the wire says how many attempts contributed.
 *
 * `waiting` (QA F14: renamed from `responseHeaders`, to match [phase]'s own
 * live label above rather than the OkHttp callback name it happened to come
 * from) is the other one that needs care: measured empirically (a
 * MockWebServer response delayed with `setHeadersDelay`, `HttpPhasesTest`'s
 * own "phase breakdown sums to the call's own elapsed time" test), OkHttp
 * does *not* call `responseHeadersStart` until the response has actually
 * started arriving — the wait for a slow server elapses *before* that
 * callback fires, silently, in the gap between finishing the request and
 * `responseHeadersStart`. Timing this phase from `responseHeadersStart`
 * itself would therefore report a slow server as instant, which is the one
 * failure this whole feature exists to catch. `waitStartNanos` is set from
 * `requestHeadersEnd`/`requestBodyEnd` instead — the instant the request
 * actually finished sending, which is genuinely where the wait begins — and
 * only read, never written, from `responseHeadersStart`.
 *
 * QA F11: `queued` (`callStart` to the first of `dnsStart`/`connectStart`/
 * `connectionAcquired`) and `dispatch` (`connectionAcquired` to
 * `requestHeadersStart`) close the two gaps that made "the phases sum to
 * elapsed" false on a real device (675ms of phases against a 748ms call,
 * on an emulator run with no TLS and a warm connection pool — the two gaps
 * this fixes are exactly where the other 73ms was). `queued` is OkHttp's
 * own dispatcher: `maxRequestsPerHost` can hold a call back before any of
 * its `EventListener` callbacks fire at all, and that wait is as real as a
 * slow DNS lookup. `dispatch` is OkHttp's own exchange setup once a
 * connection exists but before anything has been written to it — not
 * network time, but still time neither `queued` nor `requestHeaders`
 * otherwise accounts for.
 *
 * QA F13: the header/body write/read phases (`requestHeaders`,
 * `requestBody`, `waiting`, `responseBody`) are *not* accumulated the way
 * `dns`/`connect` are — a redirect or an auth-challenge retry re-runs its
 * own request/response legs, and each one's callbacks simply overwrite the
 * last. Accepted rather than fixed: these phases describe the call's
 * *final* leg only, while [live.gravitylabs.porthole.collect.InflightCollector]'s
 * own `elapsedMs` still spans every leg. Documented here, in
 * `HttpCall.phases`'s own doc comment (`Protocol.kt`) and in the README's
 * HTTP section, all three asked to say the same thing.
 */
internal class PortholeEventListener(private val delegate: EventListener?) : EventListener() {

    @Volatile private var callStartNanos: Long? = null
    @Volatile private var dnsStartNanos: Long? = null
    @Volatile private var connectStartNanos: Long? = null
    @Volatile private var secureConnectStartNanos: Long? = null
    @Volatile private var connectionAcquiredNanos: Long? = null
    @Volatile private var requestHeadersStartNanos: Long? = null
    @Volatile private var requestBodyStartNanos: Long? = null
    @Volatile private var waitStartNanos: Long? = null
    @Volatile private var responseBodyStartNanos: Long? = null

    @Volatile private var queuedMs: Long? = null
    @Volatile private var dnsMs: Long? = null
    @Volatile private var connectMs: Long? = null
    @Volatile private var connectAttempts: Int = 0
    @Volatile private var secureConnectMs: Long? = null
    @Volatile private var dispatchMs: Long? = null
    @Volatile private var requestHeadersMs: Long? = null
    @Volatile private var requestBodyMs: Long? = null
    @Volatile private var waitingMs: Long? = null
    @Volatile private var responseBodyMs: Long? = null

    /**
     * Whether a `connectStart` has fired since the last `connectionAcquired`
     * — the tell for [reused]: a pooled connection is handed back at
     * `connectionAcquired` with no `dnsStart`/`connectStart` of its own,
     * while a fresh one always runs both first. Reset after each
     * `connectionAcquired` rather than left latched, so a call that retries
     * onto a *second*, genuinely new connection after an initial pooled one
     * (or vice versa) is not misjudged by whichever attempt happened first.
     */
    @Volatile private var connectAttempted: Boolean = false
    @Volatile private var reused: Boolean = false
    @Volatile private var protocolName: String? = null
    @Volatile private var requestBytes: Long? = null
    @Volatile private var responseBytes: Long? = null

    /**
     * QA F11: `queued` closes the moment any of the three callbacks that can
     * legitimately be the *first* sign of network activity fires —
     * idempotent, since only one of them ever actually is, per call.
     */
    private fun markQueuedEndIfFirst() {
        if (queuedMs != null) return
        queuedMs = elapsedMs(callStartNanos)
    }

    override fun callStart(call: Call) {
        delegate?.callStart(call)
        callStartNanos = System.nanoTime()
        val request = call.request()
        Porthole.inflight()?.httpStart(call, request.method, request.url.toString())
    }

    override fun proxySelectStart(call: Call, url: HttpUrl) {
        delegate?.proxySelectStart(call, url)
    }

    override fun proxySelectEnd(call: Call, url: HttpUrl, proxies: List<Proxy>) {
        delegate?.proxySelectEnd(call, url, proxies)
    }

    override fun dnsStart(call: Call, domainName: String) {
        delegate?.dnsStart(call, domainName)
        markQueuedEndIfFirst()
        dnsStartNanos = System.nanoTime()
        Porthole.inflight()?.httpPhase(call, "dns")
    }

    override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<InetAddress>) {
        delegate?.dnsEnd(call, domainName, inetAddressList)
        // QA F12: accumulated, not latched — a redirect to a second host
        // needs a second lookup, and the first one's time must not be
        // thrown away for it.
        elapsedMs(dnsStartNanos)?.let { dnsMs = (dnsMs ?: 0) + it }
        dnsStartNanos = null
    }

    override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
        delegate?.connectStart(call, inetSocketAddress, proxy)
        markQueuedEndIfFirst()
        connectAttempted = true
        connectStartNanos = System.nanoTime()
        Porthole.inflight()?.httpPhase(call, "connecting")
    }

    override fun secureConnectStart(call: Call) {
        delegate?.secureConnectStart(call)
        // See this class's own doc comment: this attempt's raw TCP portion
        // of `connect` ends here, before TLS's own phase begins. Cleared
        // (not just added) so connectEnd, which always fires after this for
        // the same attempt, does not also count it.
        elapsedMs(connectStartNanos)?.let {
            connectMs = (connectMs ?: 0) + it
            connectAttempts += 1
        }
        connectStartNanos = null
        secureConnectStartNanos = System.nanoTime()
    }

    override fun secureConnectEnd(call: Call, handshake: Handshake?) {
        delegate?.secureConnectEnd(call, handshake)
        elapsedMs(secureConnectStartNanos)?.let { secureConnectMs = (secureConnectMs ?: 0) + it }
        secureConnectStartNanos = null
    }

    override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?) {
        delegate?.connectEnd(call, inetSocketAddress, proxy, protocol)
        // Only contributes for a plain (non-TLS) attempt: a TLS one already
        // accounted its own share of connectMs at secureConnectStart and
        // cleared connectStartNanos there, so this is a no-op for it.
        elapsedMs(connectStartNanos)?.let {
            connectMs = (connectMs ?: 0) + it
            connectAttempts += 1
        }
        connectStartNanos = null
    }

    override fun connectFailed(
        call: Call,
        inetSocketAddress: InetSocketAddress,
        proxy: Proxy,
        protocol: Protocol?,
        ioe: IOException,
    ) {
        delegate?.connectFailed(call, inetSocketAddress, proxy, protocol, ioe)
        // QA F12: a failed attempt still counts — an IPv6 attempt that
        // failed before a IPv4 one succeeded is real time too, and must not
        // silently stand in for (or be overwritten by) the attempt that
        // actually worked.
        elapsedMs(connectStartNanos)?.let {
            connectMs = (connectMs ?: 0) + it
            connectAttempts += 1
        }
        connectStartNanos = null
    }

    override fun connectionAcquired(call: Call, connection: Connection) {
        delegate?.connectionAcquired(call, connection)
        markQueuedEndIfFirst()
        reused = !connectAttempted
        connectAttempted = false
        protocolName = runCatching { connection.protocol().toString() }.getOrNull()
        connectionAcquiredNanos = System.nanoTime()
    }

    override fun connectionReleased(call: Call, connection: Connection) {
        delegate?.connectionReleased(call, connection)
    }

    override fun requestHeadersStart(call: Call) {
        delegate?.requestHeadersStart(call)
        // QA F11: the gap between having a connection and starting to write
        // to it — OkHttp's own exchange setup, not network time, but still
        // real and otherwise unattributed.
        dispatchMs = elapsedMs(connectionAcquiredNanos)
        requestHeadersStartNanos = System.nanoTime()
        Porthole.inflight()?.httpPhase(call, "headers")
    }

    override fun requestHeadersEnd(call: Call, request: Request) {
        delegate?.requestHeadersEnd(call, request)
        requestHeadersMs = elapsedMs(requestHeadersStartNanos)
        // See this class's own doc comment on `waitStartNanos`:
        // tentatively, the wait for a response begins here — overwritten in
        // requestBodyEnd below when this request turns out to have a body.
        waitStartNanos = System.nanoTime()
    }

    override fun requestBodyStart(call: Call) {
        delegate?.requestBodyStart(call)
        requestBodyStartNanos = System.nanoTime()
    }

    override fun requestBodyEnd(call: Call, byteCount: Long) {
        delegate?.requestBodyEnd(call, byteCount)
        requestBodyMs = elapsedMs(requestBodyStartNanos)
        requestBytes = byteCount
        // The wait for a response cannot begin before the body finishes
        // sending — moves the mark requestHeadersEnd set provisionally.
        waitStartNanos = System.nanoTime()
    }

    override fun requestFailed(call: Call, ioe: IOException) {
        delegate?.requestFailed(call, ioe)
        if (requestBodyStartNanos != null && requestBodyMs == null) requestBodyMs = elapsedMs(requestBodyStartNanos)
    }

    override fun responseHeadersStart(call: Call) {
        delegate?.responseHeadersStart(call)
        // The server has the request and has not answered yet. When a call sits
        // here, the device is not the problem.
        Porthole.inflight()?.httpPhase(call, "waiting")
    }

    override fun responseHeadersEnd(call: Call, response: Response) {
        delegate?.responseHeadersEnd(call, response)
        waitingMs = elapsedMs(waitStartNanos)
    }

    override fun responseBodyStart(call: Call) {
        delegate?.responseBodyStart(call)
        responseBodyStartNanos = System.nanoTime()
        Porthole.inflight()?.httpPhase(call, "body")
    }

    override fun responseBodyEnd(call: Call, byteCount: Long) {
        delegate?.responseBodyEnd(call, byteCount)
        responseBodyMs = elapsedMs(responseBodyStartNanos)
        responseBytes = byteCount
    }

    override fun responseFailed(call: Call, ioe: IOException) {
        delegate?.responseFailed(call, ioe)
        if (responseBodyStartNanos != null && responseBodyMs == null) {
            responseBodyMs = elapsedMs(responseBodyStartNanos)
        }
    }

    override fun callEnd(call: Call) {
        delegate?.callEnd(call)
        reportPhases(call)
        Porthole.inflight()?.httpEnd(call, "done")
    }

    override fun callFailed(call: Call, ioe: IOException) {
        delegate?.callFailed(call, ioe)
        reportPhases(call)
        Porthole.inflight()?.httpEnd(call, "failed", ioe.javaClass.simpleName + ": " + ioe.message)
    }

    override fun canceled(call: Call) {
        delegate?.canceled(call)
        reportPhases(call)
        Porthole.inflight()?.httpEnd(call, "canceled")
    }

    override fun satisfactionFailure(call: Call, response: Response) {
        delegate?.satisfactionFailure(call, response)
    }

    override fun cacheHit(call: Call, response: Response) {
        delegate?.cacheHit(call, response)
    }

    override fun cacheMiss(call: Call) {
        delegate?.cacheMiss(call)
    }

    override fun cacheConditionalHit(call: Call, response: Response) {
        delegate?.cacheConditionalHit(call, response)
    }

    /**
     * Reported before [live.gravitylabs.porthole.collect.InflightCollector.httpEnd]
     * finalises the call — that method reads whatever
     * [live.gravitylabs.porthole.collect.InflightCollector.httpPhases] last set,
     * so the order between the two calls at each of the three call sites above
     * matters and is not incidental.
     */
    private fun reportPhases(call: Call) {
        val phases = buildMap {
            queuedMs?.let { put("queued", it) }
            dnsMs?.let { put("dns", it) }
            connectMs?.let { put("connect", it) }
            secureConnectMs?.let { put("secureConnect", it) }
            dispatchMs?.let { put("dispatch", it) }
            requestHeadersMs?.let { put("requestHeaders", it) }
            requestBodyMs?.let { put("requestBody", it) }
            waitingMs?.let { put("waiting", it) }
            responseBodyMs?.let { put("responseBody", it) }
        }
        Porthole.inflight()?.httpPhases(call, phases, reused, protocolName, requestBytes, responseBytes, connectAttempts)
    }

    private fun elapsedMs(startNanos: Long?): Long? =
        startNanos?.let { (System.nanoTime() - it) / 1_000_000 }

    companion object {
        fun factory(delegate: EventListener.Factory?): EventListener.Factory =
            EventListener.Factory { call -> PortholeEventListener(delegate?.create(call)) }
    }
}
