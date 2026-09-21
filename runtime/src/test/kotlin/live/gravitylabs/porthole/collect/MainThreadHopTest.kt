// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.os.Looper
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * [MainThreadHop] on its own, decoupled from Compose: the bounded-wait
 * mechanism [SemanticsCollector.capture] (GRA-239) relies on to avoid reading
 * `SemanticsNode.config` off the main thread.
 */
@RunWith(RobolectricTestRunner::class)
class MainThreadHopTest {

    @Test
    fun `already on the main thread runs inline, no post, no latch`() {
        val outcome = MainThreadHop.run(timeoutMs = 50) { "value" }

        val completed = outcome as MainThreadHop.Outcome.Completed
        assertEquals("value", completed.value)
        assertEquals(Thread.currentThread(), completed.thread)
    }

    @Test
    fun `a call from a background thread runs the block on the main thread`() {
        val results = Collections.synchronizedList(mutableListOf<MainThreadHop.Outcome<Int>>())
        val worker = Thread {
            results += MainThreadHop.run(timeoutMs = 5_000) { 42 }
        }
        worker.start()

        // Stands in for "composition being churned from the main thread": this
        // is the test/main thread repeatedly doing its own work AND pumping
        // the looper the posted capture is waiting on, exactly like the
        // production socket-IO-thread-vs-main-thread split.
        var spins = 0
        while (results.isEmpty() && spins < 2_000) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(1)
            spins++
        }
        worker.join(5_000)

        assertEquals(1, results.size)
        val completed = results[0] as MainThreadHop.Outcome.Completed
        assertEquals(42, completed.value)
        assertEquals(Looper.getMainLooper().thread, completed.thread)
        assertTrue("expected the block to run off the calling (worker) thread", completed.thread !== worker)
    }

    @Test
    fun `60 back-to-back hops from a background thread while the main thread is busy never throw`() {
        val errors = Collections.synchronizedList(mutableListOf<Throwable>())
        val completedCount = AtomicInteger(0)
        val threadsSeen = Collections.synchronizedSet(mutableSetOf<Thread>())

        val worker = Thread {
            repeat(60) {
                try {
                    val outcome = MainThreadHop.run(timeoutMs = 5_000) { it }
                    when (outcome) {
                        is MainThreadHop.Outcome.Completed -> {
                            threadsSeen += outcome.thread
                            completedCount.incrementAndGet()
                        }
                        MainThreadHop.Outcome.TimedOut -> errors += AssertionError("hop $it timed out")
                    }
                } catch (t: Throwable) {
                    errors += t
                }
            }
        }
        worker.start()

        var churn = 0
        var spins = 0
        while (completedCount.get() < 60 && spins < 20_000) {
            // "Churn": other work landing on the same main looper queue in
            // between idling, the way a busy screen's own recompositions would.
            churn++
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(1)
            spins++
        }
        worker.join(10_000)

        assertTrue("errors: $errors", errors.isEmpty())
        assertEquals(60, completedCount.get())
        assertEquals(setOf(Looper.getMainLooper().thread), threadsSeen)
    }

    @Test
    fun `a main thread that never answers times out rather than hanging the caller`() {
        val latch = CountDownLatch(1)
        val outcomeRef = java.util.concurrent.atomic.AtomicReference<MainThreadHop.Outcome<Unit>>()
        val elapsedMsRef = java.util.concurrent.atomic.AtomicLong()

        // Run from a background thread, same as production's `porthole-io`:
        // called from the test/main thread itself this would take the
        // already-on-main-thread inline path and never exercise the timeout
        // at all. Deliberately never idled here, standing in for a main
        // thread that is stuck and never gets to the posted work in time.
        val worker = Thread {
            val start = System.nanoTime()
            val outcome = MainThreadHop.run(timeoutMs = 150) {
                // Never reached in this test.
                latch.countDown()
            }
            elapsedMsRef.set(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start))
            outcomeRef.set(outcome)
        }
        worker.start()
        worker.join(5_000)

        val elapsedMs = elapsedMsRef.get()
        assertEquals(MainThreadHop.Outcome.TimedOut, outcomeRef.get())
        assertTrue("expected to wait at least the bound, waited ${elapsedMs}ms", elapsedMs >= 150)
        assertTrue("expected the wait to actually be bounded, waited ${elapsedMs}ms", elapsedMs < 5_000)
        assertEquals(1L, latch.count)
    }
}
