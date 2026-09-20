// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.View
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import live.gravitylabs.porthole.collect.CompositionTreeCollector
import live.gravitylabs.porthole.collect.FrameCollector
import live.gravitylabs.porthole.collect.InflightCollector
import live.gravitylabs.porthole.collect.LogCollector
import live.gravitylabs.porthole.collect.MainThreadWatchdog
import live.gravitylabs.porthole.collect.NavCollector
import live.gravitylabs.porthole.collect.RecompositionCollector
import live.gravitylabs.porthole.collect.SemanticsCollector
import live.gravitylabs.porthole.collect.SnapshotWatcher
import live.gravitylabs.porthole.collect.StateCollector
import live.gravitylabs.porthole.collect.Window
import live.gravitylabs.porthole.integration.LeakCanaryPorthole
import live.gravitylabs.porthole.integration.WorkManagerPorthole
import live.gravitylabs.porthole.protocol.BlockingReport
import live.gravitylabs.porthole.protocol.FrameReport
import live.gravitylabs.porthole.protocol.Hello
import live.gravitylabs.porthole.collect.DbInspector
import live.gravitylabs.porthole.collect.AutoWire
import live.gravitylabs.porthole.collect.BackStackCollector
import live.gravitylabs.porthole.collect.DeviceCollector
import live.gravitylabs.porthole.collect.ExitInfoCollector
import live.gravitylabs.porthole.collect.MemoryCollector
import live.gravitylabs.porthole.collect.Setup
import live.gravitylabs.porthole.collect.StrictModeCollector
import live.gravitylabs.porthole.collect.StartupCollector
import live.gravitylabs.porthole.protocol.DbPage
import live.gravitylabs.porthole.protocol.DbTables
import live.gravitylabs.porthole.protocol.EventFrame
import live.gravitylabs.porthole.protocol.EventKinds
import live.gravitylabs.porthole.protocol.ExitTraceResult
import live.gravitylabs.porthole.protocol.Inflight
import live.gravitylabs.porthole.protocol.SetupEntry
import live.gravitylabs.porthole.protocol.LogPage
import live.gravitylabs.porthole.protocol.NavState
import live.gravitylabs.porthole.protocol.PortholeJson
import live.gravitylabs.porthole.protocol.portholeSocketName
import live.gravitylabs.porthole.protocol.RecompositionReport
import live.gravitylabs.porthole.protocol.SemanticsTree
import live.gravitylabs.porthole.protocol.StateDump
import live.gravitylabs.porthole.protocol.TimelinePage
import live.gravitylabs.porthole.store.EventRing
import live.gravitylabs.porthole.transport.PortholeSocketServer
import java.io.File

/**
 * The debug-build entry point.
 *
 * Installed automatically by [PortholeInitializer] on process start, so in the
 * normal case the only things you call yourself are the register functions:
 * they are what turn anonymous state objects into names an agent can reason
 * about.
 *
 * Everything here is a no-op in release builds, where the `porthole-noop` artifact
 * with the same signatures takes its place.
 */
object Porthole {

    /** True in debug builds where the real runtime is on the classpath. */
    const val ENABLED: Boolean = true

    private const val TAG = "Porthole"

    /**
     * The port used when nothing says otherwise.
     *
     * Only a fallback. The Gradle plugin writes the configured port into
     * an `integer` resource named `porthole_port`, and [install] reads that
     * first, so changing the port means changing it in one place — the
     * `porthole { }` block — rather than here and in the adb forward.
     */
    const val DEFAULT_PORT: Int = 8677

    /** Long enough for an app to have built its clients before we judge it. */
    private const val SETUP_REPORT_DELAY_MS = 5_000L

    @Volatile
    private var session: Session? = null

    private class Session(
        val app: Application,
        val port: Int,
        val ring: EventRing,
        val snapshots: SnapshotWatcher,
        val recompositions: RecompositionCollector,
        /** GRA-235: whole-tree recomposition counting. See its own doc comment. */
        val compositionTree: CompositionTreeCollector,
        val semantics: SemanticsCollector,
        val state: StateCollector,
        val inflight: InflightCollector,
        val dbInspector: DbInspector,
        val logs: LogCollector,
        val frames: FrameCollector,
        val memory: MemoryCollector,
        val deviceContext: DeviceCollector,
        val startup: StartupCollector,
        val exitInfo: ExitInfoCollector,
        val autoWire: AutoWire,
        val watchdog: MainThreadWatchdog,
        /** Null unless `porthole { strictMode.set(true) }` asked for it — see [StrictModeCollector]'s own doc comment for why this is opt-in. */
        val strictMode: StrictModeCollector?,
        val nav: NavCollector?,
        val nav3: BackStackCollector,
        val workManager: WorkManagerPorthole?,
        val server: PortholeSocketServer,
        val startedAt: Long,
        val collectors: List<String>,
        val setupHandler: Handler,
        val setupTask: Runnable,
    )

    // -- lifecycle ---------------------------------------------------------

