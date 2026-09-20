// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URI
import java.util.Properties
import java.util.zip.ZipFile
import javax.inject.Inject

/**
 * `adb forward tcp:PORT tcp:PORT`, then writes the connection file.
 *
 * The forward is what makes the device's loopback socket reachable from the
 * workstation, and it is deliberately the only bridge: nothing is exposed on a
 * network interface at any point.
 *
 * This task never reports itself up to date, and that is deliberate — see
 * [connectionFile] for why declaring no outputs is how that is said.
 */
abstract class PortholeConnectTask : DefaultTask() {

    @get:Inject
    abstract val exec: ExecOperations

    @get:Input
    abstract val adbExecutable: Property<String>

    @get:Input
    abstract val port: Property<Int>

    @get:Input
    @get:Optional
    abstract val serial: Property<String>

    @get:Input
    @get:Optional
    abstract val applicationId: Property<String>

    /**
     * Where the connection file is written. Not an `@OutputFile`.
     *
     * It is a record of a side effect, not a build output. The side effect is
     * the forward, and the forward lives in the adb server, not in the file
     * system: replug a cable, restart the adb server, reboot an emulator or
     * switch devices and it is gone, while this file and every input above are
     * byte-for-byte what they were. Declared as an output, that made the task
     * up to date on its second run and `portholeConnect` reported success
     * without running adb at all — after which every MCP tool answered with the
     * not-connected message, whose advice is to run the task that just lied.
     *
     * A task that declares no outputs is never up to date, which is the
     * truthful description of this one: only adb knows whether the forward
     * exists, so the only safe answer is to ask it again. Nothing in the build
     * consumes this file — the MCP server reads it, out of process, long after
     * Gradle has exited — so it loses nothing by not being wired as an
     * artifact, and `clean` still takes it with the build directory it sits in.
     * [PortholeDisconnectTask] says the same of the same file, for the same
     * reason and in the same words.
     */
    @get:Internal
    abstract val connectionFile: RegularFileProperty

    @TaskAction
    fun connect() {
        val port = port.get()
        val output = ByteArrayOutputStream()
        val result = exec.exec {
            commandLine(adbArgs(adbExecutable.get(), serial.orNull, "forward", "tcp:$port", "tcp:$port"))
            standardOutput = output
            errorOutput = output
            isIgnoreExitValue = true
        }

        val text = output.toString().trim()
        if (result.exitValue != 0) {
            throw GradleException(
                "adb forward failed (exit ${result.exitValue}): $text\n" +
                    "Check that a device is attached (adb devices) and that the debug build is installed.",
            )
        }

        val file = connectionFile.get().asFile
        file.parentFile.mkdirs()
        file.writeText(
            buildString {
                append("{\n")
                append("  \"port\": ").append(port).append(",\n")
                append("  \"host\": \"127.0.0.1\",\n")
                append("  \"applicationId\": ").append(quote(applicationId.orNull)).append(",\n")
                append("  \"deviceSerial\": ").append(quote(serial.orNull)).append(",\n")
                append("  \"protocol\": 1\n")
                append("}\n")
            },
        )

        logger.lifecycle("[porthole] forwarded 127.0.0.1:$port to the device")
        logger.lifecycle("[porthole] connection file: ${file.absolutePath}")
    }

    private fun quote(value: String?): String = if (value == null) "null" else "\"$value\""
}

/**
 * `adb forward --remove tcp:PORT`, then deletes the connection file.
 *
 * Removes the forward. Worth running before switching devices, which is also
 * the case it has to get right: the person running it is about to attach
 * somewhere else and is relying on this to have let go of where they were.
 *
 * This task never reports itself up to date, and that is deliberate — see
 * [connectionFile] for why declaring no outputs is how that is said.
 */
abstract class PortholeDisconnectTask : DefaultTask() {

    @get:Inject
    abstract val exec: ExecOperations

    @get:Input
    abstract val adbExecutable: Property<String>

    @get:Input
    abstract val port: Property<Int>

    @get:Input
    @get:Optional
    abstract val serial: Property<String>

