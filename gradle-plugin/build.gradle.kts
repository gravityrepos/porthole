plugins {
    `kotlin-dsl`
    id("com.gradle.plugin-publish") version "1.3.1"
}

group = "live.gravitylabs.porthole"
// The same catalog entry the rest of the build uses. This is an included build
// and its settings point `libs` at the root file.
version = libs.versions.porthole.get()

/**
 * The version, as a constant the plugin can read.
 *
 * Generated rather than typed, because the plugin hands this to consumers as
 * the runtime dependency to resolve. A literal here that disagrees with the
 * published version does not fail this build or the publish — it fails, later,
 * in the build of whoever applied the plugin, as an unresolvable artifact with
 * nothing pointing at the cause.
 */
val generateVersion = tasks.register("generatePortholeVersion") {
    val version = project.version.toString()
    val uiPackage = "@gravitylabsllc/porthole"
    val outputDir = layout.buildDirectory.dir("generated/version")

    inputs.property("version", version)
    outputs.dir(outputDir)

    doLast {
        val file = outputDir.get()
            .file("live/gravitylabs/porthole/gradle/PortholeVersion.kt").asFile
        file.parentFile.mkdirs()
        file.writeText(
            """
            // Copyright 2026 Gravity Labs
            // SPDX-License-Identifier: Apache-2.0
            //
            // Generated from `porthole` in gradle/libs.versions.toml. Do not edit.
            package live.gravitylabs.porthole.gradle

            internal const val PORTHOLE_VERSION: String = "$version"
            internal const val PORTHOLE_UI_PACKAGE: String = "$uiPackage"

            """.trimIndent(),
        )
    }
}

kotlin.sourceSets.named("main") { kotlin.srcDir(generateVersion) }

dependencies {
    // compileOnly: the consuming build always brings its own AGP, and the
    // plugin only touches the stable variant API. Verified to compile against
    // both AGP 8 and AGP 9; the compatibility test runs it against both.
    compileOnly(libs.agp.api)

    testImplementation("junit:junit:4.13.2")
    // java-gradle-plugin, which kotlin-dsl brings, puts the plugin under test
    // on the TestKit classpath for us.
    testImplementation(gradleTestKit())
}

tasks.test {
    useJUnit()

    // VersionConsistencyTest's whole job is to compare `porthole` in
    // gradle/libs.versions.toml against `version` in mcp/package.json, and it
    // does that by reading both files at runtime. Gradle cannot see a file a
    // test opens for itself, so without these two lines the subject of the
    // check is not an input to the check: editing mcp/package.json leaves
    // `test` UP-TO-DATE and the drift ships under a green build. The build
    // cache makes it worse rather than better — the cache key is built from
    // the declared inputs, so the passing entry and the state that should fail
    // share a key, and the guard gets handed its own stale pass FROM-CACHE. A
    // check whose subject is not its input is a check that can be cached past
    // the exact failure it exists to catch.
    //
    // The catalog half looks covered already, but only by accident: editing it
    // regenerates PortholeVersion.kt and recompiles the test classpath. That is
    // a side effect of a different task's wiring, not a promise about this one,
    // so both files are declared explicitly.
    //
    // This is an included build, so layout.projectDirectory is gradle-plugin/
    // and both files are one level up — the same `user.dir`-and-parent walk the
    // test itself does. NONE: only the contents decide the answer, never where
    // the files sit on disk.
    inputs.file(layout.projectDirectory.file("../gradle/libs.versions.toml"))
        .withPropertyName("versionCatalog")
        .withPathSensitivity(PathSensitivity.NONE)
    inputs.file(layout.projectDirectory.file("../mcp/package.json"))
        .withPropertyName("mcpPackageJson")
        .withPathSensitivity(PathSensitivity.NONE)

    // Which Gradle the TestKit builds run on. Unset means the one running this
    // build; a value makes TestKit fetch that distribution, which is how the
    // plugin gets checked against Gradle versions newer than it was built with.
    //
    //     ./gradlew -p gradle-plugin test -Pporthole.gradleVersion=9.7.1
    //
    // Declared as an input so changing it re-runs the tests rather than
    // reporting the previous version's result as up to date.
    // Which AGP the compatibility test builds against. Unset skips that test
    // entirely, because it needs an Android SDK and the network:
    //
    //     ./gradlew -p gradle-plugin test -Pporthole.agpVersion=9.4.0
    //
    // Worth running against the newest AGP before every release. The plugin
    // writes its port as a resource value, and AGP 9 turned that feature off
    // by default — a break no test that avoids AGP could have seen.
    listOf("porthole.gradleVersion", "porthole.agpVersion").forEach { name ->
        val value = providers.gradleProperty(name)
        // An input, so changing it re-runs the tests rather than reporting the
        // previous version's result as up to date.
        inputs.property(name, value).optional(true)
        if (value.isPresent) {
            systemProperty(name, value.get())
        }
    }

    // The compatibility test resolves the plugin the way a consumer does,
    // through a repository, so it has to be in one first. Only when asked for:
    // this writes to ~/.m2, and a plain `test` should not touch it.
    if (providers.gradleProperty("porthole.agpVersion").isPresent) {
        dependsOn(tasks.named("publishToMavenLocal"))
        systemProperty("porthole.pluginVersion", project.version.toString())
    }
}

