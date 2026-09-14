// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import org.gradle.testkit.runner.GradleRunner
import org.gradle.testkit.runner.TaskOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * `portholeMcpConfig`, run for real through TestKit — GRA-119.
 *
 * The ticket this guards against: `.mcp.json` told the MCP server the port
 * and nothing else, so the server inferred its project root and Android SDK
 * location from `process.cwd()` — a convention MCP clients happen to follow,
 * not one this build controls. The plugin knows both with certainty at
 * configure time, so this task now writes `PORTHOLE_PROJECT_ROOT` and
 * `PORTHOLE_SDK_DIR` into the generated `env` block alongside `PORTHOLE_PORT`.
 *
 * Per this project's oldest lesson (self-written fixtures test the format you
 * assumed, not the one that arrives), every test below runs a real Gradle
 * build and reads back the real `.mcp.json` it wrote, rather than asserting
 * against hand-built JSON. `local.properties` round-trips through Java
 * properties escaping — a Windows path's drive-letter colon and every
 * backslash come out doubled on write and have to come back single on read —
 * which is exactly the shape GRA-87's parser existed to handle, so that shape
 * is what the SDK-dir tests use, on a genuine Windows path when this suite
 * runs on Windows and a POSIX path otherwise.
 *
 * The task is registered by hand rather than through the plugin — the
 * plugin only registers it on an Android module, and that needs AGP, an SDK
 * and the network none of this wants. [PortholeAgpCompatibilityTest] covers
 * that wiring.
 */
class McpConfigTest : StubAdbFunctionalTest() {

    private fun registerTask(port: Int = 8677): String =
        """
        import live.gravitylabs.porthole.gradle.PortholeMcpConfigTask

        tasks.register<PortholeMcpConfigTask>("portholeMcpConfig") {
            port.set($port)
            projectName.set("scratch")
            configFile.set(layout.projectDirectory.file(".mcp.json"))
        }
        """

    private fun scratch(body: String) {
        write("settings.gradle.kts", "rootProject.name = \"scratch\"\n")
        write(
            "build.gradle.kts",
            """
            plugins { id("live.gravitylabs.porthole") }

            """.trimIndent() + "\n" + body.trimIndent() + "\n",
        )
    }

    private val mcpJson: File
        get() = File(projectDir.root, ".mcp.json")

    /** Runs with a controlled environment: real tests must not depend on
     * whatever happens to be set on the machine running them. */
    private fun buildWithEnv(env: Map<String, String>, vararg arguments: String) =
        GradleRunner.create()
            .withProjectDir(projectDir.root)
            .withPluginClasspath()
            .withArguments(*arguments, "--stacktrace")
            .withEnvironment(env)
            .build()

    @Suppress("UNCHECKED_CAST")
    private fun readEnvBlock(): Map<String, Any?> {
        val root = JsonSlurper().parseText(mcpJson.readText()) as Map<String, Any?>
        val servers = root["mcpServers"] as Map<String, Any?>
        val porthole = servers["porthole"] as Map<String, Any?>
        return porthole["env"] as Map<String, Any?>
    }

    // No ANDROID_HOME/ANDROID_SDK_ROOT: isolates the local.properties path
    // from whatever the host machine happens to have set, which matters
    // because this repo's own dev machine is a stock Android Studio install
    // where local.properties is the ONLY correct answer (see GRA-87).
    private val noSdkEnv = mapOf("PATH" to (System.getenv("PATH") ?: ""))

    @Test
    fun `writes PORTHOLE_PROJECT_ROOT as the real root project directory`() {
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals(projectDir.root.absolutePath, env["PORTHOLE_PROJECT_ROOT"])
    }

