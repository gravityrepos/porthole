// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * This is the one place in the project that downloads an executable and then
 * runs it. Picking the wrong asset means fetching 77MB that will not start;
 * getting the digest wrong means the check that makes the download acceptable
 * at all does not actually check anything.
 */
class TraceProcessorTest {

    @get:Rule
    val temp = TemporaryFolder()

    @Test
    fun `picks the asset for each platform Perfetto publishes`() {
        assertEquals("windows-amd64", TraceProcessor.platform("Windows 11", "amd64"))
        assertEquals("mac-arm64", TraceProcessor.platform("Mac OS X", "aarch64"))
        assertEquals("mac-amd64", TraceProcessor.platform("Mac OS X", "x86_64"))
        assertEquals("linux-arm64", TraceProcessor.platform("Linux", "aarch64"))
        assertEquals("linux-amd64", TraceProcessor.platform("Linux", "amd64"))
    }

    @Test
    fun `does not guess at a platform it has no build for`() {
        // Better to say so than to download the Linux binary onto a BSD and let
        // the failure surface as a checksum pass and an exec error.
        assertNull(TraceProcessor.platform("FreeBSD", "amd64"))
        assertNull(TraceProcessor.platform("", ""))
    }

    @Test
    fun `every platform it will name has a pinned checksum`() {
        val named = listOf(
            TraceProcessor.platform("Windows 11", "amd64"),
            TraceProcessor.platform("Mac OS X", "aarch64"),
            TraceProcessor.platform("Mac OS X", "x86_64"),
            TraceProcessor.platform("Linux", "aarch64"),
            TraceProcessor.platform("Linux", "amd64"),
        )
        // A platform the task will happily resolve but cannot verify would be
        // downloaded and then rejected, which is the worst of both.
        named.forEach { platform ->
            assertNotNull("no checksum pinned for $platform", TraceProcessor.expectedSha256(platform!!))
        }
    }

    @Test
    fun `only Windows gets the exe suffix`() {
        assertEquals("trace_processor_shell.exe", TraceProcessor.binaryName("windows-amd64"))
        assertEquals("trace_processor_shell", TraceProcessor.binaryName("mac-arm64"))
        assertEquals("trace_processor_shell", TraceProcessor.binaryName("linux-amd64"))
    }

    @Test
    fun `the cache is versioned so a bump does not shadow itself`() {
        val dir = TraceProcessor.cacheDir(temp.root)
        assertTrue(dir.path.replace('\\', '/').endsWith(".porthole/trace-processor/${TraceProcessor.VERSION}"))
    }

    @Test
    fun `the download url is the official release for the pinned version`() {
        assertEquals(
            "https://github.com/google/perfetto/releases/download/${TraceProcessor.VERSION}/linux-amd64.zip",
            TraceProcessor.url("linux-amd64"),
        )
        assertTrue(TraceProcessor.url("mac-arm64").startsWith("https://github.com/google/perfetto/"))
    }

    @Test
    fun `hashes a known value`() {
        // Not a round trip against itself: the expected digest is the published
        // SHA-256 of "abc", so a broken implementation cannot agree with itself.
        val file = temp.newFile("abc.txt")
        file.writeBytes("abc".toByteArray())
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            TraceProcessor.sha256(file),
        )
    }

    @Test
    fun `a single changed byte changes the digest`() {
        val a = temp.newFile("a.bin")
        val b = temp.newFile("b.bin")
        a.writeBytes(ByteArray(1 shl 17) { it.toByte() })
        b.writeBytes(ByteArray(1 shl 17) { it.toByte() }.also { it[1 shl 16] = 0x7f })
        // Larger than the read buffer on purpose: an implementation that only
        // digests the first chunk passes the small case and fails here.
        assertTrue(TraceProcessor.sha256(a) != TraceProcessor.sha256(b))
    }
}
