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

- `porthole capture --systrace`: the headless path meets Perfetto (GRA-103).
  `porthole capture` recorded the app's own view; `capture_system_trace` and
  `ask_system_trace` recorded the device's — the two never met, so a CI
  regression could be described but not explained (thermal throttling, ART
  still compiling, binder blocking). `--systrace [--systrace-seconds N]
  [--systrace-categories a,b]` starts an on-device Perfetto recording for the
  lifetime of the child command (a backgrounded, `--background-wait`
  capture, stopped the moment the command exits rather than blocking on a
  fixed duration — bounded by `planCapture`'s existing 1-120s clamp as a
  safety ceiling, defaulting to the max so the command's own lifetime is the
  real bound), pulls it beside the trace JSON (`porthole-trace.json` and
  `porthole-trace.pftrace`), and — when `trace_processor_shell` can be
  found — asks it the same eight questions `ask_system_trace` does, over the
  window the capture covered, converting between Porthole's uptime clock and
  the trace's boot clock exactly as that tool does. The answers merge into
  the same `findings` array `findingsOf` already produces, each finding now
  carrying `source: "porthole"` or `source: "trace"` — the same distinction
  `/api/findings` (timeline.ts) already drew, promoted onto `Finding` itself
  so it survives into the trace JSON on disk. `portholeLabels` (how many of
  the runtime's own atrace sections landed in the capture) is recorded in a
  new `systrace` block on the trace, and a `portholeLabels: 0` capture gets
  an explicit `warning`-severity finding, not just a buried sentence. Without
  `trace_processor_shell` on the machine the capture still succeeds and the
  `.pftrace` is still written — a note says the questions were not asked and
  names `./gradlew portholeTraceProcessor` as the fix. `porthole report`
  tags a trace-sourced finding `[trace]` so it reads differently from one the
  runtime itself observed; `compare` was already indifferent to `findings`
  (it only ever diffed `metrics`), so a baseline without trace findings
  compares cleanly against a run with them, and vice versa.
- New `accessibility` MCP tool: a lint pass over a fresh Compose semantics
  capture, in the existing findings vocabulary. `warning` for an interactive
  node with no `text` and no `contentDescription` at all, and for a touch
  target under 24dp; `note` for one between 24dp and 48dp (Compose's own
  `minimumInteractiveComponentSize` may already pad it back up, invisibly to
  the captured bounds — the finding says so), for a node whose role implies
  it is actionable with no click action (or the reverse), for a
  non-decorative `Role.Image` node with no description, for a description
  repeated across siblings, and — `confidence: "correlated"`, only past a
  1.3× system font scale — for text whose box leaves it no visible room to
  grow. Every finding names the node's `stableId`, its path in the tree and
  any `testTag`; there is no screenshot annotation in this build, so pairing
  to what is on screen is by `stableId` through `semantics_tree`'s own
  output only. A clean screen says so explicitly, `"nothing found, N
  node(s) checked"`, and coverage is always stated: only the Compose
  semantics tree is seen, never a plain Android `View` or anything Compose
  itself marked `invisibleToUser`. `findings` folds these findings in too,
  but only when a semantics capture (`semantics_tree` or `accessibility`,
  either counts) already landed inside the window being asked about — never
  a fresh capture of its own, so a caller who never asked about
  accessibility never pays for it. `SemanticsCollector.kt` gained the one
  flag this needed that the wire did not already carry
  (`invisibleToUser`); `ProfileData` gained `density`, present on the
  `profile` device event all along but never parsed on this side until this
  pass needed to turn a captured pixel bounds into a dp figure. Out of
  scope: colour contrast, View hierarchies, any compliance claim — this
  proves what the captured tree proves, never a certification; the TalkBack
  check on a real device remains the hardware pass (GRA-72).
- New `setup` MCP tool: every entry the runtime's `setup` report carries —
  which integration is instrumented, which is only on the classpath, and
  the `socket`/`strictmode` entries alongside them — was previously
  reachable only through the timeline UI's `GET /api/setup` or the raw
  socket, so GRA-59's "the setup report says whether StrictMode is
  installed" was true on the wire and invisible to an agent. `setup` now
  exposes the identical data, plus, for each integration that is present
  but unwired, the exact line to add and which lanes and MCP tools go dark
  without it — ranked so the gap that leaves the most dark comes first
  (unwiring both OkHttp and Ktor costs the `http` lane and both `inflight`
  and `blocking`, which outranks a gap that costs one tool). A
  fully-instrumented project gets an explicit "everything present is
  wired" instead of an empty list indistinguishable from "nothing to
  check." `porthole_status` now names `setup` in its own summary whenever
  an integration looks present but unwired, so the first call an agent
  makes already points at it (GRA-228).
- `setup`'s ranking and snippets, not the source project: GRA-65's EM cut
  the source scan this ticket originally scoped — finding the
  `OkHttpClient.Builder` to point an agent at — since a real app usually
  has several and guessing which one is wrong more often than right.
  What shipped instead is what the runtime can say with certainty: the
  exact one-liner README.md already documents for OkHttp, Ktor, Room,
  SQLDelight and Navigation, as a constant kept in sync with README.md by
  test, never a snippet reconstructed from a grep of the project (GRA-65).
- `porthole watch`: a blocking CLI client, independent of any running MCP
  server, that streams findings as they occur and prints one line — severity,
  title, the window on the device uptime clock, and the resolved `where`
  when `PORTHOLE_PROJECT_ROOT` is set — the instant one crosses a severity
  threshold (`--severity error` by default). Point findings (a stall, a
  failed call, a main-thread query) print on every genuinely new
  occurrence; `frames-dropped`/`recompose-hotspot`, whose `count` is a
  running tally over one still-open episode rather than discrete
  occurrences, reprint at most once every 10 seconds while that episode
  continues, instead of flooding a line per tick. `--until-first` exits 1
  with the finding already on stdout; `--json` prints one finding object
  per line for a hook to parse, with every diagnostic on stderr only;
  `--timeout <seconds>` gives up with exit 3 rather than waiting forever;
  exit 2 also covers an internal defect in the evaluation loop itself,
  never exit 1, so a hook never reads a crash as a finding it can quote.
  Never exits merely because the app disconnects — it reconnects on its
  own, the same as `porthole ui`. Routes its `adb forward` through the same
  GRA-199 `forwardTarget()` (`--application-id`/`--legacy-tcp-port`,
  `PORTHOLE_APPLICATION_ID`/`PORTHOLE_LEGACY_TCP_PORT`) `porthole
  ui`/`porthole capture` already use, refusing rather than guessing a
  socket name. Shares `watermark.ts`'s on-disk `lastReportedErrorT` with
  the MCP surface's own "since your last call" banner, keyed by the same
  session identity, so a `watch` and an agent on one session do not
  double-report the same error once each has seen the other's write — not
  full mutual exclusion: two live processes that both decide inside the
  same ~200ms poll interval can still both report an error once (GRA-56).
- `system_trace_start`/`system_trace_snapshot`/`system_trace_stop`: a
  detached Perfetto session that records continuously into a fixed-size
  ring buffer, so a system trace of a problem that already happened can be
  pulled without reproducing it under `capture_system_trace`. Opt-in only —
  nothing runs until `system_trace_start` is called. `system_trace_snapshot`
  pulls the ring's current contents via Perfetto's `--clone-by-name` without
  interrupting it (a spike found the ticket's own proposed `--detach`/
  `--attach --stop` sequence requires `write_into_file: true`, which turns
  the on-device file into a growing stream rather than a ring, and would
  have stopped the recording on every snapshot; full transcript in
  `docs/spikes/GRA-57-perfetto-ring.md`), and reports the same
  `portholeLabels` count `capture_system_trace` does. The ring's own
  TraceConfig declares the same data sources `capture_system_trace`'s
  light-config shorthand resolves to — `android.surfaceflinger.frametimeline`,
  `linux.process_stats`, `linux.system_info` alongside `linux.ftrace` — after
  QA found a ring snapshot answered zero `ask_system_trace` questions with
  `linux.ftrace` alone. `system_trace_stop` kills the backgrounded session
  and removes every file it could have left behind, reading the device's own
  pid marker first and falling back to a process-table scan when that marker
  is missing or was never written (a launch that forks but then fails is
  killed by the same scan before it is ever reported as a failure — a bad
  launch cannot leave a live session behind). `porthole_status` and
  `system_trace_snapshot` fall back to that same device check on a cache
  miss, so a restarted MCP server can still see, snapshot from, or warn
  about a ring it did not itself start. Any error-severity finding
  `findings` reports while the ring is running gets a fresh snapshot
  attached to it automatically, fired in the background rather than
  awaited (`{ inProgress: true }` until a later call or
  `porthole_status`'s `ring.lastSnapshot` has it), rate-limited to once per
  ten seconds. `porthole_status` carries the ring's running state, depth and
  a measured-on-emulator overhead figure (0.45% of one core under a light
  synthetic workload); a hardware measurement is a separate, still-open pass
  (GRA-57).

- A slow HTTP call now says which part was slow. `installPorthole()` reports
  OkHttp's own `EventListener` phase breakdown (`queued`, `dns`, `connect`,
  `secureConnect`, `dispatch`, `requestHeaders`, `requestBody`, `waiting`,
  `responseBody` — each already the time that phase itself took, summing to
  within a few ms of the call's own `elapsedMs`; `dns`/`connect` sum every
  attempt a call made, a route failover included, with `connectAttempts`
  saying how many), connection reuse, protocol and real request/response
  byte counts (not a payload, and never a fake zero for a request with no
  body) — present whether or not `BodyCapture` is on. It reads back
  whatever `EventListener`/`EventListenerFactory` the builder already had
  configured and chains onto it — all 29 callbacks OkHttp's own
  `EventListener` declares, `connectionReleased` included — so an app with
  its own listener keeps receiving every one rather than going dark the
  moment `installPorthole()` is added; that read-back is now guarded
  against the `IllegalStateException` a momentarily-invalid builder can
  throw from it, and the one call order it cannot fix on its own (the app's
  own listener set *after* `installPorthole()`) is caught at the first
  request and reported as an `okhttp-listener` entry from `setup`.
  `findings` gains `http-call-slow` at `warning` for a call at or past
  3000ms, named `mostly <phase>` only when that phase is actually at least
  half the call's own time (otherwise `largest phase: <phase> (Nms of
  Mms)`, honest about how little it explains) and joined against the
  device's own most recent `network` event, so a call that ran on cellular
  says so. `inflight`'s `recentHttp` is now window-aware (the standard
  `sinceMs`/`from`/`to`, `limit` defaulting to the old "last 25", the
  buffer itself now 200 deep so a finding's `window` can still reach a call
  older than the default returns) — with only the newest 25 keeping their
  body previews, so the deeper buffer does not multiply memory spent on
  bodies nobody asked to keep that far back. Ktor gets none of the phase/
  reuse/protocol/byte-count work — its plugin API sits above every engine,
  with no hook any engine agrees on — and the OkHttp engine remains the
  documented way to get it anyway (GRA-66).
- `portholeComposeReport` enables the Kotlin compose compiler's own metrics
  for the debug variant — gated on `project.gradle.taskGraph.whenReady`
  finding the task in the *resolved* execution graph, not a string match
  against the command line, so a Gradle task-name abbreviation
  (`./gradlew :sample:pCR`) is recognised exactly like the full name rather
  than silently running the report against stale, previously-cached compile
  output — and parses its `*-composables.txt`/`*-classes.txt`/
  `*-composables.csv` reports into `build/porthole/compose-report.json`: per
  composable, whether it is restartable and skippable and why each
  parameter is or is not stable (default parameter values, and a
  zero-parameter composable's own one-line form, both parsed correctly, not
  leaked into the type or dropped); per class, whether it is stable and,
  when not, whether that is because of a `var` property Compose cannot
  observe (never one it recognises as a `by mutableStateOf(...)`-style
  delegate) or a field the compiler proved unstable (preferred over one it
  could merely not determine). `recompositions` and `findings` now join a
  composable against this report — by resolving its `portholeNode`/
  `PortholeScreen` label to source (reusing GRA-201's own index, package-
  narrowed every time the label's own declared package is known, not only
  when more than one same-named candidate exists) and reading the enclosing
  `@Composable fun` from there, since the report is keyed by Kotlin function
  name, never the label — and report the compiler's own reason and a remedy,
  in its own words: `"LeakyRow is restartable but not skippable: parameter
  highlight: RowHighlight is unstable. RowHighlight is unstable because it
  has a var property (tappedAt). Annotate it @Immutable/@Stable, or make the
  property val."` (a parameter typed as something this project never
  compiled with the Compose compiler at all gets a different remedy — a
  stability configuration file). A hotspot that joins to a genuinely
  not-skippable composable is promoted to `warning` under
  `id: "recompose-not-skippable"` (above the bare, ordering-only note it
  used to be); one that is skippable but still carries an unstable parameter
  is `"recompose-skippable-but-unstable"` — busy, not broken; one the
  compiler never called restartable at all (`inline`,
  `@NonRestartableComposable`) is `"recompose-not-restartable"`, described
  truthfully rather than as "restartable but not skippable" — none of these
  three is ever promoted above the first. One that does not join at all —
  no report, no source match, or an unresolved same-name ambiguity — reads
  exactly as it did before this ticket, `id: "recompose-hotspot"`, never a
  guess. A report older than the sources it describes is detected by a
  content fingerprint (cached per module, not recomputed per node) and
  refused rather than joined silently — a stale match still names the
  report's own age and the composable it would have joined, but never its
  `skippable` verdict (GRA-69).