// plugin-publish brings maven-publish with it, along with sources and javadoc
// jars and the validation the Gradle Plugin Portal runs on upload, so there is
// nothing left to hand-roll here.
gradlePlugin {
    website.set("https://github.com/gravityrepos/porthole")
    vcsUrl.set("https://github.com/gravityrepos/porthole.git")

    plugins {
        create("porthole") {
            id = "live.gravitylabs.porthole"
            implementationClass = "live.gravitylabs.porthole.gradle.PortholePlugin"
            displayName = "Porthole"
            description = "Wires the debug-only Porthole runtime into an Android app, generates " +
                "its port resource, and owns the adb forward that the timeline UI and the MCP " +
                "server connect through. Release builds get a no-op artifact with the same API."
            tags.set(listOf("android", "compose", "debugging", "profiling", "mcp"))
        }
    }
}

// The configuration cache is on for this build on purpose — gradle.properties
// sets it to match the root's, so `-p gradle-plugin test` and `./gradlew test`
// agree about what was up to date — and the plugin's own tests are what it buys:
// TestKit builds are the slowest thing here and reusing the entry is most of the
// difference. It stays on. These two tasks step outside it, and only these two.
//
// Both come from com.gradle.plugin-publish 1.3.1, which holds Project,
// SourceSet, SourceSetContainer and MavenPublication in its task state — none of
// which the configuration cache can serialize. Undeclared, that surfaces where
// it can do the most damage: publishing is a rare, manual, irreversible act
// against live registries, done in an order that matters, and `publishPlugins`
// met the person doing it with six configuration-cache problems, a link to a
// report, and the line "Please report this error, run './gradlew --stop' and try
// again", before ending on `Configuration cache entry discarded with 6 problems`.
// Nothing was wrong: Gradle discarded the entry, fell back, and the publish would
// have worked. `login` was worse — its one problem failed the build outright, so
// the task that exists to store Portal credentials refused to run at all.
//
// Be clear about what declaring this does and does not buy, because the name
// promises more than the API delivers. On Gradle 8.14.5 it stops problems in
// these tasks from failing the build; it does not stop them being printed. The
// entry is discarded either way. So `login` is genuinely fixed — it went from
// BUILD FAILED to BUILD SUCCESSFUL — while `publishPlugins` prints exactly the
// six problems it printed before, because it was already being let through: the
// classloader-encoding error is unrecoverable, so Gradle was already abandoning
// the entry and falling back rather than failing. Making publishPlugins quiet
// needs --no-configuration-cache on that one command, which lives in the README,
// not here.
//
// It still earns its place. publishPlugins is non-fatal today by accident, not
// by design — it survives only because one of its six problems happens to be the
// unrecoverable kind. Fix that one upstream and leave the Project serialization,
// and publishPlugins starts failing outright exactly the way login just did, in
// the middle of a release. This says in advance that we know, and that a failure
// here is not the build's opinion worth acting on.
//
// Per task, not per build: disabling the cache globally would undo the agreement
// with the root and take the tests' speedup with it. Everything else in the
// publishing surface was checked and is clean — publishToMavenLocal, publish,
// validatePlugins, and the vanniktech publishToMavenCentral/publishToMavenLocal
// in the Android modules all store an entry without complaint. Remove these when
// plugin-publish is configuration-cache compatible, and not before; they will
// read as noise long before they stop being true.
tasks.named("publishPlugins") {
    notCompatibleWithConfigurationCache(
        "com.gradle.plugin-publish 1.3.1 serializes Project, SourceSet and MavenPublication",
    )
}
tasks.named("login") {
    notCompatibleWithConfigurationCache(
        "com.gradle.plugin-publish 1.3.1 serializes Project",
    )
}

kotlin { jvmToolchain(17) }

// Credentials are never checked in. The Portal reads gradle.publish.key and
// gradle.publish.secret from ~/.gradle/gradle.properties or the environment.
// Publishing stays a deliberate act: ./gradlew -p gradle-plugin publishPlugins
