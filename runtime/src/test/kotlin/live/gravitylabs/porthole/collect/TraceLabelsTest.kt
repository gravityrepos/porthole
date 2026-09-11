// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * An async section's name is a track. The property that matters is not that a
 * label reads nicely but that the number of distinct labels stays small: one
 * screen load produced ten of them when the statement was the name, and seven
 * of the ten were Room's invalidation triggers rather than the app's work.
 */
class TraceLabelsTest {

    @Test
    fun `names a query by what it does and to what`() {
        assertEquals(
            "db SELECT cart_items",
            TraceLabels.db("SELECT * FROM cart_items WHERE cartId = ? ORDER BY addedAt DESC", false),
        )
    }

    @Test
    fun `marks the main thread, which is the reason to look`() {
        assertTrue(TraceLabels.db("SELECT 1 FROM items", true).startsWith("db(main)"))
    }

    @Test
    fun `collapses statements that differ only in their arguments`() {
        // The point of the whole file: these are one row, not three.
        val labels = listOf(
            "SELECT * FROM cart_items WHERE cartId = 1",
            "SELECT * FROM cart_items WHERE cartId = 2",
            "SELECT name FROM cart_items WHERE addedAt > 900",
        ).map { TraceLabels.db(it, false) }.toSet()

        assertEquals(setOf("db SELECT cart_items"), labels)
    }

    @Test
    fun `collapses Room's invalidation plumbing to a handful`() {
        val labels = listOf(
            "DROP TRIGGER IF EXISTS `room_table_modification_trigger_cart_items_UPDATE`",
            "DROP TRIGGER IF EXISTS `room_table_modification_trigger_cart_items_DELETE`",
            "DROP TRIGGER IF EXISTS `room_table_modification_trigger_cart_items_INSERT`",
            "CREATE TEMP TRIGGER IF NOT EXISTS `room_table_modification_trigger_cart_items_UPDATE` AFTER UPDATE",
            "INSERT OR IGNORE INTO room_table_modification_log VALUES(0, 0)",
        ).map { TraceLabels.db(it, false) }.toSet()

        // Was five distinct tracks, and would be three per table per app.
        assertEquals(3, labels.size)
    }

    @Test
    fun `does not mistake a keyword for a table`() {
        // AFTER UPDATE ON log matched on UPDATE and captured "ON", which
        // shipped to a device as the label `db CREATE ON`.
        assertEquals(
            "db CREATE room_table_modification_log",
            TraceLabels.db(
                "CREATE TEMP TRIGGER IF NOT EXISTS `t` AFTER UPDATE ON room_table_modification_log BEGIN",
                false,
            ),
        )
    }

    @Test
    fun `falls back to the verb when there is no table to name`() {
        assertEquals("db BEGIN", TraceLabels.db("BEGIN DEFERRED TRANSACTION", false))
        assertEquals("db QUERY", TraceLabels.db("   ", false))
    }

    @Test
    fun `names a call by endpoint, not by request`() {
        assertEquals(
            "http GET api.example.com/checkout",
            TraceLabels.http("get", "https://api.example.com/checkout?token=*&cart=99001"),
        )
    }

    @Test
    fun `two calls to one endpoint share a track`() {
        val a = TraceLabels.http("GET", "https://api/cart?id=1")
        val b = TraceLabels.http("GET", "https://api/cart?id=2")
        assertEquals(a, b)
    }
}