- `ask_system_trace` puts three more questions to a trace: `startup` (launch
  type, duration and the platform's own attribution of what slowed it —
  binder, lock contention, GC, dex opening, bindApplication), `monitor_contention`
  (which lock blocked the main thread, and who was holding it), and a merged
  `cpu` question answering where the main thread actually ran (core,
  cluster, frequency) and who else wanted the same cores in the same window
  — correlated, not observed, gated to stay silent on an idle device, and
  never asserting causation. A new `ask` parameter selects a subset by id
  (default: all eight); the result now says which questions were skipped by
  that filter, separately from which were asked and failed (GRA-61).
- `porthole { strictMode.set(true) }` installs an Android `StrictMode`
  thread + VM policy in debug builds (never `penaltyDeath`) and turns a
  violation into a `strict_violation` finding — main-thread disk writes and
  network calls at `error`, leaked closeables/cursors at `warning`,
  everything else at `note` — but only for a violation whose stack names a
  frame in the app's own package; a platform-only violation (most of what
  trips during ordinary startup) is never counted or reported at all. Off by
  default: `StrictMode` has no public API to detect or chain an existing
  policy, so enabling this replaces whatever was already installed, and the
  `setup` report says so plainly rather than claiming to chain. A call site
  reports its first hit immediately, then the exact, current count at most
  once a second while it keeps happening — a background flush, not a
  per-violation check, so a site that goes quiet still gets one final
  accurate count instead of sitting on a stale one for the rest of the
  session (GRA-59).
