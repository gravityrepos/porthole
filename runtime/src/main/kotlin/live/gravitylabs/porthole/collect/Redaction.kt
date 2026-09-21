// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

/**
 * The two string transforms every URL and statement passes through on its way
 * out of the process.
 *
 * They live apart from the collector that uses them because they are the part
 * worth testing directly: a redaction that silently stops redacting is not
 * something you want to discover by reading a captured trace.
 */
internal object Redaction {

    private const val MAX_SQL_CHARS = 400

    /**
     * LeakCanary's own trace text runs one line per object in the reference
     * path plus a header and can run to a few thousand characters for a
     * deep chain — unbounded compared to everything else that goes in an
     * event, the same reason [collapseSql] caps a statement rather than
     * shipping it whole.
     */
    private const val MAX_LEAK_TRACE_CHARS = 6000

    /**
     * Strips every query-string value, keeping the names.
     *
     * Names are kept because knowing a request carried a `token` is useful and
     * the value never is. Everything is stripped rather than a list of known
     * sensitive names: a deny-list is only ever as good as its last update, and
     * the one time it is out of date is the time it matters.
     */
    fun url(url: String): String {
        val q = url.indexOf('?')
        if (q < 0) return url
        val redacted = url.substring(q + 1)
            .split('&')
            .filter { it.isNotEmpty() }
            .joinToString("&") { param ->
                val name = param.substringBefore('=')
                if (param.contains('=')) "$name=*" else name
            }
        return url.substring(0, q) + if (redacted.isEmpty()) "" else "?$redacted"
    }

    /** One line, and not an unbounded one: Room generates some very long SQL. */
    fun collapseSql(sql: String): String {
        val one = sql.replace(Regex("\\s+"), " ").trim()
        return if (one.length > MAX_SQL_CHARS) one.take(MAX_SQL_CHARS) + "..." else one
    }

    /**
     * Bounds a LeakCanary leak trace (GRA-64) the same way [collapseSql] bounds
     * a statement — a length cap with a visible marker, not a content filter.
     * A leak trace's own lines are class and field names, not free-text values
     * an app put there, so there is nothing to strip the way a query string's
     * values are; what there is, is no natural limit on how many objects a
     * reference path can hold, and a trace pasted into a chat window should not
     * be the one event that blows past every other bound in the ring.
     */
    fun leakTrace(text: String): String =
        if (text.length > MAX_LEAK_TRACE_CHARS) text.take(MAX_LEAK_TRACE_CHARS) + "..." else text
}
