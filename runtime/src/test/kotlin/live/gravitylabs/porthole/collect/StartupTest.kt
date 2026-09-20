// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.app.Application
import android.os.SystemClock
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import live.gravitylabs.porthole.protocol.EventKinds
import live.gravitylabs.porthole.store.EventRing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper

/**
 * [StartupAssembly] with hand-built timestamps — GRA-60's own AC: "unit-test
 * the ordering and arithmetic with injected timestamps; the live check is
 * hardware/emulator if available." No physical device or emulator was
 * available in this environment (see the ticket's own report for what was
 * checked and cited instead), so this suite is the whole proof for the
 * runtime side.
 */
class StartupAssemblyTest {

    private fun t(
        originMs: Long = 1_000L,
        onCreateEntryMs: Long? = 1_005L,
        onCreateExitMs: Long? = 1_040L,
        activityOnCreateMs: Long? = 1_120L,
        activityOnStartMs: Long? = 1_150L,
        activityOnResumeMs: Long? = 1_170L,
        firstFrameMs: Long? = 1_260L,
        reportFullyDrawnMs: Long? = null,
        originAssumed: Boolean = false,
    ) = StartupAssembly.Timestamps(
        originMs = originMs,
        originAssumed = originAssumed,
        onCreateEntryMs = onCreateEntryMs,
        onCreateExitMs = onCreateExitMs,
        activityOnCreateMs = activityOnCreateMs,
        activityOnStartMs = activityOnStartMs,
        activityOnResumeMs = activityOnResumeMs,
        firstFrameMs = firstFrameMs,
        reportFullyDrawnMs = reportFullyDrawnMs,
    )

    // -- ordering: AC1 -- fork, onCreate in/out, first Activity resume, first frame, in that order --

    @Test
    fun `a cold launch's phases come back in the order they happened`() {
        val phases = StartupAssembly.phases(t())
        assertEquals(
            listOf("fork", "onCreateEntry", "onCreateExit", "activityOnCreate", "activityOnStart", "activityOnResume", "firstFrame"),
            phases.map { it.first },
        )
        // Strictly increasing — the ordering claim is about time, not just position.
        for (i in 1 until phases.size) {
            assertTrue("${phases[i - 1]} should precede ${phases[i]}", phases[i - 1].second < phases[i].second)
        }
    }

    @Test
    fun `reportFullyDrawn, when present, sorts wherever its own timestamp actually falls`() {
        // Well after first frame, the common case: initial data finishes loading later.
        val phases = StartupAssembly.phases(t(reportFullyDrawnMs = 1_900L))
        assertEquals("reportFullyDrawn", phases.last().first)
    }

    // -- arithmetic --

    @Test
    fun `totalMs is first frame minus the fork, not minus onCreate`() {
        val timestamps = t(originMs = 1_000L, firstFrameMs = 1_260L)
        assertEquals(260L, StartupAssembly.totalMs(timestamps))
    }

    @Test
    fun `totalMs is null before the first frame has happened`() {
        assertNull(StartupAssembly.totalMs(t(firstFrameMs = null)))
    }

    @Test
    fun `dominantPhase names the two consecutive phases with the widest gap`() {
        // onCreateExit(1040) -> activityOnCreate(1120) is 80ms, the widest gap
        // among fork(1000)->onCreateEntry(1005)=5, onCreateEntry->onCreateExit=35,
        // activityOnCreate->activityOnStart=30, activityOnStart->activityOnResume=20,
        // activityOnResume->firstFrame(1260)=90 -- actually the widest is that
        // last one; picked deliberately so the test proves the function looks at
        // every adjacent pair, not just the first or the biggest single timestamp.
        val timestamps = t()
        assertEquals("activityOnResume->firstFrame", StartupAssembly.dominantPhase(timestamps))
    }

    @Test
    fun `dominantPhase is null with fewer than two phases observed`() {
        val timestamps = StartupAssembly.Timestamps(originMs = 1_000L)
        assertNull(StartupAssembly.dominantPhase(timestamps))
    }

    // -- classification: AC2 -- warm is classified warm and carries no onCreate phase --

    @Test
    fun `onCreate entry and exit both present classifies cold`() {
        assertEquals("cold", StartupAssembly.classify(t()))
    }

    @Test
    fun `no onCreate but a fresh Activity classifies warm`() {
        val timestamps = t(onCreateEntryMs = null, onCreateExitMs = null)
        assertEquals("warm", StartupAssembly.classify(timestamps))
    }

    @Test
    fun `neither onCreate nor a fresh Activity classifies hot`() {
        val timestamps = t(
            onCreateEntryMs = null,
            onCreateExitMs = null,
            activityOnCreateMs = null,
            activityOnStartMs = null,
        )
        assertEquals("hot", StartupAssembly.classify(timestamps))
    }

    @Test
    fun `a half-observed onCreate (exit with no entry) does not count as cold`() {
        // Should never happen live -- entry is stamped at construction, exit
        // later -- but the classifier's own rule is "both", not "either", and
        // that is worth pinning independently of whether production can
        // currently produce the half-observed case.
        val timestamps = t(onCreateEntryMs = null)
        assertEquals("warm", StartupAssembly.classify(timestamps))
    }

