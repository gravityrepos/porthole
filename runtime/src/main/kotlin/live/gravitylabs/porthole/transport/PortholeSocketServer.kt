// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.transport

import android.util.Log
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.collect.Setup
import live.gravitylabs.porthole.protocol.EventFrame
import live.gravitylabs.porthole.protocol.PortholeJson
import live.gravitylabs.porthole.protocol.Request
import live.gravitylabs.porthole.protocol.Response
import live.gravitylabs.porthole.store.EventRing
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InterruptedIOException
import java.net.BindException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

internal typealias MethodHandler = (JsonObject) -> JsonElement

/**
 * Loopback-only JSON-lines server.
 *
 * Loopback-only is the whole security story: the socket binds to 127.0.0.1, so
 * nothing off-device can reach it without an explicit `adb forward`, which in
 * turn needs USB debugging authorisation. The module being debug-only sits on
 * top of that.
 */
internal class PortholeSocketServer(
    private val port: Int,
    private val ring: EventRing,
    /**
     * Named in the bind-failure log so whoever reads logcat on a device with
     * two Porthole apps installed knows which of them is complaining, not
     * just which port. [Porthole.install] has this on hand already
     * ([android.content.Context.getPackageName]); nothing here goes looking
     * for it itself, so the class stays constructible from a plain unit test
     * with no `Application`.
     */
    private val packageName: String,
    private val onFirstClient: () -> Unit = {},
    /**
     * Fired exactly once, off the io executor, the moment the bind either
     * succeeds or exhausts its retries. [Porthole.install] uses this to log
     * "installed on ..." only once the socket is genuinely listening,
     * instead of the fixed ordering the bind-runs-on-a-background-thread
     * shape used to force: that line used to print unconditionally, before
     * the bind was even attempted, so it happily announced an install that
     * had, moments later, failed to listen. Tests that construct this class
     * directly have no reason to pass one.
     */
    private val onBindResult: (ok: Boolean) -> Unit = {},
) {
    private val handlers = LinkedHashMap<String, MethodHandler>()
    private val clients = CopyOnWriteArrayList<ClientConnection>()
    private val io = Executors.newCachedThreadPool { r ->
        Thread(r, "porthole-io").apply { isDaemon = true }
    }

    /**
     * Whether the socket is genuinely listening right now — the queryable
     * half of this class's bind result. `false` from construction until a
     * bind attempt succeeds; flips back to `false`, permanently, once every
     * retry has failed. Nothing clears it back on [stop]: a stopped server
     * was listening and then chose to stop, which is a different fact from
     * one that was never able to.
     */
    @Volatile var listening: Boolean = false
        private set

    /**
     * The remedy-bearing message from the most recent failed bind, or `null`
     * if the current (or most recent) bind succeeded. Cleared on a
     * successful bind so a caller that only checks this field after
     * `listening` flips true never reads a stale complaint from an earlier
     * attempt.
     */
    @Volatile var listeningFailure: String? = null
        private set

    /**
     * How many `ServerSocket(...)` attempts [start] made before settling one
     * way or the other. `1` is the ordinary case — bound on the first try.
     * Greater than `1` means a retry was needed, which is worth surfacing in
     * the setup report even on success: it is evidence a previous instance
     * of this same app was still releasing the port, not proof nothing is
     * wrong.
     */
    @Volatile var bindAttempts: Int = 0
        private set

    /**
     * Bounded on purpose. When the far end cannot keep up, the choice is to
     * block the app, grow without limit, or drop; a debug tool that distorts
     * the timings it reports is worse than one with a gap in it.
     */
    private val outbound = ArrayBlockingQueue<EventFrame>(OUTBOUND_CAPACITY)
    private val dropped = AtomicLong(0)

    @Volatile private var server: ServerSocket? = null
    @Volatile private var running = false

    fun method(name: String, handler: MethodHandler) {
        handlers[name] = handler
    }

    fun start() {
        if (running) return
        running = true
        io.execute {
            val socket = bindWithRetry()
            if (socket == null) {
                running = false
                onBindResult(false)
                return@execute
            }
            server = socket
            onBindResult(true)
            var sawClient = false
            while (running) {
                val client = try {
                    socket.accept()
                } catch (e: Exception) {
                    if (running) Log.w(TAG, "accept failed", e)
                    break
                }
                if (!sawClient) {
                    sawClient = true
                    runCatching(onFirstClient)
                }
                val conn = ClientConnection(client)
                clients += conn
                io.execute { conn.serve() }
            }
        }
        io.execute {
            Thread.currentThread().name = "porthole-writer"
            pumpOutbound()
        }
        ring.addListener(::broadcast)
    }

    /**
     * Tries to bind [BIND_RETRY_ATTEMPTS] times, [BIND_RETRY_DELAY_MS] apart,
     * before giving up.
     *
     * The retry exists for exactly one case: a *previous* instance of this
     * same app, mid-reinstall, still holding the port while Android tears its
     * old process down. That teardown is normally well under the ~2 seconds
     * this loop spends, so a genuine same-app reinstall races through here
     * and nobody ever sees the intermediate attempts. It is not a fix for two
     * different apps wanting the same port at once — that case runs out the
     * clock the same as any other unrecoverable failure and reports exactly
     * as loudly.
     *
     * Runs on the io executor, never the caller of [start] — a debug build
     * still starts on the main thread by way of [live.gravitylabs.porthole.PortholeInitializer],
     * and blocking that for up to ~2 seconds on every cold start (the common
     * case: no retry ever needed) would be a worse regression than the bug
     * this exists to log.
     */
    private fun bindWithRetry(): ServerSocket? {
        var lastError: Exception? = null
        for (attempt in 1..BIND_RETRY_ATTEMPTS) {
            bindAttempts = attempt
            try {
                val socket = ServerSocket(port, BACKLOG, InetAddress.getByName(LOOPBACK))
                listening = true
                listeningFailure = null
                Setup.recordSocketBind(listening = true, failure = null, attempts = attempt)
                Log.i(
                    TAG,
                    if (attempt == 1) {
                        "listening on $LOOPBACK:$port"
                    } else {
                        "listening on $LOOPBACK:$port after $attempt attempts"
                    },
                )
                return socket
            } catch (e: Exception) {
                lastError = e
                if (attempt < BIND_RETRY_ATTEMPTS) {
                    Log.d(
                        TAG,
                        "bind attempt $attempt/$BIND_RETRY_ATTEMPTS on $LOOPBACK:$port failed, retrying: ${e.message}",
                    )
                    try {
                        Thread.sleep(BIND_RETRY_DELAY_MS)
                    } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                        break
                    }
                }
            }
        }

        val e = lastError ?: error("bindWithRetry exited its loop without ever attempting a bind")
        // BindException is the JVM's own signal for "the address is taken" —
        // the same condition POSIX calls EADDRINUSE — independent of the
        // exception's message text, which is not guaranteed stable across
        // platforms. Anything else (a malformed port, a security manager
        // refusal, ...) is named by its own class instead of being folded
        // into a claim about address-in-use that would not be true.
        val reason = if (e is BindException) "EADDRINUSE" else e.javaClass.simpleName
        val message = "could not bind $LOOPBACK:$port for $packageName after $bindAttempts attempt(s) " +
            "($reason: ${e.message}); another app on this device has a Porthole on $port; stop it, " +
            "or give this app its own porthole { port.set(...) }"
        listening = false
        listeningFailure = message
        Setup.recordSocketBind(listening = false, failure = message, attempts = bindAttempts)
        Log.e(TAG, message, e)
        return null
    }

    fun stop() {
        running = false
        ring.removeListener(::broadcast)
        outbound.clear()
        runCatching { server?.close() }
        clients.forEach { it.close() }
        clients.clear()
        io.shutdownNow()
    }

    /**
     * Hands the frame to the writer thread and returns.
     *
     * This runs on whatever thread emitted the event, which for a recomposition
     * is the main thread. It must therefore do as close to nothing as possible:
     * no encoding, no I/O, no lock that a socket write could be holding. A
     * screen recomposing sixty times a second produced enough traffic to fill
     * the send buffer, and doing this work inline stalled the UI thread and then
     * dropped the client.
     */
    private fun broadcast(frame: EventFrame) {
        if (clients.isEmpty()) return
        if (!outbound.offer(frame)) {
            // Better to lose events than to block the app being measured. The
            // gap is reported rather than hidden: seq numbers would show it
            // anyway, and a silent hole in a trace is worse than a short one.
            dropped.incrementAndGet()
        }
    }

    private fun pumpOutbound() {
        while (running) {
            val frame = try {
                outbound.take()
            } catch (_: InterruptedException) {
                return
            }
            if (clients.isEmpty()) continue

            val missed = dropped.getAndSet(0)
            if (missed > 0) {
                write(
                    EventFrame(
                        event = "dropped",
                        t = frame.t,
                        seq = frame.seq,
                        data = JsonObject(mapOf("count" to JsonPrimitive(missed))),
                    ),
                )
            }
            write(frame)
        }
    }

    private fun write(frame: EventFrame) {
        val line = PortholeJson.encodeToString(EventFrame.serializer(), frame)
        clients.forEach { it.send(line) }
    }

    private inner class ClientConnection(private val socket: Socket) {
        private val writeLock = Any()
        private var writer: BufferedWriter? = null

        fun serve() {
            try {
                socket.tcpNoDelay = true
                val reader: BufferedReader = socket.getInputStream().bufferedReader()
                val out = socket.getOutputStream().bufferedWriter()
                synchronized(writeLock) { writer = out }

                while (running && !socket.isClosed) {
                    val line = reader.readLine() ?: break
                    if (line.isBlank()) continue
                    respond(line)
                }
            } catch (_: InterruptedIOException) {
                // stop() closing the socket under us.
            } catch (e: Exception) {
                Log.d(TAG, "client gone: " + e.message)
            } finally {
                close()
                clients.remove(this)
            }
        }

        private fun respond(line: String) {
            val req = try {
                PortholeJson.decodeFromString(Request.serializer(), line)
            } catch (e: Exception) {
                val err = Response(id = -1, ok = false, error = "malformed request: " + e.message)
                send(PortholeJson.encodeToString(Response.serializer(), err))
                return
            }
            val handler = handlers[req.method]
            val response = if (handler == null) {
                Response(
                    req.id,
                    ok = false,
                    error = "unknown method " + req.method + ". known: " + handlers.keys.joinToString(),
                )
            } else {
                try {
                    Response(req.id, ok = true, result = handler(req.params))
                } catch (e: Throwable) {
                    Response(req.id, ok = false, error = e.javaClass.simpleName + ": " + e.message)
                }
            }
            send(PortholeJson.encodeToString(Response.serializer(), response))
        }

        fun send(line: String) {
            val out = writer ?: return
            synchronized(writeLock) {
                try {
                    out.write(line)
                    out.write("\n")
                    out.flush()
                } catch (e: Exception) {
                    Log.d(TAG, "write failed, dropping client: " + e.message)
                    close()
                }
            }
        }

        fun close() {
            synchronized(writeLock) { writer = null }
            runCatching { socket.close() }
        }
    }

    companion object {
        private const val TAG = "Porthole"
        private const val LOOPBACK = "127.0.0.1"
        private const val BACKLOG = 8

        /** About two seconds of a badly behaved screen. */
        private const val OUTBOUND_CAPACITY = 2048

        /**
         * How many times [bindWithRetry] tries before giving up, and how long
         * it waits between tries. Five attempts, 500 ms apart: enough slack
         * for a normal same-app reinstall's old process to finish releasing
         * the port (well under a second in practice) without making a
         * genuinely-taken port take unreasonably long to report as an error.
         */
        private const val BIND_RETRY_ATTEMPTS = 5
        private const val BIND_RETRY_DELAY_MS = 500L
    }
}
