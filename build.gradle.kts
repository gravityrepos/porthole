import java.io.ByteArrayOutputStream
import java.time.LocalDate
import live.gravitylabs.porthole.release.changelogUnreleasedBody
import live.gravitylabs.porthole.release.cutChangelog
import live.gravitylabs.porthole.release.validateCleanTree
import live.gravitylabs.porthole.release.validateHasReleasableChanges
import live.gravitylabs.porthole.release.validateReleaseBranch
import live.gravitylabs.porthole.release.validateReleaseVersion

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

// `buildSrc` is where the release-tasks changelog parser and gates live now
// (GRA-100 fix pass: they need to be unit tested, and a Kotlin script body
// cannot be imported by a test). Unlike gradle-plugin, buildSrc is not an
// included build `./gradlew test` can add as a task dependency — Gradle
// builds and compiles it automatically to configure this script, but does
// not expose it through `gradle.includedBuild(...)` the way `pluginBuild`
// above is exposed, and does not run its own `test` task as a side effect of
// anything short of asking for it by name. Proven by running `./gradlew
// help` with a deliberately failing buildSrc test in place: BUILD SUCCESSFUL.
// So `test`/`check` fork a fresh process for `-p buildSrc test`, the same
// structural move `release` already makes for `-p gradle-plugin` and for the
// same reason: nothing else reaches across the build boundary.
//
// Registered as `Exec`, not an ad-hoc task with `doLast { exec { ... } } `
// (GRA-227): that `exec` is the `Project.exec` extension, and `gradlewCommand`
// is a function defined in this very script, so calling either one from
// inside a `doLast` lambda implicitly captures this build script object in
// the task's action — and the configuration cache cannot serialize a script
// object reference at all, so every `check` discarded the whole configuration
// cache entry with "cannot serialize Gradle script object references",
// `notCompatibleWithConfigurationCache` notwithstanding: that annotation
// tolerates a task whose *problems* are downgraded, not one whose action
// closes over something the cache format has no representation for. `Exec`'s
// own `commandLine` is resolved once, right here, at configuration time —
// gradlewCommand(...) still runs, but its result is a plain `List<String>`
// handed to a real task input, with nothing of the script itself captured
// into anything that has to survive past configuration.
val buildSrcTest = tasks.register<Exec>("buildSrcTest") {
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    description = "Runs buildSrc's tests (the release-tasks changelog parser and gates) via a fresh process."
    commandLine(gradlewCommand("-p", "buildSrc", "test", "--rerun-tasks"))
}
tasks.named("test") { dependsOn(buildSrcTest) }
tasks.named("check") { dependsOn(buildSrcTest) }

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

