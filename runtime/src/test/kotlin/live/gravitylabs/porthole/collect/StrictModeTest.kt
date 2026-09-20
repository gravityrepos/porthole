// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.app.Application
import android.os.StrictMode
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import live.gravitylabs.porthole.Porthole
import live.gravitylabs.porthole.protocol.EventFrame
import live.gravitylabs.porthole.protocol.EventKinds
import live.gravitylabs.porthole.store.EventRing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * `StrictModeCollector` never trips a real `StrictMode` check — that would
 * mean asserting on whatever this specific JVM's disk and network happen to
 * do today, which is not a property of this class's own logic. Every test
 * here hands [StrictModeCollector.onViolation] a synthetic violation instead
 * (a plain `Throwable` with a hand-built stack trace — `onViolation` accepts
 * any `Throwable`, exactly so a test never has to reach for
 * `android.os.strictmode`'s own subclasses, whose constructors are
 * package-private): the collector's job starts the moment a `Violation`
 * object exists, and that is exactly where these tests start it.
 *
 * The filter — "a violation whose stack contains no frame from the app's own
 * package is not a finding" — is this ticket's actual deliverable (the EM's
 * own words), so it gets the first tests, ahead of counting and
 * classification.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class StrictModeTest {

    private val app: Application get() = RuntimeEnvironment.getApplication()

    private val appPackages = listOf("com.example.app.")

    /**
     * `onViolation` only ever reports a site's first sighting on its own;
     * every repeat is a `StrictModeCollector.flushPending()` call away —
     * scheduled in production, called directly here to simulate a tick
     * without a real timer (`StrictModeCollector.stop()` calls it once more,
     * synchronously, which is what a test calling `stop()` instead is
     * exercising). `now` is frozen unless a test supplies its own: nothing
     * here reads the clock to decide whether to report any more, only to
     * stamp the emitted event's own timestamp.
     */
    private fun collector(ring: EventRing, now: () -> Long = { 0L }) = StrictModeCollector(ring, appPackages, now)

    private fun strictEvents(ring: EventRing): List<EventFrame> =
        ring.since(0, 10_000).filter { it.event == EventKinds.STRICT_VIOLATION }

    private fun EventFrame.field(key: String) = (data as JsonObject).getValue(key).jsonPrimitive

    private fun frame(className: String, method: String, line: Int) =
        StackTraceElement(className, method, className.substringAfterLast('.') + ".kt", line)

    // -- the filter: no app frame, no finding, by construction ---------------

    @Test
    fun `a violation whose stack never touches the app's own package is dropped entirely`() {
        val ring = EventRing()
        val violation = DiskWriteViolation().apply {
            stackTrace = arrayOf(
                frame("android.database.sqlite.SQLiteConnection", "nativeExecute", 100),
                frame("android.app.SharedPreferencesImpl", "awaitLoadedLocked", 50),
            )
        }

        collector(ring).onViolation(violation, fromThreadPolicy = true)

        assertTrue(
            "a platform-only stack must not become a finding — that is what makes " +
                "'ordinary startup produces no false findings' true by construction",
            strictEvents(ring).isEmpty(),
        )
    }

    @Test
    fun `a violation with an app frame becomes one event naming the call site`() {
        val ring = EventRing()
        val violation = DiskWriteViolation().apply {
            stackTrace = arrayOf(
                frame("android.database.sqlite.SQLiteConnection", "nativeExecute", 100),
                frame("com.example.app.CartRepository", "loadCart", 42),
            )
        }

        collector(ring).onViolation(violation, fromThreadPolicy = true)

        val emitted = strictEvents(ring)
        assertEquals(1, emitted.size)
        val e = emitted[0]
        assertEquals("main_thread_disk", e.field("category").content)
        assertEquals("DiskWriteViolation", e.field("type").content)
        assertEquals("main", e.field("thread").content)
        assertEquals("com.example.app.CartRepository.loadCart:42", e.field("site").content)
        assertEquals(1, e.field("count").content.toInt())
        assertTrue(
            "expected the app frame first in the rendered stack, got: ${e.field("stack").content}",
            e.field("stack").content.startsWith("com.example.app.CartRepository.loadCart"),
        )
    }

    @Test
    fun `an empty app-packages list matches nothing, so nothing is ever a finding`() {
        val ring = EventRing()
        val violation = DiskWriteViolation().apply {
            stackTrace = arrayOf(frame("com.example.app.CartRepository", "loadCart", 42))
        }

        StrictModeCollector(ring, appPackages = emptyList()).onViolation(violation, fromThreadPolicy = true)

        assertTrue(strictEvents(ring).isEmpty())
    }

    // -- category mapping: what `findings`' severity reads ---------------------

    @Test
    fun `main-thread disk writes and network calls classify as the error-worthy categories`() {
        assertEquals("main_thread_disk", categoryOf(DiskWriteViolation(), fromThreadPolicy = true))
        assertEquals("main_thread_network", categoryOf(NetworkViolation(), fromThreadPolicy = true))
    }

    @Test
    fun `a disk write from the VM policy is not a main-thread category`() {
        // Shape-only: this project's own policy always installs the thread
        // policy from the main thread (Porthole.install() runs there), so a
        // DiskWriteViolation always arrives with fromThreadPolicy = true in
        // production. This pins the classifier's own rule for the case that
        // would otherwise be silently mislabelled if that ever changed.
        assertEquals("other", categoryOf(DiskWriteViolation(), fromThreadPolicy = false))
    }

    @Test
    fun `leaked closeables and sqlite cursors classify as leaks`() {
        assertEquals("leak", categoryOf(LeakedClosableViolation(), fromThreadPolicy = false))
        assertEquals("leak", categoryOf(SqliteObjectLeakedViolation(), fromThreadPolicy = false))
        assertEquals("leak", categoryOf(ServiceConnectionLeakedViolation(), fromThreadPolicy = false))
        assertEquals("leak", categoryOf(IntentReceiverLeakedViolation(), fromThreadPolicy = false))
    }

    @Test
    fun `everything else classifies as other`() {
        assertEquals("other", categoryOf(UntaggedSocketViolation(), fromThreadPolicy = false))
        assertEquals("other", categoryOf(FileUriExposedViolation(), fromThreadPolicy = false))
    }

    private fun categoryOf(violation: Throwable, fromThreadPolicy: Boolean): String {
        val ring = EventRing()
        violation.stackTrace = arrayOf(frame("com.example.app.Foo", "bar", 1))
        collector(ring).onViolation(violation, fromThreadPolicy)
        return strictEvents(ring).single().field("category").content
    }

    // -- counting: a flood at one call site is not a flood on the wire, and
    //    every count reported is the exact, current total — never stale --------
    //
    // GRA-59 QA fixup: the original design decided whether to report on its
    // own, per violation (first a count-based cap, `count == 1 || count % 50
    // == 0`; then an elapsed-time check at the moment each violation
    // arrived). Both share the same defect QA's repro exposed: a site that
    // stops violating stops getting calls into that decision at all, so six
    // taps on the sample produced one event (count 1) and then silence,
    // forever, in a live session that never calls stop(). The fix replaces
    // that decision with a real scheduler (StrictModeCollector.flushPending,
    // ticking on its own) — these tests call it directly to simulate a tick
    // without a real timer, and assert the *exact* final count rather than
    // an arbitrary schedule of checkpoints.

    @Test
    fun `QA repro - six violations at one site eventually report the exact count, not one`() {
        val ring = EventRing()
        val c = collector(ring)
        repeat(6) {
            val violation = DiskWriteViolation().apply {
                stackTrace = arrayOf(frame("com.example.app.CartViewModel", "triggerStrictModeViolation", 150))
            }
            c.onViolation(violation, fromThreadPolicy = true)
        }
        // The six taps happen "at once" on a frozen clock, so only the first
        // is reported live; stop()'s flush is what QA's repro was missing —
        // without it, the site really would go silent after count 1 forever.
        c.stop()

        assertEquals(listOf(1, 6), strictEvents(ring).map { it.field("count").content.toInt() })
    }

    @Test
    fun `seventy-three violations at one site eventually report the exact count, not fifty`() {
        val ring = EventRing()
        val c = collector(ring)
        repeat(73) {
            val violation = DiskWriteViolation().apply {
                stackTrace = arrayOf(frame("com.example.app.CartAdapter", "onBindViewHolder", 88))
            }
            c.onViolation(violation, fromThreadPolicy = true)
        }
        c.stop()

        assertEquals(listOf(1, 73), strictEvents(ring).map { it.field("count").content.toInt() })
    }

    @Test
    fun `two hundred violations at one call site still produce a handful of events, not two hundred`() {
        val ring = EventRing()
        val c = collector(ring) // frozen clock: nothing but the first hit can report during the burst itself
        repeat(200) {
            val violation = DiskWriteViolation().apply {
                stackTrace = arrayOf(frame("com.example.app.CartAdapter", "onBindViewHolder", 88))
            }
            c.onViolation(violation, fromThreadPolicy = true)
        }
        c.stop() // the burst is still "recent" when it ends; the flush is what carries the exact total

        // Two events for two hundred violations — not one per violation, and
        // the last one is the true, exact total: nothing was ever dropped,
        // only the *reporting* of it was throttled while the burst was live.
        assertEquals(listOf(1, 200), strictEvents(ring).map { it.field("count").content.toInt() })
    }

    @Test
    fun `a scheduled tick reports the exact count live — no stop() needed`() {
        // The heart of the QA fixup: a session that never calls stop() — the
        // ordinary case, since an app keeps running — still gets an accurate
        // count while it is still live, because flushPending() is on its own
        // schedule (production: a real ScheduledExecutorService tick, every
        // UPDATE_INTERVAL_MS) rather than being triggered by the next
        // violation, which might never come.
        val ring = EventRing()
        val c = collector(ring)
        val violation = DiskWriteViolation().apply {
            stackTrace = arrayOf(frame("com.example.app.Foo", "bar", 1))
        }

        c.onViolation(violation, fromThreadPolicy = true) // count 1, reports immediately
        repeat(4) {
            c.onViolation(
                DiskWriteViolation().apply { stackTrace = arrayOf(frame("com.example.app.Foo", "bar", 1)) },
                fromThreadPolicy = true,
            )
        } // counts 2..5, none reported yet — no flush has run

        c.flushPending() // simulates one scheduled tick

        assertEquals(
            "a scheduled tick reports the exact count without the session ever stopping",
            listOf(1, 5),
            strictEvents(ring).map { it.field("count").content.toInt() },
        )

        // A second tick with nothing new pending is a no-op, not a repeat report.
        c.flushPending()
        assertEquals(listOf(1, 5), strictEvents(ring).map { it.field("count").content.toInt() })
    }

    @Test
    fun `two different call sites are counted independently, each reporting its own first sighting`() {
        val ring = EventRing()
        val c = collector(ring)
        fun violationAt(method: String) = DiskWriteViolation().apply {
            stackTrace = arrayOf(frame("com.example.app.Foo", method, 1))
        }

        c.onViolation(violationAt("a"), fromThreadPolicy = true)
        c.onViolation(violationAt("b"), fromThreadPolicy = true)
        c.onViolation(violationAt("a"), fromThreadPolicy = true) // 2nd at "a" — no flush has run, no new event yet

        val sites = strictEvents(ring).map { it.field("site").content }
        assertEquals(
            "one event per site's first sighting; a site's own repeat before the next flush must not spam a second site's count",
            listOf("com.example.app.Foo.a:1", "com.example.app.Foo.b:1"),
            sites,
        )
    }

    // -- redaction: the same path as everything else --------------------------

    @Test
    fun `the violation's own message is redacted the same way every url elsewhere in this codebase is`() {
        val ring = EventRing()
        val violation = CustomViolation("exposed content:// lookup: http://h/x?token=hunter2")
        violation.stackTrace = arrayOf(frame("com.example.app.ShareHelper", "share", 12))

        collector(ring).onViolation(violation, fromThreadPolicy = false)

        val stack = strictEvents(ring).single().field("stack").content
        assertTrue("expected the token name kept but the value starred, got: $stack", stack.contains("token=*"))
        assertFalse("expected the token value gone, got: $stack", stack.contains("hunter2"))
    }

    // -- API floor: below 28, install() does nothing at all -------------------

    @Test
    @Config(sdk = [27])
    fun `below API 28 install does nothing and reports it did nothing`() {
        val ring = EventRing()
        val c = collector(ring)
        // ThreadPolicy has no equals() and getThreadPolicy() hands back a
        // fresh instance every call, so reference equality can never hold —
        // toString() is the one public surface that reflects the policy's
        // actual flags (it prints the mask), which is the "no policy change"
        // this test is actually about.
        val before = StrictMode.getThreadPolicy().toString()

        val ok = c.install()

        assertFalse("no penaltyListener exists below API 28 — no logcat-scraping fallback", ok)
        assertFalse(c.installed)
        assertEquals(
            "install() must not touch the thread policy at all when it cannot use a listener",
            before,
            StrictMode.getThreadPolicy().toString(),
        )
    }

    // -- stop() restores what was there before, not a blank policy -----------

    @Test
    fun `stop restores the thread and VM policies install replaced`() {
        val ring = EventRing()
        val c = collector(ring)
        // See the API-28 test above for why this compares toString() rather
        // than reference identity.
        val threadBefore = StrictMode.getThreadPolicy().toString()
        val vmBefore = StrictMode.getVmPolicy().toString()

        assertTrue(c.install())
        assertTrue(c.installed)

        c.stop()

        assertFalse(c.installed)
        assertEquals(threadBefore, StrictMode.getThreadPolicy().toString())
        assertEquals(vmBefore, StrictMode.getVmPolicy().toString())
    }

    @Test
    fun `stop is safe to call twice, and safe when install was never called`() {
        val ring = EventRing()
        val c = collector(ring)
        c.stop()
        c.stop()

        assertTrue(c.install())
        c.stop()
        c.stop()
    }

    // -- wired into Porthole.install(): off by default installs nothing at all,
    //    and Setup's `strictmode` entry always exists and says the right thing --
    //
    // The `porthole_strict_mode` resValue only ever exists in a real consuming
    // app (the Gradle plugin writes it into the app module, not into this
    // library's own build) — the same reason RingCapacityTest tests
    // Porthole.sanitizeRingCapacity() directly rather than faking a resource
    // for the ring capacity's own resValue. So "the flag is on" is StrictModeTest's
    // job above, exercised directly against StrictModeCollector; what belongs
    // here is the one thing only Porthole.install() itself can prove: that
    // *without* the resource — every test in this suite's own build, and every
    // app until it opts in — nothing touches StrictMode's policy at all.

    @Test
    fun `strictMode off by default - Porthole install does not touch StrictMode's policy at all`() {
        val threadBefore = StrictMode.getThreadPolicy().toString()
        val vmBefore = StrictMode.getVmPolicy().toString()

        Porthole.install(app, port = 0)
        try {
            assertEquals(
                "no porthole_strict_mode resource exists in this module's own build, so this must read as off",
                threadBefore,
                StrictMode.getThreadPolicy().toString(),
            )
            assertEquals(vmBefore, StrictMode.getVmPolicy().toString())
        } finally {
            Porthole.shutdown()
        }
    }

    @Test
    fun `setup always has an opinion about strict mode, even off`() {
        Porthole.install(app, port = 0)
        try {
            val entry = Setup.report().single { it.name == "strictmode" }
            assertFalse("off by default", entry.instrumented)
            assertTrue(
                "expected the off-by-default hint to point at the opt-in, got: ${entry.hint}",
                entry.hint.orEmpty().contains("strictMode.set(true)"),
            )
        } finally {
            Porthole.shutdown()
        }
    }

    @Test
    fun `Setup reports a replacement, not a chain, when strict mode is on`() {
        // Exercises Setup.recordStrictMode directly, the same way the "off by
        // default" case above exercises it indirectly through Porthole.install
        // — this is the shape Porthole.install actually calls it with when the
        // resource says on, see that method's own `note` string.
        Setup.recordStrictMode(
            installed = true,
            note = "Porthole's StrictMode thread and VM policies REPLACED whatever this process had",
        )
        val entry = Setup.report().single { it.name == "strictmode" }
        assertTrue(entry.instrumented)
        assertTrue(
            "the EM was explicit: say REPLACED, not chained — got: ${entry.hint}",
            entry.hint.orEmpty().contains("REPLACED"),
        )
    }
}

