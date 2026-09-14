// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import java.util.concurrent.TimeUnit
import live.gravitylabs.porthole.store.EventRing
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Exercises the seam GRA-86 added to [LogCollector]: the injectable `spawn`
 * lambda, which exists for exactly one reason - no host in this project's own
 * CI or developer fleet has a real `logcat` on PATH, so LogCollector's own two
 * spawn attempts always fail within milliseconds and its reader thread exits
 * on its own, whether or not `stop()` is ever called. On a device `logcat` is
 * a real process whose stdout pipe blocks the reader thread in a native read
 * that `Thread.interrupt()` cannot reach; only `process.destroy()` ends it.
 * That is the one property this suite could not previously exercise on any
 * host without a device attached.
 *
 * GRA-137: this test used to run only on Windows (`assumeTrue` skipped it
 * everywhere else), which meant it silently did not run at all on the ubuntu
 * runner `.github/workflows/pr.yml` actually uses - a mutation deleting
 * `s.logs.stop()` from production code would go red on a laptop and stay
 * green on CI, exactly the shape of defect GRA-86 itself was about. The stub
 * is now picked per platform instead of skipped - see [spawnBlockingStub] for
 * what each half is and why neither runs through a shell.
 *
 * Requires Robolectric, not because anything here is Android-shaped, but
 * because `LogCollector.stream()` calls `android.os.Process.myPid()` and
 * `android.util.Log`, both unmocked stubs that throw on a plain JVM unit test.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class LogCollectorTest {

    @Test
    fun `stop destroys a still-running process and the reader thread exits`() {
        val process = spawnBlockingStub()
            ?: error(
                "could not start the platform blocking-stub process " +
                    "(${if (isWindows) "findstr" else "cat"} not on PATH) - " +
                    "this test must run everywhere, not skip",
            )

        try {
            val collector = LogCollector(EventRing(), spawn = { process })
            collector.start()

            // start() returns once the reader thread is scheduled, not once
            // it has run: `stream()` still has to reach `process = started`
            // on that thread before collector's own `process` field holds
            // anything for stop() to destroy. A thread can report `isAlive`
            // before it has executed a single line of its run(), so waiting
            // on that alone leaves the same window `stop()` would otherwise
            // race on a real `logcat` host - just self-inflicted here.
            // Waiting for the field itself closes it.
            awaitTrue(2_000) { fieldValue(collector, "process") != null }
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

    /** Reflection over LogCollector's own private fields - test-only, same as ShutdownTest's `fieldValue`. */
    private fun fieldValue(target: Any, name: String): Any? {
        var klass: Class<*>? = target.javaClass
        while (klass != null) {
            try {
                val field = klass.getDeclaredField(name)
                field.isAccessible = true
                return field.get(target)
            } catch (_: NoSuchFieldException) {
                klass = klass.superclass
            }
        }
        return null
    }

    private fun awaitTrue(timeoutMs: Long, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(20)
        }
        if (!condition()) fail("condition not met within ${timeoutMs}ms")
    }

    private val isWindows: Boolean
        get() = System.getProperty("os.name")?.lowercase()?.contains("win") == true

    /**
     * A real, still-running process that blocks without producing output -
     * the exact shape an unread `logcat` pipe has, reproduced without a
     * device. On Windows, `findstr` with a pattern that can never match
     * blocks reading its own stdin and writes nothing to stdout while it
     * waits. POSIX has no equally universal search-and-block tool, but every
     * POSIX host has `cat`: with no arguments it reads stdin and blocks until
     * EOF, and EOF never comes because nothing ever writes to or closes the
     * pipe `ProcessBuilder` wires up as this child's stdin.
     *
     * Neither command runs through a shell, and that is deliberate: a
     * POSIX-only test written earlier on this project spawned
     * `sh -c "sleep 30"`, and on Ubuntu's `/bin/sh` (dash), a simple external
     * command is *forked* rather than exec'd in place - so the `Process`
     * object returned wrapped dash's own pid, not sleep's. Killing dash left
     * `sleep` an orphan still holding the pipe open, and the test that
     * expected the pipe to close failed the first time it ever ran on CI,
     * despite looking correct on inspection. `ProcessBuilder(listOf("cat"))`
     * (and `ProcessBuilder(listOf("findstr", ...))`) invoke the command
     * directly with no intervening shell to fork away from, so the `Process`
     * this returns IS the thing blocked reading the pipe, and `destroy()`
     * reaches it directly rather than a parent that has already exited.
     */
    private fun spawnBlockingStub(): java.lang.Process? = runCatching {
        val command = if (isWindows) {
            listOf("findstr", "zzz_this_pattern_never_matches_zzz")
        } else {
            listOf("cat")
        }
        ProcessBuilder(command).start()
    }.getOrNull()
}
