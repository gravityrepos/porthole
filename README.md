<p align="center">
  <img src="brand/banner.png" alt="Porthole — a debug-only window into a running Android app" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-5ec8b0?style=flat-square"></a>
  <a href="https://codecov.io/gh/gravityrepos/porthole"><img alt="Test coverage on main, from Codecov" src="https://img.shields.io/codecov/c/github/gravityrepos/porthole?style=flat-square&label=coverage"></a>
  <img alt="Android API 26 and up" src="https://img.shields.io/badge/android-API%2026%2B-56c88c?style=flat-square">
  <img alt="Debug builds only" src="https://img.shields.io/badge/builds-debug%20only-f0883e?style=flat-square">
  <img alt="Version 0.2.0" src="https://img.shields.io/badge/version-0.2.0-9aa6b8?style=flat-square">
</p>

# Porthole

A window into a running Android app.

Porthole is a debug-only agent that lives inside your app and answers questions
about it while it runs: what recomposed and why, which frames were dropped and
where the time went, what is holding the main thread, what is in flight, what
your state actually contains right now.

It opens a loopback socket in debug builds, and `adb forward` bridges it to your
workstation. Two things connect to it, independently:

- **a live timeline** in your browser, for a person watching their own app
- **an MCP server**, for a coding assistant that can then read the answers and
  go change the code that caused them

The timeline is a complete tool on its own; the MCP half is additive. Between
them they cover:

| tool | answers |
| --- | --- |
| `findings` | start here: what is wrong right now, ranked, each with the tool that shows its evidence |
| `recompositions` | which composables recomposed, how often, and which state keys were written just before |
| `semantics_tree` | the semantics tree with an id that stays stable across captures |
| `nav_state` | back stack, arguments on each entry, and the deep link that got you here |
| `state` | current values of your ViewModel state, named automatically, and whether writes to it are attributable |
| `inflight` | open HTTP calls with the phase each is stuck in, running queries, WorkManager jobs |
| `frames` | dropped frames, and which phase of the frame ate the time |
| `blocking` | what held the main thread, with the stack it was stuck in |
| `logs` | the app's own logcat output, stack traces intact, without touching adb |
| `timeline` | the raw event stream, for ordering things relative to each other |
| `what_was_happening` | the narrative for one instant: screen, in-flight work, main thread, state just written |
| `system_context` | thermal state, CPU governor, busiest processes, memory pressure — the half Porthole cannot see |
| `capture_system_trace` | records a Perfetto trace, annotated with the app's own spans |
| `ask_system_trace` | puts a fixed set of questions to a captured trace, to rule causes in or out |
| `save_moment` | turns a window of what already happened into a named trace file, no recording required |
| `open_timeline` | a live timeline UI in the browser |
| `porthole_status` | whether any of the above can currently reach the device — and, now, why it died last time |

Everything is debug-only. Release builds link a no-op artifact with identical
signatures, so the calls stay in your code and compile to nothing.

### Why it died

The process holding the ring buffer is the process that crashed, so the ring
never has the answer to "why did it just die". `porthole_status` does: an
`exits` section carries the most recent process deaths Android recorded for
this app — `ActivityManager.getHistoricalProcessExitReasons`, read once per
launch — each with its reason (`REASON_ANR`, `REASON_CRASH`, and so on), when
it happened, the build that died (or the running build, flagged as assumed,
when the death predates anything the record itself names), and — for an ANR
or a native crash — the top frame of the main thread's stack. The same deaths
show up in `findings` at `error` severity (`note` for a user-requested exit;
nothing for a background `REASON_OTHER` kill), naming the reason, the build
and that same top frame.

Below Android 11 (API 30) `exits.apiUnavailable` says so rather than the
section silently reading empty. When nothing is currently connected and the
most recent exit is recent, `porthole_status`'s summary leads with it — "not
connected because it died" is a more useful first sentence than a generic
troubleshooting checklist.

The event itself carries a *summary* of an ANR/native-crash trace, not the
whole blob: the main thread's stack, app frames first (the same ordering
`blocking` uses), plus a count of the other threads and the states they were
in. The full trace — up to 256 KB, with a note if it was cut short — is one
more call away: `porthole_status {"exitTrace": <timestamp>}`, copying either
the epoch-milliseconds `timestamp` or the ISO-8601 `at` from that same entry
in `exits` — both are accepted and converted. Both the summary and the full
trace go through the same redaction every other captured string does,
before either ever leaves the process.

## Layout

```
runtime/         the agent: collectors, socket server, Compose wrappers
runtime-noop/    same public API, empty bodies, for release builds
gradle-plugin/   wires the artifacts in, owns the adb forward
mcp/             the MCP server (stdio) and the timeline server
mcp/ui/          the timeline itself: React 19, TypeScript, Vite, Tailwind
sample/          a small app with deliberate bugs, on two storage engines
site/            the landing page: one static file, no build step
brand/           the mark, its lockups, and the script that renders the rasters
```

## The sample

`sample/` is a cart screen wired to Room or SQLDelight, OkHttp, Ktor,
WorkManager and Navigation, with a planted recomposition bug for the porthole to
find. It serves its own API from a MockWebServer inside the app, so the demo is
self-contained: the traffic is real HTTP over a real socket, it just does not
need the internet.

It builds on two storage engines behind one `CartStore` interface, because the
porthole instruments the layer underneath both and the sample should have to
prove that rather than claim it:

```bash
./gradlew :sample:installRoomDebug         # Room
./gradlew :sample:installSqldelightDebug   # SQLDelight
adb shell am start -a android.intent.action.VIEW -d "porthole://cart/99001"
./gradlew :sample:portholeConnect
```

Either build produces db events with the same SQL, bound values, timings and
main-thread warnings. The only porthole-aware line in the SQLDelight flavor is
the `factory` argument to its driver.

Then turn on **Animate totals** and ask `recompositions`. The ticking state is
read directly inside each list row, so every row re-executes every frame:

```
read in the row:   2032 recompositions
    Cart.ItemRow              2032   (8 call sites)   <- CartViewModel.tick
```

Flip **Scoped reads**, which passes the state as a `() -> Int` so the read
happens in the leaf `Text` instead, and ask again:

```
read deferred:     2144 recompositions
    Cart.TotalPulse          2144   (8 call sites)
```

Same invalidation rate — the tick fires just as often — but `Cart.ItemRow` has
disappeared from the report entirely. The work moved from a whole `Card` + `Row`
+ `Button` subtree to one `Text`. That is the deferred-read lesson, measured
rather than asserted.

The other buttons each produce something worth looking at: a 402 with an error
body, a one-shot streaming upload, a binary download the body capture declines
to read, a main-thread stall with its stack, a Ktor call over the CIO engine,
and a WorkManager job that fails once and retries before succeeding.

Note that `CartViewModel` is never registered by hand. It is scoped to a
navigation entry, and the nav collector names it.

## What you need

**A device or emulator, with the debug build running.** There is no host-side
mode and there cannot be one: the porthole is code inside your app's process,
binding a socket on the device's loopback interface. `adb forward` is the only
bridge, and it needs USB debugging authorisation like anything else on adb.
Emulator or physical device makes no difference.

Everything else is the app you were going to run anyway. The porthole starts with
the process, so there is nothing to attach and no launch flag to remember.

## Compatibility

| | verified against |
| --- | --- |
| Gradle | 8.14 and 9.7 |
| Android Gradle Plugin | 8.9 and 9.4 |
| Configuration cache | stored and reused |
| minSdk | 26 |
| JDK | 17 for the plugin, 21 for the build |

The plugin declares AGP `compileOnly`, so your build brings its own, and it
touches only the stable variant API. That is not the same as knowing it works,
which is why both ends of that range are tested rather than assumed:

```bash
./gradlew -p gradle-plugin test \
  -Pporthole.agpVersion=9.4.0 -Pporthole.gradleVersion=9.7.1
```

That check earns its place. AGP 9 ships `resValues` disabled by default, and
this plugin writes its port as a resource value, so every app on AGP 9 failed to
configure the moment it applied Porthole — while every test here passed, because
this repository builds on AGP 8 where the feature is on. The plugin now turns
the feature on itself. Worth running before each release, against whatever AGP
is newest.

This repository stays on Gradle 8 and AGP 8 deliberately: a great many apps are
still there, and it is the half of the range a compatibility test cannot cover
from the inside. The Gradle 9 deprecation warnings it prints all come from AGP
8 itself — none from this build — so moving it is an AGP bump and nothing more.

## Setup

**1. Apply the plugin to your app module.**

```kotlin
plugins {
    id("com.android.application")
    id("live.gravitylabs.porthole")
}

porthole {
    port.set(8677)                     // default
    debugBuildTypes.set(listOf("debug"))
}
```

The plugin puts `runtime` on your debug build types and `runtime-noop` on
everything else, and generates the `porthole_port` resource so the port is
configured in exactly one place.

**2. Run one task.**

```bash
./gradlew :app:portholeStart
```

That is the whole minimum: the plugin block above, and this one command.
`portholeStart` installs the debug build, then writes `.mcp.json`, fetches
`trace_processor` the first time anything needs it, and forwards the port and
opens the timeline in your browser — always in that order, a real Gradle
`mustRunAfter` chain rather than a naming coincidence, since the last step
blocks until you stop it. It is not new behaviour: it is `installDebug` (or
`install<Variant>` with flavors — `installRoomDebug`, not
`installRoomDebugDebug`; see below), `portholeMcpConfig`,
`portholeTraceProcessor`, and — forwarding the port — either `portholeUi` or
`portholeConnect`, never both, wired together so the order is not something
you have to learn. Doing anything unusual still means reaching for one of
those four directly — step 6 below is the reference table for that — and
each one works exactly as it always has.

Two things worth knowing before you run it:

