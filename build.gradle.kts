import java.io.ByteArrayOutputStream
import java.time.LocalDate

plugins {
    // Every plugin the subprojects use has to be declared here, even though
    // none of them are applied at the root: that is what puts a single agreed
    // version on the build classpath.
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.compose.compiler) apply false
    alias(libs.plugins.maven.publish) apply false
    alias(libs.plugins.dokka) apply false
}

// Read here rather than inside `subprojects`, where `libs` is not in scope:
// the accessor belongs to this script, not to each subproject.
//
// From the catalog rather than gradle.properties because the plugin's own
// build reads the same entry, and a release where those two disagree publishes
// a plugin pointing at a runtime version nobody published.
val portholeVersion = libs.versions.porthole.get()

subprojects {
    group = providers.gradleProperty("GROUP").get()
    version = portholeVersion
}

// The Gradle plugin is a separate build, pulled in by `pluginManagement {
// includeBuild("gradle-plugin") }` in settings.gradle.kts. Nothing connects an
// included build's lifecycle to the including build's, so `./gradlew test` used
// to walk the three Android subprojects and stop — and the plugin's tests, one
// of which is the only guard against `porthole` in the version catalog drifting
// away from the version in mcp/package.json, never ran under the command the
// README tells you to run. They passed only when someone remembered to type
// `-p gradle-plugin test`, which is exactly the kind of thing nobody remembers.
//
// `register` rather than `named`: `./gradlew test` matches tasks named `test`
// anywhere in the project hierarchy, which is why the subprojects' tests run,
// but no plugin is applied at the root so the root project itself has no `test`
// or `check` to configure. Registering them adds the root's own entry to that
// match; the subprojects keep contributing theirs independently.
val pluginBuild = gradle.includedBuild("gradle-plugin")

tasks.register("test") {
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    description = "Runs the Gradle plugin's tests, which live in an included build."
    dependsOn(pluginBuild.task(":test"))
}

tasks.register("check") {
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    description = "Runs the Gradle plugin's checks, which live in an included build."
    dependsOn(pluginBuild.task(":check"))
}

// -----------------------------------------------------------------------
// release / releaseDryRun
//
// Four registries, four commands, by hand, in an order that matters — this
// replaces the bump-and-tag half of that with one local command. It does
// NOT replace the publish half: `release` prints the four publish commands
// and runs none of them, because publishing stays a deliberate, credentialed
// act a person takes separately.
//
// Both tasks below shell out to git, npm and — this part is not a style
// choice — a *fresh* `./gradlew` process for every step that depends on the
// version this task is about to change or has just changed. The reason is
// structural: Gradle fixes a build's task graph during configuration, before
// any task action runs. `subprojects { version = portholeVersion }` above
// read `gradle/libs.versions.toml` once, when *this* build configured. By
// the time `release`'s action rewrites that file, every project this build
// already configured — this one included — is holding the version that was
// true a moment ago, and there is no Gradle API to reopen configuration
// mid-run or to invoke another task from inside a running task's action. A
// person typing the next command by hand does not have this problem; a
// single task pretending to be that person does not either, as long as it
// actually starts a new process for the parts that need the new value.
// Both tasks are marked `notCompatibleWithConfigurationCache` for the same
// reason `publishPlugins` is in gradle-plugin/build.gradle.kts, but for a
// simpler cause here: a task that commits, tags, or shells out to another
// build must never be reported UP-TO-DATE or replayed FROM-CACHE, and the
// annotation is what tells Gradle that in advance rather than by accident.
// -----------------------------------------------------------------------

val releaseIncompatibleWithCache =
    "orchestrates git, npm and nested Gradle processes with real side effects; " +
        "must always fully execute, never be reported UP-TO-DATE or replayed FROM-CACHE"

