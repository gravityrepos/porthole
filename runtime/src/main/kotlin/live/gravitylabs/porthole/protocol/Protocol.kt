// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import live.gravitylabs.porthole.nowMs

/**
 * The wire format is newline-delimited JSON over one local socket per
 * connection.
 *
 * GRA-199: the socket itself is, by default, an abstract-namespace Unix
 * domain socket keyed by package name rather than a loopback TCP port shared
 * by every app on the device (`porthole { legacyTcpPort.set(true) }` keeps
 * the old TCP bind for one release) — this file's framing does not care
 * which one carries it, and neither does anything below.
 *
 * Two kinds of frame travel on the same connection:
 *  - request / response, correlated by [Request.id]
 *  - events, pushed by the device whenever something happens
 *
 * A frame with an "id" is a response; a frame with an "event" is an event.
 * Both directions are UTF-8, one JSON object per line, no embedded newlines.
 */
internal val PortholeJson: Json = Json {
    encodeDefaults = true
    ignoreUnknownKeys = true
    explicitNulls = false
    isLenient = true
}

@Serializable
internal data class Request(
    val id: Int,
    val method: String,
    val params: JsonObject = JsonObject(emptyMap()),
)

@Serializable
internal data class Response(
    val id: Int,
    val ok: Boolean,
    val result: JsonElement? = null,
    val error: String? = null,
)

@Serializable
internal data class EventFrame(
    val event: String,
    /** Device uptime in millis, from the porthole's own monotonic clock. */
    val t: Long,
    /** Monotonic per-process sequence number; the UI uses it to detect gaps. */
    val seq: Long,
    val data: JsonElement,
)

// ---------------------------------------------------------------------------
// hello
// ---------------------------------------------------------------------------

@Serializable
internal data class Hello(
    val protocol: Int = PROTOCOL_VERSION,
    val packageName: String,
    val processName: String,
    val versionName: String?,
    val debuggable: Boolean,
    val device: String,
    val sdkInt: Int,
    /** Device uptime when the porthole was installed; the timeline's origin. */
    val startedAt: Long,
    /** Which collectors actually found their dependency on the classpath. */
    val collectors: List<String>,
    /**
     * Identifies *this device*, distinct from another device running the same
     * app at the same [startedAt] — GRA-53's on-disk session identity is
     * `(packageName, deviceId, startedAt)`, and two physical devices are the
     * one case that triple cannot otherwise tell apart. Sourced from
     * `Settings.Secure.ANDROID_ID` in [Porthole]'s `hello` method — **not**
     * adb's serial number. Those are two different concepts: the adb serial
     * is host-side, known to the plugin as `deviceSerial`
     * (`PortholeConnectTask.connectionFile`'s `deviceSerial` key) and never
     * seen by the app; `ANDROID_ID` is device-side, needs no permission, and
     * is stable per device+signing-key. `mcp/src/sessions.ts`'s `HelloLike`
     * carries the identical name and doc comment for the same reason.
     *
     * Optional and defaulted so this is additive under
     * `ignoreUnknownKeys=true`/`explicitNulls=false` — no [PROTOCOL_VERSION]
     * bump. Null when `ANDROID_ID` could not be read, or when talking to a
     * runtime built before this field existed; the reading side falls back to
     * a named sentinel (`sessions.ts`'s `UNKNOWN_DEVICE_ID`) rather than
     * treating absence as a crash.
     */
    val deviceId: String? = null,
)

