// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.app.ActivityManager
import android.app.Application
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.EventKinds
import live.gravitylabs.porthole.protocol.ExitTraceResult
import live.gravitylabs.porthole.store.EventRing
import java.io.File
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * The process that held the ring buffer is the process that died, so the ring
 * never has the answer to "why". Android does, for free:
 * `ActivityManager.getHistoricalProcessExitReasons` remembers the last several
 * deaths of *this* package across process restarts (API 30+, no permission
 * needed for your own package), including — for an ANR or a native crash —
 * the actual trace blob.
 *
 * This never installs a crash handler and never catches a signal. It reads
 * what the system already recorded, once, on the next launch after the death.
 *
 * One record is a plain domain type ([ExitRecord]), not `ApplicationExitInfo`
 * itself: that class has no public constructor, so a test cannot build one,
 * and reflecting into it is exactly what this project's own lesson (GRA-86's
 * ShutdownTest doc comment, `Redaction`'s doc comment) says not to do —
 * a self-written fixture tests the shape you assumed. [ExitHistoryProvider]
 * is the seam: production wires [defaultHistoryProvider], a test wires a
 * lambda that returns hand-built [ExitRecord]s.
 */
internal class ExitInfoCollector(
    private val ring: EventRing,
    /** Package prefixes belonging to the app, so its own frames lead — same idea as [StackFormat]. */
    private val appPackages: List<String> = emptyList(),
    private val historyProvider: ExitHistoryProvider = ::defaultHistoryProvider,
) {

    /** Full redacted trace text, keyed by the exit's own timestamp — [trace]'s answer when there is one. */
    private val traceCache = ConcurrentHashMap<Long, String>()

    /** Every timestamp this process has ever seen from the provider, mapped to its reason name.
     *  Populated for every record the OS still remembers, not only the ones newly reported this
     *  install — this is what lets [trace] tell "no trace exists for this exit" (a crash, say)
     *  apart from "this timestamp was never an exit at all". */
    private val knownReasons = ConcurrentHashMap<Long, String>()

    /**
     * Reads the exit history once, emits one `exit` event per death not
     * already reported (dedup file in [Application.getFilesDir], so a
     * reconnect or reinstall never re-reports), and returns `true`
     * unconditionally — like [DeviceCollector.install], this is never
     * "did the dependency exist" the way `frames`/`autoWire` are, only
     * "did this collector do its setup".
     *
     * Below API 30 this does nothing and emits nothing at all: `hello`
     * already carries `sdkInt`, which is all the MCP side needs to say the
     * API is unavailable, so there is no "unavailable" event to invent here.
     */
    fun install(app: Application): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return true

        val reportedFile = File(app.filesDir, REPORTED_FILE)
        val alreadyReported = readReported(reportedFile)
        val records = runCatching { historyProvider(app) }.getOrDefault(emptyList()).sortedBy { it.timestamp }
        if (records.isEmpty()) return true

        val currentVersionName = runCatching {
            app.packageManager.getPackageInfo(app.packageName, 0).versionName
        }.getOrNull()

        val newlyReported = mutableListOf<Long>()
        for (record in records) {
            val reasonName = reasonName(record.reason)
            // Read and parse the trace blob exactly once per record,
            // regardless of dedupe: the input stream behind it is
            // consume-once, and a record already reported in an earlier run
            // is still worth caching for `trace()` — the OS keeps remembering
            // it (up to MAX_HISTORY entries) even after this process has
            // already told the ring about it once.
            val parsed = if (reasonName == REASON_ANR || reasonName == REASON_CRASH_NATIVE) {
                readAndParseTrace(record)
            } else {
                null
            }
            knownReasons[record.timestamp] = reasonName
            if (parsed != null) traceCache[record.timestamp] = parsed.redactedText

            if (record.timestamp in alreadyReported) continue
            val (versionName, versionAssumed) = resolveVersionName(record, currentVersionName)
            ring.emit(
                EventKinds.EXIT,
                buildExitEvent(record, reasonName, versionName, versionAssumed, parsed),
                at = nowMs(),
            )
            newlyReported += record.timestamp
        }

        if (newlyReported.isNotEmpty()) writeReported(reportedFile, alreadyReported + newlyReported)
        return true
    }

    /**
     * Nothing here owns a thread, a receiver or a callback — the history read
     * and the dedupe-file write both already happened, synchronously, inside
     * [install]. Present anyway, and called from [live.gravitylabs.porthole.Porthole.shutdown],
     * so this collector is stopped the same way every other one is (GRA-86)
     * and so a field that declares `install(Application)` always has a
     * matching `stop()` — the structural half of `ShutdownTest` checks for
     * exactly that on every `Session` field, whether or not it has anything
     * to undo.
     */
    fun stop() = Unit

    /**
     * The full redacted trace for the exit at [timestamp] — the second call
     * `porthole_status`'s `exitTrace` parameter makes, so the summary event
     * never has to carry the whole blob. Capped at [MAX_TRACE_CHARS] with a
     * truncation note; distinguishes "no exit at this timestamp at all" from
     * "this exit is real but had no trace" (a plain crash, say, or an ANR
     * whose blob the system never produced), because those are different
     * facts and only one of them means the timestamp was wrong.
     */
    fun trace(timestamp: Long): ExitTraceResult {
        val cached = traceCache[timestamp]
        if (cached != null) {
            val truncated = cached.length > MAX_TRACE_CHARS
            val text = if (truncated) {
                cached.take(MAX_TRACE_CHARS) + "\n\n[...truncated at $MAX_TRACE_CHARS characters...]"
            } else {
                cached
            }
            return ExitTraceResult(timestamp = timestamp, found = true, text = text, truncated = truncated)
        }
        val reason = knownReasons[timestamp]
        return if (reason != null) {
            ExitTraceResult(
                timestamp = timestamp,
                found = false,
                error = "no trace blob for this exit (reason was $reason; only $REASON_ANR and " +
                    "$REASON_CRASH_NATIVE carry one)",
            )
        } else {
            ExitTraceResult(timestamp = timestamp, found = false, error = "no exit recorded for timestamp $timestamp")
        }
    }

    // -- trace blob: read, redact, parse -------------------------------------

    private class ParsedTrace(
        val redactedText: String,
        val mainFrames: List<StackTraceElement>,
        val otherThreadCount: Int,
        val otherThreadStates: Map<String, Int>,
    )

    private fun readAndParseTrace(record: ExitRecord): ParsedTrace? {
        val stream = record.traceInputStream?.invoke() ?: return null
        val raw = runCatching { stream.use { it.readBytes() } }.getOrNull() ?: return null
        val text = String(raw, Charsets.UTF_8)
        val redacted = text.lineSequence().joinToString("\n", transform = ::redactLine)
        val parsed = AnrTraceParser.parse(redacted)
        return ParsedTrace(redacted, parsed.mainFrames, parsed.otherThreadCount, parsed.otherThreadStates)
    }

    /**
     * Runs [Redaction.url] over every quoted segment of a trace line, not the
     * line as a whole.
     *
     * `Redaction.url` strips everything after the first `?` it finds, which
     * is correct when its input *is* a URL and wrong the moment anything
     * follows one — and a thread's header line is exactly that: `"OkHttp
     * https://api.example.com/x?token=abc" prio=5 tid=15 Waiting` has
     * `prio=`/`tid=`/the thread's state sitting right after the name.
     * Redacting the whole line would swallow all of that into the starred
     * value and break parsing along with it. Scoping to each `"..."` segment
     * redacts exactly the thread name — the one place in this format an app
     * chooses the text — and leaves the framework's own fields untouched.
     */
    private fun redactLine(line: String): String =
        QUOTED_SEGMENT.replace(line) { match -> "\"" + Redaction.url(match.groupValues[1]) + "\"" }

    private fun buildExitEvent(
        record: ExitRecord,
        reasonName: String,
        versionName: String?,
        versionAssumed: Boolean,
        parsed: ParsedTrace?,
    ): JsonObject = JsonObject(
        buildMap {
            put("reason", JsonPrimitive(reasonName))
            put("importance", JsonPrimitive(record.importance))
            put("timestamp", JsonPrimitive(record.timestamp))
            put("pss", JsonPrimitive(record.pss))
            put("rss", JsonPrimitive(record.rss))
            record.description?.let { put("description", JsonPrimitive(Redaction.url(it))) }
            versionName?.let { put("versionName", JsonPrimitive(it)) }
            put("versionAssumed", JsonPrimitive(versionAssumed))
            if (parsed != null) {
                // Absent, not empty, when the trace carried no frame this
                // process recognised as the main thread — an empty string
                // would read as "the main thread had an empty stack", which
                // is a different and false claim.
                if (parsed.mainFrames.isNotEmpty()) {
                    put(
                        "mainStack",
                        JsonPrimitive(StackFormat.render(StackFormat.order(parsed.mainFrames, appPackages))),
                    )
                }
                put("otherThreadCount", JsonPrimitive(parsed.otherThreadCount))
                put(
                    "otherThreadStates",
                    JsonObject(parsed.otherThreadStates.mapValues { (_, count) -> JsonPrimitive(count) }),
                )
            }
        },
    )

    /**
     * `processStateSummary` is a byte blob the app itself sets via
     * `Process.setProcessStateSummary` — Porthole does not control whether an
     * app uses it, so this degrades: a summary that decodes to a short,
     * printable, version-shaped string wins; failing that, a version-looking
     * token pulled out of `description`; failing that, the *running* build's
     * own versionName, flagged as assumed. EM's note: the first run after
     * `installDebug` reports the *previous* build's deaths, so "assumed" is
     * not a hedge here, it is frequently wrong in exactly that case — which
     * is why the flag exists rather than a silent guess.
     */
    private fun resolveVersionName(record: ExitRecord, currentVersionName: String?): Pair<String?, Boolean> {
        val fromSummary = record.processStateSummary
            ?.let { runCatching { String(it, Charsets.UTF_8) }.getOrNull() }
            ?.trim()
            ?.takeIf { it.isNotEmpty() && it.length <= 64 && it.all { c -> c.isLetterOrDigit() || c in ".-_+" } }
        if (fromSummary != null) return fromSummary to false

        val fromDescription = record.description?.let { VERSION_IN_TEXT.find(it)?.value }
        if (fromDescription != null) return fromDescription to false

        return currentVersionName to true
    }

    // -- dedupe file ----------------------------------------------------------

    private fun readReported(file: File): Set<Long> = runCatching {
        if (!file.exists()) return emptySet()
        file.readLines().mapNotNull { it.trim().toLongOrNull() }.toSet()
    }.getOrDefault(emptySet())

    private fun writeReported(file: File, timestamps: Collection<Long>) {
        runCatching {
            val capped = timestamps.toSortedSet().toList().takeLast(REPORTED_CAP)
            file.writeText(capped.joinToString("\n"))
        }
    }

    private fun reasonName(reason: Int): String = when (reason) {
        ApplicationExitInfo.REASON_UNKNOWN -> "REASON_UNKNOWN"
        ApplicationExitInfo.REASON_EXIT_SELF -> "REASON_EXIT_SELF"
        ApplicationExitInfo.REASON_SIGNALED -> "REASON_SIGNALED"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "REASON_LOW_MEMORY"
        ApplicationExitInfo.REASON_CRASH -> "REASON_CRASH"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> REASON_CRASH_NATIVE
        ApplicationExitInfo.REASON_ANR -> REASON_ANR
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "REASON_INITIALIZATION_FAILURE"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "REASON_PERMISSION_CHANGE"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "REASON_EXCESSIVE_RESOURCE_USAGE"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "REASON_USER_REQUESTED"
        ApplicationExitInfo.REASON_USER_STOPPED -> "REASON_USER_STOPPED"
        ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "REASON_DEPENDENCY_DIED"
        ApplicationExitInfo.REASON_OTHER -> "REASON_OTHER"
        ApplicationExitInfo.REASON_FREEZER -> "REASON_FREEZER"
        ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE -> "REASON_PACKAGE_STATE_CHANGE"
        ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "REASON_PACKAGE_UPDATED"
        else -> "REASON_UNKNOWN($reason)"
    }

    private companion object {
        const val REPORTED_FILE = "porthole_exit_reported.txt"

        /** Bounds the dedupe file's growth; far more than the 16 records the provider ever returns at once. */
        const val REPORTED_CAP = 200

        const val MAX_TRACE_CHARS = 256 * 1024

        const val REASON_ANR = "REASON_ANR"
        const val REASON_CRASH_NATIVE = "REASON_CRASH_NATIVE"

        val VERSION_IN_TEXT = Regex("""\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?""")
        val QUOTED_SEGMENT = Regex("\"([^\"]*)\"")
    }
}

