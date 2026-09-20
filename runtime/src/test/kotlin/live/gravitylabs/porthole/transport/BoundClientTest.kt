// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.transport

import android.net.LocalSocket
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.ServerSocket
import java.net.Socket

/**
 * GRA-199 QA (F4): [LocalBoundClient.isClosed] used to read
 * `!socket.isConnected`, mirroring what [TcpBoundClient] does with a real
 * `java.net.Socket`. That is wrong for [LocalSocket] specifically:
 * `isConnected` latches `true` the moment `LocalServerSocket.accept()` hands
 * the socket over and Android's own implementation never clears it back on
 * `close()` — unlike [java.net.Socket.isClosed], which is well-defined and
 * genuinely toggles. `ClientConnection.serve()`'s `while (running &&
 * !socket.isClosed)` guard was therefore dead weight on the abstract path:
 * it could never itself end the loop.
 *
 * A real `LocalServerSocket.accept()` needs a real bind, which — like the
 * rest of the abstract-socket path — cannot be exercised under Robolectric
 * at all (see [PortholeSocketServerBindTest]'s own comment for why, proven
 * by trying it). What *can* be constructed here is a bare, unconnected
 * `LocalSocket()`, which is enough to catch the actual regression this fix
 * guards against: on an unconnected socket, `isConnected` is `false`, so the
 * old `!socket.isConnected` implementation reported `isClosed == true`
 * *before* `close()` was ever called — a freshly accepted, still-open
 * connection reporting itself already closed, which is the wrong answer in
 * the other direction from the "never becomes true" bug QA found, and this
 * test's first assertion catches it directly. The full "accept() latches
 * true and close() never clears it" scenario is only provable on-device;
 * this test proves the fix is self-consistent and does not merely swap one
 * wrong answer for another.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class BoundClientTest {

    @Test
    fun `LocalBoundClient - reports open until close is actually called, independent of LocalSocket isConnected`() {
        val socket = LocalSocket()
        val client = LocalBoundClient(socket)

        assertFalse(
            "a freshly wrapped, unclosed connection must not report itself closed " +
                "(the old `!socket.isConnected` read would fail this: isConnected is false " +
                "on an unconnected socket, so `!isConnected` is true before any close() at all)",
            client.isClosed,
        )

        client.close()

        assertTrue("close() must flip isClosed to true", client.isClosed)
    }

    @Test
    fun `LocalBoundClient - isClosed stays true once set, even though LocalSocket isConnected never becomes true here`() {
        // The narrower regression QA actually found: `isConnected` never
        // transitions to true for a socket that was never accepted, so a
        // second read after close() must still see our own flag, not fall
        // back to asking the (permanently false) isConnected again.
        val socket = LocalSocket()
        val client = LocalBoundClient(socket)
        client.close()
        assertTrue(client.isClosed)
        assertTrue("a second read must agree with the first", client.isClosed)
    }

    @Test
    fun `TcpBoundClient - isClosed already tracked real Socket state correctly, unaffected by this fix`() {
        // Control: java.net.Socket.isClosed() is well-defined and genuinely
        // toggles, which is exactly why TcpBoundClient reads it directly
        // rather than tracking its own flag — this pins that F4 did not
        // change (or need to change) the legacy TCP path.
        val server = ServerSocket(0)
        try {
            val port = server.localPort
            val clientSocket = Socket("127.0.0.1", port)
            val accepted = server.accept()
            val bound = TcpBoundClient(accepted)

            assertFalse(bound.isClosed)
            bound.close()
            assertTrue(bound.isClosed)

            clientSocket.close()
        } finally {
            server.close()
        }
    }
}
