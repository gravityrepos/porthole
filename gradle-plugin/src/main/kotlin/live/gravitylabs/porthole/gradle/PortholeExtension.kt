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
     * The host port the `adb forward` listens on — not a port the device
     * opens. GRA-199: the far end is an abstract-namespace Unix socket keyed
     * by [applicationId] (`localabstract:porthole.<applicationId>`), not a
     * second copy of this port, so two Porthole apps on one *device* never
     * contend for anything here at all. Change it if 8677 is taken on your
     * *workstation*, or if you want two of your own MCP servers watching two
     * apps on the same workstation at once — that is still a host-side
     * collision this value has to resolve, same as always.
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
     * Installs an Android `StrictMode` thread + VM policy in debug builds and
     * turns a violation with a frame in the app's own package into a
     * `findings` entry — main-thread disk writes and network calls at
     * `error`, leaked closeables/cursors at `warning`, everything else at
     * `note`. See `StrictModeCollector`'s own KDoc for exactly which checks
     * are on by default and why `detectDiskReads()` is deliberately not one
     * of them (it is the single noisiest StrictMode check there is, and
     * `db-on-main-thread` already covers the read that matters
     * categorically).
     *
     * Off by default. `StrictMode.getThreadPolicy()`/`getVmPolicy()` return
     * opaque objects with no public accessors, so there is no way to detect —
     * let alone chain onto — a policy the app already installed. Turning this
     * on unconditionally would silently discard a debug build's own
     * `penaltyDeath` the moment this plugin's runtime loaded. Enabling it
     * REPLACES whatever policy was already in effect; the device-side `setup`
     * report says so plainly, in exactly those terms. Never enable this in a
     * release build — `debugBuildTypes` is what this ships on regardless of
     * this flag, same as every other collector.
     */
    abstract val strictMode: Property<Boolean>

    /**
     * Resolves real composable names for GRA-235's whole-tree recomposition
     * counting, instead of the placeholder `<uninstrumented:...>` ids a
     * `recompositions` report otherwise gives an unwrapped scope. Off by
     * default, and this is the flag to reach for before turning it on: naming
     * a scope needs Compose's own `collectParameterInformation()` — what the
     * Layout Inspector uses — which sets `forceRecomposeScopes = true` for
     * the whole app, meaning Compose allocates a recompose scope for *every*
     * composable rather than only the ones that need one. That changes the
     * shape of the program being measured, not only what the report can
     * print about it: a build with this on recomposes differently than the
     * same build with it off, and the `recompositions` report says so in its
     * own `notes`. Turn it off to measure the app as it ships; turn it on
     * when the placeholder ids aren't enough to find the composable you're
     * looking for.
     *
     * Counting itself needs no such trade — every recompose scope in the tree
     * is counted whether this is on or off, at the cost the GRA-70 spike
     * measured (`docs/spikes/GRA-70-recomposition-counts.md`) as
     * indistinguishable from zero. Only *names* cost this.
     *
     * Requires Compose >= 1.6 for whole-tree counting to attach at all
     * (`androidx.compose.runtime.tooling.CompositionObserver`); on an older
     * Compose this flag does nothing; the runtime degrades to counting
     * `PortholeScreen`/`Modifier.portholeNode` call sites only, as it did
     * before GRA-235.
     */
    abstract val composableNames: Property<Boolean>

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

    /**
     * Keeps the pre-GRA-199 bind: a loopback TCP `ServerSocket` shared by
     * every app on the device, forwarded with `adb forward tcp:PORT
     * tcp:PORT`, instead of the abstract-namespace Unix socket keyed by
     * `applicationId` that is now the default (`adb forward tcp:PORT
     * localabstract:porthole.<applicationId>`). The abstract socket is what
     * makes two Porthole apps on one device reachable at the same time —
     * two different apps can no longer contend for the same on-device
     * endpoint at all — so this exists only for whoever has something
     * outside this plugin (a hand-rolled `adb forward`, a CI script, a tool
     * that shells out to `adb` on its own) still pointed at the old TCP
     * port and has not moved it yet.
     *
     * Default `false`. Planned for removal one release after it ships —
     * there is no migration this flag can do FOR you, since the whole point
     * of the abstract socket is that it needs no port coordination between
     * apps; it only buys time to update whatever is forwarding by hand.
     * Setting it here flows to three places that all have to agree for the
     * bridge to work at all: the runtime (a generated `porthole_legacy_tcp_port`
     * bool resource, read the same way [strictMode] is), `portholeConnect`/
     * `portholeUi`'s own `adb forward` (the far end becomes `tcp:PORT`
     * again, not `localabstract:...`), and the connection file each of those
     * writes.
     */
    abstract val legacyTcpPort: Property<Boolean>
}