    /**
     * Starts the porthole: collectors, and the socket the timeline and the
     * MCP server connect to.
     *
     * You are unlikely to call this. [PortholeInitializer] does it on process
     * start, which is early enough to see the first state write — calling it
     * yourself from `Application.onCreate` is already later than that. It is
     * public for the case where the initializer has been removed from the
     * manifest deliberately.
     *
     * Idempotent, and safe to call from any thread: the second call returns
     * without doing anything.
     *
     * GRA-240: the project's whole security argument is "debug-only,
     * device-local, app-local" — this is where the first of those is
     * actually enforced rather than assumed. [app]'s own
     * `ApplicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE` is read
     * before anything else runs; if it is clear, [install] logs one line at
     * `Log.w` naming the build type and returns — no socket, no collectors,
     * no reflection, same as a release build linking `runtime-noop`. This
     * only matters for a build type that lands here at all: the plugin's own
     * `debugBuildTypes` (see README's "Setup" section) is what puts the real
     * `runtime` artifact on a build type in the first place, and it can name
     * a build type that is not actually marked `isDebuggable = true` (a
     * `staging` type used for QA, say) — this check is what stops that
     * combination from quietly opening the socket anyway.
     *
     * @param port the port to bind on the device, defaulting to the
     *   `porthole_port` resource the Gradle plugin generates, and to
     *   [DEFAULT_PORT] if that resource is absent.
     */
    @JvmStatic
    @JvmOverloads
    fun install(app: Application, port: Int = portFromResources(app)) {
        if (session != null) return
        synchronized(this) {
            if (session != null) return

            val debuggable = isDebuggable(app)
            if (!debuggable) {
                Log.w(
                    TAG,
                    "not starting: this is a \"${buildTypeOf(app)}\" build and " +
                        "ApplicationInfo.FLAG_DEBUGGABLE is not set — porthole only ever runs on a " +
                        "debuggable build (see README's build-type section); no socket, no collectors.",
                )
                return
            }

            val ring = EventRing(capacity = ringCapacityFromResources(app))
            // Constructed before anything else below: GRA-60's origin and
            // Application.onCreate-entry timestamps are both taken at
            // construction, so every collector after this line pushes them
            // later than they need to be.
            val startup = StartupCollector(ring)
            val appPackages = appPackagesOf(app)
            val snapshots = SnapshotWatcher(ring, appPackages)
            val composableNames = composableNamesFromResources(app)
            val compositionTree = CompositionTreeCollector(snapshots, composableNames)
            val recompositions = RecompositionCollector(ring, snapshots, composableNamesEnabled = composableNames)
            recompositions.wholeTreeAvailable = compositionTree.available
            recompositions.observerNames = compositionTree
            val semantics = SemanticsCollector()
            val state = StateCollector(snapshots)
            val inflight = InflightCollector(ring)
            val logs = LogCollector(ring)
            val frames = FrameCollector(ring)
            val memory = MemoryCollector(ring)
            val deviceContext = DeviceCollector(ring)
            val exitInfo = ExitInfoCollector(ring, appPackages)
            val autoWire = AutoWire(semantics, state)
            val watchdog = MainThreadWatchdog(ring, appPackages)

            val collectors = mutableListOf("recompositions", "semantics_tree", "state", "inflight", "logs")

            val nav = if (classPresent("androidx.navigation.NavController")) {
                collectors += "nav_state"
                NavCollector(ring, state)
            } else {
                null
            }

            if (frames.install(app)) {
                collectors += "frames"
                // GRA-60: the only way StartupCollector learns "first frame
                // drawn" is from this same listener — see FrameCollector's
                // own `onFirstDraw` doc comment for why it is a plain field
                // rather than something StartupCollector polls for. A warm
                // or hot launch has no first-draw frame of its own, so it
                // arms FrameCollector's separate one-shot `armNextFrame` hook
                // instead, on demand, each time it detects one.
                frames.onFirstDraw = { atMs -> startup.onFirstFrame(atMs) }
                startup.armNextFrame = { callback -> frames.armNextFrame(callback) }
            }
            if (startup.install(app)) collectors += "startup"
            watchdog.start()
            collectors += "main_thread"

            // Nullable and only constructed once WorkManager is confirmed
            // present: WorkManagerPorthole's own fields reference WorkInfo,
            // so building an instance before that check would throw
            // NoClassDefFoundError in an app that never depended on
            // work-runtime in the first place. An instance rather than the
            // stateless object this used to be, so shutdown() has something
            // to call stop() on — the coroutine scope observe() opens used to
            // live only in that function's local variable, reachable by
            // nothing once it returned, session included.
            val workManager = if (classPresent("androidx.work.WorkManager")) {
                WorkManagerPorthole().also { wm ->
                    if (wm.install(app, inflight, ring)) collectors += "workmanager"
                }
            } else {
                null
            }

            snapshots.start()
            logs.start()
            memory.start()
            collectors += "memory"
            if (deviceContext.install(app)) collectors += "device"

            // GRA-64: LeakCanaryPorthole.install() does its own classpath
            // probe before touching a single LeakCanary type — the same
            // presence-gate shape as WorkManager just above — and returns
            // false, silently, for an app that never added
            // leakcanary-android. Setup.recordLeakCanary is only ever
            // called from inside it, never unconditionally here, which is
            // what keeps "absent" meaning no setup entry at all rather than
            // a present-but-false one (see that method's own doc comment).
            //
            // QA: the actual hook now runs on its own background thread
            // (see install()'s own doc comment for why — touching
            // LeakCanary.config for the first time is expensive enough to
            // stall the main thread on a cold launch), so `true` here means
            // "an attempt was launched," not "confirmed hooked" — this
            // collectors line is best-effort, and whether it actually hooked
            // is always Setup.report()'s own leakcanary row, never this list.
            if (LeakCanaryPorthole.install(ring)) collectors += "leakcanary"
            if (exitInfo.install(app)) collectors += "exit_info"
            if (autoWire.install(app)) collectors += "autowire"

            // Opt-in (GRA-59): off unless the plugin's `strictMode` flag reached
            // this build as the `porthole_strict_mode` resource. `Setup` is told
            // either way, unconditionally, so `setup` always has an opinion about
            // strict mode rather than the entry silently not existing when it's
            // off — see Setup.kt's own comment on why this call sits outside
            // `integrationEntries()`.
            val strictMode = if (strictModeFromResources(app)) {
                StrictModeCollector(ring, appPackages).also { collector ->
                    val ok = collector.install()
                    if (ok) {
                        collectors += "strictmode"
                        Setup.recordStrictMode(
                            installed = true,
                            note = "Porthole's StrictMode thread and VM policies REPLACED whatever this " +
                                "process had before install() ran — StrictMode has no public API to read " +
                                "or chain an existing policy, so this is a replacement, not an addition. " +
                                "Any penalty (including penaltyDeath) the app's own policy set is no " +
                                "longer in effect.",
                        )
                    } else {
                        Setup.recordStrictMode(
                            installed = false,
                            note = "porthole { strictMode.set(true) } but this device is API " +
                                "${Build.VERSION.SDK_INT}; StrictMode's penaltyListener needs API 28+, " +
                                "so nothing was installed (no logcat-scraping fallback).",
                        )
                    }
                }
            } else {
                Setup.recordStrictMode(
                    installed = false,
                    note = "off by default; enable with porthole { strictMode.set(true) } in the app " +
                        "module (debug builds only — never set it in release).",
                )
                null
            }

            // GRA-235: whole-tree recomposition counting. Unlike strictMode this
            // is not opt-in at the attach level — CompositionTreeCollector.install
            // itself already declines when CompositionObserver isn't on the
            // classpath (Compose < 1.6) — only naming (composableNames, read
            // above) is opt-in. Setup is told either way for the same reason
            // strict mode is: the entry exists even when it never had a chance to
            // attach.
            if (compositionTree.install(app, recompositions)) {
                collectors += "compose_tree"
                Setup.recordComposeTree(
                    available = true,
                    note = if (composableNames) {
                        "composableNames is on: recompose scopes get real names, at the cost of " +
                            "forceRecomposeScopes — see the recompositions report's own notes."
                    } else {
                        null
                    },
                )
            } else {
                Setup.recordComposeTree(
                    available = false,
                    note = "this build's Compose runtime is below 1.6, or " +
                        "androidx.compose.runtime.tooling.CompositionObserver was otherwise " +
                        "unavailable — recompositions falls back to PortholeScreen/Modifier.portholeNode " +
                        "counts only, as it did before GRA-235.",
                )
            }

            // Snapshotted rather than handed over live: Session used to receive
            // this same mutable list and rely on every append above already
            // having happened by the time anything read `collectors` back, which
            // held only because nothing had made a copy yet. Building the final
            // list before Session exists means that is no longer something a
            // later reordering could quietly break.
            val finalCollectors = collectors.toList()

            // The "installed on ..." line used to print unconditionally right
            // here, before the bind (which runs on the io executor, inside
            // server.start() below) had even been attempted — so a failed
            // bind still got announced as a success. onBindResult fires once
            // the bind has actually settled one way or the other, so the line
            // now only ever appears once the socket is genuinely listening;
            // a failed bind gets PortholeSocketServer's own Log.e instead,
            // with nothing here that could contradict it.
            val legacyTcp = legacyTcpPortFromResources(app)
            val server = PortholeSocketServer(
                port,
                ring,
                packageName = app.packageName,
                onBindResult = { ok ->
                    if (ok) {
                        val where = if (legacyTcp) "127.0.0.1:$port" else "localabstract:${portholeSocketName(app.packageName)}"
                        Log.i(TAG, "installed on $where, collectors: ${finalCollectors.joinToString()}")
                    }
                },
                legacyTcp = legacyTcp,
            )
            // Held as fields, not posted from a value nobody keeps, so
            // shutdown() can cancel this specific callback rather than
            // leaving it to fire into a session that has already ended. Ten
            // install/shutdown cycles used to queue ten of these, each
            // outliving the session that scheduled it.
            val setupHandler = Handler(Looper.getMainLooper())
            val setupTask = Runnable { Setup.log() }
            val s = Session(
                app = app,
                port = port,
                ring = ring,
                snapshots = snapshots,
                recompositions = recompositions,
                compositionTree = compositionTree,
                semantics = semantics,
                state = state,
                inflight = inflight,
                dbInspector = DbInspector(),
                logs = logs,
                frames = frames,
                memory = memory,
                deviceContext = deviceContext,
                startup = startup,
                exitInfo = exitInfo,
                autoWire = autoWire,
                watchdog = watchdog,
                strictMode = strictMode,
                nav = nav,
                nav3 = BackStackCollector(ring),
                workManager = workManager,
                server = server,
                startedAt = nowMs(),
                collectors = finalCollectors,
                setupHandler = setupHandler,
                setupTask = setupTask,
            )
            registerMethods(s)
            server.start()
            writeConnectionFile(app, port, legacyTcp)
            session = s
            // After the app has had a chance to build its clients. Asking
            // now would report everything as missing.
            setupHandler.postDelayed(setupTask, SETUP_REPORT_DELAY_MS)
        }
    }