    /**
     * The connection file this task deletes. Not an `@OutputFile`.
     *
     * The same reasoning as [PortholeConnectTask.connectionFile], arrived at
     * from the other side. The file is a record of a side effect and the side
     * effect is the forward, which lives in the adb server; deleting the record
     * is not what makes the forward go away, and nothing about the file says
     * whether one is still there.
     *
     * Declaring it here looked harmless — the task deletes what it declares, so
     * the output is absent afterwards and there is nothing stale to reuse — but
     * absent is precisely what Gradle then finds on the next run as well.
     * Inputs unchanged, output missing both times: up to date, and a second
     * `portholeDisconnect` reported success without running adb at all. That
     * left the workstation's port still wired to a device the console had just
     * said was let go, and the disagreement is invisible from here, because the
     * connection file is gone either way and only adb's forward list knows.
     *
     * A task that declares no outputs is never up to date, which is the
     * truthful description of this one too: only adb can say whether the
     * forward is gone, so the only safe answer is to ask it again. `clean`
     * still takes the file with the build directory it sits in.
     */
    @get:Internal
    abstract val connectionFile: RegularFileProperty

    @TaskAction
    fun disconnect() {
        val port = port.get()
        val output = ByteArrayOutputStream()
        val result = exec.exec {
            commandLine(adbArgs(adbExecutable.get(), serial.orNull, "forward", "--remove", "tcp:$port"))
            standardOutput = output
            errorOutput = output
            isIgnoreExitValue = true
        }

        // Removing a forward that is not there is not a failure. Some
        // platform-tools versions exit non-zero on it, but the request was
        // "make sure nothing is forwarded on this port" and that is the state
        // either way — failing the build would be a disconnect complaining that
        // there was nothing to disconnect, and would punish exactly the careful
        // habit of running this before switching devices. adb's own words are
        // kept at info level so a genuine failure, say an adb that cannot reach
        // its server, is still recoverable with `--info`.
        val text = output.toString().trim()
        if (result.exitValue != 0 && text.isNotEmpty()) {
            logger.info("[porthole] adb forward --remove exited ${result.exitValue}: $text")
        }

        connectionFile.get().asFile.delete()

        // Not "removed the forward": after this runs there is no forward on the
        // port, and whether there was one a moment ago is a thing adb does not
        // reliably say.
        logger.lifecycle("[porthole] no forward left on tcp:$port")
    }
}

/**
 * Writes the MCP server entry into `.mcp.json`.
 *
 * It used to print a snippet to paste, on the reasoning that `.mcp.json` is
 * usually checked in and a build task should not rewrite a shared file behind
 * your back. That reasoning is sound and this keeps it: the file is only
 * changed when the change is unambiguous, and the task says exactly what it
 * did and where.
 *
 *  - no file          create it
 *  - no porthole key  add it, keeping every other server untouched
 *  - same entry       say so and touch nothing
 *  - different entry  refuse, print the difference, and wait to be told
 *
 * That last case is the one worth refusing. A porthole entry that disagrees
 * with this project was put there on purpose — a different port, a hand-added
 * env var, a local build — and silently correcting it would be the behaviour
 * the original comment was guarding against. `-Pporthole.overwrite=true`
 * replaces it. One narrow difference is exempted from the refusal rather than
 * from the rule: see [versionOnlyDrift] and GRA-195 below.
 *
 * GRA-119: this used to write only `PORTHOLE_PORT`, leaving the MCP server to
 * infer its project root and SDK location from `process.cwd()` — set by
 * whatever launched it, not by us. This task knows both with certainty at
 * configure time, so it writes `PORTHOLE_PROJECT_ROOT` (the directory
 * [configFile] lives in — always the Gradle root, since that is where
 * [PortholePlugin] points it) and `PORTHOLE_SDK_DIR` (resolved by
 * [resolveSdkDir]: `local.properties`, then `ANDROID_HOME`/`ANDROID_SDK_ROOT`).
 * `mcp/src/adb.ts` prefers the env var when present and keeps its own walk as
 * the fallback for a server started some other way.
 *
 * GRA-150: [resolveSdkDir] used to exist twice — once here, once as a private
 * `sdkDirectory` in [PortholePlugin], because that method resolves `adb`
 * itself and this task's config generation predates it (see GRA-119's
 * report). They were kept in step by hand across two blank-`sdk.dir` fixes;
 * now [PortholePlugin] calls this one function too.
 *
 * GRA-197: also writes `PORTHOLE_APPLICATION_ID` from [PortholeExtension.applicationId]
 * when it resolves to something — explicitly set, or defaulted from AGP for
 * an application module (see [AndroidWiring.application]). The MCP server
 * uses it to tell its own app from another Porthole app answering on the
 * same port; omitted, not written empty, when unset, for the same reason
 * `PORTHOLE_SDK_DIR` is.
 *
 * GRA-195: `args` used to name the npm package with no version, so `npx`
 * resolved `latest` at launch time — subject to the registry and the npx
 * cache — while `portholeUi` and the runtime AAR were each pinned to the
 * plugin's own version. Of the three halves that have to agree, two were
 * locked to the plugin and the one carrying the tool surface floated. The
 * entry now pins `@<packageVersion>`, the same [PortholeExtension.uiPackageVersion]
 * `portholeUi` already uses, so all three resolve to one version by
 * construction. [PortholeExtension.mcpCommand] opts out of the pin (and of
 * npx) entirely, for a repo — this one's own sample included — that builds
 * the CLI itself and wants `.mcp.json` to run that build rather than any
 * published version of it. A follow-up sharpened the refusal itself: making
 * every bump need `-Pporthole.overwrite=true` would leave the pin stale
 * until someone learned the flag, which is the drift this ticket exists to
 * remove, so [versionOnlyDrift] lets [write] rewrite an entry that differs
 * from `wanted` *only* in the pinned version — same command, same env, same
 * every other arg — without the flag, logging the version it moved from and
 * to. Anything wider than that still refuses exactly as before.
 */