/**
 * The wire format's own version, sent as [Hello.protocol] and — as of GRA-96
 * — actually checked by the receiving end (`mcp/src/device.ts` owns a copy
 * of this same integer and compares it against what a connecting app sends).
 * Before GRA-96 the field was sent and never read: a runtime built against
 * one wire format and an MCP server built against another connected without
 * complaint and simply produced whatever partial nonsense `ignoreUnknownKeys`
 * and missing-field defaults happened to paper over.
 *
 * Compatibility rule, for whoever edits this next: this is a bare integer,
 * not a `major.minor` pair, so there is no partial-compatibility case to
 * reason about — every value here already *is* a major version, and "same
 * major" reduces to "the two sides sent the same number". Concretely:
 *
 *  - `hello.protocol == PROTOCOL_VERSION` on the reading side: compatible,
 *    proceed as today.
 *  - any other value: a refusal, not a best-effort attempt to limp along —
 *    the receiving side reports which two versions disagree and what to do
 *    about it (update the runtime dependency, or pin the npm package to a
 *    matching version) rather than silently decoding a frame shaped
 *    differently than it expects.
 *
 * Bumping this number is a breaking-wire-format change by definition: it
 * obliges updating the constant `device.ts` compares against in the same
 * commit (search that file for `PROTOCOL_VERSION`), and it means every app
 * built against the old runtime will be refused by a newer MCP server (and
 * vice versa) until it is rebuilt. That is the point — a silent partial
 * decode is exactly the failure mode this version field exists to prevent.
 */
internal const val PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------
// GRA-199 QA (F2): the abstract socket's name, in one place
// ---------------------------------------------------------------------------

/**
 * `porthole.` — the prefix on the abstract-namespace socket
 * [PortholeSocketServer] binds by default, and on the `localabstract:`
 * forward target the Gradle plugin (`PortholeTasks.kt`'s `forwardTarget`) and
 * the MCP server (`mcp/src/devices.ts`'s `forwardTarget`) build to reach it.
 *
 * QA on GRA-199's first pass found six independent copies of this string —
 * two inside [PortholeSocketServer] alone — and nothing that would catch one
 * of them drifting a single character: a mismatched prefix or separator
 * still produces a syntactically valid `adb forward`, one that connects to
 * adb without error and simply never reaches the app, which is a much
 * quieter failure than a bind that refuses outright. Runtime call sites
 * ([PortholeSocketServer], [live.gravitylabs.porthole.Porthole]) now all go
 * through [portholeSocketName] instead of rebuilding the string. The other
 * two — `PortholeTasks.kt` in the `gradle-plugin` module and `devices.ts` in
 * `mcp/` — cannot import this constant at all (neither module depends on
 * `runtime`, deliberately: see `AndroidWiring.kt`'s own doc comment on why
 * AGP is kept out of this module and, symmetrically, why this module is kept
 * out of a plain Kotlin/TS build). Each keeps its own literal, and a
 * source-text parity test in each of those two modules reads this constant
 * back out of this file and asserts theirs matches — the same technique
 * `device.test.ts`'s `PROTOCOL_VERSION` check and `eventKinds.test.ts`
 * already use for the same cross-module-drift problem.
 */
internal const val PORTHOLE_SOCKET_PREFIX = "porthole."

/**
 * The abstract socket's full name for [packageName] — [PORTHOLE_SOCKET_PREFIX]
 * plus the package, unmodified. Not trimmed or otherwise sanitised: the
 * package name is [android.content.Context.getPackageName], never user input
 * at this layer, so there is nothing here to sanitise against — GRA-199 QA
 * (F3) trims the applicationId earlier, at the point it is read off a Gradle
 * `Property`/`process.env`, which is the actual source of the stray
 * whitespace a hand-edited build script or `.mcp.json` could introduce.
 */
internal fun portholeSocketName(packageName: String): String = PORTHOLE_SOCKET_PREFIX + packageName

// ---------------------------------------------------------------------------
// event kinds
// ---------------------------------------------------------------------------

