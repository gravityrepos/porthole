// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.integration

import android.database.Cursor
import android.os.CancellationSignal
import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteDatabase
import live.gravitylabs.porthole.collect.DbRegistry
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.SupportSQLiteProgram
import androidx.sqlite.db.SupportSQLiteQuery
import androidx.sqlite.db.SupportSQLiteStatement
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import live.gravitylabs.porthole.Porthole

/**
 * Room integration.
 *
 * Room's own `setQueryCallback` fires when a query starts and never tells you
 * when it finished, which makes it useless for "what is blocking right now".
 * So this wraps the open helper instead: queries and writes are timed
 * open-to-close, bound values are recorded, and inserts and updates report what
 * they changed.
 *
 * Not covered: raw access to the underlying SQLiteDatabase that bypasses the
 * support layer entirely. Everything Room itself issues goes through here.
 */
object RoomPorthole {

    /**
     * @param captureBindArgs record the values bound to `?` placeholders. On by
     *   default, because a write with its values stripped out tells you almost
     *   nothing. Turn it off if the database holds data you would rather not
     *   have in a trace at all; the SQL and the timings still come through.
     * @param maxArgChars per-value truncation. Blobs are never included, only
     *   their size.
     */
    fun <T : RoomDatabase> RoomDatabase.Builder<T>.installPorthole(
        delegate: SupportSQLiteOpenHelper.Factory = FrameworkSQLiteOpenHelperFactory(),
        captureBindArgs: Boolean = true,
        maxArgChars: Int = 64,
    ): RoomDatabase.Builder<T> =
        openHelperFactory(SqlitePorthole.factory(delegate, captureBindArgs, maxArgChars))
}

internal class DbCapture(val bindArgs: Boolean, val maxArgChars: Int) {

    fun render(value: Any?): String = when (value) {
        null -> "null"
        is ByteArray -> "<blob " + value.size + " bytes>"
        else -> value.toString().let {
            if (it.length > maxArgChars) it.take(maxArgChars) + "..." else it
        }
    }
}

internal class PortholeOpenHelperFactory(
    private val delegate: SupportSQLiteOpenHelper.Factory,
    private val capture: DbCapture,
) : SupportSQLiteOpenHelper.Factory {
    override fun create(configuration: SupportSQLiteOpenHelper.Configuration): SupportSQLiteOpenHelper =
        PortholeOpenHelper(delegate.create(configuration), capture)
}

internal class PortholeOpenHelper(
    private val delegate: SupportSQLiteOpenHelper,
    private val capture: DbCapture,
) : SupportSQLiteOpenHelper by delegate {

    // These getters are hit on every DAO call, so the wrapper is cached and only
    // rebuilt if the helper hands back a different database (close and reopen).
    private var openDelegate: SupportSQLiteDatabase? = null
    private var wrapper: SupportSQLiteDatabase? = null

    override val readableDatabase: SupportSQLiteDatabase
        get() = wrap(delegate.readableDatabase)

    override val writableDatabase: SupportSQLiteDatabase
        get() = wrap(delegate.writableDatabase)

    @Synchronized
    private fun wrap(db: SupportSQLiteDatabase): SupportSQLiteDatabase {
        if (openDelegate !== db) {
            openDelegate = db
            wrapper = PortholeDatabase(db, capture)
            // The inspector gets the undecorated handle: reading a table to show
            // it should not emit db events for the act of looking.
            DbRegistry.register(databaseName ?: "database", db)
        }
        return wrapper ?: db
    }
}

/**
 * Interface delegation does the boring 40 methods; only the ones that actually
 * touch the disk are overridden.
 */
