// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory

/**
 * Release stand-in: hands back the delegate itself, so a release build opens its
 * database through exactly the factory it would have used with this library
 * absent.
 */
@JvmOverloads
fun portholeSqliteFactory(
    delegate: SupportSQLiteOpenHelper.Factory = FrameworkSQLiteOpenHelperFactory(),
    captureBindArgs: Boolean = true,
    maxArgChars: Int = 64,
): SupportSQLiteOpenHelper.Factory = delegate
