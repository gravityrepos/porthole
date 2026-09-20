// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.integration

import android.app.Application
import live.gravitylabs.porthole.Porthole
import live.gravitylabs.porthole.collect.Setup
import live.gravitylabs.porthole.installPorthole
import live.gravitylabs.porthole.protocol.HttpCall
import okhttp3.Call
import okhttp3.Connection
import okhttp3.Dispatcher
import okhttp3.EventListener
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.BufferedSink
import okio.Source
import okio.buffer
import okio.source
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.IOException
import java.lang.reflect.Modifier
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * GRA-66: [PortholeEventListener] against a real client and a real socket —
 * MockWebServer, not a mock of OkHttp itself, the same reason
 * `TeeRequestBodyTest` runs this way. Whether a phase's own duration is
 * right, whether a pooled connection really skips dns/connect, whether byte
 * counts survive a chunked response or a one-shot upload, and whether an
 * app's own `EventListener` keeps hearing every callback once the porthole
 * is chained onto it are none of them things reading the code can settle.
 *
 * `Porthole.install` is needed (rather than constructing an `InflightCollector`
 * directly) because [PortholeEventListener] reaches it through the same
 * `Porthole.inflight()` singleton accessor the real integration does — see
 * `StartupTest.kt`'s `FrameWiringTest` for the same pattern used for the
 * identical reason.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class HttpPhasesTest {

    private val app: Application get() = RuntimeEnvironment.getApplication()
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        Porthole.install(app, port = 0)
    }

    @After
    fun tearDown() {
        Porthole.shutdown()
        server.shutdown()
    }

    private fun client(existing: EventListener? = null): OkHttpClient =
        OkHttpClient.Builder()
            .apply { existing?.let { eventListener(it) } }
            .installPorthole()
            .build()

    private fun call(client: OkHttpClient, request: Request = Request.Builder().url(server.url("/")).build()): Response =
        client.newCall(request).execute()

    /** The one HttpCall `recentHttp` holds after the request this test just made completes. */
    private fun lastCall(): HttpCall = Porthole.inflight()!!.capture().recentHttp.last()

    /** `recentHttp` is newest-first (unwindowed default) — the call this test made most recently, when more than one is in flight at once. */
    private fun newestCall(): HttpCall = Porthole.inflight()!!.capture().recentHttp.first()

    // -- phase timings -------------------------------------------------------

    @Test
    fun `phase breakdown sums to the call's own elapsed time within a few ms`() {
        // setHeadersDelay stalls the server between receiving the request and
        // sending response headers back — the "waiting" phase, per the doc
        // comment on responseHeadersStart in OkHttpPorthole.kt.
        server.enqueue(MockResponse().setHeadersDelay(300, TimeUnit.MILLISECONDS).setBody("hi"))
        val client = client()

        // Measured independently of anything InflightCollector/HttpCall
        // itself reports, so this is a check against ground truth rather
        // than the code checking its own arithmetic against itself.
        val startedAt = System.nanoTime()
        call(client).use { it.body?.bytes() }
        val trueElapsedMs = (System.nanoTime() - startedAt) / 1_000_000

        val phases = lastCall().phases
        val summed = phases.values.sum()
        assertTrue(
            "summed phases ($summed from $phases) should land within a few ms of the true elapsed time (${trueElapsedMs}ms)",
            summed in (trueElapsedMs - 30)..(trueElapsedMs + 30),
        )
        // QA F14: renamed from "responseHeaders" to "waiting", to match the
        // live phase label (Porthole.inflight()?.httpPhase(call, "waiting"))
        // rather than the OkHttp callback name it happened to come from.
        assertTrue("the 300ms server delay should show up as the dominant waiting phase, got $phases", (phases["waiting"] ?: 0) >= 250)
    }

    @Test
    fun `a pooled connection reports no dns or connect time, and says reused`() {
        server.enqueue(MockResponse().setBody("first"))
        server.enqueue(MockResponse().setBody("second"))
        val client = client()

        call(client).use { it.body?.bytes() }
        val first = lastCall()
        assertFalse("the first call on a fresh client should not be reused", first.reused)
        assertTrue("the first call should have a real connect phase", first.phases.containsKey("connect"))

        call(client).use { it.body?.bytes() }
        val second = lastCall()
        assertTrue("the second call over the same client/host should reuse the pooled connection", second.reused)
        assertNull("a reused connection has no dns phase of its own", second.phases["dns"])
        assertNull("a reused connection has no connect phase of its own", second.phases["connect"])
    }

    @Test
    fun `protocol is reported once a connection is acquired`() {
        server.enqueue(MockResponse().setBody("hi"))
        call(client()).use { it.body?.bytes() }
        assertEquals("http/1.1", lastCall().protocol)
    }

    // -- QA F11: the dispatcher's own queue is real time too ------------------

    @Test
    fun `a dispatcher-queued call accounts the wait as its own queued phase, and phases still sum to elapsed`() {
        // maxRequestsPerHost = 1: the second call cannot start until the
        // first (deliberately slow) one finishes. Synchronous execute()
        // bypasses the dispatcher's own queueing entirely (OkHttp's own
        // documented behaviour), so this needs real async enqueue() calls —
        // the exact shape a real app's own connection-pool pressure takes,
        // and the one synchronous calls elsewhere in this file cannot
        // exercise at all.
        server.enqueue(MockResponse().setBodyDelay(200, TimeUnit.MILLISECONDS).setBody("first"))
        server.enqueue(MockResponse().setBody("second"))

        val client = client().newBuilder()
            .dispatcher(Dispatcher().apply { maxRequestsPerHost = 1 })
            .build()

        val firstDone = CountDownLatch(1)
        val secondDone = CountDownLatch(1)

        // Distinct paths so the two calls can be told apart afterward by
        // URL rather than by recentHttp's own ordering — that is keyed off
        // InflightCollector's `now()` (SystemClock.uptimeMillis(), a
        // Robolectric shadow with no promise of tracking real wall time
        // during a plain Thread.sleep()), which the phase timings below
        // (real System.nanoTime()) do not share a clock with.
        client.newCall(Request.Builder().url(server.url("/first")).build()).enqueue(
            object : okhttp3.Callback {
                override fun onResponse(call: Call, response: Response) {
                    response.use { it.body?.bytes() }
                    firstDone.countDown()
                }

                override fun onFailure(call: Call, e: IOException) = firstDone.countDown()
            },
        )
        // Gives the first call a moment to actually be admitted (not merely
        // enqueued) before the second arrives, so the second is the one
        // genuinely held back by maxRequestsPerHost rather than both racing
        // for the single slot together.
        Thread.sleep(30)

        // Measured independently of anything InflightCollector/HttpCall
        // itself reports, the same reason the plain phase-sum test above
        // does — ground truth, not the code checking its own arithmetic.
        val secondStartedAt = System.nanoTime()
        client.newCall(Request.Builder().url(server.url("/second")).build()).enqueue(
            object : okhttp3.Callback {
                override fun onResponse(call: Call, response: Response) {
                    response.use { it.body?.bytes() }
                    secondDone.countDown()
                }

                override fun onFailure(call: Call, e: IOException) = secondDone.countDown()
            },
        )

        assertTrue("first call never completed", firstDone.await(5, TimeUnit.SECONDS))
        assertTrue("second (queued) call never completed", secondDone.await(5, TimeUnit.SECONDS))
        val secondTrueElapsedMs = (System.nanoTime() - secondStartedAt) / 1_000_000

        val queuedCall = Porthole.inflight()!!.capture().recentHttp.first { it.url.endsWith("/second") }
        assertTrue(
            "the queued call should show real dispatcher-queue time, got ${queuedCall.phases}",
            (queuedCall.phases["queued"] ?: 0) >= 100,
        )
        val summed = queuedCall.phases.values.sum()
        assertTrue(
            "summed phases ($summed from ${queuedCall.phases}) should land within a few ms of the true " +
                "elapsed time (${secondTrueElapsedMs}ms)",
            summed in (secondTrueElapsedMs - 30)..(secondTrueElapsedMs + 30),
        )
    }

    // -- QA F12: connect/dns accumulate across attempts, never latch --------

    @Test
    fun `connect is accumulated across a failed attempt and a successful retry, not latched to either`() {
        // Drives PortholeEventListener directly through a two-attempt
        // connect sequence — the shape an IPv6-then-IPv4 failover takes —
        // rather than trying to force a real socket-level failure through
        // MockWebServer, which controls the server side, not the client's
        // own route selection.
        val listener = PortholeEventListener(null)
        val call = client().newCall(Request.Builder().url(server.url("/")).build())
        val addressA = InetSocketAddress.createUnresolved("2001:db8::1", 443)
        val addressB = InetSocketAddress.createUnresolved("127.0.0.1", 443)

        listener.callStart(call)

        // Attempt 1: fails after ~20ms.
        listener.connectStart(call, addressA, Proxy.NO_PROXY)
        Thread.sleep(20)
        listener.connectFailed(call, addressA, Proxy.NO_PROXY, null, IOException("unreachable"))

        // Attempt 2: succeeds after ~40ms.
        listener.connectStart(call, addressB, Proxy.NO_PROXY)
        Thread.sleep(40)
        listener.connectEnd(call, addressB, Proxy.NO_PROXY, Protocol.HTTP_1_1)
        listener.connectionAcquired(call, fakeConnection())

        listener.callEnd(call)

        val recorded = newestCall()
        assertEquals(
            "both attempts should count -- one failed, one succeeded",
            2,
            recorded.connectAttempts,
        )
        assertTrue(
            "connect should be the *sum* of both attempts (~60ms), not either one alone, got ${recorded.phases}",
            (recorded.phases["connect"] ?: 0) >= 55,
        )
    }

    /**
     * The previous test's second (successful) attempt goes through
     * `connectEnd`, whose own accumulation was never latched — so a
     * regression that latched *only* `connectFailed` (setting `connectMs`
     * once and never adding to it again) would still pass that test: the
     * first failed attempt sets the latch, the second, successful one
     * still adds its own share on top via the unaffected `connectEnd`, and
     * the sum comes out right by coincidence. Two *failed* attempts in a
     * row isolates `connectFailed`'s own accumulation specifically, with
     * nothing else able to paper over a regression in it.
     */
    @Test
    fun `two failed connect attempts in a row both contribute -- connectFailed's own accumulation, isolated`() {
        val listener = PortholeEventListener(null)
        val call = client().newCall(Request.Builder().url(server.url("/")).build())
        val addressA = InetSocketAddress.createUnresolved("2001:db8::1", 443)
        val addressB = InetSocketAddress.createUnresolved("2001:db8::2", 443)

        listener.callStart(call)

        listener.connectStart(call, addressA, Proxy.NO_PROXY)
        Thread.sleep(20)
        listener.connectFailed(call, addressA, Proxy.NO_PROXY, null, IOException("unreachable"))

        listener.connectStart(call, addressB, Proxy.NO_PROXY)
        Thread.sleep(25)
        listener.connectFailed(call, addressB, Proxy.NO_PROXY, null, IOException("unreachable"))

        listener.callFailed(call, IOException("both routes failed"))

        val recorded = newestCall()
        assertEquals(2, recorded.connectAttempts)
        assertTrue(
            "connect should sum both failed attempts (~45ms) -- a latch would show only the first (~20ms), " +
                "got ${recorded.phases}",
            (recorded.phases["connect"] ?: 0) >= 40,
        )
    }

    @Test
    fun `dns is accumulated too, not left holding only the last lookup`() {
        val listener = PortholeEventListener(null)
        val call = client().newCall(Request.Builder().url(server.url("/")).build())

        listener.callStart(call)
        listener.dnsStart(call, "first.example.com")
        Thread.sleep(15)
        listener.dnsEnd(call, "first.example.com", emptyList())
        // A redirect to a second host needs a second lookup.
        listener.dnsStart(call, "second.example.com")
        Thread.sleep(25)
        listener.dnsEnd(call, "second.example.com", emptyList())
        listener.connectStart(call, InetSocketAddress.createUnresolved("127.0.0.1", 443), Proxy.NO_PROXY)
        listener.connectEnd(call, InetSocketAddress.createUnresolved("127.0.0.1", 443), Proxy.NO_PROXY, Protocol.HTTP_1_1)
        listener.connectionAcquired(call, fakeConnection())
        listener.callEnd(call)

        val recorded = newestCall()
        assertTrue(
            "dns should sum both lookups (~40ms), not just the last one (~25ms), got ${recorded.phases}",
            (recorded.phases["dns"] ?: 0) >= 35,
        )
    }

    // -- byte counts (GRA-66's "a size, not a payload") -----------------------

    @Test
    fun `byte counts are right for a chunked response`() {
        // Several chunks at a small max chunk size, so this actually
        // exercises chunked transfer-encoding rather than a single frame.
        val payload = "x".repeat(9_000)
        server.enqueue(MockResponse().setChunkedBody(payload, 1_024))

        val response = call(client())
        val body = response.body?.bytes()

        assertEquals(payload.length, body?.size)
        assertEquals(
            "responseBytes should be the real decoded byte count, not the declared Content-Length " +
                "(chunked responses have none)",
            payload.length.toLong(),
            lastCall().responseBytes,
        )
    }

    @Test
    fun `byte counts are right for a one-shot streaming upload`() {
        // The exact case TeeRequestBodyTest's own "one-shot body is
        // delivered intact and still captured" test had to get right for
        // BodyCapture: a stream that can only be written once.
        server.enqueue(MockResponse().setBody("ok"))
        val payload = """{"sku":"mug-ceramic-01","qty":2}"""
        val request = Request.Builder().url(server.url("/")).post(oneShotBody(payload)).build()

        call(client(), request).use { it.body?.bytes() }

        assertEquals(payload.length.toLong(), lastCall().requestBytes)
    }

    @Test
    fun `a GET with no body reports no request byte count -- absence, not a fake zero`() {
        server.enqueue(MockResponse().setBody("hi"))
        call(client()).use { it.body?.bytes() }
        assertNull("a bodiless request never fires requestBodyEnd, so this must be null, not 0", lastCall().requestBytes)
    }

    // -- QA F9: a momentarily-invalid builder must not crash installPorthole --

    @Test
    fun `sanity check -- the invalid builder state F9 exploits really does throw, from verifyClientState() itself`() {
        // Establishes the premise the next test relies on: this specific
        // state is genuinely invalid, not merely assumed to be. The
        // builder's own interceptors() getter returns its live, mutable
        // backing list rather than a copy — Kotlin's own typing keeps a
        // null out of it through the public API, but nothing stops one
        // arriving some other way (a Java caller, a reflective interceptor
        // pipeline built up elsewhere) that OkHttpClient's own constructor,
        // ending in the private verifyClientState(), refuses at build()
        // time. This is that exact method, empirically confirmed rather
        // than assumed — see this file's own history for the two other
        // hypotheses (a CLEARTEXT-only connectionSpecs set, and the
        // deprecated single-arg sslSocketFactory() overload) that turned
        // out not to reproduce it at all.
        val builder = OkHttpClient.Builder()
        @Suppress("UNCHECKED_CAST")
        val interceptors = builder.interceptors() as MutableList<Any?>
        interceptors.add(null)
        try {
            builder.build()
            fail("expected build() to throw IllegalStateException for a null interceptor")
        } catch (e: IllegalStateException) {
            assertTrue("expected OkHttp's own null-interceptor message, got: ${e.message}", e.message.orEmpty().contains("interceptor", ignoreCase = true))
        }
    }

    @Test
    fun `a momentarily-invalid builder does not crash installPorthole -- falls back to no delegate`() {
        val builder = OkHttpClient.Builder()
        @Suppress("UNCHECKED_CAST")
        val interceptors = builder.interceptors() as MutableList<Any?>
        // Momentarily invalid, per the sanity check above: build() would
        // throw right now. installPorthole()'s own internal build() call —
        // the "free peek" at the builder's existing eventListenerFactory —
        // sits in exactly this gap.
        interceptors.add(null)

        // Must not throw, despite the builder being invalid right now.
        builder.installPorthole()

        // Fixing the mismatch afterward makes the builder valid again,
        // proving the invalidity above really was momentary, not permanent
        // — and that installPorthole() itself did not somehow leave the
        // builder worse off than it found it.
        interceptors.remove(null)
        val client = builder.build()
        assertNotNull(client)
    }

    // -- QA F10: installPorthole() called before the app's own listener -----

    @Test
    fun `installPorthole before the app's own eventListener -- last-call-wins replaces it, Setup says so, the app still gets every callback`() {
        server.enqueue(MockResponse().setBody("hi"))
        val builder = OkHttpClient.Builder()
        builder.installPorthole() // wired first...
        val seen = CopyOnWriteArrayList<String>()
        builder.eventListener(
            object : EventListener() {
                override fun callStart(call: Call) {
                    seen += "callStart"
                }
            },
        ) // ...then OkHttp's own last-call-wins silently replaces it.
        val client = builder.build()

        call(client).use { it.body?.bytes() }

        assertTrue("the app's own listener is now the only listener, so it should see callStart", seen.contains("callStart"))
        assertTrue(
            "Setup should record that installPorthole()'s own listener was replaced",
            Setup.report().any { it.name == "okhttp-listener" },
        )
    }

    // -- EM's fix: the app's own listener must keep hearing everything -------

    @Test
    fun `an app with its own EventListener still receives every callback`() {
        val seen = CopyOnWriteArrayList<String>()
        val recording = object : EventListener() {
            override fun callStart(call: Call) { seen += "callStart" }
            override fun dnsStart(call: Call, domainName: String) { seen += "dnsStart" }
            override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<java.net.InetAddress>) { seen += "dnsEnd" }
            override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) { seen += "connectStart" }
            override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?) {
                seen += "connectEnd"
            }
            override fun connectionAcquired(call: Call, connection: Connection) { seen += "connectionAcquired" }
            override fun connectionReleased(call: Call, connection: Connection) { seen += "connectionReleased" }
            override fun requestHeadersStart(call: Call) { seen += "requestHeadersStart" }
            override fun requestHeadersEnd(call: Call, request: Request) { seen += "requestHeadersEnd" }
            override fun responseHeadersStart(call: Call) { seen += "responseHeadersStart" }
            override fun responseHeadersEnd(call: Call, response: Response) { seen += "responseHeadersEnd" }
            override fun responseBodyStart(call: Call) { seen += "responseBodyStart" }
            override fun responseBodyEnd(call: Call, byteCount: Long) { seen += "responseBodyEnd" }
            override fun callEnd(call: Call) { seen += "callEnd" }
        }

        server.enqueue(MockResponse().setBody("hi"))
        // The app sets its own listener directly on the builder, the way it
        // already would in real code — installPorthole() runs after, with no
        // `existing` argument, which is the whole point of the EM fix: it
        // has to find this on its own rather than being told about it.
        call(client(existing = recording)).use { it.body?.bytes() }

        val expected = listOf(
            "callStart", "dnsStart", "dnsEnd", "connectStart", "connectEnd", "connectionAcquired",
            "connectionReleased", "requestHeadersStart", "requestHeadersEnd", "responseHeadersStart",
            "responseHeadersEnd", "responseBodyStart", "responseBodyEnd", "callEnd",
        )
        for (name in expected) {
            assertTrue("app's own listener should still have seen $name; saw $seen", seen.contains(name))
        }
    }

    @Test
    fun `porthole still reports its own phases when chained onto the app's own listener`() {
        // The other half of the same fix: chaining must not go one way only.
        server.enqueue(MockResponse().setBody("hi"))
        call(client(existing = object : EventListener() {})).use { it.body?.bytes() }
        assertTrue(lastCall().phases.containsKey("connect"))
    }

    // -- QA F8: every one of EventListener's public callbacks, not just 14 --

    /**
     * The test named above ("an app with its own EventListener still
     * receives every callback") asserts a hand-picked list — 13 names
     * before this ticket, 14 now — which can only ever catch a regression
     * in a callback someone remembered to add to that list. Seven were
     * missing entirely before QA F8 (`connectionReleased`,
     * `proxySelectStart`/`End`, `satisfactionFailure`, `cacheHit`/`Miss`/
     * `ConditionalHit`) and that exact test, unchanged, would have stayed
     * green throughout.
     *
     * This one instead enumerates [EventListener]'s own public methods by
     * reflection and invokes every one of them directly on a
     * [PortholeEventListener] wrapping a recording delegate — so a future
     * OkHttp version adding a 30th callback fails this test outright
     * (`argsFor` has nothing registered for it) rather than the two
     * silently drifting apart the way the named list could.
     */
    @Test
    fun `every public EventListener callback OkHttp declares reaches the delegate (F8)`() {
        val recording = RecordingEventListener()
        val listener = PortholeEventListener(recording)

        val methods = EventListener::class.java.declaredMethods
            .filter { Modifier.isPublic(it.modifiers) && !Modifier.isStatic(it.modifiers) && !it.isSynthetic }
        assertTrue(
            "sanity: EventListener should declare its usual ~29 callbacks, found ${methods.size}",
            methods.size >= 29,
        )

        val request = Request.Builder().url("https://example.com/").build()
        val call = client().newCall(request)
        val response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(200)
            .message("OK")
            .build()

        val unregistered = mutableListOf<String>()
        for (method in methods) {
            val args = argsFor(method.name, call, request, response) ?: run {
                unregistered += method.name
                null
            } ?: continue
            method.isAccessible = true
            method.invoke(listener, *args)
        }
        assertTrue(
            "OkHttp declares a callback this test has no arguments registered for: $unregistered — add it " +
                "to argsFor() here and override+delegate it on PortholeEventListener",
            unregistered.isEmpty(),
        )

        val expectedNames = methods.map { it.name }.toSet()
        assertEquals(
            "every EventListener callback OkHttp declares should have reached the recording delegate",
            expectedNames,
            recording.seen.toSet(),
        )
    }

    /** One argument list per [EventListener] method name — see the test above for why by name rather than by reflected parameter type. */
    private fun argsFor(name: String, call: Call, request: Request, response: Response): Array<Any?>? {
        val address = InetSocketAddress.createUnresolved("example.com", 443)
        return when (name) {
            "callStart", "requestHeadersStart", "requestBodyStart", "responseHeadersStart", "responseBodyStart",
            "secureConnectStart", "callEnd", "canceled", "cacheMiss",
            -> arrayOf(call)
            "proxySelectStart" -> arrayOf(call, request.url)
            "proxySelectEnd" -> arrayOf(call, request.url, listOf(Proxy.NO_PROXY))
            "dnsStart" -> arrayOf(call, "example.com")
            "dnsEnd" -> arrayOf(call, "example.com", emptyList<java.net.InetAddress>())
            "connectStart" -> arrayOf(call, address, Proxy.NO_PROXY)
            "secureConnectEnd" -> arrayOf(call, null)
            "connectEnd" -> arrayOf(call, address, Proxy.NO_PROXY, Protocol.HTTP_1_1)
            "connectFailed" -> arrayOf(call, address, Proxy.NO_PROXY, Protocol.HTTP_1_1, IOException("boom"))
            "connectionAcquired", "connectionReleased" -> arrayOf(call, fakeConnection())
            "requestHeadersEnd" -> arrayOf(call, request)
            "requestBodyEnd", "responseBodyEnd" -> arrayOf(call, 128L)
            "requestFailed", "responseFailed", "callFailed" -> arrayOf(call, IOException("boom"))
            "responseHeadersEnd", "satisfactionFailure", "cacheHit", "cacheConditionalHit" -> arrayOf(call, response)
            else -> null
        }
    }

    private fun fakeConnection(): Connection = object : Connection {
        override fun route(): okhttp3.Route = throw UnsupportedOperationException("not needed by anything this test exercises")
        override fun socket(): java.net.Socket = throw UnsupportedOperationException("not needed by anything this test exercises")
        override fun handshake() = null
        override fun protocol(): Protocol = Protocol.HTTP_1_1
    }

    // -- helpers ---------------------------------------------------------------

    /** A body backed by a stream, which is the shape that cannot be written twice — the same helper `TeeRequestBodyTest` defines for the identical reason. */
    private fun oneShotBody(text: String): RequestBody = object : RequestBody() {
        private val source: Source = ByteArrayInputStream(text.toByteArray()).source()

        override fun contentType() = "application/json".toMediaType()

        override fun isOneShot(): Boolean = true

        override fun writeTo(sink: BufferedSink) {
            source.buffer().use { sink.writeAll(it) }
        }
    }
}

