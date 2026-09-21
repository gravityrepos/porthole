// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package com.example.shop

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper

/**
 * GRA-64: a deliberate, obvious leak — a fixture for exercising
 * `LeakCanaryPorthole` end to end, not a defect a real app would ship. A
 * plain top-level `object` outlives every `Activity`, so a reference it
 * holds is held forever; this is the textbook shape LeakCanary's own sample
 * app uses to demonstrate itself.
 *
 * Wired to the "Leak activity" button in [com.example.shop.ui.Controls]:
 * press it, then background the app (LeakCanary only dumps once retained
 * objects have been idle a few seconds after a `TRIM_MEMORY` callback, not
 * while the app is in the foreground doing other things) and wait. Once
 * LeakCanary finishes analyzing the dump, `LeakCanaryPorthole` reports the
 * retained [MainActivity][com.example.shop.ui.MainActivity] as a `leak`
 * event, and `findings` promotes it to `warning`.
 */
object LeakFixture {

    /** Never cleared — that omission is the entire fixture. */
    private var leaked: Activity? = null

    fun leak(context: Context) {
        leaked = context.unwrapActivity()
    }

    private tailrec fun Context.unwrapActivity(): Activity? = when (this) {
        is Activity -> this
        is ContextWrapper -> baseContext.unwrapActivity()
        else -> null
    }
}