- Findings now carry `where`: a stall's top frame, an exit's `topAppFrame`
  and a recomposition's composable name resolve to a `{ path, line }` under
  the project root when exactly one source file or declaration matches, and
  to `resolved: false` with a reason (`not found`, `ambiguous`, `synthetic`)
  otherwise — never to a guess. When the evidence carries a package too (a
  stack frame's own fully qualified class, or a qualified `state`/
  recomposition name), a match that would otherwise be ambiguous narrows to
  the one file in that package — the multi-module case this exists for —
  and stays ambiguous only when the package matches none or more than one.
  `blocking`, `recompositions`, `porthole_status`'s `exits`, the timeline
  UI's selection panel and `porthole report` all carry or show it;
  resolution is a fact about where evidence lives on disk and never changes
  a finding's title, severity or detail, and is off entirely (no `where`
  key at all) whenever `PORTHOLE_PROJECT_ROOT` is unset (GRA-201).
- Two new MCP tools so an agent can get itself unstuck instead of asking a
  human to run `adb` by hand: `porthole_status` now lists attached devices
  and (re-)establishes the `adb forward` on its own before reporting —
  idempotent and invisible to the app, so a dropped forward is often
  invisible too, just call it again — and the new `porthole_connect` tool
  checks whether the debug build is installed and which version, and can
  launch or restart the app (the same force-stop-then-launch
  `capture_system_trace`'s `restartApp` option and the timeline UI's own
  restart button already use). `porthole_status` stays read-only; only
  `porthole_connect` can act on the app under test (GRA-62).