- **More than one debug build variant** (a `productFlavors` block, like the
  sample's `room`/`sqldelight` storage flavors) means `portholeStart` cannot
  guess which one you want installed, and refuses rather than picking. Name
  the variant itself, the way `install<Variant>` already ends — not the
  flavor alone — so the sample's Room flavor is `roomDebug`:
  `./gradlew :app:portholeStart -Pporthole.variant=roomDebug`. One variant is
  picked automatically; more than one is always asked for, never guessed.
- **An agent driving this** — no one at a keyboard to look at a browser
  window — wants `-Pporthole.open=false`, which does everything except open
  the timeline. A person running it by hand gets the browser by default,
  since that is what `portholeUi` alone has always done.
- **Two things land in your project root, and one of them belongs in
  `.gitignore`.** `.porthole/` holds every recorded session and every saved
  trace (see [Sessions on disk](#sessions-on-disk)); it is runtime output
  from your own app, grows to 500 MB by default, and should never be
  committed — add `.porthole/` to your `.gitignore` before the first run.
  `.mcp.json` is the agent's config; its `env` block carries absolute paths
  for this machine (`PORTHOLE_PROJECT_ROOT`, `PORTHOLE_SDK_DIR`), so commit
  it only if everyone on the project regenerates it with
  `./gradlew portholeMcpConfig` rather than sharing one copy.
- **If nothing responds once "connected", something is already holding the
  port** — on either end. `portholeConnect`'s `adb forward` succeeds
  whether or not anything else on this machine is already holding the
  port, so if the MCP server still can't reach the app, check what is
  listening on `PORTHOLE_PORT` locally and stop it, or set a different one.
  On the device, another Porthole app already running there (the sample
  counts, and it is exactly what running the sample and then your own app
  produces) can be holding the socket before your app ever tries to bind —
  `adb logcat -s Porthole:E` names it, with the port, this app's own
  package, and the fix: stop the other app, or give this one its own
  `porthole { port.set(...) }`.
- **If it says "connected" but is answering for the wrong app**, the MCP
  server has `PORTHOLE_APPLICATION_ID` (written into `.mcp.json` by
  `portholeMcpConfig` from AGP's own `applicationId`) and compares it
  against every `hello` — a mismatch warns loudly (`porthole_status`, every
  tool's banner, the timeline UI's pill in the danger tone) rather than
  silently answering for whichever app is holding the port. It never
  refuses the connection, so the fix is the same as above: stop the other
  app, or give this one its own port.
- **A device with two adb transports at once** (wireless plus wired, most
  commonly) makes `adb forward` ambiguous, and it fails silently for
  exactly the port this all depends on. `adb devices` lists more than one
  line for the same device when this is happening; pin one with
  `porthole { deviceSerial.set("...") }`.

The runtime starts with the process through androidx.startup and finds the
current Activity on its own, which gives it the view it needs for the
semantics tree and the view models scoped to that Activity. There is nothing
to wrap and no launch flag to remember.

Screen-scoped view models need step 3.

**3. Register your NavController.** One line, and it earns more than it used to.

```kotlin
val navController = rememberNavController()
LaunchedEffect(navController) { Porthole.registerNavController(navController) }
```

Besides the back stack, this is how screen-scoped view models get named.
`viewModel()` inside a `NavHost` scopes its model to the `NavBackStackEntry`
rather than to the Activity, which is the ordinary arrangement rather than an
edge case — so the nav collector names the view models on each entry as you
arrive at it.

On Navigation 3 there is no controller to register, because the back stack is a
snapshot list your code owns. Hand it over instead:

```kotlin
val backStack = rememberNavBackStack(HomeKey)
PortholeBackStack(backStack)
NavDisplay(backStack = backStack, ...)
```

**4. Instrument the clients you care about.** This is the part that cannot be
automatic: instrumenting a client means being handed the builder before it is
built, and nothing can discover that for you. Each is one line, each independent.

```kotlin
import live.gravitylabs.porthole.*

// OkHttp. Phases, timings, status codes and headers. No bodies.
OkHttpClient.Builder().installPorthole().build()

// Bodies too, when you are debugging a payload rather than a timing.
OkHttpClient.Builder().installPorthole(bodies = BodyCapture.Text).build()

// Ktor, for clients not on the OkHttp engine.
HttpClient(CIO) { install(portholeKtor()) }

// Room. Bound values are recorded by default; captureBindArgs = false stops it.
Room.databaseBuilder(context, AppDb::class.java, "app.db").installPorthole().build()

// SQLDelight, or anything else built on androidx.sqlite.
AndroidSqliteDriver(schema = Schema, context = context, name = "app.db",
    factory = portholeSqliteFactory())
```

One import covers all of them. And if you forget one, the runtime says so a few
seconds after start rather than leaving you with an empty lane that looks the
same as an app which made no requests:

```
I Porthole: not instrumented: okhttp — add installPorthole() to your OkHttpClient.Builder
```

It only says that for libraries actually on your classpath, so an app with no
database is never told about Room. The timeline says it too, on the lane
itself — an empty http lane reads "okhttp or ktor not instrumented" rather
than looking like an app that made no requests.

**Every integration is optional and independent.** Instrument HTTP and not the
database, or neither. Verified by stripping all four from the sample: the run
still produced recompositions, state writes, frames, main-thread stalls,
memory, GC, device context, logs and WorkManager. Only the lanes you did not
wire are empty, and those say why.

Room was never the thing being instrumented — `SupportSQLiteOpenHelper` was, and
Room is one of the things that opens a database through it. That is why the same
factory covers SQLDelight, and why the database inspector reads both.

If your Ktor client uses the OkHttp engine, install the OkHttp porthole on that
engine instead and you get more: the interceptor sees DNS, connect and TLS as
separate phases, which a plugin sitting above the engine cannot.

WorkManager needs nothing. If it is on the classpath it is observed, and every
attempt appears on the timeline — retries as separate bars, which is usually the
thing you are looking for.

**5. Optional: name things the tool cannot name for itself.**

Automatic naming covers view models. State a composable creates for itself has
no owner to reflect over, and a composable has no name of its own, so those are
worth a word each:

```kotlin
@Composable
fun CartScreen(viewModel: CartViewModel) = PortholeScreen("Cart") {
    val items by viewModel.items.collectAsNamedState("CartViewModel.items")
    val query = rememberNamedState("Cart.query", "")

    LazyColumn {
        items(items) { item ->
            CartRow(item, modifier = Modifier.portholeNode("Cart.ItemRow"))
        }
    }
}
```

`PortholeRoot` still exists and still names the root screen, but it is no longer
required for the semantics tree — the runtime attaches to the Activity's decor
view by itself.

**6. The pieces, individually.** `portholeStart` in step 2 is four of these
five tasks, for one variant, in a fixed order — `portholeConnect` and
`portholeUi` both forward the port, so exactly one of them runs, never both.
Reach for any of the five directly for anything `portholeStart` does not
cover — a second device, the UI without a fresh install, a config entry
regenerated after editing `.mcp.json` by hand:

| task | does | reach for it directly when |
| --- | --- | --- |
| `install<Variant>` | installs the debug build (AGP's own task, e.g. `installDebug` or, with flavors, `installRoomDebug`) | you only need the build on the device, nothing else |
| `portholeConnect` | `adb forward`s the port and writes the connection file | your agent is doing the looking and you do not want a browser — `portholeStart -Pporthole.open=false` uses this instead of `portholeUi` |
| `portholeMcpConfig` | writes the MCP server entry into `.mcp.json` | you edited `.mcp.json` by hand and want the entry regenerated, or need `-Pporthole.overwrite=true` |
| `portholeTraceProcessor` | fetches and verifies Perfetto's `trace_processor`, once | you want it ahead of time, or `-Pporthole.refresh=true` to re-fetch it |
| `portholeUi` | forwards the port itself, serves the UI, opens your browser, and keeps running until you stop it | you already installed and connected, and only want the timeline again |

`portholeUi` and the npm CLI it launches are the same thing, so without the
plugin applied — or without Gradle at all — this does what `portholeUi` does:

```bash
npx @gravitylabsllc/porthole ui
```

Both need Node, because the UI is a web app. The MCP server and the UI are
independent — run either, or both at once, and each opens its own connection
to the device.

**7. Point your agent at it.** `./gradlew portholeMcpConfig` prints the entry:

```json
{
  "mcpServers": {
    "porthole": {
      "command": "npx",
      "args": ["-y", "@gravitylabsllc/porthole", "mcp"],
      "env": { "PORTHOLE_PORT": "8677" }
    }
  }
}
```

`./gradlew portholeMcpConfig` writes that entry for you. It merges rather than
overwrites, so other servers in the file are untouched, and if a `porthole`
entry is already there and differs it prints the difference and leaves it —
a different entry is usually deliberate. `-Pporthole.overwrite=true` replaces
it, and the previous file is kept as `.mcp.json.bak` either way.

**Environment variables**, for anyone not going through the generated
`.mcp.json` above:

| variable | default | what it sets |
| --- | --- | --- |
| `PORTHOLE_HOST` | `127.0.0.1` | host the forwarded device socket is reachable on |
| `PORTHOLE_PORT` | `8677` | device port the porthole listens on |
| `PORTHOLE_UI_PORT` | `8678` | port the timeline is served on |
| `PORTHOLE_TRACE_PROCESSOR` | none | path to Perfetto's `trace_processor`, for [system traces](#system-traces) |
| `PORTHOLE_TRACE_TIMEOUT_MS` | `60000` | how long `ask_system_trace` waits on `trace_processor` per question before giving up |
| `PORTHOLE_SESSIONS` | on | set to `0` to turn off [sessions on disk](#sessions-on-disk) entirely |
| `PORTHOLE_SESSIONS_MAX_BYTES` | `524288000` (500MB) | total size before the oldest session is pruned, see [Sessions on disk](#sessions-on-disk) |
| `PORTHOLE_SESSIONS_MAX_AGE_DAYS` | `7` | age before a session is pruned regardless of size, see [Sessions on disk](#sessions-on-disk) |
| `PORTHOLE_APPLICATION_ID` | none | the app this server expects — written by `portholeMcpConfig` from AGP's own `applicationId` on an application module, or from `porthole { applicationId.set(...) }` if you set one explicitly. A `hello` naming a different package warns loudly everywhere (`porthole_status`, every tool's banner, the timeline UI's pill) instead of silently answering for whichever app happens to be holding the port |

Two more exist but you should not normally set them by hand: `PORTHOLE_PROJECT_ROOT`
and `PORTHOLE_SDK_DIR` are written into the generated `.mcp.json` by
`portholeMcpConfig`, which knows both with certainty — the Gradle root
project directory, and the SDK resolved the same way the plugin resolves it
for `adb` itself — rather than guessing from whatever directory an MCP
client happened to launch the server in. `porthole_status` reports which
source each came from (`PORTHOLE_PROJECT_ROOT` or `cwd` for the root;
`PORTHOLE_SDK_DIR`, `local.properties`, `ANDROID_HOME`, `ANDROID_SDK_ROOT` or
`PATH` for the SDK), which is where to look first if a resolved path looks
wrong.

## What you actually have to write

The short answer to "is it just the plugin and a dependency": nearly.

| | |
| --- | --- |
| the plugin | required — it brings the runtime and owns the port |
| `registerNavController` | one line, if you use Navigation |
| `installPorthole()` on each client | one line each, and unavoidable |
| everything else | optional, for better names |

View models, the semantics tree, frames, the main thread, memory, WorkManager,
logs and device context all need nothing at all.

## What the timeline shows

Lanes, sharing one clock: findings, recompositions and state writes, dropped
frames and main-thread stalls, navigation, http, db, work, memory, device
context, and your own logcat at warning and above.

A few of them are worth knowing about because the number means something
specific. Dropped frames are counted in refreshes, so a 400ms freeze is not "one
missed frame". Work gets one bar per attempt, so a retry is visible rather than
averaged into a single long one. The main thread lane carries both stalls and
the queries that ran on it.

Clicking any mark opens it: the subject first, then its attributes, then whatever
bulk it carries. `ask agent` copies the window as bounds.

The findings lane is the first one, above recompositions, and it is the one
lane whose data is a server answer rather than the event buffer — it has its
own loading, stale and empty states, so a request still in flight does not
read as "nothing is wrong." Severity is colour, matching the insights panel
exactly; confidence is a solid mark for `observed` and an outline for
`correlated`; source is a small filled-versus-hollow mark at the mark's edge.
A `spanning` finding draws as a dim band across the window it was asked
about rather than as a point, since it has no narrower moment to sit under.
Findings that overlap on screen stack up to three rows before a `+N` glyph
takes over. With no trace loaded, the lane still shows Porthole's own
findings and says the trace half is missing in one line.

That trace half comes from a capture chosen in the insights panel header: a
small dropdown, fed by `GET /api/traces`, listing captures by when they were
recorded. A capture whose coverage could not be read (`coverage: null`) is
listed with its reason and cannot be chosen. Once one is chosen, the ruler
grows a thin bar under it showing which part of the visible axis that
capture's coverage actually covers — the difference between "the trace has
nothing to say about this window" (no bar reaches it) and "the trace says
nothing was wrong here" (the bar reaches it and the lane is quiet), which
otherwise look identical.

Selecting a dropped frame, a main-thread stall, or a finding adds an
**ask the trace** action to the selection panel — the gesture that replaces
opening a trace viewer. It asks about that hit's own window (its duration,
centred, floored at 200ms of total width — never the visible view) against
whichever capture's coverage actually contains it: the one chosen above if
its coverage reaches that far, otherwise the first listed capture that does,
otherwise none. With none, the panel says plainly that no capture covers that
moment and offers a copy-ready prompt for taking one. Otherwise it asks
`GET /api/findings?trace=<id>&from=&to=` — the same endpoint the lane above
already uses, no second implementation — and renders the answer sourced and
confidence-labelled like every other finding, including a line for each
question the trace answered that ruled something out rather than finding it:
"the main thread was running for all of it" is as much an answer as a jank
finding is. A copy-ready prompt names the same bounds for pasting at an agent.
The answer is cached per capture and window for the session, so re-selecting
the same hit never re-asks.

The header also has **database**, a read-only inspector over the app's own
tables — list, page, and run a SELECT — and **restart app**, which force-stops
and relaunches over adb.

The inspector reads through an undecorated handle, so looking at a table does
not emit query events for the act of looking. It refuses anything that is not a
single SELECT, WITH, or a PRAGMA with no assignment in it. That is enforced on
the device rather than assumed from the socket being loopback.

### Timeline server API

`GET /api/findings` is the one place a trace-derived finding and a Porthole
finding sit in one list, on one severity vocabulary, each carrying a `source`.
Add `?trace=<id>` to merge in what a system trace has to say about the same
window; the id has to be one `GET /api/traces` just listed — an arbitrary
filesystem path is refused, before anything is spawned. When a trace was
actually queried, the response also carries `asked`: one `{ id, answered }`
per question `ask_system_trace` puts to it, so a caller can tell "this
question was answered and ruled nothing out" apart from "this question was
never reached" — the two look the same from the finding list alone.

`GET /api/traces` lists what is under `.porthole/traces/`: `id` (the file name,
without `.pftrace`), `bytes`, `recordedAt`, and `coverage` — the uptime window
the capture covers, `{ from, to }` in the same clock every finding's own
`window` is in, or `null` with a `reason` when trace_processor could not read
it (missing binary, no clock snapshot). It is how a caller finds out whether a
trace has anything to say about what is on screen right now without opening
it.

Every finding either carries a `window` in that clock or is marked
`spanning: true` for one that is a property of the whole window asked about
rather than a moment inside it — a thread-state aggregate summed across
however many stretches the scheduler visited that state, say. Drawing either
as a point under one frame would invent a precision neither one has.

## Capturing a run with nobody watching

The timeline is for a person looking at their own app. On CI there is nobody
looking, so a capture writes a file instead.

```bash
porthole capture --scenario checkout --out trace.json -- ./gradlew connectedRoomDebugAndroidTest
porthole report trace.json
porthole compare baseline.json trace.json
```

It wraps a command rather than asking anything of it, so `connectedAndroidTest`,
Maestro, a shell script and an agentic driver are all just a command. The
process lifetime is the capture window.

What comes back is a short list of what is worth looking at, not a dump:

```
checkout · 9.8s · Google sdk_gphone16k_x86_64 (60Hz) · com.example.shop

  ERROR    1 database query ran on the main thread
           Worst was 3ms: SELECT * FROM cart_items WHERE cartId = ? ORDER BY addedAt DESC
  ERROR    main thread blocked for 305ms
           during "block the main thread"
           com.example.shop.ui.CartViewModel.blockTheMainThread(CartViewModel.kt:146)
  ERROR    1 HTTP call failed
           POST http://localhost:54779/v1/checkout → 402
  WARNING  158 frames missed their deadline (budget 16.7ms at 60Hz)
           worst 276ms · most often in swapBuffers

  quiet: memory

  frame budget 16.7ms · 214 recompositions · 4 calls (2 still open) · 11 queries
```

The last "quiet" line is not padding. A report that only ever lists problems
gives no signal that the things it did not mention were actually checked.

The footer's counts include spans that were still open when the capture
ended — a call that never came back still happened and still cost the wait —
and the `(N still open)` qualifier travels with the number it counts so "4
calls" cannot be misread as four completions. It is left off entirely when
nothing was open, which is almost every run.

Every finding carries how strongly it can be claimed. **observed** means the
device said so — a query ran on the main thread, a frame missed its deadline.
**correlated** means two things happened near each other, which is ordering and
not causation; the recomposition hotspot is the only one of those, and it says
"ordering, not proof" in its own text. There is no `cause` field.

### Steps

`Porthole.mark("checkout")` puts a label on the timeline, and findings name the
mark they fell under. An instrumented test runs in the app's process, so a
`connectedAndroidTest` can mark its own steps with no protocol and no
coordination; the app can mark its own phases the same way.

### Regressions

`compare` diffs the metrics, with two rules that keep it honest. Changes below
both a relative and an absolute floor are noise and are not reported — without
both, every run is a regression and the check gets switched off. And zero to
non-zero is always reported, however small, because the first main-thread query
is categorical rather than a drift.

It refuses outright when the two runs were never comparable — a different
scenario, refresh rate, or core count — and **exits 2 when it refuses**, because
a gate that compared nothing should not go green.

One caveat worth knowing before wiring this to CI. Findings are categorical and
survive any driver, including an exploratory one. Timing comparison does not: a
driver that reasons between steps varies its own pace and path, so
`frames.p95Ms` drifts for reasons that are not your code. Gate timings on a
deterministic driver — Macrobenchmark, UiAutomator, Maestro — and use
`--driver <name>` so `compare` can point out when two runs were driven
differently.

Not settled yet, and worth knowing before leaning on this:

- **Where a baseline lives.** A file in the repo is reviewable but goes stale. A
  rolling baseline from the last green build catches drift but hides a slow
  decline. Probably both, with the repo file winning.
- **One run is one sample.** Repeating a scenario and taking the median is the
  only way a timing gate is really trustworthy, and it costs CI minutes. Worth
  measuring the variance before deciding.
- **Stacks in release builds.** They come through readable from a debug build. A
  minified capture would need mapping, which is a larger piece of work.
- **`--driver` is a label**, and a label is only as honest as whoever typed it.
  `compare` can say two runs were driven differently; it cannot tell.

There is no start/stop control surface, deliberately. A driver that runs as a
library inside someone's test process cannot be wrapped as a command and would
want one — but it is worth nothing until such a driver integrates with it, and
it brings lifecycle problems the wrapper does not have, starting with a crashed
test leaving a capture running forever.

## Handing a moment to the agent

The two halves share a clock: every event, every log line and every report is
stamped in device uptime. That is what makes the handoff work.

When the timeline shows you something it cannot explain — a recomposition spike
with no obvious cause — zoom to it and press **Ask agent**. It copies the window
you are looking at, as bounds rather than prose:

```
Using the porthole MCP tools, look at device uptime 2057010 to 2075089.
That window contains: recompose 1145, state_write 161, log 71, db_start 4, nav 1.
Start with recompositions {"from": 2057010, "to": 2075089} and logs
{"from": 2057010, "to": 2075089, "level": "W"}.
```

Paste that at your assistant. `recompositions`, `logs` and `timeline` all take
absolute `from`/`to`, so it asks about the moment you actually saw instead of
guessing a lookback and hoping the windows overlap.

### What happened while you were not looking

MCP has no push — a server cannot interrupt an agent's turn. The gap this
leaves is the ordinary agentic loop: ask a question, think for a while, ask
another. In between, the app can ANR and nothing says so; the next call
either misses it or, worse, re-reports the same three findings it already
investigated.

Every window-taking tool (`findings`, `save_moment`, `recompositions`,
`frames`, `blocking`, `logs`, `timeline`) accepts a `since` parameter next to
`sinceMs`/`from`/`to`, and it is the default whenever none of those three are
given:

- `since: "last"` (the default) starts where the previous window-taking tool
  call on this session left off, so a call with no arguments never misses
  anything and never re-reads what was already examined. The first call a
  session ever makes has nothing to start from, so it behaves exactly like
  today's default — the whole buffer — and its summary says so.
- `since: "all"` is the reset: the whole buffer plus disk, the same as every
  call before `since` existed, and it clears the tracking `since: "last"`
  uses. There is no separate `reset_watermark` tool — this is the reset.

This tracking (`lastExaminedT`, an error-severity digest, and `findings`' own
last result) is a **watermark**: one per MCP server process, keyed to
whichever session is currently open, held in memory and written through to
`<session dir>/watermark.json` beside `events.ndjson` on every update. It
survives an MCP server restart the same way [sessions on disk](#sessions-on-disk)
do — loaded back from the session directory the next time that identity
reconnects. Two MCP servers attached to one app at once is not designed
for: both would write the same file, and the last writer wins.

**The banner.** Every tool's result — not only `findings` — leads its
summary line with a one-line alert when anything of `error` severity has
happened since the last call and has not yet been reported:

```
⚠ Since your last call: main thread blocked for 6200ms. Call `findings {"since":"last"}`.
```

It never repeats an event: showing the banner advances the watermark, so the
same ANR is not reported again on the next nine calls. Capped at 240
characters, truncating with "…and N more kinds" rather than growing past it.
The same fact is also on the payload as a structured field —
`sinceLast: { errors, firstAt, lastAt } | null` — for a caller that would
rather branch on a value than parse a sentence.

**`findings` classifies what it finds** against its own previous call:
each finding carries `status: "new" | "ongoing" | "resolved"`, and an
`ongoing` one carries `delta` — the count now minus the count last time, so
"still happening" and "got worse while I was reading" read differently.
`resolved` is reported exactly once, for a finding that was there last time
and is not any more, and then it drops out. The summary line says "N new, M
ongoing, K resolved" rather than restating every ongoing finding.

Classification only runs when the two calls are actually comparable: chained
`since: "last"` calls always are, and two calls with explicit windows are
comparable when they overlap by at least half of the shorter one. When they
are not, `findings` says so in the summary and leaves every finding
unclassified rather than guessing — a `resolved` finding from a call that
merely looked somewhere else would be a false all-clear.

## Sessions on disk

The MCP server's own memory is a process, and that process restarts more
often than you would like — it is usually owned by your MCP client, not by
you. Everything the in-memory buffer holds is gone the moment it does, which
used to mean a moment `findings` told you about eight minutes ago was simply
no longer answerable: "not that nothing was happening — it is no longer
held."

`findings`, `what_was_happening` and `timeline` now fall back to a session
recorded on disk whenever the live buffer cannot cover the window you asked
for, so a restart, a crash, or reinstalling the app mid-session no longer
loses the evidence. This is not a new capture mode and nothing you have to
turn on — it is what the socket was already carrying, written down as it
arrives.

What's written is **exactly** the event stream that already crosses the
socket: the same one [Payloads](#payloads-what-gets-captured-and-what-does-not)
and [Security](#security) describe — already starred, redacted and
body-capture-gated in-process, before any of this module ever sees it.
Nothing new is captured for this feature; it records the wire, verbatim.

A session is one contiguous run of one app process, identified by
`(packageName, deviceId, startedAt)` — the same triple the timeline already
uses to know when to start a fresh in-memory buffer. It lives at
`<project root>/.porthole/sessions/<id>/`: `events.ndjson` (one JSON object
per line, appended off the socket thread on an interval, never inline, so
persistence cannot slow down what the socket is doing) plus `meta.json`
(device profile, first/last recorded time, event counts by kind).
Add `.porthole/` to your project's `.gitignore` (see step 2 of
[Setup](#setup)): it is runtime output, it grows to the retention cap
below, and it contains whatever your app sent, redacted but yours.

Retention prunes by total size and by age, oldest session first, and never
touches the session currently being written no matter how old or large it
is. Defaults: 500MB total, 7 days. `PORTHOLE_SESSIONS_MAX_BYTES` and
`PORTHOLE_SESSIONS_MAX_AGE_DAYS` override those (see the environment
variable table above). `PORTHOLE_SESSIONS=0` is the off switch: set it and
nothing is written to disk at all — the window-taking tools answer only from
the live buffer, the same as before this feature existed.

### Saving a moment after it happened

Every other way Porthole produces a durable trace requires deciding to record
*before* the interesting thing happens — `capture` wraps a command,
`capture_system_trace` blocks for a fixed duration. Sessions on disk mean that
decision no longer has to come first: poke the app, watch something break,
*then* keep it.

`save_moment` (MCP) and `porthole save` (CLI) turn a window into a trace file
in exactly the format `capture` writes, so `porthole report` and
`porthole compare` work on it with no changes:

```bash
porthole save --scenario checkout --since 10m
porthole save --from 2057010 --to 2075089 --out trace.json   # quote a finding's window directly
```

`--since` accepts `10m`, `90s`, `2h`, or a bare millisecond count.
`--scenario` defaults to `moment-<from>-<to>` on the uptime clock when
omitted, and `--out` defaults to `.porthole/traces/<scenario>.json`, the same
directory `capture_system_trace` writes under. The CLI has no running MCP
server's live buffer to ask "what counts as now", so it resolves both against
whichever session on disk was most recently written to — with more than one
app or device recording at once, that is the busiest one, not necessarily the
one you meant; pass `--from`/`--to` explicitly to sidestep the ambiguity.

The result — from either entry point — carries `clippedMs`, the same
vocabulary `findings` reports coverage in: a window reaching earlier than
anything ever recorded says so rather than silently writing a shorter trace.
`--with-events` does not exist here; a saved moment sits right next to the
session file it came from, so a copy of the same events inside the trace
would only double the bytes to hand back something already on disk.

`porthole sessions` lists what is recorded, across every app and device,
newest-started first, with the most recently active one marked:

```
$ porthole sessions
* com.example.shop device-under-test started 2026-09-15T18:04:02.000Z t=[0,842011] events=15234 3.8MB .porthole/sessions/com.example.shop_device-under-test_500000
  com.example.shop emulator-5554     started 2026-09-14T09:11:40.000Z t=[0,190442] events=4120  980.1KB .porthole/sessions/com.example.shop_emulator-5554_10000
```

The timeline UI has the same gesture built into its header: **keep** saves
the window you are already looking at, through the same save path. Zoomed
or panned away from the live edge, it saves exactly the visible window, to
the millisecond the ruler shows; following the live edge, there is no fixed
window to save, so it saves a lookback of N seconds ending now — a small
input next to the button, defaulting to 30. Either way it writes through
`POST /api/save` (`{from, to, scenario?}` in uptime ms, hardened the way
`/api/tools/restart` is: POST only, the same origin check every route on
this server already applies, a 400 on a malformed body or `from >= to`)
into the same `buildSavedTrace`/`writeSavedTrace` pair above, so the
result is the same trace format either way. The header shows the path it
wrote, selectable and copyable — the next thing you do with it is paste it
at the agent — plus one line: this saves the Porthole half only, since the
system trace ring (GRA-57) is not in 0.2.0. It replaces the old
**copy trace** control, which put every event in the window on the
clipboard as an unbounded JSON blob `capture`'s own tools never read — two
controls claiming to save the window was worse than one.

## System traces

Porthole watches one process. Most of what goes wrong is inside it, but not
all of it — a stall whose stack bottoms out in a native read, or jank blamed on
`swapBuffers`, can be the OS's doing rather than the app's. Answering that
needs the view that watches everything, which is what a Perfetto system trace
is and Porthole is not.

`system_context` is the live half of that: thermal state, CPU governor and
clock, the busiest processes, memory pressure, read straight off the device.
It draws no conclusions — a throttled device is a fact, that it explains your
regression is a guess this tool leaves to you.

`capture_system_trace` records a trace: `atrace` categories aimed at jank, for
the duration you give it, pulled off the device when it is done. It does not
return the trace itself — a ten-second capture is tens of megabytes of
protobuf, and the useful form is a file you open, not one you read — so it
lands under `.porthole/traces/`, relative to wherever the MCP server's process
is running, and the result is a path plus a sentence saying whether it is
worth opening. The reason to take one here rather than by hand is that the
runtime's own atrace sections are already inside it: navigations, HTTP calls,
queries and stalls, so the capture arrives annotated with what the app was
doing and not only what the kernel was doing. The result says how many of
those labels it found, which is how you know the annotation actually
happened — and on the verified device (see Status) that count tracks what the
app actually did inside the window, not whether `--app` was honoured: a
capture of a screen sitting idle, with no navigation, HTTP, DB or stall
activity inside it, comes back with zero labels correctly, because there was
nothing for the runtime to annotate.

**Some builds only read the app trace tag when a process starts, not while
one is already running.** Confirmed on a Pixel 9 Pro Fold, Android 17: a
process already running when the capture session starts never has its
`ATRACE_TAG_APP` sections recorded, even though the session's own `--app`
enablement reaches the property table correctly — classic `atrace -a` shows
the identical restriction, so it is a platform behaviour, not a Porthole or
`perfetto --app` defect. (The Pixel 10 Pro XL, also Android 17, does not have
this restriction: it live-reloads the tag for an already-running process.)
`capture_system_trace`'s `restartApp: true` option works around it by
force-stopping and relaunching the target app right after the capture starts,
at the cost of the trace containing a cold start; Porthole reconnects to the
relaunched process on its own. Launching the app after starting the capture
by hand has the same effect.

`ask_system_trace` turns that file into an answer without anyone opening a
trace viewer. It runs a fixed set of five questions — jank, thread states,
binder, render, slices — scoped to one window and one process, using
parameters Porthole already holds: the window off a finding, the package off
the handshake with the device. Deliberately not a SQL interface: an agent
handed a hundred tables and no guidance assembles an answer from whichever
guess came back non-empty, which is the failure this surface exists to avoid.
What it is for is ruling causes out — CPU starvation, blocked I/O, the runtime
compiling its own bytecode in the background — and answering yes to one of
those means the app's own work was never the whole story.

Both need `trace_processor_shell`, Perfetto's own query engine and a large
platform-specific binary that is not bundled with Porthole: it would multiply
the size of a Gradle plugin and an npm package for a tool most sessions never
reach for. `./gradlew portholeTraceProcessor` fetches it instead — a pinned
release, SHA-256 verified per platform, cached under
`~/.porthole/trace-processor/<version>/` — which is the same bargain the
Gradle wrapper makes with `distributionSha256Sum`. The MCP tool finds it there
without further configuration; an existing copy works too, via
`PORTHOLE_TRACE_PROCESSOR` or a `traceProcessor` argument. Neither tool needs
it to exist before you start — the trace is already readable by hand at
ui.perfetto.dev, and `ask_system_trace` says so, and where to get one, when it
cannot find a binary.

One clock detail worth knowing before a window looks wrong. Porthole stamps
everything in `SystemClock.uptimeMillis()`, which stops during deep sleep;
Perfetto stamps in `CLOCK_BOOTTIME`, which does not. The two drift apart by
however long the device has slept, so a window handed to `ask_system_trace`
is converted using the sleep reading in force at the time before it means
anything to the trace. `what_was_happening` takes a raw `bootMs` reading off a
Perfetto trace directly, for the same reason.

## What the numbers actually mean

This matters more than usual, because an agent will take these outputs at face
value.

**Recomposition counts cover instrumented call sites only.** Compose exposes no
public hook for "every recomposition in the tree", so the porthole counts the
scopes you wrapped in `PortholeScreen` or `Modifier.portholeNode`. A composable that
does not appear in the report is uninstrumented, not idle. The report says so in
its own `notes` field.

**Attribution is temporal, not causal.** `Snapshot.registerApplyObserver` tells
us which state objects were written in each apply, and we pair that with the
recompositions that follow within ~32ms (two frames). When three states change
in one frame, all three are listed as possible triggers. It is a strong signal,
not a proof.

**Names come from an owner.** A state object has no name of its own, so every
name in a report came from something that owns it. View models are found for
you; the rest you name. What each one reaches:

| your state lives in | name it with | reachable? |
| --- | --- | --- |
| a ViewModel field | nothing — found via the Activity or the nav entry | yes, by reflection |
| an object a ViewModel holds | the same | yes, the walk goes three deep |
| a ViewModel the tool cannot reach | `Porthole.registerViewModel("Cart", vm)` | yes, same reflection |
| a `StateFlow` | `flow.collectAsNamedState("Cart.items")` | yes, names the State it feeds |
| `remember { mutableStateOf() }` in a composable | `rememberNamedState("Cart.query", "")` | yes |
| Compose itself — ripples, scroll, focus, animation | nothing | **no, and that is correct** |

A view model scoped to something other than an Activity or a navigation entry —
a custom `ViewModelStoreOwner`, or one held outside a store entirely — is the
case that still needs the explicit call.

Registration walks past the direct fields, so state living one hop away — a
ui-state holder, a repository with an observable cache — gets named too. The
walk stops at library packages, and is bounded in depth and in objects visited
so a cyclic object graph cannot turn registration into a hang.

That last row is most of what you will see. In the sample app, all five of the
ViewModel's states resolve to names, and *every one* of the fifty-odd unnamed
states belongs to Material and Compose internals. They still appear, as
`unnamed#3f2a1c`, because a burst of them next to a recomposition is a real
signal — but they are not yours and there is nothing to fix.

So the timeline splits the lane. Writes it can name are drawn solid on the top
half; anonymous ones are faint on the bottom half, and **hidden by default** —
the **Framework** button brings them back. Mixing the two buries the half you
can act on, and on a real screen the anonymous ones outnumber yours.

Worth being precise about what that split is: it is *named versus anonymous*,
not *yours versus Compose*. Nothing about a state object says who created it.
In practice almost everything anonymous is the framework, but your own
unregistered state lands there too — which is the argument for registering it
rather than for trusting the colour.

A key that is yours and still unnamed means its owner was never registered, or
was registered too late: naming applies from the moment of the call, and writes
before it stay anonymous.

**A StateFlow is never directly attributable.** Its emissions are not snapshot
writes, so the apply observer never sees them. What the observer sees is the
`State` that `collectAsState` produces downstream — which is anonymous unless
you use `collectAsNamedState("name")`.

**`stableId` in the semantics tree is a structural path hash**, built from the
porthole node id, then test tag, then role, then sibling index. Compose's own
`SemanticsNode.id` is recycled and useless for diffing two captures; this is
not.

**Room queries are timed by wrapping the open helper**, not by
`setQueryCallback`, which only fires at query start and never reports
completion. Raw access to the underlying `SQLiteDatabase` that bypasses the
support layer is not seen.

## Payloads: what gets captured, and what does not

Two knobs, with different defaults, for a reason.

**Database bind values are captured by default.** `PortholeStatement` overrides the
`bind*` methods rather than delegating them, so by the time a statement executes
the porthole knows what was bound. Reads recover their arguments a different way:
`SupportSQLiteQuery.bindTo` is replayed into a recorder, which reads the values
without executing anything. So a write arrives as

```
sql:    INSERT OR REPLACE INTO cart_items (`id`,`cart_id`,`name`,`qty`, ...
args:   mug-ceramic-01, 88213, Ceramic Mug, 2, 1800, 1789092786359
kind:   write
result: 412            # executeInsert row id, or rows affected for an update
thread: Room-Transaction-1
```

rather than a row of question marks. Values are truncated at 64 characters and
blobs are never included, only sized (`<blob 48213 bytes>`). Pass
`captureBindArgs = false` if the database holds something you would rather never
have in a trace; the SQL, timings and thread still come through.

**HTTP bodies are off by default.** Bodies are the most sensitive thing here and
the most likely to get pasted into a chat window — an auth response carries
tokens, a profile response carries personal data. Turn it on per client, for the
client you are debugging, with `BodyCapture`.

Capture is an `Interceptor`, not the `EventListener`: the listener only ever
sees byte counts. Even when enabled it is bounded four ways:

- only text-shaped content types (`application/json`, `text/`, form encoding, …)
- never an open-ended stream (`text/event-stream`, `application/grpc`,
  `application/x-ndjson`) — peeking at one would block until traffic arrived
  that may never come
- only the first `maxBytes` (4KB by default), with `truncated: true` when there
  was more
- `authorization`, `cookie`, `set-cookie`, `x-api-key` and friends are replaced
  with `*` in-process, before anything reaches the socket

**Request bodies are teed, not re-read.** The obvious implementation — read the
body into a buffer, then hand the buffer to OkHttp — fails on a one-shot body
(a stream can only be written once) and serialises a large payload twice for no
reason. Instead the body is wrapped in a `RequestBody` whose `writeTo` copies
the first `maxBytes` as they travel to the socket. The source is read exactly
once, by the real write, so a streaming upload is as capturable as a string, and
a 2GB file costs `maxBytes` of memory rather than 2GB.

Two consequences worth knowing:

- The preview is not final until the upload is. Ask `inflight` mid-upload and
  you get what has gone out so far, with `omittedReason: "still uploading"` —
  which is exactly what you want when a request is stuck partway through.
- Chunked uploads get a real `byteCount` (what the tee counted) rather than the
  `-1` that `contentLength()` reports. That holds even for content types it
  declines to read: it still counts them.

The one body it genuinely cannot report is a **duplex** one, where the request
is written while the response is being read. There is no moment at which it is a
finished thing, so it is reported as such rather than half-captured.

Response bodies go through `Response.peekBody`, which buffers a copy and leaves
the real body untouched for your code to consume.

When a body is not captured, you get the reason rather than silence:

```json
{ "contentType": "image/webp", "byteCount": 48213, "text": null,
  "omittedReason": "content type not captured" }
```

That distinction matters — "we did not look" and "there was nothing there" are
very different answers to "did we even send that field".

Full previews live in `inflight`'s `recentHttp` (last 25 calls). The event
timeline carries only a 512-character snippet, so turning bodies on does not
blow out the ring buffer.

## Frames

Every other collector measures a cause. This one measures the effect: a
recomposition count is only interesting because of what it does to frame time,
and a tool that reports the churn without the cost leaves you to guess whether
it mattered.

`frames` reports how many frames overran the display's deadline and, for the
worst ones, where the time went:

```
157 of 241 frames janky (65.1%), budget 16.7ms at 60Hz.
  222ms  missed 13  worst=swapBuffers
  100ms  missed  6  worst=animation
```

`worstPhase` is the part that decides where to look. `layoutMeasure` or `draw`
points at composition doing too much work; `gpu` or `swapBuffers` at overdraw or
an expensive shader; `unknownDelay` at the main thread being busy with something
that is not drawing at all. The timeline puts the jank lane directly under the
recomposition lane, because "did that burst cost frames" is the question, and
two lanes on one axis answer it by eye.

Two implementation notes worth knowing:

**It observes rather than drives.** `Window.addOnFrameMetricsAvailableListener`
reports on frames the system actually drew. The obvious alternative — reposting
a Choreographer frame callback — requests a vsync every frame, so an idle app
never idles and the measurement changes the thing being measured.

**Late and how-late are different numbers.** Whether a frame was janky is judged
against its own deadline, which the system can relax. How much of the display it
cost is always counted in refreshes. Dividing by a relaxed deadline reported a
400ms freeze as one missed frame, which is how that bug was found.

Needs API 24. Below that the only techniques available force a vsync, so the
collector reports nothing rather than lying.

## Main thread blocking

`frames` says a frame was late. `blocking` says what was holding the thread.

Stalls are found by pinging: a background thread posts a message to the main
looper every 300ms and times the reply. The message goes to the back of the
queue, so its latency is exactly how long everything ahead of it took. When a
ping goes overdue the main thread's stack is sampled once — and the stack is the
whole point, because "blocked for 486ms" is a symptom and a line number is a
cause:

```
213ms blocked
  com.example.shop.ui.CartViewModel.blockTheMainThread(CartViewModel.kt:139)
  com.example.shop.ui.ScreensKt.Controls$lambda$21(Screens.kt:129)
  java.lang.Thread.sleep(Thread.java:-2)
```

App frames are listed first, and everything else follows rather than being
dropped. The top frame of a stalled thread is nearly always `Thread.sleep`, a
lock, or a native read — all true, and none of them the line you can change.

The obvious alternative, `Looper.setMessageLogging`, makes the looper build a
log string for every message it dispatches: allocating on the main thread
forever to catch the rare moment it is slow. One ping every 300ms costs nothing
by comparison.

**Database work on the main thread is reported however fast it was.** A 1ms
query still ran a disk read inside the frame loop; it is a defect that has not
bitten yet, and it will bite on a cold cache or a slower phone. Room's thread is
checked by identity, not by name, since a background thread can be called
anything.

**HTTP is checked in the interceptor, not the event listener.** `callStart` runs
on whoever called `enqueue`, which is routinely the main thread and says nothing
about where the IO goes; the interceptor chain runs on the thread doing the
work. In practice this should never fire — OkHttp throws
`NetworkOnMainThreadException` for a synchronous call on the main thread — so if
it ever does, something has gone around OkHttp's own guard and is worth a hard
look.

The timeline puts the main thread lane next to dropped frames, because a block
and the frames it cost are the same event seen twice.

## Logs

The app reads its own logcat and streams it over the same socket as everything
else, so there is no second terminal and no `adb logcat | grep` to keep alive.
Ask the `logs` tool, or watch the pane at the bottom of the timeline UI.

Since Jelly Bean an app only ever sees log entries from its own uid, so spawning
`logcat` inside the process needs no permission and returns exactly the app's
own output. That also means it catches everything, including libraries and
anything calling `android.util.Log` directly — which a Timber-style tree would
never see.

Two details that took running it to get right:

**Stack traces are one entry, not thirty.** `Log.e(tag, msg, throwable)` does
not produce a single entry with newlines in it; every frame comes back as its
own fully-formed log line. Left alone, one error becomes thirty rows and the
message explaining it scrolls off the top. Consecutive lines from the same
tag, level and thread, within 150ms, that look like stack frames get glued back
onto the line they belong to.

**Entries share the timeline's clock.** logcat reports wall time and the
timeline runs on uptime, so entries are converted with an offset taken at start
and carry their original stamp as well. That is what lets a log line be placed
against a recomposition burst or an open HTTP call, and what makes clicking a
row in the log pane move the timeline to it.

The timeline also carries a `warnings` lane: ticks for W and worse only, since a
tick per debug line would be a solid bar and say nothing, while a cluster of red
next to a recomposition burst says a great deal.

## Security

The socket binds to `127.0.0.1` and nothing else. Reaching it from off-device
requires `adb forward`, which requires USB debugging authorisation. On top of
that, the whole runtime is debug-only: release builds link the no-op artifact,
which contains no socket, no collectors and no reflection.

Log capture is the one collector that will happily forward whatever the app
prints, including anything a developer logged that they should not have. It is
debug-only and loopback-only like everything else, and the porthole's own tag is
excluded so a failing socket write cannot log its way into a loop.

URLs and SQL are collapsed, query-string values and sensitive headers are
replaced with `*`, and request and response bodies are not captured at all
unless you ask for them — all before anything leaves the process. A trace you
paste into a chat does not carry an auth token with it.

The database inspector reads and does not write, and that is enforced on the
device rather than assumed from the socket being loopback. One statement, and it
has to be a SELECT, a WITH, or a PRAGMA with no assignment in it — `PRAGMA
user_version = 5` writes, and no transaction would undo it, so the assignment
form is refused outright rather than wrapped and hoped about.

The one thing that reaches back out to the device is **restart app**, which
shells out to `adb` to force-stop and relaunch. It asks first, because it throws
away whatever the app was in the middle of.

In a release build none of this code exists to be misconfigured: no interceptor
is added, no open helper is wrapped, so no body is read and no bind value is
recorded.

## Publishing

0.2.0 is the current release (see [CHANGELOG.md](CHANGELOG.md)); 0.1.0 is
live on Maven Central and npm, and its Gradle Plugin Portal submission was
pending review at last check. Publishing itself is still a deliberate,
credentialed act that this repo never performs on its own — but the bump,
changelog, full-suite run and tag that used to precede it by hand are now one
command, and the rehearsal that used to mean actually publishing something is
another:

```bash
./gradlew release "-Pversion=0.2.0"   # bump, changelog, full suite, commit, tag
./gradlew releaseDryRun               # rehearse all of it with no credentials
```

Quote the whole `-Pversion=...` assignment, including on Windows. Unquoted,
Windows PowerShell 5.1 — this project's primary shell — mangles a dotted
value before Gradle ever sees it: `gradlew release -Pversion=0.2.0` arrives
as the two arguments `-Pversion=0` and `.2.0`, and the command fails with
`Task '.2.0' not found in root project 'porthole'`. It fails safe — never
with a wrong version — but it is the first thing a Windows user hits, and
quoting the assignment avoids it entirely. `$env:PORTHOLE_RELEASE_VERSION`
(or `PORTHOLE_RELEASE_VERSION=0.2.0` in bash) is a second way to pass the
version, for anyone who would rather not depend on quoting correctly on
every shell this ever runs on:

```powershell
$env:PORTHOLE_RELEASE_VERSION = "0.2.0"
.\gradlew.bat release
```

`release` refuses on a dirty tree, on any branch but `main`, on a version
that does not match `X.Y.Z` or `X.Y.Z-suffix`, on a `-SNAPSHOT` version, and
on an empty `## [Unreleased]` section in [`CHANGELOG.md`](CHANGELOG.md) —
each with a one-line reason, checked before anything is written to disk. If
a later step fails anyway — `check`, a build, one of the npm suites, or the
commit itself — `gradle/libs.versions.toml`, `mcp/package.json` and (once
cut) `CHANGELOG.md` are rolled back to what they were, so a failed attempt
never leaves a dirty tree blocking the next one. Given a version, it:

1. writes `porthole` under `[versions]` in `gradle/libs.versions.toml`, the
   only place the version is authored, then regenerates `mcp/package.json`'s
   `version` field from it. `VersionConsistencyTest` still fails the build if
   the two disagree — the generator is what keeps that check green, not
   something you now fix by hand when it goes red.
2. runs the full check, both Android builds, and both npm test suites.
3. cuts CHANGELOG.md's Unreleased section into a dated `## [X.Y.Z]` section.
4. commits and tags `vX.Y.Z` (annotated).
5. prints the four publish commands below, in order, and runs none of them.

`releaseDryRun` rehearses the parts of a release that used to be caught only
by actually publishing something, using no credentials at all: `npm pack
--dry-run` diffed against the committed `mcp/expected-package-files.txt`;
`publishToMavenLocal -PRELEASE_SIGNING_ENABLED=false` for the two runtime
AARs, `-p gradle-plugin publishToMavenLocal` for the plugin itself — a
separate included build the root `publishToMavenLocal` never reaches — then
actually resolving, not just reporting on, the plugin marker plus both the
debug and release runtime classpaths in a separate scratch project, no
`includeBuild`, the consumer path a real app takes. That project's
repositories admit the `live.gravitylabs.porthole` group only from that
`mavenLocal()`, so the step fails loudly and non-zero the moment the marker,
`runtime`, or `runtime-noop` is missing, and can't be rescued by a remote
even after the Plugin Portal accepts the plugin. Then `validatePlugins`,
checking the plugin's own structure with no network call. Deliberately not
`publishPlugins --validate-only`: measured against the real Gradle Plugin
Portal, that flag still authenticates and POSTs the plugin bundle — it only
avoided actually publishing 0.1.0 a second time because the Portal rejected
it as already existing, and pointed at a version that had never been
published, the same call would have published it. If the plugin ever pointed
a consumer at a runtime version nobody actually published, the mavenLocal()
resolution above is where that shows up — not in someone else's build.

The publish order itself is not arbitrary. `portholeUi` launches the timeline
with `npx --package @gravitylabsllc/porthole@<version>`, and the plugin
points at the AAR coordinates, so each step wants the one before it to
already exist:

```bash
cd mcp && npm publish                              # @gravitylabsllc/porthole
./gradlew publishToMavenCentral                    # the two AARs, staged
./gradlew -p gradle-plugin publishPlugins          # the Gradle Plugin Portal
npx vercel deploy --prod                           # the landing page and API docs
```

Credentials live in `~/.gradle/gradle.properties` or the environment, never
here:

```properties
mavenCentralUsername=...
mavenCentralPassword=...
signingInMemoryKey=...
signingInMemoryKeyPassword=...
gradle.publish.key=...
gradle.publish.secret=...
```

The last of those is normally unnecessary: the Vercel project is linked to
this GitHub repository, so every push to `main` already deploys `site/` to
production. Run it only when a deploy has to happen without a push, and
note that it uploads only what `.vercelignore` allows through (`site/` and
`vercel.json`), because nothing is built on Vercel.

`publishToMavenCentral` stages without releasing, and
`SONATYPE_AUTOMATIC_RELEASE=false` keeps it that way: the staged bundle is
promoted by hand after you have looked at it. `RELEASE_SIGNING_ENABLED=true`
means an unsigned release fails outright rather than quietly uploading
something Central would reject; `releaseDryRun`'s
`-PRELEASE_SIGNING_ENABLED=false` is what lets it publish to `mavenLocal()`
without a signing key, since signing is otherwise required for anything that
is not a snapshot.

## Working on the UI

The timeline is a Vite app in `mcp/ui`, built into `mcp/ui/dist` and served by
the timeline server. It is a workspace of the `mcp` package, so one install
covers both.

```bash
cd mcp && npm install
npm run build          # ui then server
npm run lint           # eslint
npm run format         # prettier
```

For live work, run the timeline server and Vite side by side:

```bash
npm run ui             # timeline server on 8678, talking to the device
npm run dev:ui         # vite on 5273, proxying /ws and /api to 8678
```

Then open the Vite port. You get hot reload against a real device: the server
still owns the socket to the app, and Vite proxies the stream through.

A note on the shape of it, since it is not the obvious React layout. The event
array does not live in React state. A busy screen emits well over sixty events a
second, and putting that in `useState` would re-render the tree on every one of
them for a canvas that only needs the array. So `TimelineStore` holds it,
notifies subscribers at most once per animation frame, and the canvas reads it
directly in a draw loop driven by a dirty flag. Components that genuinely render
from the data — the log pane, the connection pill — subscribe through
`useSyncExternalStore` and wake up at most once a frame.

The palette is declared once, in `index.css`, as Tailwind `@theme` tokens
aliased to short custom properties. The canvas reads those back with
`getComputedStyle`, so the lanes and the chrome cannot drift apart.

## The landing page

`site/index.html` is the whole site: one file, no build step, no JavaScript. It
is deliberately script-free — every part of it is markup, so it renders the same
from a `file://` path, a sanitising preview or a strict CSP as it does from a
host. The `vercel.json` at the repo root encodes that as a rule rather than a
habit: the policy it sends has no `script-src`, and `default-src 'none'`, so a
script added to the page later will be blocked rather than quietly shipped.

Deploying it takes no dashboard configuration. Import the repository, leave the
root directory alone, and `vercel.json` does the rest — no install step, no
build step, `site/` as the output.

```bash
npx vercel deploy --prod     # or import the repo at vercel.com/new
```

It serves two things. `/` is the landing page. `/api` is the API reference,
committed under `site/api` because the host cannot build it: Dokka needs AGP,
AGP needs the Android SDK, and this site has no build step at all. Regenerate
it with `./gradlew :runtime:apiDocs`, which syncs — a declaration that goes away
leaves the site too.

They get different content security policies, which is why `vercel.json` scopes
the strict one to `/` rather than to everything: the landing page runs no script
and the policy says so, while the reference is a Dokka app that needs its own.
The reference's rule is `/api/:path*` rather than `/api/(.*)`, which misses the
directory itself and left `/api` with no policy at all.

`cleanUrls` is deliberately off. It strips `.html` and redirects, and the
reference is fifty-eight pages that link to each other by `.html` — every
navigation was paying for a 308.

Both of those were only visible once deployed. Locally the headers looked
right, because a local check answers what a rule matches, not what the site
does with a URL before the rule is reached.

The canonical host is `https://porthole.gravitylabs.live`, which `og:url`,
`og:image` and the canonical link all name absolutely — most card scrapers
resolve relative ones, Facebook's does not.

## Brand

| asset | use |
| --- | --- |
| [`brand/mark.svg`](brand/mark.svg) | the mark alone, for dark grounds |
| [`brand/mark-light.svg`](brand/mark-light.svg) | the same, for light grounds |
| [`brand/lockup-dark.svg`](brand/lockup-dark.svg) | mark and wordmark together |
| [`brand/lockup-light.svg`](brand/lockup-light.svg) | the same, for light grounds |
| [`brand/icon.svg`](brand/icon.svg) | square, for favicons and avatars |
| [`brand/banner.svg`](brand/banner.svg) | the repository header |
| [`brand/og.html`](brand/og.html) | source for the social card |

A ring and an aperture: a porthole, and the lens of the thing looking through
it. Teal `#5ec8b0` on dark, `#127a66` on light, and the mark stays one colour —
in the timeline header it never turns red on disconnect, because the status pill
beside it already says that, and saying it twice makes the logo mean less.

The nine lane colours in the banner are not decoration. They are the timeline's
own legend, read from `mcp/ui/src/timeline/lanes.ts` — which is why there are
nine chips for eleven lanes: main thread shares its colour with dropped frames,
and warnings with db.

`brand/banner.png` and `site/og.png` are rendered from those sources and
committed, because they change only when the brand does:

```bash
node brand/render.mjs
```

It drives headless Chrome rather than a rasteriser library, for one reason:
Chrome fetches the webfont. Anything else renders PORTHOLE in whatever sans the
machine happens to have — and so does GitHub, which serves README images through
a proxy that will not load Google Fonts. That is why the header above points at
the PNG and not at the SVG.

## API documentation

The published surface is 53 declarations — 8 classes and objects (`Porthole`,
`PortholeInitializer`, `BodyCapture` and its `Companion`, `KtorPorthole`,
`OkHttpPorthole`, `RoomPorthole`, `SqlitePorthole`) and 45 members and
top-level functions between them — counted from `site/api`'s own pages (58
total, minus the module root, the navigation sidebar and the three
package-overview pages, which describe the surface but are not part of it).
Dokka renders them:

```bash
./gradlew :runtime:apiDocs     # into site/api, where the site serves it
```

Published three ways from the one source: as `site/api` on the site, as the
`-javadoc` jar on Maven Central, and as `runtime/build/dokka/html` for a local
look.

`reportUndocumented` is on, so a public declaration without KDoc is a build
warning. On a surface this size that is a reasonable bar to hold, and it is
currently at zero.

Dokka rather than the Javadoc tool, because most of this API is extension
functions and the Javadoc tool does not speak Kotlin. It rendered
`OkHttpClient.Builder.installPorthole` as a static method on a synthetic
`OkHttpKt` class, and dropped `portholeKtor()` and `portholeSqliteFactory()`
altogether, their receivers coming from `compileOnly` dependencies. The javadoc
jar bound for Maven Central therefore documented neither of the two functions a
consumer is most likely to be looking for. It carries Dokka's HTML now.

## Building

```bash
./gradlew test                           # runtime, no-op and the Gradle plugin
./gradlew check                          # the same, plus Android lint
./gradlew build                          # check, and the artifacts — Android modules only
./gradlew :runtime:testDebugUnitTest     # runtime
./gradlew :runtime-noop:testDebugUnitTest  # api parity with the runtime
./gradlew -p gradle-plugin test          # plugin alone, ProjectBuilder and TestKit
cd mcp && npm install && npm run build   # ui and server
cd mcp/ui && npm test                    # timeline logic
```

The plugin is a separate Gradle build, pulled in by `includeBuild` from the
`pluginManagement` block in `settings.gradle.kts`. An included build's lifecycle
tasks are not reachable from the including build's, so the root `test` and
`check` name the plugin's explicitly; without that they walk the three Android
modules and stop, which is what they used to do. `build` is the exception — it
still covers the Android modules only, so `check` is the command that verifies
everything the JVM side can. Two of the plugin's tests, the AGP pair, skip unless
you pass `-Pporthole.agpVersion`; they publish to `~/.m2` and need the network,
which is why they are opt-in.

The runtime tests run the request-body tee against a real client and a real
socket via MockWebServer. The property they exist to hold down is the boring
one: the server must receive exactly what it would have received with the
porthole absent. The rest cover the arithmetic that has been wrong before —
counting a long freeze in refreshes, and ordering a stalled thread's stack so
the app's own frames lead.

The MCP server can be exercised without a device. `mcp/tools/mock-device.mjs`
speaks the same wire protocol and emits synthetic recomposition bursts, state
writes, navigation and network traffic:

```bash
cd mcp
npm run mock          # in one shell
npm start             # in another, then call open_timeline
```

That is how the tools and the timeline UI were verified.

## CI

`.github/workflows/pr.yml` runs on every pull request and on every push to
`main`. It is meant to end up required to merge — both jobs are intended as
required status checks on `main` — but requiring a check is a
branch-protection setting on the repository itself, not something a workflow
file can grant, and nobody has switched it on yet — the workflow itself has
had well over a hundred runs by now. Two jobs, meant to both be required:

- **Gradle checks** (ubuntu) — `./gradlew check`, which since GRA-75 reaches
  the plugin's tests too (see [Building](#building) above). Test reports
  upload as an artifact when the job fails.
- **Node** — a matrix of ubuntu, windows and macos, because the MCP server
  and CLI are Node and the platform bugs live there, not in the Kotlin. Each
  leg runs `npm ci`, `npm run build`, `npm test`, `npm run test:ui`, `npm run
  lint`, and a check that `npm pack --dry-run` still produces exactly the
  files listed in `mcp/expected-package-files.txt` — a fixture that exists
  because 0.1.0 shipped once with a missing README and dangling source maps,
  and nothing in the process was watching for that.

`npm test` at the mcp root does not run `mcp/ui`'s tests — its script never
calls the `ui` workspace's `test` — so CI calls `npm test` and `npm run
test:ui` as two separate steps rather than relying on one script to cover
both. The preferred fix is making `npm test` itself run both suites; that is
a change to `mcp/package.json`, which is out of this workflow's scope, and is
left as a follow-up.

Both jobs finish with `git diff --exit-code`, so a build step that
regenerates a file this repo commits (`site/api`, if `apiDocs` ever gets
wired into `check`) fails the PR instead of drifting in silently.

No job in this workflow ever runs a publish task, and the only secret it
references is the coverage token described below — the emulator, the AGP
compatibility matrix and anything nightly are separate, slower checks that
live outside this workflow entirely.

**Coverage.** Both jobs also upload coverage to Codecov: the Gradle job
uploads JaCoCo XML for `gradle-plugin` and `runtime` under the `jvm` flag
(`runtime-noop` has no tests worth measuring and is excluded); the Node job
uploads each vitest suite's own `lcov` report under `server` and `ui`, from
the same `--coverage` run that already produces the JUnit XML the checks
above read, on every leg. Reports upload with `if: always()`, so a red suite
still shows whatever coverage it produced. Both the project and patch status
checks are `informational: true` in `codecov.yml` — they appear on every PR
but cannot fail one, until the founder turns that off deliberately — and
`fail_ci_if_error: false` on every upload means a Codecov outage degrades
reporting, never the PR itself. The upload reads `secrets.CODECOV_TOKEN` by
name only; the repo is public, so Codecov's tokenless upload is the fallback
for as long as a maintainer has not created that secret in the repository's
own settings, which is the only place its value ever exists.

**The exec-bit rule.** A `*.sh` or `gradlew` committed from a Windows checkout
arrives in the index as mode `100644` — Windows has no such bit to record —
and a Linux runner honours the bit it does have. The first run on `origin`
died at the very first step, `./gradlew: Permission denied`, and
`tools/avd/create.sh` had the identical fault waiting behind it. The fix is
`git update-index --chmod=+x <path>`, applied directly to the index since a
Windows working tree cannot express the bit for a normal `git add` to pick
up; `git ls-files -s <path>` reading `100755` (not `100644`) is how to check
it stuck. Any script this repo adds for a Linux or macOS runner — or for a
contributor on either — needs this checked once at commit time, because nothing
short of running it there will surface the omission before CI does.

**The stopwatch-test lesson.** A test that asserts a fold finishes inside some
fixed number of milliseconds is a bet on the runner's speed, not on the code:
one such test passed at ~5ms locally and took 14.6ms on a GitHub runner,
failing a green PR on a machine-speed difference rather than a regression.
What the test actually needed to guard was that parents resolve through an
index rather than a scan — so it now times a scan of the same data in the
same process and asserts the indexed fold comes in under half of that,
warming the indexed run once first so the JIT's first-call cost doesn't land
on the measurement. The scan is a fixed multiple slower on every machine
tried, which is the property that matters; an absolute millisecond bar is
either flaky on the slow machine or meaningless on the fast one. Any new
timing assertion in this codebase should measure against a same-process
baseline, never a wall-clock constant.

## Emulator

A captured session is only reproducible against a known device, which
`porthole compare` already half-admits: it refuses to diff two traces whose
refresh rate, core count or RAM class differ (`mcp/src/report.ts`,
`comparability()`), rather than print a number that looks meaningful and
isn't. `tools/avd/` turns "the same device" into a file in the repo instead
of something remembered: a pinned system image and a pinned `config.ini`,
created by `tools/avd/create.sh` (macOS/Linux/Git Bash) or
`tools/avd/create.ps1` (Windows), both reading the one parameter file,
`tools/avd/avd-spec.json`. It is also the thing a nightly CI emulator job
needs simply to have a device at all — see **CI** below.

```bash
bash tools/avd/create.sh          # macOS / Linux / Git Bash
powershell -File tools\avd\create.ps1   # Windows
```

Both are idempotent: re-running against an AVD that already exists does not
recreate it, but does re-apply every pinned `config.ini` key, so an AVD from
an older run of the script converges to the current spec instead of quietly
keeping stale settings.

**The pin is a build, not an API level.** `system-images;android-35;google_atd;x86_64`
names a package, and Google has republished packages under an unchanged name
before with different bits behind them — pinning the API level alone
reintroduces the exact drift this exists to remove. `avd-spec.json` also
records the image's own `ro.build.id` and `ro.build.version.incremental`,
read out of its `build.prop`, and both scripts fail (not just warn) if what
actually installed doesn't match — a pinned AVD running on the wrong build
would produce measurements nobody could trust, so this is the one check
that has to stop the run rather than continue past it. The chosen image is
`google_atd` (Google's
automated-test device tag) rather than the default `google_apis`: it boots
faster and carries less that can vary run to run. RAM, core count, GPU mode
(`swiftshader_indirect`), LCD density and refresh rate are pinned in
`config.ini` too, since a default that varies by SDK version is the same
drift one level down, and snapshots are off so every boot runs the same cold
path rather than resuming whatever state a snapshot happened to freeze.

**An emulator is not a device, and its numbers are not a device's.**
Software-rendered GPU, a virtualised CPU and a host doing other things at
the same time produce frame times, query latencies and GC pauses that do not
resemble a Pixel's. That is a category error, not a footnote: a baseline
taken on this AVD and compared against a run on a physical phone would
produce a number that looks like a regression or an improvement and is
neither, and `porthole compare`'s device-mismatch refusal exists precisely
to catch the mechanical cases of this (different `refreshHz`, different
`cores`) even though it cannot catch "emulator vs. real silicon" as a
category by itself. The value this AVD provides is comparing an emulator run
against an earlier emulator run — the shape of the findings, and whether a
change moved them — never absolute numbers against a physical baseline.

**Measured run-to-run tolerance.** Four consecutive `porthole capture` runs
of the same nine-second scripted scenario (cold-start the sample app, follow
its `porthole://cart/99001` deep link) on one instance of this AVD produced,
for the metrics that actually moved:

| metric | across 4 runs | largest pairwise swing (consecutive) |
| --- | --- | --- |
| `mainThread.blockedMs` | 769–1358 | +60% (850→1358) |
| `mainThread.worstMs` | 453–649 | +43% (453→649) |

`porthole compare`'s default noise floor (10% relative *and* 3ms absolute,
`mcp/src/report.ts`) is not wide enough to absorb this: all three of the
consecutive pairs the four runs form would have printed a REGRESSED or
improved line against each other despite nothing in the app changing. `http.calls` and
`http.p95Ms` also swung between 0 and 2 calls across otherwise-identical
runs — a nine-second capture is short enough that whether the deep-linked
screen's network fetch starts (let alone finishes) inside the recording
window is itself timing-sensitive, which is a property of the scenario's
length more than of the device.

Take this as a measured lower bound on the noise, not a validated gate
threshold: it is four runs of one short scenario on one AVD instance. What
it does establish is the shape of the problem — before wiring `porthole
compare --fail-on regression` into a nightly job, either the tolerance for
main-thread timing metrics needs to be widened well past the current 10%
default, or the comparison scenario needs to run long enough (and be
internally deterministic enough) that async work reliably lands inside the
window every time. Re-measuring with more runs and a longer scenario is
follow-up work, not something this ticket's four-sample read should be
trusted to settle on its own.

**CI.** `avd-spec.json`'s `ci` block is written for the nightly emulator job
(GRA-101, which owns `.github/workflows/*`) to consume:
`reactivecircus/android-emulator-runner`'s inputs come straight from
`ci.inputs`, and `ci.postBootVerification` names the `getprop` check a
post-boot step should run, because the action takes `api-level`/`target`/
`arch` rather than a package id and so cannot pin the exact build the way
`create.sh`/`create.ps1` do — asserting the installed build's
`ro.build.version.incremental` after boot is what turns an otherwise
unpinnable input into a detected pin. `ci.inputs` carries every field that
defines this AVD's identity, not just the ones the action happens to have
native slots for: `cores` and `profile` are the action's own inputs;
`refreshRateHz`'s pin rides along inside `emulator-options` as a real
`-vsync-rate 60` emulator flag; and `lcdDensity` has no action input or CLI
flag at all, so it is still recorded in `ci.inputs` (for a cache key built
from this block to reflect the whole AVD rather than part of it) with a
note for GRA-101 to apply it post-boot via `adb shell wm density 420`, the
same pattern the build-id check already uses.

## Wire protocol

Newline-delimited JSON over TCP, one object per line, both directions.

```jsonc
// request
{"id": 1, "method": "recompositions", "params": {"screen": "Cart"}}
// response
{"id": 1, "ok": true, "result": { }}
// event, unsolicited
{"event": "recompose", "t": 24831, "seq": 4102, "data": { }}
```

`t` is `SystemClock.uptimeMillis()`. Events are also kept in a ring buffer on
the device, so a client that attaches late can backfill with `timeline`.

## Cost

The porthole is not free, and the places it costs something are the places it
touches the main thread.

Event fan-out does not happen on the emitting thread. `broadcast` puts the frame
on a bounded queue and returns; a writer thread encodes and sends. This matters
more than it sounds: the first version encoded and wrote inline, and a screen
recomposing sixty times a second filled the socket buffer, stalled the UI thread
and then dropped the client, which the reconnect loop turned into a flood. When
the queue is full, events are dropped and a `dropped` frame reports how many. A
gap you can see beats a stall you cannot.

Attribution walks the write log backwards from the newest entry and stops at the
window edge, rather than scanning it, because it runs once per instrumented
recomposition on the composition thread.

What remains on the main thread per instrumented recomposition: a timestamp, a
short backwards walk over the last ~32ms of writes, an object into a ring, and a
queue offer.

## License

Apache License 2.0. See [LICENSE](LICENSE).

Apache rather than MIT for the reason it usually is: it carries an explicit
patent grant, which is what a company's legal review looks for before allowing
a library into a build. It is also what the rest of this stack is under —
AndroidX, Kotlin, OkHttp, Gradle — so it raises no question a reviewer has to
take anywhere.

Copyright 2026 Gravity Labs.

## Status

Version 0.2.0 (see [CHANGELOG.md](CHANGELOG.md)); 0.1.0 is live on Maven
Central and npm, and its Gradle Plugin Portal submission was pending review
at last check (see [Publishing](#publishing)).
Verified end to end on an emulator against
`sample/`: the plugin puts `:runtime` on debug and `:runtime-noop` on release,
the porthole installs itself on process start, and every tool returns real data
— including request and response bodies captured from a one-shot streaming
upload, and a `state` dump reflected out of a live `ViewModel` that nothing
registered.

**On a physical device.** One broad pass, 2026-09-15, on a **Pixel 9 Pro Fold**
(`google/comet_beta/comet:17/CP31.260623.012/16064790:user/release-keys`,
Android 17 / API 37, 120 Hz). The full record, including what was wrong and
what was never reached, is in [docs/verified.md](docs/verified.md). Observed
there, on hardware: every collector returning numbers that hold up to
inspection (35 HTTP calls of which the 4 deliberate `POST /v1/checkout → 402`
failures, 28 queries with none on the main thread, 7 WorkManager runs with 4
retries); `system_context` parsing that device's twelve thermal sensors and
per-core cpufreq; a real navigation back stack with its arguments resolved;
cold start at 451 ms; **an ANR declared by the system**, after which
`porthole_status` named `REASON_ANR` and pointed at
`CartViewModel.blockTheMainThread(CartViewModel.kt:148)` — the method that was
actually blocking — and returned the full 136 KB trace on request; and the
`since your last call` banner surfacing an 8917 ms main-thread block on an
unrelated tool's next call, against a 9000 ms block. Sessions persisted to
`.porthole/sessions/` and `porthole report` rendered a saved moment.

**What that pass found wrong.** `findings` takes the frame budget from a
`device` profile event the runtime emits once at startup, and falls back to
60 Hz whenever the requested window does not contain it — so the same phone
reported `budget 8.3ms at 120Hz` for one window and `budget 16.7ms at 60Hz` for
another, minutes apart, and `porthole report` headed the saved file
`Google Pixel 9 Pro Fold (60Hz)`. The missed-frame counts are right; the budget
printed beside them is not. Separately, two Perfetto captures on that device
carried **no** Porthole atrace labels at all, where a capture on a Pixel 10 Pro
XL the day before carried them. Both are filed; neither is fixed.

**Not verified on any device:** a blocking GC (no stop-the-world collection
could be induced — the sample's heap peaks at 24 MB of 256 MB and it has no
allocation-storm affordance); thermal throttling (not attempted — it is the
founder's daily phone); Navigation 3's back stack (the sample uses Navigation
2, and `PortholeBackStack` has no caller outside the runtime); a low-memory
kill; deep-sleep clock divergence; the timeline UI against device data; a
second device end to end; a cheap or old device; multi-process apps; and
Compose versions other than the one in the version catalog.

Redaction was checked the only way worth checking it: the sample sends a bearer
token, a query-string token and a `Set-Cookie`, all containing the string
`do-not-log`. Across a megabyte of everything the porthole emitted on the
emulator, and across both session trees, both `.pftrace` captures, the saved
moment, the rendered report, the captured logcat and every saved tool output on
the Pixel 9 Pro Fold, it appears zero times. The device serial appears zero
times too.

**1521 tests, measured on ubuntu-latest CI** (a total holds on every leg; a
pass/skip split holds on exactly one, so the leg is named — see
[Testing](#testing)): 455 on the JVM (`./gradlew test`, which covers both
build types of `runtime` and `runtime-noop` plus the Gradle plugin — 447
passed, 0 failed, 8 skipped), 772 in the MCP server (`cd mcp && npm test` —
769 passed, 0 failed, 3 skipped), and 294 in the timeline UI (`cd mcp && npm
run test:ui`, a separate suite from the server's — 294 passed, 0 failed, 0
skipped). **What is checked, precisely:** `tools/check-readme-test-counts.py`
fails CI when the JVM sentence's four numbers disagree with its own JUnit
XML, and when 1521 disagrees with the sum of the three suites' totals stated
here; `mcp/scripts/check-readme-vitest-counts.mjs` does the same for the
server and UI sentences against their own JUnit XML. Everything else in this
paragraph and the next — the skip explanations, the per-platform comparison
— is prose, not machine-checked. GRA-164 exists because these four numbers
went wrong by hand three times in one day before the checks existed. The
runtime's arithmetic is covered where it has been wrong before — a long freeze
counted in refreshes rather than in relaxed deadlines, and a stalled thread's
stack ordered so the app's own frames lead. A parity test compares the public
surface of `runtime` and `runtime-noop`, because a missing no-op breaks the
release build of whoever cuts the release rather than whoever added the
integration.

The JVM's 8 skips on ubuntu are four Windows-shaped `McpConfigTest` cases
(drive-relative, POSIX-shaped-on-Windows, the committed capture's
resolution, UNC), the machine-local `local.properties` cross-check, and the
three-test AGP compatibility set, which needs an SDK and the network and
skips cleanly without a version to check — none of the eight is a gap in
what the suite proves, each is a test that only makes sense on a platform
this runner is not. GRA-197's two `applicationId`-defaulting tests (a real
Android application module, proving AGP's own `defaultConfig.applicationId`
reaches `PortholeExtension`) are not among the eight: unlike the AGP
compatibility set, they need only an SDK, not `-Pporthole.agpVersion`, so
`ubuntu-latest`'s preinstalled `ANDROID_HOME` runs them for real on every PR
— a checkout with no SDK at all (no `ANDROID_HOME`, no `local.properties`
next to the plugin) is the only place they skip. GRA-197 also adds 12 server
tests (the `packageMismatch` rig, its "leads an unrelated tool's banner"
proof, and the `TimelineServer` WebSocket tests proving it actually reaches
a connecting client, since the UI cannot derive it locally the way it does
`protocolMismatch`) and 18 UI tests (the header pill's danger tone, the
header's per-state neighbour text, and `TimelineStore`'s new wire field) —
none of them platform-gated, so they add to every leg's passed count and
change no leg's skip count. The server's 3 skips on
ubuntu are `perfetto-stdout` and GRA-113's real-coverage check
(both gated on a cached `trace_processor` capture no CI runner has — gitignored
and per-checkout) and the one Windows-only case GRA-160 added. **The total is the same
everywhere; the split is not**: the primary Windows checkout runs
the same 455 JVM tests with only 4 skipped (the POSIX-path case plus the AGP
set — the same SDK that keeps it at 4 also runs GRA-197's two tests for
real) and the same 772 server tests with 0 skipped, because it has the
cached `trace_processor` capture the ubuntu leg lacks; a worktree checkout
sees 772/770/2, missing only that capture. The timeline UI is the one suite
whose split does not move: 294/294/0 on every leg.

**Verified on the emulator:** Room, SQLDelight, OkHttp, Ktor on CIO, WorkManager
with retries, frames, main-thread stalls, memory and GC, device context,
the database inspector, restart, automatic view model naming, a captured
system trace holding the runtime's own atrace spans, and the fixed
system-trace questions interpreted from trace_processor's real output
against it.

**Not verified on the emulator:** `PortholeBackStack` for Navigation 3. The
sample is on Navigation 2, and adding an alpha dependency to prove a six-line
wrapper was a poor trade; the function it calls is unit tested. Blocking GC is
also written but never observed — the emulator did not produce one.

**Verified on a physical device:** wave 2's integration QA ran end to end on a
real Pixel 10 Pro XL, fingerprint
`google/mustang_beta/mustang:17/CP41.260814.003.B1/16166531:user/release-keys`
(Android 17, API 37), and passed. A separate hardware run on that same device
and fingerprint checked the trace half directly: `perfetto --app
com.example.shop` is accepted and honoured — a real capture carried `porthole:
http`, `recompose` and `screen` slices with real durations, and it still
worked when the app process predated the tracing session. All five curated
`ask_system_trace` questions answered on the first try, returning six
differentiated findings and none empty, including 31ms of main-thread
runnable-but-not-scheduled that Porthole's own collectors cannot see. The
trace's own `App Deadline Missed` (119.47ms) matched the frame Porthole
independently reported at `totalMs: 125`. An earlier report of this device
refusing `--app` (`portholeLabels: 0`, `ATRACE_TAG_APP` reading clear) does
not hold up: it was read off `debug.atrace.tags.enableflags`, which is a
device-wide tag mask that cannot show a tag enabled for one package — it
reads "off" on a setup that is working correctly, which is exactly what
happened. The only check that actually answers the question is the trace
itself. Read this as neither "works on Android 17" as a platform claim nor a
closed question generally; it is one behaviour, confirmed on one device and
one fingerprint.

**Not done:** multi-process apps, and Compose versions other than the one in
the version catalog. A second physical device is still wanted — not to
settle the `--app` question above, which is now answered, but because GRA-67
wants everything in 0.1.0 proved on two physical devices and GRA-111 wants
real artifacts with provenance from more than one.

**And the `--app` question is now less settled than this paragraph says.** On
2026-09-15 the same mechanism produced **zero** Porthole labels on a Pixel 9
Pro Fold, across two ten-second captures — one with the package defaulted, one
with it named explicitly — while the app was running with the runtime attached
and being driven. That was checked against the trace itself, not against the
tag mask: the only `porthole` strings in either capture are the runtime's own
thread names, with no `porthole: ` section names anywhere. So the honest
statement is that the mechanism worked on one device and one fingerprint and
did not work on another; see [docs/verified.md](docs/verified.md).

**Resolved the same evening (GRA-186).** The Fold's build reads the app
trace tag only when a process starts, so a process that was already running
when the capture began never annotates it; classic `atrace` behaves the same
there, and the Pixel 10 Pro XL's build picks the tag up live. `capture_system_trace
{ restartApp: true }` force-stops and relaunches the app once the on-device
trace file exists: four Porthole labels on the Fold with it, zero without,
checked in the trace itself. Without the option, a zero-label capture now
says which of the two causes it cannot tell apart.
