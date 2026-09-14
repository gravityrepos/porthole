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
import java.util.Properties

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

    /**
     * Provenance (GRA-111 pattern): captured verbatim from a real
     * `local.properties` written by an actual Android Studio install, on a
     * Windows 11 development workstation, 2026-09-14 — the same file this
     * repository ships gitignored, so every developer's own copy is written
     * by the same tool the same way. Only the username segment
     * (`C:\Users\<name>\...`) was changed, to a neutral `builder`, per
     * GRA-150 QA's note not to commit a personal filesystem path; the
     * escaping under test — the drive-letter colon and every doubled
     * backslash — is exactly what Android Studio's `Properties.store()`
     * wrote, untouched. If this ever needs refreshing, replace this whole
     * block with a fresh capture and update the date above and the expected
     * value in the test that reads it.
     */
    private val capturedLocalProperties = "sdk.dir=C\\:\\\\Users\\\\builder\\\\AppData\\\\Local\\\\Android\\\\Sdk\n"

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
    fun `a relative sdk dir resolves against the project root, not this JVM's working directory`() {
        // GRA-150, AC3. Android Studio always writes an absolute sdk.dir, so
        // this is a hand-edited-file case rather than a common one — but
        // local.properties is exactly the kind of file a person edits, and a
        // relative entry has one reasonable meaning: relative to the project
        // that owns the file. `File(it).absolutePath` alone would instead
        // resolve it against this JVM's own `user.dir`, which for a reused
        // Gradle daemon is wherever that long-lived process happened to
        // start — unrelated to projectDir.root, the scratch project this test
        // just created. Comparing against `File(projectDir.root, ...)` rather
        // than a literal string is what makes this a regression test for that
        // exact bug: it fails if resolution ever goes back to being anchored
        // on `user.dir` instead of the project root, on any host.
        projectDir.newFolder("sdk-relative")
        write("local.properties", "sdk.dir=sdk-relative\n")
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        val expected = File(projectDir.root, "sdk-relative").absolutePath
        assertEquals(expected, env["PORTHOLE_SDK_DIR"])
    }

    @Test
    fun `a Windows drive-relative sdk dir does not get spliced into the project root`() {
        // GRA-150 QA regression: `C:foo` (a drive letter and colon with no
        // separator) is Windows' "drive-relative" shape — "foo, relative to
        // whatever the current directory on drive C happens to be" — which
        // File.isAbsolute correctly reports as false. Joining it onto
        // projectRoot the same way an ordinary relative path is joined does
        // NOT anchor it under the project: WinNTFileSystem splices the two
        // strings together as "<projectRoot>\C:foo", a colon inside a path
        // segment that Windows refuses to open at all — worse than doing
        // nothing, and worse than what this resolver did before GRA-150. See
        // the comment on resolveSdkDir/isWindowsDriveRelative for why this
        // shape is deliberately left exactly as Java resolves it alone
        // (valid, just not anchored to the project) rather than given an
        // invented answer. Not compared against a literal
        // `File("C:sdk-drive-relative").absolutePath` computed in this test's
        // own JVM: Windows tracks "the current directory on drive C"
        // per-process, and this build forks a separate TestKit daemon JVM
        // with its own value for it, so the two processes can legitimately
        // resolve the same drive-relative string to different (both valid)
        // answers. What must hold regardless of which process resolves it is
        // the actual regression this guards: the result must not be
        // projectRoot with "C:sdk-drive-relative" appended to it.
        assumeTrue("drive-relative paths are a Windows shape", isWindowsHost())

        write("local.properties", "sdk.dir=C:sdk-drive-relative\n")
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        val produced = env["PORTHOLE_SDK_DIR"] as String
        assertFalse(
            "a colon must never appear outside the drive prefix; got $produced",
            produced.drop(2).contains(':'),
        )
        assertFalse(
            "must not be spliced onto the project root; got $produced",
            produced.startsWith(projectDir.root.absolutePath),
        )
    }

    @Test
    fun `a dot-relative sdk dir resolves under the project root`() {
        // QA-flagged gap: "./foo" is a shape nothing exercised. It is not
        // normalized (the "." segment goes verbatim into the resolved path,
        // same as PortholeMcpConfigTask writes it into .mcp.json) — that is a
        // deliberate non-goal of this ticket, not an oversight; what matters
        // is that it is still anchored under projectRoot rather than user.dir.
        projectDir.newFolder("sdk-dot-relative")
        write("local.properties", "sdk.dir=./sdk-dot-relative\n")
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals(File(projectDir.root, "./sdk-dot-relative").absolutePath, env["PORTHOLE_SDK_DIR"])
    }

    @Test
    fun `a parent-relative sdk dir resolves against the project root's parent`() {
        // QA-flagged gap: "../foo" has a real, useful meaning — a shared SDK
        // checkout that lives next to several projects — and it is worth
        // proving the anchor is projectRoot and not some other directory by
        // computing the expected answer independently (via projectDir.root's
        // own parentFile) rather than by re-running the same File(...) call
        // resolveSdkDir itself would run. Compared via canonicalFile, not a
        // literal string: resolveSdkDir does not normalize ".." out of the
        // path it returns (see the dot-relative test above), so the raw
        // string still contains "..\sdk-parent-relative-..." — canonicalizing
        // both sides is what makes this an independent check of where the
        // path actually points rather than a re-derivation of the same
        // unnormalized string.
        val sibling = File(projectDir.root.parentFile, "sdk-parent-relative-${System.nanoTime()}")
        sibling.mkdirs()
        try {
            write("local.properties", "sdk.dir=../${sibling.name}\n")
            scratch(registerTask())

            val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
            assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

            val env = readEnvBlock()
            val produced = File(env["PORTHOLE_SDK_DIR"] as String)
            assertEquals(sibling.canonicalFile, produced.canonicalFile)
        } finally {
            sibling.delete()
        }
    }

    @Test
    fun `a trailing separator on a relative sdk dir does not change the resolved path`() {
        // QA-flagged gap. A forward slash is accepted by java.io.File as a
        // separator on every platform this suite runs on, so it is used here
        // rather than choosing the escaped-backslash spelling on Windows only.
        val sdk = projectDir.newFolder("sdk-relative-trailing")
        write("local.properties", "sdk.dir=${sdk.name}/\n")
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals(sdk.absolutePath, env["PORTHOLE_SDK_DIR"])
    }

    @Test
    fun `a relative sdk dir with spaces resolves under the project root`() {
        // QA-flagged gap: the existing spaces coverage is all on absolute
        // paths (see the Windows/UNC/POSIX tests above); this is the
        // relative case, which goes through the projectRoot-join branch
        // those never touch.
        val sdk = projectDir.newFolder("sdk relative with spaces")
        write("local.properties", "sdk.dir=${sdk.name}\n")
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals(sdk.absolutePath, env["PORTHOLE_SDK_DIR"])
    }

    @Test
    fun `a POSIX-shaped sdk dir resolves under the project root on Windows too`() {
        // QA-flagged gap: `writes PORTHOLE_SDK_DIR ... surviving a POSIX
        // path` above is assumeFalse(isWindowsHost()), so it structurally
        // never runs here, and this ticket changed Windows' own answer for
        // this shape — main gave "C:\opt\android-sdk" (the current drive
        // root; java.io.File treats a leading "/" as belonging to the
        // current drive on Windows, not the filesystem root), this resolver
        // now gives "<projectRoot>\opt\android-sdk" (the relative-join
        // branch, since "/opt/android-sdk" is not absolute by
        // File.isAbsolute's Windows definition). That is a real behaviour
        // change worth pinning explicitly rather than leaving to a test that
        // cannot run on this host.
        assumeTrue(isWindowsHost())

        write("local.properties", "sdk.dir=/opt/android-sdk\n")
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        val produced = env["PORTHOLE_SDK_DIR"]
        assertEquals(File(projectDir.root, "/opt/android-sdk").absolutePath, produced)
        assertFalse(
            "expected the projectRoot-anchored answer, not the pre-GRA-150 current-drive answer",
            produced == "C:\\opt\\android-sdk",
        )
    }

    @Test
    fun `local properties escaping round-trips against a real Android Studio capture, committed`() {
        // AC4, and this is now the *primary* proof, not the only one — QA
        // (GRA-150) correctly flagged that the machine-local test below is
        // the GRA-75 / GRA-137 / GRA-144 shape: it silently skips wherever
        // local.properties is absent (every fresh checkout, all of CI), the
        // suite total does not move, and the build stays green. A green
        // build that ran one fewer test is indistinguishable from one that
        // passed, which defeats the entire point of AC4.
        //
        // capturedLocalProperties below is not reconstructed from the escaping
        // rules this suite assumes — it is the literal bytes read from a
        // local.properties Android Studio wrote on a real Windows workstation
        // (this project's GRA-111 pattern: a committed real artifact, with
        // provenance, rather than a hand-built fixture). The only change from
        // what was captured is the username, replaced with a neutral
        // placeholder per GRA-150 QA's note not to commit a personal
        // filesystem path — the escaping under test (the drive colon and
        // every doubled backslash) is untouched. This test needs no file on
        // disk and no assumeTrue: it runs identically on this machine, a
        // fresh clone and CI.
        assumeTrue("this escaping shape is Windows-specific", isWindowsHost())

        write("local.properties", capturedLocalProperties)
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals(
            "C:\\Users\\builder\\AppData\\Local\\Android\\Sdk",
            env["PORTHOLE_SDK_DIR"],
        )
    }

    @Test
    fun `local properties escaping round-trips against the real file on this machine, when one is present`() {
        // AC4's belt-and-suspenders half: the committed capture above is now
        // the unconditional proof, so this one is free to be exactly what its
        // name says — an *additional* real-world cross-check on whatever
        // local.properties this run's machine actually has, which may catch
        // something the fixed capture above cannot (a different SDK layout,
        // a different Windows locale, a genuinely different escaping choice
        // by whatever wrote it). Per QA's finding, its skip must be visible
        // rather than silent, so both the run and the skip print a banner —
        // grep test output for "[McpConfigTest][AC4]" to see which happened
        // without opening the JUnit XML.
        //
        // System.getProperty("user.dir") here is this JVM's own working
        // directory, not the scratch project's — Gradle sets a test task's
        // working directory to its module (gradle-plugin), so the parent is
        // the repository root, same as PortholeAgpCompatibilityTest.
        val real = File(File(System.getProperty("user.dir")).parentFile, "local.properties")
        if (!real.isFile) {
            println("[McpConfigTest][AC4] SKIPPED: no local.properties at ${real.absolutePath} — " +
                "this environment gets AC4's coverage only from the committed capture above.")
        }
        assumeTrue("no local.properties next to the real build; nothing to compare against", real.isFile)

        val props = Properties()
        real.inputStream().use(props::load)
        val rawSdkDir = props.getProperty("sdk.dir")
        if (rawSdkDir.isNullOrBlank()) {
            println("[McpConfigTest][AC4] SKIPPED: ${real.absolutePath} has no usable sdk.dir.")
        }
        assumeTrue("the real local.properties has no usable sdk.dir", !rawSdkDir.isNullOrBlank())
        val expected = File(rawSdkDir)
        if (!(expected.isAbsolute && expected.isDirectory)) {
            println(
                "[McpConfigTest][AC4] SKIPPED: ${real.absolutePath}'s sdk.dir ($expected) is not an " +
                    "absolute, existing directory.",
            )
        }
        assumeTrue(
            "expected an absolute, existing SDK directory from the real file, got $expected",
            expected.isAbsolute && expected.isDirectory,
        )

        write("local.properties", real.readText())
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals(expected.absolutePath, env["PORTHOLE_SDK_DIR"])
        println("[McpConfigTest][AC4] RAN against the real ${real.absolutePath}: ${env["PORTHOLE_SDK_DIR"]}")
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
    fun `falls back to ANDROID_SDK_ROOT when neither local properties nor ANDROID_HOME name an sdk`() {
        // AC2: the full precedence chain is sdk.dir -> ANDROID_HOME ->
        // ANDROID_SDK_ROOT. The other tests around this one pin the first two
        // links; this is the third, otherwise unexercised by name.
        val sdk = projectDir.newFolder("sdk-from-sdk-root")
        scratch(registerTask())

        val result = buildWithEnv(
            mapOf("PATH" to (System.getenv("PATH") ?: ""), "ANDROID_SDK_ROOT" to sdk.absolutePath),
            "portholeMcpConfig",
        )
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals(sdk.absolutePath, env["PORTHOLE_SDK_DIR"])
    }

    @Test
    fun `ANDROID_HOME wins over ANDROID_SDK_ROOT when both are set`() {
        // QA (GRA-150): the two tests around this one each set exactly one of
        // ANDROID_HOME/ANDROID_SDK_ROOT, which proves each is consulted but
        // not which one wins — swapping their order in resolveSdkDir's
        // fallback sequence left the whole suite green. This is the test
        // that mutation is supposed to break: both variables point at real,
        // distinct directories, and only ANDROID_HOME's may come back.
        val fromHome = projectDir.newFolder("sdk-from-android-home")
        val fromSdkRoot = projectDir.newFolder("sdk-from-android-sdk-root")
        scratch(registerTask())

        val result = buildWithEnv(
            mapOf(
                "PATH" to (System.getenv("PATH") ?: ""),
                "ANDROID_HOME" to fromHome.absolutePath,
                "ANDROID_SDK_ROOT" to fromSdkRoot.absolutePath,
            ),
            "portholeMcpConfig",
        )
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals(fromHome.absolutePath, env["PORTHOLE_SDK_DIR"])
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
