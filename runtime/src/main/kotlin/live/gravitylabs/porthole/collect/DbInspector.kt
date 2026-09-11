// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.database.Cursor
import androidx.sqlite.db.SupportSQLiteDatabase
import live.gravitylabs.porthole.protocol.DbColumn
import live.gravitylabs.porthole.protocol.DbPage
import live.gravitylabs.porthole.protocol.DbTable
import live.gravitylabs.porthole.protocol.DbTables
import java.util.concurrent.ConcurrentHashMap

/**
 * Every database the app opened through the porthole, kept so it can be read
 * back on request.
 *
 * The handle stored here is the *undecorated* database, deliberately. Reading a
 * table through the instrumented wrapper would emit db events for the act of
 * looking, and the inspector would fill the timeline with its own reflection.
 */
internal object DbRegistry {

    private val open = ConcurrentHashMap<String, SupportSQLiteDatabase>()

    internal fun register(name: String, database: SupportSQLiteDatabase) {
        open[name] = database
    }

    internal fun names(): List<String> = open.keys.sorted()

    internal fun get(name: String?): SupportSQLiteDatabase? =
        if (name == null) open.values.firstOrNull() else open[name]
}

/**
 * Read-only access to the app's own tables.
 *
 * Read-only is enforced here rather than trusted: the socket is loopback and
 * debug-only, but "debug-only" is not a reason to let a viewer mutate the data
 * it is trying to understand. One statement, and it must be a SELECT, a WITH,
 * or a PRAGMA with no assignment in it.
 */
internal class DbInspector {

    fun tables(dbName: String?): DbTables {
        val db = DbRegistry.get(dbName)
            ?: return DbTables(
                database = dbName,
                databases = DbRegistry.names(),
                tables = emptyList(),
                error = NO_DATABASE,
            )

        val tables = mutableListOf<DbTable>()
        db.query(
            "SELECT name FROM sqlite_master WHERE type = 'table' " +
                "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'android_%' ORDER BY name",
        ).use { cursor ->
            while (cursor.moveToNext()) tables += DbTable(cursor.getString(0), rows = -1)
        }

        return DbTables(
            database = dbName ?: DbRegistry.names().firstOrNull(),
            databases = DbRegistry.names(),
            tables = tables.map { table ->
                table.copy(rows = countOf(db, table.name))
            },
        )
    }