internal class PortholeDatabase(
    private val delegate: SupportSQLiteDatabase,
    private val capture: DbCapture,
) : SupportSQLiteDatabase by delegate {

    override fun query(query: String): Cursor = timed(query, emptyList(), "read") { delegate.query(query) }

    override fun query(query: String, bindArgs: Array<out Any?>): Cursor =
        timed(query, render(bindArgs), "read") { delegate.query(query, bindArgs) }

    override fun query(query: SupportSQLiteQuery): Cursor =
        timed(query.sql, argsOf(query), "read") { delegate.query(query) }

    override fun query(query: SupportSQLiteQuery, cancellationSignal: CancellationSignal?): Cursor =
        timed(query.sql, argsOf(query), "read") { delegate.query(query, cancellationSignal) }

    override fun execSQL(sql: String) = timed(sql, emptyList(), "write") { delegate.execSQL(sql) }

    override fun execSQL(sql: String, bindArgs: Array<out Any?>) =
        timed(sql, render(bindArgs), "write") { delegate.execSQL(sql, bindArgs) }

    override fun compileStatement(sql: String): SupportSQLiteStatement =
        PortholeStatement(delegate.compileStatement(sql), sql, capture)

    private fun render(bindArgs: Array<out Any?>): List<String> =
        if (!capture.bindArgs) emptyList() else bindArgs.map(capture::render)

    /**
     * Replays the query's bindings into a recorder to read the values without
     * executing anything. Room's own RoomSQLiteQuery stores its arguments and
     * re-binds them on demand, so this is cheap and side-effect free.
     */
    private fun argsOf(query: SupportSQLiteQuery): List<String> {
        if (!capture.bindArgs) return emptyList()
        return runCatching {
            val recorder = ArgRecorder(capture)
            query.bindTo(recorder)
            recorder.values()
        }.getOrElse { emptyList() }
    }

    private inline fun <R> timed(sql: String, args: List<String>, kind: String, body: () -> R): R {
        val inflight = Porthole.inflight() ?: return body()
        val id = inflight.queryStart(sql, args, kind)
        try {
            val result = body()
            inflight.queryEnd(id)
            return result
        } catch (e: Throwable) {
            inflight.queryEnd(id, error = e.javaClass.simpleName + ": " + e.message)
            throw e
        }
    }
}

/**
 * Compiled statements are how Room does inserts and updates, which are the ones
 * most likely to be blocking a main thread somewhere they should not be.
 *
 * The bind methods are overridden rather than delegated so the values are known
 * by the time the statement executes. Without this a write shows up as
 * `INSERT INTO cart_items VALUES (?,?,?)` and tells you nothing about what was
 * written.
 */
internal class PortholeStatement(
    private val delegate: SupportSQLiteStatement,
    private val sql: String,
    private val capture: DbCapture,
) : SupportSQLiteStatement by delegate {

    private val bindings = sortedMapOf<Int, String>()

    override fun bindNull(index: Int) {
        record(index, null)
        delegate.bindNull(index)
    }

    override fun bindLong(index: Int, value: Long) {
        record(index, value)
        delegate.bindLong(index, value)
    }

    override fun bindDouble(index: Int, value: Double) {
        record(index, value)
        delegate.bindDouble(index, value)
    }

    override fun bindString(index: Int, value: String) {
        record(index, value)
        delegate.bindString(index, value)
    }

    override fun bindBlob(index: Int, value: ByteArray) {
        record(index, value)
        delegate.bindBlob(index, value)
    }

    override fun clearBindings() {
        synchronized(bindings) { bindings.clear() }
        delegate.clearBindings()
    }

    override fun execute() = tracked("write", { null }) { delegate.execute() }

    override fun executeInsert(): Long = tracked("write", { it }) { delegate.executeInsert() }

    override fun executeUpdateDelete(): Int =
        tracked("write", { it.toLong() }) { delegate.executeUpdateDelete() }

    override fun simpleQueryForLong(): Long = tracked("read", { it }) { delegate.simpleQueryForLong() }

    override fun simpleQueryForString(): String? =
        tracked("read", { null }) { delegate.simpleQueryForString() }

    /**
     * @param resultOf pulls the reportable number out of the statement's return
     *   value: the new row id for an insert, the row count for an update.
     */
    private inline fun <R> tracked(kind: String, resultOf: (R) -> Long?, body: () -> R): R {
        val inflight = Porthole.inflight() ?: return body()
        val id = inflight.queryStart(sql, args(), kind)
        try {
            val result = body()
            inflight.queryEnd(id, result = resultOf(result))
            return result
        } catch (e: Throwable) {
            inflight.queryEnd(id, error = e.javaClass.simpleName + ": " + e.message)
            throw e
        }
    }

    private fun record(index: Int, value: Any?) {
        if (!capture.bindArgs) return
        synchronized(bindings) { bindings[index] = capture.render(value) }
    }

    private fun args(): List<String> = synchronized(bindings) { bindings.values.toList() }
}

/** Collects bound values without touching a database. */
internal class ArgRecorder(private val capture: DbCapture) : SupportSQLiteProgram {

    private val bindings = sortedMapOf<Int, String>()

    fun values(): List<String> = bindings.values.toList()

    override fun bindNull(index: Int) {
        bindings[index] = capture.render(null)
    }

    override fun bindLong(index: Int, value: Long) {
        bindings[index] = capture.render(value)
    }

    override fun bindDouble(index: Int, value: Double) {
        bindings[index] = capture.render(value)
    }

    override fun bindString(index: Int, value: String) {
        bindings[index] = capture.render(value)
    }

    override fun bindBlob(index: Int, value: ByteArray) {
        bindings[index] = capture.render(value)
    }

    override fun clearBindings() {
        bindings.clear()
    }

    override fun close() = Unit
}
