// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.integration

import android.app.Application
import live.gravitylabs.porthole.Porthole
import live.gravitylabs.porthole.installPorthole
import live.gravitylabs.porthole.protocol.HttpCall
import okhttp3.Call
import okhttp3.Connection
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.CopyOnWriteArrayList
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
        assertTrue("the 300ms server delay should show up as the dominant responseHeaders phase, got $phases", (phases["responseHeaders"] ?: 0) >= 250)
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

    // -- EM's fix: the app's own listener must keep hearing everything -------

    @Test
    fun `an app with its own EventListener still receives every callback`() {
        val seen = CopyOnWriteArrayList<String>()
        val recording = object : EventListener() {
            override fun callStart(call: Call) { seen += "callStart" }
            override fun dnsStart(call: Call, domainName: String) { seen += "dnsStart" }
            override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<InetAddress>) { seen += "dnsEnd" }
            override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) { seen += "connectStart" }
            override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?) {
                seen += "connectEnd"
            }
            override fun connectionAcquired(call: Call, connection: Connection) { seen += "connectionAcquired" }
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
            "requestHeadersStart", "requestHeadersEnd", "responseHeadersStart", "responseHeadersEnd",
            "responseBodyStart", "responseBodyEnd", "callEnd",
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