abstract class PortholeMcpConfigTask : DefaultTask() {

    @get:Input
    abstract val port: Property<Int>

    @get:Input
    abstract val projectName: Property<String>

    @get:Input
    @get:Optional
    abstract val applicationId: Property<String>

    /** npm version to pin `args` to, unless [mcpCommand] overrides the launch entirely. */
    @get:Input
    abstract val packageVersion: Property<String>

    /** See [PortholeExtension.mcpCommand]. Empty (the default) keeps the pinned npx launch. */
    @get:Input
    abstract val mcpCommand: ListProperty<String>

    /**
     * Deliberately not an `@OutputFile`. It lives in the source tree, not the
     * build directory, and letting Gradle treat it as task output would invite
     * `clean` to delete a file the project owns.
     */
    @get:Internal
    abstract val configFile: RegularFileProperty

    @get:Input
    @get:Optional
    abstract val overwrite: Property<Boolean>

    /**
     * The `env` block for the entry this task wants, built as data rather than
     * as interpolated JSON text — a Windows SDK path is full of characters
     * (`C:\`, spaces) that raw string interpolation would emit unescaped.
     * [JsonOutput] is what actually escapes them, at the point the whole
     * document is serialized in [write].
     */
    private fun entry(projectRoot: File, sdkDir: File?): Map<String, Any?> {
        val env = linkedMapOf<String, Any?>(
            "PORTHOLE_PORT" to port.get().toString(),
            "PORTHOLE_PROJECT_ROOT" to projectRoot.absolutePath,
        )
        // Omitted, not written empty, when it can't be resolved: adb.ts's
        // fallback walk is only correct behaviour if the variable's absence
        // is what triggers it.
        if (sdkDir != null) {
            env["PORTHOLE_SDK_DIR"] = sdkDir.absolutePath
        }
        // GRA-197: same rule as PORTHOLE_SDK_DIR above, and for the same
        // reason — the server treats absence as "no expectation, don't
        // check" rather than as an empty string to compare against, so an
        // unset applicationId must omit the key, not write it blank.
        applicationId.orNull?.let { env["PORTHOLE_APPLICATION_ID"] = it }

        val override = mcpCommand.get()
        val command: String
        val args: List<String>
        if (override.isNotEmpty()) {
            command = override.first()
            args = override.drop(1)
        } else {
            command = "npx"
            // GRA-193: the package declares two bins, `porthole` (the CLI) and
            // `porthole-mcp`. npx runs the one named like the package, so
            // without a subcommand this launched the CLI's usage screen,
            // which exited at once — an MCP client saw a server that started
            // and ended. `mcp` is the CLI branch that boots the same server
            // `dist/index.js` does.
            //
            // GRA-195: pinned to packageVersion, the same version portholeUi
            // and the runtime AAR resolve to, rather than the unqualified
            // package name npx would resolve to `latest` at launch time.
            args = listOf("-y", "$PORTHOLE_UI_PACKAGE@" + packageVersion.get(), "mcp")
        }
        return linkedMapOf(
            "command" to command,
            "args" to args,
            "env" to env,
        )
    }

