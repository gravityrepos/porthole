// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.app.Application
import android.app.ApplicationExitInfo
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import live.gravitylabs.porthole.protocol.EventFrame
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
import java.io.ByteArrayInputStream

/**
 * `ExitInfoCollector` never touches a real `ApplicationExitInfo` — that class
 * has no public constructor, so the seam is [ExitHistoryProvider]: every test
 * here hands the collector a lambda returning hand-built [ExitRecord]s
 * instead (GRA-58's own instruction: "inject a provider function, do not
 * reflect"). `Application` itself is real, via Robolectric, only for
 * `filesDir` and `packageManager` — the dedupe file and the fallback
 * versionName both need those to be genuine framework objects, the same
 * reason `ShutdownTest` gives for using Robolectric at all.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class ExitInfoTest {

    private val app: Application get() = RuntimeEnvironment.getApplication()

    // -- reasons map to constant names ---------------------------------------

    @Test
    fun `every known reason maps to its constant name`() {
        val cases = listOf(
            ApplicationExitInfo.REASON_ANR to "REASON_ANR",
            ApplicationExitInfo.REASON_CRASH to "REASON_CRASH",
            ApplicationExitInfo.REASON_CRASH_NATIVE to "REASON_CRASH_NATIVE",
            ApplicationExitInfo.REASON_LOW_MEMORY to "REASON_LOW_MEMORY",
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE to "REASON_EXCESSIVE_RESOURCE_USAGE",
            ApplicationExitInfo.REASON_USER_REQUESTED to "REASON_USER_REQUESTED",
            ApplicationExitInfo.REASON_SIGNALED to "REASON_SIGNALED",
            ApplicationExitInfo.REASON_OTHER to "REASON_OTHER",
        )
        val records = cases.mapIndexed { index, (reason, _) ->
            ExitRecord(timestamp = 1_000L + index, reason = reason, importance = 100, pss = 1, rss = 1)
        }
        val ring = EventRing()
        val collector = ExitInfoCollector(ring, historyProvider = { records })

        collector.install(app)

        val emitted = exitEvents(ring)
        assertEquals(cases.size, emitted.size)
        cases.forEachIndexed { index, (_, expectedName) ->
            assertEquals(expectedName, emitted[index].field("reason")?.jsonPrimitive?.content)
        }
    }

    // -- dedupe across two install()s ----------------------------------------

    @Test
    fun `the same death is never reported twice across a reconnect or reinstall`() {
        val records = listOf(
            ExitRecord(timestamp = 5_000L, reason = ApplicationExitInfo.REASON_ANR, importance = 100, pss = 1, rss = 1),
        )
        val ring = EventRing()
        // Same Application (same filesDir) across both installs, as a real
        // reconnect or a real reinstall onto the same device would be -- the
        // dedupe file is what has to carry the memory across them, not the
        // in-memory collector instance.
        val first = ExitInfoCollector(ring, historyProvider = { records })
        first.install(app)
        assertEquals(1, exitEvents(ring).size)

        val second = ExitInfoCollector(ring, historyProvider = { records })
        second.install(app)
        assertEquals(
            "the second install() must not re-report a death the dedupe file already has",
            1,
            exitEvents(ring).size,
        )
    }

    @Test
    fun `a genuinely new death after a dedup'd one is still reported`() {
        val ring = EventRing()
        val first = ExitInfoCollector(
            ring,
            historyProvider = {
                listOf(ExitRecord(timestamp = 1L, reason = ApplicationExitInfo.REASON_CRASH, importance = 100, pss = 1, rss = 1))
            },
        )
        first.install(app)
        assertEquals(1, exitEvents(ring).size)

        val second = ExitInfoCollector(
            ring,
            historyProvider = {
                listOf(
                    ExitRecord(timestamp = 1L, reason = ApplicationExitInfo.REASON_CRASH, importance = 100, pss = 1, rss = 1),
                    ExitRecord(timestamp = 2L, reason = ApplicationExitInfo.REASON_ANR, importance = 100, pss = 1, rss = 1),
                )
            },
        )
        second.install(app)
        assertEquals(2, exitEvents(ring).size)
        assertEquals("REASON_ANR", exitEvents(ring).last().field("reason")?.jsonPrimitive?.content)
    }

    // -- API < 30 says unavailable, emits nothing ----------------------------

    @Test
    @Config(sdk = [29])
    fun `below API 30 the provider is never called and nothing is emitted`() {
        var called = false
        val ring = EventRing()
        val collector = ExitInfoCollector(
            ring,
            historyProvider = {
                called = true
                listOf(ExitRecord(timestamp = 1L, reason = ApplicationExitInfo.REASON_ANR, importance = 100, pss = 1, rss = 1))
            },
        )

        val installed = collector.install(app)

        // install() still returns true -- it did its job, which below API 30
        // is "confirm there is nothing to do". `hello.sdkInt` is what tells
        // the MCP side the API is unavailable; there is no event to invent
        // for that fact.
        assertTrue(installed)
        assertFalse("the history provider must not be called below API 30", called)
        assertTrue(exitEvents(ring).isEmpty())
    }

    // -- trace summary puts the app frame first ------------------------------

    @Test
    fun `the main thread's stack leads with the app's own frame`() {
        val ring = EventRing()
        val collector = ExitInfoCollector(
            ring,
            appPackages = listOf("com.example.shop."),
            historyProvider = {
                listOf(
                    ExitRecord(
                        timestamp = 9_000L,
                        reason = ApplicationExitInfo.REASON_ANR,
                        importance = 100,
                        pss = 1,
                        rss = 1,
                        traceInputStream = { ByteArrayInputStream(ANR_TRACE.toByteArray()) },
                    ),
                )
            },
        )

        collector.install(app)

        val event = exitEvents(ring).single()
        val mainStack = event.field("mainStack")?.jsonPrimitive?.content
            ?: error("expected a mainStack field on an ANR exit event")
        // The raw fixture's true top frame is `java.lang.Thread.sleep` — a
        // framework frame, not the app's — with the app's own frames sitting
        // lower in the same thread. Asserting the app frame leads is only
        // real evidence of reordering because of that: a collector that
        // forgot to call StackFormat.order at all would produce a mainStack
        // starting with `java.lang.Thread.sleep`, not the app frame, and
        // this assertion would catch it. (An earlier version of this fixture
        // put the app frame at the raw top too, which made this assertion
        // pass whether or not reordering ever ran — see the mutation that
        // caught that, quoted in the ticket's self-check.)
        assertTrue(
            "expected the app's own frame first, got: $mainStack",
            mainStack.startsWith("com.example.shop.data.CartRepository.blockingLoad"),
        )
        // The framework frame is real evidence and must survive reordering,
        // just not lead it.
        assertTrue(mainStack.contains("java.lang.Thread.sleep"))
        assertTrue(mainStack.contains("android.app.Activity.performCreate"))

        assertEquals(1, event.field("otherThreadCount")?.jsonPrimitive?.content?.toInt())
    }

    // -- AC2: a crash names its exception class ------------------------------

    @Test
    fun `a crash's description, with the exception class in it, reaches the event redacted`() {
        // QA round 1: deleting the description line left the suite green.
        // Android puts the exception class in the record's description for
        // REASON_CRASH; the event must carry it, through the same redaction
        // as everything else (the message half of a description can carry
        // a URL with a query string, so the URL rule applies here too).
        val ring = EventRing()
        val collector = ExitInfoCollector(
            ring,
            appPackages = listOf("com.example.shop."),
            historyProvider = {
                listOf(
                    ExitRecord(
                        timestamp = 11_000L,
                        reason = ApplicationExitInfo.REASON_CRASH,
                        importance = 100,
                        pss = 1,
                        rss = 1,
                        description = "java.lang.IllegalStateException: checkout failed for https://api.example.com/cart?token=abc",
                    ),
                )
            },
        )

        collector.install(app)

        val event = exitEvents(ring).single()
        val description = event.field("description")?.jsonPrimitive?.content
            ?: error("expected a description field on a REASON_CRASH exit event")
        assertTrue(
            "expected the exception class in the description, got: $description",
            description.startsWith("java.lang.IllegalStateException"),
        )
        assertTrue("expected the query-string value starred, got: $description", !description.contains("token=abc"))
    }

    // -- redaction of the thread name -----------------------------------------

    @Test
    fun `a thread named with a query-string URL comes out with the value starred`() {
        val ring = EventRing()
        val collector = ExitInfoCollector(
            ring,
            historyProvider = {
                listOf(
                    ExitRecord(
                        timestamp = 4_200L,
                        reason = ApplicationExitInfo.REASON_ANR,
                        importance = 100,
                        pss = 1,
                        rss = 1,
                        traceInputStream = { ByteArrayInputStream(ANR_TRACE.toByteArray()) },
                    ),
                )
            },
        )
        collector.install(app)

        val result = collector.trace(4_200L)
        assertTrue(result.found)
        val text = result.text ?: error("expected trace text")
        assertTrue(
            "expected the token value starred, got: $text",
            text.contains("OkHttp https://api.example.com/x?token=*"),
        )
        assertFalse("the raw secret must not survive redaction", text.contains("token=abc"))
    }

    // -- cap on the full blob --------------------------------------------------

    @Test
    fun `the full trace is capped at 256 KB with a truncation note`() {
        val huge = "\"main\" prio=5 tid=1 Native\n" +
            (1..40_000).joinToString("\n") { "  at com.example.shop.Foo.bar(Foo.kt:$it)" }
        assertTrue(huge.length > 256 * 1024)

        val ring = EventRing()
        val collector = ExitInfoCollector(
            ring,
            historyProvider = {
                listOf(
                    ExitRecord(
                        timestamp = 7_700L,
                        reason = ApplicationExitInfo.REASON_CRASH_NATIVE,
                        importance = 100,
                        pss = 1,
                        rss = 1,
                        traceInputStream = { ByteArrayInputStream(huge.toByteArray()) },
                    ),
                )
            },
        )
        collector.install(app)

        val result = collector.trace(7_700L)
        assertTrue(result.found)
        assertTrue(result.truncated)
        val text = result.text ?: error("expected trace text")
        assertTrue(text.length <= 256 * 1024 + 200)
        assertTrue(text.contains("truncated"))
    }

    // -- self-check (a): the collector with an empty history -------------------

    @Test
    fun `trace on an empty history says there was no such exit`() {
        val ring = EventRing()
        val collector = ExitInfoCollector(ring, historyProvider = { emptyList() })
        collector.install(app)

        val result = collector.trace(123L)
        assertFalse(result.found)
        assertNull(result.text)
        assertEquals("no exit recorded for timestamp 123", result.error)
    }

    // -- self-check (a): a record whose trace stream is null -------------------

    @Test
    fun `trace on a reason that never carries a blob says so, distinctly from an unknown timestamp`() {
        val ring = EventRing()
        val collector = ExitInfoCollector(
            ring,
            historyProvider = {
                listOf(
                    ExitRecord(
                        timestamp = 55L,
                        reason = ApplicationExitInfo.REASON_CRASH,
                        importance = 100,
                        pss = 1,
                        rss = 1,
                        traceInputStream = null,
                    ),
                )
            },
        )
        collector.install(app)

        val result = collector.trace(55L)
        assertFalse(result.found)
        assertNull(result.text)
        assertEquals(
            "no trace blob for this exit (reason was REASON_CRASH; only REASON_ANR and REASON_CRASH_NATIVE carry one)",
            result.error,
        )

        // A timestamp this collector has never heard of at all is a
        // *different* fact and must say so differently, not just "not found".
        val unknown = collector.trace(56L)
        assertFalse(unknown.found)
        assertEquals("no exit recorded for timestamp 56", unknown.error)
    }

    // -- helpers ----------------------------------------------------------------

    private fun exitEvents(ring: EventRing): List<EventFrame> =
        ring.since(0, 1000).filter { it.event == "exit" }

    /** [EventFrame.data] is a bare `JsonElement`; every exit event is a `JsonObject` underneath. */
    private fun EventFrame.field(key: String) = (data as JsonObject)[key]

    private companion object {
        val ANR_TRACE = """
            "main" prio=5 tid=1 Native
              | group="main" sCount=1 dsCount=0 flags=1 obj=0x0 self=0x0
              | sysTid=100 nice=0 cgrp=default sched=0/0 handle=0x0
              | state=S schedstat=( 0 0 0 ) utm=0 stm=0 core=0 HZ=100
              | stack=0x0 stackSize=8188KB
              | held mutexes=
              native: #00 pc 00001234  /system/lib64/libc.so (nanosleep+123)
              at java.lang.Thread.sleep(Native Method)
              at java.lang.Thread.sleep(Thread.java:450)
              at com.example.shop.data.CartRepository.blockingLoad(CartRepository.kt:42)
              at com.example.shop.ui.CartViewModel.<init>(CartViewModel.kt:18)
              at android.app.Activity.performCreate(Activity.java:8000)

            "OkHttp https://api.example.com/x?token=abc" prio=5 tid=15 Waiting
              | group="main" sCount=1 dsCount=0 flags=1 obj=0x0 self=0x0
              at java.lang.Object.wait(Native Method)
              at java.lang.Object.wait(Object.java:442)
        """.trimIndent()
    }
}
