// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.integration

import android.app.Activity
import androidx.activity.ComponentActivity

/**
 * Catches the platform's own `Activity.reportFullyDrawn()` call, for free.
 *
 * androidx.activity 1.7 gave `ComponentActivity` a `fullyDrawnReporter`
 * property (`FullyDrawnReporter`, `by lazy`), and `ComponentActivity`'s own
 * `reportFullyDrawn()` override routes through it — `super.reportFullyDrawn()`
 * (the platform call GRA-60's `Porthole.reportFullyDrawn()` doc comment
 * describes as otherwise unobservable), then `fullyDrawnReporter.fullyDrawnReported()`.
 * `addOnReportDrawnListener` is a plain callback for exactly that moment, and
 * it is *every* Compose app: `ComponentActivity` is what `setContent` runs
 * inside. So this is the "no app code" path GRA-60 asked for; `Porthole.reportFullyDrawn()`
 * stays as the documented fallback for an app whose Activity does not extend
 * `ComponentActivity` at all.
 *
 * [attach] is only ever called after [live.gravitylabs.porthole.collect.StartupCollector]
 * has confirmed `androidx.activity.ComponentActivity` is really on the
 * classpath — the same `classPresent`-then-touch shape
 * `WorkManagerPorthole`/`RoomPorthole` use for their own compileOnly
 * dependency, and for the same reason: referencing `ComponentActivity`
 * anywhere reachable without that guard would throw in an app that never
 * depended on androidx.activity at all.
 */
internal object ComponentActivityPorthole {

    /**
     * @return true when [activity] is a [ComponentActivity] and the listener
     *   was attached — false for a plain `Activity`, which this cannot help
     *   with, and is not a failure, just a different app shape.
     */
    fun attach(activity: Activity, onReportFullyDrawn: () -> Unit): Boolean {
        val component = activity as? ComponentActivity ?: return false
        // "If it has already been called, then callback will be called
        // immediately" — FullyDrawnReporter's own doc comment. So a listener
        // attached after a very fast reportFullyDrawn() still fires, rather
        // than silently missing it.
        component.fullyDrawnReporter.addOnReportDrawnListener(onReportFullyDrawn)
        return true
    }
}