- New `screenshot` MCP tool: captures the device screen with `adb exec-out
  screencap -p` and returns it as an image content block, scaled and
  re-encoded as a ~640px-wide, quality-80 JPEG (capped at 1.5MB) — `findings`
  and the semantics tree can say a query ran on the main thread, but not that
  the price is rendering as `$NaN` or that a dialog is covering everything.
  Refuses rather than returning a black rectangle when a FLAG_SECURE window
  is on top, since screencap itself returns solid black for one of those.
  Decoding, downscaling and re-encoding are all pure JS (`pngjs`, `jpeg-js`;
  no `sharp`, no native module in the `npx` path). Never written to the
  session file: a screenshot cannot be redacted the way the app's own text
  events can (GRA-63).
- `site/robots.txt` and `site/sitemap.xml`, so `/robots.txt` and
  `/sitemap.xml` return real content instead of a 404. The sitemap lists the
  landing page and the API reference directory, not the ~58 individual
  Dokka pages under it — those are meant to be found by search inside the
  reference, not indexed on their own (GRA-129).
- A `<link rel="canonical">` on `site/api/index.html`, added as a
  post-processing step of the `:runtime:apiDocs` Gradle task rather than
  hand-edited, since `apiDocs` is a `Sync` that overwrites the file from
  Dokka's output on every run (GRA-129).