/**
 * One recorded death, independent of `ApplicationExitInfo` — see the class
 * doc comment on [ExitInfoCollector] for why. [traceInputStream] is a lambda
 * rather than a stream: the real one is consume-once and opened lazily by the
 * framework, so a fake can hand back a fresh stream on every call the same
 * way, or `null` for a reason that never carries a trace.
 */
internal class ExitRecord(
    /** Wall-clock epoch millis the process died — `ApplicationExitInfo.getTimestamp()`'s own unit,
     *  distinct from every other timestamp in this codebase, which is device uptime. */
    val timestamp: Long,
    /** One of `ApplicationExitInfo.REASON_*`. */
    val reason: Int,
    val importance: Int,
    /** KB, the unit `ApplicationExitInfo` itself reports in. */
    val pss: Long,
    val rss: Long,
    val description: String? = null,
    val processStateSummary: ByteArray? = null,
    val traceInputStream: (() -> InputStream?)? = null,
)

internal typealias ExitHistoryProvider = (Context) -> List<ExitRecord>

/**
 * Wraps `ActivityManager.getHistoricalProcessExitReasons(packageName, 0, 16)`
 * — the app's own package, no permission required, the last 16 deaths the
 * system still remembers. `0` for the `pid` argument means "any process of
 * this package", which is what you want after a restart: the previous
 * process's pid is gone.
 */
