# Changelog

All notable changes to Porthole are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version
numbers are the one `porthole` entry in `gradle/libs.versions.toml`, which
`./gradlew release -Pversion=X.Y.Z` is the only thing that ever writes.

Reconstructed back to 0.1.0 from the commit history: 0.1.0 predates this
file, so that section is a best-effort summary rather than a per-PR record.
From here on, `release` refuses to run against an empty `## [Unreleased]`
section, so every release after 0.1.0 carries one — add to it as part of the
PR that makes the change, not after the fact.

## [Unreleased]

### Added

- `site/robots.txt` and `site/sitemap.xml`, so `/robots.txt` and
  `/sitemap.xml` return real content instead of a 404. The sitemap lists the
  landing page and the API reference directory, not the ~58 individual
  Dokka pages under it — those are meant to be found by search inside the
  reference, not indexed on their own (GRA-129).
- A `<link rel="canonical">` on `site/api/index.html`, added as a
  post-processing step of the `:runtime:apiDocs` Gradle task rather than
  hand-edited, since `apiDocs` is a `Sync` that overwrites the file from
  Dokka's output on every run (GRA-129).

### Changed

- The landing page's `<title>`, meta description and Open Graph tags now
  name the terms an Android developer with this problem would actually
  search — MCP, Perfetto, recompositions, frames, main-thread stalls,
  in-flight work — instead of describing the tool with no term a search
  engine or an agent would match. The page now carries `SoftwareApplication`
  and `FAQPage` JSON-LD, and the Google Fonts request was trimmed from seven
  weights to the five the page's own CSS actually uses (GRA-128).
- `vercel.json`'s strict Content-Security-Policy rule now matches every path
  except `/api` (`/((?!api(?:/|$)).*)`) instead of the literal `/`, so a
  future second landing-style page inherits the policy instead of falling
  through to the catch-all header block, which carries no CSP at all.
  `/api/:path*` keeps its own, looser policy; the two `source` patterns are
  mutually exclusive by construction, so no single path can ever collect
  both `Content-Security-Policy` headers (GRA-129).

### Fixed

## [0.2.2] - 2026-09-16

### Added

- `findings` and `what_was_happening` now carry `alsoInWindow`: an inventory
  of every process exit in the window (including ones that already produced
  a finding above), plus raw counts of device, memory, GC and memory-trim
  events that never cross a finding's own threshold. Present only when there
  is something to add — a REASON_SIGNALED exit, or any other event a
  finding's severity mapping does not cover, used to be invisible to both
  tools; now it is a plain count with a pointer to where the detail lives
  (`porthole_status` for an exit, `timeline` for the rest) (GRA-200).
- The runtime's event kinds are now named constants (`EventKinds`,
  `DeviceEventKinds` in `Protocol.kt`) instead of a string literal repeated
  at each collector's own call site, and `mcp/src/eventKinds.ts` mirrors the
  wire-facing set — a test on each side keeps the two lists honest against
  each other (GRA-200).

### Changed

- `timeline`'s `kinds` parameter description now lists and narrates every
  kind the filter actually accepts, grouped by where each one is better
  read — `porthole_status` for `exit`, `findings`/`frames` for `device`'s
  startup profile, `timeline` itself for the rest — generated from the same
  list `eventKinds.test.ts` checks against the runtime, so the description
  cannot silently fall out of sync with what the filter admits (GRA-200).

### Fixed

- A second Porthole app already holding the device's loopback port no longer
  makes the first app look like it isn't running Porthole at all. The
  runtime now retries a failed bind a few times (for a same-app reinstall
  whose old process is still releasing the port), reports a genuine conflict
  at error level in logcat — naming the port, this app's package, `EADDRINUSE`
  when that's the cause, and the one-line fix — and keeps the state
  queryable so a later successful connection's `setup` report can say a bind
  needed a retry. The "installed on ..." log line no longer prints before the
  bind (which runs on a background thread) has actually settled (GRA-196).
- The MCP server no longer reports "connected" to whatever app happens to
  answer on its port. The plugin defaults `porthole.applicationId` from
  AGP's own `applicationId` on an application module and writes it into
  `.mcp.json` as `PORTHOLE_APPLICATION_ID`; a `hello` whose package
  disagrees with it warns loudly — in `porthole_status`, in another tool's
  own summary, and in the timeline UI's pill, in the danger tone — rather
  than silently answering for another Porthole app holding the same port.
  The not-connected checklist and README's troubleshooting text both name
  the two cases this incident produced: another Porthole app holding the
  port, and more than one adb transport for one device. Warns loudly; does
  not refuse (GRA-197).
