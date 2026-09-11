// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package com.example.shop

import android.app.Application
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.example.shop.data.CartApi
import com.example.shop.data.CartStore
import com.example.shop.data.createCartStore
import com.example.shop.data.SyncCartWorker

/**
 * Nothing here mentions the porthole.
 *
 * It installs itself on process start through androidx.startup, before the
 * first Activity exists, which is early enough to see the opening state writes.
 * The only porthole-aware code in this app is the one-line `installPorthole()` on the
 * OkHttp and Room builders and the register calls in MainActivity.
 */
class ShopApplication : Application() {

    lateinit var api: CartApi
        private set

    lateinit var store: CartStore
        private set

    override fun onCreate() {
        super.onCreate()
        api = CartApi()
        store = createCartStore(this)

        // Something for `inflight` to report under work.
        WorkManager.getInstance(this)
            .enqueue(OneTimeWorkRequestBuilder<SyncCartWorker>().build())
    }

    override fun onTerminate() {
        api.shutdown()
        super.onTerminate()
    }
}
