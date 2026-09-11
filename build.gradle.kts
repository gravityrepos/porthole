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
