pluginManagement {
    includeBuild("gradle-plugin")
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

// Every module here asks for `jvmToolchain(17)`, and until this was added nothing
// told Gradle where a JDK 17 comes from on a machine that does not already have
// one. It auto-provisioned anyway and warned that it was doing so blind; Gradle 9
// removes that fallback, so on a CI runner whose default JDK is not 17 the warning
// becomes a failure. This plugin points the toolchain lookup at the Foojay API.
//
// The version is a literal rather than a catalog reference because a settings
// script's `plugins` block cannot see `libs` at all, at any position in this
// file: the type-safe accessor Gradle generates for a version catalog is
// wired into project build scripts, not into a settings script's own `plugins`
// block, so moving this block relative to `dependencyResolutionManagement`
// would not fix it. Pin it exactly — a range here would let the resolver
// change underneath a build that is otherwise reproducible.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "porthole"

include(":runtime")
include(":runtime-noop")
include(":sample")
