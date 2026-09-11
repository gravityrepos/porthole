// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.transport

import android.util.Log
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.protocol.EventFrame
import live.gravitylabs.porthole.protocol.PortholeJson
import live.gravitylabs.porthole.protocol.Request
import live.gravitylabs.porthole.protocol.Response
import live.gravitylabs.porthole.store.EventRing
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InterruptedIOException
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
    private val onFirstClient: () -> Unit = {},
) {
    private val handlers = LinkedHashMap<String, MethodHandler>()
    private val clients = CopyOnWriteArrayList<ClientConnection>()
    private val io = Executors.newCachedThreadPool { r ->
        Thread(r, "porthole-io").apply { isDaemon = true }
    }

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
            val socket = try {
                ServerSocket(port, BACKLOG, InetAddress.getByName(LOOPBACK))
            } catch (e: Exception) {
                Log.w(TAG, "could not bind $LOOPBACK:$port, is another process holding it?", e)
                running = false
                return@execute
            }
            server = socket
            Log.i(TAG, "listening on $LOOPBACK:$port")
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
    }
}
