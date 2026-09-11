// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.os.Process
import android.util.Log
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.LogEntry
import live.gravitylabs.porthole.protocol.LogPage
import live.gravitylabs.porthole.store.EventRing
import java.io.BufferedReader
import java.util.ArrayDeque
import java.util.Calendar
import java.util.concurrent.atomic.AtomicLong

/**
 * Streams the app's own logcat output over the porthole socket.
 *
 * Since Jelly Bean an app can only read log entries produced by its own uid, so
 * spawning `logcat` from inside the process needs no permission and returns
 * exactly what we want and nothing else. It also catches everything the app
 * prints, including output from libraries and from code that calls
 * `android.util.Log` directly — which is most code, and none of which a
 * Timber-style tree would see.
 */
internal class LogCollector(
    private val ring: EventRing,
    /**
     * Tags never captured. The porthole's own tag is in here for a concrete
     * reason: a failing socket write logs, and if that log became an event that
     * needed writing, a dropped client would spin.
     */
    private val excludeTags: Set<String> = setOf(PORTHOLE_TAG),
) {
    private val entries = ArrayDeque<LogEntry>()
    private val lock = Any()
    private val evicted = AtomicLong(0)

    @Volatile private var process: java.lang.Process? = null
    @Volatile private var reader: Thread? = null
    @Volatile private var running = false
    @Volatile private var failure: String? = null

    /**
     * Sequence of the log event most recently pushed to clients.
     *
     * Coalescing a stack trace rewrites an entry that has already been sent, so
     * the extra lines follow as a `log_append` naming this sequence. Without it
     * the `logs` tool would show a whole trace while the live view showed only
     * its first line, and two views of the same thing disagreeing is worse than
     * either one being incomplete.
     */
    @Volatile private var lastEmittedSeq: Long = -1

    /**
     * logcat reports wall clock; the timeline runs on uptime. One offset taken
     * at start converts between them. It drifts across deep sleep, since uptime
     * does not advance there, which is why the original stamp is kept too.
     */
    private val wallToUptimeOffset = System.currentTimeMillis() - nowMs()

    fun start() {
        if (running) return
        running = true

        val thread = Thread({
            try {
                stream()
            } catch (e: Throwable) {
                failure = e.javaClass.simpleName + ": " + e.message
                Log.w(PORTHOLE_TAG, "log capture stopped", e)
            }
        }, "porthole-logcat")
        thread.isDaemon = true
        reader = thread
        thread.start()
    }

    fun stop() {
        running = false
        runCatching { process?.destroy() }
        process = null
        reader?.interrupt()
        reader = null
    }

    fun isCapturing(): Boolean = running && failure == null

    private fun stream() {
        // -T seeds the stream with recent history so a client that attaches
        // late still sees what led up to now. It is not on every platform, so a
        // plain follow is the fallback.
        val started = spawn(listOf("logcat", "-v", "threadtime", "-T", BACKFILL_LINES.toString()))
            ?: spawn(listOf("logcat", "-v", "threadtime"))
            ?: run {
                failure = "could not spawn logcat"
                return
            }
        process = started

        val ownPid = Process.myPid()
        started.inputStream.bufferedReader().use { input: BufferedReader ->
            var previous: LogEntry? = null
            while (running) {
                val line = input.readLine() ?: break
                val parsed = parse(line, ownPid)

                if (parsed == null) {
                    // Stack traces and other wrapped output arrive as lines that
                    // do not carry a header. They belong to the entry above.
                    val head = previous ?: continue
                    if (line.isBlank()) continue
                    previous = head.copy(message = head.message + "\n" + line.trimEnd())
                    replaceLast(previous)
                    emitAppend(line.trimEnd())
                    continue
                }

                if (parsed.tag in excludeTags) {
                    previous = null
                    continue
                }

                // Log.e(tag, msg, throwable) does not produce one entry with
                // newlines in it: every frame of the stack trace comes back as
                // its own fully-formed log line. Left alone, a single error
                // becomes thirty rows and the message that explains it scrolls
                // away. Glue them back onto the line they belong to.
                val head = previous
                if (head != null && head.continuesInto(parsed)) {
                    previous = head.copy(message = head.message + "\n" + parsed.message)
                    replaceLast(previous)
                    emitAppend(parsed.message)
                    continue
                }

                previous = parsed
                record(parsed)
            }
        }
    }

    /**
     * Whether [next] is a continuation of this entry rather than a new one.
     *
     * Same writer, same instant, and a shape that only ever appears inside a
     * stack trace. Requiring all three keeps two unrelated errors logged back
     * to back from being welded together.
     */
    private fun LogEntry.continuesInto(next: LogEntry): Boolean {
        if (next.tag != tag || next.level != level || next.tid != tid) return false
        if (next.t - t > CONTINUATION_WINDOW_MS) return false
        return STACK_FRAME.containsMatchIn(next.message) || THROWABLE_HEAD.matches(next.message)
    }

    private fun spawn(command: List<String>): java.lang.Process? = runCatching {
        ProcessBuilder(command).redirectErrorStream(true).start()
    }.getOrNull()

    private fun record(entry: LogEntry) {
        synchronized(lock) {
            entries.addLast(entry)
            while (entries.size > CAPACITY) {
                entries.removeFirst()
                evicted.incrementAndGet()
            }
        }
        lastEmittedSeq = ring.emit("log", entry.toJson()).seq
    }

    /** Extra lines for an entry already sent, addressed by its sequence. */
    private fun emitAppend(text: String) {
        val seq = lastEmittedSeq
        if (seq < 0) return
        ring.emit(
            "log_append",
            JsonObject(
                mapOf(
                    "seq" to JsonPrimitive(seq),
                    "text" to JsonPrimitive(text),
                ),
            ),
        )
    }

    /** Continuation lines rewrite the entry in place rather than adding noise. */
    private fun replaceLast(entry: LogEntry) {
        synchronized(lock) {
            if (entries.isNotEmpty()) entries.removeLast()
            entries.addLast(entry)
        }
    }

    fun page(
        minLevel: String?,
        tag: String?,
        contains: String?,
        sinceMs: Long?,
        from: Long?,
        to: Long?,
        limit: Int,
    ): LogPage {
        val floor = from ?: sinceMs?.let { nowMs() - it }
        val ceiling = to
        val minRank = minLevel?.let { rank(it.uppercase().first()) } ?: 0

        val matched = synchronized(lock) {
            entries.filter { entry ->
                (floor == null || entry.t >= floor) &&
                    (ceiling == null || entry.t <= ceiling) &&
                    rank(entry.level.first()) >= minRank &&
                    (tag == null || entry.tag.contains(tag, ignoreCase = true)) &&
                    (contains == null || entry.message.contains(contains, ignoreCase = true))
            }
        }

        val notes = buildList {
            failure?.let {
                add("Log capture is not running: $it. Everything else still works.")
            }
            if (matched.isEmpty() && entries.isNotEmpty()) {
                add("Nothing matched. There are ${entries.size} entries buffered.")
            }
            if (excludeTags.isNotEmpty()) {
                add("Excluded tags: " + excludeTags.joinToString())
            }
        }

        return LogPage(
            entries = matched.takeLast(limit),
            capturing = isCapturing(),
            evicted = evicted.get(),
            notes = notes,
        )
    }

    // -- parsing -----------------------------------------------------------

    /**
     * threadtime format:
     * `09-10 21:32:33.196  6392  6499 I Porthole: listening on ...`
     *
     * Returns null for anything that is not a header line, which the caller
     * treats as a continuation of the entry above.
     */
    private fun parse(line: String, ownPid: Int): LogEntry? {
        val match = HEADER.matchEntire(line) ?: return null
        val (stamp, pid, tid, level, tag, message) = match.destructured

        // An app only ever gets its own entries, but a shared-uid process would
        // see its siblings', and those are somebody else's problem.
        val parsedPid = pid.toIntOrNull() ?: return null
        if (parsedPid != ownPid) return null

        return LogEntry(
            t = toUptime(stamp),
            wallTime = stamp,
            level = level,
            tag = tag.trim(),
            pid = parsedPid,
            tid = tid.toIntOrNull() ?: 0,
            message = message.trimEnd(),
        )
    }

    /** `MM-DD HH:MM:SS.mmm` carries no year, so the current one is assumed. */
    private fun toUptime(stamp: String): Long = runCatching {
        val month = stamp.substring(0, 2).toInt()
        val day = stamp.substring(3, 5).toInt()
        val hour = stamp.substring(6, 8).toInt()
        val minute = stamp.substring(9, 11).toInt()
        val second = stamp.substring(12, 14).toInt()
        val millis = stamp.substring(15, 18).toInt()

        val calendar = Calendar.getInstance()
        calendar.set(Calendar.MONTH, month - 1)
        calendar.set(Calendar.DAY_OF_MONTH, day)
        calendar.set(Calendar.HOUR_OF_DAY, hour)
        calendar.set(Calendar.MINUTE, minute)
        calendar.set(Calendar.SECOND, second)
        calendar.set(Calendar.MILLISECOND, millis)

        calendar.timeInMillis - wallToUptimeOffset
    }.getOrDefault(nowMs())

    private fun rank(level: Char): Int = when (level) {
        'V' -> 1
        'D' -> 2
        'I' -> 3
        'W' -> 4
        'E' -> 5
        'F' -> 6
        else -> 0
    }

    private fun LogEntry.toJson() = JsonObject(
        mapOf(
            "level" to JsonPrimitive(level),
            "tag" to JsonPrimitive(tag),
            "tid" to JsonPrimitive(tid),
            "wallTime" to JsonPrimitive(wallTime),
            "message" to JsonPrimitive(
                if (message.length > MAX_MESSAGE_CHARS) {
                    message.take(MAX_MESSAGE_CHARS) + "... (+" + (message.length - MAX_MESSAGE_CHARS) + ")"
                } else {
                    message
                },
            ),
        ),
    )

    companion object {
        const val PORTHOLE_TAG = "Porthole"

        private val HEADER = Regex(
            """^(\d\d-\d\d \d\d:\d\d:\d\d\.\d\d\d)\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+([^:]*):\s?(.*)$""",
        )

        /** "	at com.example...", "Caused by:", "... 12 more", "Suppressed:". */
        private val STACK_FRAME = Regex("""^\s+(at\s|\.\.\.\s*\d+\s+more)|^\s*(Caused by|Suppressed):""")

        /** The exception header line that follows the message: "java.lang.Foo: bar". */
        private val THROWABLE_HEAD = Regex("""^[A-Za-z_][\w.$]*(Exception|Error|Throwable)(:.*)?$""")

        /** Frames are written in one burst; anything later is a separate event. */
        private const val CONTINUATION_WINDOW_MS = 150L

        private const val CAPACITY = 3000
        private const val BACKFILL_LINES = 400
        private const val MAX_MESSAGE_CHARS = 4000
    }
}
