// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.integration

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import leakcanary.LeakCanary
import leakcanary.OnHeapAnalyzedListener
import live.gravitylabs.porthole.collect.Setup
import live.gravitylabs.porthole.protocol.EventFrame
import live.gravitylabs.porthole.protocol.EventKinds
import live.gravitylabs.porthole.store.EventRing
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import shark.ApplicationLeak
import shark.HeapAnalysisSuccess
import shark.LeakTrace
import shark.LeakTraceObject
import shark.LibraryLeak
import shark.ReferencePattern
import java.io.File

/**
 * A real `leakcanary.LeakCanary`, on the test classpath the same way
 * `androidx.work.WorkManager` is for `WorkManagerPorthole`'s own tests — see
 * `runtime/build.gradle.kts`'s `testImplementation(libs.leakcanary.android)`
 * comment. No app ever actually dumps a heap in this test: LeakCanary's own
 * `HeapAnalysisSuccess` is a plain data class, so a fixture is built by hand
 * and handed straight to the listener [LeakCanaryPorthole.install] attached
 * — this is the same shape `StrictModeTest` uses a hand-built `Throwable` in
 * place of a real `android.os.strictmode` violation.
 *
 * GRA-64 QA: [LeakCanaryPorthole.install] no longer hooks synchronously — it
 * launches a background thread and returns immediately (see that method's
 * own doc comment for why: touching `LeakCanary.config` for the first time
 * is expensive enough to stall the main thread on a cold launch). Every test
 * below that needs the hook to have actually attached before proceeding goes
 * through [installAndAwaitHook], which polls [Setup.report] rather than
 * assuming any particular delay.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class LeakCanaryTest {

    @After
    fun tearDown() {
        // Undoes install()'s own chaining so the next test (and the next
        // test *class*, since this one really does load a real LeakCanary
        // into this Robolectric sandbox's classloader) starts from
        // LeakCanary's own default config rather than this suite's leftover
        // listener.
        LeakCanaryPorthole.uninstall()
        LeakCanary.config = LeakCanary.Config()
        LeakCanaryPorthole.lastHookThreadName = null
        LeakCanaryPorthole.lastHookThread = null
    }

    private fun EventFrame.field(key: String) = (data as JsonObject).getValue(key).jsonPrimitive

    private fun leakEvents(ring: EventRing): List<EventFrame> =
        ring.since(0, 10_000).filter { it.event == EventKinds.LEAK }

    /**
     * [LeakCanaryPorthole.install] plus a bounded wait for its background
     * thread to actually finish attaching — polling [Setup.report] rather
     * than `Thread.sleep`ing a guessed delay, and failing loudly rather than
     * proceeding against a listener that was never attached if the deadline
     * passes.
     */
    private fun installAndAwaitHook(ring: EventRing) {
        assertTrue(LeakCanaryPorthole.install(ring))
        // Join the thread this install actually started rather than polling
        // Setup.report(): that row is process-wide and still says "hooked"
        // from the previous test, so polling it returned before this
        // install's own thread had run (the CI-only failures of 2026-09-20).
        val thread = requireNotNull(LeakCanaryPorthole.lastHookThread) { "install() started no hook thread" }
        thread.join(5_000)
        if (thread.isAlive) fail("LeakCanaryPorthole's background hook thread did not finish within 5s")
        assertTrue(
            "expected Setup to report leakcanary as hooked after the thread finished",
            Setup.report().any { it.name == "leakcanary" },
        )
    }

    private fun leakTrace(className: String, retainedBytes: Int?) = LeakTrace(
        gcRootType = LeakTrace.GcRootType.JAVA_FRAME,
        referencePath = emptyList(),
        leakingObject = LeakTraceObject(
            type = LeakTraceObject.ObjectType.INSTANCE,
            className = className,
            labels = emptySet(),
            leakingStatus = LeakTraceObject.LeakingStatus.LEAKING,
            leakingStatusReason = "test fixture",
            retainedHeapByteSize = retainedBytes,
            retainedObjectCount = 1,
        ),
    )

    private fun analysis(
        applicationLeaks: List<ApplicationLeak> = emptyList(),
        libraryLeaks: List<LibraryLeak> = emptyList(),
        createdAtTimeMillis: Long = 1_700_000_000_000L,
        dumpDurationMillis: Long = 2_500L,
    ) = HeapAnalysisSuccess(
        heapDumpFile = File("fake.hprof"),
        createdAtTimeMillis = createdAtTimeMillis,
        dumpDurationMillis = dumpDurationMillis,
        analysisDurationMillis = 400L,
        metadata = emptyMap(),
        applicationLeaks = applicationLeaks,
        libraryLeaks = libraryLeaks,
        unreachableObjects = emptyList(),
    )

    // -- install(): hooks a present LeakCanary and tells Setup ---------------

    @Test
    fun `install hooks a present LeakCanary and setup reports present and hooked`() {
        val ring = EventRing()

        installAndAwaitHook(ring)

        val entry = Setup.report().single { it.name == "leakcanary" }
        assertTrue(entry.onClasspath)
        assertTrue(entry.instrumented)
        assertNull(entry.hint)
    }

    // -- off the main thread (GRA-64 QA) --------------------------------------

    @Test
    fun `the hook's own work never runs on the main thread`() {
        // GRA-64 QA: this used to run synchronously inside install(), on
        // whatever thread called it — Porthole.install(), the main thread,
        // during process start. Touching LeakCanary.config for the first
        // time is expensive enough (shark.AndroidReferenceMatchers' own
        // static init) to have measured out at roughly a second on a cold
        // launch, which is a real, findings-worthy main-thread stall this
        // integration was itself causing.
        val ring = EventRing()

        assertTrue(LeakCanaryPorthole.install(ring))

        val deadlineAt = System.currentTimeMillis() + 5_000
        while (LeakCanaryPorthole.lastHookThreadName == null) {
            if (System.currentTimeMillis() > deadlineAt) fail("the hook never ran within 5s")
            Thread.sleep(5)
        }

        assertNotEquals("main", LeakCanaryPorthole.lastHookThreadName)
        assertTrue(
            "expected the same dedicated, named daemon thread every other collector's own " +
                "background work uses, got: ${LeakCanaryPorthole.lastHookThreadName}",
            LeakCanaryPorthole.lastHookThreadName!!.startsWith("porthole-leakcanary-hook"),
        )
    }

    // -- chaining: an app's (or LeakCanary's own default) listener is never silently dropped --

    @Test
    fun `chains onto whatever onHeapAnalyzedListener was already configured`() {
        val seen = mutableListOf<Any>()
        LeakCanary.config = LeakCanary.config.copy(
            onHeapAnalyzedListener = OnHeapAnalyzedListener { seen += it },
        )

        val ring = EventRing()
        installAndAwaitHook(ring)

        val fixture = analysis(applicationLeaks = listOf(ApplicationLeak(listOf(leakTrace("com.example.shop.LeakyActivity", 128_000)))))
        LeakCanary.config.onHeapAnalyzedListener.onHeapAnalyzed(fixture)

        assertEquals(
            "the previously-configured listener must still see every analysis",
            1,
            seen.size,
        )
        assertEquals(1, leakEvents(ring).size)
    }

    // -- one event per leak, carrying trace text, class, retained size, count --

    @Test
    fun `an application leak becomes one event with class, retained size, trace text and count`() {
        val ring = EventRing()
        installAndAwaitHook(ring)

        val trace = leakTrace("com.example.shop.LeakyActivity", 256_000)
        // Two occurrences of the exact same leak: LeakCanary groups repeats
        // of one reference path under a single Leak rather than reporting
        // each instance on its own, which is what `leakCount` reads —
        // `retainedHeapByteSize` is `Leak.totalRetainedHeapByteSize`, which
        // sums every occurrence's own retained size, so two 256,000-byte
        // occurrences of the same leak total 512,000.
        val leak = ApplicationLeak(listOf(trace, trace))
        LeakCanary.config.onHeapAnalyzedListener.onHeapAnalyzed(analysis(applicationLeaks = listOf(leak)))

        val event = leakEvents(ring).single()
        assertEquals("application", event.field("kind").content)
        assertEquals("com.example.shop.LeakyActivity", event.field("leakingClass").content)
        assertEquals(512_000, event.field("retainedHeapByteSize").content.toInt())
        assertEquals(2, event.field("leakCount").content.toInt())
        assertTrue(
            "expected LeakCanary's own rendered trace text, got: ${event.field("traceText").content}",
            event.field("traceText").content.contains("LeakyActivity"),
        )
    }

    @Test
    fun `two application leaks in one analysis become two separate events`() {
        val ring = EventRing()
        installAndAwaitHook(ring)

        val leaks = listOf(
            ApplicationLeak(listOf(leakTrace("com.example.shop.LeakyActivity", 100))),
            ApplicationLeak(listOf(leakTrace("com.example.shop.LeakyPresenter", 200))),
        )
        LeakCanary.config.onHeapAnalyzedListener.onHeapAnalyzed(analysis(applicationLeaks = leaks))

        val classes = leakEvents(ring).map { it.field("leakingClass").content }
        assertEquals(listOf("com.example.shop.LeakyActivity", "com.example.shop.LeakyPresenter"), classes)
    }

    // -- application vs library: the kind findings.ts reads to pick warning vs note --

    @Test
    fun `a library leak carries kind=library, distinct from an application leak's kind=application`() {
        val ring = EventRing()
        installAndAwaitHook(ring)

        val libraryLeak = LibraryLeak(
            leakTraces = listOf(leakTrace("android.view.inputmethod.InputMethodManager", 4_000)),
            pattern = ReferencePattern.JavaLocalPattern("main"),
            description = "a leak LeakCanary already knows about and classifies as a framework defect",
        )
        LeakCanary.config.onHeapAnalyzedListener.onHeapAnalyzed(analysis(libraryLeaks = listOf(libraryLeak)))

        assertEquals("library", leakEvents(ring).single().field("kind").content)
    }

    // -- the heap-dump pause window, reconstructed for stall attribution ------

    @Test
    fun `carries the heap dump's own start and end so a stall in that window can be attributed to it`() {
        val ring = EventRing()
        installAndAwaitHook(ring)

        val leak = ApplicationLeak(listOf(leakTrace("com.example.shop.LeakyActivity", 1)))
        LeakCanary.config.onHeapAnalyzedListener.onHeapAnalyzed(
            analysis(applicationLeaks = listOf(leak), createdAtTimeMillis = 1_700_000_000_000L, dumpDurationMillis = 3_000L),
        )

        val event = leakEvents(ring).single()
        val start = event.field("heapDumpStartMs").content.toLong()
        val end = event.field("heapDumpEndMs").content.toLong()
        assertEquals(
            "the window's width has to be exactly the reported dump duration",
            3_000L,
            end - start,
        )
    }

    // -- a failed analysis has no leaks to report and is silently dropped -----

    @Test
    fun `a heap analysis failure emits nothing - LeakCanary already has its own notification for that`() {
        val ring = EventRing()
        installAndAwaitHook(ring)

        LeakCanaryPorthole.onHeapAnalyzed(
            ring,
            shark.HeapAnalysisFailure(
                heapDumpFile = File("fake.hprof"),
                createdAtTimeMillis = 0L,
                dumpDurationMillis = 0L,
                analysisDurationMillis = 0L,
                exception = shark.HeapAnalysisException(RuntimeException("boom")),
            ),
        )

        assertTrue(leakEvents(ring).isEmpty())
    }
}
