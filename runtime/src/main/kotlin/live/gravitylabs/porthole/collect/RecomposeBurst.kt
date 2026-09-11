// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import live.gravitylabs.porthole.nowMs

/**
 * Recomposition churn, as one span per burst in the system trace.
 *
 * The gap this closes is specific. A Perfetto capture already shows a missed
 * frame better than Porthole could — Android's own frame timeline knows the
 * deadline, the expected work and the actual, and classifies the jank. What it
 * cannot show is why: that `Cart.ItemRow` re-executed hundreds of times in that
 * window because a ticking value was read inside it. Duplicating the jank
 * marker would add nothing; putting the churn beside it makes the trace read as
 * a sentence.
 *
 * One span per burst rather than per recomposition, because a recomposition is
 * a sub-millisecond event that can happen thousands of times a second — a slice
 * each would bury the track it was meant to explain.
 *
 * One name, not one per composable. An async section's name is fixed when it
 * opens, and at that moment the only thing known is which composable happened
 * to recompose first — which on a device turned out to be the outermost one
 * every time, giving the label `recompose root`. That reads as an accusation
 * against the root and it is merely the opener.
 *
 * So the span says when churn happened and for how long, and `recompositions`
 * says which composable and which state key. Naming it after a guess would
 * cost a track per composable and be wrong most of the time.
 *
 * Not thread-safe by construction — [onRecompose] is called from the
 * composition thread and [tick] from a scheduler, so both take the lock. The
 * work under it is a couple of field writes.
 */
internal class RecomposeBurst(
    /** Silence this long ends a burst. Roughly a few frames at 60Hz. */
    private val quietMs: Long = 120,
    /** A burst is cut at this length, so one never runs away with the trace. */
    private val maxMs: Long = 3_000,
    private val now: () -> Long = ::nowMs,
    private val begin: (String, Int) -> Unit = { name, cookie -> Atrace.begin(name, cookie) },
    private val end: (String, Int) -> Unit = { name, cookie -> Atrace.end(name, cookie) },
    private val nextCookie: () -> Int = { Atrace.nextCookie() },
) {
    private val lock = Any()
    private var openName: String? = null
    private var cookie = 0
    private var openedAt = 0L
    private var lastAt = 0L

    /** From the composition thread, once per recomposition. Keep it cheap. */
    fun onRecompose() {
        val t = now()
        synchronized(lock) {
            val current = openName
            if (current == null) {
                start(t)
                return
            }
            // Cut a burst that has run long enough to stop being one event.
            if (t - openedAt >= maxMs) {
                end(current, cookie)
                start(t)
                return
            }
            lastAt = t
        }
    }

    /**
     * From a scheduler, to close a burst that has gone quiet.
     *
     * Needed because nothing happens when recompositions stop, and closing on
     * the next one instead would stretch the span across the silence — which
     * is the opposite of what it is for.
     */
    fun tick() {
        val t = now()
        synchronized(lock) {
            val current = openName ?: return
            if (t - lastAt >= quietMs) {
                end(current, cookie)
                openName = null
            }
        }
    }

    /** A span left open runs to the end of the capture, which is worse than none. */
    fun close() {
        synchronized(lock) {
            openName?.let { end(it, cookie) }
            openName = null
        }
    }

    fun isOpen(): Boolean = synchronized(lock) { openName != null }

    private fun start(t: Long) {
        cookie = nextCookie()
        openName = LABEL
        openedAt = t
        lastAt = t
        begin(LABEL, cookie)
    }

    private companion object {
        const val LABEL = "recompose"
    }
}
