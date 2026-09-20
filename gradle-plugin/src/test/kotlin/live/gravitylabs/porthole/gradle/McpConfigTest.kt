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

    private fun registerTask(
        port: Int = 8677,
        applicationId: String? = null,
        packageVersion: String = "0.2.2",
        mcpCommand: List<String>? = null,
        overwrite: Boolean = false,
    ): String =
        """
        import live.gravitylabs.porthole.gradle.PortholeMcpConfigTask

        tasks.register<PortholeMcpConfigTask>("portholeMcpConfig") {
            port.set($port)
            projectName.set("scratch")
            packageVersion.set("$packageVersion")
            configFile.set(layout.projectDirectory.file(".mcp.json"))
            ${if (applicationId != null) "applicationId.set(\"$applicationId\")" else ""}
            ${if (mcpCommand != null) "mcpCommand.set(listOf(${mcpCommand.joinToString(", ") { "\"$it\"" }}))" else ""}
            ${if (overwrite) "overwrite.set(true)" else ""}
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
    private fun readPortholeEntry(): Map<String, Any?> {
        val root = JsonSlurper().parseText(mcpJson.readText()) as Map<String, Any?>
        val servers = root["mcpServers"] as Map<String, Any?>
        return servers["porthole"] as Map<String, Any?>
    }

    @Suppress("UNCHECKED_CAST")
    private fun readEnvBlock(): Map<String, Any?> = readPortholeEntry()["env"] as Map<String, Any?>

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
        assertEquals(canonicalPathOf(projectDir.root), env["PORTHOLE_PROJECT_ROOT"])
    }

    /**
     * GRA-193. The npm package declares two bins, `porthole` (the CLI) and
     * `porthole-mcp`; npx runs the one named like the package, so an entry
     * without a subcommand launched the CLI's usage screen, which exited at
     * once, and the MCP client saw a server that started and immediately
     * ended. `porthole mcp` is the CLI branch that boots the same server
     * `dist/index.js` does. Pinned in order, as the literal package name a
     * consumer's client will actually run, not the constant the task reads.
     *
     * GRA-195: also pinned to a version, in the same literal-string style —
     * see `pins the npm package to the configured uiPackageVersion` below for
     * the test that is specifically about the pin surviving a version change.
     */
    @Test
    fun `launches the CLI's mcp subcommand, not its usage screen`() {
        scratch(registerTask(packageVersion = "0.2.2"))

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val porthole = readPortholeEntry()
        assertEquals("npx", porthole["command"])
        assertEquals(listOf("-y", "@gravitylabsllc/porthole@0.2.2", "mcp"), porthole["args"])
    }

    /**
     * GRA-195. `portholeUi` pins the timeline it launches to
     * [PortholeExtension.uiPackageVersion], and `AndroidWiring.dependency`
     * pins the runtime AAR to the plugin's own version — but until this
     * ticket, this task's `args` named the npm package with no version at
     * all, so `npx` resolved `latest` at launch time, subject to the
     * registry and the npx cache. Of the three halves that must agree, two
     * were locked and the one carrying the tool surface floated. This is the
     * regression test named directly in the ticket's acceptance criteria:
     * `.mcp.json` written by plugin version X must carry
     * `@gravitylabsllc/porthole@X`. Mutation: drop the `"@" + packageVersion.get()`
     * suffix in `PortholeMcpConfigTask.entry` back to the bare package name
     * and this fails.
     */
    @Test
    fun `pins the npm package to the configured uiPackageVersion`() {
        scratch(registerTask(packageVersion = "1.2.3"))

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val porthole = readPortholeEntry()
        assertEquals(listOf("-y", "@gravitylabsllc/porthole@1.2.3", "mcp"), porthole["args"])
    }

    /**
     * GRA-195 AC: "a re-run after a plugin bump rewrites the pinned version
     * in an existing porthole entry (it replaces the whole entry today, so
     * it should)" — sharpened by a follow-up review: making that require
     * `-Pporthole.overwrite=true` would leave the pin stale on every plugin
     * bump until someone learns the flag, which is the exact drift GRA-195
     * exists to remove. [PortholeMcpConfigTask.versionOnlyDrift] is the
     * narrow proof that lets [PortholeMcpConfigTask.write] apply this one
     * *without* the flag: command, env and every arg but the version match,
     * so nothing about this rewrite is a judgment call the way a genuinely
     * different entry would be. Registering the task fresh with a different
     * packageVersion between the two runs, rather than mutating one
     * in-process task, is deliberate: it is what a real plugin version bump
     * looks like from `.mcp.json`'s point of view — a different build,
     * pointed at the same file. Mutation: in `PortholeMcpConfigTask.write`,
     * drop `&& versionDrift == null` from the refusal's guard condition and
     * this fails (the second run refuses instead of rewriting).
     */
    @Test
    fun `re-running after a version bump rewrites the pinned version without -Pporthole overwrite`() {
        scratch(registerTask(packageVersion = "1.0.0"))
        val first = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, first.task(":portholeMcpConfig")?.outcome)
        assertEquals(listOf("-y", "@gravitylabsllc/porthole@1.0.0", "mcp"), readPortholeEntry()["args"])

        scratch(registerTask(packageVersion = "2.0.0"))
        val second = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, second.task(":portholeMcpConfig")?.outcome)
        assertEquals(listOf("-y", "@gravitylabsllc/porthole@2.0.0", "mcp"), readPortholeEntry()["args"])
        assertTrue(
            "expected the one-line pin-moved notice, got:\n${second.output}",
            second.output.contains("npm package pin moved from 1.0.0 to 2.0.0"),
        )
        assertTrue(
            "expected the previous contents backed up, same as any other rewrite",
            File(projectDir.root, ".mcp.json.bak").isFile,
        )
    }

    /**
     * GRA-195 QA: every `.mcp.json` written before this ticket — every
     * consumer on 0.2.2 or earlier — has exactly this shape: `npx`, no
     * `@version` on the package name at all. Without treating that bare name
     * as "unpinned" (see `PortholeMcpConfigTask.PACKAGE_ARG_PATTERN`'s
     * optional `@version` group), unpinned → pinned would not be
     * recognised as a version-only drift, so the very first run after
     * upgrading past 0.2.2 — the case this whole ticket exists for — would
     * be refused rather than rewritten.
     *
     * The pre-GRA-195 fixture is built from a real run's own `env`, not typed
     * by hand: `PORTHOLE_PROJECT_ROOT` canonicalizes differently depending on
     * the host (GRA-223's `/private/var` on macOS), and this test's own
     * assertions must not reconstruct that resolution to compare against
     * it — the same lesson the class doc opens with, applied to a fixture
     * this test writes itself rather than one the task writes.
     *
     * Mutation: in `PACKAGE_ARG_PATTERN`, drop the `(?:@(.+))?` alternation
     * back to the required `@(.+)` and this fails — the second run falls
     * through to the ordinary refusal instead of auto-rewriting, and the old
     * bare entry survives untouched.
     */
    @Test
    fun `an existing unpinned entry from before GRA-195 is a version-only drift too`() {
        scratch(registerTask(packageVersion = "0.2.3"))
        val first = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, first.task(":portholeMcpConfig")?.outcome)

        // Roll the entry this run just wrote back to the pre-GRA-195 shape —
        // same command, same env, only the pin removed from args.
        val env = readPortholeEntry()["env"]
        write(
            ".mcp.json",
            JsonOutput.prettyPrint(
                JsonOutput.toJson(
                    mapOf(
                        "mcpServers" to mapOf(
                            "porthole" to mapOf(
                                "command" to "npx",
                                "args" to listOf("-y", "@gravitylabsllc/porthole", "mcp"),
                                "env" to env,
                            ),
                        ),
                    ),
                ),
            ) + "\n",
        )

        val second = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, second.task(":portholeMcpConfig")?.outcome)

        assertEquals(listOf("-y", "@gravitylabsllc/porthole@0.2.3", "mcp"), readPortholeEntry()["args"])
        assertTrue(
            "expected the pin-added notice (not \"moved from\"), got:\n${second.output}",
            second.output.contains("npm package pin added: 0.2.3"),
        )
    }

    /**
     * The narrow half of the follow-up: pairing the version bump with an
     * unrelated change — here, a different port, which lands in `env` — must
     * NOT be auto-rewritten. Only a difference confined to the pinned
     * version's own `@` suffix is safe to apply unattended;
     * [PortholeMcpConfigTask.versionOnlyDrift] returns null the moment
     * anything else differs, so this still falls through to the ordinary
     * refusal, same as any hand-edited entry. (Renamed from "a version bump
     * alone does not silently rewrite an existing entry", which the
     * follow-up above made false — a version bump *alone* now does
     * rewrite.)
     */
    @Test
    fun `an entry differing in more than the version pin is still refused`() {
        scratch(registerTask(port = 8677, packageVersion = "1.0.0"))
        val first = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, first.task(":portholeMcpConfig")?.outcome)

        scratch(registerTask(port = 9000, packageVersion = "2.0.0"))
        val second = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, second.task(":portholeMcpConfig")?.outcome)
        assertTrue(
            "expected the refusal message, got:\n${second.output}",
            second.output.contains("already defines 'porthole', and it differs"),
        )
        assertEquals(
            "the stale entry must survive until told to overwrite",
            listOf("-y", "@gravitylabsllc/porthole@1.0.0", "mcp"),
            readPortholeEntry()["args"],
        )
    }

    /**
     * `-Pporthole.overwrite=true` remains the escape hatch for the case the
     * test above proves is otherwise refused — a difference wider than the
     * version pin. Without this, the previous test alone would leave the
     * `overwrite` input effectively untested outside the narrow auto-rewrite
     * path.
     */
    @Test
    fun `-Pporthole overwrite still replaces an entry that differs in more than the version pin`() {
        scratch(registerTask(port = 8677, packageVersion = "1.0.0"))
        val first = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, first.task(":portholeMcpConfig")?.outcome)

        scratch(registerTask(port = 9000, packageVersion = "2.0.0", overwrite = true))
        val second = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, second.task(":portholeMcpConfig")?.outcome)

        assertEquals("9000", readEnvBlock()["PORTHOLE_PORT"])
        assertEquals(listOf("-y", "@gravitylabsllc/porthole@2.0.0", "mcp"), readPortholeEntry()["args"])
    }

    /**
     * GRA-195's `mcpCommand` override (analogous to [PortholeExtension.uiCommand]):
     * for a repo that builds the CLI itself, `.mcp.json` should run that
     * local build rather than any pinned registry version — the sample's own
     * motivating case, since everything else in its `porthole {}` block is
     * already local. Mutation: in `PortholeMcpConfigTask.entry`, replace the
     * `if (override.isNotEmpty())` branch with the unconditional npx/pinned
     * path and this fails.
     */
    @Test
    fun `mcpCommand replaces the pinned npx launch entirely`() {
        scratch(registerTask(mcpCommand = listOf("node", "../porthole/mcp/dist/cli.js", "mcp")))

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val porthole = readPortholeEntry()
        assertEquals("node", porthole["command"])
        assertEquals(listOf("../porthole/mcp/dist/cli.js", "mcp"), porthole["args"])
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
        val expected = canonicalPathOf(File(projectDir.root, "sdk-relative"))
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
        // canonicalPathOf on the whole joined File would normalize the "./"
        // straight out of it — collapsing exactly the segment this test
        // exists to prove survives — so only projectDir.root (the half that
        // actually differs between JUnit's raw path and Gradle's canonical
        // one) is canonicalized; the dot-relative suffix is joined on
        // afterwards, verbatim, the same as the production path is built.
        assertEquals(File(canonicalPathOf(projectDir.root), "./sdk-dot-relative").path, env["PORTHOLE_SDK_DIR"])
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
        assertEquals(canonicalPathOf(sdk), env["PORTHOLE_SDK_DIR"])
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
        assertEquals(canonicalPathOf(sdk), env["PORTHOLE_SDK_DIR"])
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
        // AC4, and this is the primary proof, not the only one — QA
        // (GRA-150, round 2) correctly flagged that the machine-local test
        // below is the GRA-75 / GRA-137 / GRA-144 shape: it silently skips
        // wherever local.properties is absent (every fresh checkout, all of
        // CI), the suite total does not move, and the build stays green.
        //
        // capturedLocalProperties below is not reconstructed from the escaping
        // rules this suite assumes — it is the literal bytes read from a
        // local.properties Android Studio wrote on a real Windows workstation
        // (this project's GRA-111 pattern: a committed real artifact, with
        // provenance, rather than a hand-built fixture). The only change from
        // what was captured is the username, replaced with a neutral
        // placeholder per QA's note not to commit a personal filesystem path
        // — the escaping under test (the drive colon and every doubled
        // backslash) is untouched.
        //
        // GRA-150 QA, round 3: the round-2 version of this test routed the
        // parsed value through the whole resolveSdkDir/PortholeMcpConfigTask
        // path, which meant asserting the *resolved absolute path* — and a
        // Windows-shaped absolute path is only absolute by
        // java.io.File.isAbsolute's rules on Windows, so that assertion
        // needed isWindowsHost() to avoid the value being (correctly, on
        // Linux) joined onto the project root instead. CI's `gradle` job in
        // pr.yml runs on ubuntu-latest only, so that gate meant this test —
        // the one thing AC4 asks for — never ran in CI at all: the "runs
        // nowhere but this laptop" finding moved, it did not close.
        //
        // AC4's actual claim is about the *escaping round-trip*
        // (java.util.Properties un-escaping the doubled backslashes and the
        // escaped drive colon), which is pure JVM and has nothing to do with
        // java.io.File's platform-dependent notion of "absolute". Asserting
        // the parsed property value directly — no Gradle build, no File, no
        // platform gate — is what actually runs this claim on every host,
        // ubuntu-latest included. The paired test below covers the
        // Windows-only half: that the parsed value, once treated as a path,
        // resolves to the expected absolute SDK directory.
        val props = Properties()
        capturedLocalProperties.byteInputStream().use(props::load)
        assertEquals(
            "C:\\Users\\builder\\AppData\\Local\\Android\\Sdk",
            props.getProperty("sdk.dir"),
        )
    }

    @Test
    fun `the committed capture resolves to the expected absolute path, on Windows`() {
        // The Windows-only half of the claim above, kept separate rather
        // than folded back into the platform-independent escaping test: once
        // the parsed "C:\Users\..." string is treated as a path rather than
        // just a string Properties handed back, whether it counts as
        // absolute — and therefore whether it goes through this task and
        // .mcp.json unchanged rather than being joined onto the project root
        // — is a java.io.File, per-platform question, not a Properties one.
        assumeTrue("a Windows-drive-letter path is absolute only on Windows", isWindowsHost())

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
        // An *additional* real-world cross-check on whatever local.properties
        // this run's machine actually has, on top of the unconditional
        // committed-capture test above — it may catch something the fixed
        // capture cannot (a different SDK layout, a different Windows
        // locale, a genuinely different escaping choice by whatever wrote
        // it). Its skip is no longer this suite's problem to announce: GRA-159
        // (merged since the previous QA round) makes CI's summary step print
        // every skipped JVM test by name regardless of pass/fail, which is a
        // stronger, already-solved version of what an in-test println banner
        // was attempting — a println here would only reach the JUnit XML's
        // system-out, sitting next to the skip attribute it was meant to be
        // more visible than, with no console output at all (this module sets
        // no testLogging.showStandardStreams). So: no banner, just the
        // ordinary assumeTrue skip, same as every other environment-gated
        // test in this file.
        //
        // System.getProperty("user.dir") here is this JVM's own working
        // directory, not the scratch project's — Gradle sets a test task's
        // working directory to its module (gradle-plugin), so the parent is
        // the repository root, same as PortholeAgpCompatibilityTest.
        val real = File(File(System.getProperty("user.dir")).parentFile, "local.properties")
        assumeTrue("no local.properties next to the real build; nothing to compare against", real.isFile)

        val props = Properties()
        real.inputStream().use(props::load)
        val rawSdkDir = props.getProperty("sdk.dir")
        assumeTrue("the real local.properties has no usable sdk.dir", !rawSdkDir.isNullOrBlank())
        val expected = File(rawSdkDir)
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
    fun `writes PORTHOLE_APPLICATION_ID when applicationId is set`() {
        // GRA-197 AC1 (unit half — the AGP-defaulting half is
        // PortholeAgpCompatibilityTest, which needs a real Android module).
        scratch(registerTask(applicationId = "com.example.shop"))

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertEquals("com.example.shop", env["PORTHOLE_APPLICATION_ID"])
    }

    @Test
    fun `omits PORTHOLE_APPLICATION_ID when applicationId is unset`() {
        // Same "absence is a signal" rule PORTHOLE_SDK_DIR follows: the
        // server treats a missing key as "no expectation was configured",
        // not as an empty string to compare hello.packageName against.
        scratch(registerTask())

        val result = buildWithEnv(noSdkEnv, "portholeMcpConfig")
        assertEquals(TaskOutcome.SUCCESS, result.task(":portholeMcpConfig")?.outcome)

        val env = readEnvBlock()
        assertFalse(
            "expected no PORTHOLE_APPLICATION_ID without an applicationId set, got: $env",
            env.containsKey("PORTHOLE_APPLICATION_ID"),
        )
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
