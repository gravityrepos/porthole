// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.util.Log
import live.gravitylabs.porthole.protocol.SetupEntry
import java.util.concurrent.ConcurrentHashMap

/**
 * What is wired up, and what is on the classpath but is not.
 *
 * The integrations cannot be discovered: instrumenting a client means being
 * handed the builder before it is built, and nothing can do that for you. What
 * can be fixed is having to *work out* which ones you forgot.
 *
 * Without this, a missing `installPorthole()` looks exactly like an app that
 * made no requests — an empty lane either way, and no way to tell which. So the
 * runtime says so: it knows OkHttp is on your classpath, and it knows nothing
 * ever installed a porthole on a client.
 */
internal object Setup {

    private val installed = ConcurrentHashMap.newKeySet<String>()

    /** Called by each integration the moment it is actually wired to something. */
    fun record(name: String) {
        installed += name
    }

    fun isInstalled(name: String): Boolean = name in installed

    private fun onClasspath(className: String): Boolean =
        runCatching { Class.forName(className, false, Setup::class.java.classLoader) }.isSuccess

    fun report(): List<SetupEntry> = INTEGRATIONS.map { integration ->
        val present = onClasspath(integration.probeClass)
        val wired = integration.wired()
        SetupEntry(
            name = integration.name,
            onClasspath = present,
            instrumented = wired,
            // Only worth saying when there is something to do about it: the
            // library is there and nothing has been attached to it.
            hint = if (present && !wired) integration.hint else null,
        )
    }

    /**
     * Logged once, a few seconds in, because the answer is only meaningful after
     * the app has had a chance to build its clients.
     */
    fun log() {
        val missing = report().filter { it.hint != null }
        if (missing.isEmpty()) return
        Log.i(
            TAG,
            "not instrumented: " + missing.joinToString("; ") { "${it.name} — ${it.hint}" },
        )
    }

    private class Integration(
        val name: String,
        val probeClass: String,
        val hint: String,
        val wired: () -> Boolean,
    )

    private val INTEGRATIONS = listOf(
        Integration(
            name = "okhttp",
            probeClass = "okhttp3.OkHttpClient",
            hint = "add installPorthole() to your OkHttpClient.Builder",
            wired = { isInstalled("okhttp") },
        ),
        Integration(
            name = "ktor",
            probeClass = "io.ktor.client.HttpClient",
            hint = "add install(portholeKtor()) to your HttpClient",
            wired = { isInstalled("ktor") },
        ),
        Integration(
            name = "room",
            probeClass = "androidx.room.RoomDatabase",
            hint = "add installPorthole() to your Room databaseBuilder",
            wired = { DbRegistry.names().isNotEmpty() },
        ),
        Integration(
            name = "sqlite",
            probeClass = "app.cash.sqldelight.driver.android.AndroidSqliteDriver",
            hint = "pass portholeSqliteFactory() as your driver's factory",
            wired = { DbRegistry.names().isNotEmpty() },
        ),
        Integration(
            name = "navigation",
            probeClass = "androidx.navigation.NavController",
            hint = "call Porthole.registerNavController(navController)",
            wired = { isInstalled("navigation") },
        ),
    )

    private const val TAG = "Porthole"
}