    /**
     * The narrow case [write] auto-rewrites without `-Pporthole.overwrite=true`
     * (GRA-195 follow-up): [existing] and [wanted] name the same `command`,
     * the same `env`, and every `args` element but one, and that one element
     * differs only in the version pinned onto `PORTHOLE_UI_PACKAGE`'s `@`
     * suffix on both sides — exactly what changes between two runs of this
     * task across a plugin version bump and nothing else. Returns the (old,
     * new) version pair when that holds, or null the moment anything else
     * differs — including an [existing] entry written by [mcpCommand] (no
     * `@version` arg to compare) or one whose `args` is a different shape
     * entirely, both of which are exactly the deliberate-divergence case the
     * ordinary refusal exists to protect.
     */
    private fun versionOnlyDrift(existing: Map<String, Any?>, wanted: Map<String, Any?>): Pair<String, String>? {
        if (existing["command"] != wanted["command"] || existing["env"] != wanted["env"]) return null
        val existingArgs = existing["args"] as? List<*> ?: return null
        val wantedArgs = wanted["args"] as? List<*> ?: return null
        if (existingArgs.size != wantedArgs.size) return null

        var drift: Pair<String, String>? = null
        for (i in existingArgs.indices) {
            val e = existingArgs[i]
            val w = wantedArgs[i]
            if (e == w) continue
            // A second differing element means this is not a version-only
            // drift; bail rather than let the later ones silently win.
            if (drift != null) return null
            val eMatch = (e as? String)?.let(PACKAGE_ARG_PATTERN::find) ?: return null
            val wMatch = (w as? String)?.let(PACKAGE_ARG_PATTERN::find) ?: return null
            drift = eMatch.groupValues[1] to wMatch.groupValues[1]
        }
        return drift
    }

    @TaskAction
    fun write() {
        val file = configFile.get().asFile
        // configFile is always set to a path under the Gradle root project
        // directory (see PortholePlugin.registerTasks), so its parent IS that
        // directory — no second input needed to say so.
        val projectRoot = file.parentFile
        val sdkDir = resolveSdkDir(projectRoot)
        val json = JsonSlurper()

        @Suppress("UNCHECKED_CAST")
        val root: MutableMap<String, Any?> =
            if (file.isFile && file.readText().isNotBlank()) {
                (json.parseText(file.readText()) as? Map<String, Any?>)?.toMutableMap()
                    ?: throw GradleException("${file.name} is not a JSON object; leaving it alone.")
            } else {
                mutableMapOf()
            }

        @Suppress("UNCHECKED_CAST")
        val servers =
            (root["mcpServers"] as? Map<String, Any?>)?.toMutableMap() ?: mutableMapOf()

        val wanted = entry(projectRoot, sdkDir)
        val existing = servers["porthole"]

        if (existing == wanted) {
            logger.lifecycle("[porthole] ${file.name} already has a matching entry. Nothing to do.")
            return
        }

        // GRA-195 follow-up: a plugin bump moves packageVersion, which moves
        // `wanted`, which turns yesterday's matching entry into today's
        // "different entry" — the drift this ticket exists to remove, not
        // the hand-edited-on-purpose case the refusal below exists to guard.
        // [versionOnlyDrift] is the narrow proof that nothing else about the
        // entry changed, so this is applied even without
        // -Pporthole.overwrite=true; anything wider than the version suffix
        // — a different command, a different port, a hand-added env var —
        // still falls through to the refusal.
        @Suppress("UNCHECKED_CAST")
        val versionDrift = (existing as? Map<String, Any?>)?.let { versionOnlyDrift(it, wanted) }

        if (existing != null && overwrite.getOrElse(false) != true && versionDrift == null) {
            logger.lifecycle("[porthole] ${file.name} already defines 'porthole', and it differs:")
            logger.lifecycle("  there: ${JsonOutput.toJson(existing)}")
            logger.lifecycle("  here:  ${JsonOutput.toJson(wanted)}")
            logger.lifecycle(
                "Left as it is — a different entry is usually deliberate. " +
                    "Re-run with -Pporthole.overwrite=true to replace it.",
            )
            return
        }

        servers["porthole"] = wanted
        root["mcpServers"] = servers

        // Back the file up before rewriting it. Merging reformats the whole
        // document, and someone should be able to get their formatting back.
        if (file.isFile) {
            file.copyTo(File(file.parentFile, "${file.name}.bak"), overwrite = true)
        }
        file.parentFile?.mkdirs()
        file.writeText(JsonOutput.prettyPrint(JsonOutput.toJson(root)) + "\n")

        val what = if (existing != null) "replaced the entry in" else "added porthole to"
        logger.lifecycle("[porthole] $what ${file.path}")
        if (versionDrift != null) {
            logger.lifecycle(
                "[porthole] npm package pin moved from ${versionDrift.first} to ${versionDrift.second}",
            )
        }
        if (file.resolveSibling("${file.name}.bak").isFile) {
            logger.lifecycle("[porthole] previous contents: ${file.name}.bak")
        }
        logger.lifecycle(
            "[porthole] next: ./gradlew portholeConnect, launch the debug build, " +
                "and the tools go live in ${projectName.get()}.",
        )
        logger.lifecycle(
            if (sdkDir != null) {
                "[porthole] PORTHOLE_SDK_DIR: ${sdkDir.absolutePath}"
            } else {
                "[porthole] PORTHOLE_SDK_DIR: not resolved (no sdk.dir in local.properties, " +
                    "no ANDROID_HOME/ANDROID_SDK_ROOT) — omitted; the MCP server falls back to its own walk."
            },
        )
    }
}

