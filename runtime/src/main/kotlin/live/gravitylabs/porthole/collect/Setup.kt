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

    // -- strict mode (GRA-59) ------------------------------------------------
    //
    // Not an "integration" in INTEGRATIONS's sense either: there is no
    // library to be on the classpath or not, only a plugin flag Porthole
    // either acted on or didn't. Recorded unconditionally by
    // `Porthole.install()` — once with `installed = false` when
    // `strictMode` was never turned on, so the entry always exists and an
    // agent never has to infer "opt-in and currently off" from its absence.

    @Volatile private var strictModeInstalled: Boolean? = null
    @Volatile private var strictModeNote: String? = null

    /** Called once by `Porthole.install()`, whether or not `strictMode` was enabled. */
    fun recordStrictMode(installed: Boolean, note: String?) {
        strictModeInstalled = installed
        strictModeNote = note
    }

    private fun strictModeEntry(): SetupEntry? {
        val installed = strictModeInstalled ?: return null
        return SetupEntry(
            name = "strictmode",
            onClasspath = true,
            instrumented = installed,
            hint = strictModeNote,
        )
    }

    // -- whole-tree recomposition counting (GRA-235) -------------------------
    //
    // Not a classpath question in the INTEGRATIONS sense: androidx.compose.runtime
    // is always on the classpath here (this module depends on it directly), what
    // varies is the *version* the app resolves — CompositionObserver needs
    // Compose >= 1.6. Recorded unconditionally by Porthole.install(), same
    // reasoning as strict mode: the entry exists even when whole-tree
    // counting never had a chance to attach, so its absence never has to be
    // read as "porthole forgot to check."

    @Volatile private var composeTreeAvailable: Boolean? = null
    @Volatile private var composeTreeNote: String? = null

    /** Called once by `Porthole.install()`, whether or not `CompositionObserver` attached. */
    fun recordComposeTree(available: Boolean, note: String?) {
        composeTreeAvailable = available
        composeTreeNote = note
    }

    private fun composeTreeEntry(): SetupEntry? {
        val available = composeTreeAvailable ?: return null
        return SetupEntry(
            name = "compose_tree",
            onClasspath = true,
            instrumented = available,
            hint = composeTreeNote,
        )
    }

    // -- the OkHttp listener getting silently replaced (GRA-66 F10) ---------
    //
    // Not a classpath question either: OkHttp is on the classpath and
    // `installPorthole()` was called — both already true, or this could
    // never happen at all. What went wrong is call order: a client can
    // hold exactly one `EventListener` factory, and OkHttp's builder is
    // last-call-wins, silently. If the app calls its own `eventListener()`
    // *after* `installPorthole()`, the porthole's factory is replaced and
    // `Setup.record("okhttp")` already reported this client wired — which
    // was true the moment it ran, and stopped being true one builder call
    // later. `PortholeInterceptor` is the one thing still guaranteed to run
    // for every call regardless (it is a separate builder call,
    // `addInterceptor()`, nothing else can silently displace it), so it is
    // the only place left that can notice the listener went dark — see its
    // own comment for how. Recorded once: every later call on the same
    // client has the identical builder-level cause, so nothing is gained by
    // saying it again.

    @Volatile private var listenerReplaced: Boolean = false

    /**
     * Called by [live.gravitylabs.porthole.integration.PortholeInterceptor]
     * the first time a call reaches it with no record of
     * [live.gravitylabs.porthole.integration.PortholeEventListener] having
     * seen that call's own `callStart`.
     */
    fun recordListenerReplaced() {
        if (listenerReplaced) return
        listenerReplaced = true
        Log.w(
            TAG,
            "okhttp: installPorthole()'s own EventListener was replaced by a later " +
                "eventListener()/eventListenerFactory() call on the same builder — call " +
                "installPorthole() after your own listener, not before, or its phases, reuse, " +
                "protocol and byte counts silently stop appearing",
        )
    }

    private fun listenerReplacedEntry(): SetupEntry? {
        if (!listenerReplaced) return null
        return SetupEntry(
            name = "okhttp-listener",
            onClasspath = true,
            instrumented = false,
            hint = "call installPorthole() after your own eventListener()/eventListenerFactory(), " +
                "not before — it was replaced and this client's own callbacks are not reaching it",
        )
    }

    fun report(): List<SetupEntry> = buildList {
        socketEntry()?.let(::add)
        strictModeEntry()?.let(::add)
        composeTreeEntry()?.let(::add)
        listenerReplacedEntry()?.let(::add)
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
