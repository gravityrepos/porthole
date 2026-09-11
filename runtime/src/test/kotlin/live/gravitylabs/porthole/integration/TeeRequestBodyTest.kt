// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.integration

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import okio.BufferedSink
import okio.Source
import okio.buffer
import okio.source
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream

/**
 * The tee forwards a request body to the socket while keeping a copy of its
 * opening bytes. Whether it actually does that is not something reading the
 * code can settle, so these run against a real client and a real socket.
 *
 * The property that matters most is the boring one: the server must receive
 * exactly what it would have received without the porthole installed.
 */
class TeeRequestBodyTest {

    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = OkHttpClient.Builder().build()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `one-shot body is delivered intact and still captured`() {
        val payload = """{"sku":"mug-ceramic-01","qty":2}"""
        val tee = TeeRequestBody(oneShotBody(payload), BodyCapture.Text)

        // The thing the old pre-read approach could not do.
        assertTrue("body should still report itself as one-shot", tee.isOneShot())

        post(tee)

        assertEquals(payload, server.takeRequest().body.readUtf8())

        val preview = tee.preview()
        assertEquals(payload, preview.text)
        assertEquals(payload.length.toLong(), preview.byteCount)
        assertEquals(false, preview.truncated)
        assertNull(preview.omittedReason)
    }

    @Test
    fun `repeatable body is delivered intact and captured`() {
        val payload = """{"cartId":"88213"}"""
        val tee = TeeRequestBody(payload.asJsonBody(), BodyCapture.Text)

        post(tee)

        assertEquals(payload, server.takeRequest().body.readUtf8())
        assertEquals(payload, tee.preview().text)
    }

    @Test
    fun `body larger than maxBytes is truncated in the preview but sent whole`() {
        val payload = "x".repeat(64 * 1024)
        val capture = BodyCapture(maxBytes = 1024)
        val tee = TeeRequestBody(oneShotBody(payload), capture)

        post(tee)

        // Truncation is a property of the preview, never of what goes out.
        assertEquals(payload, server.takeRequest().body.readUtf8())

        val preview = tee.preview()
        assertEquals(1024, preview.text?.length)
        assertEquals(payload.length.toLong(), preview.byteCount)
        assertTrue("preview should be marked truncated", preview.truncated)
    }

    @Test
    fun `non-text body is sized but not read`() {
        val bytes = ByteArray(4096) { it.toByte() }
        val body = bytes.toRequestBody("image/png".toMediaType())
        val tee = TeeRequestBody(body, BodyCapture.Text)

        post(tee)

        assertEquals(bytes.size, server.takeRequest().body.size.toInt())

        val preview = tee.preview()
        assertNull(preview.text)
        assertEquals("content type not captured", preview.omittedReason)
        // Still worth knowing how big the upload was, which is more than the
        // declared content length gives you on a chunked request.
        assertEquals(bytes.size.toLong(), preview.byteCount)
    }

    @Test
    fun `event streams are excluded from capture`() {
        assertEquals(false, BodyCapture.Text.isText("text/event-stream"))
        assertEquals(false, BodyCapture.Text.isText("application/grpc+proto"))
        assertEquals(true, BodyCapture.Text.isText("application/json; charset=utf-8"))
    }

    @Test
    fun `preview during an unfinished upload says so`() {
        val tee = TeeRequestBody(oneShotBody("never sent"), BodyCapture.Text)
        val preview = tee.preview()
        assertEquals("still uploading", preview.omittedReason)
        assertEquals(0L, preview.byteCount)
    }

    @Test
    fun `a retried body reports the latest attempt`() {
        val payload = """{"attempt":"n"}"""
        val tee = TeeRequestBody(payload.asJsonBody(), BodyCapture.Text)

        post(tee)
        server.takeRequest()
        post(tee)
        server.takeRequest()

        // Not payload twice: each write starts from a clean copy.
        assertEquals(payload, tee.preview().text)
        assertEquals(payload.length.toLong(), tee.preview().byteCount)
    }

    // -- helpers -----------------------------------------------------------

    private fun post(body: RequestBody) {
        server.enqueue(MockResponse().setResponseCode(200))
        client.newCall(Request.Builder().url(server.url("/")).post(body).build())
            .execute()
            .use { it.body?.bytes() }
    }

    private fun String.asJsonBody(): RequestBody = toRequestBody("application/json".toMediaType())

    /**
     * A body backed by a stream, which is the shape that cannot be written
     * twice: OkHttp itself marks these one-shot.
     */
    private fun oneShotBody(text: String): RequestBody = object : RequestBody() {
        private val source: Source = ByteArrayInputStream(text.toByteArray()).source()

        override fun contentType() = "application/json".toMediaType()

        override fun isOneShot(): Boolean = true

        override fun writeTo(sink: BufferedSink) {
            source.buffer().use { sink.writeAll(it) }
        }
    }

    @Suppress("unused")
    private fun Buffer.utf8(): String = clone().readUtf8()
}
