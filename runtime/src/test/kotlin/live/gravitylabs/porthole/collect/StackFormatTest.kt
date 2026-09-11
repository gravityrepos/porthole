// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A stalled main thread is almost always sitting in Thread.sleep or a native
 * read. True, and not a line anyone can change. The first version of this
 * filtered the plumbing away and lost the frame that said what was being
 * waited on; it reorders instead.
 */
class StackFormatTest {

    private val app = listOf("com.example.shop")

    private fun frame(className: String, method: String = "m", line: Int = 1) =
        StackTraceElement(className, method, className.substringAfterLast('.') + ".kt", line)

    @Test
    fun `the app's own frames lead`() {
        val ordered = StackFormat.order(
            listOf(
                frame("java.lang.Thread", "sleep"),
                frame("com.example.shop.ui.CartViewModel", "blockTheMainThread"),
            ),
            app,
        )

        assertEquals("com.example.shop.ui.CartViewModel", ordered.first().className)
    }

    @Test
    fun `what was being waited on is kept, not dropped`() {
        val ordered = StackFormat.order(
            listOf(
                frame("java.lang.Thread", "sleep"),
                frame("com.example.shop.ui.CartViewModel", "blockTheMainThread"),
            ),
            app,
        )

        assertTrue(ordered.any { it.className == "java.lang.Thread" })
    }

    @Test
    fun `relative order within each group survives`() {
        val ordered = StackFormat.order(
            listOf(
                frame("android.os.Looper", "loop"),
                frame("com.example.shop.A", "first"),
                frame("com.example.shop.B", "second"),
                frame("android.app.ActivityThread", "main"),
            ),
            app,
        )

        assertEquals(
            listOf("first", "second", "loop", "main"),
            ordered.map { it.methodName },
        )
    }

    @Test
    fun `the machinery that took the sample is not in it`() {
        val ordered = StackFormat.order(
            listOf(
                frame("dalvik.system.VMStack", "getThreadStackTrace"),
                frame("java.lang.Thread", "getStackTrace"),
                frame("com.example.shop.A", "real"),
            ),
            app,
        )

        assertEquals(listOf("real"), ordered.map { it.methodName })
    }

    @Test
    fun `a stack that is entirely plumbing is kept rather than blanked`() {
        // Better a stack of framework frames than no stack at all.
        val plumbing = listOf(frame("dalvik.system.VMStack", "getThreadStackTrace"))

        assertEquals(1, StackFormat.order(plumbing, app).size)
    }

    @Test
    fun `a stack with none of the app's frames still reports`() {
        val ordered = StackFormat.order(
            listOf(frame("android.os.Binder", "transact"), frame("android.os.Looper", "loop")),
            app,
        )

        assertEquals(listOf("transact", "loop"), ordered.map { it.methodName })
    }

    @Test
    fun `a deep stack is capped`() {
        val deep = (1..50).map { frame("android.thing.Class$it") }

        assertEquals(StackFormat.MAX_FRAMES, StackFormat.order(deep, app).size)
    }

    @Test
    fun `the cap does not cut off the app's frames`() {
        // The app's frames are hoisted before the cap applies, so a stall deep
        // under forty framework frames still names the app code that caused it.
        val deep = (1..40).map { frame("android.thing.Class$it") } +
            frame("com.example.shop.Deep", "buried")

        val ordered = StackFormat.order(deep, app)
        assertEquals("buried", ordered.first().methodName)
    }

    @Test
    fun `an empty stack yields nothing rather than throwing`() {
        assertEquals(emptyList<StackTraceElement>(), StackFormat.order(emptyList(), app))
    }

    @Test
    fun `rendering names the file and line`() {
        val text = StackFormat.render(listOf(frame("com.example.shop.A", "go", 42)))

        assertEquals("com.example.shop.A.go(A.kt:42)", text)
    }
}
