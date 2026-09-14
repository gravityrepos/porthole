// The same toolchain resolver the root settings declares. This is an included
// build with its own settings file, so it inherits nothing from the root: build
// the plugin on its own and it auto-provisions a JDK 17 blind and warns about it
// exactly as the root build used to. Both halves have to be here.
//
// The version is a literal rather than a catalog reference because a settings
// script's `plugins` block cannot see `libs` at all, at any position in this
// file: the type-safe accessor Gradle generates for a version catalog is
// wired into project build scripts, not into a settings script's own `plugins`
// block, so moving this block relative to `dependencyResolutionManagement`
// would not fix it. Kept identical to the root's by hand; pin it exactly.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }

    // This is an included build, so it does not inherit the root's catalog.
    // Point at the same file rather than keeping a second copy of the AGP
    // version: the version this compiles against and the version the rest of
    // the build uses should not be able to drift apart silently.
    versionCatalogs {
        create("libs") {
            from(files("../gradle/libs.versions.toml"))
        }
    }
}

rootProject.name = "porthole-gradle-plugin"
