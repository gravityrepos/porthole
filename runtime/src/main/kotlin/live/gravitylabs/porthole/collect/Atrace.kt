// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.os.Build
import android.os.Trace
import java.util.concurrent.atomic.AtomicInteger

/**
 * Porthole's spans, written into the system trace as well as its own.
 *
 * This is the answer to the thing that makes a Perfetto capture daunting:
 * staring at forty seconds of scheduler activity trying to remember what you
 * were doing at 00:42.318. Perfetto knows what every thread ran and nothing at
 * all about why. Porthole knows only why. Emitting the why into the same buffer
 * means the capture arrives already annotated — a slice saying
 * `porthole: POST /checkout` sitting exactly where the question was going to be
 * asked, on the app's own track, with no export step and no second artifact.
 *
 * It also sidesteps the clock problem entirely. These sections are timestamped
 * by the same tracing infrastructure as everything else in the capture, so they
 * need no alignment with Porthole's own clock — they are already in Perfetto's.
 *
 * Async sections need API 29. Below that only [event] works, because a
 * synchronous section has to begin and end on one thread and nest properly, and
 * an HTTP call obeys neither. The runtime's minSdk is 26, so 26 to 28 get the
 * point markers and no spans rather than something subtly wrong.
 *
 * Everything here is a no-op when nothing is tracing. On API 29 and up that is
 * checked; below it the calls themselves are the cheap path in the platform.
 */
internal object Atrace {

    /** `Trace` truncates past this and throws past 127. Leave room for the tag. */
    private const val MAX_NAME = 100

    private const val PREFIX = "porthole: "

    /** Async sections are matched on (name, cookie), so the cookie must be unique. */
    private val cookies = AtomicInteger(1)

    private val asyncSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

    /** Cheap enough to ask every time, and it is the difference between a no-op and a JNI call. */
    private val tracing: Boolean
        get() = if (asyncSupported) Trace.isEnabled() else true

    fun nextCookie(): Int = cookies.incrementAndGet()

    /**
     * A span that starts here and ends elsewhere, on any thread.
     *
     * Pair with [end] using the same name and cookie. An unmatched begin leaves
     * a slice open to the end of the capture, which is worse than no slice at
     * all, so every caller must end in a finally or an equivalent.
     */
    fun begin(name: String, cookie: Int) {
        if (!asyncSupported || !tracing) return
        runCatching { Trace.beginAsyncSection(label(name), cookie) }
    }

    fun end(name: String, cookie: Int) {
        if (!asyncSupported || !tracing) return
        runCatching { Trace.endAsyncSection(label(name), cookie) }
    }

    // There was an `event` here, opening and closing a section immediately to
    // mark a moment. It worked, in that the label really was in the trace — and
    // it was useless, because a zero-duration slice has no width and a trace
    // viewer draws nothing. The navigation and stall markers were both invisible
    // while appearing, by every check this code could make, to have been written.
    //
    // Anything worth marking is worth giving a real duration, so both callers
    // became spans and this went away rather than staying as a trap.

    /**
     * Prefixed so these are findable among the platform's own slices, and
     * truncated because `beginSection` throws on a name over 127 characters —
     * which a URL or a SQL statement reaches easily.
     */
    private fun label(name: String): String {
        val trimmed = if (name.length > MAX_NAME) name.take(MAX_NAME - 1) + "…" else name
        return PREFIX + trimmed
    }
}
