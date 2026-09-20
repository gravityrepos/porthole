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

    /**
     * Replaces the `command`/`args` that `portholeMcpConfig` writes into
     * `.mcp.json`'s `porthole` entry, the same way [uiCommand] replaces what
     * `portholeUi` launches.
     *
     * Unset (the default), the entry runs the published npm package, pinned
     * to [uiPackageVersion] (GRA-195). For a repo that builds the CLI itself —
     * this repo's own sample is one — that pin still names a version on the
     * registry, not the local build sitting right there, so an agent talking
     * to `.mcp.json` would drift from the checkout the same way GRA-195's bug
     * report describes. Point this at the local build instead:
     * ```kotlin
     * mcpCommand.set(listOf("node", "../porthole/mcp/dist/cli.js", "mcp"))
     * ```
     */
    abstract val mcpCommand: ListProperty<String>

    /**
     * How many events the in-process ring on the device holds before the
     * oldest ones are overwritten — see `EventRing.kt`. Sized in **events**,
     * not seconds: the ring is a fixed-size array, not a time-bounded buffer,
     * so there is no clock to hand it. The default, 2048, is a translation of
     * that into a duration you can actually reason about, using the same
     * assumption `EventRing`'s own default comment makes — a busy screen
     * produces on the order of 4096 events in "a couple of minutes", call it
     * 120s, which is ~34 events/s. At that rate 2048 events is roughly
     * **60 seconds** of a busy screen. A quieter screen buys proportionally
     * more wall-clock time for the same capacity; a busier one, less. Raise
     * it if `findings` or `what_was_happening` keep reporting a buffer that
     * rolled before the moment you wanted; the cost is memory on the device,
     * a few hundred KB per thousand events per `EventRing`'s own note.
     */
    abstract val ringCapacity: Property<Int>

    /** `-s` argument for adb. Leave unset when exactly one device is attached. */
    abstract val deviceSerial: Property<String>

    /**
     * Application id to record in the connection file and in `.mcp.json`'s
     * `PORTHOLE_APPLICATION_ID`. No longer only cosmetic (GRA-197): the MCP
     * server compares it against the connected app's own `hello.packageName`
     * and warns loudly on a mismatch — the case where another Porthole app on
     * the device is holding the configured port. For an application module
     * this defaults from AGP's own `defaultConfig.applicationId` at
     * `finalizeDsl` time (see `AndroidWiring.application`); setting it here
     * explicitly always wins over that default. Library modules leave it
     * unset.
     */
    abstract val applicationId: Property<String>
}