- A new `StartupCollector` measures where the time went before the first
  frame: the process fork (`Process.getStartUptimeMillis()`), `Application.onCreate`'s
  entry and exit, the first Activity's `onCreate`/`onStart`/`onResume`, and
  the first frame drawn, all in one `startup` event classified cold, warm or
  hot — and not only the first launch: every relaunch while the process stays
  alive gets its own warm or hot `startup` event too, observed live off the
  same activity lifecycle callbacks, carrying `originKind` (`fork` for the
  cold launch, `activity` for every relaunch after it) so a reader can tell
  the two kinds of span apart. `findings` judges every launch in the window
  on its own — reopening the app does not erase an earlier slow launch's own
  finding — turning a slow **cold** launch into a `startup-slow` entry naming
  the dominant phase and cross-referencing any `db-on-main-thread` or
  `main-thread-stall` finding that fell inside that launch's own window, and
  noting once, for the cold launch only, when the app never reports itself
  fully drawn — caught automatically via `ComponentActivity.fullyDrawnReporter`
  in a Compose (or any ComponentActivity) app, with the new
  `Porthole.reportFullyDrawn()` as the documented fallback for an Activity
  that is not one. Warm and hot launches get no `startup-slow` today: their
  origin is the relaunched Activity's own lifecycle callback, already inside
  the system's own launch work, and Android vitals' warm/hot thresholds are
  measured from the launch request itself — a materially different span, not
  a smaller number for the same one (GRA-60).
- Whole-tree recomposition counting: `recompositions` now sees every
  recompose scope Compose invalidates, not only the ones wrapped in
  `PortholeScreen`/`Modifier.portholeNode`, via
  `androidx.compose.runtime.tooling.CompositionObserver` attached from an
  `ActivityLifecycleCallbacks` decor-view walk with no app code — the
  GRA-70 spike shipped. Each node's `source` says `wrapped` or `observer`;
  a wrapped call site is merged with its own observer entry rather than
  double-counted (best-effort at the composition-pass level, exact for the
  common case — see `CompositionTreeCollector`'s own doc comment for what
  that does and does not guarantee). `triggeredBy` is causal
  (`attribution: "observer"`) when the observer supplies the actual
  invalidating state objects, falling back to the original ~32ms temporal
  correlation (`attribution: "temporal"`) whenever it can't — including
  automatically on a pre-1.6 Compose, where the runtime now starts, logs
  once, and reports wrapped call sites exactly as it did before this
  ticket rather than failing. Names for an observer-only node — real
  composable names instead of a stable `<uninstrumented:...>` placeholder —
  are opt-in behind `porthole { composableNames.set(true) }` (default
  false): resolving them needs Compose's own
  `collectParameterInformation()`, the same mechanism the Layout Inspector
  uses, which sets `forceRecomposeScopes = true` for the whole app and so
  measurably changes how it recomposes — the report's own `notes` say so
  whenever it is on. `setup` carries a new `compose_tree` entry either way.
  README's recompositions caveat is rewritten, not softened; the full
  mechanism, measurements and version constraints are in
  `docs/spikes/GRA-70-recomposition-counts.md` (GRA-235).

### Changed

- `where` is now a breakpoint address, not merely a file: `resolved: true`
  always carries a real, numeric `line` — never optional any more — plus a
  new `kind`, `"frame"` when the line came from the evidence itself (a stack
  frame's own rendered `File.kt:NN`) or `"declaration"` when it did not (a
  composable/`state` name is never a line, so this is the line of the
  declaration the lookup found in source instead). A frame whose file
  resolves but whose own line does not — a stripped release build can carry
  a real file name next to no line table — no longer reports `resolved:
  true` with the line silently missing; it reads `"synthetic"`, the same as
  any other frame with nothing to point at. An ambiguous `where` now also
  carries `candidates`, every path it actually found, rather than leaving an
  agent to guess which two (or more) files "ambiguous" meant. A lookup that
  matched nothing gains a fourth reason, `"not in project"`, for evidence
  that named a package no directory under the root is authored in at all —
  a library frame (`okhttp3.internal.connection.RealCall`, an androidx
  class) reads this way instead of the less specific `"not found"`, decided
  from the walk's own file paths already in memory, never an extra read
  (GRA-205).
