// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import android.app.Application
import android.content.Context
import android.util.Log
import androidx.startup.Initializer

/**
 * Starts the porthole on process start, before the first Activity exists.
 *
 * Early matters: the snapshot apply observer has to be running before the first
 * state write, or the opening moments of the trace are missing. androidx.startup
 * gives us that without asking anyone to touch their Application class.
 *
 * To opt out, remove the entry in your debug manifest:
 * ```xml
 * <provider android:name="androidx.startup.InitializationProvider"
 *     android:authorities="${applicationId}.androidx-startup"
 *     tools:node="merge">
 *     <meta-data android:name="live.gravitylabs.porthole.PortholeInitializer" tools:node="remove" />
 * </provider>
 * ```
 */
class PortholeInitializer : Initializer<Porthole> {

    /** Installs the porthole and hands back the object that owns it. */
    override fun create(context: Context): Porthole {
        val app = context.applicationContext as? Application
        if (app == null) {
            Log.w("Porthole", "no Application context, porthole not installed")
            return Porthole
        }
        Porthole.install(app)
        return Porthole
    }

    /** None. The porthole is the first thing that should run. */
    override fun dependencies(): List<Class<out Initializer<*>>> = emptyList()
}
