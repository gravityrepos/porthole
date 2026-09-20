// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * GRA-199 QA (F2): [forwardTarget]'s abstract-socket prefix, `localabstract:porthole.`,
 * exists as three independent literals — this module's own `forwardTarget`,
 * `mcp/src/devices.ts`'s own `forwardTarget`, and `runtime`'s
 * `PortholeSocketServer`/`Porthole.kt` (which now go through one shared
 * `Protocol.kt` function, `portholeSocketName` — see that function's own
 * KDoc for why `gradle-plugin` and `mcp` cannot import it directly: neither
 * module depends on `runtime`). A one-character drift here — a typo'd
 * prefix, a missing dot — produces an `adb forward` that runs without error
 * and simply never reaches the app, a far quieter failure than a refused
 * bind.
 *
 * This is the `gradle-plugin`-side half of the parity check:
 * `runtime/.../protocol/Protocol.kt`'s `PORTHOLE_SOCKET_PREFIX` is read as
 * text (the same cross-module-drift technique `VersionConsistencyTest`
 * already uses for the published version, and `device.test.ts`'s
 * `PROTOCOL_VERSION` check and `eventKinds.test.ts` already use across the
 * Kotlin/TypeScript boundary), and this module's own `forwardTarget` is
 * called for real and checked against it. `mcp/src/devices.test.ts` carries
 * the matching TS-side half.
 */
class ForwardTargetParityTest {

    /** Tests run from the included build's directory, so the root is one up — same as [VersionConsistencyTest]. */
    private val root = File(System.getProperty("user.dir")).parentFile!!

    private val protocolKtPrefix: String by lazy {
        val protocolKt = File(root, "runtime/src/main/kotlin/live/gravitylabs/porthole/protocol/Protocol.kt")
        assertTrue("expected to find Protocol.kt at ${protocolKt.absolutePath}", protocolKt.isFile)
        val text = protocolKt.readText()
        val matches = Regex("""internal const val PORTHOLE_SOCKET_PREFIX\s*=\s*"([^"]*)"""").findAll(text).toList()
        assertEquals(
            if (matches.isEmpty()) {
                "PORTHOLE_SOCKET_PREFIX declaration was not found in Protocol.kt in the expected shape"
            } else {
                "found ${matches.size} things that look like a PORTHOLE_SOCKET_PREFIX declaration in " +
                    "Protocol.kt; this parser cannot tell which one is real, so it refuses to guess"
            },
            1,
            matches.size,
        )
        matches.single().groupValues[1]
    }

    @Test
    fun `Protocol Kt actually names a non-empty prefix — guards the regex above`() {
        assertTrue("PORTHOLE_SOCKET_PREFIX read back empty", protocolKtPrefix.isNotEmpty())
        assertEquals("porthole.", protocolKtPrefix)
    }

    @Test
    fun `this module's forwardTarget uses Protocol Kt's own prefix, not a copy that could drift`() {
        val target = forwardTarget(8677, "com.example.shop", legacyTcpPort = false)
        assertEquals("localabstract:$protocolKtPrefix" + "com.example.shop", target)
    }
}