    @JvmStatic
    /**
     * Stops everything and closes the socket.
     *
     * Provided for tests and for apps that restart their process state in
     * place. A debug build has no reason to call it otherwise: the porthole
     * costs nothing while nothing is connected to it.
     */
    fun shutdown() {
        synchronized(this) {
            val s = session ?: return
            s.setupHandler.removeCallbacks(s.setupTask)
            s.server.stop()
            s.snapshots.stop()
            s.logs.stop()
            s.frames.stop(s.app)
            s.memory.stop()
            s.deviceContext.stop(s.app)
            s.startup.stop(s.app)
            s.exitInfo.stop()
            s.autoWire.stop()
            s.watchdog.stop()
            s.strictMode?.stop()
            LeakCanaryPorthole.uninstall()
            s.recompositions.stop()
            s.compositionTree.stop(s.app)
            s.nav?.unregister()
            s.workManager?.stop()
            session = null
        }
    }

    // -- registration ------------------------------------------------------

    /**
     * Names the state held by a ViewModel (or any object) so recomposition
     * reports say `CartViewModel.items` instead of `<unnamed:...>`.
     *
     * Call it where you create or first obtain the ViewModel. Naming applies
     * from that moment on; writes that already happened stay anonymous.
     */
    @JvmStatic
    fun registerViewModel(name: String, viewModel: Any) {
        session?.state?.register(name, viewModel)
    }

