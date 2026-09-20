// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.os.Handler
import android.os.Looper
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Runs a block on the main thread and waits, bounded, for the answer.
 *
 * The hop itself — `Handler(Looper.getMainLooper())` — is the same one
 * [StartupCollector], [AutoWire] and [MainThreadWatchdog] already use to reach
 * the main thread; this adds only what none of those three needed: a caller
 * that wants the result back, and a bound on how long it will wait for it.
 * GRA-239: `SemanticsCollector.capture()` used to read `SemanticsNode.config`
 * and `boundsInRoot` straight from whatever thread called it — the socket's
 * `porthole-io` thread — which trips Compose's own multithreaded-access
 * detector under composition churn. This is the fix for that class of bug,
 * not just this one call site.
 */
internal object MainThreadHop {

    internal sealed interface Outcome<out T> {
        /** [thread] is always [Looper.getMainLooper]'s thread — recorded for tests, not for callers. */
        data class Completed<T>(val value: T, val thread: Thread) : Outcome<T>
        data object TimedOut : Outcome<Nothing>
    }

    /**
     * Already on the main thread, [block] runs immediately, inline — no post,
     * no latch, nothing to time out. Otherwise it is posted to the main
     * looper and this call blocks the caller for at most [timeoutMs] waiting
     * for it to run. A main thread that never answers (blocked elsewhere, or
     * dead) yields [Outcome.TimedOut] rather than a hang: the whole point of
     * a bounded wait is that the caller — here, the socket's IO thread — gets
     * its thread back either way.
     */
    fun <T> run(timeoutMs: Long, block: () -> T): Outcome<T> {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return Outcome.Completed(block(), Thread.currentThread())
        }

        val latch = CountDownLatch(1)
        val value = AtomicReference<T>()
        val thread = AtomicReference<Thread>()
        Handler(Looper.getMainLooper()).post {
            thread.set(Thread.currentThread())
            value.set(block())
            latch.countDown()
        }

        val answered = try {
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }

        return if (answered) {
            Outcome.Completed(value.get(), thread.get())
        } else {
            Outcome.TimedOut
        }
    }
}
