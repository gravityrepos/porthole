// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.integration

import android.os.Looper
import io.ktor.client.plugins.api.Send
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.http.content.ByteArrayContent
import io.ktor.http.content.TextContent
import live.gravitylabs.porthole.Porthole
import live.gravitylabs.porthole.collect.Setup
import live.gravitylabs.porthole.protocol.BodyPreview

/**
 * Ktor client integration, for apps not on the OkHttp engine.
 *
 * An app using Ktor *with* the OkHttp engine can install the OkHttp porthole on
 * that engine's client instead and get more: OkHttp exposes the whole call
 * lifecycle, so DNS, connect and TLS show up as phases. This plugin sits above
 * the engine, where the only honest boundary is "the call started" and "the
 * call finished", so that is what it reports.
 *
 * ```kotlin
 * HttpClient(CIO) {
 *     install(KtorPorthole.plugin)
 * }
 * ```
 *
 * Response bodies are deliberately not captured. Ktor hands the body over as a
 * channel the caller is expected to consume exactly once, and a tee that gets
 * it wrong breaks the app being debugged — which is a far worse outcome than a
 * missing preview. Request bodies are captured when they are already in memory.
 */
object KtorPorthole {

    /** Marks the header values that never belong in a trace. */
    private val REDACTED = BodyCapture.DEFAULT_REDACTED_HEADERS

    /**
     * The plugin to install. Prefer [portholeKtor], which reads better at
     * the call site:
     *
     * ```kotlin
     * HttpClient(CIO) { install(portholeKtor()) }
     * ```
     */
    val plugin = createClientPlugin("Porthole") {
        Setup.record("ktor")
        on(Send) { request ->
            val inflight = Porthole.inflight() ?: return@on proceed(request)

            val token = Any()
            val url = request.url.buildString()
            inflight.httpStart(token, request.method.value, url)
            inflight.httpThread(
                token,
                Looper.myLooper() != null && Looper.myLooper() == Looper.getMainLooper(),
            )
            inflight.httpRequest(token, headersOf(request), requestBody(request))

            try {
                val call = proceed(request)
                val response = call.response
                inflight.httpResponse(
                    token,
                    response.status.value,
                    response.headers.entries().associate { entry ->
                        entry.key to redact(entry.key, entry.value.joinToString(", "))
                    },
                    BodyPreview(
                        contentType = response.headers["Content-Type"],
                        byteCount = -1,
                        truncated = false,
                        omittedReason = "Ktor response bodies are read once by the caller; " +
                            "teeing one here would take it away from the app.",
                    ),
                )
                inflight.httpEnd(token, "done")
                call
            } catch (error: Throwable) {
                inflight.httpEnd(token, "failed", error.message ?: error::class.java.simpleName)
                throw error
            }
        }
    }

    private fun headersOf(request: HttpRequestBuilder): Map<String, String> =
        request.headers.entries().associate { entry ->
            entry.key to redact(entry.key, entry.value.joinToString(", "))
        }

    private fun redact(name: String, value: String): String =
        if (name.lowercase() in REDACTED) "*" else value

    /**
     * Only bodies already sitting in memory. Anything else is a channel, and
     * the rule about not consuming the app's data applies to requests too.
     */
    private fun requestBody(request: HttpRequestBuilder): BodyPreview? {
        val body = request.body
        return when (body) {
            is TextContent -> BodyPreview(
                contentType = body.contentType.toString(),
                byteCount = body.text.length.toLong(),
                truncated = body.text.length > MAX_BODY_CHARS,
                text = body.text.take(MAX_BODY_CHARS),
            )

            is ByteArrayContent -> BodyPreview(
                contentType = body.contentType?.toString(),
                byteCount = body.bytes().size.toLong(),
                truncated = false,
                omittedReason = "binary",
            )

            else -> null
        }
    }

    private const val MAX_BODY_CHARS = 4096
}
