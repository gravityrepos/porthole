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
