// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Redaction is the one thing here that has to hold: a trace gets pasted into
 * tickets and chat, and a value that leaks cannot be un-leaked.
 */
class RedactionTest {

    @Test
    fun `leaves a url without a query alone`() {
        assertEquals(
            "http://localhost:4000/v1/carts/99001",
            Redaction.url("http://localhost:4000/v1/carts/99001"),
        )
    }

    @Test
    fun `keeps parameter names and removes every value`() {
        assertEquals(
            "http://h/v1/carts?include=*&token=*",
            Redaction.url("http://h/v1/carts?include=items&token=secret-do-not-log"),
        )
    }

    @Test
    fun `redacts a parameter it has never heard of`() {
        // The point of stripping everything: a deny-list is only as good as its
        // last update, and the time it is out of date is the time it matters.
        assertEquals(
            "http://h/x?surprise_new_field=*",
            Redaction.url("http://h/x?surprise_new_field=hunter2"),
        )
    }

    @Test
    fun `keeps a valueless flag as a name`() {
        assertEquals("http://h/x?debug", Redaction.url("http://h/x?debug"))
    }

    @Test
    fun `removes a value containing an equals sign entirely`() {
        assertEquals("http://h/x?jwt=*", Redaction.url("http://h/x?jwt=aaa=bbb=ccc"))
    }

    @Test
    fun `drops a trailing question mark with nothing after it`() {
        assertEquals("http://h/x", Redaction.url("http://h/x?"))
    }

    @Test
    fun `does not touch a value that is only in the path`() {
        // Path segments are the shape of the request and are the useful part.
        assertEquals("http://h/v1/carts/99001", Redaction.url("http://h/v1/carts/99001"))
    }

    @Test
    fun `collapses whitespace in a statement onto one line`() {
        assertEquals(
            "SELECT * FROM cart_items WHERE cartId = ?",
            Redaction.collapseSql("SELECT *\n  FROM cart_items\n  WHERE cartId = ?"),
        )
    }

    @Test
    fun `truncates a very long statement and says so`() {
        val long = "SELECT " + "x".repeat(1000)
        val collapsed = Redaction.collapseSql(long)

        assertEquals(403, collapsed.length)
        assertEquals(true, collapsed.endsWith("..."))
    }

    @Test
    fun `leaves a short statement untruncated`() {
        assertEquals("SELECT 1", Redaction.collapseSql("  SELECT 1  "))
    }

    // -- GRA-64: a LeakCanary trace goes through the same bounded path -------

    @Test
    fun `leaves a short leak trace untouched`() {
        val trace = "com.example.shop.LeakyActivity instance\n" +
            "Retaining 256.0 kB in 1 object"
        assertEquals(trace, Redaction.leakTrace(trace))
    }

    @Test
    fun `caps a very long leak trace and says so, the same shape collapseSql uses`() {
        val long = "== leakcanary ==\n" + "x".repeat(10_000)
        val capped = Redaction.leakTrace(long)

        assertEquals(6003, capped.length)
        assertTrue(capped.endsWith("..."))
    }
}
