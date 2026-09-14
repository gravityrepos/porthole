// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import java.lang.reflect.Method
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Porthole.install()/shutdown() through a real Application, which is the only
 * place the leaks GRA-86 is about are visible at all. Every one of them - a
 * thread that outlives the session, a BroadcastReceiver or a
 * ActivityLifecycleCallbacks nothing ever unregisters - is a property of the
 * real Android framework's own bookkeeping, not of this module's, so a plain
 * JVM test double could not have shown any of this. Robolectric is what
 * makes `app.registerActivityLifecycleCallbacks` and
 * `ConnectivityManager.registerDefaultNetworkCallback` real enough to ask
 * afterwards whether they were undone.
 *
 * Pinned to API 35 rather than whatever Robolectric would otherwise default
 * to without a manifest (targetSdkVersion is what it reads that from, and
 * this module - a library with no Application of its own - has none for a
 * unit test to pick up): DeviceCollector reads Configuration.getLocales(),
 * added in API 24, and a too-old default framework jar fails that call
 * before install() ever reaches the code this test is about.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class ShutdownTest {

    private val app: Application get() = RuntimeEnvironment.getApplication()

    // -- no porthole-* thread survives shutdown ------------------------------

    @Test
    fun `shutdown leaves no porthole thread alive`() {
        // A LogCollector thread from a *previous* test method in this class can
        // still be mid-exit here: on a host with no real `logcat` on PATH,
        // ProcessBuilder has to fail twice before the thread's run() returns,
        // and on Windows that failure is a synchronous CreateProcess call that
        // is not free - it can cost real wall-clock time searching PATH, and
        // Thread.interrupt() (what stop() sends it) cannot reach in and cut
        // that short because the thread is blocked in native process-launch
        // code, not in an interruptible wait. JUnit reuses one JVM across the
        // methods in this class, so that straggler is a real thread this
        // process still owns, just not proof of a leak - a leak is one still
        // alive after a wait, not one caught between two check-ins. Polling
        // here is the same tolerance already given below to shutdown()'s own
        // cleanup, applied to whatever the previous test handed off.
        awaitTrue(2_000) { !hasPortholeThread() }
        assertNoPortholeThread("before anything ran")

        Porthole.install(app, port = 0)
        // Proves the test isn't vacuous: something with a porthole-* thread
        // actually started. MemoryCollector's sampler and MainThreadWatchdog's
        // loop both name themselves this way.
        awaitTrue(2_000) { hasPortholeThread() }

        Porthole.shutdown()
        awaitTrue(2_000) { !hasPortholeThread() }
        assertNoPortholeThread("after shutdown")
    }

    // -- ten install/shutdown cycles change nothing net ----------------------

    @Test
    fun `ten install-shutdown cycles leave receiver and callback counts where they started`() {
        val baselineReceivers = shadowOf(app).registeredReceivers.size
        val baselineLifecycle = activityLifecycleCallbackCount(app)
        val baselineComponent = componentCallbackCount(app)
        val connectivity = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        val baselineNetworkCallbacks = connectivity?.let { shadowOf(it).networkCallbacks.size } ?: 0

        // Compose's own bookkeeping, not Robolectric's - SnapshotWatcher calls
        // Snapshot.registerApplyObserver, which appends to this static list on
        // androidx.compose.runtime.snapshots.SnapshotKt and never shrinks it
        // back down on its own. Deleting `s.snapshots.stop()` from
        // Porthole.shutdown() (mutation M09) left every existing test green
        // because nothing here read this list; ten cycles with the line
        // removed take it from 1 to 11, one orphaned observer per install.
        val observersField = Class.forName("androidx.compose.runtime.snapshots.SnapshotKt")
            .getDeclaredField("applyObservers")
            .apply { isAccessible = true }
        val baselineObservers = (observersField.get(null) as Collection<*>).size

        repeat(10) {
            Porthole.install(app, port = 0)
            Porthole.shutdown()
        }

        assertEquals(
            "registered BroadcastReceivers",
            baselineReceivers,
            shadowOf(app).registeredReceivers.size,
        )
        assertEquals(
            "registered ActivityLifecycleCallbacks",
            baselineLifecycle,
            activityLifecycleCallbackCount(app),
        )
        assertEquals(
            "registered ComponentCallbacks2",
            baselineComponent,
            componentCallbackCount(app),
        )
        if (connectivity != null) {
            assertEquals(
                "registered ConnectivityManager.NetworkCallbacks",
                baselineNetworkCallbacks,
                shadowOf(connectivity).networkCallbacks.size,
            )
        }
        assertEquals(
            "Compose Snapshot apply observers",
            baselineObservers,
            (observersField.get(null) as Collection<*>).size,
        )
    }

    // -- every collector with a start has a matching stop, and shutdown()
    //    is genuinely safe to call twice - not just at the outer guard ------

    @Test
    fun `every stoppable field on the session tolerates a second stop`() {
        Porthole.install(app, port = 0)
        val session = currentSessionOrNull()
            ?: error("Porthole.install did not leave a session behind")

        // Walking Session's declared fields, rather than naming the
        // collectors here, is the point: a collector added to Session later
        // that grows a stop() shows up in this list automatically, instead of
        // depending on this test file being updated in step with Porthole.kt.
        val stoppable = sessionFields(session).filterValues { it != null && stopMethod(it) != null }

        // A collector-shaped field with no stop() at all (EventRing, the app
        // reference, primitives) is expected and fine; a Session that ended up
        // with *none* that have one is not - it would mean this test checked
        // nothing.
        assertTrue(
            "expected at least 3 stoppable fields on Session (memory, deviceContext, " +
                "autoWire are the ones this ticket added); found: ${stoppable.keys}",
            stoppable.size >= 3,
        )

        Porthole.shutdown()

        // shutdown() has already called each of these once, above. Calling
        // Porthole.shutdown() itself a second time would not add coverage
        // here: the second call returns at the session == null guard before
        // touching a single collector. Actually exercising "safe to call
        // twice" for each collector means calling its stop() a second time
        // directly, which is what this loop does.
        stoppable.forEach { (name, value) ->
            val method = stopMethod(value!!)!!
            try {
                if (method.parameterCount == 0) method.invoke(value) else method.invoke(value, app)
            } catch (e: Exception) {
                fail("$name.${method.name}() threw on a second call: ${e.cause ?: e}")
            }
        }
    }

    // -- a field that starts something is required to be able to stop it,
    //    structurally - independent of whether shutdown() remembers to call
    //    it, which `every stoppable field...` above already covers ----------

    @Test
    fun `every session field with a start or install has a matching stop`() {
        Porthole.install(app, port = 0)
        val session = currentSessionOrNull()
            ?: error("Porthole.install did not leave a session behind")
        Porthole.shutdown()

        // The failure mode this ticket is about was never "shutdown() forgot
        // a line" in the abstract - it was "a collector that owns a thread, a
        // receiver or a callback has nowhere on it that undoes that." A field
        // whose class declares a no-arg start() or an install(...) is exactly
        // that shape, on the same naming convention every collector in this
        // file already follows. Requiring a stop() to exist is a lower bar
        // than requiring shutdown() to call it correctly - `every stoppable
        // field...` above is what checks that - but it is the one a class
        // added to Session later cannot forget without this test naming it,
        // which is the point: nobody has to remember to update this file.
        val startsSomethingButCannotBeStopped = sessionFields(session)
            .filterValues { it != null && looksLikeALifecycle(it) && stopMethod(it) == null }
            .keys

        assertTrue(
            "Session field(s) $startsSomethingButCannotBeStopped declare a start() or " +
                "install(...) but no stop() at all - add one and call it from " +
                "Porthole.shutdown(), the same shape as memory/deviceContext/autoWire.",
            startsSomethingButCannotBeStopped.isEmpty(),
        )
    }

    private fun looksLikeALifecycle(value: Any): Boolean =
        value.javaClass.methods.any { m ->
            (m.name == "start" && m.parameterCount == 0) ||
                (m.name == "install" && m.parameterCount >= 1)
        }

    // -- the reported collector list is the real one, not a placeholder -----

    @Test
    fun `install reports the collectors that actually started`() {
        // Session(collectors = emptyList()) would leave every other test in
        // this suite green - nothing here previously read the `hello`
        // payload's `collectors` field back. Building `finalCollectors` before
        // Session exists (see the comment at that call site in Porthole.kt)
        // removed a real hazard - a later reordering silently reading the
        // list before every append had happened - but nothing asserted the
        // content, so a regression that handed Session an empty list outright
        // would have passed too.
        Porthole.install(app, port = 0)
        try {
            val session = currentSessionOrNull() ?: error("Porthole.install did not leave a session behind")
            @Suppress("UNCHECKED_CAST")
            val collectors = sessionFields(session)["collectors"] as? List<String>
                ?: error("Session.collectors was not a List<String>")

            assertTrue(
                "expected install() to report the collectors it actually started; got: $collectors",
                collectors.containsAll(
                    listOf("recompositions", "semantics_tree", "state", "inflight", "logs", "memory"),
                ),
            )
        } finally {
            Porthole.shutdown()
        }
    }

    // -- the one leak this Windows host cannot show on its own ---------------

    @Test
    fun `shutdown destroys a still-running log capture process`() {
        // On this host `logcat` does not exist, so LogCollector's own two
        // spawn attempts fail within milliseconds and its reader thread exits
        // on its own whether or not stop() ever runs - which is exactly why
        // deleting `s.logs.stop()` from Porthole.kt (mutation M05) left every
        // test in this file green. On a device, logcat is a real process
        // whose stdout pipe blocks the reader thread in a native read that
        // Thread.interrupt() cannot reach; only process.destroy() ends it.
        //
        // `findstr` with a pattern that can never match reproduces that
        // shape without a device: it blocks reading its own stdin and writes
        // nothing to stdout while it waits, so it is a real, still-running
        // process exactly like an unread logcat pipe. Swapping it into the
        // real Session's real LogCollector - the same reflection this file
        // already uses on Session's own fields - and then calling the real
        // Porthole.shutdown() is what proves the production call chain
        // (`s.logs.stop()` -> `process?.destroy()`) actually reaches it,
        // rather than testing LogCollector in isolation.
        val stub = runCatching {
            ProcessBuilder("findstr", "zzz_this_pattern_never_matches_zzz").start()
        }.getOrNull()
        assumeTrue("findstr is not available on this host", stub != null)
        val process = stub!!

        try {
            Porthole.install(app, port = 0)
            val session = currentSessionOrNull() ?: error("Porthole.install did not leave a session behind")
            val logs = sessionFields(session)["logs"] ?: error("Session has no `logs` field")
            setPrivateField(logs, "process", process)

            assertTrue("expected the stub process to still be running", process.isAlive)

            Porthole.shutdown()

            assertTrue(
                "shutdown() should have destroyed the process s.logs.stop() was holding",
                process.waitFor(5, TimeUnit.SECONDS),
            )
            assertFalse(process.isAlive)
        } finally {
            runCatching { process.destroyForcibly() }
        }
    }

    private fun setPrivateField(target: Any, name: String, value: Any?) {
        var klass: Class<*>? = target.javaClass
        while (klass != null) {
            try {
                val field = klass.getDeclaredField(name)
                field.isAccessible = true
                field.set(target, value)
                return
            } catch (_: NoSuchFieldException) {
                klass = klass.superclass
            }
        }
        error("could not find field `$name` on ${target.javaClass}")
    }

    // -- shutdown() is safe when there was never anything to shut down ------

    @Test
    fun `shutdown before any install does nothing and does not throw`() {
        Porthole.shutdown()
    }

    @Test
    fun `shutdown is safe to call twice in a row`() {
        Porthole.install(app, port = 0)
        Porthole.shutdown()
        Porthole.shutdown()
    }

    // -- a second install after a shutdown is a fresh, working session, not
    //    a no-op left over from some stale guard -----------------------------

    @Test
    fun `install after shutdown starts a working session again`() {
        Porthole.install(app, port = 0)
        awaitTrue(2_000) { hasPortholeThread() }
        Porthole.shutdown()
        awaitTrue(2_000) { !hasPortholeThread() }

        // If install() were silently failing the second time - session != null
        // left over from an incomplete shutdown, a static flag never reset, a
        // collector whose start() is not idempotent - this would time out
        // rather than pass, which is the failure this test exists to catch.
        Porthole.install(app, port = 0)
        awaitTrue(2_000) { hasPortholeThread() }
        val second = currentSessionOrNull()
        assertTrue("second install() left no session behind", second != null)

        Porthole.shutdown()
        awaitTrue(2_000) { !hasPortholeThread() }
    }

    // -- thread helpers -------------------------------------------------------

    private fun hasPortholeThread(): Boolean =
        Thread.getAllStackTraces().keys.any { it.isAlive && it.name.startsWith("porthole-") }

    private fun assertNoPortholeThread(whenDescription: String) {
        val survivors = Thread.getAllStackTraces().keys
            .filter { it.isAlive && it.name.startsWith("porthole-") }
            .map { it.name }
        assertTrue("expected no porthole-* thread $whenDescription, found: $survivors", survivors.isEmpty())
    }

    private fun awaitTrue(timeoutMs: Long, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(20)
        }
        if (!condition()) fail("condition not met within ${timeoutMs}ms")
    }

    // -- reflection over the private Session, and over Application's own
    //    bookkeeping - both are test-only, nothing here is part of the
    //    public API or a seam added to production code for this test's sake.

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

    private fun stopMethod(value: Any): Method? =
        value.javaClass.methods.firstOrNull { m ->
            m.name == "stop" &&
                (m.parameterCount == 0 ||
                    (m.parameterCount == 1 && m.parameterTypes[0] == Application::class.java))
        }

    /**
     * Application keeps these as plain private ArrayLists of its own - there
     * is no public count and no Robolectric shadow for either, so this reads
     * the real framework fields the same way the framework's own
     * register/unregister methods do.
     */
    private fun activityLifecycleCallbackCount(app: Application): Int =
        (fieldValue(app, "mActivityLifecycleCallbacks") as? Collection<*>)?.size
            ?: error("could not read Application.mActivityLifecycleCallbacks")

    /**
     * Since API 30, Application no longer keeps this list itself: it
     * delegates registerComponentCallbacks/unregisterComponentCallbacks to a
     * ComponentCallbacksController it holds (`mCallbacksController`), and the
     * controller is what actually owns the `mComponentCallbacks` ArrayList.
     * Reading `Application.mComponentCallbacks` directly - which is where it
     * lived before that split, and is still where a search of the framework
     * source or an old Stack Overflow answer says to look - throws instead of
     * silently returning the wrong count, which is what led here: the field
     * just is not on this class any more at API 35.
     */
    private fun componentCallbackCount(app: Application): Int {
        val controller = fieldValue(app, "mCallbacksController")
            ?: return (fieldValue(app, "mComponentCallbacks") as? Collection<*>)?.size
                ?: error("could not read Application.mComponentCallbacks")
        // The controller's own list starts out null - ComponentCallbacksController
        // allocates it lazily on the first ever registerCallbacks() - rather than
        // as an empty ArrayList, so a baseline read before anything has registered
        // sees null, not zero-but-present. Once something has registered and
        // unregistered, it is an empty ArrayList and stays that way, so treating
        // null as zero is what makes the "before" and "after" counts comparable
        // instead of the first read throwing on a perfectly normal fresh app.
        return when (val callbacks = fieldValue(controller, "mComponentCallbacks")) {
            null -> 0
            is Collection<*> -> callbacks.size
            else -> error("mComponentCallbacks was not a Collection: $callbacks")
        }
    }

    private fun fieldValue(target: Any, name: String): Any? {
        var klass: Class<*>? = target.javaClass
        while (klass != null) {
            try {
                val field = klass.getDeclaredField(name)
                field.isAccessible = true
                return field.get(target)
            } catch (_: NoSuchFieldException) {
                klass = klass.superclass
            }
        }
        return null
    }
}
