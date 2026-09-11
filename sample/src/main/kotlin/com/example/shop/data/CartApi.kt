// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package com.example.shop.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import live.gravitylabs.porthole.integration.BodyCapture
import live.gravitylabs.porthole.installPorthole
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.BufferedSink
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private val JSON = "application/json".toMediaType()

/**
 * The sample serves its own API from inside the app, so the demo is
 * self-contained and the same every time. The traffic is real OkHttp over a
 * real socket, which is the part that matters: it goes through the porthole's
 * interceptor and event listener exactly as a production client would.
 *
 * Point [baseUrl] at a real host and nothing else here changes.
 */
class CartApi {

    private val server = MockWebServer()
    private val ready = CountDownLatch(1)

    private val client: OkHttpClient = OkHttpClient.Builder()
        // Bodies are off by default. This is a sample app with fake data, so it
        // opts in; a real app would think about it first.
        .installPorthole(bodies = BodyCapture.Text)
        .build()

    init {
        // MockWebServer binds a socket, which is not allowed on the main thread.
        Thread({
            server.dispatcher = FakeBackend()
            server.start()
            ready.countDown()
        }, "sample-api").apply { isDaemon = true }.start()
    }

    /** Exposed so a worker can demonstrate calling the same host off an uninstrumented client. */
    fun endpoint(path: String): String = baseUrl() + path

    private fun baseUrl(): String {
        ready.await(5, TimeUnit.SECONDS)
        return server.url("/").toString().trimEnd('/')
    }

    suspend fun fetchCart(cartId: String): String = withContext(Dispatchers.IO) {
        get("${baseUrl()}/v1/carts/$cartId?include=items&token=secret-do-not-log")
    }

    suspend fun addItem(cartId: String, sku: String, qty: Int): String = withContext(Dispatchers.IO) {
        post(
            url = "${baseUrl()}/v1/carts/$cartId/items",
            body = """{"sku":"$sku","qty":$qty,"giftWrap":false}""".toRequestBody(JSON),
        )
    }

    /** Always fails with a 402, so there is a real error path on the timeline. */
    suspend fun checkout(cartId: String): String = withContext(Dispatchers.IO) {
        post(
            url = "${baseUrl()}/v1/checkout",
            body = """{"cartId":"$cartId","paymentMethodId":"pm_1QxT"}""".toRequestBody(JSON),
        )
    }

    /**
     * A streaming upload: the body is written from a source that can only be
     * read once. The old pre-read approach could not capture this; the tee can.
     */
    suspend fun uploadNote(cartId: String, note: String): String = withContext(Dispatchers.IO) {
        post("${baseUrl()}/v1/carts/$cartId/notes", OneShotBody(note))
    }

    /** A binary download, which body capture declines to read but still sizes. */
    suspend fun fetchThumbnail(sku: String): String = withContext(Dispatchers.IO) {
        get("${baseUrl()}/images/$sku.webp")
    }

    private fun get(url: String): String =
        client.newCall(Request.Builder().url(url).header("Authorization", "Bearer sk-live-do-not-log").build())
            .execute()
            .use { it.body?.string().orEmpty() }

    private fun post(url: String, body: RequestBody): String =
        client.newCall(
            Request.Builder().url(url).post(body)
                .header("Authorization", "Bearer sk-live-do-not-log")
                .build(),
        ).execute().use { it.body?.string().orEmpty() }

    fun shutdown() {
        runCatching { server.shutdown() }
    }
}

/** Reports itself as one-shot, so OkHttp will only ever write it once. */
private class OneShotBody(private val note: String) : RequestBody() {

    private val payload = """{"note":"$note","author":"james","attachments":[]}"""

    override fun contentType() = JSON

    override fun isOneShot(): Boolean = true

    override fun writeTo(sink: BufferedSink) {
        // Written in pieces, the way a streamed body actually arrives.
        payload.chunked(16).forEach { sink.writeUtf8(it) }
    }
}

private class FakeBackend : Dispatcher() {

    override fun dispatch(request: RecordedRequest): MockResponse {
        val path = request.path.orEmpty()
        Thread.sleep(LATENCY_MS)

        return when {
            path.endsWith(".webp") -> MockResponse()
                .setHeader("Content-Type", "image/webp")
                .setBody(okio.Buffer().write(ByteArray(48_213)))

            path.contains("/checkout") -> MockResponse()
                .setResponseCode(402)
                .setHeader("Content-Type", "application/json")
                .setBody(
                    """{"error":"card_declined","message":"Your card was declined.",""" +
                        """"declineCode":"insufficient_funds"}""",
                )

            path.contains("/notes") -> MockResponse()
                .setHeader("Content-Type", "application/json")
                .setBody("""{"ok":true}""")

            path.contains("/items") -> MockResponse()
                .setResponseCode(201)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"lineItemId":"li_8f21","cartTotalCents":9200}""")

            else -> MockResponse()
                .setHeader("Content-Type", "application/json")
                .setHeader("Set-Cookie", "session=do-not-log; HttpOnly")
                .setBody(
                    """{"id":"88213","itemCount":4,"totalCents":9200,"currency":"GBP",""" +
                        """"items":[{"sku":"mug-ceramic-01","name":"Ceramic Mug"}]}""",
                )
        }
    }

    private companion object {
        /** Enough that a call is visibly open when you ask `inflight`. */
        const val LATENCY_MS = 450L
    }
}
