import org.jetbrains.dokka.gradle.engine.parameters.VisibilityModifier

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.maven.publish)
    alias(libs.plugins.dokka)
}

android {
    namespace = "live.gravitylabs.porthole"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")
    }

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
    implementation(libs.compose.ui.util)

    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.startup)

    // Every integration is optional. The collectors look for these classes at
    // runtime and stay dark if the app doesn't ship them.
    compileOnly(libs.androidx.navigation.runtime)
    compileOnly(libs.okhttp)
    compileOnly(libs.okio)
    compileOnly(libs.room.runtime)
    compileOnly(libs.androidx.sqlite)
    compileOnly(libs.work.runtime)
    compileOnly(libs.ktor.client.core)

    // The tee has to be exercised against a real client and a real socket:
    // whether it forwards bytes untouched is not something reading it proves.
    testImplementation(libs.junit)
    testImplementation(libs.okhttp)
    testImplementation(libs.okio)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.ktor.client.core)

    // Porthole.install/shutdown registers real Application callbacks,
    // BroadcastReceivers and ConnectivityManager callbacks: whether they come
    // back off is an Android framework question, not a Kotlin one, and
    // nothing about it can be answered from a plain JVM test double.
    testImplementation(libs.robolectric)

    // work-runtime is compileOnly in production (optional integration), which
    // otherwise leaves it off the unit-test classpath entirely: classPresent
    // ("androidx.work.WorkManager") is false under Robolectric and the whole
    // WorkManagerPorthole branch of install() never runs in any test.
    testImplementation(libs.work.runtime)
}

// The published API is about twenty declarations, and most of them are
// extension functions — `OkHttpClient.Builder.installPorthole`, the composable
// wrappers, `RoomDatabase.Builder.installPorthole`. Kotlin does not survive the
// Javadoc tool: those become static methods on synthetic `OkHttpKt` classes, or
// disappear entirely when their receiver comes from a compileOnly dependency,
// which is how the first javadoc jar ended up documenting neither
// `portholeKtor()` nor `portholeSqliteFactory()`. Dokka reads Kotlin.
dokka {
    moduleName.set("porthole")

    dokkaSourceSets.configureEach {
        // Public only. Nothing under collect/, store/ or net/ is API, and the
        // internals are where the interesting comments live — they would drown
        // the twenty declarations that consumers actually call.
        documentedVisibilities.set(setOf(VisibilityModifier.Public))
        reportUndocumented.set(true)

        sourceLink {
            localDirectory.set(file("src/main/kotlin"))
            remoteUrl("https://github.com/gravityrepos/porthole/blob/main/runtime/src/main/kotlin")
            remoteLineSuffix.set("#L")
        }
    }

    pluginsConfiguration.html {
        footerMessage.set("© 2026 Gravity Labs · Apache-2.0")
    }
}


/**
 * Copies the generated docs into the site, where they are committed and served
 * at /api.
 *
 * Committed rather than built on deploy because the host cannot build them:
 * Dokka needs AGP, AGP needs the Android SDK, and the site has no build step at
 * all. Generated-and-committed is the same bargain the brand rasters make.
 *
 * Sync, not Copy: a declaration that goes away should leave the site too.
 */
tasks.register<Sync>("apiDocs") {
    group = "documentation"
    description = "Regenerates site/api from the runtime's KDoc."

    from(tasks.named("dokkaGeneratePublicationHtml"))

    // These sit one link from the landing page, so they should not arrive
    // wearing JetBrains' logo. Overwritten here rather than through Dokka's
    // customAssets, which loses to its own defaults for a name it also ships.
    from(layout.projectDirectory.file("../brand/mark.svg")) {
        into("images")
        rename { "logo-icon.svg" }
    }
    duplicatesStrategy = DuplicatesStrategy.INCLUDE

    into(layout.projectDirectory.dir("../site/api"))
}
