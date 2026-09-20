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

    // GRA-190: only the debug build type — the one every unit test here
    // actually compiles and runs against (see AndroidWiring.kt: the plugin
    // wires `runtime` to debug and `runtime-noop` to every other build
    // type). Turning this on for release too would ask AGP to instrument a
    // variant nothing tests, for a build type this module doesn't have.
    buildTypes {
        debug {
            enableUnitTestCoverage = true
        }
    }
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

    // GRA-129 item 5: /api/ is ~58 Dokka pages with no canonical, so a search
    // engine sees near-duplicate content across module/package/class pages
    // with nothing pointing back at the one URL worth ranking. Only the
    // directory's own index gets it — the individual declaration pages are
    // meant to be found by search within the reference, not indexed on
    // their own. Done as a post-processing step here rather than by hand in
    // site/api/index.html, because Sync overwrites that file from Dokka's
    // output on every run and a hand edit would not survive the next one.
    // Idempotent: re-running apiDocs does not duplicate the tag.
    doLast {
        val indexHtml = layout.projectDirectory.file("../site/api/index.html").asFile
        if (indexHtml.exists()) {
            val text = indexHtml.readText()
            if (!text.contains("rel=\"canonical\"")) {
                val marker = "<title>porthole</title>"
                check(text.contains(marker)) {
                    "apiDocs: expected Dokka's $marker in site/api/index.html to anchor the " +
                        "canonical link — Dokka's generated head may have changed shape."
                }
                val canonicalTag = "<link rel=\"canonical\" href=\"https://porthole.gravitylabs.live/api/\">"
                indexHtml.writeText(text.replaceFirst(marker, "$marker\n    $canonicalTag"))
            }
        }
    }
}
