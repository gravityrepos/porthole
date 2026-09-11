// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import androidx.compose.runtime.State
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.runtime.snapshots.ObserverHandle
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.store.EventRing
import java.lang.ref.WeakReference
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap

/**
 * Watches every snapshot apply in the process and turns it into a named write
 * event.
 *
 * This is the only honest source of "what state changed" that Compose exposes
 * publicly. [Snapshot.registerApplyObserver] hands us the set of state objects
 * written by each apply, but state objects have no names of their own, so we
 * keep a side table of identity to name populated from three places:
 *
 *  - explicit calls to [name]
 *  - reflection over registered ViewModels (see StateCollector)
 *  - `collectAsNamedState`, which names the State that a Flow feeds
 *
 * Anything we cannot name still shows up, as `<unnamed:Type#identity>`, so a
 * mystery invalidation is visible even when it is anonymous.
 */
internal class SnapshotWatcher(
    private val ring: EventRing,
    /**
     * Package prefixes that mean "this came from the app being debugged".
     * Empty disables the ownership hint entirely.
     */
    private val appPackages: List<String> = emptyList(),
) {

    /** One apply: the moment, and the names of everything written in it. */
    internal class Write(val t: Long, val keys: List<String>, val named: Boolean)

    private val names = WeakIdentityNames()
    private val hints = ConcurrentHashMap<String, String>()
    private val log = ArrayDeque<Write>()
    private val logLock = Any()
    private var handle: ObserverHandle? = null

    fun start() {
        if (handle != null) return
        handle = Snapshot.registerApplyObserver { changed, _ ->
            if (changed.isEmpty()) return@registerApplyObserver
            val t = nowMs()
            var allNamed = true
            val keys = ArrayList<String>(changed.size)
            for (obj in changed) {
                val name = names.lookup(obj)
                if (name == null) allNamed = false
                val key = name ?: unnamedKey(obj)
                if (name == null) rememberHint(key, obj)
                keys += key
            }
            record(Write(t, keys, allNamed))
        }
    }

    fun stop() {
        handle?.dispose()
        handle = null
    }

    private fun record(write: Write) {
        synchronized(logLock) {
            log.addLast(write)
            while (log.size > LOG_CAPACITY) log.removeFirst()
        }
        // Both halves go out: the named keys are the answer, and the count of
        // unnamed ones is the caveat on it. Splitting them here means the UI does
        // not have to pattern-match a string prefix to tell them apart.
        val named = write.keys.filterNot { isUnnamed(it) }
        val yours = write.keys.filter { isUnnamed(it) && hintFor(it) != null }
        ring.emit(
            "state_write",
            JsonObject(
                mapOf(
                    "keys" to JsonArray(write.keys.map { JsonPrimitive(it) }),
                    "named" to JsonArray(named.map { JsonPrimitive(it) }),
                    "unnamed" to JsonPrimitive(write.keys.size - named.size),
                    // Anonymous, but holding one of the app's own types, so
                    // definitely the app's state and definitely unregistered.
                    "yours" to JsonArray(
                        yours.map { JsonPrimitive(it + " holds " + hintFor(it)) },
                    ),
                ),
            ),
        )
    }

    /**
     * Names written in `(at - windowMs, at]`. Used to attribute a recomposition.
     *
     * Called on the composition thread once per instrumented recomposition, so
     * it walks backwards from the newest entry and stops at the window edge
     * rather than scanning the whole log. The log is append-ordered by time, so
     * the first entry older than the floor is the last one worth looking at.
     */
    fun writesBefore(at: Long, windowMs: Long): List<String> {
        val floor = at - windowMs
        return synchronized(logLock) {
            var found: MutableList<String>? = null
            val iterator = log.descendingIterator()
            while (iterator.hasNext()) {
                val write = iterator.next()
                if (write.t <= floor) break
                if (write.t > at) continue
                val into = found ?: ArrayList<String>(write.keys.size).also { found = it }
                for (key in write.keys) if (key !in into) into += key
            }
            found ?: emptyList()
        }
    }

    /** Every write in `[from, to]`, flattened, with how often each key appeared. */
    fun writesBetween(from: Long, to: Long): Map<String, Int> {
        val out = LinkedHashMap<String, Int>()
        synchronized(logLock) {
            for (w in log) {
                if (w.t < from || w.t > to) continue
                for (k in w.keys) out[k] = (out[k] ?: 0) + 1
            }
        }
        return out
    }

    fun clear() {
        synchronized(logLock) { log.clear() }
    }

    // -- naming ------------------------------------------------------------

    /** Computed once per distinct anonymous state; the apply observer is hot. */
    private fun rememberHint(key: String, obj: Any) {
        if (appPackages.isEmpty() || hints.containsKey(key)) return
        if (hints.size >= MAX_HINTS) return
        hints[key] = ownershipHint(obj) ?: NO_HINT
    }

    /** The app type an anonymous key holds, if we could tell. */
    fun hintFor(key: String): String? = hints[key]?.takeIf { it != NO_HINT }

    fun name(target: Any, key: String) = names.put(target, key)

    fun isNamed(target: Any): Boolean = names.lookup(target) != null

    fun nameOf(target: Any): String = names.lookup(target) ?: unnamedKey(target)

    /**
     * Identity is all we have for a state nobody named.
     *
     * Most unnamed writes in a Compose app are the framework's own: ripples,
     * scroll offsets, focus, animation clocks. They are still worth showing,
     * because a burst of them next to a recomposition is a real signal, but the
     * identity is the only handle on them and the key stays short so it reads as
     * a placeholder rather than as a failure.
     */
    /**
     * Names the type an anonymous state is holding, when that type is the app's.
     *
     * Nothing about a state object says who created it, so this never guesses:
     * it answers only when the value's class sits in the app's own package, and
     * stays silent otherwise. A hit means "this is yours and nobody registered
     * it", which is the one anonymous case that is actually actionable. A miss
     * means nothing at all — an unregistered Int looks exactly like a ripple.
     */
    private fun ownershipHint(obj: Any): String? {
        if (appPackages.isEmpty()) return null
        val state = obj as? State<*> ?: return null

        return runCatching {
            // Reading state inside an apply observer would otherwise be recorded
            // as a read by whatever is currently observing, which could
            // invalidate a scope that never touched this state.
            val value = Snapshot.withoutReadObservation { state.value } ?: return null
            val candidate = when {
                value is Collection<*> -> value.firstOrNull() ?: return null
                value is Map<*, *> -> value.values.firstOrNull() ?: return null
                else -> value
            }
            val type = candidate.javaClass
            if (appPackages.any { type.name.startsWith(it) }) type.simpleName else null
        }.getOrNull()
    }

    private fun unnamedKey(obj: Any): String =
        UNNAMED_PREFIX + Integer.toHexString(System.identityHashCode(obj))

    companion object {
        /** Marks a state object nobody gave a name to. */
        const val UNNAMED_PREFIX = "unnamed#"

        private const val NO_HINT = ""
        private const val MAX_HINTS = 2048

        fun isUnnamed(key: String): Boolean = key.startsWith(UNNAMED_PREFIX)

        /**
         * How far back a recomposition looks for the write that caused it.
         * Two frames at 60Hz. Compose coalesces invalidations into the next
         * frame, so a wider window mostly adds noise and a narrower one misses
         * writes that landed just before a vsync boundary.
         */
        const val DEFAULT_ATTRIBUTION_WINDOW_MS = 32L
        private const val LOG_CAPACITY = 8192
    }
}