- **Every MCP tool now takes a `detail` parameter** (`"summary"` | `"normal"`
  | `"full"`), and `"summary"` — the summary line, its headline numbers, and
  anything needed to make a follow-up call, no JSON payload at all — is now
  the default on every tool, an explicit EM ruling on this ticket. Before
  this, every call returned its entire JSON payload, pretty-printed,
  whether or not anything past the first sentence was ever read; a 500-event
  `timeline` call cost tens of thousands of tokens every single time. JSON
  is compact rather than pretty-printed at `"normal"`/`"full"` now too —
  measured on the JSON payload of a 500-event `timeline` capture, compact
  is 38,602 bytes against 73,151 pretty-printed (47% smaller) before
  `detail` even enters the picture. Before this ticket every call always
  returned that whole pretty-printed payload (73KB+ for 500 events, every
  single call); the same 500 events now cost 176 bytes total at
  `"summary"` (the new default), 8,036 bytes at `"normal"` (its own new,
  context-sized default of 100 events rather than the old always-500), and
  38,729 bytes at `"full"` (the old 500-event default, unchanged, now
  opt-in rather than automatic). `findings` drops from 1,333 bytes (its
  `"normal"` payload) to 255 at `"summary"`; a `semantics_tree` capture
  drops from 28,792 bytes at its own new 300-node `"normal"` default
  (1,500 nodes, always, before this ticket) to 123 at `"summary"`.
  `timeline`'s and `semantics_tree`'s own defaults are now detail-aware —
  100 events/300 nodes at `"summary"`/`"normal"`, the old 500/1500 moved to
  `"full"` — stated in each tool's own description; an explicit `limit`/
  `maxNodes` still wins outright, regardless of `detail`. Every truncation
  note that existed before this ticket (`timeline`'s "N matched, M
  returned", `recompositions`' "busiest N of M nodes shown", and the rest)
  still appears at every level, because it lives in the summary line itself,
  which is present and unchanged at every `detail` — only the JSON payload
  block comes and goes. Every level states the bytes it actually returned
  and what the next level up would cost, measured off the real response,
  never estimated ahead of building it — the one exception being an
  approximate "next level" figure for `semantics_tree`, where the actual
  next size cannot be known without a second round trip to the device.
  GRA-91's asks are folded into what `"summary"` means for three tools:
  `semantics_tree` reports node count, unlabelled count and
  instrumented-node coverage; `state` names each unattributable field and
  the API that would fix it; `timeline` names the busiest second, the
  longest gap, and the thing that happened exactly once. One exception to
  `"summary"` being the default: `porthole_status {"exitTrace": <timestamp>}`
  bumps its own effective default to `"normal"`, since the trace text is
  the entire reason to make that call and would otherwise be silently
  withheld. The MCP server's shared rendering path (`render.ts`, new) is
  the one place this decision is made; `ok()` in `index.ts` is the only
  caller, the same discipline GRA-55's banner and GRA-171's
  `joinSummaryAndPayload()` already follow. The timeline UI reads `/api/*`
  HTTP endpoints, never a tool's own `content`, so none of this touches it
  (GRA-68, GRA-91).
- Every Porthole app on a device now binds its own on-device endpoint instead
  of contending for one shared loopback TCP port: the runtime listens by
  default on an Android abstract-namespace Unix socket named
  `porthole.<applicationId>`, unique per app by construction, and
  `portholeConnect`/`portholeUi`/the MCP server's own `porthole_status`/
  `porthole_connect` forward `tcp:<port>` (still a plain host-side port,
  still configurable with `porthole { port.set(...) }`) to
  `localabstract:porthole.<applicationId>` rather than to a second copy of
  the port. Two debug apps with the plugin applied can now run, and be
  watched by their own MCP servers, on one device at the same time — the
  collision GRA-196/197 made loud is now structurally impossible rather than
  merely diagnosed. The wire protocol is unchanged (`PROTOCOL_VERSION`
  stays `1`): only the socket carrying it moved.
  **Migrating**: nothing to do if you only ever used the plugin's own tasks
  — `portholeConnect`, `portholeUi`, `portholeStart` — or the MCP server
  through the `.mcp.json` `portholeMcpConfig` generates; both regenerate the
  new target automatically. Anyone forwarding `adb forward tcp:<port>
  tcp:<port>` **by hand**, outside the plugin, needs to update that to
  `adb forward tcp:<port> localabstract:porthole.<applicationId>`, or set
  `porthole { legacyTcpPort.set(true) }` (and `PORTHOLE_LEGACY_TCP_PORT=1`
  for a hand-started MCP server) to keep the old shared TCP bind for one
  release while updating whatever forwards by hand — that flag is planned
  for removal, since it reintroduces the collision this change removes
  (GRA-199).
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
  `/api/(.*)` keeps its own, looser policy (the `/api/:path*` form matched every page beneath the directory but not `/api/` itself, which the preview showed carrying no policy at all); the two `source` patterns are
  mutually exclusive by construction, so no single path can ever collect
  both `Content-Security-Policy` headers (GRA-129).
- The landing page's FAQ is trimmed to the three real first-minute
  objections (release APK, runtime cost, root); the other two now link to
  README's Compatibility and Payloads sections and to SECURITY.md instead.
  A status block above the footer now states the current version and where
  to get it (Maven Central, npm, Gradle Plugin Portal), with a link to the
  README for what is and is not supported — device coverage is not a metric
  this project tracks, so the block does not enumerate it. The footer's
  hand-typed version string, which had drifted two releases stale, is gone;
  the one hand-maintained version on the page now lives in the status block,
  next to the registries that explain what it means (GRA-131).
- `ask_system_trace`'s `trace-startup` finding now reconciles against the
  runtime's own `startup` event for the same launch, when the window holds
  one: the launch's phases (fork or activity origin, `onCreate`
  entry/exit, the three activity lifecycle callbacks, first frame,
  `reportFullyDrawn`) land in `evidence.runtimePhases`, alongside
  `runtimeTotalMs`, `runtimeOriginKind` and `gapMs`. The trace times a
  launch from the launch request itself, before the process even forks;
  Porthole times from the fork (cold) or the relaunched Activity's own
  first callback (warm/hot) — always a later instant — so a positive
  `gapMs` is that structural difference, not a discrepancy (see README's
  Startup section). A `startup-reconciliation-<originMs>` note fires only
  when the two numbers say something that gap cannot explain: `gapMs`
  negative, or past the same 5000ms line `startup-slow` already draws for
  "this cold startup is excessive." Neither side changes when the other is
  absent (GRA-231).
