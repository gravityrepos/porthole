// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import live.gravitylabs.porthole.store.EventRing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The cap the MCP surface has been advertising all along.
 *
 * It took a `limit`, passed it to the device, and the device dropped it — so a
 * caller asking for the ten busiest nodes got every node that had recomposed,
 * while believing the answer was bounded. A cap that is accepted and ignored is
 * worse than none, because nothing about the result says otherwise.
 */
class RecompositionLimitTest {

    private var clock = 1_000L

    private fun collector(): RecompositionCollector {
        val ring = EventRing(now = { clock })
        return RecompositionCollector(ring, SnapshotWatcher(ring, emptyList()), now = { clock })
    }

    /** `n` distinct call sites, each recomposing one time more than the last. */
    private fun RecompositionCollector.churn(n: Int) {
        for (node in 0 until n) {
            repeat(node + 1) { onRecompose("node-$node", "Node$node", "screen", 1) }
        }
    }

    @Test
    fun `keeps the busiest, not the first recorded`() {
        val collector = collector()
        collector.churn(20)

        val report = collector.report(screen = null, sinceMs = null, limit = 3)

        assertEquals(3, report.nodes.size)
        // node-19 recomposed 20 times, node-18 nineteen, and so on.
        assertEquals(listOf("Node19", "Node18", "Node17"), report.nodes.map { it.name })
    }

    @Test
    fun `says the list was cut, and how long it really was`() {
        val collector = collector()
        collector.churn(20)

        val report = collector.report(screen = null, sinceMs = null, limit = 3)

        assertTrue(report.truncated)
        assertEquals(20, report.totalNodes)
    }

    @Test
    fun `does not claim truncation when everything fitted`() {
        val collector = collector()
        collector.churn(3)

        val report = collector.report(screen = null, sinceMs = null, limit = 10)

        assertFalse(report.truncated)
        assertEquals(3, report.nodes.size)
        assertEquals(3, report.totalNodes)
    }

    @Test
    fun `a caller that names no limit still gets a bounded answer`() {
        // The unbounded case was the original defect: a busy screen has
        // hundreds of call sites and all of them arrived.
        val collector = collector()
        collector.churn(80)

        val report = collector.report(screen = null, sinceMs = null)

        assertEquals(50, report.nodes.size)
        assertTrue(report.truncated)
        assertEquals(80, report.totalNodes)
    }

    @Test
    fun `a nonsensical limit still returns something`() {
        val collector = collector()
        collector.churn(5)

        assertEquals(1, collector.report(screen = null, sinceMs = null, limit = 0).nodes.size)
        assertEquals(1, collector.report(screen = null, sinceMs = null, limit = -4).nodes.size)
    }
}
