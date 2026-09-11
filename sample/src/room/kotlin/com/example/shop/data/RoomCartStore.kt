// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package com.example.shop.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import live.gravitylabs.porthole.installPorthole

@Entity(tableName = "cart_items")
data class CartItemRow(
    @PrimaryKey val id: String,
    val cartId: String,
    val name: String,
    val qty: Int,
    val priceCents: Int,
    val addedAt: Long,
)

@Dao
interface CartDao {

    @Query("SELECT * FROM cart_items WHERE cartId = :cartId ORDER BY addedAt DESC")
    fun observe(cartId: String): Flow<List<CartItemRow>>

    @Query("SELECT COUNT(*) FROM cart_items WHERE cartId = :cartId")
    suspend fun count(cartId: String): Int

    @Query("SELECT * FROM cart_items WHERE cartId = :cartId ORDER BY addedAt DESC")
    fun loadBlocking(cartId: String): List<CartItemRow>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(item: CartItemRow): Long

    @Query("UPDATE cart_items SET qty = :qty WHERE id = :id")
    suspend fun setQuantity(id: String, qty: Int): Int

    @Query("DELETE FROM cart_items WHERE id = :id")
    suspend fun delete(id: String): Int

    @Query("DELETE FROM cart_items WHERE cartId = :cartId")
    suspend fun clear(cartId: String): Int
}

@Database(entities = [CartItemRow::class], version = 1, exportSchema = false)
abstract class CartDatabase : RoomDatabase() {
    abstract fun cartDao(): CartDao
}

private class RoomCartStore(private val dao: CartDao) : CartStore {

    override val engine = "Room"

    override fun observe(cartId: String): Flow<List<CartItem>> =
        dao.observe(cartId).map { rows -> rows.map { it.toItem() } }

    override suspend fun count(cartId: String): Int = dao.count(cartId)

    override fun loadBlocking(cartId: String): List<CartItem> =
        dao.loadBlocking(cartId).map { it.toItem() }

    override suspend fun insert(item: CartItem): Long = dao.insert(item.toRow())

    override suspend fun setQuantity(id: String, qty: Int): Int = dao.setQuantity(id, qty)

    override suspend fun delete(id: String): Int = dao.delete(id)

    override suspend fun clear(cartId: String): Int = dao.clear(cartId)
}

private fun CartItemRow.toItem() = CartItem(id, cartId, name, qty, priceCents, addedAt)

private fun CartItem.toRow() = CartItemRow(id, cartId, name, qty, priceCents, addedAt)

fun createCartStore(context: Context): CartStore {
    val database = Room.databaseBuilder(context, CartDatabase::class.java, "cart.db")
        // One line. Every query and write from here on is timed open-to-close,
        // with its bound values recorded.
        .installPorthole()
        // A demo of a bug, so the bug has to be possible: Room refuses
        // main-thread queries by default, and the sample needs one to show the
        // porthole catching it.
        .allowMainThreadQueries()
        .build()

    return RoomCartStore(database.cartDao())
}