    @Test
    fun `writes PORTHOLE_SDK_DIR resolved from local properties, surviving a Windows-shaped path`() {
        // A drive letter and spaces: the two things properties-escaping and
        // JSON-escaping each have their own way of mangling if either is done
        // by hand instead of through a real parser/serializer.
        val sdk = projectDir.newFolder("Android Sdk", "with spaces")
        val escaped = sdk.absolutePath.replace("\\", "\\\\").replace(":", "\\:")
        write("local.properties", "sdk.dir=$escaped\n")
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals(sdk.absolutePath, env["PORTHOLE_SDK_DIR"])
        // Pasted for the record: the actual bytes a client would read.
        println("[McpConfigTest] generated .mcp.json (Windows-shaped sdk.dir):\n${mcpJson.readText()}")
    }

    @Test
    fun `writes PORTHOLE_SDK_DIR resolved from local properties, surviving a UNC path`() {
        // A UNC path is a second Windows absolute-path shape distinct from a
        // drive letter: no colon to properties-escape, but two leading
        // backslashes that must survive both the properties parse and the
        // JSON serialize.
        //
        // Windows-only for the same reason the POSIX case below is POSIX-only:
        // the shape is decided by java.io.File, not by this task. On Linux a
        // UNC string is not absolute at all — every backslash is an ordinary
        // filename character — so the task correctly resolves it against the
        // project directory and the assertion below compares a resolved path
        // against a raw one. The `JSON serialization survives representative
        // absolute path shapes` test carries the UNC *string* through the real
        // writer and reader on every platform, which is the part of this that
        // is genuinely portable.
        assumeTrue("a UNC string is only an absolute path on Windows", isWindowsHost())

        val unc = "\\\\build-server\\share\\Android Sdk"
        val escaped = unc.replace("\\", "\\\\")
        write("local.properties", "sdk.dir=$escaped\n")
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals(unc, env["PORTHOLE_SDK_DIR"])
        println("[McpConfigTest] generated .mcp.json (UNC-shaped sdk.dir):\n${mcpJson.readText()}")
    }

    @Test
    fun `writes PORTHOLE_SDK_DIR resolved from local properties, surviving a POSIX path`() {
        // Genuinely run only on a POSIX host: java.io.File treats a leading
        // "/" as non-absolute on Windows and rewrites it under the current
        // drive (verified: File("/home/x").getAbsolutePath() on this machine
        // returns "C:\home\x"), which is Windows' own File semantics, not a
        // defect in this task. A local.properties file is host-generated and
        // never shared across OSes, so that combination does not arise in
        // practice; `JSON serialization survives representative absolute
        // path shapes` below still exercises the POSIX string shape through
        // the actual JSON writer/reader, independent of java.io.File.
        assumeFalse("java.io.File normalizes a POSIX path away from its own shape on Windows", isWindowsHost())

        val sdk = projectDir.newFolder("posix sdk", "with spaces")
        write("local.properties", "sdk.dir=${sdk.absolutePath}\n")
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals(sdk.absolutePath, env["PORTHOLE_SDK_DIR"])
        println("[McpConfigTest] generated .mcp.json (POSIX-shaped sdk.dir):\n${mcpJson.readText()}")
    }

    @Test
    fun `JSON serialization survives representative absolute path shapes`() {
        // The part of this ticket that is actually novel: the old code built
        // .mcp.json by interpolating values into a raw JSON string and
        // parsing that back, which is exactly wrong for a path containing a
        // backslash. This is now built as data and handed to JsonOutput (see
        // PortholeMcpConfigTask.entry). Exercised directly here against
        // JsonOutput/JsonSlurper, independent of java.io.File's own
        // Windows-vs-POSIX absolute-path opinions, which is a second and
        // unrelated source of platform difference covered by the functional
        // tests above.
        val shapes = listOf(
            "C:\\Users\\jane doe\\AppData\\Local\\Android\\Sdk",
            "\\\\build-server\\share\\Android Sdk",
            "/home/jane/Android/Sdk with spaces",
        )
        for (shape in shapes) {
            val json = JsonOutput.toJson(mapOf("PORTHOLE_SDK_DIR" to shape))
            val parsed = JsonSlurper().parseText(json) as Map<*, *>
            assertEquals(shape, parsed["PORTHOLE_SDK_DIR"])
        }
    }