// The CHANGELOG.md parser (changelogUnreleasedBody, hasReleasableChanges,
// cutChangelog) and the release-version/branch/tree gates (validateRelease*)
// used to live here inline. They moved to buildSrc (GRA-100 fix pass) so
// they can be unit tested — see buildSrc/src/main/kotlin/live/gravitylabs/porthole/release
// and the imports at the top of this file.

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
        // The live.gravitylabs.porthole group — the plugin marker, runtime
        // and runtime-noop alike — may come only from the isolated
        // mavenLocal() this run just published into, never from Google,
        // Maven Central or the Plugin Portal, even though this consumer
        // deliberately keeps those reachable for everything else (AGP
        // itself, AndroidX transitively). Without exclusiveContent scoping
        // this by group, the day the Plugin Portal approves
        // live.gravitylabs.porthole, a marker sitting there but never
        // published to this run's mavenLocal() would resolve from the
        // Portal instead, and this whole check would go green having
        // proved nothing about what publishToMavenLocal just did
        // (GRA-100 QA, second pass).
        pluginManagement {
            repositories {
                exclusiveContent {
                    forRepository { mavenLocal() }
                    filter { includeGroup("live.gravitylabs.porthole") }
                }
                google()
                mavenCentral()
                gradlePluginPortal()
            }
        }
        dependencyResolutionManagement {
            repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
            repositories {
                exclusiveContent {
                    forRepository { mavenLocal() }
                    filter { includeGroup("live.gravitylabs.porthole") }
                }
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

        // `:app:dependencies` is a *report* task: it renders an unresolved
        // dependency as "FAILED" inside the printed tree and still exits 0,
        // so it cannot be the thing releaseDryRun asserts against — it never
        // actually resolves anything (GRA-100 QA, second pass). Reading
        // `resolvedConfiguration.resolvedArtifacts` forces the same real
        // resolution `Configuration.resolve()` did and throws
        // (ResolveException, non-zero exit) the moment an artifact is
        // missing. Both classpaths are checked, not just debug's: the plugin
        // wires the debug build type to `runtime` and every other build type
        // to `runtime-noop` (AndroidWiring.kt), so only checking
        // debugRuntimeClasspath would leave runtime-noop untested.
        //
        // Resolving without success is not enough to prove either coordinate
        // is present (GRA-165): `porthole { enabled.set(false) }` makes
        // AndroidWiring.wire() return before adding any dependency at all
        // (AndroidWiring.kt:59), so both configurations still resolve — to
        // an empty, and therefore trivially successful, artifact set. The
        // plugin marker itself needs no separate check here: applying
        // `id("live.gravitylabs.porthole")` above already forced Gradle to
        // resolve it from this consumer's exclusiveContent-scoped
        // mavenLocal() before this build script could even configure, so a
        // withheld marker fails the whole run before `resolvePorthole` is
        // reached.
        tasks.register("resolvePorthole") {
            doLast {
                // No string templates in these messages: this whole file is
                // itself the text of an outer Kotlin string template one
                // level up (see writeScratchConsumer in the root
                // build.gradle.kts), which would try to interpolate a bare
                // ${'$'}configurationName here against its own scope, not
                // this one. Plain concatenation sidesteps that entirely.
                fun requirePortholeArtifact(configurationName: String, module: String) {
                    val artifacts = configurations.getByName(configurationName).resolvedConfiguration.resolvedArtifacts
                    check(
                        artifacts.any {
                            it.moduleVersion.id.group == "live.gravitylabs.porthole" && it.moduleVersion.id.name == module
                        },
                    ) {
                        configurationName + " resolved (" + artifacts.size + " artifacts) but none was " +
                            "live.gravitylabs.porthole:" + module + " — an empty or disabled porthole { } " +
                            "block resolves just as successfully as a real dependency does."
                    }
                }
                requirePortholeArtifact("debugRuntimeClasspath", "runtime")
                requirePortholeArtifact("releaseRuntimeClasspath", "runtime-noop")
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

tasks.register("release") {
    group = "release"
    description = "Bumps the version, updates the changelog, runs the full suite, commits and tags. " +
        "Never publishes — see releaseDryRun and the four commands this prints instead of running."
    notCompatibleWithConfigurationCache(releaseIncompatibleWithCache)

    doLast {
        // `-Pversion=X.Y.Z` is the primary form, but Windows PowerShell 5.1
        // — this project's primary shell — mangles an *unquoted* dotted
        // value on the command line before Gradle ever sees it: `gradlew
        // release -Pversion=0.2.0` arrives as the two tokens `-Pversion=0`
        // and `.2.0`, and Gradle reports "Task '.2.0' not found" long before
        // this task's own validation runs. Quoting the whole assignment
        // (`"-Pversion=0.2.0"`, documented in README.md) avoids that
        // entirely. $PORTHOLE_RELEASE_VERSION is a second way in for anyone
        // who would rather not depend on quoting a property value correctly
        // on every shell this ever runs on.
        val newVersion = validateReleaseVersion(
            providers.gradleProperty("version").orNull
                ?: providers.environmentVariable("PORTHOLE_RELEASE_VERSION").orNull,
        )
        validateReleaseBranch(gitOutput("rev-parse", "--abbrev-ref", "HEAD"))
        validateCleanTree(gitOutput("status", "--porcelain"))

        val changelogFile = file("CHANGELOG.md")
        val changelogText = changelogFile.readText()
        validateHasReleasableChanges(changelogUnreleasedBody(changelogText), newVersion)

        // From here on this task has real side effects on disk. A failure
        // partway through used to leave gradle/libs.versions.toml and
        // mcp/package.json bumped and uncommitted — release's own dirty-tree
        // gate then refused the very next attempt, and recovery was a manual
        // `git checkout --`. Both files are written only here, at run time,
        // never committed as part of this change, and rolled back to the
        // text read above if anything past this point throws.
        val catalogFile = file("gradle/libs.versions.toml")
        val packageJsonFile = file("mcp/package.json")
        val originalCatalogText = catalogFile.readText()
        val originalPackageJsonText = packageJsonFile.readText()
        fun rollBackVersionFiles() {
            logger.lifecycle("release: failed after bumping the version; rolling gradle/libs.versions.toml and mcp/package.json back")
            catalogFile.writeText(originalCatalogText)
            packageJsonFile.writeText(originalPackageJsonText)
        }

        try {
            logger.lifecycle("release: writing porthole = \"$newVersion\"")
            writeCatalogVersion(catalogFile, newVersion)

            // Fresh process: see the note above this section for why this
            // cannot be a task dependency of `release` itself.
            exec { commandLine(gradlewCommand("-p", "gradle-plugin", "generateMcpPackageVersion", "--rerun-tasks")) }

            logger.lifecycle("release: running the full check and both builds")
            exec { commandLine(gradlewCommand("check", "build", "--rerun-tasks")) }

            logger.lifecycle("release: running both npm suites")
            exec { commandLine(npmCommand("ci")); workingDir = file("mcp") }
            exec { commandLine(npmCommand("run", "build")); workingDir = file("mcp") }
            exec { commandLine(npmCommand("test")); workingDir = file("mcp") }
            exec { commandLine(npmCommand("run", "test:ui")); workingDir = file("mcp") }
        } catch (e: Exception) {
            rollBackVersionFiles()
            throw e
        }

        logger.lifecycle("release: cutting CHANGELOG.md")
        changelogFile.writeText(cutChangelog(changelogText, newVersion, LocalDate.now().toString()))

        val releaseFiles = listOf("gradle/libs.versions.toml", "mcp/package.json", "CHANGELOG.md")
        try {
            exec { commandLine(listOf("git", "add", "--") + releaseFiles) }
            exec { commandLine(listOf("git", "commit", "-m", "Release v$newVersion")) }
            exec { commandLine(listOf("git", "tag", "-a", "v$newVersion", "-m", "v$newVersion")) }
        } catch (e: Exception) {
            // `git add` may already have staged the bump; unstage before
            // restoring the working tree, or the index and HEAD disagree
            // even once the files on disk are back to what they were.
            exec { commandLine(listOf("git", "reset", "--") + releaseFiles) }
            changelogFile.writeText(changelogText)
            rollBackVersionFiles()
            throw e
        }

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
    description = "Rehearses a release with no publishing credentials: npm pack, publishToMavenLocal for both " +
        "the runtime AARs and the Gradle plugin, a real consumer resolution of all three, and validatePlugins. " +
        "Never publishes, and never calls publishPlugins or its --validate-only form."
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

        // The Gradle plugin is a separate included build (gradle-plugin/);
        // the root `publishToMavenLocal` above reaches only :runtime and
        // :runtime-noop, never :gradle-plugin — root `./gradlew
        // publishToMavenLocal --dry-run` shows an 82-task graph entirely
        // under `:runtime:*`/`:runtime-noop:*`, no `:gradle-plugin:*` task
        // in it anywhere. Without this, the consumer resolution below only
        // ever succeeded because some *earlier* command had left the plugin
        // sitting in this machine's ~/.m2 already — on a clean checkout, or
        // at any version after a real bump, it failed with "Plugin ... was
        // not found in any of the following sources" (GRA-100 QA). No
        // `-PRELEASE_SIGNING_ENABLED`: com.gradle.plugin-publish's
        // `publishToMavenLocal` has no signing task in its graph to gate —
        // confirmed with `-p gradle-plugin publishToMavenLocal --dry-run`.
        logger.lifecycle("releaseDryRun: publishToMavenLocal -p gradle-plugin")
        exec { commandLine(gradlewCommand("-p", "gradle-plugin", "publishToMavenLocal", "--rerun-tasks")) }

        val catalogFile = file("gradle/libs.versions.toml")
        val version = readCatalogEntry(catalogFile, "porthole")
        val agpVersion = readCatalogEntry(catalogFile, "agp")
        val consumerDir = layout.buildDirectory.dir("releaseDryRun/consumer").get().asFile
        writeScratchConsumer(consumerDir, version, agpVersion)

        logger.lifecycle("releaseDryRun: resolving the plugin and both AARs from mavenLocal() in a separate project")
        exec {
            commandLine(
                gradlewCommand(
                    "--project-dir", consumerDir.absolutePath,
                    ":app:resolvePorthole",
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
            |  publishToMavenLocal (root, then -p gradle-plugin) produced
            |    live.gravitylabs.porthole:runtime:$version, :runtime-noop:$version and the plugin
            |    itself, and a separate project (no includeBuild, and scoped so the
            |    live.gravitylabs.porthole group can resolve only from mavenLocal()) actually
            |    resolved the plugin marker plus both the debug and release runtime
            |    classpaths — the same resolution a real consumer app performs, and one that
            |    fails loudly and non-zero if the marker, runtime, or runtime-noop is missing
            |  validatePlugins found no problems with the plugin's own structure, entirely locally
            |
            |A real release still ends with the four commands `release` prints — this only
            |proves three of them (not npx vercel deploy --prod, which this task never
            |touches) would have something real to publish.
            """.trimMargin(),
        )
    }
}
