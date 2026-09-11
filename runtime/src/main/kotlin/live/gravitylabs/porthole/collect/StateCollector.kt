// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import androidx.compose.runtime.State
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonElement
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.StateDump
import live.gravitylabs.porthole.protocol.StateField
import live.gravitylabs.porthole.protocol.StateOwner
import java.lang.ref.WeakReference
import java.lang.reflect.Field
import java.lang.reflect.Modifier
import java.util.Collections
import java.util.IdentityHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Reads the current value of every state holder on a registered object, and
 * teaches the [SnapshotWatcher] their names while it is in there.
 *
 * Registering a ViewModel is what turns `<unnamed:SnapshotMutableStateImpl#3f2a>`
 * in a recomposition report into `CartViewModel.items`. The naming happens at
 * registration time, so register early: writes before that point are recorded
 * anonymously and stay that way.
 */
internal class StateCollector(private val snapshots: SnapshotWatcher) {

    private class Registration(val name: String, val ref: WeakReference<Any>)

    private val owners = CopyOnWriteArrayList<Registration>()

    fun register(name: String, owner: Any) {
        owners.removeAll { it.ref.get() == null || it.ref.get() === owner }
        owners += Registration(name, WeakReference(owner))
        // Name everything we can reach right now so attribution works from the
        // first write, not from the first time somebody calls `state`.
        nameFields(name, owner)
    }

    fun registeredNames(): List<String> = owners.mapNotNull { r -> r.name.takeIf { r.ref.get() != null } }

    fun dump(only: String?): StateDump {
        val now = nowMs()
        val result = owners.mapNotNull { reg ->
            val owner = reg.ref.get() ?: return@mapNotNull null
            if (only != null && !reg.name.equals(only, ignoreCase = true) &&
                owner.javaClass.simpleName != only
            ) {
                return@mapNotNull null
            }
            StateOwner(
                name = reg.name,
                type = owner.javaClass.name,
                fields = readFields(reg.name, owner),
            )
        }
        owners.removeAll { it.ref.get() == null }
        return StateDump(capturedAt = now, owners = result)
    }

    // -- reflection --------------------------------------------------------

    private fun fieldsOf(owner: Any): List<Field> {
        val out = ArrayList<Field>()
        var cls: Class<*>? = owner.javaClass
        while (cls != null && cls != Any::class.java && !cls.name.startsWith("androidx.lifecycle.ViewModel")) {
            for (f in cls.declaredFields) {
                if (Modifier.isStatic(f.modifiers)) continue
                if (f.isSynthetic) continue
                if (f.name.startsWith("this$")) continue
                out += f
            }
            cls = cls.superclass
        }
        return out
    }

    /**
     * Names every State reachable from [owner], not only its direct fields.
     *
     * State often lives one hop away — a ui-state holder, a repository with an
     * observable cache — and a write to it would otherwise show up anonymous
     * next to fifty framework writes with nothing to separate them. Every name
     * found here is one fewer mystery in the report.
     *
     * The walk stops at library packages, because nothing inside androidx or the
     * standard library is yours to name, and it is bounded in depth and in nodes
     * visited so a cyclic object graph cannot turn registration into a hang.
     */
    private fun nameFields(ownerName: String, owner: Any) {
        val seen = Collections.newSetFromMap(IdentityHashMap<Any, Boolean>())
        val budget = intArrayOf(MAX_NODES)
        walk(ownerName, owner, depth = 0, seen = seen, budget = budget)
    }

    private fun walk(path: String, owner: Any, depth: Int, seen: MutableSet<Any>, budget: IntArray) {
        if (!seen.add(owner) || budget[0] <= 0) return
        budget[0]--

        for (field in fieldsOf(owner)) {
            val value = read(field, owner) ?: continue
            val key = path + "." + cleanName(field.name)

            if (value is State<*>) {
                snapshots.name(value, key)
                continue
            }
            if (depth < MAX_WALK_DEPTH && isWorthWalking(value)) {
                walk(key, value, depth + 1, seen, budget)
            }
        }
    }