// `Project.exec` rather than the injected `ExecOperations` or
// `ProviderFactory.exec`: both tasks below already opt out of the
// configuration cache above, which is the thing `Project.exec` being
// deprecated is actually warning about, so the migration buys nothing here
// and the plain, blocking, "run this and tell me if it failed" form is the
// easiest one to read and audit for a task whose whole job is real side
// effects taken once. Revisit if Gradle 9 actually removes it.

val isWindowsOs = System.getProperty("os.name").orEmpty().lowercase().contains("win")

fun gradlewCommand(vararg args: String): List<String> {
    val wrapper = if (isWindowsOs) "gradlew.bat" else "gradlew"
    return listOf(rootDir.resolve(wrapper).absolutePath) + args
}

// npm on Windows is a shim (.cmd), which the JVM's process launcher cannot
// exec directly the way it execs a real binary — it needs a shell in front
// of it. Nothing analogous is needed for git or gradlew, which are real
// executables on every platform this runs on.
fun npmCommand(vararg args: String): List<String> =
    if (isWindowsOs) listOf("cmd", "/c", "npm") + args else listOf("npm") + args

fun gitOutput(vararg args: String): String {
    val out = ByteArrayOutputStream()
    exec {
        commandLine(listOf("git") + args)
        standardOutput = out
    }
    return out.toString(Charsets.UTF_8.name()).trim()
}