- The timeline header no longer says "waiting on app" in the pill and
  "waiting for the app" beside it during the handshake — two phrasings of
  one fact. The neighbouring text is now state-specific: what the
  handshake is waiting on, the existing sentence once genuinely
  disconnected, and (once connected) the package and device the `hello`
  actually named (GRA-198).

## [0.2.1] - 2026-09-15

### Fixed

- The timeline's wheel handling now knows which gesture it is looking at:
  ctrl/⌘ + wheel or a trackpad pinch zooms at the cursor by an amount that
  scales with the delta (clamped to 2× per event), shift + wheel or a
  sideways swipe pans, and a plain vertical wheel scrolls the lane list and
  nothing else. Before, every wheel event zoomed by a fixed step, a sideways
  swipe with no vertical component zoomed *in*, and the lane list scrolled
  under every zoom because the handler was passive, which on a trackpad made
  the timeline impossible to navigate (GRA-194).
- The generated `.mcp.json` now launches `porthole mcp`. The entry ran the
  package's default bin with no subcommand, which printed the CLI's usage
  and exited, so an MCP client saw a server that started and immediately
  ended. The README's example entry was wrong the same way (GRA-193).

## [0.2.0] - 2026-09-15

### Changed

- **Breaking:** every MCP tool's answer now returns its human-readable
  summary and its JSON payload as two separate items in the response's
  `content` array (`content[0]` is the summary text, `content[1]` is the
  JSON payload as text) instead of one text block holding both, joined by
  a blank line (`"<summary>\n\n<json>"`). **If your client parses a tool's
  answer by finding the first blank line in `content[0].text` and treating
  everything after it as JSON, that code must change**: read the payload
  from `content[1].text` and `JSON.parse` it directly — do not search for
  a delimiter. A tool reporting an error (`isError: true`) still returns
  exactly one `content` item, as before; check `content.length` (or
  `isError`) rather than assuming a payload is always present. This
  removes a class of bug where device data containing a blank line
  (a device name, a package name, anything interpolated into the summary)
  could corrupt the split and make a tool's payload unrecoverable — see
  GRA-169 and GRA-171. 0.1.0 wire compatibility is explicitly not
  preserved by this change (founder decision, 2026-09-15).

### Added

- Every PR now reports test coverage to Codecov: JaCoCo XML for the two
  Kotlin modules under a `jvm` flag, and `lcov` from each vitest suite under
  `server`/`ui`. Both status checks are informational and cannot fail a PR
  (GRA-190).
- `capture_system_trace` gains a `restartApp` option: force-stop and relaunch
  the target app right after the capture starts, for builds (seen on a Pixel
  9 Pro Fold, Android 17) that only read the app trace tag at process start
  and so never annotate a process that was already running (GRA-186).
- Why the app died last time: a new runtime collector reads
  `ActivityManager.getHistoricalProcessExitReasons` on install (API 30+) and
  emits one `exit` event per death not already reported, deduplicated across
  reconnects and reinstalls. `porthole_status` gains an `exits` section (most
  recent exits, the build that died, the top app frame for an ANR or native
  crash, and a statement when the API is unavailable below API 30) and an
  `exitTrace: <timestamp>` parameter that fetches the full redacted trace on
  demand, capped at 256 KB. The same deaths appear in `findings` at `error`
  severity (`note` for a user-requested exit; nothing for a background
  `REASON_OTHER` kill). No new tool: the ticket's own EM argued against a
  sixteenth tool for a fact `porthole_status` already had the room to answer
  (GRA-58).
- Every window-taking tool (`findings`, `save_moment`, `recompositions`,
  `frames`, `blocking`, `logs`, `timeline`) accepts `since: "last" | "all"`,
  and `"last"` is now the default when no window is given: it starts where
  the previous window-taking tool call on this session left off instead of
  re-reading the whole buffer every time. `"all"` is the explicit reset.
  Every tool result carries a one-line banner and a structured `sinceLast`
  field when an `error`-severity finding has happened since the last call
  and has not yet been reported, and `findings` classifies each finding as
  `new`/`ongoing`/`resolved` against its own previous call. This state (a
  "watermark") is per MCP server process and survives a restart, written to
  `watermark.json` beside a session's `events.ndjson` (GRA-55).