- The root lifecycle tasks now mean what their names say. `./gradlew :test`
  (qualified) used to run only the Gradle plugin's tests — the root `test`
  task named just the plugin's as a dependency — while unqualified
  `./gradlew test` also ran the three Android subprojects', reached only by
  Gradle's own cross-project name-matching; the two commands looked
  interchangeable and were not (`:check` had the same gap). `test`/`check`
  now also depend explicitly on `:runtime:test`/`:runtime-noop:test`/
  `:sample:test` and the equivalent `check`s, so `:test`/`:check` and their
  unqualified forms depend on the identical task set — confirmed by diffing
  `./gradlew :test --dry-run` against `./gradlew test --dry-run` (and the
  `check` pair) task-for-task. `./gradlew build` used to compile the plugin,
  as a side effect of putting it on this build's classpath, and verify none
  of it: no root `build` task existed at all (`:build` failed outright,
  "task 'build' is ambiguous"). `build` is now registered at the root and
  depends on the plugin's `check` — not its `build`, which is
  `java-gradle-plugin`'s/`com.gradle.plugin-publish`'s own
  assemble-and-publish-bundle path that `releaseDryRun` already exercises
  deliberately elsewhere, and that an ordinary local build has no reason to
  produce (GRA-121).

### Fixed

- `FrameCollector` computed its first-draw flag, and fired the hooks that
  depend on it, only after the "is this frame janky" early return — so a
  smooth first frame never counted as the first draw, and anything keyed on
  it (now the startup collector's first-frame phase) waited for the first
  dropped frame instead. The flag and the hooks now run for every frame,
  before the jank test (GRA-60).
- `findings` read `startup` as if `StartupCollector` emitted at most one per
  session, taking only the newest event — so backgrounding and reopening the
  app made an earlier slow cold launch's own `startup-slow` (and its
  db-on-main/main-thread-stall cross-reference) disappear the moment the
  fast relaunch's event became the newest one, and could accuse a cold
  launch that *did* call `reportFullyDrawn()` of never having called it,
  once a later relaunch's event carried no `reportFullyDrawnMs` of its own.
  Every `startup` event in the window is now judged independently (QA
  60-A/60-B, GRA-60).
