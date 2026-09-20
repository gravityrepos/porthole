// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.app.Application
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Composition
import androidx.compose.runtime.ExperimentalComposeRuntimeApi
import androidx.compose.runtime.RecomposeScope
import live.gravitylabs.porthole.store.EventRing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * The API this class drives (`CompositionObserver`) needs a live Compose
 * tree to fire for real, which is out of reach for a JVM unit test — see the
 * emulator pass in the GRA-235 verification notes for that. What is tested
 * here is everything this class does with the data *once* that API hands it
 * over: the pass-level merge with wrapped call sites (this class's own doc
 * comment explains exactly what it does and does not guarantee), causal
 * attribution, and graceful degradation when the API is absent — the last of
 * which the ticket's own acceptance criteria call out as acceptable to prove
 * with a mock rather than an actual pre-1.6 Compose runtime.
 */
@OptIn(ExperimentalComposeRuntimeApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class CompositionTreeCollectorTest {

    private val app: Application get() = RuntimeEnvironment.getApplication()

    private fun ring() = EventRing(capacity = 64)

    private fun scope(): RecomposeScope = object : RecomposeScope {
        override fun invalidate() = Unit
    }

    private val fakeComposition: Composition = object : Composition {
        override val hasInvalidations: Boolean = false
        override val isDisposed: Boolean = false
        override fun dispose() = Unit
        override fun setContent(content: @Composable () -> Unit) = Unit
    }

    // -- degradation ----------------------------------------------------------

    @Test
    fun `install returns false and never crashes when the tooling API is unavailable`() {
        val snapshots = SnapshotWatcher(ring())
        val tree = CompositionTreeCollector(snapshots, composableNames = false, available = false)

        assertFalse(tree.install(app, RecompositionCollector(ring(), snapshots)))
        assertFalse(tree.attachedAtLeastOnce)
        // No pass ever opens, so a wrapped call site's SideEffect gets no
        // causal triggers to fall back on — RecompositionCollector.onRecompose
        // then falls back to its own temporal correlation with no special-
        // casing, exactly as it did before GRA-235.
        assertNull(tree.currentPassTriggers())

        // Harmless even though nothing is attached — nothing should ever call
        // these in practice (Compose only calls back an observer it was
        // actually handed), but stop() in particular is called
        // unconditionally by Porthole.shutdown().
        tree.stop(app)
    }

    // -- pass-level merge with wrapped call sites ------------------------------

    @Test
    fun `a wrapped call site's own scope is never also reported as an observer node`() {
        val ring = ring()
        val snapshots = SnapshotWatcher(ring)
        snapshots.name(PROMO_CODE, "CartViewModel.promoCode")
        val recompositions = RecompositionCollector(ring, snapshots)
        val tree = CompositionTreeCollector(snapshots, composableNames = false)
        assertTrue(tree.install(app, recompositions))
        recompositions.observerNames = tree
        recompositions.wholeTreeAvailable = true

        // One scope invalidated this pass (the wrapped node's own), by one
        // state write — exactly the "typing in the promo field" scenario.
        tree.onBeginComposition(fakeComposition, mapOf(scope() to setOf(PROMO_CODE)))
        val causal = tree.currentPassTriggers()
        tree.notifyWrappedFired()
        recompositions.onRecompose("wrapped-1", "Cart.PromoField", "Cart", 1, causal)
        tree.onEndComposition(fakeComposition)

        val report = recompositions.report(screen = null, sinceMs = null)
        assertEquals("exactly one node — the wrapped one, not a duplicate observer entry", 1, report.nodes.size)
        val node = report.nodes.single()
        assertEquals("wrapped-1", node.id)
        assertEquals("wrapped", node.source)
        assertEquals("observer", node.attribution)
        assertEquals(listOf("CartViewModel.promoCode"), node.triggeredBy.map { it.key })
    }

    @Test
    fun `an unwrapped scope that recomposes on its own is reported, with causal triggeredBy`() {
        val ring = ring()
        val snapshots = SnapshotWatcher(ring)
        val cursorBlink = Any()
        snapshots.name(cursorBlink, "cursorBlink")
        val recompositions = RecompositionCollector(ring, snapshots)
        val tree = CompositionTreeCollector(snapshots, composableNames = false)
        assertTrue(tree.install(app, recompositions))
        recompositions.observerNames = tree
        recompositions.wholeTreeAvailable = true

        // No wrapped SideEffect fires this pass — e.g. CoreTextField's own
        // cursor-blink state recomposing on its own, independent of the
        // wrapped PromoField scope above it in the tree.
        tree.onBeginComposition(fakeComposition, mapOf(scope() to setOf(cursorBlink)))
        tree.onEndComposition(fakeComposition)
        // A pass is reconciled once the *next* one begins — SideEffect fires
        // after onEndComposition, not before; see this class's own doc
        // comment. An empty pass is enough to trigger that flush.
        tree.onBeginComposition(fakeComposition, emptyMap())

        val report = recompositions.report(screen = null, sinceMs = null)
        val node = report.nodes.single()
        assertEquals("observer", node.source)
        assertEquals("observer", node.attribution)
        assertTrue("placeholder name until composableNames resolves one", node.name.startsWith("<uninstrumented:"))
        assertEquals(listOf("cursorBlink"), node.triggeredBy.map { it.key })
    }

    @Test
    fun `the same unwrapped scope accumulates its count across repeated passes`() {
        val ring = ring()
        val snapshots = SnapshotWatcher(ring)
        val recompositions = RecompositionCollector(ring, snapshots)
        val tree = CompositionTreeCollector(snapshots, composableNames = false)
        assertTrue(tree.install(app, recompositions))
        recompositions.observerNames = tree
        recompositions.wholeTreeAvailable = true

        val s = scope()
        repeat(3) {
            tree.onBeginComposition(fakeComposition, mapOf(s to null))
            tree.onEndComposition(fakeComposition)
        }
        // Flushes the third (and every earlier) pass — see the previous test's comment.
        tree.onBeginComposition(fakeComposition, emptyMap())

        val report = recompositions.report(screen = null, sinceMs = null)
        assertEquals(1, report.nodes.size)
        assertEquals(3, report.nodes.single().count)
    }

    // -- report-level provenance -----------------------------------------------

    @Test
    fun `wholeTreeCoverage and composableNames are surfaced on the report`() {
        val ring = ring()
        val snapshots = SnapshotWatcher(ring)
        val recompositions = RecompositionCollector(ring, snapshots, composableNamesEnabled = true)
        recompositions.wholeTreeAvailable = true

        val report = recompositions.report(screen = null, sinceMs = null)
        assertTrue(report.wholeTreeCoverage)
        assertTrue(report.composableNames)
        assertTrue(
            "the forceRecomposeScopes caveat belongs in notes when composableNames is on",
            report.notes.any { it.contains("forceRecomposeScopes") },
        )
    }

    // -- name formatting --------------------------------------------------------

    @Test
    fun `nameOf prefers the composable name and location together`() {
        val tree = CompositionTreeCollector(SnapshotWatcher(ring()), composableNames = true)
        assertEquals(
            "CoreTextField (BasicTextField.android.kt:221)",
            tree.nameOf(name = "CoreTextField", sourceFile = "BasicTextField.android.kt", lineNumber = 221),
        )
    }

    @Test
    fun `nameOf falls back to file colon line for a content lambda with no name`() {
        val tree = CompositionTreeCollector(SnapshotWatcher(ring()), composableNames = true)
        assertEquals("Screens.kt:62", tree.nameOf(name = null, sourceFile = "Screens.kt", lineNumber = 62))
    }

    @Test
    fun `nameOf never returns blank`() {
        val tree = CompositionTreeCollector(SnapshotWatcher(ring()), composableNames = true)
        assertEquals("<anonymous scope>", tree.nameOf(name = null, sourceFile = null, lineNumber = null))
    }

    private companion object {
        val PROMO_CODE = Any()
    }
}