/**
 * Every value [EventFrame.event] can carry, named once instead of typed as a
 * string literal at each of the dozen call sites that used to spell it out
 * separately (`DeviceCollector.emit`, `InflightCollector.emit`,
 * `LogCollector.record`, and the rest — see GRA-200's own history for the
 * grep that found them). No behaviour change: every value here is the exact
 * string that travelled on the wire before this object existed, and a
 * collector referencing `EventKinds.NAV` instead of `"nav"` produces an
 * identical `EventFrame`.
 *
 * This is also the set `mcp/src/eventKinds.ts`'s own `EVENT_KINDS` is meant
 * to equal — `eventKinds.test.ts` reads this file's source as text and
 * compares the two, so a kind added on only one side of the wire fails a
 * test instead of silently going unrecognised by whichever side did not
 * hear about it. That test parses exactly this object (`object EventKinds
 * { ... }`, one `const val NAME = "value"` per line), which is why
 * [DeviceEventKinds] below — real kinds, but nested inside a `device`
 * event's own `data.kind` rather than carried as [EventFrame.event] itself
 * — lives in a separate object rather than inside this one: mixing the two
 * would make "every kind `timeline`'s `kinds` filter actually admits" and
 * "every kind `EventFrame.event` can equal" the same list when they are not.
 */
internal object EventKinds {
    /** A Compose node recomposed. RecompositionCollector. */
    const val RECOMPOSE = "recompose"

    /** A tracked `MutableState`/`StateFlow`/plain field was written. SnapshotWatcher. */
    const val STATE_WRITE = "state_write"

    /** One rendered frame, with its phase breakdown. FrameCollector. */
    const val FRAME = "frame"

    /** A navigation to a new destination, from either NavController or an app-owned back stack. NavCollector, BackStackCollector. */
    const val NAV = "nav"

    /** An HTTP call began. InflightCollector. */
    const val HTTP_START = "http_start"

    /** An HTTP call finished, failed, or was canceled. InflightCollector. */
    const val HTTP_END = "http_end"

    /** A database query began. InflightCollector. */
    const val DB_START = "db_start"

    /** A database query finished. InflightCollector. */
    const val DB_END = "db_end"

    /** One captured logcat line. LogCollector. */
    const val LOG = "log"

    /** A continuation line (a stack trace frame) for a `log` entry already sent. LogCollector. */
    const val LOG_APPEND = "log_append"

    /** An app- or test-authored marker, from `Porthole.mark()`. */
    const val MARK = "mark"

    /** Device/app/system state changed; see [DeviceEventKinds] for what `data.kind` names. DeviceCollector. */
    const val DEVICE = "device"

    /** The process died; `ExitInfoCollector` replayed it from `ApplicationExitInfo` at the next install. */
    const val EXIT = "exit"

    /** A WorkManager job started running. WorkManagerPorthole. */
    const val WORK_START = "work_start"

    /** A WorkManager job stopped running (succeeded, failed, or went back to enqueued for a retry). WorkManagerPorthole. */
    const val WORK_END = "work_end"

    /** The main thread did not respond to a scheduled ping for longer than the watchdog's threshold. MainThreadWatchdog. */
    const val BLOCKED = "blocked"

    /** One garbage collection, sampled from ART's own counters. MemoryCollector. */
    const val GC = "gc"

    /** A periodic heap/native/RAM sample. MemoryCollector. */
    const val MEMORY = "memory"

    /**
     * A `StrictMode` thread- or VM-policy violation whose stack named a
     * frame from the app's own package — one Porthole judged actionable,
     * not every violation the platform noticed. StrictModeCollector.
     */
    const val STRICT_VIOLATION = "strict_violation"
    /** One completed app launch, phases from process fork to first frame. StartupCollector. */
    const val STARTUP = "startup"

    /** One LeakCanary-classified leak (application or library) from a heap analysis. LeakCanaryPorthole (GRA-64). */
    const val LEAK = "leak"
}

/**
 * Values [DeviceCollector]'s own `data.kind` field can carry, inside an
 * [EventKinds.DEVICE] event. These are real, named kinds — the server
 * matches on several of them by name (`trace.ts`'s `resolveProfile` reads
 * `"profile"`, its `trims` reads `"trimMemory"`) — but they never appear as
 * [EventFrame.event] itself, so they cannot be passed to `timeline`'s
 * `kinds` filter the way [EventKinds]'s members can. Kept in a separate
 * object from [EventKinds] for that reason: see that object's own doc
 * comment for why the cross-language test depends on the two staying apart.
 */