/** Reads one `key = "value"` entry under `[versions]` in a TOML catalog. */
fun readCatalogEntry(catalogFile: File, key: String): String {
    val text = catalogFile.readText()
    val match = Regex("""^$key\s*=\s*"([^"]+)"""", RegexOption.MULTILINE).find(text)
    return requireNotNull(match) { "no `$key` entry under [versions] in $catalogFile" }.groupValues[1]
}

fun writeCatalogVersion(catalogFile: File, newVersion: String) {
    val text = catalogFile.readText()
    val pattern = Regex("""^porthole\s*=\s*"[^"]+"""", RegexOption.MULTILINE)
    require(pattern.containsMatchIn(text)) { "no `porthole` entry under [versions] in $catalogFile" }
    catalogFile.writeText(pattern.replaceFirst(text, "porthole = \"$newVersion\""))
}

// Anchored to the start of a line on purpose: this file's own intro prose
// mentions `` `## [Unreleased]` `` inline as documentation, and a plain
// substring search (`String.indexOf`) matched that mention instead of the
// actual heading — found by running `release` for real in a scratch clone,
// where it silently mistook the whole Unreleased section for empty. Only a
// `##` at column zero is a heading; nothing that appears mid-line counts.
val changelogUnreleasedHeadingPattern = Regex("""^## \[Unreleased\]""", RegexOption.MULTILINE)
val changelogVersionHeadingPattern = Regex("""^## \[""", RegexOption.MULTILINE)

/** The `[bodyStart, bodyEnd)` offsets between `## [Unreleased]` and the next `## [` heading (or EOF). */
fun changelogUnreleasedBounds(changelog: String): Pair<Int, Int> {
    val heading = changelogUnreleasedHeadingPattern.find(changelog)
    requireNotNull(heading) { "CHANGELOG.md has no '## [Unreleased]' heading at the start of a line" }
    val bodyStart = changelog.indexOf('\n', heading.range.last).let { if (it < 0) changelog.length else it + 1 }
    val next = changelogVersionHeadingPattern.find(changelog, bodyStart)
    val bodyEnd = next?.range?.first ?: changelog.length
    return bodyStart to bodyEnd
}

fun changelogUnreleasedBody(changelog: String): String {
    val (bodyStart, bodyEnd) = changelogUnreleasedBounds(changelog)
    return changelog.substring(bodyStart, bodyEnd)
}

/** A `### Heading` with no `- ` entries under it is not a change, just a label. */
fun hasReleasableChanges(unreleasedBody: String): Boolean =
    unreleasedBody.lineSequence().any { it.trimStart().startsWith("- ") }

/**
 * Moves the Unreleased body into a new dated section and leaves a fresh,
 * empty Unreleased behind for whatever lands next. Subsections that carried
 * no entries are dropped rather than carried forward empty.
 */
fun cutChangelog(changelog: String, newVersion: String, date: String): String {
    val (bodyStart, bodyEnd) = changelogUnreleasedBounds(changelog)
    val body = changelog.substring(bodyStart, bodyEnd)

    val carried = body.split(Regex("""(?=^### )""", RegexOption.MULTILINE))
        .filter { section -> section.lineSequence().any { it.trimStart().startsWith("- ") } }
        .joinToString("") { it.trimEnd('\n') + "\n\n" }
        .trimEnd('\n')

    val freshUnreleased = "\n### Added\n\n### Changed\n\n### Fixed\n\n"
    val datedSection = "## [$newVersion] - $date\n\n$carried\n\n"

    return (changelog.substring(0, bodyStart) + freshUnreleased + datedSection + changelog.substring(bodyEnd))
        .replace(Regex("""\n{3,}"""), "\n\n")
}

/**
 * The paths `npm pack` would ship, with the Vite content hash in the UI
 * asset filenames normalised to `*` — see the comment at the top of
 * mcp/expected-package-files.txt for why: it changes on every UI edit and
 * says nothing about what the package contains.
 */
fun npmPackFiles(packJson: String): Set<String> {
    val parsed = groovy.json.JsonSlurper().parseText(packJson)
    @Suppress("UNCHECKED_CAST")
    val pkg = (parsed as List<Map<String, Any?>>).first()
    @Suppress("UNCHECKED_CAST")
    val files = pkg["files"] as List<Map<String, Any?>>
    val hashedAsset = Regex("""^(ui/dist/assets/index)-[^./]+(\.(?:js|css))$""")
    return files.map { it["path"] as String }
        .map { path -> hashedAsset.replace(path) { m -> "${m.groupValues[1]}-*${m.groupValues[2]}" } }
        .toSet()
}

/**
 * The consumer path README.md's Publishing section describes: a separate
 * project, no `includeBuild`, `mavenLocal()` added to both repository blocks,
 * the plugin applied by id. Generated fresh each run rather than checked in,
 * because its only job is to prove that *this* run's `publishToMavenLocal`
 * actually produced something a real consumer could resolve.
 */
fun writeScratchConsumer(dir: File, portholeVersion: String, agpVersion: String) {
    dir.deleteRecursively()
    fun write(path: String, text: String) {
        val target = File(dir, path)
        target.parentFile.mkdirs()
        target.writeText(text)
    }
    write(
        "gradle.properties",
        """
        # The runtime AAR pulls in AndroidX (Compose) transitively, and AGP
        # refuses to resolve those against a project that has not opted in.
        android.useAndroidX=true
        """.trimIndent() + "\n",
    )
    write(
        "settings.gradle.kts",
        """
        pluginManagement {
            repositories {
                mavenLocal()
                google()
                mavenCentral()
                gradlePluginPortal()
            }
        }
        dependencyResolutionManagement {
            repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
            repositories {
                mavenLocal()
                google()
                mavenCentral()
            }
        }
        rootProject.name = "porthole-release-dry-run-consumer"
        include(":app")
        """.trimIndent() + "\n",
    )
    write(
        "app/build.gradle.kts",
        """
        plugins {
            id("com.android.application") version "$agpVersion"
            id("live.gravitylabs.porthole") version "$portholeVersion"
        }

        android {
            namespace = "live.gravitylabs.porthole.dryrun"
            compileSdk = 35
            defaultConfig {
                applicationId = "live.gravitylabs.porthole.dryrun"
                minSdk = 26
                targetSdk = 35
            }
            compileOptions {
                sourceCompatibility = JavaVersion.VERSION_17
                targetCompatibility = JavaVersion.VERSION_17
            }
        }
        """.trimIndent() + "\n",
    )
    write(
        "app/src/main/AndroidManifest.xml",
        """
        <manifest xmlns:android="http://schemas.android.com/apk/res/android">
            <application />
        </manifest>
        """.trimIndent() + "\n",
    )
}

val releaseVersionPattern = Regex("""\d+\.\d+\.\d+(-.+)?""")

tasks.register("release") {
    group = "release"
    description = "Bumps the version, updates the changelog, runs the full suite, commits and tags. " +
        "Never publishes — see releaseDryRun and the four commands this prints instead of running."
    notCompatibleWithConfigurationCache(releaseIncompatibleWithCache)

    doLast {
        val newVersion = providers.gradleProperty("version").orNull
            ?: throw GradleException("release needs -Pversion=X.Y.Z")
        if (!releaseVersionPattern.matches(newVersion)) {
            throw GradleException("version must look like X.Y.Z or X.Y.Z-suffix; got '$newVersion'")
        }

        val branch = gitOutput("rev-parse", "--abbrev-ref", "HEAD")
        if (branch != "main") {
            throw GradleException("release only runs on main; the current branch is '$branch'")
        }

        val dirty = gitOutput("status", "--porcelain")
        if (dirty.isNotBlank()) {
            throw GradleException("release needs a clean working tree; 'git status --porcelain' is not empty")
        }

        val changelogFile = file("CHANGELOG.md")
        val changelogText = changelogFile.readText()
        if (!hasReleasableChanges(changelogUnreleasedBody(changelogText))) {
            throw GradleException(
                "CHANGELOG.md's Unreleased section has no entries; add one before releasing $newVersion",
            )
        }

        logger.lifecycle("release: writing porthole = \"$newVersion\"")
        val catalogFile = file("gradle/libs.versions.toml")
        writeCatalogVersion(catalogFile, newVersion)

        // Fresh process: see the note above this section for why this cannot
        // be a task dependency of `release` itself.
        exec { commandLine(gradlewCommand("-p", "gradle-plugin", "generateMcpPackageVersion", "--rerun-tasks")) }

        logger.lifecycle("release: running the full check and both builds")
        exec { commandLine(gradlewCommand("check", "build", "--rerun-tasks")) }

        logger.lifecycle("release: running both npm suites")
        exec { commandLine(npmCommand("ci")); workingDir = file("mcp") }
        exec { commandLine(npmCommand("run", "build")); workingDir = file("mcp") }
        exec { commandLine(npmCommand("test")); workingDir = file("mcp") }
        exec { commandLine(npmCommand("run", "test:ui")); workingDir = file("mcp") }

        logger.lifecycle("release: cutting CHANGELOG.md")
        changelogFile.writeText(cutChangelog(changelogText, newVersion, LocalDate.now().toString()))

        exec { commandLine(listOf("git", "add", "--", "gradle/libs.versions.toml", "mcp/package.json", "CHANGELOG.md")) }
        exec { commandLine(listOf("git", "commit", "-m", "Release v$newVersion")) }
        exec { commandLine(listOf("git", "tag", "-a", "v$newVersion", "-m", "v$newVersion")) }

        println(
            """
            |
            |Release v$newVersion committed and tagged. Nothing has been published.
            |Publish, in this order, when ready:
            |
            |  cd mcp && npm publish
            |  ./gradlew publishToMavenCentral
            |  ./gradlew -p gradle-plugin publishPlugins
            |  npx vercel deploy --prod
            |
            |Credentials for the first three live in ~/.gradle/gradle.properties or the
            |environment, never in this repo. publishToMavenCentral only stages —
            |SONATYPE_AUTOMATIC_RELEASE=false — and is promoted by hand afterwards.
            """.trimMargin(),
        )
    }
}

tasks.register("releaseDryRun") {
    group = "release"
    description = "Rehearses a release with no publishing credentials: npm pack, publishToMavenLocal plus a " +
        "real consumer resolution, and publishPlugins --validate-only. Never publishes."
    notCompatibleWithConfigurationCache(releaseIncompatibleWithCache)

    doLast {
        logger.lifecycle("releaseDryRun: npm pack --dry-run vs mcp/expected-package-files.txt")
        exec { commandLine(npmCommand("ci")); workingDir = file("mcp") }
        exec { commandLine(npmCommand("run", "build")); workingDir = file("mcp") }

        val packJson = ByteArrayOutputStream()
        exec {
            commandLine(npmCommand("pack", "--dry-run", "--json"))
            workingDir = file("mcp")
            standardOutput = packJson
        }
        val actualFiles = npmPackFiles(packJson.toString(Charsets.UTF_8.name()))
        val expectedFiles = file("mcp/expected-package-files.txt").readLines()
            .map(String::trim)
            .filter { it.isNotEmpty() && !it.startsWith("#") }
            .toSet()
        if (actualFiles != expectedFiles) {
            val missing = expectedFiles - actualFiles
            val unexpected = actualFiles - expectedFiles
            throw GradleException(
                buildString {
                    appendLine("npm pack --dry-run does not match mcp/expected-package-files.txt.")
                    if (missing.isNotEmpty()) appendLine("Missing from the tarball: $missing")
                    if (unexpected.isNotEmpty()) appendLine("Not in the expected list: $unexpected")
                },
            )
        }
        logger.lifecycle("releaseDryRun: npm pack matches (${actualFiles.size} files)")

        logger.lifecycle("releaseDryRun: publishToMavenLocal -PRELEASE_SIGNING_ENABLED=false")
        exec {
            commandLine(gradlewCommand("publishToMavenLocal", "-PRELEASE_SIGNING_ENABLED=false", "--rerun-tasks"))
        }

        val catalogFile = file("gradle/libs.versions.toml")
        val version = readCatalogEntry(catalogFile, "porthole")
        val agpVersion = readCatalogEntry(catalogFile, "agp")
        val consumerDir = layout.buildDirectory.dir("releaseDryRun/consumer").get().asFile
        writeScratchConsumer(consumerDir, version, agpVersion)

        logger.lifecycle("releaseDryRun: resolving the plugin and the AAR from mavenLocal() in a separate project")
        exec {
            commandLine(
                gradlewCommand(
                    "--project-dir", consumerDir.absolutePath,
                    ":app:dependencies", "--configuration", "debugRuntimeClasspath",
                    "--rerun-tasks",
                ),
            )
        }

        // Not `publishPlugins --validate-only`: measured against the real
        // Portal, that flag still POSTs the plugin bundle with real
        // credentials — it came back "Plugin ... exists already" rather than
        // actually publishing only because 0.1.0 already happens to be there.
        // Pointed at a version that had never been published, the same call
        // would have published it. That is the opposite of what a task
        // required to run with no publishing credentials, on a clean
        // checkout, is for. `validatePlugins` — from `java-gradle-plugin`,
        // not `com.gradle.plugin-publish` — checks the plugin's own
        // structure (task and artifact-transform parameter annotations)
        // entirely locally, with no network call and nothing to authenticate.
        // It does not check the Portal-side metadata (id, tags, description)
        // the way `publishPlugins` does, but nothing that stays local can.
        logger.lifecycle("releaseDryRun: validatePlugins (local only; publishPlugins --validate-only still calls the Portal)")
        exec { commandLine(gradlewCommand("-p", "gradle-plugin", "validatePlugins", "--rerun-tasks")) }

        println(
            """
            |
            |releaseDryRun OK for v$version. Nothing was published:
            |
            |  npm pack would ship ${actualFiles.size} files, matching mcp/expected-package-files.txt
            |  publishToMavenLocal produced live.gravitylabs.porthole:runtime:$version and
            |    :runtime-noop:$version, and a separate project (no includeBuild) resolved both
            |    of those plus the plugin itself from mavenLocal() alone
            |  validatePlugins found no problems with the plugin's own structure, entirely locally
            |
            |A real release still ends with the four commands `release` prints — this only
            |proves each one would have something real to publish.
            """.trimMargin(),
        )
    }
}
