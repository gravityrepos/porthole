// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import java.io.File
import java.security.MessageDigest

/**
 * Where Perfetto's trace_processor comes from, and how it is checked.
 *
 * It is not shipped with Porthole and should not be: it is a platform-specific
 * native binary, 77MB on Windows, versioned against the trace format. Bundling
 * it would multiply the size of a Gradle plugin and an npm package for a tool
 * most sessions never reach for.
 *
 * Fetching it on demand is a different question, and the answer is yes. This
 * build already downloads its own Gradle distribution, AGP, Kotlin and every
 * dependency, and `portholeUi` runs npx against the registry. Declining to
 * fetch one more tool was never a principle this project actually held — the
 * one it does hold is that the app's data stays on the machine, which is
 * untouched by downloading a binary from a pinned release.
 *
 * So: a pinned version, a pinned SHA-256 per platform, over HTTPS from the
 * official release, into a cache, and never unless asked. The same bargain the
 * Gradle wrapper makes with distributionSha256Sum.
 */
internal object TraceProcessor {

    const val VERSION = "v58.2"

    /**
     * Checked against the digest GitHub publishes for each release asset.
     *
     * Pinned rather than read at download time on purpose: fetching the
     * expected hash from the same place as the file it describes checks that
     * the download completed, not that it is the file this plugin was written
     * against.
     */
    private val SHA256 = mapOf(
        "windows-amd64" to "5a00dbb990b1aa422c818169259ffaf0671e2ff276a51857f30185d8bf9d1409",
        "linux-amd64" to "32c739f71b2d39721afd294c0b038f2499a44a71b5b6bcdd85b83faca0b240b9",
        "linux-arm64" to "a82bf4111a340a7ea8577bcfd62e014e8e81b9e6a35a3190f5415fb800051ab0",
        "mac-amd64" to "1ec01f5de30fbf3b4e91c2b96508e3f537f0f57d1d1ce4bdf0892c98c4de039c",
        "mac-arm64" to "9dbd484a32c9833c95cf58ca5ef86d2c9ad4767149054ad4eaa52bdf027d1507",
    )

    /** The release asset for the machine this is running on. */
    fun platform(
        osName: String = System.getProperty("os.name").orEmpty(),
        arch: String = System.getProperty("os.arch").orEmpty(),
    ): String? {
        val os = osName.lowercase()
        val arm = arch.lowercase().let { it.contains("aarch64") || it.contains("arm") }
        return when {
            os.contains("win") -> "windows-amd64"
            os.contains("mac") || os.contains("darwin") -> if (arm) "mac-arm64" else "mac-amd64"
            os.contains("nux") || os.contains("nix") -> if (arm) "linux-arm64" else "linux-amd64"
            else -> null
        }
    }

    fun url(platform: String): String =
        "https://github.com/google/perfetto/releases/download/$VERSION/$platform.zip"

    fun expectedSha256(platform: String): String? = SHA256[platform]

    /** Where a verified copy lives. Versioned, so a bump does not shadow itself. */
    fun cacheDir(home: File): File = File(home, ".porthole/trace-processor/$VERSION")

    fun binaryName(platform: String): String =
        if (platform.startsWith("windows")) "trace_processor_shell.exe" else "trace_processor_shell"

    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { stream ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val read = stream.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
