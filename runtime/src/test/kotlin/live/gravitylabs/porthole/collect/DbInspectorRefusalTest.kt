// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The inspector reads. These are the statements it must refuse, and refusing
 * them is not a formality: the socket is loopback and debug-only, but that is
 * not a reason to let a viewer mutate the data it is trying to understand.
 */
class DbInspectorRefusalTest {

    private val inspector = DbInspector()

    private fun allowed(sql: String) = assertNull("should be allowed: $sql", inspector.refusalFor(sql))

    private fun refused(sql: String) =
        assertNotNull("should be refused: $sql", inspector.refusalFor(sql))

    @Test
    fun `allows a plain select`() {
        allowed("SELECT * FROM cart_items")
        allowed("select name, qty from cart_items where cartId = '1'")
    }

    @Test
    fun `allows a select spanning several lines`() {
        allowed("SELECT *\n  FROM cart_items\n  ORDER BY addedAt DESC")
    }

    @Test
    fun `allows a common table expression`() {
        allowed("WITH recent AS (SELECT * FROM cart_items) SELECT * FROM recent")
    }

    @Test
    fun `allows a trailing semicolon, which is habit rather than a second statement`() {
        allowed("SELECT 1;")
    }

    @Test
    fun `allows a read-only pragma`() {
        allowed("PRAGMA table_info(cart_items)")
        allowed("pragma user_version")
    }

    @Test
    fun `refuses a pragma that assigns`() {
        // No transaction would undo this one, so it is refused rather than
        // wrapped and hoped about.
        refused("PRAGMA user_version = 5")
    }

    @Test
    fun `refuses every statement that writes`() {
        refused("DELETE FROM cart_items")
        refused("UPDATE cart_items SET qty = 0")
        refused("INSERT INTO cart_items VALUES (1)")
        refused("DROP TABLE cart_items")
        refused("ALTER TABLE cart_items ADD COLUMN x TEXT")
        refused("CREATE TABLE evil (x TEXT)")
        refused("REPLACE INTO cart_items VALUES (1)")
        refused("VACUUM")
        refused("ATTACH DATABASE 'other.db' AS other")
    }

    @Test
    fun `refuses a write smuggled in after a select`() {
        refused("SELECT 1; DROP TABLE cart_items")
    }

    @Test
    fun `refuses a write hidden behind leading whitespace`() {
        refused("   \n\t DELETE FROM cart_items")
    }

    @Test
    fun `refuses an empty statement rather than running it`() {
        refused("")
        refused("   ")
        refused(";")
    }

    @Test
    fun `is not fooled by a table whose name starts with select`() {
        // "selective" is not "select": the rule matches on a word boundary.
        refused("selective_delete FROM x")
    }
}