    /**
     * Tracks a NavController's back stack, arguments and deep link.
     *
     * Typed as [Any] so this class stays loadable in apps that do not use
     * androidx.navigation at all. Pass a `NavController`.
     */
    @JvmStatic
    fun registerNavController(controller: Any) {
        val s = session ?: return
        val nav = s.nav ?: run {
            Log.w(TAG, "androidx.navigation is not on the classpath, ignoring NavController")
            return
        }
        runCatching { nav.register(controller as androidx.navigation.NavController) }
            .onFailure { Log.w(TAG, "registerNavController expected a NavController", it) }
    }

    /**
     * Reports a back stack the app owns itself, rather than one androidx holds.
     *
     * Navigation 3 has no NavController to hook: the back stack is a snapshot
     * list belonging to the app, so there is nothing for the tool to discover
     * and it has to be handed over. [live.gravitylabs.porthole.compose.PortholeBackStack]
     * is the ergonomic way in; this is what it calls.
     *
     * Safe to call on every change. A repeat of the current destination is
     * dropped, so recomposition does not fill the lane with duplicates.
     */
    @JvmStatic
    fun reportBackStack(routes: List<String>) {
        session?.nav3?.report(routes)
    }

    /**
     * Marks a moment on the timeline.
     *
     * ```kotlin
     * Porthole.mark("checkout started")
     * ```
     *
     * A flat trace says a 426ms stall happened; a marked one says it happened
     * during "checkout started", which is most of the way to a cause.
     *
     * Meant for whatever knows the shape of the run. An instrumented test is in
     * the app's process, so a connectedAndroidTest can mark its own steps with
     * no protocol and no coordination; the app can mark its own phases the same
     * way. Costs one event.
     */
    @JvmStatic
    @JvmOverloads
    fun mark(label: String, detail: String? = null) {
        val s = session ?: return
        s.ring.emit(
            EventKinds.MARK,
            JsonObject(
                buildMap {
                    put("label", JsonPrimitive(label))
                    if (!detail.isNullOrBlank()) put("detail", JsonPrimitive(detail))
                },
            ),
        )
    }

    /**
     * The documented fallback. Call `Activity.reportFullyDrawn()` — the
     * standard Android API — and in a Compose app, or any app whose Activity
     * extends `androidx.activity.ComponentActivity`, that is already enough:
     * [live.gravitylabs.porthole.integration.ComponentActivityPorthole]
     * hooks `ComponentActivity`'s own `fullyDrawnReporter` automatically, no
     * app code at all. This exists for the Activity that is not one — Android
     * otherwise gives nothing outside the app a way to observe a plain
     * `Activity.reportFullyDrawn()` call: there is no listener for it, and
     * the system's own logcat line naming it is written by `system_server`,
     * under a different uid than the app's own — the same restriction
     * [live.gravitylabs.porthole.collect.LogCollector]'s doc comment already
     * describes for why that collector can only ever see the app's own
     * output. Skip both and `findings` says once, as a note, that it was
     * never observed — an honest "we don't know", not a claim that the app
     * is slow to draw.
     *
     * A no-op once the `startup` event has already been emitted (see
     * `StartupCollector`'s grace window) — late is better than a second,
     * contradictory event, but it is still late, so nothing here pretends
     * otherwise.
     */
    @JvmStatic
    fun reportFullyDrawn() {
        session?.startup?.onReportFullyDrawn()
    }

    /** Give a [androidx.compose.runtime.State] a readable name. */
    @JvmStatic
    fun nameState(state: Any, name: String) {
        session?.snapshots?.name(state, name)
    }

