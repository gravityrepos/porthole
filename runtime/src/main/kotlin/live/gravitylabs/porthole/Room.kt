// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import live.gravitylabs.porthole.integration.RoomPorthole

/**
 * Instruments a Room database.
 *
 * ```kotlin
 * Room.databaseBuilder(context, AppDb::class.java, "app.db").installPorthole().build()
 * ```
 *
 * Room is not what is being instrumented — `SupportSQLiteOpenHelper` is, and
 * Room is one of the things that opens a database through it. See
 * [portholeSqliteFactory] for everything else built on the same layer.
 *
 * @param captureBindArgs record the values bound to `?` placeholders. On by
 *   default, because a write with its values stripped tells you almost nothing.
 * @param maxArgChars per-value truncation. Blobs are never included, only sized.
 */
fun <T : RoomDatabase> RoomDatabase.Builder<T>.installPorthole(
    delegate: SupportSQLiteOpenHelper.Factory = FrameworkSQLiteOpenHelperFactory(),
    captureBindArgs: Boolean = true,
    maxArgChars: Int = 64,
): RoomDatabase.Builder<T> =
    with(RoomPorthole) { installPorthole(delegate, captureBindArgs, maxArgChars) }