internal object DeviceEventKinds {
    /** The one-time device/app/display profile emitted at install. */
    const val PROFILE = "profile"

    /** Porthole's clock against the system's, so a timestamp from elsewhere can be placed. */
    const val CLOCKS = "clocks"

    /** The app's first activity started. */
    const val FOREGROUND = "foreground"

    /** The app's last activity stopped. */
    const val BACKGROUND = "background"

    /** The display rotated. */
    const val ROTATION = "rotation"

    /** Dark mode toggled. */
    const val THEME = "theme"

    /** The system font scale changed. */
    const val FONT_SCALE = "fontScale"

    /** `ComponentCallbacks2.onTrimMemory` — the system asking for memory back. */
    const val TRIM_MEMORY = "trimMemory"

    /** `ComponentCallbacks2.onLowMemory`, the deprecated pre-API-34 signal. */
    const val LOW_MEMORY = "lowMemory"

    /** Battery/doze/power-save state changed. */
    const val POWER = "power"

    /** The active network transport changed, or was lost. */
    const val NETWORK = "network"

    /** `PowerManager`'s thermal status changed. DeviceCollector (GRA-73). */
    const val THERMAL = "thermal"

    /** An Activity's onCreate/onDestroy, classified rotation vs process restore. DeviceCollector (GRA-73). */
    const val ACTIVITY_LIFECYCLE = "activityLifecycle"

    /** The app's current permission grant set, at install and on every foreground transition. DeviceCollector (GRA-73). */
    const val PERMISSIONS = "permissions"
}

// ---------------------------------------------------------------------------
// recompositions
// ---------------------------------------------------------------------------

@Serializable
internal data class RecompositionReport(
    val since: Long,
    val now: Long,
    val nodes: List<RecompositionNode>,
    /** How many nodes recomposed in the window, before any limit. */
    val totalNodes: Int = 0,
    /** True when [nodes] is the busiest slice of a longer list. */
    val truncated: Boolean = false,
    /** Writes seen in the window that no instrumented node reacted to. */
    val unattributedWrites: List<StateWriteCount>,
    val notes: List<String> = emptyList(),
)

@Serializable
internal data class RecompositionNode(
    /** Stable across recompositions of the same call site. See portholeNodeId. */
    val id: String,
    val name: String,
    val screen: String?,
    val count: Int,
    val firstAt: Long,
    val lastAt: Long,
    /**
     * State objects written inside the attribution window before each
     * recomposition, ranked by how often they preceded one. This is a
     * correlation, not a causal read of the invalidation graph — see README.
     */
    val triggeredBy: List<StateWriteCount>,
)

@Serializable
internal data class StateWriteCount(
    val key: String,
    val count: Int,
    /** false when the key is a synthesised `unnamed#...` placeholder. */
    val named: Boolean = true,
    /**
     * For an anonymous key, the app type it was holding, when that could be
     * determined. Present means the state is the app's own and was never
     * registered. Absent means nothing either way.
     */
    val holds: String? = null,
)

// ---------------------------------------------------------------------------
// semantics_tree
// ---------------------------------------------------------------------------

@Serializable
internal data class SemanticsTree(
    val capturedAt: Long,
    val merged: Boolean,
    val root: SemanticsNodeDto?,
    val error: String? = null,
)

@Serializable
internal data class SemanticsNodeDto(
    /** Compose's own node id — unique while the node lives, reused after. */
    @SerialName("nodeId") val nodeId: Int,
    /** Structural id: stable across recomposition and across process restarts
     *  for the same tree shape. Use this to diff two captures. */
    val stableId: String,
    val role: String?,
    val testTag: String?,
    val text: String?,
    val contentDescription: String?,
    val bounds: Rect?,
    val actions: List<String> = emptyList(),
    val flags: List<String> = emptyList(),
    val children: List<SemanticsNodeDto> = emptyList(),
    val truncated: Boolean = false,
)