/** Records every [EventListener] callback's own name — the delegate F8's reflective coverage test invokes every method against. */
private class RecordingEventListener : EventListener() {
    val seen = CopyOnWriteArrayList<String>()

    override fun callStart(call: Call) { seen += "callStart" }
    override fun proxySelectStart(call: Call, url: okhttp3.HttpUrl) { seen += "proxySelectStart" }
    override fun proxySelectEnd(call: Call, url: okhttp3.HttpUrl, proxies: List<Proxy>) { seen += "proxySelectEnd" }
    override fun dnsStart(call: Call, domainName: String) { seen += "dnsStart" }
    override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<java.net.InetAddress>) { seen += "dnsEnd" }
    override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) { seen += "connectStart" }
    override fun secureConnectStart(call: Call) { seen += "secureConnectStart" }
    override fun secureConnectEnd(call: Call, handshake: okhttp3.Handshake?) { seen += "secureConnectEnd" }
    override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?) { seen += "connectEnd" }
    override fun connectFailed(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?, ioe: IOException) {
        seen += "connectFailed"
    }
    override fun connectionAcquired(call: Call, connection: Connection) { seen += "connectionAcquired" }
    override fun connectionReleased(call: Call, connection: Connection) { seen += "connectionReleased" }
    override fun requestHeadersStart(call: Call) { seen += "requestHeadersStart" }
    override fun requestHeadersEnd(call: Call, request: Request) { seen += "requestHeadersEnd" }
    override fun requestBodyStart(call: Call) { seen += "requestBodyStart" }
    override fun requestBodyEnd(call: Call, byteCount: Long) { seen += "requestBodyEnd" }
    override fun requestFailed(call: Call, ioe: IOException) { seen += "requestFailed" }
    override fun responseHeadersStart(call: Call) { seen += "responseHeadersStart" }
    override fun responseHeadersEnd(call: Call, response: Response) { seen += "responseHeadersEnd" }
    override fun responseBodyStart(call: Call) { seen += "responseBodyStart" }
    override fun responseBodyEnd(call: Call, byteCount: Long) { seen += "responseBodyEnd" }
    override fun responseFailed(call: Call, ioe: IOException) { seen += "responseFailed" }
    override fun callEnd(call: Call) { seen += "callEnd" }
    override fun callFailed(call: Call, ioe: IOException) { seen += "callFailed" }
    override fun canceled(call: Call) { seen += "canceled" }
    override fun satisfactionFailure(call: Call, response: Response) { seen += "satisfactionFailure" }
    override fun cacheHit(call: Call, response: Response) { seen += "cacheHit" }
    override fun cacheMiss(call: Call) { seen += "cacheMiss" }
    override fun cacheConditionalHit(call: Call, response: Response) { seen += "cacheConditionalHit" }
}
