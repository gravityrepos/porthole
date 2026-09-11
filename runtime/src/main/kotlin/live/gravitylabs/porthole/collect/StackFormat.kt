// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

/**
 * Turning a stalled thread's stack into something worth reading.
 *
 * Apart from the watchdog because the decision in it is not obvious and has
 * been got wrong: the first version filtered the plumbing out, which threw away
 * the frame that said *what* was being waited on.
 */
internal object StackFormat {

    /**
     * Frames that are always true and never the answer.
     *
     * Matched against `class.method`, so an entry can name a package or a
     * single method. Matching the class name alone made the Thread entry below
     * dead: a frame's class is `java.lang.Thread`, which never starts with
     * `java.lang.Thread.getStackTrace`.
     */
    val SKIPPED = listOf(
        "dalvik.system",
        "java.lang.Thread.getStackTrace",
        "android.os.VMRuntime",
    )

    const val MAX_FRAMES = 12

    /**
     * The app's own frames first, then everything else.
     *
     * Reordered rather than filtered. The top frame of a stalled thread is
     * usually `Thread.sleep` or a native read — true, and not a line anyone can
     * change. Leading with the app's own frames puts something actionable
     * first, and keeping the rest means the thing being waited on is still
     * there to read.
     */
    fun order(
        frames: List<StackTraceElement>,
        appPackages: Collection<String>,
        maxFrames: Int = MAX_FRAMES,
    ): List<StackTraceElement> {
        if (frames.isEmpty()) return emptyList()

        val useful = frames
            .filterNot { frame -> SKIPPED.any { qualified(frame).startsWith(it) } }
            .ifEmpty { frames }

        val (mine, theirs) = useful.partition { frame ->
            appPackages.any { frame.className.startsWith(it) }
        }
        return (mine + theirs).take(maxFrames)
    }

    private fun qualified(frame: StackTraceElement): String =
        frame.className + "." + frame.methodName

    fun render(frames: List<StackTraceElement>): String =
        frames.joinToString("\n") { frame ->
            frame.className + "." + frame.methodName +
                "(" + (frame.fileName ?: "?") + ":" + frame.lineNumber + ")"
        }
}
