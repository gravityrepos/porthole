// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * GRA-96: `Hello.protocol` is the one field this whole file exists to make
 * trustworthy — the receiving side (`mcp/src/device.ts`) now compares it
 * against its own copy of [PROTOCOL_VERSION] instead of ignoring it. These
 * tests stay on the Kotlin side of that check: they prove the field actually
 * survives a real `PortholeJson` encode/decode round trip (not a hand-built
 * JSON string a test author assumed was the wire shape — this project's
 * recurring lesson, see BRIEFING.md), and that a Hello missing `protocol`
 * altogether — the shape an old sender would produce — still decodes to a
 * real, non-null integer rather than blowing up or silently going missing.
 */
class ProtocolRoundTripTest {

    private fun sampleHello(protocol: Int = PROTOCOL_VERSION) = Hello(
        protocol = protocol,
        packageName = "com.example.shop",
        processName = "com.example.shop",
        versionName = "1.0.0",
        debuggable = true,
        device = "Pixel 10 Pro XL",
        sdkInt = 37,
        startedAt = 12_345L,
        collectors = listOf("recompositions", "frames"),
    )

    @Test
    fun `Hello round-trips through PortholeJson with protocol intact`() {
        val hello = sampleHello(protocol = PROTOCOL_VERSION)
        val encoded = PortholeJson.encodeToString(Hello.serializer(), hello)
        val decoded = PortholeJson.decodeFromString(Hello.serializer(), encoded)
        assertEquals(hello, decoded)
        assertEquals(PROTOCOL_VERSION, decoded.protocol)
    }

    @Test
    fun `a Hello constructed without naming protocol still carries PROTOCOL_VERSION`() {
        // The constructor default, not a hand-typed literal — this is the
        // same default registerMethods() relies on implicitly by never
        // passing `protocol` itself (see Porthole.kt's `hello` method).
        val hello = Hello(
            packageName = "com.example.shop",
            processName = "com.example.shop",
            versionName = null,
            debuggable = true,
            device = "Pixel 10 Pro XL",
            sdkInt = 37,
            startedAt = 0L,
            collectors = emptyList(),
        )
        assertEquals(PROTOCOL_VERSION, hello.protocol)

        // encodeDefaults = true (see PortholeJson above), so the field is
        // still present on the wire even though nothing set it explicitly —
        // the receiving side never has to distinguish "sent PROTOCOL_VERSION"
        // from "sent nothing and I assumed PROTOCOL_VERSION".
        val encoded = PortholeJson.encodeToString(Hello.serializer(), hello)
        assertEquals(true, encoded.contains("\"protocol\":$PROTOCOL_VERSION"))
    }

    @Test
    fun `a hello frame with no protocol key at all still decodes to PROTOCOL_VERSION`() {
        // The shape an app built before this field existed would send: every
        // other required field present, `protocol` simply absent rather than
        // present-and-wrong. Hello.protocol's own default is what makes this
        // decode instead of fail closed — the receiving side's version check
        // (device.ts) is what turns that default into an honest "the app is
        // older than this field" refusal rather than a crash here.
        val legacyFrame = """
            {
              "packageName": "com.example.shop",
              "processName": "com.example.shop",
              "versionName": "0.9.0",
              "debuggable": true,
              "device": "Pixel 10 Pro XL",
              "sdkInt": 37,
              "startedAt": 0,
              "collectors": []
            }
        """.trimIndent()
        val decoded = PortholeJson.decodeFromString(Hello.serializer(), legacyFrame)
        assertEquals(PROTOCOL_VERSION, decoded.protocol)
    }

    @Test
    fun `a mismatched protocol still decodes cleanly -- the refusal is the reader's job, not the parser's`() {
        // Protocol.kt's job stops at "this is a well-formed Hello"; deciding
        // whether protocol=99 is acceptable belongs to the reader
        // (device.ts), not to deserialisation, which must not throw just
        // because the number is one this build has never heard of — a
        // forward-compatible bump should still parse, so the reader gets the
        // chance to produce its actionable message instead of a stack trace.
        val hello = sampleHello(protocol = 99)
        val encoded = PortholeJson.encodeToString(Hello.serializer(), hello)
        val decoded = PortholeJson.decodeFromString(Hello.serializer(), encoded)
        assertEquals(99, decoded.protocol)
    }
}
