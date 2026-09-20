// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.app.Activity
import android.app.Application
import android.os.SystemClock
import androidx.activity.ComponentActivity
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import live.gravitylabs.porthole.Porthole
import live.gravitylabs.porthole.protocol.EventFrame
import live.gravitylabs.porthole.protocol.EventKinds
import live.gravitylabs.porthole.store.EventRing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
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
        originKind: String = StartupAssembly.OriginKind.FORK,
    ) = StartupAssembly.Timestamps(
        originMs = originMs,
        originAssumed = originAssumed,
        originKind = originKind,
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

    // -- QA 60-C: originKind travels on the wire, defaults to fork --

    @Test
    fun `originKind defaults to fork`() {
        val event = StartupAssembly.toEvent(t())
        assertEquals("fork", event["originKind"]?.jsonPrimitive?.contentOrNull)
    }

    @Test
    fun `originKind carries activity for a warm-hot-shaped origin`() {
        val event = StartupAssembly.toEvent(t(originKind = StartupAssembly.OriginKind.ACTIVITY))
        assertEquals("activity", event["originKind"]?.jsonPrimitive?.contentOrNull)
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

private class PlainActivity : Activity()

private class TestComponentActivity : ComponentActivity()

/**
 * The GRA-60 follow-up: warm and hot launches observed live, not only
 * classified in [StartupAssembly]. Drives a real Robolectric
 * `ActivityController` through cold, then hot (the same Activity instance
 * merely stopped and restarted), then warm (that instance destroyed and a
 * fresh one created) — the same three shapes the coordinator's own follow-up
 * names. `armNextFrame` is wired to a local variable rather than a real
 * `FrameCollector`, the same way [StartupCollectorTest] drives `onFirstFrame`
 * directly: what fires it is [FrameWiringTest] below, once, which is the
 * seam this suite does not need to re-prove per scenario.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class StartupLiveRelaunchTest {

    private val app: Application get() = RuntimeEnvironment.getApplication()

    private fun startupEvents(ring: EventRing) = ring.since(0).filter { it.event == EventKinds.STARTUP }

    private fun JsonElement.asObject(): JsonObject = this as JsonObject

    private fun classificationOf(frame: EventFrame): String =
        frame.data.asObject()["classification"]?.jsonPrimitive?.contentOrNull ?: "?"

    @Test
    fun `cold, then hot, then warm — each a real launch this collector observes live`() {
        val ring = EventRing()
        val collector = StartupCollector(ring)
        var armedCallback: ((Long) -> Unit)? = null
        collector.armNextFrame = { callback -> armedCallback = callback }
        collector.install(app)

        // -- cold: the process's first Activity --
        val first = Robolectric.buildActivity(PlainActivity::class.java)
        first.create().start().resume()
        collector.onFirstFrame(SystemClock.uptimeMillis() + 10L)
        ShadowLooper.idleMainLooper(2_000, TimeUnit.MILLISECONDS)

        val afterCold = startupEvents(ring)
        assertEquals(1, afterCold.size)
        assertEquals("cold", classificationOf(afterCold[0]))
        assertNull("armNextFrame must not arm during the cold launch itself", armedCallback)

        // -- hot: the same instance, merely stopped and brought back — no onCreate --
        first.pause().stop()
        assertNull("no pending launch should be armed while the app is merely backgrounded", armedCallback)
        // restart() alone dispatches onRestart *and* onStart (Robolectric's
        // ActivityController combines them, matching the real framework
        // sequence for coming back from stopped) — a separate start() call
        // after it double-counts onActivityStarted, which is what the first
        // version of this test got wrong and diagnosed via startedCount.
        first.restart().resume()
        assertTrue("the 0-to-1 transition should have armed the next-frame hook", armedCallback != null)
        armedCallback!!.invoke(SystemClock.uptimeMillis() + 40L)
        armedCallback = null

        val afterHot = startupEvents(ring)
        assertEquals(2, afterHot.size)
        val hot = afterHot[1]
        assertEquals("hot", classificationOf(hot))
        assertFalse(
            "a hot launch must not report an Application.onCreate phase",
            hot.data.asObject().containsKey("onCreateEntryMs"),
        )
        assertFalse(
            "a hot launch has no fresh Activity.onCreate either",
            hot.data.asObject().containsKey("activityOnCreateMs"),
        )
        assertTrue(hot.data.asObject().containsKey("activityOnResumeMs"))
        // QA 60-C: a hot/warm origin is the relaunched Activity's own
        // lifecycle callback, never a fork — originKind says so, and
        // originAssumed is true for the same reason (its own contract is
        // "not the real fork time", which this categorically is not).
        assertEquals("activity", hot.data.asObject()["originKind"]?.jsonPrimitive?.contentOrNull)
        assertTrue(hot.data.asObject()["originAssumed"]?.jsonPrimitive?.boolean == true)

        // -- warm: that instance destroyed, a fresh one created --
        first.pause().stop().destroy()
        val second = Robolectric.buildActivity(PlainActivity::class.java)
        second.create()
        assertTrue("onCreate on a fresh instance should arm the next-frame hook immediately", armedCallback != null)
        second.start().resume()
        armedCallback!!.invoke(SystemClock.uptimeMillis() + 80L)
        armedCallback = null

        val afterWarm = startupEvents(ring)
        assertEquals(3, afterWarm.size)
        val warm = afterWarm[2]
        assertEquals("warm", classificationOf(warm))
        assertFalse(
            "a warm launch must not report an Application.onCreate phase either",
            warm.data.asObject().containsKey("onCreateEntryMs"),
        )
        assertTrue(
            "a warm launch's whole distinguishing feature is a fresh Activity.onCreate",
            warm.data.asObject().containsKey("activityOnCreateMs"),
        )
        assertEquals("activity", warm.data.asObject()["originKind"]?.jsonPrimitive?.contentOrNull)
        assertTrue(warm.data.asObject()["originAssumed"]?.jsonPrimitive?.boolean == true)

        // "cold only once per process" — the property EM's follow-up asked to keep and test.
        assertEquals(listOf("cold", "hot", "warm"), afterWarm.map(::classificationOf))
        assertTrue(afterWarm.drop(1).none { it.data.asObject().containsKey("onCreateEntryMs") })
    }

    @Test
    fun `a second launch cannot begin before the cold event has actually been emitted`() {
        val ring = EventRing()
        val collector = StartupCollector(ring)
        var armedCallback: ((Long) -> Unit)? = null
        collector.armNextFrame = { callback -> armedCallback = callback }
        collector.install(app)

        val first = Robolectric.buildActivity(PlainActivity::class.java)
        first.create().start().resume()
        // No onFirstFrame() yet — the cold event has not been emitted. A
        // second activity showing up now (a second window in a
        // multi-activity app's own launch sequence, say) must not be
        // mistaken for a relaunch: startedCount never reached zero.
        val second = Robolectric.buildActivity(PlainActivity::class.java)
        second.create().start().resume()

        assertNull("no relaunch should be armed before the process's own cold event exists", armedCallback)
        assertTrue(startupEvents(ring).isEmpty())
    }

    @Test
    fun `reportFullyDrawn during a warm-hot launch is recorded on that launch, not lost — QA 60-B`() {
        val ring = EventRing()
        val collector = StartupCollector(ring)
        var armedCallback: ((Long) -> Unit)? = null
        collector.armNextFrame = { callback -> armedCallback = callback }
        collector.install(app)

        val first = Robolectric.buildActivity(PlainActivity::class.java)
        first.create().start().resume()
        collector.onFirstFrame(SystemClock.uptimeMillis() + 10L)
        ShadowLooper.idleMainLooper(2_000, TimeUnit.MILLISECONDS)
        assertEquals(1, startupEvents(ring).size)

        // hot relaunch: report before the ending frame arrives, the way a
        // fast screen that was already fully drawn once might.
        first.pause().stop()
        first.restart().resume()
        assertTrue(armedCallback != null)
        collector.onReportFullyDrawn()
        armedCallback!!.invoke(SystemClock.uptimeMillis() + 5L)

        val hot = startupEvents(ring)[1]
        assertTrue(
            "a reportFullyDrawn call that happened before this launch's own ending frame must not be dropped",
            hot.data.asObject().containsKey("reportFullyDrawnMs"),
        )
    }
}

/**
 * androidx.activity 1.7's own `ComponentActivity.reportFullyDrawn()` observed
 * automatically — GRA-60's follow-up 2. No `Porthole.reportFullyDrawn()` call
 * anywhere in this test; the platform API alone is enough.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class ComponentActivityReportFullyDrawnTest {

    private val app: Application get() = RuntimeEnvironment.getApplication()

    private fun startupEvents(ring: EventRing) = ring.since(0).filter { it.event == EventKinds.STARTUP }

    private fun JsonElement.asObject(): JsonObject = this as JsonObject

    @Test
    fun `Activity_reportFullyDrawn on a ComponentActivity is caught with no app code`() {
        val ring = EventRing()
        val collector = StartupCollector(ring)
        collector.install(app)

        val controller = Robolectric.buildActivity(TestComponentActivity::class.java)
        controller.create().start().resume()

        collector.onFirstFrame(SystemClock.uptimeMillis() + 10L)
        // The standard platform API — not Porthole.reportFullyDrawn().
        controller.get().reportFullyDrawn()
        ShadowLooper.idleMainLooper(2_000, TimeUnit.MILLISECONDS)

        val events = startupEvents(ring)
        assertEquals(1, events.size)
        assertTrue(
            "expected reportFullyDrawnMs from the automatic ComponentActivity hook",
            events.single().data.asObject().containsKey("reportFullyDrawnMs"),
        )
    }

    @Test
    fun `a plain, non-ComponentActivity gets no automatic hook, and no crash either`() {
        val ring = EventRing()
        val collector = StartupCollector(ring)
        collector.install(app)

        val controller = Robolectric.buildActivity(PlainActivity::class.java)
        controller.create().start().resume()

        collector.onFirstFrame(SystemClock.uptimeMillis() + 10L)
        ShadowLooper.idleMainLooper(2_000, TimeUnit.MILLISECONDS)

        val events = startupEvents(ring)
        assertEquals(1, events.size)
        assertFalse(events.single().data.asObject().containsKey("reportFullyDrawnMs"))
    }
}

/**
 * The regression this suite otherwise cannot catch: [FrameCollector.onFirstDraw]
 * is a field [live.gravitylabs.porthole.Porthole.install] sets, not something
 * [StartupCollector] reaches on its own. Deleting that one wiring line would
 * leave every test above green — they all call `collector.onFirstFrame(...)`
 * directly — while a real device would never emit a `startup` event at all.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class FrameWiringTest {

    private val app: Application get() = RuntimeEnvironment.getApplication()

    @Test
    fun `Porthole install wires FrameCollector's first-draw callback into StartupCollector`() {
        Porthole.install(app, port = 0)
        try {
            val session = currentSessionOrNull() ?: error("Porthole.install did not leave a session behind")
            val fields = sessionFields(session)
            val frames = fields["frames"] as? FrameCollector ?: error("Session has no `frames` field")
            val ring = fields["ring"] as? EventRing ?: error("Session has no `ring` field")

            val callback = frames.onFirstDraw
            assertTrue("Porthole.install should have wired FrameCollector.onFirstDraw", callback != null)

            // Calling it directly is exactly what FrameCollector's own frame
            // listener does once it sees a first-draw frame — the one part of
            // that path a real FrameMetrics object (no public constructor)
            // cannot be manufactured to exercise here.
            callback!!(SystemClock.uptimeMillis() + 5L)
            ShadowLooper.idleMainLooper(2_000, TimeUnit.MILLISECONDS)

            val events = ring.since(0).filter { it.event == EventKinds.STARTUP }
            assertEquals(1, events.size)
        } finally {
            Porthole.shutdown()
        }
    }

    private fun currentSessionOrNull(): Any? {
        val field = Class.forName("live.gravitylabs.porthole.Porthole").getDeclaredField("session")
        field.isAccessible = true
        return field.get(Porthole)
    }

    private fun sessionFields(session: Any): Map<String, Any?> =
        session.javaClass.declaredFields.associate { f ->
            f.isAccessible = true
            f.name to f.get(session)
        }
}
