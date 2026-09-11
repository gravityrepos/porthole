// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.integration

import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory

/**
 * The database porthole, for anything that is not Room.
 *
 * Room was never what was being instrumented — `SupportSQLiteOpenHelper` was,
 * and Room is only one of the things that opens a database through it.
 * SQLDelight's `AndroidSqliteDriver` takes a factory, and so does anything else
 * built on androidx.sqlite, so they can all be handed this one.
 *
 * ```kotlin
 * AndroidSqliteDriver(
 *     schema = Schema,
 *     context = context,
 *     name = "cart.db",
 *     factory = SqlitePorthole.factory(),
 * )
 * ```
 *
 * The instrumented database is what the caller ends up using, and a separate
 * undecorated handle goes to the inspector, so reading a table to display it
 * does not emit query events for the act of looking.
 */
object SqlitePorthole {

    /**
     * @param delegate the factory that actually opens the file. The framework
     *   one unless you are already using something else, such as Requery.
     * @param captureBindArgs record the values bound to `?` placeholders. On by
     *   default, because a write with its values stripped tells you almost
     *   nothing. Turn it off if the database holds data you would rather not
     *   have in a trace at all; the SQL and the timings still come through.
     * @param maxArgChars per-value truncation. Blobs are never included, only
     *   their size.
     */
    @JvmOverloads
    fun factory(
        delegate: SupportSQLiteOpenHelper.Factory = FrameworkSQLiteOpenHelperFactory(),
        captureBindArgs: Boolean = true,
        maxArgChars: Int = 64,
    ): SupportSQLiteOpenHelper.Factory =
        PortholeOpenHelperFactory(delegate, DbCapture(captureBindArgs, maxArgChars))
}
