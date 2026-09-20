// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import android.app.Application
import android.content.pm.ApplicationInfo

/**
 * GRA-240: [Porthole.install] now refuses to start unless
 * `ApplicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE` is set.
 * Robolectric's synthetic `ApplicationInfo` for a test with no manifest
 * (`@Config(manifest = Config.NONE)`, what every test in this module that
 * calls [Porthole.install] uses) does not set that flag on its own, so any
 * such test now needs this first — [DebuggableGateTest] is the one place
 * that flag is meant to be exercised directly; everywhere else it would just
 * be unrelated noise on every install() call.
 */
internal fun Application.makeDebuggableForTest() {
    applicationInfo.flags = applicationInfo.flags or ApplicationInfo.FLAG_DEBUGGABLE
}