/**
 * Identity-keyed, weakly-held name table.
 *
 * A plain WeakHashMap compares with equals, and some state holders do override
 * it, so two distinct states could collide. Keying on identityHashCode and
 * confirming with `===` gives identity semantics without pinning the state
 * object in memory.
 */
private class WeakIdentityNames {
    private class Entry(val ref: WeakReference<Any>, val name: String)

    private val buckets = ConcurrentHashMap<Int, MutableList<Entry>>()

    fun put(target: Any, name: String) {
        val hash = System.identityHashCode(target)
        // getOrPut is not atomic on ConcurrentHashMap, and computeIfAbsent is API 24.
        val bucket = buckets[hash] ?: mutableListOf<Entry>().let { buckets.putIfAbsent(hash, it) ?: it }
        synchronized(bucket) {
            bucket.removeAll { it.ref.get() == null || it.ref.get() === target }
            bucket += Entry(WeakReference(target), name)
        }
    }

    fun lookup(target: Any): String? {
        val bucket = buckets[System.identityHashCode(target)] ?: return null
        synchronized(bucket) {
            var found: String? = null
            val it = bucket.iterator()
            while (it.hasNext()) {
                val entry = it.next()
                val held = entry.ref.get()
                if (held == null) it.remove() else if (held === target) found = entry.name
            }
            return found
        }
    }
}
