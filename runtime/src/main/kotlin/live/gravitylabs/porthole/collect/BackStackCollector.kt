// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.store.EventRing

/**
 * A back stack the app owns, rather than one androidx holds for it.
 *
 * Navigation 3 inverted this: the back stack is a snapshot list in app code, so
 * there is no controller to attach a listener to and nothing to auto-detect.
 * The app hands its stack over and this turns the changes into the same `nav`
 * events the NavController collector produces, so one lane covers both.
 */
internal class BackStackCollector(private val ring: EventRing) {

    private var last: List<String> = emptyList()

    @Synchronized
    fun report(routes: List<String>) {
        // Recomposition can report an unchanged stack many times over. Only a
        // real move is a navigation.
        val direction = backStackChange(last, routes) ?: return
        last = routes
        val top = routes.lastOrNull() ?: return

        ring.emit(
            "nav",
            JsonObject(
                mapOf(
                    "route" to JsonPrimitive(top),
                    "label" to JsonPrimitive(""),
                    "args" to JsonPrimitive("{}"),
                    "depth" to JsonPrimitive(routes.size),
                    // Which way the stack moved, which a plain list of routes
                    // does not say and is usually the first thing you ask.
                    "direction" to JsonPrimitive(direction),
                    "source" to JsonPrimitive("backStack"),
                ),
            ),
        )
    }

}

/**
 * How the stack moved, or null if it did not.
 *
 * Separate from the collector because this is the part with decisions in it,
 * and the collector needs an Android clock to construct.
 */
internal fun backStackChange(before: List<String>, after: List<String>): String? = when {
    after == before -> null
    after.isEmpty() -> "empty"
    before.isEmpty() -> "start"
    after.size > before.size -> "push"
    after.size < before.size -> "pop"
    else -> "replace"
}
