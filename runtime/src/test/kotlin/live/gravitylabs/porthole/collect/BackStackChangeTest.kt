// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Navigation 3 hands its back stack over on every recomposition, so most
 * reports say nothing happened. Telling those apart from real moves is the
 * whole job.
 */
class BackStackChangeTest {

    @Test
    fun `an unchanged stack is not a navigation`() {
        assertNull(backStackChange(listOf("Home", "Cart"), listOf("Home", "Cart")))
    }

    @Test
    fun `the first destination starts the stack`() {
        assertEquals("start", backStackChange(emptyList(), listOf("Home")))
    }

    @Test
    fun `growing the stack is a push`() {
        assertEquals("push", backStackChange(listOf("Home"), listOf("Home", "Cart")))
    }

    @Test
    fun `shrinking it is a pop`() {
        assertEquals("pop", backStackChange(listOf("Home", "Cart"), listOf("Home")))
    }

    @Test
    fun `same depth with different entries is a replace`() {
        assertEquals("replace", backStackChange(listOf("Home", "Cart"), listOf("Home", "Checkout")))
    }

    @Test
    fun `emptying the stack is reported rather than ignored`() {
        // The app is on its way out; that is worth a mark on the timeline.
        assertEquals("empty", backStackChange(listOf("Home"), emptyList()))
    }

    @Test
    fun `a repeated destination at a new depth is still a push`() {
        assertEquals("push", backStackChange(listOf("Detail"), listOf("Detail", "Detail")))
    }
}
