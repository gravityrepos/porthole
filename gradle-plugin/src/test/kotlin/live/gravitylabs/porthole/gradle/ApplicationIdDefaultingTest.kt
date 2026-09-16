// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.testkit.runner.GradleRunner
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.Properties

/**
 * GRA-197 AC1: `PortholeExtension.applicationId` defaults from AGP's own
 * `defaultConfig.applicationId` on an application module, at `finalizeDsl`
 * time (see [AndroidWiring.application]), and an explicit
 * `porthole { applicationId.set(...) }` still wins over that default.
 *
 * This needs a real Android application module — `AndroidWiring` is only
 * loaded once `com.android.application` is applied, and the property it sets
 * a convention on lives on the real [PortholeExtension] instance the plugin
 * creates. Unlike the functional tests in [McpConfigTest] and
 * [StubAdbFunctionalTest], this cannot use `withPluginClasspath()`:
 * [PortholeAgpCompatibilityTest]'s own KDoc explains why — that puts the
 * plugin under test in a different classloader from the AGP the build script
 * applies, and casts between AGP DSL types loaded by each side then fail.
 *
 * [PortholeAgpCompatibilityTest] solves that by resolving a published
 * `live.gravitylabs.porthole` from `mavenLocal()`, which only exists when the
 * build was run with `-Pporthole.agpVersion=...` (it drives the
 * `publishToMavenLocal` dependency and the `porthole.pluginVersion` system
 * property) — which is why that whole class is skipped on every routine run,
 * CI included (see the BRIEFING's "no single machine runs all 358 tests"
 * note). This ticket needs the opposite: a test CI's ubuntu leg actually
 * runs. `pluginManagement { includeBuild(...) }`, pointed at this same
 * `gradle-plugin` checkout, gets the plugin under test onto the *ordinary*
 * plugin classloader realm instead — the exact mechanism the root build uses
 * to apply this plugin to `sample/` (`pluginManagement { includeBuild(
 * "gradle-plugin") }` in the root `settings.gradle.kts`) — so it coexists
 * with a normally-applied `com.android.application` the same way production
 * usage does, no `-Pporthole.agpVersion` and no `mavenLocal()` publish
 * required. Gated only on an available SDK ("its skip-when-no-SDK
 * convention"), which `ubuntu-latest` ships preinstalled (see
 * `.github/workflows/pr.yml`) and a machine with no `ANDROID_HOME`/
 * `local.properties` does not — that machine skips cleanly instead of
 * failing on a missing SDK it was never promised.
 */
class ApplicationIdDefaultingTest {

    @get:Rule
    val projectDir = TemporaryFolder()

    private val gradleVersion: String? =
        System.getProperty("porthole.gradleVersion")?.takeIf(String::isNotBlank)

    /** The `gradle-plugin` checkout this test class itself is compiled from. */
    private val pluginProjectDir: File = File(System.getProperty("user.dir"))

    private fun write(path: String, text: String) {
        val file = File(projectDir.root, path)
        file.parentFile.mkdirs()
        file.writeText(text)
    }

    /** Same lookup [PortholeAgpCompatibilityTest] uses, duplicated rather than
     * shared: the two classes are gated on different things and a shared
     * helper would blur why each one skips when it does. */
    private fun sdkDirectory(): String? {
        val fromEnv = sequenceOf("ANDROID_HOME", "ANDROID_SDK_ROOT")
            .mapNotNull(System::getenv)
            .firstOrNull { File(it).isDirectory }
        if (fromEnv != null) return fromEnv

        val local = pluginProjectDir.parentFile?.resolve("local.properties")
        if (local != null && local.isFile) {
            val props = Properties()
            local.inputStream().use(props::load)
            return props.getProperty("sdk.dir")?.takeIf { File(it).isDirectory }
        }
        return null
    }

    /** A Kotlin string literal for a path, escaped for both drive-letter
     * colons and backslashes to survive inside a generated build script. */
    private fun quoted(path: String): String = "\"" + path.replace("\\", "\\\\") + "\""