    // -- the event payload: warm/hot omit fields a cold launch carries --

    @Test
    fun `toEvent's cold launch carries both onCreate timestamps`() {
        val event = StartupAssembly.toEvent(t())
        assertEquals("cold", event["classification"]?.jsonPrimitive?.contentOrNull)
        assertEquals(1_005L, event["onCreateEntryMs"]?.jsonPrimitive?.long)
        assertEquals(1_040L, event["onCreateExitMs"]?.jsonPrimitive?.long)
    }

    @Test
    fun `toEvent's warm launch reports no onCreate phase at all — AC2`() {
        val timestamps = t(onCreateEntryMs = null, onCreateExitMs = null)
        val event = StartupAssembly.toEvent(timestamps)
        assertEquals("warm", event["classification"]?.jsonPrimitive?.contentOrNull)
        assertFalse("a warm launch must not carry onCreateEntryMs", event.containsKey("onCreateEntryMs"))
        assertFalse("a warm launch must not carry onCreateExitMs", event.containsKey("onCreateExitMs"))
        // Still carries everything it *did* observe.
        assertTrue(event.containsKey("activityOnCreateMs"))
        assertTrue(event.containsKey("firstFrameMs"))
    }

    @Test
    fun `toEvent flags an assumed origin rather than presenting it as measured`() {
        val event = StartupAssembly.toEvent(t(originAssumed = true))
        assertTrue(event["originAssumed"]?.jsonPrimitive?.boolean == true)
    }

    @Test
    fun `toEvent omits reportFullyDrawnMs when it was never observed`() {
        val event = StartupAssembly.toEvent(t(reportFullyDrawnMs = null))
        assertFalse(event.containsKey("reportFullyDrawnMs"))
    }

    @Test
    fun `toEvent carries reportFullyDrawnMs when it was observed`() {
        val event = StartupAssembly.toEvent(t(reportFullyDrawnMs = 1_900L))
        assertEquals(1_900L, event["reportFullyDrawnMs"]?.jsonPrimitive?.long)
    }
}

/**
 * [StartupCollector]'s Android wiring, through Robolectric — the seam
 * [StartupAssemblyTest] cannot reach: registering the ActivityLifecycleCallbacks,
 * scheduling emission off the main looper, and the grace window that lets a
 * close-behind [Porthole.reportFullyDrawn] call land in the same event.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class StartupCollectorTest {

    private val app: Application get() = RuntimeEnvironment.getApplication()

    private fun startupEvents(ring: EventRing) = ring.since(0).filter { it.event == EventKinds.STARTUP }

    private fun JsonElement.asObject(): JsonObject = this as JsonObject

    @Test
    fun `emits one startup event after the grace window, with a plausible total`() {
        val ring = EventRing()
        val collector = StartupCollector(ring)
        collector.install(app)

        // Relative to the fake clock's own "now" rather than a literal, so
        // this holds regardless of where Robolectric's SystemClock happens to
        // start — only the ordering (after origin) and the gap (500ms) matter.
        val firstFrame = SystemClock.uptimeMillis() + 500L
        collector.onFirstFrame(firstFrame)
        assertTrue("must not emit before the grace window elapses", startupEvents(ring).isEmpty())

        ShadowLooper.idleMainLooper(2_000, TimeUnit.MILLISECONDS)

        val events = startupEvents(ring)
        assertEquals(1, events.size)
        val data = events.single().data.asObject()
        assertEquals("cold", data["classification"]?.jsonPrimitive?.contentOrNull)
        val total = data["totalMs"]?.jsonPrimitive?.long
        assertTrue("expected a positive, plausible total, got $total", total != null && total in 1..60_000)
    }

    @Test
    fun `a reportFullyDrawn call inside the grace window is included, not dropped`() {
        val ring = EventRing()
        val collector = StartupCollector(ring)
        collector.install(app)

        collector.onFirstFrame(SystemClock.uptimeMillis() + 500L)
        collector.onReportFullyDrawn()

        val events = startupEvents(ring)
        assertEquals(1, events.size)
        assertTrue(events.single().data.asObject().containsKey("reportFullyDrawnMs"))
    }

    @Test
    fun `never calling onFirstFrame never emits`() {
        val ring = EventRing()
        val collector = StartupCollector(ring)
        collector.install(app)

        ShadowLooper.idleMainLooper(10_000, TimeUnit.MILLISECONDS)

        assertTrue(startupEvents(ring).isEmpty())
    }

    @Test
    fun `stop cancels a still-pending emission`() {
        val ring = EventRing()
        val collector = StartupCollector(ring)
        collector.install(app)

        collector.onFirstFrame(SystemClock.uptimeMillis() + 500L)
        collector.stop(app)
        ShadowLooper.idleMainLooper(5_000, TimeUnit.MILLISECONDS)

        assertTrue("stop() must not leave the emission still pending", startupEvents(ring).isEmpty())
    }
}