- `portholeStart`, a single task that installs the debug build, forwards the
  port, writes `.mcp.json`, fetches `trace_processor` on first need, and
  opens the timeline — a thin orchestrator over the existing narrow tasks,
  which stay individually runnable and are now the README's reference table
  rather than its lead (GRA-174).
- System traces: capture a Perfetto trace on demand and ask it questions
  through `ask_system_trace` / `capture_system_trace`, backed by five
  curated SQL questions (jank, thread_states, binder, render, slices)
  interpreted into findings with a `severity` and a `confidence`.
- A finding can now say when it happened: `window` (device uptime ms) or
  `spanning: true` for one that is a property of the whole window asked
  about rather than a moment inside it. The timeline server's `GET
  /api/traces` lists what is under `.porthole/traces/` — id, bytes,
  recorded-at, and the uptime window each capture covers — and
  `/api/findings?trace=<id>` takes an id from that listing rather than an
  arbitrary filesystem path, refused before anything is spawned (GRA-113).
- The timeline UI draws findings on the same axis as Porthole's own events: a
  findings lane, above recompositions, placing every finding from `/api/
  findings` by its `window` (or as a dim band across the queried window for
  a `spanning` one) with severity as colour, confidence as solid-vs-outline,
  and source as a small mark — the same encoding the insights panel already
  used, now also on the canvas. A trace chooser in the insights panel header
  (fed by `GET /api/traces`) picks which capture `?trace=` asks about, and a
  coverage bar on the ruler shows which part of the visible axis that
  capture actually covers. The findings fetch itself moved out of the
  insights panel and into the app shell, so the panel and the lane share one
  request per settled view instead of doubling it (GRA-114).
- Clicking a dropped frame, a main-thread stall, or a finding in the timeline
  UI now offers **ask the trace**: it asks `GET /api/findings?trace=&from=&
  to=` about that hit's own window (centred, floored at 200ms), scoped to
  whichever listed capture's coverage actually reaches it, and renders the
  answer under the selection — including a line for each of the five trace
  questions that was answered but ruled nothing out, so a negative answer
  reads as one. With no covering capture it says so and offers a copy-ready
  capture prompt instead; either way a copy-ready prompt names the exact
  window for pasting at an agent. The answer is cached per capture and window
  for the session. `/api/findings` gained a minimal `asked: [{ id, answered
  }]` field, one entry per trace question, so the UI can tell "answered, ruled
  nothing out" apart from "never reached" (GRA-115).
- `portholeTraceProcessor`, a Gradle task that fetches Perfetto's
  `trace_processor` (pinned v58.2, SHA-256 verified) and caches it under
  `~/.porthole/trace-processor/<version>/`.
- `system_context` (what the rest of the device was doing around a moment)
  and `what_was_happening` ("what was I doing at this exact time").
- Porthole's own collector spans (frames, recomposition, nav, DB, HTTP) are
  now written into the system trace alongside the OS's own slices, with
  `ClockOffsets` reconciling `SystemClock.uptimeMillis()` against Perfetto's
  `CLOCK_BOOTTIME`.
- A single MCP entry point and shared window/session model tying the tools
  together, and `portholeMcpConfig` now writes the client config entry
  directly instead of printing it for hand-copying.
- A pinned Android Virtual Device, runnable identically on a laptop and in
  CI (GRA-106).
- CI: Gradle checks plus a three-OS Node matrix on every pull request
  (GRA-101).
- The landing page: an above-the-fold hero section (GRA-134), quick-start
  step placement and coloured severities (GRA-143), a desktop-width layout
  with terminal-styled commands (GRA-136), and the implementer's path from
  "what is this" to an agent answering (GRA-127).
- Vercel Web Analytics on the landing page: same-origin, cookieless
  (GRA-149).
- A README for the npm package, with source maps that resolve to sources
  actually in the tarball (GRA-97).
- Sessions on disk: `findings`, `what_was_happening` and `timeline` now fall
  back to a session recorded at `.porthole/sessions/<id>/` whenever the
  in-memory buffer cannot cover the window asked for, so a moment from
  before an MCP server restart is still answerable. Exactly the redacted
  event stream that already crosses the socket, nothing new captured;
  retained 500MB/7 days by default, both configurable via
  `PORTHOLE_SESSIONS_MAX_BYTES`/`PORTHOLE_SESSIONS_MAX_AGE_DAYS`, and
  `PORTHOLE_SESSIONS=0` turns writing off entirely. The device also sends an
  optional `deviceId` (`Settings.Secure.ANDROID_ID`) in `hello`, and the ring
  buffer's capacity is now configurable via `porthole { ringCapacity.set(…) }`
  (GRA-53).
- `save_moment` (MCP) and `porthole save`/`porthole sessions` (CLI): turn a
  window of what already happened into a trace file, in exactly the format
  `capture` writes, without having to reproduce the problem with a recording
  running. `clippedMs` says how much of the requested window was never
  recorded, in the same vocabulary `findings` uses; `porthole sessions` lists
  every session on disk, across every app and device, newest first, with the
  most recently active one marked (GRA-54).
- The timeline UI's header gained a **keep** control: the same "save what
  just happened" gesture, from the place it is actually wanted. Saves the
  visible window to the millisecond when zoomed or panned away from the
  live edge, or the last N seconds (a small input, default 30) ending now
  when following it, through a new `POST /api/save` that calls the same
  `fillWindowFromDisk`/`buildSavedTrace`/`writeSavedTrace` path `save_moment`
  already uses — no second implementation of any of it — hardened exactly
  like `/api/tools/restart` (POST only, GRA-78's origin check, a 400 on a
  malformed body or `from >= to`). Shows the path it wrote, selectable and
  copyable, plus a note that only the Porthole half is saved until GRA-57's
  system trace ring lands. Replaces **copy trace**, which put every event
  in the window on the clipboard as an unbounded JSON blob none of
  `capture`'s own tools could read (GRA-116).

- Spans still open when a recording or a saved moment ends are no longer
  dropped. They are emitted with `open: true` and a duration that is a floor
  (the capture's last event minus the span's start), counted in `http.calls`,
  `db.queries` and `work.runs`, reported under new `http.stillOpen` /
  `db.stillOpen` metrics and by a warning finding that names the oldest one,
  and excluded from every percentile, which cover completed spans only — a
  request that never returned is the shape of a hang, and it used to be the
  one span the trace could not show (GRA-92).
- The terminal readout of `findings` and `porthole report` colours severity,
  honouring `NO_COLOR` (GRA-142).
- One release command: `./gradlew release "-Pversion=X.Y.Z"` bumps the
  version, cuts this changelog, runs the full suite, commits and tags, and
  never publishes; `releaseDryRun` rehearses all of it against `mavenLocal()`
  with no credentials and proves the declared Porthole artifacts actually
  resolve (GRA-100, GRA-165).

### Fixed

- The runtime's `hello` carries a protocol version that the server now
  checks: a mismatch is reported in `porthole_status` as `protocolMismatch`
  instead of being silently accepted, and the receiving side validates the
  rest of what it is handed (GRA-96).
- A process that has died no longer leaves every tool answering from the
  stale ring as though it were still connected: the handshake has its own
  `ConnectionState`, the ring is cleared on the boundary, and the sampled
  proof on a real device is in `docs/verified.md` (GRA-157, GRA-163).
- `porthole_status` says where it looked, and `findings` no longer reports
  "not connected" while the app is connected (GRA-152).
- The timeline UI no longer shows a red "disconnected" pill for two seconds
  on every connect (GRA-161), and the insights pane no longer flickers on
  and off on first launch before there is anything to show (GRA-173).
- `ask_system_trace` loads `trace_processor` once per question, off the
  event loop, instead of once per query (GRA-82).
- The generated `.mcp.json` tells the server the port and nothing else
  (GRA-119).
- `Porthole.shutdown()` no longer leaks the collectors it started (GRA-86),
  and the same leak defences now actually run where CI runs (GRA-137).
- The timeline server refuses an origin it was not also addressed to
  (GRA-78).
- `portholeConnect` no longer reports success without having run `adb`
  (GRA-76); `portholeDisconnect` no longer reports itself up to date when
  it isn't (GRA-118).
- The Gradle plugin looks for the Android SDK in one place instead of
  several inconsistent ones (GRA-87), through one resolver rather than two
  mirrored copies (GRA-150), and a relative `sdk.dir` is anchored on the
  project directory every time instead of on two different directories in
  one code path (GRA-160).
- Zero-duration nav and stall markers now render with width instead of
  vanishing; trace slices are named by shape rather than by statement or
  instance, so high-cardinality names stop exploding tracks.
- Stopped reading a cooling device's temperature sensor as if it were
  still under load.
- Closed three system-trace query gaps (an ignored limit, a silent time
  window, two missing questions), and both halves of an answer now show in
  one list instead of two.
- The UI port is reported in plain language instead of a stack trace when
  it is unavailable.
- The insights panel no longer asks the server once per animation frame —
  debounced, aborted and ordered correctly (GRA-80).
- Rejected nonsense CLI arguments instead of silently accepting them
  (GRA-93).
- The blocking-window sweep is centred on the boundary it was meant to
  straddle (GRA-84); parents are indexed once instead of rescanned for
  each lookup (GRA-94); dead code and the claims it did not honour were
  removed (GRA-95).
- `gradlew` is marked executable so CI can run it, and CI's toolchain is
  pointed at a real JDK 17 source (GRA-98).
- The publishing commands no longer reference a build cache they were
  never going to use (GRA-75).
- `timeline` no longer silently drops `sinceMs` when `to` is also given —
  it now resolves its window the same way `frames` and every other
  time-bounded tool does, with a ceiling at now and no negative floor; its
  `sinceSeq` cursor mode is untouched. The MCP server's own `resolveWindow`
  now clamps a negative `from` to 0 and refuses an inverted window (`from`
  after `to`) instead of handing one back, and `windowShape`'s `to`/`sinceMs`
  descriptions say what the code actually defaults to (GRA-120).
- The server test suite no longer runs its loopback-socket rig files
  (`save`, `watermark`, `surface`, `sessions-integration` and others)
  concurrently with each other, which is what produced CI-only flakes on
  the Windows and macOS runners; the split runs as two vitest projects with
  the same total test count (GRA-183).
- `findings` no longer prints a 60Hz frame budget on a higher-refresh-rate
  panel just because the requested window misses the device's one startup
  profile event; the resolved profile (live buffer, then the session's own
  `meta.json`, then an honestly-labelled 60Hz guess) is now shared by every
  trace-building path, and `frames`' own budget text agrees with `findings`'
  instead of printing a different precision for the same panel (GRA-185).
- `findings` no longer analyses a zero-length window and reports "0s
  examined" when `since: "last"` finds nothing new past the watermark and no
  earlier findings digest to reclassify against — it now says plainly that
  nothing new has arrived, including on a fresh MCP process that has just
  loaded that watermark from disk (GRA-189).
- `porthole_status`'s `exitTrace` now accepts the ISO-8601 timestamp
  `exits.recent` itself prints (`at`), not only the epoch-milliseconds
  `timestamp` it already accepted (GRA-188).
- An event arriving between a reconnect's `hello` and the on-disk session
  writer finishing its own disk I/O no longer gets pushed onto the live
  timeline ring and then wiped by that `hello`'s delayed ring-clear; the
  writer also no longer drops (or, on a removed sessions root, throws an
  unhandled rejection over) an event that arrives before it has finished
  opening (GRA-191).
- The header's connection pill no longer flickers between "disconnected"
  and "connecting" at the device client's own reconnect cadence while no
  app is running; a `connecting` attempt that follows a shown
  "disconnected" now keeps the pill steady unless it runs past the
  client's maximum backoff, at which point it is shown for what it is
  (GRA-192).
- `capture_system_trace` no longer freezes the rest of the MCP server for
  the length of a recording — its three `adb` calls run through an
  asynchronous, awaited spawn instead of a blocking one — and its label
  scan no longer reads the whole trace into memory to find them (GRA-89).

## [0.1.0] - 2026-09-11

### Added

- Initial release: the Gradle plugin, the Android runtime and its no-op
  release artifact, the MCP server and CLI, the timeline UI, and the
  landing page and docs.
- Published `@gravitylabsllc/porthole` to npm.
- The API reference is served at a URL its own links resolve from.

### Fixed

- Made the version a single value across the catalog, the plugin and the
  npm package, and fail the build when it drifts — the check that grew
  into `VersionConsistencyTest`.
- Fixed two routing faults the deployment exposed.