- `portholeMcpConfig` now pins the npm package it writes into `.mcp.json`'s
  `porthole` entry to the same `uiPackageVersion` that `portholeUi` runs and
  the runtime AAR is pinned to, instead of leaving it unversioned for `npx`
  to resolve to whatever the registry called `latest` at launch time
  (subject to the npx cache besides). All three now resolve to one version
  by construction, and a plugin bump carries its new pin into an existing
  `.mcp.json` entry on the next run with no flag needed — the rewrite is
  narrowed to entries that differ *only* in the pinned version, so any other
  hand-made difference is still refused and printed the way it always was.
  A new `mcpCommand` extension property, mirroring `uiCommand`, opts a build
  that produces its own CLI out of the pin entirely and points `.mcp.json`
  at that local build instead — this repo's own sample now uses it
  (GRA-195).
- The sample hard-crashed the moment "Add" was pressed on an API 28+ device
  with the platform's default network security policy, which refuses
  cleartext even to loopback: `CartApi`'s in-process `MockWebServer` is
  plain `http://localhost`, so OkHttp threw `UnknownServiceException`
  (`CLEARTEXT communication to localhost not permitted`) on the first
  request, main thread, no catch. A debug-only `network_security_config.xml`
  now permits cleartext for `localhost`/`127.0.0.1` only, wired in via
  `sample/src/debug/AndroidManifest.xml` so release carries no
  `networkSecurityConfig` and is unaffected (GRA-236).
- Five `McpConfigTest` cases failed on a stock macOS checkout: each compared
  JUnit's `TemporaryFolder.root` (`/var/folders/...`) against a path
  `portholeMcpConfig` resolved through Gradle, which canonicalizes the
  project directory before joining a relative path onto it (`/private/var/
  folders/...` — macOS's `/var` is itself a symlink into `/private/var`).
  The assertions now canonicalize whichever side came straight from
  `java.io.File`, via a shared `canonicalPathOf` test helper, rather than
  comparing raw `absolutePath`s across that boundary or loosening the
  comparison to `endsWith` (GRA-223).
- `./gradlew check` (and `test`) discarded the whole configuration cache
  entry on every run: `buildSrcTest`'s `doLast { exec { ... } }` called
  `Project.exec` and a script-defined `gradlewCommand()` function from
  inside its action, which implicitly captured this build script itself —
  a type the configuration cache cannot serialize at all, regardless of
  `notCompatibleWithConfigurationCache`. `buildSrcTest` is now a real `Exec`
  task whose `commandLine` is resolved once, at configuration time, into a
  plain `List<String>`; nothing of the script is left for the action to
  close over. `./gradlew check` now stores a clean configuration cache
  entry with zero problems and the next run reuses it (GRA-227).
- `porthole_connect`'s `restart`/`launch` and the timeline UI's own restart
  button judged whether the app came back up by grepping `monkey`'s own
  stdout for its "Events injected" line — on an API 36 image `monkey -p
  <pkg> -c android.intent.category.LAUNCHER 1` prints debug noise instead
  and never reliably prints that line, so a relaunch that plainly worked
  still reported failure. Success is now judged by the process actually
  being up afterwards (`pidof`, polled for up to ~2s), never mind what the
  launcher printed; the launcher itself is now `adb shell cmd package
  resolve-activity` followed by `am start -W -n <pkg>/<activity>` (stable
  `Status:`/`LaunchState:`/`TotalTime:` output, reported in
  `porthole_connect`'s own payload for GRA-60's startup work to use), with
  `monkey` kept only as the fallback for when resolve-activity names no
  launcher activity at all. The timeline UI's restart button now shares
  this exact code path (`restartAppAsync`) rather than a separate sync copy
  (GRA-233).
- `ask_system_trace` on a trace path that does not exist (a typo, a trace
  already cleaned up, one copied from the wrong session) reached
  `trace_processor_shell` anyway, where every one of its eight questions
  failed to load the file independently and came back "unanswered" —
  reported as "8 question(s) failed" instead of the one true sentence. The
  path is now stat'd before anything tries to load it: a missing or
  unreadable file is reported in one plain sentence naming it, with the
  nearest same-prefix (or, failing that, newest) `.pftrace` file under the
  same directory suggested when one exists, and `asked`/`skipped`/
  `unanswered`/`findings` all come back empty rather than populated with a
  ghost result (GRA-234).

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
