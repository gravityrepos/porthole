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