@Serializable
internal data class Rect(val left: Float, val top: Float, val right: Float, val bottom: Float)

// ---------------------------------------------------------------------------
// nav_state
// ---------------------------------------------------------------------------

@Serializable
internal data class NavState(
    val capturedAt: Long,
    val graph: String?,
    val current: NavEntry?,
    val backStack: List<NavEntry>,
    val deepLink: DeepLink?,
    val error: String? = null,
)

@Serializable
internal data class NavEntry(
    val route: String?,
    val destinationId: String,
    val label: String?,
    val args: Map<String, String> = emptyMap(),
    val lifecycleState: String? = null,
    /** Uptime millis when this entry was pushed, when the porthole saw the push. */
    val enteredAt: Long? = null,
)

@Serializable
internal data class DeepLink(
    val uri: String,
    val action: String?,
    val extras: Map<String, String> = emptyMap(),
    /** Uptime millis of the Intent that carried it. */
    val at: Long,
)

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

@Serializable
internal data class StateDump(
    val capturedAt: Long,
    val owners: List<StateOwner>,
)

@Serializable
internal data class StateOwner(
    val name: String,
    val type: String,
    val fields: List<StateField>,
)

@Serializable
internal data class StateField(
    val key: String,
    /** "MutableState", "StateFlow", "Flow(cached)", "plain" */
    val kind: String,
    val type: String,
    val value: JsonElement,
    /** Whether writes to this field are visible to the recomposition attributor. */
    val attributable: Boolean,
)

// ---------------------------------------------------------------------------
// inflight
// ---------------------------------------------------------------------------

@Serializable
internal data class Inflight(
    val capturedAt: Long,
    val http: List<HttpCall>,
    val queries: List<DbQuery>,
    val work: List<WorkJob>,
    /**
     * The last few finished HTTP calls, with whatever body capture was enabled.
     * Bodies are too big for the event ring, so the full preview lives here and
     * the timeline only carries a short snippet.
     */
    val recentHttp: List<HttpCall> = emptyList(),
    val notes: List<String> = emptyList(),
)

