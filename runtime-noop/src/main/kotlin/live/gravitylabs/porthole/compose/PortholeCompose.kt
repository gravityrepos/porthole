// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.compose

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsPropertyKey
import kotlinx.coroutines.flow.StateFlow

/** @see live.gravitylabs.porthole.compose.PortholeRoot in the debug runtime. */
val LocalPortholeScreen = staticCompositionLocalOf<String?> { null }

val PortholeNodeIdKey = SemanticsPropertyKey<String>("PortholeNodeId")

@Composable
fun PortholeRoot(name: String = "root", content: @Composable () -> Unit) {
    content()
}

@Composable
fun PortholeScreen(name: String, content: @Composable () -> Unit) {
    content()
}

/** Returns the receiver untouched: no semantics node, no side effect, no cost. */
@Composable
fun Modifier.portholeNode(name: String): Modifier = this

@Composable
fun <T> StateFlow<T>.collectAsNamedState(name: String): State<T> = collectAsState()

@Composable
fun <T> rememberNamedState(name: String, initial: T): MutableState<T> =
    remember { mutableStateOf(initial) }

@Composable
fun portholeNodeId(name: String): String = name

/** Release stand-in: the back stack is never read. */
@Composable
fun PortholeBackStack(backStack: List<Any>, label: (Any) -> String = { it.toString() }) = Unit
