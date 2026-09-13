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
        .withPathSensitivity(PathSensitivity.NONE)
    inputs.file(layout.projectDirectory.file("../mcp/package.json"))
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

kotlin { jvmToolchain(17) }

// Credentials are never checked in. The Portal reads gradle.publish.key and
// gradle.publish.secret from ~/.gradle/gradle.properties or the environment.
// Publishing stays a deliberate act: ./gradlew -p gradle-plugin publishPlugins
