// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package com.example.shop.data

import kotlinx.coroutines.flow.Flow

/**
 * The cart, independent of what is storing it.
 *
 * The sample ships two implementations behind this, chosen by product flavor:
 * Room in the `room` flavor and SQLDelight in the `sqldelight` one. They exist
 * to make a point — the porthole instruments `SupportSQLiteOpenHelper`, which is
 * the layer underneath both, so neither one needs the tool to know about it.
 *
 * Build either with `:sample:installRoomDebug` or `:sample:installSqldelightDebug`.
 */
data class CartItem(
    val id: String,
    val cartId: String,
    val name: String,
    val qty: Int,
    val priceCents: Int,
    val addedAt: Long,
)

interface CartStore {

    fun observe(cartId: String): Flow<List<CartItem>>

    suspend fun count(cartId: String): Int

    /** Deliberately blocking, for the "do not do this" button in the sample. */
    fun loadBlocking(cartId: String): List<CartItem>

    suspend fun insert(item: CartItem): Long

    suspend fun setQuantity(id: String, qty: Int): Int

    suspend fun delete(id: String): Int

    suspend fun clear(cartId: String): Int

    /** Which storage engine this build used, for the sample's own title bar. */
    val engine: String
}

// Each flavor declares `createCartStore(Context): CartStore` in its own source
// set under this package. Android flavors are not multiplatform, so there is no
// `expect` here: the declaration simply exists once per variant, and only one
// variant is ever compiled.
