// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package com.example.shop.ui

import android.content.Context
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.shop.data.CartApi
import com.example.shop.data.CartStore
import live.gravitylabs.porthole.Porthole
import com.example.shop.data.KtorApi
import com.example.shop.data.CartItem
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.io.File
import java.util.UUID

private val CATALOGUE = listOf(
    Triple("mug-ceramic-01", "Ceramic Mug", 1800),
    Triple("poster-a2-07", "A2 Poster", 2400),
    Triple("tote-canvas-03", "Canvas Tote", 3200),
    Triple("sticker-pack-12", "Sticker Pack", 450),
)

class CartViewModel(
    private val dao: CartStore,
    private val api: CartApi,
    private val cartId: String,
) : ViewModel() {

    /** Snapshot state, so writes to it are attributable by name. */
    var lastResponse by mutableStateOf("")
        private set

    var promoCode by mutableStateOf("")
        private set

    /**
     * Ticks every frame while [animating] is on. This is the sample's
     * deliberate performance problem: read it in the wrong place and every row
     * in the list recomposes sixty times a second.
     */
    var tick by mutableIntStateOf(0)
        private set

    var animating by mutableStateOf(false)
        private set

    /** Off by default, so the porthole has something bad to find. */
    var scopedReads by mutableStateOf(false)
        private set

    /**
     * A StateFlow, on purpose: its emissions are not snapshot writes, so the
     * recomposition attributor cannot see them unless the screen collects it
     * with collectAsNamedState.
     */
    val items: StateFlow<List<CartItem>> = dao.observe(cartId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val status = MutableStateFlow("idle")
    val statusFlow: StateFlow<String> = status

    fun toggleAnimation() {
        animating = !animating
        if (animating) {
            viewModelScope.launch {
                while (animating) {
                    tick++
                    delay(16)
                }
            }
        }
    }

    fun toggleScopedReads() {
        scopedReads = !scopedReads
    }

    fun addRandomItem() = viewModelScope.launch {
        val (sku, name, price) = CATALOGUE.random()
        Log.i(TAG, "adding " + sku + " to cart " + cartId)
        dao.insert(
            CartItem(
                id = sku + "-" + UUID.randomUUID().toString().take(4),
                cartId = cartId,
                name = name,
                qty = 1 + (0..3).random(),
                priceCents = price,
                addedAt = System.currentTimeMillis(),
            ),
        )
        lastResponse = api.addItem(cartId, sku, 1)
    }

    fun bumpQuantity(item: CartItem) = viewModelScope.launch {
        dao.setQuantity(item.id, item.qty + 1)
    }

    fun remove(item: CartItem) = viewModelScope.launch {
        dao.delete(item.id)
    }

    fun refresh() = viewModelScope.launch {
        status.value = "refreshing"
        lastResponse = api.fetchCart(cartId)
        dao.count(cartId)
        status.value = "idle"
    }

    fun checkout() = viewModelScope.launch {
        Porthole.mark("checkout")
        status.value = "checking out"
        lastResponse = api.checkout(cartId)
        status.value = "declined"
        // Logged with a throwable on purpose: a multi-line stack trace is the
        // case a naive log reader mangles into loose fragments.
        Log.e(TAG, "checkout failed for cart " + cartId, IllegalStateException("card_declined"))
    }

    fun uploadNote() = viewModelScope.launch {
        lastResponse = api.uploadNote(cartId, "gift wrap the mug")
    }

    fun fetchThumbnail() = viewModelScope.launch {
        lastResponse = "thumbnail: " + api.fetchThumbnail("mug-ceramic-01").length + " chars"
    }

    /**
     * Everything you are told not to do, on the main thread, on purpose: a
     * synchronous database read followed by a long block. The porthole should
     * report the query as main-thread work and the watchdog should catch the
     * stall with a stack pointing here.
     */
    fun blockTheMainThread() {
        // Marks a step on the timeline. A headless capture groups its findings
        // under this, so the stall below is reported as having happened here
        // rather than somewhere in a flat nine seconds.
        Porthole.mark("block the main thread")
        val items = dao.loadBlocking(cartId)
        Thread.sleep(450)
        lastResponse = "blocked the main thread reading " + items.size + " items"
    }

    /**
     * A synchronous disk **write** on the main thread, not a read: the
     * default `StrictMode` policy `porthole { strictMode.set(true) }`
     * installs deliberately leaves out `detectDiskReads()` (GRA-59's EM
     * re-scope — it is the single noisiest check StrictMode has, and
     * `db-on-main-thread` already covers the read that matters
     * categorically), so a plain `File.readText()` here would trip nothing
     * under that policy. `detectDiskWrites()` is on by default, so this is
     * what actually demonstrates a `strict_violation` finding end to end —
     * see `StrictModeTest` for the same shape exercised as a synthetic
     * violation, without a device.
     */
    fun triggerStrictModeViolation(context: Context) {
        Porthole.mark("strict mode: disk write on main")
        val file = File(context.filesDir, "strictmode-demo.txt")
        file.writeText("porthole strictmode demo " + System.currentTimeMillis())
        lastResponse = "wrote " + file.length() + " bytes synchronously on the main thread"
    }

    private val ktor = KtorApi()

    /** The same endpoint over Ktor's CIO engine, with no OkHttp in the path. */
    fun fetchWithKtor() {
        viewModelScope.launch {
            lastResponse = runCatching { ktor.fetchCart(api.endpoint(""), cartId) }
                .getOrElse { "ktor failed: " + it.message }
                .take(180)
        }
    }

    fun setPromo(code: String) {
        promoCode = code
    }

    override fun onCleared() {
        animating = false
    }

    private companion object {
        const val TAG = "CartViewModel"
    }
}
