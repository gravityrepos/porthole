plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.maven.publish)
}

// Mirrors the public surface of :runtime with every body emptied out, so a
// release build compiles against the same API and ships none of the machinery.
// If you add a public function to :runtime, add it here too.
android {
    namespace = "live.gravitylabs.porthole"
    compileSdk = 35

    defaultConfig { minSdk = 26 }

    buildFeatures { compose = true }

    // Kept in step with jvmToolchain below; AGP fails the build if Java and
    // Kotlin disagree on the target.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin { jvmToolchain(17) }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.runtime)
    implementation(libs.compose.ui)
    implementation(libs.kotlinx.coroutines.android)

    compileOnly(libs.okhttp)
    compileOnly(libs.room.runtime)
    compileOnly(libs.androidx.sqlite)
    compileOnly(libs.ktor.client.core)

    testImplementation(libs.junit)
}
