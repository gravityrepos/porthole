<p align="center">
  <img src="brand/banner.png" alt="Porthole — a debug-only window into a running Android app" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-5ec8b0?style=flat-square"></a>
  <img alt="Android API 26 and up" src="https://img.shields.io/badge/android-API%2026%2B-56c88c?style=flat-square">
  <img alt="Debug builds only" src="https://img.shields.io/badge/builds-debug%20only-f0883e?style=flat-square">
  <img alt="Version 0.1.0, unpublished" src="https://img.shields.io/badge/version-0.1.0%20unpublished-9aa6b8?style=flat-square">
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
| `recompositions` | which composables recomposed, how often, and which state keys were written just before |
| `semantics_tree` | the semantics tree with an id that stays stable across captures |
| `nav_state` | back stack, arguments on each entry, and the deep link that got you here |
| `state` | current values of your ViewModel state, named automatically, and whether writes to it are attributable |
| `inflight` | open HTTP calls with the phase each is stuck in, running queries, WorkManager jobs |
| `frames` | dropped frames, and which phase of the frame ate the time |
| `blocking` | what held the main thread, with the stack it was stuck in |
| `logs` | the app's own logcat output, stack traces intact, without touching adb |
| `timeline` | the raw event stream, for ordering things relative to each other |
| `open_timeline` | a live timeline UI in the browser |
| `porthole_status` | whether any of the above can currently reach the device |

Everything is debug-only. Release builds link a no-op artifact with identical
signatures, so the calls stay in your code and compile to nothing.

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

**2. Run the app.**

That is the whole minimum. The runtime starts with the process through
androidx.startup and finds the current Activity on its own, which gives it the
view it needs for the semantics tree and the view models scoped to that
Activity. There is nothing to wrap and no launch flag to remember.

Screen-scoped view models need step 3.

```bash
./gradlew :app:installDebug        # your app
./gradlew portholeUi
```

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

**6. Open the timeline.**

```bash
./gradlew portholeUi
```

That forwards the port, serves the UI, opens your browser and keeps running
until you stop it. It is the whole workflow for a person: build, run, look.

If you would rather not go through Gradle, or you do not have the plugin
applied, the CLI is the same thing:

```bash
npx @gravitylabs/porthole ui
```

Both need Node, because the UI is a web app. If you only want the adb bridge —
because your agent is doing the looking — `./gradlew portholeConnect` sets it up
and nothing else.

**7. Point your agent at it.** `./gradlew portholeMcpConfig` prints the entry:

```json
{
  "mcpServers": {
    "porthole": {
      "command": "npx",
      "args": ["-y", "@gravitylabs/porthole"],
      "env": { "PORTHOLE_PORT": "8677" }
    }
  }
}
```

The MCP server and the UI are independent. Run either, or both at once — they
each open their own connection to the device.

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

Lanes, sharing one clock: recompositions and state writes, dropped frames and
main-thread stalls, navigation, http, db, work, memory, device context, and your
own logcat at warning and above.

A few of them are worth knowing about because the number means something
specific. Dropped frames are counted in refreshes, so a 400ms freeze is not "one
missed frame". Work gets one bar per attempt, so a retry is visible rather than
averaged into a single long one. The main thread lane carries both stalls and
the queries that ran on it.

Clicking any mark opens it: the subject first, then its attributes, then whatever
bulk it carries. `ask agent` copies the window as bounds.

The header also has **database**, a read-only inspector over the app's own
tables — list, page, and run a SELECT — and **restart app**, which force-stops
and relaunches over adb.

The inspector reads through an undecorated handle, so looking at a table does
not emit query events for the act of looking. It refuses anything that is not a
single SELECT, WITH, or a PRAGMA with no assignment in it. That is enforced on
the device rather than assumed from the socket being loopback.

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
```

The last line is not padding. A report that only ever lists problems gives no
signal that the things it did not mention were actually checked.

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
157 of 241 frames janky (65.1%), budget 16ms.
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

Nothing is published yet, but the build is now configured for all three
registries. Publishing is a deliberate act and needs credentials that are not in
this repo.

The order is not arbitrary. `portholeUi` launches the timeline with `npx
--package @gravitylabs/porthole@<version>`, and the plugin points at the AAR
coordinates, so each step wants the one before it to already exist:

```bash
cd mcp && npm publish                              # @gravitylabs/porthole
./gradlew publishToMavenCentral                    # the two AARs, staged
./gradlew -p gradle-plugin publishPlugins          # the Gradle Plugin Portal
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

