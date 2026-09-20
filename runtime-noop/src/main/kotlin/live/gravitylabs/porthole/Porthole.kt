// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import android.app.Application
import android.view.View

/**
 * Release-build stand-in. Same signatures as the real [Porthole], no behaviour.
 *
 * This artifact is what the Gradle plugin puts on `releaseImplementation`, so
 * `Porthole.registerViewModel(...)` left in production code costs a method call
 * that R8 then removes entirely.
 */
object Porthole {

    /** False here; true when the debug runtime is on the classpath. */
    const val ENABLED: Boolean = false

    const val DEFAULT_PORT: Int = 8677

    @JvmStatic
    @JvmOverloads
    fun install(app: Application, port: Int = DEFAULT_PORT) {
        // no-op
    }

    @JvmStatic
    fun shutdown() {
        // no-op
    }

    @JvmStatic
    fun registerViewModel(name: String, viewModel: Any) {
        // no-op
    }

    @JvmStatic
    fun registerNavController(controller: Any) {
        // no-op
    }

    @JvmStatic
    fun nameState(state: Any, name: String) {
        // no-op
    }

    @JvmStatic
    fun attachComposeView(view: View) {
        // no-op
    }

    @JvmStatic
    fun detachComposeView(view: View) {
        // no-op
    }

    /** Release stand-in: nothing records a back stack. */
    @JvmStatic
    fun reportBackStack(routes: List<String>) = Unit

    /** Release stand-in: no moment is marked. */
    @JvmStatic
    @JvmOverloads
    fun mark(label: String, detail: String? = null) = Unit

    /** Release stand-in: there is no `startup` event to tell. */
    @JvmStatic
    fun reportFullyDrawn() = Unit
}