    /**
     * Makes a Compose view's semantics tree readable by the `semantics_tree`
     * tool.
     *
     * Only needed for a `ComposeView` hosted inside a View hierarchy, which
     * the porthole cannot find on its own. A wholly Compose Activity is
     * discovered without help.
     */
    @JvmStatic
    fun attachComposeView(view: View) {
        session?.semantics?.attach(view)
    }

    /** Undoes [attachComposeView]. Call it when the view goes away. */
    @JvmStatic
    fun detachComposeView(view: View) {
        session?.semantics?.detach(view)
    }

    // -- internal hooks ----------------------------------------------------

    internal fun inflight(): InflightCollector? = session?.inflight

    internal fun onRecompose(nodeId: String, name: String, screen: String?, pass: Int) {
        val s = session ?: return
        // GRA-235: causal attribution for a wrapped call site, when the
        // observer has a pass open — otherwise unchanged (null falls back to
        // RecompositionCollector's own temporal correlation). Order matters:
        // read the pass's triggers before notifying it fired, since
        // notifyWrappedFired is what onEndComposition uses to decide how many
        // map entries this pass's wrapped fires account for.
        val causalTriggers = s.compositionTree.currentPassTriggers()
        s.compositionTree.notifyWrappedFired()
        s.recompositions.onRecompose(nodeId, name, screen, pass, causalTriggers)
    }

    // -- rpc ---------------------------------------------------------------

    private fun registerMethods(s: Session) = with(s.server) {
        method("hello") {
            encode(
                Hello.serializer(),
                Hello(
                    packageName = s.app.packageName,
                    processName = processName(s.app),
                    versionName = runCatching {
                        s.app.packageManager.getPackageInfo(s.app.packageName, 0).versionName
                    }.getOrNull(),
                    debuggable = isDebuggable(s.app),
                    device = Build.MANUFACTURER + " " + Build.MODEL,
                    sdkInt = Build.VERSION.SDK_INT,
                    startedAt = s.startedAt,
                    collectors = s.collectors,
                    deviceId = androidId(s.app),
                ),
            )
        }

        method("recompositions") { params ->
            encode(
                RecompositionReport.serializer(),
                s.recompositions.report(
                    screen = params.string("screen"),
                    sinceMs = params.long("sinceMs"),
                    from = params.long("from"),
                    to = params.long("to"),
                    limit = params.long("limit")?.toInt(),
                ),
            )
        }

        method("semantics_tree") { params ->
            encode(
                SemanticsTree.serializer(),
                s.semantics.capture(
                    merged = params.bool("merged") ?: true,
                    maxDepth = params.int("maxDepth") ?: 40,
                    maxNodes = params.int("maxNodes") ?: 1500,
                ),
            )
        }

        method("nav_state") {
            val nav = s.nav
            if (nav == null) {
                encode(
                    NavState.serializer(),
                    NavState(
                        capturedAt = nowMs(),
                        graph = null,
                        current = null,
                        backStack = emptyList(),
                        deepLink = null,
                        error = "androidx.navigation is not on this app's classpath.",
                    ),
                )
            } else {
                encode(NavState.serializer(), nav.capture())
            }
        }

        method("state") { params ->
            encode(
                StateDump.serializer(),
                s.state.dump(only = params.string("viewModel") ?: params.string("owner")),
            )
        }

        method("db_tables") { params ->
            encode(DbTables.serializer(), s.dbInspector.tables(params.string("database")))
        }

        method("db_rows") { params ->
            encode(
                DbPage.serializer(),
                s.dbInspector.rows(
                    dbName = params.string("database"),
                    table = params.string("table").orEmpty(),
                    limit = params.int("limit") ?: 100,
                    offset = params.int("offset") ?: 0,
                    withCount = params.bool("count") ?: true,
                ),
            )
        }

        method("db_query") { params ->
            encode(
                DbPage.serializer(),
                s.dbInspector.query(params.string("database"), params.string("sql").orEmpty()),
            )
        }

        method("exit_trace") { params ->
            val timestamp = params.long("timestamp")
            encode(
                ExitTraceResult.serializer(),
                if (timestamp == null) {
                    // Missing, empty and malformed all land here alike:
                    // `JsonObject.long` returns null for every one of them
                    // (an absent key, an empty string, a non-numeric
                    // string), and there is no meaningful distinction to
                    // draw between "you forgot the argument" and "you sent
                    // something that isn't a timestamp" — both mean the
                    // caller has no timestamp to ask about.
                    ExitTraceResult(
                        timestamp = -1,
                        found = false,
                        error = "missing or malformed `timestamp` parameter",
                    )
                } else {
                    s.exitInfo.trace(timestamp)
                },
            )
        }

        method("setup") {
            encode(ListSerializer(SetupEntry.serializer()), Setup.report())
        }

        method("inflight") { params ->
            // GRA-66: recentHttp is now window-aware, same sinceMs/from/to/limit
            // shape as `logs`/`timeline` below — the live `http`/`queries`/`work`
            // sets inside Inflight are unaffected, see `capture`'s own comment.
            encode(
                Inflight.serializer(),
                s.inflight.capture(
                    sinceMs = params.long("sinceMs"),
                    from = params.long("from"),
                    to = params.long("to"),
                    limit = params.int("limit") ?: InflightCollector.RECENT_HTTP_DEFAULT_LIMIT,
                ),
            )
        }

        method("logs") { params ->
            encode(
                LogPage.serializer(),
                s.logs.page(
                    minLevel = params.string("level"),
                    tag = params.string("tag"),
                    contains = params.string("contains"),
                    sinceMs = params.long("sinceMs"),
                    from = params.long("from"),
                    to = params.long("to"),
                    limit = params.int("limit") ?: 200,
                ),
            )
        }

        method("timeline") { params ->
            val events = timelineEvents(
                ring = s.ring,
                sinceSeq = params.long("sinceSeq"),
                sinceMs = params.long("sinceMs"),
                from = params.long("from"),
                to = params.long("to"),
                limit = params.int("limit") ?: 1000,
                now = nowMs(),
            )
            encode(
                TimelinePage.serializer(),
                TimelinePage(
                    events = events,
                    droppedBefore = s.ring.oldestSeq(),
                    now = nowMs(),
                ),
            )
        }

        method("frames") { params ->
            encode(
                FrameReport.serializer(),
                s.frames.report(
                    sinceMs = params.long("sinceMs"),
                    from = params.long("from"),
                    to = params.long("to"),
                    limit = params.int("limit") ?: 20,
                ),
            )
        }

        method("blocking") { params ->
            // One reading of the clock for the whole answer.
            //
            // This used to work the window out twice — once inside the watchdog
            // and once here for the inflight collector — from two calls to
            // nowMs() a few milliseconds apart. A single `blocking` answer
            // therefore reported stalls and main-thread queries over two windows
            // that did not line up, and nothing in the output said so, which is
            // not something anybody was ever going to debug from the result.
            val window = Window.resolve(
                sinceMs = params.long("sinceMs"),
                from = params.long("from"),
                to = params.long("to"),
                now = nowMs(),
            )
            encode(
                BlockingReport.serializer(),
                blockingReport(s.watchdog, s.inflight, window, params.int("limit") ?: 20),
            )
        }

        method("reset") {
            s.recompositions.reset()
            s.frames.reset()
            s.watchdog.reset()
            s.inflight.clearMainThreadQueries()
            JsonObject(mapOf("ok" to JsonPrimitive(true)))
        }
    }