/**
 * `sdk.dir` from `local.properties` in [projectRoot], falling back to
 * `ANDROID_HOME` then `ANDROID_SDK_ROOT`. The one SDK-directory resolver for
 * this module (GRA-150) — [PortholePlugin] calls this too, to resolve `adb`,
 * rather than keeping its own copy. The two had drifted apart only in the
 * sense that a bug fix (the blank-`sdk.dir` handling below) had to be applied
 * to both by hand; nothing about them was ever meant to differ.
 *
 * `Properties.load` is what does the real work here: `local.properties` is
 * Java-properties-escaped (a Windows path's drive-letter colon and every
 * backslash come out doubled), and `Properties` un-escapes that on read the
 * same way it always has.
 *
 * A present-but-blank `sdk.dir=` is treated as absent rather than as a path.
 * `File("")` is not nothing: its `absolutePath` is the current working
 * directory, so a blank line would have written the Gradle daemon's cwd into
 * `.mcp.json` as the Android SDK — a confidently wrong answer, and worse than
 * the omission that lets the MCP server fall back to its own walk.
 *
 * GRA-150, AC3: a *relative* `sdk.dir` is resolved against [projectRoot], not
 * against this JVM's own working directory. `File(it).absolutePath` alone
 * would do the latter — a Gradle daemon is a long-lived process the launcher
 * reuses across unrelated project directories, so its `user.dir` is wherever
 * the daemon happened to start, not wherever the build was invoked from —
 * and that answer was silently wrong before this ticket rather than merely
 * unlikely: `local.properties` is text a person can hand-edit, and Android
 * Studio's own writes are always absolute, so the relative case is rare but
 * not hypothetical.
 *
 * The absolute case has to be handled explicitly rather than left to
 * `File(projectRoot, it)`: on Windows, `java.io.File`'s two-argument
 * constructor does *not* discard the parent just because the child looks
 * absolute — `File(File("C:\\a"), "C:\\b")` is `C:\a\b`, not `C:\b`, whenever
 * parent and child share a drive letter (`WinNTFileSystem.resolve`, working
 * as documented — a real quirk, not a bug — but the wrong tool here). This
 * cost an hour to a failing `Windows-shaped path` test before the explicit
 * `isAbsolute` check below was added; the mistake is worth naming so nobody
 * reaches for the two-argument constructor here again. `File(it).isAbsolute`
 * correctly recognises a *fully* absolute drive-letter path (`C:\…`) and a UNC
 * path, and correctly refuses a POSIX-shaped `/…` on Windows (it belongs to
 * the current drive, not the filesystem root), matching the platform-dependent
 * shapes this file's tests already document. It does **not** recognise a
 * drive-letter path with no separator after the colon (`C:foo`) as absolute —
 * that shape gets its own check below, because it is not "relative" either.
 *
 * GRA-150 QA: a **drive-relative** `sdk.dir` — `C:foo`, meaning "foo, relative
 * to whatever the current directory on drive C happens to be", a real Windows
 * path concept distinct from both absolute and ordinary-relative — is not
 * absolute by `File.isAbsolute`'s definition, so it fell into the
 * `File(projectRoot, it)` branch on the first pass of this fix. That branch
 * does not "resolve it against projectRoot" for this shape; `WinNTFileSystem`
 * splices the two strings together as `<projectRoot>\C:foo`, a colon inside a
 * path segment that Windows refuses to open — worse than doing nothing, and
 * worse than what this function did before GRA-150 (`File(it).absolutePath`
 * alone, which Windows resolves against the drive's own current directory: a
 * valid path, merely not anchored to the project). There is no reliable way
 * to ask the JVM what "the current directory on drive C" is, so rather than
 * invent an answer, this shape is deliberately left exactly as it resolved
 * before this ticket: [isWindowsDriveRelative] routes it to `candidate`
 * unjoined, matching `main`'s old behaviour on the one input where this
 * ticket would otherwise have made things worse. On every other platform a
 * colon is an ordinary filename character, so `C:foo` there is exactly as
 * relative as it looks and takes the normal `File(projectRoot, it)` branch.
 *
 * `mcp/src/adb.ts`'s `sdkDirFromLocalProperties` does not resolve a relative
 * value at all today — it returns the raw string from the file, and whatever
 * eventually stats it resolves that string against its own process's cwd —
 * so it does not yet agree with the answer here; see this ticket's report for
 * why that is a TypeScript-side follow-up rather than a change made from this
 * file.
 */
