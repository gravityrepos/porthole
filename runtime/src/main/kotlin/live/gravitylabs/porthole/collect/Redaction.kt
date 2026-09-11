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
}
