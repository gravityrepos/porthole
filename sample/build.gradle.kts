plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.ksp)
    id("live.gravitylabs.porthole")
}

android {
    namespace = "com.example.shop"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.shop"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.4.2"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    // Two storage engines, one app. The porthole instruments the layer under
    // both, so neither flavor's code mentions it beyond a single line.
    flavorDimensions += "storage"
    productFlavors {
        create("room") { dimension = "storage" }
        create("sqldelight") { dimension = "storage" }
    }

    buildFeatures { compose = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin { jvmToolchain(17) }
}

porthole {
    // This repo builds the runtime itself, so depend on the projects rather
    // than on a published artifact. A real app leaves this alone.
    useProjectDependencies.set(true)
    port.set(8677)
    // Same reason: this repo builds the CLI too, so point `portholeUi` at the
    // local build instead of fetching the published package.
    uiCommand.set(listOf("node", rootProject.file("mcp/dist/cli.js").absolutePath, "ui"))
    // GRA-195: without this, portholeMcpConfig would still write a pinned
    // *registry* version into .mcp.json, the one thing in this sample that
    // would point away from the checkout instead of at it.
    mcpCommand.set(listOf("node", rootProject.file("mcp/dist/cli.js").absolutePath, "mcp"))
    // GRA-59: on, so the sample's own "StrictMode" button (CartViewModel.
    // triggerStrictModeViolation) actually demonstrates a strict_violation
    // finding rather than silently doing nothing. Off is the right default
    // for a real app; this repo's own sample is exactly the place to turn
    // it on.
    strictMode.set(true)
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)

    implementation(libs.kotlinx.coroutines.android)

    // Storage is per flavor, so an app only ever ships the engine it uses.
    "roomImplementation"(libs.room.runtime)
    "roomImplementation"(libs.room.ktx)
    // KSP names its configurations per variant (kspRoomDebug), so the plain
    // one is used and simply has nothing to process in the sqldelight flavor,
    // where Room is not on the compile classpath at all.
    ksp(libs.room.compiler)

    "sqldelightImplementation"(libs.sqldelight.android)

    implementation(libs.okhttp)

    // Ktor on the CIO engine: no OkHttp anywhere in this path, so it exercises
    // the Ktor plugin rather than the interceptor.
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.cio)
    implementation(libs.work.runtime)

    // The sample serves its own API from inside the app so the demo is
    // self-contained and deterministic. Swapping in a real base URL is one line.
    implementation(libs.mockwebserver)

    // GRA-64: debugImplementation, the same as every real app would use it —
    // never shipped in release, and never assumed by the runtime (Porthole's
    // own runtime/build.gradle.kts has it compileOnly; see LeakCanaryPorthole
    // for the classpath probe that makes an app without this line a no-op).
    debugImplementation(libs.leakcanary.android)
}
