// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package com.example.shop.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import live.gravitylabs.porthole.portholeKtor

/**
 * The same cart endpoint, fetched with Ktor on the CIO engine.
 *
 * There is no OkHttp in this path at all, which is the point: it exercises the
 * Ktor plugin rather than the interceptor. One line installs it.
 */
class KtorApi {

    private val client = HttpClient(CIO) {
        install(portholeKtor())
    }

    suspend fun fetchCart(baseUrl: String, cartId: String): String = withContext(Dispatchers.IO) {
        client.get("$baseUrl/v1/carts/$cartId?include=items&token=secret-do-not-log") {
            header("Authorization", "Bearer sk-live-do-not-log")
        }.bodyAsText()
    }

    fun shutdown() {
        runCatching { client.close() }
    }
}