    private fun <T> encode(serializer: SerializationStrategy<T>, value: T): JsonElement =
        PortholeJson.encodeToJsonElement(serializer, value)

    // -- helpers -----------------------------------------------------------

    private fun JsonObject.string(key: String): String? =
        this[key]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() && it != "null" }

    private fun JsonObject.long(key: String): Long? = this[key]?.jsonPrimitive?.longOrNull

    private fun JsonObject.int(key: String): Int? = this[key]?.jsonPrimitive?.intOrNull

    private fun JsonObject.bool(key: String): Boolean? = this[key]?.jsonPrimitive?.booleanOrNull

    /**
     * Package prefixes that count as "the app".
     *
     * The Application subclass is the better signal, because an applicationId
     * carries build-type suffixes the code does not, but both are used since a
     * default Application means there is no class to ask.
     */
    private fun appPackagesOf(app: Application): List<String> = buildList {
        app.javaClass.`package`?.name
            ?.takeIf { it.isNotEmpty() && !it.startsWith("android") }
            ?.let { add(it + ".") }
        app.packageName
            .takeIf { it.isNotEmpty() }
            ?.let { if (none { prefix -> it.startsWith(prefix) }) add(it + ".") }
    }

    private fun classPresent(name: String): Boolean =
        runCatching { Class.forName(name, false, Porthole::class.java.classLoader) }.isSuccess

    /**
     * GRA-240: the actual OS-enforced flag, not the literal `true` this used
     * to be. `ApplicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE` is
     * what `dumpsys package` reports as `pkgFlags`'s `DEBUGGABLE` entry, and
     * what decides whether `run-as`/JDWP attach work — the same signal a
     * release build's manifest (`android:debuggable` defaulting to `false`,
     * forced `false` by AGP's own release signing regardless of manifest
     * overrides) is judged by. `getOrDefault(false)`: a context that cannot
     * even answer this is treated as not debuggable, never the other way.
     */
    private fun isDebuggable(context: Context): Boolean = runCatching {
        (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    }.getOrDefault(false)

    /**
     * Best-effort name for the one line [install] logs when it refuses to
     * start. There is no public Android API for "which Gradle build type is
     * this" — that is a compile-time AGP concept — so this reflects on the
     * consuming app's own generated `<applicationId>.BuildConfig.BUILD_TYPE`,
     * the same field AGP writes for every variant. Reflection because
     * `runtime` cannot depend on an app module's generated class; any failure
     * (obfuscated away, field renamed, class simply absent) reads as
     * `"unknown"` rather than throwing from inside a log line.
     */
    private fun buildTypeOf(context: Context): String = runCatching {
        val cls = Class.forName(context.packageName + ".BuildConfig", false, context.classLoader)
        cls.getField("BUILD_TYPE").get(null) as? String
    }.getOrNull() ?: "unknown"

    /**
     * The Gradle plugin writes the port as a generated integer resource, which
     * avoids a manifest placeholder the consuming app would have to declare.
     * Without the plugin, or with it left at its default, this is [DEFAULT_PORT].
     */
    private fun portFromResources(context: Context): Int = runCatching {
        val id = context.resources.getIdentifier(RES_PORT, "integer", context.packageName)
        if (id != 0) context.resources.getInteger(id) else DEFAULT_PORT
    }.getOrDefault(DEFAULT_PORT).let { if (it in 1024..65535) it else DEFAULT_PORT }

    /**
     * The Gradle plugin's `ringCapacity` DSL setting, written the same way as
     * the port: a generated integer resource ([RES_RING_CAPACITY]), not a
     * second plugin-to-runtime mechanism. Without the plugin, or with the
     * resource absent or out of a sane range, this is
     * [EventRing.DEFAULT_CAPACITY] — the same fallback shape
     * [portFromResources] uses for the port.
     */
    private fun ringCapacityFromResources(context: Context): Int = sanitizeRingCapacity(
        runCatching {
            val id = context.resources.getIdentifier(RES_RING_CAPACITY, "integer", context.packageName)
            if (id != 0) context.resources.getInteger(id) else null
        }.getOrNull(),
    )

    /**
     * The clamp behind [ringCapacityFromResources], separated so it can be
     * tested without a `Context`. It is load-bearing: `EventRing` indexes
     * `slots[n % capacity]`, so a configured capacity of 0 (or below) that
     * reached the constructor would throw on the first event. `null` means
     * "no resource", which is the same case as an unusable value.
     */
    internal fun sanitizeRingCapacity(configured: Int?): Int =
        if (configured != null && configured > 0) configured else EventRing.DEFAULT_CAPACITY

    /**
     * The Gradle plugin's `strictMode` DSL setting, written the same way as
     * the port and ring capacity: a generated resource
     * ([RES_STRICT_MODE]), not a second plugin-to-runtime mechanism. Absent
     * resource (no plugin, or a plugin build predating GRA-59) reads as
     * `false` — the same "off unless told otherwise" default the plugin
     * extension itself uses, so a build applying an old plugin jar against a
     * new runtime does not accidentally turn this on.
     */
    private fun strictModeFromResources(context: Context): Boolean = runCatching {
        val id = context.resources.getIdentifier(RES_STRICT_MODE, "bool", context.packageName)
        if (id != 0) context.resources.getBoolean(id) else false
    }.getOrDefault(false)

    /**
     * The Gradle plugin's `legacyTcpPort` DSL setting (GRA-199), written the
     * same way as `strictMode`: a generated `bool` resource
     * ([RES_LEGACY_TCP_PORT]), absent (reads `false`) for a build that
     * predates this flag or never set it — which is also the correct
     * default: the abstract socket is what fixes the two-apps-one-device
     * collision, so opting into the old behaviour has to be a deliberate,
     * named choice, not something a stale plugin jar could silently keep
     * alive. See the Gradle plugin's `PortholeExtension.legacyTcpPort` KDoc
     * for who this is for and how long it is staying.
     */
    private fun legacyTcpPortFromResources(context: Context): Boolean = runCatching {
        val id = context.resources.getIdentifier(RES_LEGACY_TCP_PORT, "bool", context.packageName)
        if (id != 0) context.resources.getBoolean(id) else false
    }.getOrDefault(false)

    /**
     * The Gradle plugin's `composableNames` DSL setting (GRA-235), written
     * the same way as `strictMode`: a generated `bool` resource
     * ([RES_COMPOSABLE_NAMES]), absent (reads `false`) for a build predating
     * this flag or never setting it — the same off-by-default a stale plugin
     * jar has to fall back to, since turning this on changes how the app
     * under test recomposes (`forceRecomposeScopes`) and that has to be a
     * deliberate choice. See [live.gravitylabs.porthole.collect.CompositionTreeCollector]'s
     * own doc comment for what it costs.
     */
    private fun composableNamesFromResources(context: Context): Boolean = runCatching {
        val id = context.resources.getIdentifier(RES_COMPOSABLE_NAMES, "bool", context.packageName)
        if (id != 0) context.resources.getBoolean(id) else false
    }.getOrDefault(false)

    private fun processName(context: Context): String = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            Application.getProcessName()
        } else {
            // cmdline is NUL-padded; the process name is the leading token.
            File("/proc/self/cmdline").readText().takeWhile { it > ' ' }
        }
    }.getOrDefault(context.packageName)

    /**
     * [Hello.deviceId]'s source — see that field's KDoc for why this is
     * `Settings.Secure.ANDROID_ID` and specifically not adb's serial. No
     * permission is required to read it. Null on the rare device where it is
     * genuinely absent, rather than a synthesised value the reading side
     * would mistake for a real one.
     */
    private fun androidId(context: Context): String? = runCatching {
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
    }.getOrNull()?.takeIf { it.isNotBlank() }

    /**
     * Drops a marker in the app's files dir naming the port the runtime actually
     * bound, and (GRA-199) which on-device endpoint it is actually listening
     * on: `socket` is the abstract socket name a `localabstract:` forward
     * targets, `null` when [legacyTcp] bound the old shared TCP port
     * instead — the two are mutually exclusive by construction, the same way
     * [PortholeSocketServer]'s own bind is.
     *
     * Nothing reads this back today — `portholeConnect` forwards whatever port
     * the extension is configured with, not this file's. Kept anyway because it
     * is the one place that records the port Porthole actually bound rather than
     * the one it was told to try, which is what a future `portholeConnect` would
     * need to discover a port over `adb shell run-as <pkg> cat files/porthole.json`
     * instead of assuming the configured value matches. Tracked as a follow-up
     * (GRA-141); until that lands, do not describe this as read by anything.
     */
    private fun writeConnectionFile(context: Context, port: Int, legacyTcp: Boolean) {
        runCatching {
            val socket = if (legacyTcp) "null" else "\"${portholeSocketName(context.packageName)}\""
            File(context.filesDir, "porthole.json").writeText(
                """{"port":$port,"package":"${context.packageName}","socket":$socket,"protocol":1}""",
            )
        }.onFailure { Log.d(TAG, "could not write connection marker: ${it.message}") }
    }

    private const val RES_PORT = "porthole_port"
    private const val RES_RING_CAPACITY = "porthole_ring_capacity"
    private const val RES_STRICT_MODE = "porthole_strict_mode"
    private const val RES_LEGACY_TCP_PORT = "porthole_legacy_tcp_port"
    private const val RES_COMPOSABLE_NAMES = "porthole_composable_names"
}

