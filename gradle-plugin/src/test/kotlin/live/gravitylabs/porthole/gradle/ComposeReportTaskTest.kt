// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.api.GradleException
import org.gradle.testfixtures.ProjectBuilder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * [resolveComposeReportVariant] mirrors [resolveInstallTask]'s own rule
 * (single variant auto-selects, ambiguous needs `-Pporthole.variant`) —
 * pinned here the same way [ResolveInstallTaskTest] pins the original, since
 * a future refactor that tried to share the two must not silently change
 * either one's error text or auto-select behaviour without a test noticing.
 */
class ResolveComposeReportVariantTest {

    @Test
    fun `auto-selects the only debug variant`() {
        assertEquals("debug", resolveComposeReportVariant(listOf("debug"), requestedVariant = null))
    }

    @Test
    fun `an explicit request is honoured even when unambiguous`() {
        assertEquals("roomDebug", resolveComposeReportVariant(listOf("roomDebug"), requestedVariant = "roomDebug"))
    }

    @Test
    fun `two debug variants without a request is refused, naming both`() {
        val error = assertThrows {
            resolveComposeReportVariant(listOf("roomDebug", "sqldelightDebug"), requestedVariant = null)
        }
        assertTrue(error.message.orEmpty(), error.message!!.contains("roomDebug"))
        assertTrue(error.message.orEmpty(), error.message!!.contains("sqldelightDebug"))
        assertTrue(error.message.orEmpty(), error.message!!.contains("porthole.variant"))
    }

    @Test
    fun `an explicit request naming the wrong variant is refused, not silently picked`() {
        val error = assertThrows {
            resolveComposeReportVariant(listOf("roomDebug", "sqldelightDebug"), requestedVariant = "typoDebug")
        }
        assertTrue(error.message.orEmpty(), error.message!!.contains("typoDebug"))
    }

    @Test
    fun `no debug variant at all is refused rather than crashing on an empty list`() {
        val error = assertThrows { resolveComposeReportVariant(emptyList(), requestedVariant = null) }
        assertTrue(error.message.orEmpty(), error.message!!.contains("debugBuildTypes"))
    }

    private fun assertThrows(block: () -> Unit): GradleException {
        try {
            block()
        } catch (e: GradleException) {
            return e
        }
        fail("expected a GradleException")
        error("unreachable")
    }
}

class KotlinCompileTaskNameTest {

    @Test
    fun `capitalizes the variant into AGP-Kotlin's own compile task naming`() {
        assertEquals("compileDebugKotlin", kotlinCompileTaskName("debug"))
        assertEquals("compileRoomDebugKotlin", kotlinCompileTaskName("roomDebug"))
    }
}

class ComposeReportRequestedTest {

    @Test
    fun `true when the bare task name was requested`() {
        val project = ProjectBuilder.builder().build()
        project.gradle.startParameter.setTaskNames(listOf("portholeComposeReport"))
        assertTrue(composeReportRequested(project))
    }

    @Test
    fun `true when a project-qualified task name was requested`() {
        val project = ProjectBuilder.builder().build()
        project.gradle.startParameter.setTaskNames(listOf(":sample:portholeComposeReport"))
        assertTrue(composeReportRequested(project))
    }

    @Test
    fun `false for an ordinary build with no mention of the task`() {
        val project = ProjectBuilder.builder().build()
        project.gradle.startParameter.setTaskNames(listOf("assembleDebug", "test"))
        assertFalse(composeReportRequested(project))
    }

    @Test
    fun `a task name that merely contains the substring does not count`() {
        // Regression guard: naive `contains` would wrongly match a
        // hypothetical "myPortholeComposeReportThing" task.
        val project = ProjectBuilder.builder().build()
        project.gradle.startParameter.setTaskNames(listOf("notPortholeComposeReport"))
        assertFalse(composeReportRequested(project))
    }
}

class SourceFingerprintTest {

    @get:Rule
    val temp = TemporaryFolder()

    @Test
    fun `is deterministic regardless of file iteration order`() {
        val root = temp.newFolder()
        val a = File(root, "a.kt").apply { writeText("class A") }
        val b = File(root, "b.kt").apply { writeText("class B") }
        val forward = sourceFingerprint(setOf(a, b), root)
        val backward = sourceFingerprint(setOf(b, a), root)
        assertEquals(forward, backward)
    }

    @Test
    fun `changes when a file's content changes`() {
        val root = temp.newFolder()
        val file = File(root, "a.kt").apply { writeText("class A") }
        val before = sourceFingerprint(setOf(file), root)
        file.writeText("class A { val x = 1 }")
        val after = sourceFingerprint(setOf(file), root)
        assertNotEquals(before, after)
    }

    @Test
    fun `changes when a file is renamed, even with identical content`() {
        // The relative path is hashed alongside the content precisely so a
        // rename (or a file moving between source sets) is not invisible to
        // the fingerprint — two files with the same bytes at different
        // paths are not the same source state.
        val root = temp.newFolder()
        val a = File(root, "a.kt").apply { writeText("class Same") }
        val fingerprintA = sourceFingerprint(setOf(a), root)
        a.delete()
        val b = File(root, "b.kt").apply { writeText("class Same") }
        val fingerprintB = sourceFingerprint(setOf(b), root)
        assertNotEquals(fingerprintA, fingerprintB)
    }

    @Test
    fun `an empty source set still produces a stable, well-formed hash`() {
        val root = temp.newFolder()
        val fingerprint = sourceFingerprint(emptySet(), root)
        assertEquals(64, fingerprint.length) // SHA-256, hex-encoded
        assertEquals(fingerprint, sourceFingerprint(emptySet(), root))
    }
}
