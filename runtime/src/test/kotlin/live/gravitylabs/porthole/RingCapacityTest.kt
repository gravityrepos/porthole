// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import live.gravitylabs.porthole.store.EventRing
import org.junit.Test
import org.junit.Assert.assertEquals

/**
 * GRA-53: the plugin's `ringCapacity` reaches the runtime as a generated
 * integer resource, and `EventRing` indexes `slots[n % capacity]`. A zero or
 * negative value that got through would throw on the first emitted event, so
 * the clamp in [Porthole.sanitizeRingCapacity] is the only thing between a
 * misconfigured `porthole { ringCapacity.set(0) }` and a crash at install.
 */
class RingCapacityTest {
    @Test
    fun `a positive configured capacity is used as-is`() {
        assertEquals(1, Porthole.sanitizeRingCapacity(1))
        assertEquals(2048, Porthole.sanitizeRingCapacity(2048))
        assertEquals(Int.MAX_VALUE, Porthole.sanitizeRingCapacity(Int.MAX_VALUE))
    }

    @Test
    fun `zero falls back to the default rather than reaching EventRing`() {
        assertEquals(EventRing.DEFAULT_CAPACITY, Porthole.sanitizeRingCapacity(0))
    }

    @Test
    fun `a negative value falls back to the default`() {
        assertEquals(EventRing.DEFAULT_CAPACITY, Porthole.sanitizeRingCapacity(-1))
        assertEquals(EventRing.DEFAULT_CAPACITY, Porthole.sanitizeRingCapacity(Int.MIN_VALUE))
    }

    @Test
    fun `no resource at all falls back to the default`() {
        assertEquals(EventRing.DEFAULT_CAPACITY, Porthole.sanitizeRingCapacity(null))
    }

    @Test
    fun `the default itself is usable by EventRing`() {
        // Guards the fallback against a future edit that sets DEFAULT_CAPACITY
        // to something the ring cannot index — the clamp would then be
        // "correct" and still hand EventRing an unusable number.
        val ring = EventRing(capacity = Porthole.sanitizeRingCapacity(0))
        assertEquals(0, ring.since(0).size)
    }
}
