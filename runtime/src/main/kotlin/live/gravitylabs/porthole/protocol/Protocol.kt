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
 * The wire format is newline-delimited JSON over a loopback TCP socket.
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
