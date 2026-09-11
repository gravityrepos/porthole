// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavController
import androidx.navigation.NavDestination
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.DeepLink
import live.gravitylabs.porthole.protocol.NavEntry
import live.gravitylabs.porthole.protocol.NavState
import live.gravitylabs.porthole.store.EventRing
import java.lang.ref.WeakReference

/**
 * Tracks the navigation back stack, the arguments on each entry, and the deep
 * link that started the current session, if there was one.
 *
 * Only loaded when androidx.navigation is on the classpath; see Porthole.install.
 */
internal class NavCollector(
    private val ring: EventRing,
    private val state: StateCollector? = null,
) {

    /** View models already named, by identity. */
    private val seenViewModels = HashSet<Int>()

    private var controllerRef: WeakReference<NavController>? = null
    private var listener: NavController.OnDestinationChangedListener? = null

    /** Route to the uptime when it was pushed, so the timeline can show dwell. */
    private val enteredAt = LinkedHashMap<String, Long>()
    private var deepLink: DeepLink? = null

    fun register(controller: NavController) {
        Setup.record("navigation")
        unregister()
        controllerRef = WeakReference(controller)
        val l = NavController.OnDestinationChangedListener { _, destination, arguments ->
            val t = nowMs()
            val route = destination.route ?: destination.id.toString()
            enteredAt[route] = t
            while (enteredAt.size > ENTERED_CAPACITY) {
                enteredAt.remove(enteredAt.keys.first())
            }
            captureDeepLink(arguments, t)

            // The marker that answers "what was I doing here" in a system
            // trace. A navigation is the coarsest thing a person remembers
            // doing, so it is the one worth finding first.
            Atrace.event("nav → " + route)
            // A NavBackStackEntry owns the view models scoped to its screen,
            // which is where viewModel() inside a NavHost puts them. Naming
            // them here means an app does not register each one by hand.
            state?.let { ViewModelScan.register(controller.currentBackStackEntry, it, seenViewModels) }
            ring.emit(
                "nav",
                JsonObject(
                    mapOf(
                        "route" to JsonPrimitive(route),
                        "label" to JsonPrimitive(destination.label?.toString() ?: ""),
                        "args" to JsonPrimitive(argsOf(arguments).toString()),
                        "depth" to JsonPrimitive(backStackOf(controller).size),
                    ),
                ),
            )
        }
        listener = l
        controller.addOnDestinationChangedListener(l)
    }

    fun unregister() {
        val controller = controllerRef?.get()
        val l = listener
        if (controller != null && l != null) controller.removeOnDestinationChangedListener(l)
        controllerRef = null
        listener = null
    }

    fun isRegistered(): Boolean = controllerRef?.get() != null

    fun capture(): NavState {
        val now = nowMs()
        val controller = controllerRef?.get()
            ?: return NavState(
                capturedAt = now,
                graph = null,
                current = null,
                backStack = emptyList(),
                deepLink = null,
                error = "No NavController registered. Call Porthole.registerNavController(navController) " +
                    "once, next to where you create it.",
            )

        val entries = backStackOf(controller).map { it.toDto() }
        return NavState(
            capturedAt = now,
            graph = runCatching { controller.graph.route ?: controller.graph.id.toString() }.getOrNull(),
            current = entries.lastOrNull(),
            backStack = entries,
            deepLink = deepLink,
        )
    }

    // currentBackStack is restricted to navigation's own library group. Reading
    // it anyway is the deliberate choice: the public surface offers only the top
    // entry and the visible ones, and a back stack tool that cannot see the back
    // stack is not worth shipping. It is wrapped, so a future release that moves
    // it degrades to the top entry rather than throwing.
    @SuppressLint("RestrictedApi")
    private fun backStackOf(controller: NavController): List<NavBackStackEntry> = runCatching {
        controller.currentBackStack.value
    }.getOrElse {
        listOfNotNull(controller.currentBackStackEntry)
    }

    private fun NavBackStackEntry.toDto(): NavEntry {
        val route = destination.route ?: destination.id.toString()
        return NavEntry(
            route = destination.route,
            destinationId = destination.idLabel(),
            label = destination.label?.toString(),
            args = argsOf(arguments),
            lifecycleState = runCatching { lifecycle.currentState.name }.getOrNull(),
            enteredAt = enteredAt[route],
        )
    }

    /** The hex form is what the nav graph and Logcat both print. */
    private fun NavDestination.idLabel(): String = "0x" + Integer.toHexString(id)

    @Suppress("DEPRECATION")
    private fun captureDeepLink(arguments: Bundle?, t: Long) {
        val intent = arguments?.deepLinkIntent() ?: return
        val uri = intent.data?.toString() ?: return
        deepLink = DeepLink(
            uri = uri,
            action = intent.action,
            extras = intent.extras?.let { bundle ->
                bundle.keySet()
                    .filter { it != KEY_DEEP_LINK_INTENT }
                    .associateWith { key -> stringify(bundle.get(key)) }
            } ?: emptyMap(),
            at = t,
        )
    }

    @Suppress("DEPRECATION")
    private fun Bundle.deepLinkIntent(): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getParcelable(KEY_DEEP_LINK_INTENT, Intent::class.java)
        } else {
            getParcelable(KEY_DEEP_LINK_INTENT) as? Intent
        }

    @Suppress("DEPRECATION")
    private fun argsOf(bundle: Bundle?): Map<String, String> {
        if (bundle == null) return emptyMap()
        return runCatching {
            bundle.keySet()
                .filter { it != KEY_DEEP_LINK_INTENT }
                .associateWith { key -> stringify(bundle.get(key)) }
        }.getOrElse { emptyMap() }
    }

    private fun stringify(value: Any?): String = when (value) {
        null -> "null"
        is Array<*> -> value.joinToString(prefix = "[", postfix = "]") { stringify(it) }
        else -> value.toString().let { if (it.length > MAX_VALUE_CHARS) it.take(MAX_VALUE_CHARS) + "..." else it }
    }

    companion object {
        /**
         * NavController exposes this as a constant, but it has moved between
         * RestrictTo levels across releases, so it is inlined here. The value
         * is part of the saved-state format and has not changed.
         */
        private const val KEY_DEEP_LINK_INTENT = "android-support-nav:controller:deepLinkIntent"
        private const val ENTERED_CAPACITY = 64
        private const val MAX_VALUE_CHARS = 512
    }
}