/**
 * The events `timeline` returns, assembled outside the RPC handler so the
 * window logic can be checked without a device — same reason [blockingReport]
 * lives out here.
 *
 * Four mutually-exclusive modes, not three: a cursor ([sinceSeq], for a
 * client backfilling from where it last left off), the three time-bounded
 * shapes every other collector already shares ([sinceMs], [from]/[to], or
 * both — see [Window.resolve] for exactly what each combination means), and
 * "give me everything buffered" when none of the four is given.
 *
 * The time-bounded shapes used to be handled by hand here, tested with
 * `from != null || to != null` **first** — so a caller who sent both
 * `sinceMs` and `to` (exactly what an agent does when it quotes a `findings`
 * window into `timeline`) had `sinceMs` silently thrown away and got
 * `between(0, to)` instead of the window it asked for. The same code also
 * left the `sinceMs`-only branch with no ceiling at all, and used
 * `to ?: Long.MAX_VALUE` as the from/to branch's ceiling — GRA-84's precise
 * unbounded-ceiling defect, already fixed everywhere else. Routing through
 * [Window.resolve] fixes all three at once by construction, and it is the
 * same call `frames`' `report(sinceMs, from, to, limit)` makes, so the two
 * resolve to the same range for the same arguments — that agreement is what
 * `TimelineWindowTest` pins.
 *
 * The cursor mode is unchanged: `Window` has no concept of a sequence
 * number, and folding it in was explicitly out of GRA-84's scope and stays
 * out of this fix's too. It is also unconditionally ranked below the
 * time-bounded shapes, exactly as `from`/`to` already outranked it before
 * this change — no caller has ever sent `sinceSeq` alongside a time bound,
 * so this is a distinction without a difference in practice, but it keeps
 * the precedence rule simple: any of `sinceMs`/`from`/`to` present means a
 * time-bounded request.
 */
