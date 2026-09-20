// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.transport

import android.net.LocalServerSocket
import android.net.LocalSocket
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
import java.io.InputStream
import java.io.InterruptedIOException
import java.io.OutputStream
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
 * A per-package JSON-lines server, off by default on a TCP port at all.
 *
 * GRA-199: every Porthole app used to bind the same loopback TCP port
 * (127.0.0.1:8677 by default), so two Porthole apps on one device could never
 * both be reachable — the second one's bind simply lost the race GRA-196
 * taught this class to report loudly. The fix keys the on-device endpoint by
 * package instead of by port: [start] binds an [LocalServerSocket] in
 * Android's abstract namespace, named `porthole.<packageName>`, which is
 * unique by construction the same way the package name it is built from is.
 * `adb forward tcp:PORT localabstract:porthole.<applicationId>` bridges it to
 * the workstation exactly as `adb forward tcp:PORT tcp:PORT` used to — the
 * host side of the wire is unchanged, only the far end of the forward moved.
 *
 * An abstract-namespace Unix domain socket carries the same loopback-only
 * security story a TCP bind to 127.0.0.1 did: it is not reachable from
 * another device, another network namespace, or anything off-device at all —
 * only a process on the same device (in practice, `adbd`, itself confined to
 * a `adb forward`) can connect to it. Nothing here changes what the module
 * being debug-only already guarded.
 *
 * [legacyTcp] is the escape hatch for anyone who was forwarding the old TCP
 * port by hand and has not moved their tooling yet — see
 * `PortholeExtension.legacyTcpPort`'s own doc comment for the deprecation
 * story. It restores the pre-GRA-199 bind exactly: `ServerSocket(port, ...,
 * 127.0.0.1)`, with the same collision the rest of this class's doc comment
 * describes.
 */