@Serializable
internal data class HttpCall(
    val id: String,
    val method: String,
    val url: String,
    val startedAt: Long,
    val elapsedMs: Long,
    /** queued | dns | connecting | headers | waiting | body | done | failed | canceled */
    val phase: String,
    val callStack: String? = null,
    /** True when the call's IO ran on the main thread. */
    val onMainThread: Boolean = false,
    val status: Int? = null,
    val requestHeaders: Map<String, String> = emptyMap(),
    val responseHeaders: Map<String, String> = emptyMap(),
    val requestBody: BodyPreview? = null,
    val responseBody: BodyPreview? = null,
    /**
     * GRA-66: OkHttp's own `EventListener` timings, only the phases actually
     * observed — `queued`, `dns`, `connect`, `secureConnect`, `dispatch`,
     * `requestHeaders`, `requestBody`, `waiting`, `responseBody` — each the
     * time *that phase itself* took (not cumulative), so summing every key
     * here should now genuinely land within a few ms of [elapsedMs] (QA
     * F11: it did not, before `queued` and `dispatch` existed — 73ms of a
     * 748ms call was dispatcher queueing before `dnsStart`, plus OkHttp's
     * own exchange setup between `connectionAcquired` and
     * `requestHeadersStart`, and neither had anywhere to go). `waiting` is
     * named to match [phase]'s own live label above, not OkHttp's callback
     * name (`responseHeadersStart`/`End`) — it is mostly server think time,
     * not header-parsing time; see `OkHttpPorthole.kt`'s own doc comment
     * for why it has to be timed from *before* that callback fires at all.
     *
     * `dns` and `connect` are summed across every attempt a call made
     * (QA F12) — an IPv6 attempt that failed before a IPv4 one succeeded is
     * not thrown away, [connectAttempts] says how many there were. The
     * header/body write/read phases are not: a redirect or an auth-challenge
     * retry re-runs its own request/response legs, and each one's callbacks
     * simply overwrite the last (QA F13, accepted rather than fixed) — they
     * describe the *final* leg only, while [elapsedMs] still spans the
     * whole call, every leg included.
     *
     * Empty for a call this collector has no `EventListener` timings for at
     * all — a Ktor call with no OkHttp engine underneath (see
     * `KtorPorthole`'s own doc comment for why that boundary is real, not
     * an oversight), or one still in flight.
     */
    val phases: Map<String, Long> = emptyMap(),
    /**
     * True when this call reused a pooled connection from OkHttp's own
     * `ConnectionPool` — the tell is that `connectStart` never fired for it,
     * so it structurally has no `dns`/`connect`/`secureConnect` phase of its
     * own. Always `false` for a call [phases] has nothing to say about.
     */
    val reused: Boolean = false,
    /** `Connection.protocol()`, e.g. `h2` or `http/1.1` — null before a connection is actually acquired, or for a call `phases` has nothing to say about. */
    val protocol: String? = null,
    /**
     * Bytes actually written for the request body, from
     * `EventListener.requestBodyEnd` — null for a request with no body
     * (a GET, say), never a fake zero standing in for "not measured."
     */
    val requestBytes: Long? = null,
    /** Bytes actually read for the response body, from `EventListener.responseBodyEnd` — same null-means-no-body rule as [requestBytes]. */
    val responseBytes: Long? = null,
    /** QA F12: how many `connectStart`s this call made — 1 for an ordinary connect, 2+ for a failover, 0 for a reused connection or a call [phases] has nothing to say about. */
    val connectAttempts: Int = 0,
)

/**
 * A bounded look at a request or response body.
 *
 * [text] is null whenever the body was not captured, and [omittedReason] then
 * says why — capture disabled, wrong content type, one-shot body. An absent
 * body and an uncaptured body are different facts and the difference matters
 * when you are chasing "did we even send that field".
 */
@Serializable
internal data class BodyPreview(
    val contentType: String?,
    val byteCount: Long,
    val truncated: Boolean,
    val text: String? = null,
    val omittedReason: String? = null,
)

@Serializable
internal data class DbQuery(
    val id: String,
    val sql: String,
    /** Bound values, in index order, redacted and truncated. */
    val args: List<String>,
    val startedAt: Long,
    val elapsedMs: Long,
    val thread: String,
    val done: Boolean,
    /** True when this ran on the main thread, which is almost always a bug. */
    val onMainThread: Boolean = false,
    /** read | write — a write is anything that went through a compiled statement or execSQL. */
    val kind: String = "read",
    /** Rows changed by an update or delete, or the new row id for an insert. */
    val result: Long? = null,
)

@Serializable
internal data class WorkJob(
    val id: String,
    val name: String,
    val state: String,
    val tags: List<String>,
    val runAttemptCount: Int,
)

// ---------------------------------------------------------------------------
// frames
// ---------------------------------------------------------------------------

@Serializable
internal data class FrameReport(
    val totalFrames: Long,
    val jankyFrames: Long,
    /** Frames the system dropped before it could hand us metrics for them. */
    val droppedBySystem: Long,
    /** The display's frame budget. 16ms at 60Hz, 8ms at 120Hz. */
    val frameIntervalMs: Long,
    val worst: List<JankyFrame>,
    val notes: List<String> = emptyList(),
)

@Serializable
internal data class MainThreadStall(
    /** Uptime the ping was posted; the stall had already begun. */
    val at: Long,
    val durationMs: Long,
    /** The main thread's stack when it became a stall, app frames first. */
    val stack: String,
)

