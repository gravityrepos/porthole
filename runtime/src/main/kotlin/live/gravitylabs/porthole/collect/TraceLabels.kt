// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

/**
 * Names for system-trace slices, kept deliberately coarse.
 *
 * An async section's name is its track identity: every distinct string becomes
 * another row in the trace viewer. Naming a slice after the statement that
 * produced it therefore turns one screen load into ten tracks — measured, on a
 * capture where seven of the ten were Room's own invalidation triggers rather
 * than anything the app wrote.
 *
 * So the trace gets the shape of the work and Porthole's own timeline keeps the
 * detail. A row reading `db SELECT cart_items` says what happened and stays one
 * row however many times it runs with different arguments; the statement, its
 * bound values and the thread it ran on are a query away in the tools that can
 * hold them.
 */
internal object TraceLabels {

    private val VERB = Regex("""^\s*(\w+)""")

    /**
     * The table a statement touches, under whichever keyword introduces it.
     *
     * TRIGGER is deliberately absent. A trigger's name is per-object, so naming
     * a slice after it is as unbounded as naming it after the statement —
     * Room's three per table came back as three separate tracks. Without it
     * they fall back to the verb and collapse into one.
     */
    private val TABLE = Regex(
        """(?:FROM|INTO|UPDATE|TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?[`"'\[]?([A-Za-z_][\w]*)""",
        RegexOption.IGNORE_CASE,
    )

    /**
     * `db SELECT cart_items`, and `db(main) …` when it ran on the main thread —
     * which is the reason anyone would be looking at a database slice at all.
     */
    /**
     * Words the table pattern can land on that are not tables.
     *
     * `CREATE TRIGGER … AFTER UPDATE ON log` matches on UPDATE and captures
     * "ON", which shipped as the label `db CREATE ON`.
     */
    private val NOT_A_TABLE = setOf("ON", "SET", "VALUES", "SELECT", "WHERE", "AS", "BEGIN")

    /**
     * `CREATE TRIGGER … AFTER UPDATE ON log` needs a second look.
     *
     * The first pattern matches on UPDATE and consumes through "ON", so the
     * table sitting immediately after it is never scanned — filtering the
     * keyword out just left no table at all. This picks it up.
     */
    private val AFTER_ON = Regex("""(?:^|\s)ON\s+[`"'\[]?([A-Za-z_]\w*)""", RegexOption.IGNORE_CASE)

    private fun tableOf(sql: String): String? =
        TABLE.findAll(sql)
            .map { it.groupValues[1] }
            .firstOrNull { it.uppercase() !in NOT_A_TABLE }
            ?: AFTER_ON.find(sql)
                ?.groupValues?.get(1)
                ?.takeIf { it.uppercase() !in NOT_A_TABLE }

    fun db(sql: String, onMainThread: Boolean): String {
        val verb = VERB.find(sql)?.groupValues?.get(1)?.uppercase() ?: "QUERY"
        val table = tableOf(sql)
        val prefix = if (onMainThread) "db(main)" else "db"
        return if (table != null) "$prefix $verb $table" else "$prefix $verb"
    }

    /**
     * `http GET api.example.com/checkout`.
     *
     * Query string dropped: it is per-request by nature, so keeping it would
     * give every call its own track. It is already redacted before it reaches
     * here, and the full URL is on Porthole's own timeline either way.
     */
    fun http(method: String, url: String): String {
        val withoutQuery = url.substringBefore('?').substringBefore('#')
        val trimmed = withoutQuery.substringAfter("://").trimEnd('/')
        return "http ${method.uppercase()} ${trimmed.ifEmpty { url }}"
    }
}
