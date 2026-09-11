// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.compose

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.currentCompositeKeyHash
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.semantics
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.StateFlow
import live.gravitylabs.porthole.Porthole

/** The nearest enclosing [PortholeScreen] name, so leaf nodes know where they live. */
val LocalPortholeScreen = staticCompositionLocalOf<String?> { null }

/**
 * Semantics key carrying the porthole's node id.
 *
 * This is the join between two tools: `recompositions` reports counts keyed by
 * node id, and `semantics_tree` reports the same id on the matching node, so an
 * agent can go from "this thing recomposed 340 times" to "this is where it is
 * on screen" without guessing.
 */
val PortholeNodeIdKey = SemanticsPropertyKey<String>("PortholeNodeId")

private var SemanticsPropertyReceiver.portholeId: String by PortholeNodeIdKey

/**
 * Wrap your app's root composable once. Gives the semantics collector a View to
 * walk and establishes the timeline's root scope.
 *
 * In release builds this is the no-op artifact and compiles to just `content()`.
 */
@Composable
fun PortholeRoot(name: String = "root", content: @Composable () -> Unit) {
    val view = LocalView.current
    DisposableEffect(view) {
        Porthole.attachComposeView(view)
        onDispose { Porthole.detachComposeView(view) }
    }
    PortholeScreen(name, content)
}

/**
 * Marks a screen. Recompositions of this scope are counted and attributed, and
 * every [portholeNode] underneath inherits the name.
 */
@Composable
fun PortholeScreen(name: String, content: @Composable () -> Unit) {
    val nodeId = portholeNodeId(name)
    val passes = remember { intArrayOf(0) }
    SideEffect {
        passes[0]++
        Porthole.onRecompose(nodeId, name, name, passes[0])
    }
    CompositionLocalProvider(LocalPortholeScreen provides name) {
        content()
    }
}

/**
 * Counts recompositions of the composable that applies it, and stamps the node
 * id into semantics so the two trees line up.
 *
 * It is a `@Composable` extension on purpose: the [SideEffect] lands in the
 * calling scope, so what gets counted is the caller's recomposition, which is
 * the number you actually want.
 */
@Composable
fun Modifier.portholeNode(name: String): Modifier {
    val screen = LocalPortholeScreen.current
    val nodeId = portholeNodeId(name)
    val passes = remember { intArrayOf(0) }
    SideEffect {
        passes[0]++
        Porthole.onRecompose(nodeId, name, screen, passes[0])
    }
    return this.semantics { portholeId = nodeId }
}

/**
 * Like `collectAsState`, but tells the porthole what the resulting State is called.
 *
 * Worth using on anything Flow-shaped. A plain `collectAsState` produces an
 * anonymous State object, so recompositions it causes are attributed to
 * `<unnamed:...>`, which is exactly the dead end this tool exists to avoid.
 */
@Composable
fun <T> StateFlow<T>.collectAsNamedState(name: String): State<T> {
    val state = collectAsState()
    remember(state, name) { Porthole.nameState(state, name); name }
    return state
}

/**
 * `remember { mutableStateOf(...) }` with a name attached.
 *
 * Reflection over a registered ViewModel reaches the state a ViewModel holds,
 * and `collectAsNamedState` reaches the state a Flow feeds. Neither can reach
 * state a composable creates for itself, which has no owner to reflect over —
 * so without this, local state is invisible to attribution no matter how much
 * you register.
 */
@Composable
fun <T> rememberNamedState(name: String, initial: T): MutableState<T> {
    val state = remember { mutableStateOf(initial) }
    remember(state, name) { Porthole.nameState(state, name); name }
    return state
}

/**
 * Stable identity for a call site.
 *
 * `currentCompositeKeyHash` is derived from the composable's position in the
 * composition, so it survives recomposition and is the same on every run of the
 * same code path, including across process restarts. Sibling items in a `key {}`
 * block get distinct values, which is what you want for a list row.
 */
@Composable
fun portholeNodeId(name: String): String {
    // Compose 1.9 introduced currentCompositeKeyHashCode (Long) and began
    // deprecating this Int version. Single call site, so it is a one-line change.
    @Suppress("DEPRECATION")
    val hash = currentCompositeKeyHash
    return name + "#" + Integer.toHexString(hash)
}

/**
 * Reports a back stack the app owns, such as Navigation 3's.
 *
 * ```kotlin
 * val backStack = rememberNavBackStack(HomeKey)
 * PortholeBackStack(backStack)
 * NavDisplay(backStack = backStack, ...)
 * ```
 *
 * Navigation 3 has no NavController, so there is nothing to auto-detect: the
 * back stack is a snapshot list in app code and has to be handed over. One call
 * beside the NavDisplay does it, and the entries land in the same navigation
 * lane a NavController's would.
 *
 * [label] turns an entry into the route shown on the timeline. The default is
 * the class's simple name, which is what a Nav3 key usually is.
 */
@Composable
fun PortholeBackStack(backStack: List<Any>, label: (Any) -> String = ::defaultRouteLabel) {
    LaunchedEffect(backStack, label) {
        // snapshotFlow, so this follows the same snapshot the list is written
        // in rather than sampling it and hoping.
        snapshotFlow { backStack.map(label) }
            .distinctUntilChanged()
            .collect { routes -> Porthole.reportBackStack(routes) }
    }
}

/**
 * A Nav3 key is usually a data class or object, whose simple name is the
 * readable part. Anything else falls back to its own toString.
 */
private fun defaultRouteLabel(entry: Any): String =
    entry::class.simpleName?.takeUnless { it.isEmpty() } ?: entry.toString()
