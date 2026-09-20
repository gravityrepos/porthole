// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.view.View
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.AccessibilityAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsOwner
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import live.gravitylabs.porthole.compose.PortholeNodeIdKey
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.protocol.Rect
import live.gravitylabs.porthole.protocol.SemanticsNodeDto
import live.gravitylabs.porthole.protocol.SemanticsTree
import java.lang.ref.WeakReference
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Snapshots the semantics tree with an identity you can diff across captures.
 *
 * Compose's own `SemanticsNode.id` is unique while a node is alive but gets
 * recycled, so it is useless for "is this the same button as last time". The
 * `stableId` here is a structural path hash: parent path plus the most stable
 * discriminator the node has (porthole node id, then test tag, then role, then
 * sibling index). Same UI, same id, run after run.
 */
internal class SemanticsCollector {

    private val views = CopyOnWriteArrayList<WeakReference<View>>()

    fun attach(view: View) {
        if (views.none { it.get() === view }) views += WeakReference(view)
        prune()
    }

    fun detach(view: View) {
        views.removeAll { it.get() == null || it.get() === view }
    }

    fun isAttached(): Boolean = views.any { it.get() != null }

    fun capture(merged: Boolean, maxDepth: Int, maxNodes: Int): SemanticsTree {
        val now = nowMs()
        val owner = findOwner()
            ?: return SemanticsTree(
                capturedAt = now,
                merged = merged,
                root = null,
                error = "No Compose semantics owner found. Wrap your content in PortholeRoot { }, " +
                    "or make sure a Compose hierarchy is actually on screen.",
            )

        val budget = intArrayOf(maxNodes)
        // The unmerged root is not public API, so an unmerged capture is
        // best-effort. When it is unavailable we say so rather than silently
        // handing back a merged tree labelled unmerged.
        val unmerged = if (merged) null else reflectUnmergedRoot(owner)
        val root = unmerged ?: owner.rootSemanticsNode
        val downgraded = !merged && unmerged == null

        return SemanticsTree(
            capturedAt = now,
            merged = merged || downgraded,
            root = convert(root, parentPath = "", discriminator = "root", depth = 0, maxDepth = maxDepth, budget = budget),
            error = if (downgraded) {
                "Unmerged tree unavailable on this Compose version; returned the merged tree."
            } else {
                null
            },
        )
    }

    private fun reflectUnmergedRoot(owner: SemanticsOwner): SemanticsNode? = runCatching {
        val getter = owner.javaClass.methods.firstOrNull {
            it.name == "getUnmergedRootSemanticsNode" && it.parameterTypes.isEmpty()
        } ?: return@runCatching null
        getter.isAccessible = true
        getter.invoke(owner) as? SemanticsNode
    }.getOrNull()

    private fun findOwner(): SemanticsOwner? {
        prune()
        for (ref in views) {
            val view = ref.get() ?: continue
            // ViewRootForTest is the supported way in: public, stable, and what
            // the testing APIs themselves use to reach the semantics owner.
            (view as? ViewRootForTest)?.let { return it.semanticsOwner }
            reflectOwner(view)?.let { return it }
        }
        return null
    }

    private fun reflectOwner(view: View): SemanticsOwner? = runCatching {
        var cls: Class<*>? = view.javaClass
        while (cls != null) {
            val getter = cls.declaredMethods.firstOrNull {
                it.name == "getSemanticsOwner" && it.parameterTypes.isEmpty()
            }
            if (getter != null) {
                getter.isAccessible = true
                return@runCatching getter.invoke(view) as? SemanticsOwner
            }
            cls = cls.superclass
        }
        null
    }.getOrNull()

    private fun prune() {
        views.removeAll { it.get() == null }
    }

