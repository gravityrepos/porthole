// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import android.app.Application
import android.content.pm.ApplicationInfo
import android.util.Log
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import live.gravitylabs.porthole.transport.PortholeSocketServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

/**
 * GRA-240: `ApplicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE`, read
 * for real, gates [Porthole.install] — this used to be a literal `true` in
 * the `hello` handshake, so a build type the plugin's own `debugBuildTypes`
 * named but that was not actually `isDebuggable = true` (a QA `staging` type,
 * say) opened the socket, started every collector, and reported
 * `hello.debuggable: true` regardless. Same [ShutdownTest] pattern: a real
 * `Application` through Robolectric, reflection only over this module's own
 * private fields, never over Android framework internals a shadow already
 * exposes a real API for.
 *
 * Emulator evidence for the same gate is in the GRA-240 ticket's own report:
 * a `staging` build type with `isDebuggable = false` listed in
 * `debugBuildTypes`, `dumpsys package ... pkgFlags` showing no `DEBUGGABLE`,
 * and no `porthole.<applicationId>` entry in `/proc/net/unix`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class DebuggableGateTest {

    private val app: Application get() = RuntimeEnvironment.getApplication()

    @After
    fun tearDown() {
        Porthole.shutdown()
    }

    @Test
    fun `FLAG_DEBUGGABLE clear - install refuses, no session, no socket`() {
        clearDebuggable()

        Porthole.install(app, port = 0)

        assertNull(
            "expected no session at all — no socket, no collectors — when the app is not debuggable",
            currentSessionOrNull(),
        )
    }

    @Test
    fun `FLAG_DEBUGGABLE clear - logs exactly one warning line naming why and the build type`() {
        clearDebuggable()
        ShadowLog.clear()

        Porthole.install(app, port = 0)

        val portholeWarnings = ShadowLog.getLogs().filter { it.tag == "Porthole" && it.type == Log.WARN }
        assertEquals(
            "expected exactly one Porthole warning line, got: ${portholeWarnings.map { it.msg }}",
            1,
            portholeWarnings.size,
        )
        val message = portholeWarnings.single().msg
        assertTrue(
            "expected the line to say why (FLAG_DEBUGGABLE): $message",
            message.contains("FLAG_DEBUGGABLE"),
        )
        assertTrue(
            "expected the line to name the build type it refused to start on: $message",
            message.contains("build"),
        )
    }

    @Test
    fun `FLAG_DEBUGGABLE set - install behaves as before and hello reports debuggable true`() {
        // Robolectric's synthetic ApplicationInfo (manifest = Config.NONE, what
        // every test here uses) does not set FLAG_DEBUGGABLE on its own — set
        // it explicitly rather than assume it, the same real flag every other
        // test in this module now needs too (see TestApplications.kt).
        app.makeDebuggableForTest()
        assertTrue(
            "expected the flag to be set after makeDebuggableForTest()",
            (app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0,
        )

        Porthole.install(app, port = 0)

        val session = currentSessionOrNull() ?: error("Porthole.install did not leave a session behind")
        assertEquals(true, helloDebuggable(session))
    }

    private fun clearDebuggable() {
        app.applicationInfo.flags = app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE.inv()
    }

    private fun currentSessionOrNull(): Any? {
        val field = Class.forName("live.gravitylabs.porthole.Porthole").getDeclaredField("session")
        field.isAccessible = true
        return field.get(Porthole)
    }

    /** Invokes the real `hello` RPC handler directly, with no socket involved. */
    private fun helloDebuggable(session: Any): Boolean {
        val server = session.javaClass.getDeclaredField("server").apply { isAccessible = true }
            .get(session) as PortholeSocketServer
        val handlersField = PortholeSocketServer::class.java.getDeclaredField("handlers")
            .apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val handlers = handlersField.get(server) as Map<String, (JsonObject) -> JsonElement>
        val hello = handlers["hello"] ?: error("no `hello` handler registered on the server")
        val result = hello(JsonObject(emptyMap()))
        return result.jsonObject["debuggable"]?.jsonPrimitive?.boolean
            ?: error("hello result had no `debuggable` field: $result")
    }
}
