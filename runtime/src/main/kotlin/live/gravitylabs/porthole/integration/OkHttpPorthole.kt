// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.integration

import android.os.Looper
import live.gravitylabs.porthole.Porthole
import live.gravitylabs.porthole.collect.Setup
import live.gravitylabs.porthole.protocol.BodyPreview
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.Headers
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.Buffer
import okio.BufferedSink
import okio.ForwardingSink
import okio.buffer
import java.io.IOException
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
     * A client can hold exactly one event listener factory, and the builder does
     * not expose the one already set, so pass yours in [existing] if you have
     * one and it will be called through to.
     */
    fun OkHttpClient.Builder.installPorthole(
        existing: EventListener.Factory? = null,
        bodies: BodyCapture = BodyCapture.Off,
    ): OkHttpClient.Builder {
        eventListenerFactory(PortholeEventListener.factory(existing))
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

internal class PortholeEventListener(private val delegate: EventListener?) : EventListener() {

    override fun callStart(call: Call) {
        delegate?.callStart(call)
        val request = call.request()
        Porthole.inflight()?.httpStart(call, request.method, request.url.toString())
    }

    override fun dnsStart(call: Call, domainName: String) {
        delegate?.dnsStart(call, domainName)
        Porthole.inflight()?.httpPhase(call, "dns")
    }

    override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
        delegate?.connectStart(call, inetSocketAddress, proxy)
        Porthole.inflight()?.httpPhase(call, "connecting")
    }

    override fun requestHeadersStart(call: Call) {
        delegate?.requestHeadersStart(call)
        Porthole.inflight()?.httpPhase(call, "headers")
    }

    override fun responseHeadersStart(call: Call) {
        delegate?.responseHeadersStart(call)
        // The server has the request and has not answered yet. When a call sits
        // here, the device is not the problem.
        Porthole.inflight()?.httpPhase(call, "waiting")
    }

    override fun responseBodyStart(call: Call) {
        delegate?.responseBodyStart(call)
        Porthole.inflight()?.httpPhase(call, "body")
    }

    override fun callEnd(call: Call) {
        delegate?.callEnd(call)
        Porthole.inflight()?.httpEnd(call, "done")
    }

    override fun callFailed(call: Call, ioe: IOException) {
        delegate?.callFailed(call, ioe)
        Porthole.inflight()?.httpEnd(call, "failed", ioe.javaClass.simpleName + ": " + ioe.message)
    }

    override fun canceled(call: Call) {
        delegate?.canceled(call)
        Porthole.inflight()?.httpEnd(call, "canceled")
    }

    companion object {
        fun factory(delegate: EventListener.Factory?): EventListener.Factory =
            EventListener.Factory { call -> PortholeEventListener(delegate?.create(call)) }
    }
}
