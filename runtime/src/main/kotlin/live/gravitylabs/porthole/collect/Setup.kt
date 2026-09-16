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

    // -- the socket's own bind result (GRA-196) -----------------------------
    //
    // Not an "integration" in the sense the entries below are - nothing has
    // to wire the socket up, it either bound or it didn't - so it is kept as
    // separate state rather than forced into the INTEGRATIONS shape, and
    // report() below assembles it into the same list only because `setup` is
    // the one RPC method a later, successful connection already has to ask
    // this question with. There is deliberately no host-side channel of its
    // own: a socket that never bound at all cannot be asked anything, by
    // construction - the only case this can ever surface is a retry that
    // eventually succeeded, or a caller connecting on a *second* attempt at
    // the same port after the first `install()` gave up.

    @Volatile private var socketListening: Boolean? = null
    @Volatile private var socketFailure: String? = null
    @Volatile private var socketBindAttempts: Int = 0

    /**
     * Called once [live.gravitylabs.porthole.transport.PortholeSocketServer]'s
     * bind has settled, win or lose.
     */
    fun recordSocketBind(listening: Boolean, failure: String?, attempts: Int) {
        socketListening = listening
        socketFailure = failure
        socketBindAttempts = attempts
    }

    private fun socketEntry(): SetupEntry? {
        val listening = socketListening ?: return null
        return SetupEntry(
            name = "socket",
            // Not a classpath question for this one - the socket is this
            // module, not a dependency it might or might not have pulled in
            // - so `true` here means "applicable", the only sense onClasspath
            // can have for it.
            onClasspath = true,
            instrumented = listening,
            hint = when {
                !listening -> socketFailure
                socketBindAttempts > 1 ->
                    "bound after $socketBindAttempts attempts " +
                        "(a previous instance of this app was likely still releasing the port)"
                else -> null
            },
        )
    }

    private fun integrationEntries(): List<SetupEntry> = INTEGRATIONS.map { integration ->
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

    fun report(): List<SetupEntry> = buildList {
        socketEntry()?.let(::add)
        addAll(integrationEntries())
    }

    /**
     * Logged once, a few seconds in, because the answer is only meaningful after
     * the app has had a chance to build its clients.
     *
     * Deliberately reads [integrationEntries] rather than [report]: the
     * socket either bound (and already got its own `Log.i`/`Log.e` from
     * [live.gravitylabs.porthole.transport.PortholeSocketServer] at the
     * moment it happened) or it never bound at all, in which case there is
     * no live connection left for this delayed log line to reach anyway.
     * Folding it into "not instrumented: ..." here would also mislabel it -
     * a socket that needed a retry was not left uninstrumented, it just
     * took a moment.
     */
    fun log() {
        val missing = integrationEntries().filter { it.hint != null }
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
