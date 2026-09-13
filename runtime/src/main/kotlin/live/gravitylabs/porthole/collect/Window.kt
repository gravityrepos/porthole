// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

/**
 * What "the last five seconds" means, written down once.
 *
 * Every tool on the surface takes the same three arguments — `sinceMs`, `from`,
 * `to` — and until this existed each collector worked out for itself what they
 * meant. Five copies of four lines of arithmetic, and they had drifted: one left
 * the ceiling unbounded when `to` was absent, one clamped the floor at zero and
 * the others did not, and one ignored `sinceMs` entirely. An agent asking two
 * tools about "the last five seconds" was asking two different questions and
 * being given no way to notice.
 *
 * So the semantics live here and nowhere else:
 *
 *  - **[from] is the floor when it is given.** It is an absolute reading of the
 *    same uptime clock every event is stamped with, so it names a moment on the
 *    timeline exactly rather than approximately. It wins over [sinceMs], which
 *    can only say "roughly this long ago".
 *  - **[sinceMs] is the floor otherwise**, as `now - sinceMs`. It is the
 *    convenient form and the imprecise one: the answer depends on when the
 *    request arrived.
 *  - **With neither, the floor is 0** — the start of the device's uptime, which
 *    is as far back as any buffer here reaches. Not `Long.MIN_VALUE`: a
 *    timestamp on this clock cannot be negative, and a floor that can be is one
 *    more thing for a caller to reason about.
 *  - **[to] is the ceiling when it is given, and [now] otherwise.** Defaulting
 *    to now is the part that changed: the log collector used to leave the
 *    ceiling open, so `logs` and `frames` asked for the same window and got
 *    spans of different lengths. Now is the only defensible default, because
 *    nothing in any of these buffers is stamped in the future.
 *  - **The floor is never negative.** `sinceMs` larger than the device's uptime
 *    is the ordinary case for "show me everything" — a caller passing
 *    `sinceMs = 86_400_000` on a phone booted twenty minutes ago means the whole
 *    buffer, not a window starting before the device existed.
 *
 * Both ends are inclusive. A window whose floor is above its ceiling — `from`
 * after `to`, or a `to` in the past with a `sinceMs` that does not reach back to
 * it — comes back as an empty [LongRange] rather than an error or a silently
 * widened window, because that is what was asked for: a span of time containing
 * no moments. `LongRange.isEmpty()` says so, and filtering with `in` yields
 * nothing, which is the honest answer.
 *
 * [now] is passed in rather than read here so that one answer can be assembled
 * from one reading of the clock. That is not a style preference: the `blocking`
 * RPC used to derive its window twice, milliseconds apart, and reported stalls
 * and main-thread queries over two windows that did not quite line up.
 */
internal object Window {

    fun resolve(sinceMs: Long?, from: Long?, to: Long?, now: Long): LongRange {
        val floor = when {
            from != null -> from
            sinceMs != null -> now - sinceMs
            else -> 0L
        }.coerceAtLeast(0L)
        val ceiling = to ?: now
        return floor..ceiling
    }

    /**
     * Whether a span of work belongs in [window].
     *
     * The rule is overlap, not containment, and it is deliberate: work that
     * began before the window and was still running inside it is exactly the
     * work worth seeing. A query that started 200ms before the window opened and
     * held the main thread for 900ms is the cause of the jank the window was
     * drawn around, and filtering on its start time alone made it invisible —
     * the longer the offence, the more likely it was to be missed.
     *
     * So a span counts when it began at or before the ceiling and had not ended
     * before the floor. [endedAt] of null means it has not ended at all, which
     * overlaps every window that has not already closed before it began.
     */
    fun overlaps(window: LongRange, startedAt: Long, endedAt: Long?): Boolean =
        !window.isEmpty() && startedAt <= window.last && (endedAt ?: Long.MAX_VALUE) >= window.first
}
