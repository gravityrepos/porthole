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

- `portholeStart`, a single task that installs the debug build, forwards the
  port, writes `.mcp.json`, fetches `trace_processor` on first need, and
  opens the timeline — a thin orchestrator over the existing narrow tasks,
  which stay individually runnable and are now the README's reference table
  rather than its lead (GRA-174).
- System traces: capture a Perfetto trace on demand and ask it questions
  through `ask_system_trace` / `capture_system_trace`, backed by five
  curated SQL questions (jank, thread_states, binder, render, slices)
  interpreted into findings with a `severity` and a `confidence`.
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

### Fixed

- `Porthole.shutdown()` no longer leaks the collectors it started (GRA-86),
  and the same leak defences now actually run where CI runs (GRA-137).
- The timeline server refuses an origin it was not also addressed to
  (GRA-78).
- `portholeConnect` no longer reports success without having run `adb`
  (GRA-76); `portholeDisconnect` no longer reports itself up to date when
  it isn't (GRA-118).
- The Gradle plugin looks for the Android SDK in one place instead of
  several inconsistent ones (GRA-87).
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