// ---------------------------------------------------------------------------
// synthetic violations
// ---------------------------------------------------------------------------
//
// android.os.strictmode's real classes (DiskWriteViolation, NetworkViolation,
// ...) have package-private constructors — only StrictMode itself can build
// one, which is exactly the point: a violation is supposed to come from a
// real check tripping, not from test code. StrictModeCollector.onViolation
// takes a plain Throwable for precisely this reason, so a test can hand it
// something *shaped* like a violation — same simple class name, a hand-built
// stack trace, an optional message — without reaching for reflection or a
// same-package trick to construct the real thing. categoryOf() only ever
// reads javaClass.simpleName, which these match exactly.

private class DiskWriteViolation(message: String? = null) : Throwable(message)
private class NetworkViolation(message: String? = null) : Throwable(message)
private class LeakedClosableViolation(message: String? = null) : Throwable(message)
private class SqliteObjectLeakedViolation(message: String? = null) : Throwable(message)
private class ServiceConnectionLeakedViolation(message: String? = null) : Throwable(message)
private class IntentReceiverLeakedViolation(message: String? = null) : Throwable(message)
private class UntaggedSocketViolation(message: String? = null) : Throwable(message)
private class FileUriExposedViolation(message: String? = null) : Throwable(message)
private class CustomViolation(message: String? = null) : Throwable(message)