internal fun timelineEvents(
    ring: EventRing,
    sinceSeq: Long?,
    sinceMs: Long?,
    from: Long?,
    to: Long?,
    limit: Int,
    now: Long,
): List<EventFrame> = when {
    sinceMs != null || from != null || to != null -> {
        val window = Window.resolve(sinceMs, from, to, now)
        ring.between(window.first, window.last, limit)
    }
    sinceSeq != null -> ring.since(sinceSeq, limit)
    else -> ring.since(ring.oldestSeq(), limit)
}

/**
 * The `blocking` answer, assembled from one window.
 *
 * Outside the RPC handler so that the two properties that matter here can be
 * checked without a device. Both halves of the report are drawn from the same
 * [window] — they used to be drawn from two, resolved milliseconds apart — and
 * the threshold it quotes comes off the watchdog that enforces it rather than
 * from a literal written alongside. A literal was what it had, and the two
 * numbers were free to drift apart in the one field that tells an agent what
 * "nothing blocked the main thread in this window" means. A report saying 100ms
 * while the watchdog waited 250 is worse than no threshold at all, because it
 * reads as precision.
 */
internal fun blockingReport(
    watchdog: MainThreadWatchdog,
    inflight: InflightCollector,
    window: LongRange,
    limit: Int,
): BlockingReport {
    val stalls = watchdog.report(window, limit)
    val queries = inflight.mainThreadQueries(window, limit)
    // Renders calls that may still be running, so their fields are read live rather than under the writer's lock.
    val calls = inflight.mainThreadHttp(window, limit)
    return BlockingReport(
        stalls = stalls,
        mainThreadQueries = queries,
        mainThreadHttp = calls,
        stallThresholdMs = watchdog.stallThresholdMs,
        notes = buildList {
            if (calls.isNotEmpty()) {
                add(
                    "HTTP on the main thread is normally impossible: OkHttp throws " +
                        "NetworkOnMainThreadException for it. These calls went around " +
                        "that somehow and are worth looking at closely.",
                )
            }
            if (stalls.isEmpty() && queries.isEmpty() && calls.isEmpty()) {
                add("Nothing blocked the main thread in this window.")
            }
            add(
                "A stall is the main thread failing to answer a ping for longer than " +
                    "the threshold; the stack is where it was at that moment. Shorter " +
                    "hitches show up in `frames` instead.",
            )
            if (queries.isNotEmpty()) {
                add(
                    "Database work on the main thread is a defect regardless of how " +
                        "fast it was: it is a disk read in the frame loop.",
                )
            }
            add(
                "Work that began before this window and was still running inside it is " +
                    "included: a query that started early and held the main thread is the " +
                    "cause you are looking for, not an entry to filter out.",
            )
        },
    )
}