    fun rows(dbName: String?, table: String, limit: Int, offset: Int, withCount: Boolean = true): DbPage {
        val db = DbRegistry.get(dbName)
            ?: return DbPage(table = table, error = NO_DATABASE)

        if (!isKnownTable(db, table)) {
            return DbPage(table = table, error = "No table named '$table' in this database.")
        }

        val capped = limit.coerceIn(1, MAX_ROWS)
        // SQLite keeps no row count, so COUNT(*) scans the table. Worth it when
        // a human opens a table; not worth repeating on a poll, which is why
        // the caller gets to say no.
        return read(db, "SELECT * FROM \"${table.replace("\"", "\"\"")}\" LIMIT $capped OFFSET ${offset.coerceAtLeast(0)}")
            .copy(
                table = table,
                total = if (withCount) countOf(db, table) else -1,
                offset = offset.coerceAtLeast(0),
            )
    }

    fun query(dbName: String?, sql: String): DbPage {
        // Checked before the database is even looked up: a statement that is not
        // allowed is not allowed whether or not there is something to run it on,
        // and this way the rule can be tested without a database at all.
        val trimmed = sql.trim().trimEnd(';').trim()
        refusalFor(trimmed)?.let { return DbPage(table = null, error = it) }

        val db = DbRegistry.get(dbName)
            ?: return DbPage(table = null, error = NO_DATABASE)

        return read(db, trimmed)
    }

    /** The reason this statement is refused, or null if it may run. */
    internal fun refusalFor(sql: String): String? {
        val trimmed = sql.trim().trimEnd(';').trim()
        if (trimmed.isEmpty()) return "Nothing to run."
        if (trimmed.contains(';')) return "One statement at a time."
        // A bare PRAGMA reads; "PRAGMA user_version = 5" writes, and no
        // transaction would undo it, so the assignment form is refused outright
        // rather than wrapped and hoped about.
        if (SELECTS.matches(trimmed) || READ_PRAGMA.matches(trimmed)) return null
        return "Only a single SELECT, WITH, or read-only PRAGMA is allowed. " +
            "The inspector reads; it does not write."
    }

    private fun read(db: SupportSQLiteDatabase, sql: String): DbPage {
        // No transaction wrapper. It would not undo a pragma, and taking one on
        // a connection the app is writing through would block this thread on
        // the app's own work — a debug view is not worth stalling the app for.
        return try {
            db.query(sql).use { cursor -> page(cursor) }
        } catch (error: Throwable) {
            DbPage(table = null, error = error.message ?: error.javaClass.simpleName)
        }
    }

    private fun page(cursor: Cursor): DbPage {
        val names = cursor.columnNames.toList()
        // SQLite types belong to values, not columns, so they can only be read
        // off a row — and only while the cursor is still sitting on one. Taken
        // from the first row for that reason; asking afterwards throws, because
        // by then the cursor is parked past the end.
        var types = names.map { "" }
        val rows = mutableListOf<List<String?>>()
        var truncated = false

        while (cursor.moveToNext()) {
            if (rows.isEmpty()) types = names.indices.map { index -> typeName(cursor, index) }
            if (rows.size >= MAX_ROWS) {
                truncated = true
                break
            }
            rows += names.indices.map { index -> cell(cursor, index) }
        }

        return DbPage(
            table = null,
            columns = names.mapIndexed { index, name -> DbColumn(name, types[index]) },
            rows = rows,
            truncated = truncated,
        )
    }

    private fun cell(cursor: Cursor, index: Int): String? = when (cursor.getType(index)) {
        Cursor.FIELD_TYPE_NULL -> null
        // A blob's contents are rarely what you want in a table cell, and could
        // be megabytes. Its size is the useful part.
        Cursor.FIELD_TYPE_BLOB -> "<blob " + (cursor.getBlob(index)?.size ?: 0) + " bytes>"
        else -> cursor.getString(index)?.take(MAX_CELL_CHARS)
    }

    private fun typeName(cursor: Cursor, index: Int): String =
        when (cursor.getType(index)) {
            Cursor.FIELD_TYPE_INTEGER -> "integer"
            Cursor.FIELD_TYPE_FLOAT -> "real"
            Cursor.FIELD_TYPE_STRING -> "text"
            Cursor.FIELD_TYPE_BLOB -> "blob"
            else -> "null"
        }

    private fun isKnownTable(db: SupportSQLiteDatabase, table: String): Boolean =
        db.query(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
            arrayOf<Any?>(table),
        ).use { it.moveToFirst() }

    private fun countOf(db: SupportSQLiteDatabase, table: String): Int = runCatching {
        db.query("SELECT COUNT(*) FROM \"${table.replace("\"", "\"\"")}\"").use {
            if (it.moveToFirst()) it.getInt(0) else -1
        }
    }.getOrDefault(-1)

    internal companion object {
        const val NO_DATABASE = "No database has been opened through the porthole yet."
        const val MAX_ROWS = 500
        const val MAX_CELL_CHARS = 2000

        val SELECTS = Regex(
            "^\\s*(select|with)\\b.*",
            setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
        )

        /** A pragma with no assignment in it: "pragma table_info(cart_items)". */
        val READ_PRAGMA = Regex(
            "^\\s*pragma\\s+[a-z_]+\\s*\\(?[a-z0-9_\"'. ]*\\)?\\s*$",
            RegexOption.IGNORE_CASE,
        )
    }
}