    private fun convert(
        node: SemanticsNode,
        parentPath: String,
        discriminator: String,
        depth: Int,
        maxDepth: Int,
        budget: IntArray,
    ): SemanticsNodeDto {
        val config = node.config
        val testTag = config.getOrNull(SemanticsProperties.TestTag)
        val portholeId = config.getOrNull(PortholeNodeIdKey)
        val role = config.getOrNull(SemanticsProperties.Role)?.toString()
        val text = config.getOrNull(SemanticsProperties.Text)
            ?.joinToString(" ") { it.text }
            ?.takeIf { it.isNotBlank() }
        val contentDescription = config.getOrNull(SemanticsProperties.ContentDescription)
            ?.joinToString(" ")
            ?.takeIf { it.isNotBlank() }

        val path = if (parentPath.isEmpty()) discriminator else "$parentPath/$discriminator"

        val bounds = runCatching {
            val r = node.boundsInRoot
            Rect(r.left, r.top, r.right, r.bottom)
        }.getOrNull()

        budget[0]--
        val overBudget = budget[0] <= 0
        val tooDeep = depth >= maxDepth
        val children = if (overBudget || tooDeep) {
            emptyList()
        } else {
            childDiscriminators(node.children).mapIndexed { i, childDiscriminator ->
                convert(node.children[i], path, childDiscriminator, depth + 1, maxDepth, budget)
            }
        }

        return SemanticsNodeDto(
            nodeId = node.id,
            stableId = stableId(path),
            role = role,
            testTag = portholeId ?: testTag,
            text = text,
            contentDescription = contentDescription,
            bounds = bounds,
            actions = config.mapNotNull { (key, value) ->
                if (value is AccessibilityAction<*>) value.label ?: key.name else null
            },
            flags = buildList {
                if (config.getOrNull(SemanticsProperties.Disabled) != null) add("disabled")
                if (config.getOrNull(SemanticsProperties.Focused) == true) add("focused")
                if (config.getOrNull(SemanticsProperties.Selected) == true) add("selected")
                if (config.contains(SemanticsActions.OnClick)) add("clickable")
                if (config.isMergingSemanticsOfDescendants) add("merging")
                // GRA-72: `accessibility`'s decorative-image rule needs this to
                // tell "no description because it draws nothing meaningful"
                // (Modifier.clearAndSetSemantics / Image's own
                // `invisibleToUser`-marked default) apart from "no description
                // because nobody set one" — the same marker TalkBack itself
                // reads to skip a node entirely.
                if (config.getOrNull(SemanticsProperties.InvisibleToUser) != null) add("invisibleToUser")
            },
            children = children,
            truncated = (overBudget || tooDeep) && node.children.isNotEmpty(),
        )
    }

    /**
     * The discriminator each child contributes to its path.
     *
     * Picking the most stable identifier a node has is only half the job: a row
     * of five Buttons all reduce to "role:Button", and three nodes sharing an id
     * is worse than no id at all. So siblings that land on the same
     * discriminator get their occurrence appended, which stays stable for as
     * long as the tree shape does — which is exactly the contract stableId
     * offers.
     */
    private fun childDiscriminators(children: List<SemanticsNode>): List<String> {
        val raw = children.mapIndexed { index, child -> discriminatorOf(child, index) }
        val totals = raw.groupingBy { it }.eachCount()
        val seen = HashMap<String, Int>()
        return raw.map { discriminator ->
            if (totals.getValue(discriminator) == 1) {
                discriminator
            } else {
                // Map.getOrDefault is API 24; minSdk here is 21.
                val occurrence = seen[discriminator] ?: 0
                seen[discriminator] = occurrence + 1
                discriminator + "[" + occurrence + "]"
            }
        }
    }

    /** Most stable identifier first; the sibling index is the last resort. */
    private fun discriminatorOf(node: SemanticsNode, index: Int): String {
        val config = node.config
        return config.getOrNull(PortholeNodeIdKey)
            ?: config.getOrNull(SemanticsProperties.TestTag)?.let { "tag:" + it }
            ?: config.getOrNull(SemanticsProperties.Role)?.let { "role:" + it }
            ?: config.getOrNull(SemanticsProperties.ContentDescription)
                ?.joinToString(" ")
                ?.takeIf { it.isNotBlank() }
                ?.let { "cd:" + it }
            ?: "i:$index"
    }

    /** Short, deterministic, and collision-tolerant for tree-sized inputs. */
    private fun stableId(path: String): String {
        var h = -0x7ee3623b // FNV-ish seed
        for (c in path) {
            h = h xor c.code
            h *= 0x01000193
        }
        return Integer.toHexString(h)
    }
}