Still to do before any of that will succeed:

- Ownership of `gravitylabs.live` proved by DNS record, to claim the
  `live.gravitylabs` namespace on the Central Portal.
- A GPG key. `RELEASE_SIGNING_ENABLED=true` means an unsigned release fails
  rather than quietly uploading something Central will reject.
The version is settled. It is written once, as `porthole` under `[versions]` in
`gradle/libs.versions.toml`, and everything else derives from it: the AARs and
the plugin take it as their project version, and `PortholeVersion.kt` is
generated from it so the runtime version the plugin hands a consumer cannot be
stale. `mcp/package.json` is the one copy that is still edited by hand, and
`VersionConsistencyTest` fails the build if it disagrees.

That test earns its place the same way the AGP one does. A wrong version here
breaks nothing locally — this build compiles and the publish succeeds — and
surfaces later as an unresolvable dependency in the build of whoever applied
the plugin.

`publishToMavenCentral` stages without releasing, and
`SONATYPE_AUTOMATIC_RELEASE=false` keeps it that way: the staged bundle is
promoted by hand after you have looked at it.

To try the consumer path without publishing anywhere:

```bash
./gradlew publishToMavenLocal -PRELEASE_SIGNING_ENABLED=false
```

The flag is needed because the version is no longer a snapshot: signing is
skipped for snapshots and required for everything else, so without it a local
publish fails on a missing signatory rather than on anything you did.

then add `mavenLocal()` to a separate project's `pluginManagement` and
`dependencyResolutionManagement` repositories and apply the plugin by id. That
is how the consumer story here was checked — a separate project, no
`includeBuild`.

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

The published surface is about twenty declarations. Dokka renders them:

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
./gradlew build                          # everything, including lint
./gradlew :runtime:testDebugUnitTest     # runtime
./gradlew :runtime-noop:testDebugUnitTest  # api parity with the runtime
./gradlew -p gradle-plugin test          # plugin, ProjectBuilder and TestKit
cd mcp && npm install && npm run build   # ui and server
cd mcp/ui && npm test                    # timeline logic
```

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

Version 0.1.0, unpublished. Verified end to end on an emulator against
`sample/`: the plugin puts `:runtime` on debug and `:runtime-noop` on release,
the porthole installs itself on process start, and every tool returns real data
— including request and response bodies captured from a one-shot streaming
upload, and a `state` dump reflected out of a live `ViewModel` that nothing
registered.

Redaction was checked the only way worth checking it: the sample sends a bearer
token, a query-string token and a `Set-Cookie`, all containing the string
`do-not-log`. Across a megabyte of everything the porthole emitted, it appears
zero times.

280 tests: 159 on the JVM, 121 across the MCP server and the timeline. The
runtime's arithmetic is covered where it has been wrong before — a long freeze
counted in refreshes rather than in relaxed deadlines, and a stalled thread's
stack ordered so the app's own frames lead. A parity test compares the public
surface of `runtime` and `runtime-noop`, because a missing no-op breaks the
release build of whoever cuts the release rather than whoever added the
integration. Two of the 159 are the AGP compatibility pair, which skips unless
given a version to check, since it needs an SDK and the network.

**Verified on a device:** Room, SQLDelight, OkHttp, Ktor on CIO, WorkManager
with retries, frames, main-thread stalls, memory and GC, device context,
the database inspector, restart, and automatic view model naming.

**Not verified on a device:** `PortholeBackStack` for Navigation 3. The sample
is on Navigation 2, and adding an alpha dependency to prove a six-line wrapper
was a poor trade; the function it calls is unit tested. Blocking GC is also
written but never observed — the emulator did not produce one.

**Not done:** a physical device, multi-process apps, and Compose versions other
than the one in the version catalog.