@Suppress("NewApi") // guarded by the SDK_INT check in ExitInfoCollector.install before this is ever called
private fun defaultHistoryProvider(context: Context): List<ExitRecord> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
    val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        ?: return emptyList()
    return runCatching {
        activityManager.getHistoricalProcessExitReasons(context.packageName, 0, 16).map { info ->
            ExitRecord(
                timestamp = info.timestamp,
                reason = info.reason,
                importance = info.importance,
                pss = info.pss,
                rss = info.rss,
                description = info.description,
                processStateSummary = info.processStateSummary,
                traceInputStream = { runCatching { info.traceInputStream }.getOrNull() },
            )
        }
    }.getOrDefault(emptyList())
}

/**
 * The app's own frames first within the main thread's block, then a tally of
 * every other thread's state — the shape the EM's note asked for: "the
 * blob is the largest payload this product will ever return... carry the
 * main thread's stack plus a count of other threads and their states; the
 * full blob is a second call."
 *
 * Parses the plain-text thread-dump format ART writes for an ANR or a native
 * crash's Java-visible stack (the same shape `/data/anr/traces.txt` entries
 * have): a header line per thread — `"name" prio=N tid=N <State>` — followed
 * by `at Class.method(File:line)` frames until the next header.
 */
internal object AnrTraceParser {