    private fun isWindowsHost(): Boolean =
        System.getProperty("os.name").orEmpty().lowercase().contains("win")

    @Test
    fun `omits PORTHOLE_SDK_DIR when it cannot be resolved at all`() {
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertFalse(
            "expected no PORTHOLE_SDK_DIR without a resolvable SDK, got: $env",
            env.containsKey("PORTHOLE_SDK_DIR"),
        )
        // PORTHOLE_PROJECT_ROOT is unconditional — the plugin always knows it.
        assertTrue(env.containsKey("PORTHOLE_PROJECT_ROOT"))
    }

    @Test
    fun `treats a blank sdk dir as absent rather than as the working directory`() {
        // `sdk.dir=` with nothing after it is what a half-edited or
        // tool-generated local.properties looks like. Taken at its word it
        // becomes File(""), whose absolutePath is the Gradle daemon's current
        // working directory — so .mcp.json would have named some arbitrary
        // directory as the Android SDK, which is worse than saying nothing,
        // because the MCP server's own walk never gets a chance to run.
        write("local.properties", "sdk.dir=\n")
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertFalse(
            "a blank sdk.dir must not become a path, got: $env",
            env.containsKey("PORTHOLE_SDK_DIR"),
        )
    }

    @Test
    fun `a blank sdk dir does not shadow ANDROID_HOME`() {
        // The other half of the same bug: a blank value that is treated as a
        // hit stops the env-var fallback from ever being consulted.
        val sdk = projectDir.newFolder("sdk-behind-a-blank")
        write("local.properties", "sdk.dir=   \n")
        scratch(registerTask())

        val result = buildWithEnv(
            mapOf("PATH" to (System.getenv("PATH") ?: ""), "ANDROID_HOME" to sdk.absolutePath),
            "portholeMcpConfig",
        )
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals(sdk.absolutePath, env["PORTHOLE_SDK_DIR"])
    }

    @Test
    fun `falls back to ANDROID_HOME when local properties has no sdk dir`() {
        val sdk = projectDir.newFolder("sdk-from-env")
        scratch(registerTask())

        val result = buildWithEnv(
            mapOf("PATH" to (System.getenv("PATH") ?: ""), "ANDROID_HOME" to sdk.absolutePath),
            "portholeMcpConfig",
        )
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals(sdk.absolutePath, env["PORTHOLE_SDK_DIR"])
    }

    @Test
    fun `local properties sdk dir wins over ANDROID_HOME`() {
        val fromProperties = projectDir.newFolder("from-properties")
        val fromEnv = projectDir.newFolder("from-env")
        write("local.properties", "sdk.dir=${fromProperties.absolutePath.replace("\\", "\\\\")}\n")
        scratch(registerTask())

        val result = buildWithEnv(
            mapOf("PATH" to (System.getenv("PATH") ?: ""), "ANDROID_HOME" to fromEnv.absolutePath),
            "portholeMcpConfig",
        )
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals(fromProperties.absolutePath, env["PORTHOLE_SDK_DIR"])
    }

    @Test
    fun `regenerating with the same inputs reports up to date and leaves other servers untouched`() {
        write(
            ".mcp.json",
            """
            {
              "mcpServers": {
                "other-tool": { "command": "npx", "args": ["-y", "other-tool"] }
              }
            }
            """.trimIndent(),
        )
        scratch(registerTask())

        buildWithEnv(noSdkEnv, "portholeMcpConfig")
        val second = buildWithEnv(noSdkEnv, "portholeMcpConfig")

        assertTrue(
            "expected the second run to say there was nothing to do, got:\n${second.output}",
            second.output.contains("already has a matching entry"),
        )

        @Suppress("UNCHECKED_CAST")
        val servers = (JsonSlurper().parseText(mcpJson.readText()) as Map<String, Any?>)["mcpServers"] as Map<String, Any?>
        assertTrue("expected the pre-existing server to survive", servers.containsKey("other-tool"))
        assertTrue("expected porthole to be present", servers.containsKey("porthole"))
    }
}
