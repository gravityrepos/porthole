// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.transport

import android.util.Log
import live.gravitylabs.porthole.collect.Setup
import live.gravitylabs.porthole.store.EventRing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog
import java.net.InetAddress
import java.net.ServerSocket

/**
 * GRA-196: a bind failure used to be a `Log.w` with no queryable state at
 * all, and `Porthole.install`'s "installed on ..." line printed before the
 * bind (which happens on a background executor) had even been attempted -
 * so two Porthole apps on one device produced a log that confidently
 * claimed success for the one that lost the race.
 *
 * GRA-199: the default bind target moved from a loopback TCP port shared by
 * every app on the device to an abstract-namespace Unix socket keyed by
 * package name, so the collision these tests were originally written
 * against — two *different* apps wanting the same port — cannot happen on
 * the new default path at all; see the "by default" and "two instances of
 * the same package" tests below for what replaces it. The original
 * collision-retry story survives verbatim on the `legacyTcp = true` opt-out
 * (below), which restores the old `ServerSocket(port, ..., 127.0.0.1)` bind
 * exactly, collision included.
 *
 * These tests go straight at [PortholeSocketServer] rather than through
 * [live.gravitylabs.porthole.Porthole] - the bind result is a property of
 * the server itself, and `Porthole.install` in a real process would need a
 * real occupied port to exercise the same path, which is exactly what these
 * tests set up directly with a plain [ServerSocket]/[LocalServerSocket].
 * Robolectric only for `android.util.Log` and (GRA-199) `android.net.LocalSocket`'s
 * family, the same reason [live.gravitylabs.porthole.collect.LogCollectorTest]
 * needs it for `Log` - a plain JVM test throws the moment anything here calls
 * an Android class with no pure-Java equivalent.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class PortholeSocketServerBindTest {

    private val packageName = "com.example.shop"

    // -- legacyTcp = true: the pre-GRA-199 collision, verbatim --------------

    @Test
    fun `legacyTcp - a port already held for the whole retry window is reported as an error, with the state to match`() {
        val port = freePort()
        val holder = ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))
        ShadowLog.clear()
        try {
            val ring = EventRing()
            val server = PortholeSocketServer(port, ring, packageName = packageName, legacyTcp = true)

            server.start()
            // Five attempts, 500ms apart: the whole retry window is ~2s: give
            // it real headroom rather than trying to land exactly on it.
            awaitTrue(6_000) { !server.listening && server.listeningFailure != null }

            assertFalse("expected the server to report it is not listening", server.listening)
            val failure = server.listeningFailure
                ?: error("expected a listeningFailure message once every retry was exhausted")
            assertTrue("expected the port named in the failure, got: $failure", failure.contains(port.toString()))
            assertTrue(
                "expected this app's own package named in the failure, got: $failure",
                failure.contains(packageName),
            )
            assertTrue(
                "expected EADDRINUSE named for a genuinely occupied port, got: $failure",
                failure.contains("EADDRINUSE"),
            )
            assertTrue(
                "expected the one-line remedy in the failure, got: $failure",
                failure.contains("port.set"),
            )
            assertEquals(5, server.bindAttempts)

            // The log is error-level, fired exactly once (not once per
            // attempt), and keeps the throwable - the three properties the
            // ticket asks for and the ones the mutations below each remove
            // one at a time.
            val errorLogs = ShadowLog.getLogsForTag("Porthole").filter { it.type == Log.ERROR }
            assertEquals("expected exactly one error-level log line", 1, errorLogs.size)
            val errorLog = errorLogs.single()
            assertTrue(errorLog.msg.contains("EADDRINUSE"))
            assertNotNull("expected the throwable to survive onto the log line", errorLog.throwable)

            server.stop()
        } finally {
            holder.close()
        }
    }

    @Test
    fun `legacyTcp - releasing the port before the retries run out lets the server bind, and says how many attempts it took`() {
        val port = freePort()
        val holder = ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))
        val ring = EventRing()
        val server = PortholeSocketServer(port, ring, packageName = packageName, legacyTcp = true)

        try {
            server.start()
            // The retry sleeps 500ms between attempts; releasing partway
            // through the window (well before the 5th attempt) proves the
            // retry itself, not just that a free port binds on attempt 1.
            Thread.sleep(700)
            holder.close()

            awaitTrue(6_000) { server.listening }

            assertTrue("expected the server to end up listening", server.listening)
            assertNull("a successful bind must clear any failure message", server.listeningFailure)
            assertTrue(
                "expected more than one bind attempt - got ${server.bindAttempts}, which would mean " +
                    "the retry was never exercised",
                server.bindAttempts > 1,
            )

            // Setup.report() is the queryable fact for the case that matters:
            // a retry that succeeded is still worth a later connection
            // knowing about, even though nothing failed in the end.
            val socketEntry = Setup.report().singleOrNull { it.name == "socket" }
                ?: error("expected a `socket` entry once a bind has settled")
            assertTrue(socketEntry.instrumented)
            val hint = socketEntry.hint
                ?: error("expected a hint noting the retry on a socket that needed more than one attempt")
            assertTrue(hint.contains(server.bindAttempts.toString()))

            server.stop()
        } finally {
            runCatching { holder.close() }
        }
    }

    @Test
    fun `legacyTcp - a malformed port fails for its own reason, not misreported as EADDRINUSE`() {
        val ring = EventRing()
        // Out of the valid 0-65535 range: ServerSocket's own constructor
        // throws IllegalArgumentException synchronously, before any socket
        // syscall happens at all - a different failure shape than a taken
        // port, and the message must not claim the wrong one.
        val server = PortholeSocketServer(70_000, ring, packageName = packageName, legacyTcp = true)

        server.start()
        awaitTrue(6_000) { !server.listening && server.listeningFailure != null }

        val failure = server.listeningFailure ?: error("expected a listeningFailure message")
        assertFalse("a malformed port is not an address-in-use failure: $failure", failure.contains("EADDRINUSE"))
        assertTrue(
            "expected the real exception class named instead, got: $failure",
            failure.contains("IllegalArgumentException"),
        )
        server.stop()
    }

    // -- the GRA-199 default: an abstract socket keyed by package -----------
    //
    // `android.net.LocalServerSocket` itself cannot be exercised from this
    // JVM test at all - confirmed by trying it, not assumed: Robolectric
    // ships no shadow for it (no `ShadowLocalServerSocket` anywhere in
    // shadows-framework, unlike `ServerSocket`), and its real implementation
    // reaches a native method with no host backing, so
    // `LocalServerSocket("x")` under this same Robolectric config throws
    // `IOException: socket not created` unconditionally, success or failure,
    // package name irrelevant. [PortholeSocketServer.bindOnce] exists for
    // exactly this: it separates "what bindWithRetry does with a bind
    // result" (the retry count, the two message shapes, the Setup
    // recording, the log lines) from "how a socket is actually bound",
    // so the former is fully testable here with a fake, and the latter is
    // proved the only way it can be - on a real device or emulator. This
    // ticket's own report records that run.

    @Test
    fun `by default a successful bind names the abstract socket, not a TCP port, in its log line`() {
        val ring = EventRing()
        val port = freePort()
        ShadowLog.clear()
        val server = PortholeSocketServer(
            port,
            ring,
            packageName = packageName,
            bindOnce = { TcpBoundServer(ServerSocket(0)) }, // stands in for a real LocalServerSocket bind
        )

        try {
            server.start()
            awaitTrue(6_000) { server.listening }
            assertTrue("expected the fake bind to succeed", server.listening)
            assertNull(server.listeningFailure)
            assertEquals(1, server.bindAttempts)

            // `listening` flips true, on the io thread, in the statement
            // right before Log.i is called - a volatile write's
            // happens-before guarantee covers what came before it in program
            // order, not what comes after, so a poll on `listening` alone can
            // observe it true a moment before the log line actually lands.
            // Poll for the log line itself rather than adding a fixed sleep.
            awaitTrue(6_000) { ShadowLog.getLogsForTag("Porthole").any { it.type == Log.INFO && it.msg.startsWith("listening on") } }
            val infoLogs = ShadowLog.getLogsForTag("Porthole").filter { it.type == Log.INFO }
            val listeningLog = infoLogs.singleOrNull { it.msg.startsWith("listening on") }
                ?: error("expected exactly one 'listening on ...' info log, got: $infoLogs")
            assertTrue(
                "expected the abstract socket named, not a TCP port, got: ${listeningLog.msg}",
                listeningLog.msg.contains("localabstract:porthole.$packageName"),
            )
        } finally {
            server.stop()
        }
    }

    @Test
    fun `by default, exhausting the retries reports the same-app explanation instead of GRA-196's port-collision one`() {
        val port = freePort()
        ShadowLog.clear()
        val ring = EventRing()
        val server = PortholeSocketServer(
            port,
            ring,
            packageName = packageName,
            // Every attempt fails - the same exception shape the real
            // LocalServerSocket bind throws under this Robolectric config
            // (see the section comment above), so the reason-detection
            // branch this test exercises is the one an emulator/device run
            // could actually reach too, not a fabricated one.
            bindOnce = { throw java.io.IOException("socket not created") },
        )

        server.start()
        awaitTrue(6_000) { !server.listening && server.listeningFailure != null }

        assertFalse("expected the server to report it is not listening", server.listening)
        val failure = server.listeningFailure
            ?: error("expected a listeningFailure message once every retry was exhausted")
        assertTrue(
            "expected the abstract socket name in the failure, got: $failure",
            failure.contains("localabstract:porthole.$packageName"),
        )
        assertTrue(
            "expected this app's own package named in the failure, got: $failure",
            failure.contains(packageName),
        )
        // GRA-199: the abstract socket is keyed by package, so a collision
        // here can only mean another process of this SAME app - two
        // processes, or a reinstall whose old process has not yet let go -
        // never a *different* Porthole app, which is exactly the case this
        // ticket removes. The message must say that, not repeat GRA-196's
        // now-inapplicable "another app ... porthole { port.set(...) }"
        // advice, which described moving the *host* port and never applied
        // to a same-package collision even before this ticket.
        assertTrue(
            "expected the same-app explanation, got: $failure",
            failure.contains("same app"),
        )
        assertFalse(
            "a same-package collision is not fixed by moving the host port, so the old remedy must not appear: $failure",
            failure.contains("port.set"),
        )
        assertEquals(5, server.bindAttempts)

        val socketEntry = Setup.report().singleOrNull { it.name == "socket" }
            ?: error("expected a `socket` entry once a bind has settled")
        assertFalse("a failed bind must not be reported as instrumented", socketEntry.instrumented)

        server.stop()
    }

    // -- helpers -------------------------------------------------------------

    private fun freePort(): Int = ServerSocket(0).use { it.localPort }

    private fun awaitTrue(timeoutMs: Long, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(20)
        }
        if (!condition()) fail("condition not met within ${timeoutMs}ms")
    }
}
