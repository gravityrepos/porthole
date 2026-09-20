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

    private fun collector(ring: EventRing) = StrictModeCollector(ring, appPackages)

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

    // -- counting: a flood at one call site is not a flood on the wire -------

    @Test
    fun `two hundred violations at one call site produce far fewer than two hundred events`() {
        val ring = EventRing()
        val c = collector(ring)
        repeat(200) {
            val violation = DiskWriteViolation().apply {
                stackTrace = arrayOf(frame("com.example.app.CartAdapter", "onBindViewHolder", 88))
            }
            c.onViolation(violation, fromThreadPolicy = true)
        }

        val counts = strictEvents(ring).map { it.field("count").content.toInt() }
        // Emitted at 1 (first sighting) and every 50th occurrence after that —
        // see StrictModeCollector.onViolation's own comment for why a count-based
        // cap rather than a wall-clock interval. 5 events, not 200, and the last
        // one's count is the true, exact total: nothing was ever dropped, only
        // the *reporting* of it was throttled.
        assertEquals(listOf(1, 50, 100, 150, 200), counts)
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
        c.onViolation(violationAt("a"), fromThreadPolicy = true) // 2nd at "a" — below the update cap, no new event

        val sites = strictEvents(ring).map { it.field("site").content }
        assertEquals(
            "one event per site's first sighting; a site's own repeat before the update cap must not spam a second site's count",
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

        val ok = c.install(app)

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

        assertTrue(c.install(app))
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

        assertTrue(c.install(app))
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
