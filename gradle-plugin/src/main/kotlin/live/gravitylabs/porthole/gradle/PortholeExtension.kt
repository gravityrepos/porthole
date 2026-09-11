// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property

/**
 * ```kotlin
 * porthole {
 *     port.set(8677)
 *     debugBuildTypes.set(listOf("debug", "staging"))
 *     deviceSerial.set("emulator-5554")
 * }
 * ```
 */
abstract class PortholeExtension {

    /** Turn the whole plugin off without removing it. Default true. */
    abstract val enabled: Property<Boolean>

    /**
     * Port on both sides of the adb forward. Change it if 8677 is taken, or if
     * you want two apps watched at once.
     */
    abstract val port: Property<Int>

    /**
     * Build types that get the real runtime. Everything else gets the no-op.
     * Default `["debug"]`.
     */
    abstract val debugBuildTypes: ListProperty<String>

    /** Version of the runtime artifacts to depend on. Defaults to the plugin's own. */
    abstract val runtimeVersion: Property<String>

    /** Used when developing porthole itself: depend on `:runtime` instead of Maven. */
    abstract val useProjectDependencies: Property<Boolean>

    /** npm version of @gravitylabsllc/porthole that `portholeUi` runs. */
    abstract val uiPackageVersion: Property<String>

    /**
     * Replaces the `npx` invocation entirely. `portholeUi` appends `--port` and
     * `--serial` to whatever you put here.
     *
     * For a globally installed CLI, a different package manager, or a checkout
     * of porthole itself:
     * ```kotlin
     * uiCommand.set(listOf("node", "../porthole/mcp/dist/cli.js", "ui"))
     * ```
     */
    abstract val uiCommand: ListProperty<String>

    /** `-s` argument for adb. Leave unset when exactly one device is attached. */
    abstract val deviceSerial: Property<String>

    /**
     * Application id to record in the connection file. Only cosmetic — it tells
     * the MCP server which app it is talking to. Defaults to unset.
     */
    abstract val applicationId: Property<String>
}