internal class PortholeSocketServer(
    private val port: Int,
    private val ring: EventRing,
    /**
     * The device-side identity: named in the bind-failure log so whoever
     * reads logcat on a device with two Porthole apps installed knows which
     * of them is complaining, and (GRA-199) it is also literally the abstract
     * socket's name (`porthole.<packageName>`) — the thing that makes two
     * Porthole apps on one device no longer contend for anything at all.
     * [Porthole.install] has this on hand already
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
    /**
     * GRA-199: bind the legacy loopback TCP socket instead of the abstract
     * Unix socket that is now the default. Off unless `porthole { legacyTcpPort.set(true) }`
     * asked for it — see that property's own KDoc for who still needs this
     * and for how long.
     */
    private val legacyTcp: Boolean = false,
    /**
     * The one call [bindWithRetry] repeats: `ServerSocket(port, ...)` wrapped
     * as a [TcpBoundServer] when [legacyTcp], `LocalServerSocket(socketName)`
     * wrapped as a [LocalBoundServer] otherwise — the real bind, in
     * production, always. A constructor parameter rather than a direct call
     * so a plain JVM test can drive the retry loop, the two message shapes
     * and the [Setup] recording with a fake that throws on demand, without
     * ever touching `android.net.LocalServerSocket` itself: Robolectric ships
     * no shadow for it (no `ShadowLocalServerSocket` anywhere in
     * shadows-framework, unlike `ServerSocket`, which is plain Java and needs
     * none), and its real implementation calls native methods with no host
     * backing, so `new LocalServerSocket(name)` under Robolectric throws
     * `IOException: socket not created` unconditionally — confirmed by
     * running it, not assumed. Exercising the abstract-socket bind itself is
     * therefore only ever provable on a real device or emulator; this
     * ticket's own report records that run. Nothing outside a test ever
     * passes a non-default value.
     */
    private val bindOnce: () -> BoundServer = {
        if (legacyTcp) {
            TcpBoundServer(ServerSocket(port, BACKLOG, InetAddress.getByName(LOOPBACK)))
        } else {
            LocalBoundServer(LocalServerSocket("porthole.$packageName"))
        }
    },
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

    @Volatile private var server: BoundServer? = null
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
    /**
     * `porthole.<packageName>` — the abstract socket's name, and (GRA-199)
     * the reason two Porthole apps on one device no longer contend for
     * anything: each app's own package name makes this unique by
     * construction, the same guarantee a Java package namespace already
     * gives every class on it. Only used to describe the target in a log
     * line here; [legacyTcp] never calls this, and [bindOnce] builds its own
     * copy of the same string for the real bind.
     */
    private val socketName = "porthole.$packageName"

    /** How the current [legacyTcp]/[port] combination reads in a log line. */
    private val bindDescription = if (legacyTcp) "$LOOPBACK:$port" else "localabstract:$socketName"

    private fun bindWithRetry(): BoundServer? {
        var lastError: Exception? = null
        for (attempt in 1..BIND_RETRY_ATTEMPTS) {
            bindAttempts = attempt
            try {
                val socket = bindOnce()
                listening = true
                listeningFailure = null
                Setup.recordSocketBind(listening = true, failure = null, attempts = attempt)
                Log.i(
                    TAG,
                    if (attempt == 1) {
                        "listening on $bindDescription"
                    } else {
                        "listening on $bindDescription after $attempt attempts"
                    },
                )
                return socket
            } catch (e: Exception) {
                lastError = e
                if (attempt < BIND_RETRY_ATTEMPTS) {
                    Log.d(
                        TAG,
                        "bind attempt $attempt/$BIND_RETRY_ATTEMPTS on $bindDescription failed, retrying: ${e.message}",
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
        // into a claim about address-in-use that would not be true. A
        // LocalSocketImpl bind failure is not guaranteed to surface as a
        // BindException the way ServerSocket's is (it is a thinner JNI
        // wrapper over the same EADDRINUSE errno), so the message text is
        // checked too rather than trusting the exception's Java type alone.
        val reason = if (e is BindException || e.message?.contains("EADDRINUSE") == true) {
            "EADDRINUSE"
        } else {
            e.javaClass.simpleName
        }
        val message = if (legacyTcp) {
            "could not bind $bindDescription for $packageName after $bindAttempts attempt(s) " +
                "($reason: ${e.message}); another app on this device has a Porthole on $port; stop it, " +
                "or give this app its own porthole { port.set(...) }"
        } else {
            // GRA-199: the abstract socket is keyed by package, so this is no
            // longer "another app took the port" — it can only mean a second
            // instance of THIS SAME app (two processes, or a reinstall whose
            // old process has not fully released the name) still holding it
            // once every retry above is exhausted.
            "could not bind $bindDescription for $packageName after $bindAttempts attempt(s) " +
                "($reason: ${e.message}); another process of this same app still holds it"
        }
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

    private inner class ClientConnection(private val socket: BoundClient) {
        private val writeLock = Any()
        private var writer: BufferedWriter? = null

        fun serve() {
            try {
                socket.disableNagle()
                val reader: BufferedReader = socket.input.bufferedReader()
                val out = socket.output.bufferedWriter()
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

// ---------------------------------------------------------------------------
// GRA-199: the abstraction that lets the accept loop, ClientConnection and
// stop() above stay ignorant of which of the two socket families is live
// underneath — the abstract-namespace LocalServerSocket that is the default,
// or the legacy loopback ServerSocket kept behind `legacyTcp`. Free functions
// on `ServerSocket`/`Socket` and `LocalServerSocket`/`LocalSocket` already
// agree closely enough (both pairs offer accept()/close() and
// getInputStream()/getOutputStream()) that this is a thin adapter, not a
// reimplementation of either.
// ---------------------------------------------------------------------------

/** What [PortholeSocketServer.bindWithRetry] binds: either shape, once bound. */
internal interface BoundServer {
    fun accept(): BoundClient
    fun close()
}

/** One accepted connection, either shape. */
internal interface BoundClient {
    val input: InputStream
    val output: OutputStream
    val isClosed: Boolean
    fun close()

    /**
     * Disables Nagle's algorithm on a real TCP socket, where batching small
     * writes trades latency the timeline UI feels for a bandwidth saving this
     * loopback link does not need. A no-op on the abstract Unix-domain
     * socket: there is no Nagle algorithm to disable on a socket that was
     * never a TCP stream in the first place, and `LocalSocket` has no such
     * setting to call.
     */
    fun disableNagle()
}

internal class TcpBoundServer(private val delegate: ServerSocket) : BoundServer {
    override fun accept(): BoundClient = TcpBoundClient(delegate.accept())
    override fun close() = delegate.close()
}

internal class TcpBoundClient(private val socket: Socket) : BoundClient {
    override val input: InputStream get() = socket.getInputStream()
    override val output: OutputStream get() = socket.getOutputStream()
    override val isClosed: Boolean get() = socket.isClosed
    override fun close() = socket.close()
    override fun disableNagle() {
        socket.tcpNoDelay = true
    }
}

internal class LocalBoundServer(private val delegate: LocalServerSocket) : BoundServer {
    override fun accept(): BoundClient = LocalBoundClient(delegate.accept())
    override fun close() = delegate.close()
}

internal class LocalBoundClient(private val socket: LocalSocket) : BoundClient {
    override val input: InputStream get() = socket.inputStream
    override val output: OutputStream get() = socket.outputStream
    override val isClosed: Boolean get() = !socket.isConnected
    override fun close() = socket.close()
    override fun disableNagle() {}
}
