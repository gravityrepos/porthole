// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package com.example.shop.data

import android.content.Context
import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.db.SqlSchema
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import live.gravitylabs.porthole.portholeSqliteFactory

/**
 * The same cart, on SQLDelight instead of Room.
 *
 * The only porthole-aware line is the `factory` argument to the driver. Nothing
 * else here knows the tool exists — which is the whole point of instrumenting
 * `SupportSQLiteOpenHelper` rather than an ORM: SQLDelight's Android driver is
 * built on the same layer Room is, so it gets the same timings, the same bound
 * values, and the same main-thread warnings for free.
 *
 * Deliberately hand-written SQL rather than SQLDelight's generated API. The
 * sample is demonstrating the porthole, and adding a code generator to it would
 * be a lot of machinery in the way of a one-line point.
 */
private val SCHEMA = object : SqlSchema<QueryResult.Value<Unit>> {
    override val version: Long = 1

    override fun create(driver: SqlDriver): QueryResult.Value<Unit> {
        driver.execute(
            null,
            "CREATE TABLE IF NOT EXISTS cart_items (" +
                "id TEXT NOT NULL PRIMARY KEY, " +
                "cartId TEXT NOT NULL, " +
                "name TEXT NOT NULL, " +
                "qty INTEGER NOT NULL, " +
                "priceCents INTEGER NOT NULL, " +
                "addedAt INTEGER NOT NULL)",
            0,
        )
        return QueryResult.Unit
    }

    override fun migrate(
        driver: SqlDriver,
        oldVersion: Long,
        newVersion: Long,
        vararg callbacks: app.cash.sqldelight.db.AfterVersion,
    ): QueryResult.Value<Unit> = QueryResult.Unit
}

private class SqlDelightCartStore(private val driver: SqlDriver) : CartStore {

    override val engine = "SQLDelight"

    /**
     * SQLDelight's query notifications belong to its generated code, which this
     * sample does not use, so the flow is nudged after each write instead.
     */
    private val revision = MutableStateFlow(0)

    // The read goes to IO. Collecting happens on the main thread, and without
    // this the porthole correctly flags every refresh as a main-thread query —
    // which the sample has a dedicated button for doing on purpose.
    override fun observe(cartId: String): Flow<List<CartItem>> =
        revision.asStateFlow().map { withContext(Dispatchers.IO) { loadBlocking(cartId) } }

    override suspend fun count(cartId: String): Int = withContext(Dispatchers.IO) {
        driver.executeQuery(
            null,
            "SELECT COUNT(*) FROM cart_items WHERE cartId = ?",
            { cursor -> QueryResult.Value(if (cursor.next().value) cursor.getLong(0) ?: 0L else 0L) },
            1,
        ) { bindString(0, cartId) }.value.toInt()
    }

    override fun loadBlocking(cartId: String): List<CartItem> =
        driver.executeQuery(
            null,
            "SELECT id, cartId, name, qty, priceCents, addedAt FROM cart_items " +
                "WHERE cartId = ? ORDER BY addedAt DESC",
            { cursor ->
                val rows = mutableListOf<CartItem>()
                while (cursor.next().value) {
                    rows += CartItem(
                        id = cursor.getString(0).orEmpty(),
                        cartId = cursor.getString(1).orEmpty(),
                        name = cursor.getString(2).orEmpty(),
                        qty = (cursor.getLong(3) ?: 0L).toInt(),
                        priceCents = (cursor.getLong(4) ?: 0L).toInt(),
                        addedAt = cursor.getLong(5) ?: 0L,
                    )
                }
                QueryResult.Value(rows.toList())
            },
            1,
        ) { bindString(0, cartId) }.value

    override suspend fun insert(item: CartItem): Long = write {
        driver.execute(
            null,
            "INSERT OR REPLACE INTO cart_items (id, cartId, name, qty, priceCents, addedAt) " +
                "VALUES (?, ?, ?, ?, ?, ?)",
            6,
        ) {
            bindString(0, item.id)
            bindString(1, item.cartId)
            bindString(2, item.name)
            bindLong(3, item.qty.toLong())
            bindLong(4, item.priceCents.toLong())
            bindLong(5, item.addedAt)
        }.value
    }

    override suspend fun setQuantity(id: String, qty: Int): Int = write {
        driver.execute(null, "UPDATE cart_items SET qty = ? WHERE id = ?", 2) {
            bindLong(0, qty.toLong())
            bindString(1, id)
        }.value
    }.toInt()

    override suspend fun delete(id: String): Int = write {
        driver.execute(null, "DELETE FROM cart_items WHERE id = ?", 1) { bindString(0, id) }.value
    }.toInt()

    override suspend fun clear(cartId: String): Int = write {
        driver.execute(null, "DELETE FROM cart_items WHERE cartId = ?", 1) {
            bindString(0, cartId)
        }.value
    }.toInt()

    private suspend fun write(block: () -> Long): Long = withContext(Dispatchers.IO) {
        block().also { revision.value += 1 }
    }
}

fun createCartStore(context: Context): CartStore {
    val driver = AndroidSqliteDriver(
        schema = SCHEMA,
        context = context,
        name = "cart.db",
        // The only porthole-aware line in this file.
        factory = portholeSqliteFactory(),
    )
    return SqlDelightCartStore(driver)
}