@Serializable
internal data class BlockingReport(
    val stalls: List<MainThreadStall>,
    /** Queries that ran on the main thread, worst first. */
    val mainThreadQueries: List<DbQuery>,
    /** HTTP calls whose IO ran on the main thread. Normally impossible; see notes. */
    val mainThreadHttp: List<HttpCall> = emptyList(),
    val stallThresholdMs: Long,
    val notes: List<String> = emptyList(),
)

@Serializable
internal data class JankyFrame(
    /** Vsync time in device uptime, so it lines up with every other event. */
    val at: Long,
    val totalMs: Long,
    /** How many display refreshes this frame ate. 1 means one dropped frame. */
    val missedFrames: Int,
    /** The phase that took the most time — where to look first. */
    val worstPhase: String,
    val phases: Map<String, Long> = emptyMap(),
    /** First draw of a window is expected to be slow; not a real regression. */
    val firstDraw: Boolean = false,
)

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

@Serializable
internal data class LogEntry(
    /** Device uptime, converted from logcat's wall clock so it lines up with events. */
    val t: Long,
    /** The original logcat stamp, kept because the conversion is approximate. */
    val wallTime: String,
    /** V, D, I, W, E or F. */
    val level: String,
    val tag: String,
    val pid: Int,
    val tid: Int,
    val message: String,
)

@Serializable
internal data class LogPage(
    val entries: List<LogEntry>,
    /** True while the logcat reader is alive. */
    val capturing: Boolean,
    /** How many entries the ring has evicted since capture started. */
    val evicted: Long,
    val notes: List<String> = emptyList(),
)

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

@Serializable
internal data class TimelinePage(
    val events: List<EventFrame>,
    val droppedBefore: Long,
    val now: Long,
)

// ---------------------------------------------------------------------------
// database inspector
// ---------------------------------------------------------------------------

@Serializable
internal data class DbTable(
    val name: String,
    /** -1 when the count could not be taken, rather than a lie about being empty. */
    val rows: Int,
)

@Serializable
internal data class DbTables(
    val database: String? = null,
    val databases: List<String> = emptyList(),
    val tables: List<DbTable> = emptyList(),
    val error: String? = null,
)

@Serializable
internal data class DbColumn(
    val name: String,
    /** SQLite is dynamically typed, so this is the type of the value actually read. */
    val type: String,
)

@Serializable
internal data class DbPage(
    val table: String? = null,
    val columns: List<DbColumn> = emptyList(),
    val rows: List<List<String?>> = emptyList(),
    val total: Int = -1,
    val offset: Int = 0,
    val truncated: Boolean = false,
    val error: String? = null,
)

// ---------------------------------------------------------------------------
// exit
// ---------------------------------------------------------------------------
//
// The `exit` event itself (reason, importance, timestamp, pss, rss,
// description, versionName/versionAssumed, and — for REASON_ANR and
// REASON_CRASH_NATIVE only — mainStack/otherThreadCount/otherThreadStates)
// is built as a plain JsonObject in ExitInfoCollector, the same way
// `memory`/`device`/`blocked` are: it travels as a ring event, not a typed
// RPC result, so it has no Serializable data class here. `exit_trace` is an
// RPC method with an actual typed response, which is what this section is.

/** The `exit_trace` RPC's answer: the full redacted trace for one exit, fetched on demand. */
@Serializable
internal data class ExitTraceResult(
    val timestamp: Long,
    /** False for a timestamp with no matching exit, or an exit whose reason never carries a trace. */
    val found: Boolean,
    val text: String? = null,
    /** True when [text] was cut short at the cap; a note is already appended to [text] when so. */
    val truncated: Boolean = false,
    val error: String? = null,
)

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

@Serializable
internal data class SetupEntry(
    val name: String,
    /** The library is on the app's classpath. */
    val onClasspath: Boolean,
    /** Something was actually attached to it. */
    val instrumented: Boolean,
    /** What to do about it, when there is something to do. */
    val hint: String? = null,
)
