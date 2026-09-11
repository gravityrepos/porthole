// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory

/** Release stand-in: no open helper is wrapped, so no bind value is recorded. */
fun <T : RoomDatabase> RoomDatabase.Builder<T>.installPorthole(
    delegate: SupportSQLiteOpenHelper.Factory = FrameworkSQLiteOpenHelperFactory(),
    captureBindArgs: Boolean = true,
    maxArgChars: Int = 64,
): RoomDatabase.Builder<T> = this