internal fun resolveSdkDir(projectRoot: File): File? {
    val local = File(projectRoot, "local.properties")
    if (local.isFile) {
        val props = Properties()
        local.inputStream().use(props::load)
        props.getProperty("sdk.dir")?.takeIf { it.isNotBlank() }?.let {
            val candidate = File(it)
            return when {
                candidate.isAbsolute -> candidate
                isWindowsDriveRelative(it) -> candidate
                else -> File(projectRoot, it)
            }
        }
    }
    return sequenceOf("ANDROID_HOME", "ANDROID_SDK_ROOT")
        .mapNotNull { System.getenv(it) }
        .filter { it.isNotBlank() }
        .map(::File)
        .firstOrNull { it.isDirectory }
}

/**
 * True for a Windows drive-relative path — a letter, a colon, and then
 * anything other than a separator (`C:foo`, or bare `C:`) — which is neither
 * absolute (`File.isAbsolute` says so correctly) nor safely joinable with a
 * parent (see the comment on [resolveSdkDir]). Gated on [isWindowsHost]
 * because the same string is an unremarkable relative filename everywhere
 * else: a colon is legal in a POSIX filename, and `File(projectRoot, "C:foo")`
 * there is a normal, correct join.
 */
private fun isWindowsDriveRelative(value: String): Boolean =
    isWindowsHost() && value.length >= 2 && value[0].isLetter() && value[1] == ':' &&
        (value.length == 2 || (value[2] != '\\' && value[2] != '/'))

private fun isWindowsHost(): Boolean =
    System.getProperty("os.name").orEmpty().lowercase().contains("win")

/**
 * Fetches Perfetto's trace_processor, once, and says where it went.
 *
 * Separate from everything else and never run on its own: a 77MB download is
 * not something to trigger as a side effect of applying a plugin. Ask for it
 * and it arrives; otherwise nothing here touches the network.
 *
 * Already-present copies are left alone, including one the developer installed
 * themselves — the point is to remove a chore, not to take ownership of a tool
 * that is not ours.
 */
abstract class PortholeTraceProcessorTask : DefaultTask() {

    /** Set to re-download over a cached copy. Rarely wanted. */
    @get:Input
    @get:Optional
    abstract val refresh: Property<Boolean>