    /** Your types are worth descending into; the platform's are not. */
    private fun isWorthWalking(value: Any): Boolean {
        val name = value.javaClass.name
        if (value.javaClass.isPrimitive || value is CharSequence || value is Number || value is Boolean) {
            return false
        }
        return SKIPPED_PACKAGES.none { name.startsWith(it) }
    }

    private fun readFields(ownerName: String, owner: Any): List<StateField> =
        fieldsOf(owner).mapNotNull { field ->
            val key = ownerName + "." + cleanName(field.name)
            when (val value = read(field, owner)) {
                null -> null
                is State<*> -> {
                    snapshots.name(value, key)
                    StateField(
                        key = key,
                        kind = if (value.javaClass.simpleName.contains("Derived")) "DerivedState" else "MutableState",
                        type = typeName(value.value),
                        value = toJson(value.value, 0),
                        attributable = true,
                    )
                }

                is StateFlow<*> -> StateField(
                    key = key,
                    kind = "StateFlow",
                    type = typeName(value.value),
                    value = toJson(value.value, 0),
                    // A StateFlow emission is not a snapshot write, so the apply
                    // observer never sees it. What becomes attributable is the
                    // State that collectAsState produces downstream, which is
                    // why collectAsNamedState exists.
                    attributable = false,
                )

                is Flow<*> -> StateField(
                    key = key,
                    kind = "Flow",
                    type = value.javaClass.name,
                    value = JsonPrimitive("<cold flow, not sampled>"),
                    attributable = false,
                )

                else -> StateField(
                    key = key,
                    kind = "plain",
                    type = typeName(value),
                    value = toJson(value, 0),
                    attributable = false,
                )
            }
        }

    private fun read(field: Field, owner: Any): Any? = runCatching {
        field.isAccessible = true
        field.get(owner)
    }.getOrNull()

    /** `items$delegate` and `_items` both mean `items` to a human. */
    private fun cleanName(raw: String): String =
        raw.removeSuffix("\$delegate").removePrefix("_")

    private fun typeName(value: Any?): String = when (value) {
        null -> "null"
        else -> value.javaClass.simpleName.ifEmpty { value.javaClass.name }
    }

    private fun toJson(value: Any?, depth: Int): JsonElement = when {
        value == null -> JsonNull
        value is String -> JsonPrimitive(value.truncate())
        value is Number -> JsonPrimitive(value)
        value is Boolean -> JsonPrimitive(value)
        value is Enum<*> -> JsonPrimitive(value.name)
        depth >= MAX_DEPTH -> JsonPrimitive(value.toString().truncate())

        value is Collection<*> -> JsonObject(
            mapOf(
                "size" to JsonPrimitive(value.size),
                "items" to JsonArray(value.take(MAX_ITEMS).map { toJson(it, depth + 1) }),
            ),
        )

        value is Map<*, *> -> JsonObject(
            value.entries.take(MAX_ITEMS).associate { (k, v) -> k.toString() to toJson(v, depth + 1) },
        )

        // Kotlin data classes print their whole contents, which beats anything
        // field-walking would produce and cannot blow up on a lazy getter.
        else -> JsonPrimitive(value.toString().truncate())
    }

    private fun String.truncate(): String =
        if (length > MAX_VALUE_CHARS) take(MAX_VALUE_CHARS) + "... (+" + (length - MAX_VALUE_CHARS) + " chars)" else this

    companion object {
        /** How far the naming walk descends past a registered owner. */
        private const val MAX_WALK_DEPTH = 3

        /** Ceiling on objects visited per registration, so a cycle cannot hang it. */
        private const val MAX_NODES = 400

        /** Nothing in here is yours to name, and descending into it finds only noise. */
        private val SKIPPED_PACKAGES = listOf(
            "android.",
            "androidx.",
            "java.",
            "javax.",
            "kotlin.",
            "kotlinx.",
            "com.google.",
            "dagger.",
            "okhttp3.",
            "okio.",
            "retrofit2.",
        )

        private const val MAX_DEPTH = 2
        private const val MAX_ITEMS = 20
        private const val MAX_VALUE_CHARS = 1024
    }
}