    internal class Parsed(
        val mainFrames: List<StackTraceElement>,
        val otherThreadCount: Int,
        val otherThreadStates: Map<String, Int>,
    )

    /** Captures the thread's quoted name and the state token right after `tid=<n>`. */
    private val THREAD_HEADER = Regex("""^"([^"]*)"[^\n]*?\btid=\d+\s+(\S+)""")

    private val FRAME = Regex("""^\s*at\s+([\w$.]+)\.([\w$<>]+)\(([^)]*)\)\s*$""")

    fun parse(text: String): Parsed {
        val lines = text.lines()
        val headers = lines.withIndex().mapNotNull { (index, line) ->
            THREAD_HEADER.find(line)?.let { index to it }
        }
        if (headers.isEmpty()) return Parsed(emptyList(), 0, emptyMap())

        var mainFrames: List<StackTraceElement> = emptyList()
        val otherStates = mutableMapOf<String, Int>()
        var otherCount = 0

        for ((position, header) in headers.withIndex()) {
            val (start, match) = header
            val end = if (position + 1 < headers.size) headers[position + 1].first else lines.size
            val name = match.groupValues[1]

            if (name == "main") {
                mainFrames = lines.subList(start, end).mapNotNull(::frameOf)
            } else {
                otherCount++
                val state = match.groupValues[2].trim().trimEnd(':', ',')
                otherStates[state] = (otherStates[state] ?: 0) + 1
            }
        }
        return Parsed(mainFrames, otherCount, otherStates)
    }

    private fun frameOf(line: String): StackTraceElement? {
        val match = FRAME.find(line) ?: return null
        val className = match.groupValues[1]
        val methodName = match.groupValues[2]
        val location = match.groupValues[3]
        if (location == "Native Method") return StackTraceElement(className, methodName, null, -2)

        val colon = location.lastIndexOf(':')
        return if (colon < 0) {
            StackTraceElement(className, methodName, location.ifEmpty { null }, -1)
        } else {
            val fileName = location.substring(0, colon)
            val lineNumber = location.substring(colon + 1).toIntOrNull() ?: -1
            StackTraceElement(className, methodName, fileName, lineNumber)
        }
    }
}