    @TaskAction
    fun fetch() {
        val platform = TraceProcessor.platform()
            ?: throw GradleException(
                "No trace_processor build for ${System.getProperty("os.name")} " +
                    "${System.getProperty("os.arch")}. Perfetto publishes Windows, macOS and " +
                    "Linux on amd64 and arm64; see github.com/google/perfetto/releases.",
            )

        val home = File(System.getProperty("user.home"))
        val target = File(TraceProcessor.cacheDir(home), TraceProcessor.binaryName(platform))
        if (target.isFile && refresh.getOrElse(false) != true) {
            logger.lifecycle("[porthole] trace_processor already at ${target.absolutePath}")
            report(target)
            return
        }

        val expected = TraceProcessor.expectedSha256(platform)
            ?: throw GradleException("No pinned checksum for $platform; refusing to download it.")

        val url = TraceProcessor.url(platform)
        logger.lifecycle("[porthole] downloading trace_processor ${TraceProcessor.VERSION} for $platform")
        logger.lifecycle("[porthole] from $url")

        target.parentFile.mkdirs()
        val archive = File(target.parentFile, "$platform.zip")
        URI(url).toURL().openStream().use { input ->
            archive.outputStream().use { output -> input.copyTo(output) }
        }

        // Before unzipping, not after: an archive that is not the one this
        // plugin was written against should never be opened at all.
        val actual = TraceProcessor.sha256(archive)
        if (actual != expected) {
            archive.delete()
            throw GradleException(
                "Checksum mismatch for $platform.zip.\n" +
                    "  expected $expected\n" +
                    "  got      $actual\n" +
                    "Nothing was extracted. Either the release was re-cut or the download was " +
                    "tampered with; in both cases this plugin's pin is the thing to trust.",
            )
        }

        extract(archive, target)
        archive.delete()

        if (!target.isFile) {
            throw GradleException(
                "The archive verified but held no ${TraceProcessor.binaryName(platform)}. " +
                    "The release layout may have changed.",
            )
        }
        target.setExecutable(true)
        logger.lifecycle("[porthole] verified and extracted to ${target.absolutePath}")
        report(target)
    }

    /** Pulls the one file out of the release archive, wherever it sits in it. */
    private fun extract(archive: File, target: File) {
        val wanted = target.name
        ZipFile(archive).use { zip ->
            val entry = zip.entries().asSequence().firstOrNull {
                !it.isDirectory && File(it.name).name == wanted
            } ?: return
            zip.getInputStream(entry).use { input ->
                target.outputStream().use { output -> input.copyTo(output) }
            }
        }
    }

    private fun report(binary: File) {
        logger.lifecycle(
            "[porthole] the MCP server finds it here on its own. To use it from a shell:\n" +
                "  PORTHOLE_TRACE_PROCESSOR=${binary.absolutePath}",
        )
    }
}

/**
 * Runs the timeline UI, which lives in the npm package alongside the MCP server.
 *
 * It blocks until you stop it, the way a run task does, because the thing it
 * starts is a server you are meant to be watching. Node is required: the UI is
 * a web app, and duplicating it into the AAR to avoid one `npx` would mean
 * shipping a second copy of it inside every debug build.
 */
abstract class PortholeUiTask : DefaultTask() {

    @get:Inject
    abstract val exec: ExecOperations

    @get:Input
    abstract val port: Property<Int>

    @get:Input
    @get:Optional
    abstract val serial: Property<String>

    @get:Input
    abstract val packageVersion: Property<String>

    @get:Input
    abstract val overrideCommand: ListProperty<String>

    @TaskAction
    fun run() {
        val launcher = overrideCommand.get().ifEmpty {
            listOf(
                if (isWindows()) "npx.cmd" else "npx",
                "-y",
                "--package",
                "$PORTHOLE_UI_PACKAGE@" + packageVersion.get(),
                "porthole",
                "ui",
            )
        }

        val command = buildList {
            addAll(launcher)
            add("--port")
            add(port.get().toString())
            serial.orNull?.let {
                add("--serial")
                add(it)
            }
        }

        logger.lifecycle("[porthole] starting the timeline UI; ctrl-c to stop")
        val result = exec.exec {
            commandLine(command)
            isIgnoreExitValue = true
        }
        if (result.exitValue != 0) {
            throw GradleException(
                "The timeline UI exited with " + result.exitValue + ".\n" +
                    "It needs Node on your PATH. Without it, run the tools through your " +
                    "agent instead, or install Node and try again.",
            )
        }
    }

    private fun isWindows(): Boolean =
        System.getProperty("os.name").orEmpty().lowercase().contains("win")
}

internal fun adbArgs(adb: String, serial: String?, vararg rest: String): List<String> = buildList {
    add(adb)
    if (!serial.isNullOrBlank()) {
        add("-s")
        add(serial)
    }
    addAll(rest)
}

/** Matches a pinned `args` element (`@gravitylabsllc/porthole@1.2.3`), capturing the version. */
private val PACKAGE_ARG_PATTERN = Regex("^" + Regex.escape(PORTHOLE_UI_PACKAGE) + "@(.+)$")
