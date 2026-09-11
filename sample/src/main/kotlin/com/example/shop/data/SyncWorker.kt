// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package com.example.shop.data

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.example.shop.ShopApplication
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Background sync, planted with two things worth seeing on a timeline.
 *
 * It fails its first attempt, so the work lane shows a retry rather than one
 * clean bar. And it makes two HTTP calls to the same server: one through the
 * app's instrumented client, one through a client it built itself. Only the
 * first reaches the http lane, which is the point — capture follows the
 * OkHttpClient, not the thread the call happens to run on.
 */
class SyncCartWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    /** A client with no porthole on it, the way a worker often gets one from DI. */
    private val ownClient = OkHttpClient.Builder().build()

    override suspend fun doWork(): Result {
        val api = (applicationContext as ShopApplication).api

        // Instrumented: this one lands in the http lane.
        runCatching { api.fetchCart(CART_ID) }
            .onFailure { Log.w(TAG, "instrumented fetch failed", it) }

        // Uninstrumented: same host, same process, invisible to the probe.
        withContext(Dispatchers.IO) {
            runCatching {
                ownClient.newCall(Request.Builder().url(api.endpoint("/v1/carts/$CART_ID")).build())
                    .execute()
                    .use { it.body?.string() }
            }.onFailure { Log.w(TAG, "uninstrumented fetch failed", it) }
        }

        delay(RUN_FOR_MS)

        if (runAttemptCount < 1) {
            Log.w(TAG, "sync attempt $runAttemptCount failed, asking WorkManager to retry")
            return Result.retry()
        }

        Log.i(TAG, "sync succeeded on attempt $runAttemptCount")
        return Result.success()
    }

    private companion object {
        const val RUN_FOR_MS = 4_000L
        const val CART_ID = "99001"
        const val TAG = "SyncCartWorker"
    }
}
