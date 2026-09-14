// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import java.util.concurrent.TimeUnit
import live.gravitylabs.porthole.store.EventRing
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Exercises the seam GRA-86 added to [LogCollector]: the injectable `spawn`
 * lambda, which exists for exactly one reason - this Windows host has no
 * `logcat`, so LogCollector's own two spawn attempts always fail within
 * milliseconds and its reader thread exits on its own, whether or not
 * `stop()` is ever called. On a device `logcat` is a real process whose
 * stdout pipe blocks the reader thread in a native read that
 * `Thread.interrupt()` cannot reach; only `process.destroy()` ends it. That
 * is the one property this suite could not previously exercise on any host
 * without a device attached.
 *
 * `findstr` with a pattern that can never match reproduces the same shape
 * without a device: it blocks reading its own stdin and writes nothing to
 * stdout while it waits, so it is a real, still-running process with a real
 * native pipe, not a fake standing in for one. Requires Robolectric, not
 * because anything here is Android-shaped, but because `LogCollector.stream()`
 * calls `android.os.Process.myPid()` and `android.util.Log`, both unmocked
 * stubs that throw on a plain JVM unit test.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class LogCollectorTest {

    @Test
    fun `stop destroys a still-running process and the reader thread exits`() {
        val stub = runCatching {
            ProcessBuilder("findstr", "zzz_this_pattern_never_matches_zzz").start()
        }.getOrNull()
        assumeTrue("findstr is not available on this host", stub != null)
        val process = stub!!

        try {
            val collector = LogCollector(EventRing(), spawn = { process })
            collector.start()

            awaitTrue(2_000) { readerThreadAlive() }
            assertTrue("expected the stub process to still be running", process.isAlive)

            collector.stop()

            assertTrue(
                "stop() should have destroyed the still-running process",
                process.waitFor(5, TimeUnit.SECONDS),
            )
            assertFalse(process.isAlive)
            awaitTrue(2_000) { !readerThreadAlive() }
        } finally {
            runCatching { process.destroyForcibly() }
        }
    }

    private fun readerThreadAlive(): Boolean =
        Thread.getAllStackTraces().keys.any { it.isAlive && it.name == "porthole-logcat" }

    private fun awaitTrue(timeoutMs: Long, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(20)
        }
        if (!condition()) fail("condition not met within ${timeoutMs}ms")
    }
}
