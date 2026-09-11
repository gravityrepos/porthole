// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import live.gravitylabs.porthole.integration.SqlitePorthole

/**
 * One import for the integrations that are not tied to a builder.
 *
 * The builder-bound ones — OkHttp, Room — live beside their own library so a
 * file that does not use Ktor never loads Ktor's classes to find out. These two
 * have no such constraint.
 *
 * @see live.gravitylabs.porthole.installPorthole
 */

/**
 * The open-helper factory for anything built on androidx.sqlite: SQLDelight's
 * `AndroidSqliteDriver`, Requery, or a hand-rolled helper.
 *
 * ```kotlin
 * AndroidSqliteDriver(schema = Schema, context = context, name = "app.db",
 *     factory = portholeSqliteFactory())
 * ```
 */
@JvmOverloads
fun portholeSqliteFactory(
    delegate: SupportSQLiteOpenHelper.Factory = FrameworkSQLiteOpenHelperFactory(),
    captureBindArgs: Boolean = true,
    maxArgChars: Int = 64,
): SupportSQLiteOpenHelper.Factory =
    SqlitePorthole.factory(delegate, captureBindArgs, maxArgChars)
