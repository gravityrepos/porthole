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
 * These tests go straight at [PortholeSocketServer] rather than through
 * [live.gravitylabs.porthole.Porthole] - the bind result is a property of
 * the server itself, and `Porthole.install` in a real process would need a
 * real occupied port to exercise the same path, which is exactly what these
 * tests set up directly with a plain [ServerSocket]. Robolectric only for
 * `android.util.Log`, the same reason [live.gravitylabs.porthole.collect.LogCollectorTest]
 * needs it - a plain JVM test throws the moment anything here calls `Log.*`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class PortholeSocketServerBindTest {

    private val packageName = "com.example.shop"

    // -- a genuinely occupied port fails loudly, with the state to prove it -

    @Test
    fun `a port already held for the whole retry window is reported as an error, with the state to match`() {
        val port = freePort()
        val holder = ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))
        ShadowLog.clear()
        try {
            val ring = EventRing()
            val server = PortholeSocketServer(port, ring, packageName = packageName)

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

    // -- the retry: released before the attempts run out, the server binds -

    @Test
    fun `releasing the port before the retries run out lets the server bind, and says how many attempts it took`() {
        val port = freePort()
        val holder = ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))
        val ring = EventRing()
        val server = PortholeSocketServer(port, ring, packageName = packageName)

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

    // -- self-check (a): a bind exception that is not EADDRINUSE -----------

    @Test
    fun `a malformed port fails for its own reason, not misreported as EADDRINUSE`() {
        val ring = EventRing()
        // Out of the valid 0-65535 range: ServerSocket's own constructor
        // throws IllegalArgumentException synchronously, before any socket
        // syscall happens at all - a different failure shape than a taken
        // port, and the message must not claim the wrong one.
        val server = PortholeSocketServer(70_000, ring, packageName = packageName)

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
