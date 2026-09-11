// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import java.lang.ref.WeakReference

/**
 * Finds what it can on its own, so an app has less to hand over.
 *
 * Two of the three registration calls the tool used to require can be worked
 * out from an Activity, and an Activity is something the runtime already sees
 * without being told. What is left is the integrations — Room, OkHttp, Ktor —
 * which genuinely cannot be discovered, because instrumenting a client means
 * being handed the builder before it is built.
 *
 * Reflection rather than a dependency on androidx.lifecycle. This reads one
 * method on one class, it is optional, and every failure is survivable; making
 * a consuming build resolve another artifact to get it would cost more than it
 * is worth.
 */
internal class AutoWire(
    private val semantics: SemanticsCollector,
    private val state: StateCollector,
) {

    private val seen = HashSet<Int>()
    private val main = Handler(Looper.getMainLooper())

    fun install(app: Application): Boolean {
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                attachView(activity)
                scanRepeatedly(activity)
            }

            override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, out: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
        return true
    }

    /**
     * onResume is too early on its own.
     *
     * `viewModel()` builds its model during composition, and composition runs
     * after onResume returns, so the store is empty at the moment the activity
     * says it is resumed. Looking once found nothing at all. These follow-ups
     * cover the first composition and a slow one; they are idempotent, so the
     * later passes cost a set lookup each.
     */
    private fun scanRepeatedly(activity: Activity) {
        val ref = WeakReference(activity)
        registerViewModels(activity)
        for (delay in RESCAN_DELAYS_MS) {
            main.postDelayed({ ref.get()?.let(::registerViewModels) }, delay)
        }
    }

    /**
     * The decor view holds whatever Compose put in it, so the semantics
     * collector has something to walk without the app wrapping its content.
     */
    private fun attachView(activity: Activity) {
        runCatching { semantics.attach(activity.window.decorView) }
    }

    /** Activity-scoped view models. Screen-scoped ones come via NavCollector. */
    private fun registerViewModels(activity: Activity) {
        ViewModelScan.register(activity, state, seen)
    }

    private companion object {
        const val TAG = "Porthole"

        /** After resume, in ms. Enough to cover a first composition and a slow one. */
        val RESCAN_DELAYS_MS = longArrayOf(250, 1_000, 3_000)
    }
}
