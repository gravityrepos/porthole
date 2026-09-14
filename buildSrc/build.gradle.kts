// The pure logic behind `./gradlew release` / `releaseDryRun` — the
// changelog parser and the version/branch/tree gates — used to live entirely
// inline in the root build script, where nothing could import it and nothing
// could unit test it (GRA-100 QA: "no file under any src/test references
// release, releaseDryRun, cutChangelog..."). Kotlin script bodies are not
// importable; a real Kotlin source set is, and `buildSrc` is the one Gradle
// puts on every project build script's classpath automatically, so the root
// build.gradle.kts can call straight into it with no `includeBuild` and no
// extra repository wiring.
//
// `kotlin-dsl` rather than a plain `kotlin("jvm")`: it pulls in the embedded
// Kotlin version the root build itself runs on (so there is exactly one
// Kotlin on the classpath that configures this build) and puts `gradleApi()`
// on it, which is what lets ReleaseGates.kt throw a real GradleException
// instead of inventing its own exception type for build.gradle.kts to catch
// and rethrow.
plugins {
    `kotlin-dsl`
}

repositories {
    mavenCentral()
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}

tasks.test {
    useJUnit()
}