    private fun androidProject(sdk: String, defaultConfigApplicationId: String, extensionBlock: String) {
        write("local.properties", "sdk.dir=${sdk.replace('\\', '/')}\n")
        write(
            "settings.gradle.kts",
            """
            pluginManagement {
                includeBuild(${quoted(pluginProjectDir.absolutePath)})
                repositories { google(); gradlePluginPortal(); mavenCentral() }
            }
            dependencyResolutionManagement {
                repositories { google(); mavenCentral() }
            }
            rootProject.name = "appid"
            include(":app")
            """.trimIndent(),
        )
        write(
            "build.gradle.kts",
            """plugins { id("com.android.application") version "${libsAgpVersion()}" apply false }""",
        )
        write(
            "app/build.gradle.kts",
            """
            plugins {
                id("com.android.application")
                id("live.gravitylabs.porthole")
            }

            android {
                namespace = "appid.app"
                compileSdk = 36
                defaultConfig {
                    applicationId = "$defaultConfigApplicationId"
                    minSdk = 23
                }
            }

            $extensionBlock

            tasks.register("printPortholeApplicationId") {
                doLast {
                    // project.porthole rather than the bare `porthole`
                    // accessor: unambiguous from inside a Task-receiver
                    // doLast lambda, and doLast is deliberate — AGP's
                    // finalizeDsl (where AndroidWiring.application sets the
                    // convention) fires during configuration but after this
                    // script's own top-level evaluation, so only something
                    // that runs at execution time is guaranteed to see it.
                    println("porthole.applicationId=" + project.porthole.applicationId.orNull)
                }
            }
            """.trimIndent(),
        )
        write("app/src/main/AndroidManifest.xml", "<manifest />\n")
    }

    /**
     * The AGP version this very module compiles against
     * (`gradle/libs.versions.toml`'s `agp` entry) — read as a plain string
     * rather than through the catalog, for the same reason
     * `gradle-plugin/settings.gradle.kts`'s own comment gives for not
     * referencing `libs` from a settings script: the accessor is wired into
     * project build scripts, not available here.
     */
    private fun libsAgpVersion(): String {
        val catalog = File(pluginProjectDir.parentFile, "gradle/libs.versions.toml").readText()
        val match = Regex("""(?m)^agp\s*=\s*"([^"]+)"""").find(catalog)
            ?: error("no agp entry in libs.versions.toml")
        return match.groupValues[1]
    }

    private fun run(vararg arguments: String) =
        GradleRunner.create()
            .withProjectDir(projectDir.root)
            .withArguments(*arguments, "--stacktrace")
            .apply { gradleVersion?.let(::withGradleVersion) }
            .build()

    private fun prepare(defaultConfigApplicationId: String, extensionBlock: String = ""): Boolean {
        val sdk = sdkDirectory() ?: return false
        androidProject(sdk, defaultConfigApplicationId, extensionBlock)
        return true
    }

    @Test
    fun `defaults applicationId from AGP's defaultConfig on an application module`() {
        assumeTrue("no Android SDK; set ANDROID_HOME", prepare("com.example.fromagp"))

        val output = run(":app:printPortholeApplicationId").output
        assertTrue(
            "expected the AGP-defaulted applicationId in:\n$output",
            output.contains("porthole.applicationId=com.example.fromagp"),
        )
    }

    @Test
    fun `an explicit applicationId still wins over the AGP default`() {
        assumeTrue(
            "no Android SDK; set ANDROID_HOME",
            prepare(
                defaultConfigApplicationId = "com.example.fromagp",
                extensionBlock = """
                porthole {
                    applicationId.set("com.example.explicit")
                }
                """.trimIndent(),
            ),
        )

        val output = run(":app:printPortholeApplicationId").output
        assertTrue(
            "expected the explicit applicationId, not AGP's default, in:\n$output",
            output.contains("porthole.applicationId=com.example.explicit"),
        )
    }
}
