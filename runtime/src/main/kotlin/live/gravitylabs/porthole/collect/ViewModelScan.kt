// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

/**
 * Reads the view models out of anything that owns a ViewModelStore.
 *
 * Reflection rather than a dependency on androidx.lifecycle: this reads two
 * methods, it is optional, and every failure is survivable. Making a consuming
 * build resolve another artifact for it would cost more than it is worth.
 *
 * Two kinds of owner matter. An Activity owns the view models scoped to it, and
 * a navigation back stack entry owns the ones scoped to a screen — which is
 * where `viewModel()` inside a NavHost actually puts them, and the reason
 * scanning only Activities found nothing at all in a Compose app.
 */
internal object ViewModelScan {

    /** Registers every view model in [owner]'s store that has not been seen. */
    fun register(owner: Any?, state: StateCollector, seen: MutableSet<Int>): Int {
        if (owner == null) return 0
        return runCatching {
            val store = owner.javaClass.getMethod("getViewModelStore").invoke(owner) ?: return 0

            @Suppress("UNCHECKED_CAST")
            val keys = store.javaClass.getMethod("keys").invoke(store) as? Set<String>
                ?: return 0
            val get = store.javaClass.getMethod("get", String::class.java)

            var added = 0
            for (key in keys) {
                val viewModel = get.invoke(store, key) ?: continue
                // Identity, not name: two view models of one class in the same
                // store are different owners and both deserve naming.
                if (!seen.add(System.identityHashCode(viewModel))) continue
                state.register(viewModel.javaClass.simpleName, viewModel)
                added += 1
            }
            added
        }.getOrDefault(0)
    }
}
