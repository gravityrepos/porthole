// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.invisibleToUser
import androidx.compose.ui.semantics.semantics
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import live.gravitylabs.porthole.protocol.SemanticsNodeDto
import live.gravitylabs.porthole.protocol.SemanticsTree
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * GRA-239's own reproduction, at unit-test scale: [SemanticsCollector.capture]
 * called from a thread that is not the main thread — the socket's
 * `porthole-io` thread in production — while a real Compose composition is
 * being churned from the main thread. Before the fix, this is exactly the
 * shape that trips Compose's `SnapshotStateObserver` multithreaded-access
 * check (4 times in 60 captures in the GRA-74 spike).
 */
@RunWith(RobolectricTestRunner::class)
class SemanticsCollectorThreadTest {

    /** Undecorated leaf so this test needs nothing beyond `compose-ui`. */
    @Composable
    private fun TestNode(tag: String, modifier: Modifier = Modifier) {
        Layout(content = {}, modifier = modifier.testTag(tag)) { _, constraints ->
            layout(constraints.minWidth.coerceAtLeast(1), constraints.minHeight.coerceAtLeast(1)) {}
        }
    }

    /**
     * One real Compose hierarchy, attached once, whose leaf's `testTag` is
     * re-derived from [churn] on every recomposition — so bumping [churn] from
     * the main thread is a genuine invalidate-and-recompose, the same
     * mechanism a real screen's own state changes drive, not a no-op write.
     */
    private fun attachChurningComposition(collector: SemanticsCollector, churn: MutableState<Int>) {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val composeView = ComposeView(activity)
        activity.setContentView(composeView)
        composeView.setContent {
            val view = LocalView.current
            DisposableEffect(view) {
                collector.attach(view)
                onDispose { collector.detach(view) }
            }
            val n by churn
            TestNode(tag = "tag-$n")
        }
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test
    fun `60 captures from a non-main thread while composition churns from the main thread never throw`() {
        val collector = SemanticsCollector(mainThreadTimeoutMs = 5_000)
        val churn = mutableStateOf(0)
        attachChurningComposition(collector, churn)

        val errors = Collections.synchronizedList(mutableListOf<Throwable>())
        val completed = AtomicInteger(0)

        val worker = Thread {
            repeat(60) { i ->
                try {
                    val tree = collector.capture(merged = true, maxDepth = 20, maxNodes = 200)
                    if (tree.root == null) {
                        errors += AssertionError("capture $i returned no tree: ${tree.error}")
                    }
                } catch (t: Throwable) {
                    errors += t
                } finally {
                    completed.incrementAndGet()
                }
            }
        }
        worker.start()

        var spins = 0
        while (completed.get() < 60 && spins < 20_000) {
            // The churn: a state write that forces recomposition, driven from
            // this thread, which Robolectric treats as the main thread —
            // exactly the thread SemanticsNode.config reads have to happen on.
            churn.value = churn.value + 1
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(1)
            spins++
        }
        worker.join(15_000)

        assertTrue("errors captured during concurrent access: $errors", errors.isEmpty())
        assertEquals(60, completed.get())
    }

    @Test
    fun `capture walks the tree on the main thread even when called from a background thread`() {
        val collector = SemanticsCollector(mainThreadTimeoutMs = 5_000)
        val churn = mutableStateOf(0)
        attachChurningComposition(collector, churn)

        val hasRoot = AtomicReference<Boolean>()
        val error = AtomicReference<String>()
        val worker = Thread {
            val tree = collector.capture(merged = true, maxDepth = 20, maxNodes = 200)
            hasRoot.set(tree.root != null)
            error.set(tree.error)
        }
        worker.start()

        var spins = 0
        while (hasRoot.get() == null && spins < 5_000) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(1)
            spins++
        }
        worker.join(5_000)

        assertTrue("capture never completed", hasRoot.get() != null)
        assertTrue("expected a real tree, got error: ${error.get()}", hasRoot.get() == true)
    }

    @Test
    fun `a blocked main thread makes capture return a timeout error, not a partial tree or a hang`() {
        val collector = SemanticsCollector(mainThreadTimeoutMs = 150)
        val churn = mutableStateOf(0)
        attachChurningComposition(collector, churn)

        // Called from a background thread and, deliberately, the main
        // looper is never idled here: stands in for a main thread that is
        // stuck (in a layout pass, a long callback, wherever) and never gets
        // to the posted capture work in time.
        val result = AtomicReference<SemanticsTree>()
        val worker = Thread {
            result.set(collector.capture(merged = true, maxDepth = 20, maxNodes = 200))
        }
        val startNanos = System.nanoTime()
        worker.start()
        worker.join(5_000)
        val elapsedMs = java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos)

        val tree = requireNotNull(result.get()) { "capture never returned" }
        assertTrue("expected the wait to be bounded, took ${elapsedMs}ms", elapsedMs < 5_000)
        assertEquals(null, tree.root)
        assertTrue("expected the error to name the timeout, was: ${tree.error}", tree.error?.contains("150ms") == true)
    }

    /**
     * QA F10 (GRA-72 follow-up): pins the wire flag `accessibility.ts`'s
     * decorative-image rule (mcp/src/accessibility.ts) depends on. Not a
     * threading test itself — co-located here only because this is the
     * one existing `SemanticsCollector` test file; a node's own capture
     * happens on the main thread regardless (this test's `capture()` call
     * is made from the (Robolectric) main thread directly, the ordinary
     * case every other collector behaviour is proven against).
     */
    @Test
    fun `a node marked invisibleToUser carries the flag, a sibling without it does not`() {
        val collector = SemanticsCollector(mainThreadTimeoutMs = 5_000)
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val composeView = ComposeView(activity)
        activity.setContentView(composeView)
        composeView.setContent {
            val view = LocalView.current
            DisposableEffect(view) {
                collector.attach(view)
                onDispose { collector.detach(view) }
            }
            TestNode(tag = "hidden", modifier = Modifier.semantics { invisibleToUser() })
            TestNode(tag = "visible")
        }
        shadowOf(Looper.getMainLooper()).idle()

        val tree = collector.capture(merged = true, maxDepth = 20, maxNodes = 200)
        val root = requireNotNull(tree.root) { "capture returned no tree: ${tree.error}" }
        val hidden = requireNotNull(findByTestTag(root, "hidden")) { "no node tagged 'hidden' in the capture" }
        val visible = requireNotNull(findByTestTag(root, "visible")) { "no node tagged 'visible' in the capture" }

        assertTrue("expected 'hidden' to carry invisibleToUser, flags were: ${hidden.flags}", hidden.flags.contains("invisibleToUser"))
        assertFalse("expected 'visible' not to carry invisibleToUser, flags were: ${visible.flags}", visible.flags.contains("invisibleToUser"))
    }

    private fun findByTestTag(node: SemanticsNodeDto, tag: String): SemanticsNodeDto? {
        if (node.testTag == tag) return node
        for (child in node.children) {
            findByTestTag(child, tag)?.let { return it }
        }
        return null
    }
}
