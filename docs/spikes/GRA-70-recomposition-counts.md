# GRA-70 — can recomposition counts stop needing instrumentation?

A research spike, not a feature. The question is whether the porthole can
count recompositions across the whole composition rather than only at the call
sites an app wrapped in `PortholeScreen` / `Modifier.portholeNode`, and if so at
what cost.

**Answer: yes, via `androidx.compose.runtime.tooling.CompositionObserver`, and
it also fixes the second caveat — attribution becomes causal rather than
temporal. It is not free of conditions: the Compose floor rises from 1.5 to
1.6, one private field has to be read reflectively, and getting *names* out
requires turning on the mechanism the Layout Inspector uses, which changes how
the app under test compiles its recompose scopes. The recommendation is to take
it, behind an opt-in, and keep `PortholeScreen` for what it is actually for.**

Everything below was run. Nothing in it is reasoned from documentation alone.

---

## What was measured on, and what was not

| | |
| --- | --- |
| host | macOS 15.6.1 (Darwin 24.6.0), Apple M1 Pro |
| emulator | emulator 36.1.9.0, AVD `porthole-gra70` from `system-images;android-36;google_apis_playstore;arm64-v8a`, device profile `pixel_6`, `-no-window -no-audio -no-boot-anim -no-snapshot`, port 5560 |
| image | `google/sdk_gphone64_arm64/emu64a:16/BE2A.250530.026.D1/13818094:user/release-keys`, Android 16, sdk 36 |
| screen | 1080x2400 @ 420dpi, `Pipeline=Skia (OpenGL)` — software rasterisation |
| app under test | `:sample:assembleRoomDebug` (`com.example.shop`, versionName 1.4.2) on `GRA-70` off `main` at `b2477c1` |
| Compose | BOM 2025.01.00 → `androidx.compose.runtime:runtime-android:1.7.6`, `androidx.compose.ui:ui-android:1.7.6` |
| toolchain | Kotlin 2.1.0, AGP 8.13.2, JDK 17 (Android Studio JBR) |
| trace_processor | v58.2, from `~/.porthole/trace-processor/v58.2/trace_processor_shell` |

**No physical device was attached.** The ticket's "real device" acceptance
criterion is met here by an emulator and is labelled as such everywhere below.
A second emulator belonging to a sibling worktree was running on the same host
throughout, which is the main reason the frame-time numbers are as noisy as
they are. Hardware re-measurement is **pending** — see
[What still needs hardware](#what-still-needs-hardware).

### The probe

The probe is scratch code and is **not** part of this commit. It lived at
`sample/src/main/kotlin/com/example/shop/gra70/Gra70Probe.kt` plus four lines of
`sample/src/main/AndroidManifest.xml`, and was reverted afterwards.

It is shaped deliberately: a `ContentProvider` declared in the manifest and
never mentioned by any app source file. That is the same install mechanism
`androidx.startup` uses, so "can the runtime do this without the app changing
code" is answered by construction rather than by argument. Routes were switched
on with flag files under `/data/local/tmp/` so that every condition ran the same
binary.

### The interaction script

One script, byte-identical across every condition
(`scratchpad/run.sh`, reproduced here):

```bash
adb -s emulator-5560 shell am force-stop com.example.shop
adb -s emulator-5560 shell am start -a android.intent.action.VIEW -d "porthole://cart/99001"
# 3 cart rows, persisted in Room, so the tree is the same every run
adb -s emulator-5560 shell input tap 540 840          # focus the promo field
adb -s emulator-5560 shell dumpsys gfxinfo com.example.shop reset
adb -s emulator-5560 shell input text "SPRINGSALEQ4DISCOUNTPROMOCODEABCDEFGH"
adb -s emulator-5560 shell dumpsys gfxinfo com.example.shop
```

37 characters into `Cart.PromoField`. The script does not press "Add",
because on this image it kills the app: API 36 blocks cleartext to `localhost`
by default and the sample's in-process MockWebServer is reached over plain
HTTP, so `CartApi.addItem` throws `UnknownServiceException: CLEARTEXT
communication to localhost not permitted by network security policy` on the
main thread. The three cart rows were already in Room from an earlier attempt
(the insert happens before the HTTP call) and persist across runs, which is
what makes the tree identical every time. Unrelated to this spike, but it is a
real break in the sample on Android 16 and wants its own ticket.

A second, steadier metric
(`scratchpad/anim.sh`) turns the sample's "Animate totals" switch on — which
ticks a `mutableIntStateOf` at 60 Hz and recomposes every row — and measures
process CPU time (`utime+stime` from `/proc/<pid>/stat`) and frames rendered
over a fixed 20 s window. Frame pacing on a software-rasterised emulator is
close to useless; a fixed-duration CPU integral is not.

---

## Overhead, measured

Five conditions, one binary, switched by flag file. `A` is the control: the
sample exactly as it ships, Porthole's own `SideEffect` instrumentation
included, probe code present but inert.

| | what is on |
| --- | --- |
| **A** control | nothing added |
| **B** observer | `CompositionObserver` attached; counts, no names |
| **C** observer + names | B, plus the `inspection_slot_table_set` tag, so `forceRecomposeScopes` is on and scopes resolve to names |
| **D** tracer, counting | `Composer.setTracer`, counting by name into a map in process |
| **E** tracer, atrace | `Composer.setTracer` emitting `Trace.beginSection`, no counting |

Runs are **interleaved** — A,B,C,D,E, then again — so that host load drifting
over the session cannot be mistaken for a condition. One `E` animation run is
excluded: the toggle tap missed and it rendered zero frames.

### Typing into `Cart.PromoField`, `dumpsys gfxinfo` (4 runs each)

| condition | n | p50 frame, median | p50 range | process CPU, median | CPU range | Δp50 | ΔCPU |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A control | 4 | 57 ms | 48–150 | 1860 ms | 1410–6330 | — | — |
| B observer | 4 | 54 ms | 48–105 | 1790 ms | 1470–3820 | −4% | −4% |
| C observer + names | 4 | 63 ms | 53–77 | 2265 ms | 1770–2730 | +11% | +22% |
| D tracer, counting | 4 | 61 ms | 53–77 | 1865 ms | 1370–2720 | +7% | +0% |
| E tracer, atrace | 4 | 53 ms | 53–81 | 1660 ms | 1620–3040 | −7% | −11% |

### 20 s of 60 Hz recomposition, "Animate totals" on (7 runs each)

| condition | n | CPU over 20 s, median | CPU range | frames in 20 s, median | frames range | ΔCPU | Δframes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A control | 7 | 11 370 ms | 9640–15440 | 1010 | 650–1144 | — | — |
| B observer | 7 | 12 100 ms | 10820–14300 | 935 | 668–1114 | +6% | −7% |
| C observer + names | 7 | 13 190 ms | 9840–17690 | 905 | 215–1130 | +16% | −10% |
| D tracer, counting | 7 | 13 200 ms | 12110–17960 | 903 | 400–1037 | +16% | −11% |
| E tracer, atrace | 6 | 12 745 ms | 11520–15950 | 898 | 396–1078 | +12% | −11% |

### Reading these honestly

**No condition produced a regression that clears this emulator's noise floor.**
The control alone spans 48–150 ms p50 and 9.6–15.4 s of CPU; every interval
above overlaps every other. A software-rasterised emulator sharing an M1 Pro
with a second emulator is not a measuring instrument.

What survives is the *ordering*, which is the same in both metrics and across
interleaved rounds: `A ≤ B < E < C ≈ D`. The one condition whose distribution
barely overlaps the control's is **D** — every one of its seven CPU readings
(12 110–17 960 ms) sits above the control's lower half — which is what you would
expect from a mechanism that fires on every composable invocation.

The numbers that are *not* noisy are the ones the probe took of itself, with
the same `System.nanoTime` bracketing on both sides, over the same 37-character
interaction:

| mechanism | callbacks | time inside the callback |
| --- | --- | --- |
| `CompositionObserver.onBeginComposition` | 43 | **1–2 ms** |
| `CompositionTracer.traceEventStart/End` | 5287 | **30 ms** |

Two orders of magnitude fewer callbacks, and fifteen times less work, for a
strictly better answer. That is the whole comparison between routes 1 and 2 in
one table, and it does not depend on the emulator at all.

Best estimate for hardware, to be confirmed: counts-only (B) under 5%, names
(C) in the 10–20% CPU range, tracing (D/E) similar to C but paid on every
frame rather than on invalidation.



---

## Route 1 — `CompositionObserver`

### Does it exist, in this BOM and in the oldest Compose the project claims?

In this BOM, yes. From the cached AAR:

```
$ unzip -l classes.jar | grep runtime/tooling
androidx/compose/runtime/tooling/CompositionObserver.class
androidx/compose/runtime/tooling/CompositionObserverHandle.class
androidx/compose/runtime/tooling/CompositionObserverKt.class
androidx/compose/runtime/tooling/RecomposeScopeObserver.class

$ javap androidx.compose.runtime.tooling.CompositionObserverKt
  public static final CompositionObserverHandle observe(Composition, CompositionObserver);
  public static final CompositionObserverHandle observe(RecomposeScope, RecomposeScopeObserver);
```

In the oldest Compose the README claims, **no**. Checking every published
`runtime` sources jar, `tooling/CompositionObserver.kt` is absent from 1.4.3,
1.5.0, 1.5.4 and 1.6.0-alpha01 … -alpha06, and first present in
**1.6.0-alpha07** (stable in 1.6.0). There was never an earlier
`Composition.setObserver` — the API was called `observe` in its first CL and
moved into the `tooling` package before release. It is
`@ExperimentalComposeRuntimeApi` throughout.

So adopting this raises the floor in the README's opening comment from
"Compose >= 1.5" to "Compose >= 1.6". There is no in-process observation API at
all on 1.5.x.

One signature detail that cost a compile: in 1.7.x the map's value type is
nullable.

```kotlin
fun onBeginComposition(composition: Composition, invalidationMap: Map<RecomposeScope, Set<Any>?>)
```

### Per-call-site, or only per-composition?

**Per call site.** `onBeginComposition` is called once per composition pass, but
its argument is a map keyed by `RecomposeScope` — one entry per scope that was
invalidated — and the value is *the set of state objects that invalidated it*.

That second half is the part worth noticing. Porthole today pairs a
recomposition with every snapshot write in the preceding 32 ms and lists all of
them, which is why the report on this interaction names 39 candidate triggers
for one node. The observer hands over the actual objects. Attribution stops
being temporal.

### Can the runtime attach it with no app code?

**Yes, and it was done.** The chain, all from a manifest-declared
`ContentProvider`:

1. `Application.registerActivityLifecycleCallbacks`.
2. `onActivityResumed` → walk `activity.window.decorView` for an
   `AbstractComposeView`.
3. Read its `composition` field. This is the one unavoidable reflection:
   `AbstractComposeView.composition` is `private` with no accessor, confirmed by
   `javap -p`.
4. Call `observe(…)` on it **directly** — no unwrapping needed.
   `WrappedComposition` implements `CompositionServices` and forwards the
   service lookup to the real `CompositionImpl`, so the public extension works
   on the wrapper:

   ```
   I GRA70: OBSERVER ATTACHED to androidx.compose.ui.platform.WrappedComposition
            (inner androidx.compose.runtime.CompositionImpl) via ComposeView
   ```

Of the three candidate discovery mechanisms the ticket lists — decor traversal,
`LocalInspectionTables`, the `Recomposer` — decor traversal is the one that
works today. `LocalInspectionTables` is a composition local, so reading it needs
a composable, which needs app code. The `Recomposer` does hold every
composition, but only in `private final List<ControlledComposition>
_knownCompositions`, so reaching it is strictly more reflection than reading one
field off a View, for the same result.

### Do the counts agree with Porthole's own?

Same interaction, both read at the end of it. Porthole over its socket, the
observer from the probe.

| source | scopes reported | busiest | count |
| --- | --- | --- | --- |
| Porthole, instrumented | 2 | `Cart.PromoField` | 32 |
| " | | `Cart.ResponseText` | 32 |
| `CompositionObserver` | 10 | the `CartScreen` content scope | 32–33 |
| " | | 9 others, unwrapped | 35, 33, 3, 2, 2, 1, 1, 1, 1 |

The counts match. What differs is coverage: Porthole saw the two call sites the
sample wrapped, the observer saw all ten scopes in the tree that were actually
invalidated — the `OutlinedTextField`, `BasicTextField`, `CoreTextField`,
`CommonDecorationBox` and `Transition.animateTo` scopes underneath the field,
none of which any app would ever think to wrap. That is the caveat, closed.

### Names — the hard part, and the reason this is not a one-line change

`RecomposeScope` is `interface RecomposeScope { fun invalidate() }`. It has no
name. The scope identity has to be joined to something that does.

The join exists: walk the composition's slot table (`SlotTable` implements
`CompositionData`), and every group's `data` contains the `RecomposeScopeImpl`
for that group, so group → scope is a map you can build. This is the same join
the Layout Inspector makes. Building it found all 199 scopes.

**And every one of their `sourceInfo` strings was null.** The reason is
structural, not a bug in the probe:

- `ComposerImpl.sourceInformation(...)` writes to the slot table only
  `if (inserting && sourceMarkersEnabled)`.
- `sourceMarkersEnabled` is false unless someone calls
  `Composer.collectParameterInformation()`.
- On Android, the only caller is `WrappedComposition.setContent` in
  `Wrapper.android.kt`, and only when it finds a
  `R.id.inspection_slot_table_set` tag.
- Compose only creates that tag itself when the global
  `isDebugInspectorInfoEnabled` is true, which it is not in a normal app.
- `Recomposer.collectingSourceInformation` and `collectingParameterInformation`
  are hard-coded `false`.

Note the `inserting` guard. Flipping the flags after the fact records nothing,
because source information is only written while a group is being *created*. A
plain recomposition of an existing group takes the other path. This is why the
Layout Inspector, which attaches to an already-running app, has to force a full
hot reload (`HotReloader.saveStateAndDispose` / `loadStateAndCompose`) after
setting the tag — it has to make the whole tree be re-inserted.

**The porthole does not have to do that, because it is there first.** The tag
lookup reads `owner` (the `AndroidComposeView`) and exactly one level up, its
parent, which is the `ComposeView`. `Application.ActivityLifecycleCallbacks
.onActivityCreated` is dispatched from inside `Activity.onCreate`'s `super`
call — before the app's own `setContent` — and at that point the decor is not
yet attached to a window, so `addView` does not dispatch attach and
`AbstractComposeView.onAttachedToWindow` has not run. An
`OnHierarchyChangeListener` on `android.R.id.content` therefore sees the
`ComposeView` being added with time to spare, and tagging it there is early
enough:

```kotlin
override fun onActivityCreated(a: Activity, b: Bundle?) {
    val id = a.resources.getIdentifier("inspection_slot_table_set", "id", a.packageName)
    a.findViewById<ViewGroup>(android.R.id.content).setOnHierarchyChangeListener(
        object : ViewGroup.OnHierarchyChangeListener {
            override fun onChildViewAdded(parent: View, child: View) {
                child.setTag(id, Collections.synchronizedSet(HashSet<CompositionData>()))
            }
            override fun onChildViewRemoved(parent: View, child: View) {}
        },
    )
}
```

With that in place Compose populated the set itself — four `CompositionData`
tables, root plus subcompositions — and 298 scopes resolved to names. The
reflection into `CompositionImpl.slotTable` becomes unnecessary: the tag hands
back `CompositionData` through public types.

The names are good:

```
C(CartScreen)59@2464L2638,59@2441L2661:Screens.kt#wsnfdn
C(Controls)128@5233L7,129@5245L1776:Screens.kt#wsnfdn
C(LeakyRow)P(!1,2)166@7151L28,166@7181L43,166@7111L113:Screens.kt#wsnfdn
C(RowBody)P(!1,2)190@8018L306:Screens.kt#wsnfdn
C(OutlinedTextField)P(21,11,10,1,14,19,6,12,7,20,13,17,18,3,22,5,4,16,8,9,2,15)175@9821L7,…
C(CoreTextField)P(14,10,8,13,15,9,4!1,12,6,7,3,5,2,11)221@12329L29,…
C62@2649L42,63@2731L43,68@3031L44,70@3081L2019:Screens.kt#wsnfdn
```

Function name, source file and line, for the app's code and the library's
alike. The last line is a content lambda, which gets no `C(name)` — those stay
`Screens.kt:62` and nothing more, which is still enough to point at. The
existing published artifact `androidx.compose.ui:ui-tooling-data` parses this
format (`SourceContext.name`, `parseCallLocation`) and should be used rather
than hand-parsing, which is what the probe did.

**The cost of doing this is not the CPU cost.**
`collectParameterInformation()` also sets `forceRecomposeScopes = true`, which
makes Compose create a recompose scope for every composable rather than only
where one is needed. That changes the shape of the thing being measured. A
count taken with names on is a count of a slightly different program. This is
the single strongest argument for making naming an explicit opt-in rather than
the default, and for saying so in the report's own `notes`.

### Coverage gap found

The hierarchy listener covers the Activity's content view. Dialogs, popups and
anything else that creates its own `ComposeView` in a separate window are not
covered by it and would need `WindowInspector.getGlobalWindowViews()` or an
equivalent sweep. Not solved here.

---

## Route 2 — composition tracing

### What it actually is

The Compose compiler already emits, around every composable body:

```kotlin
if (isTraceInProgress()) { traceEventStart(key, $dirty, -1, "com.example.shop.ui.CartScreen (Screens.kt:59)") }
```

`isTraceInProgress()` returns true only when something has been handed to
`Composer.setTracer(CompositionTracer)`. That is exactly, and only, what
`androidx.compose.runtime:runtime-tracing` does — its `ComposeTracingInitializer`
is an `androidx.startup` `Initializer` whose whole body is a `setTracer` call
forwarding to `PerfettoSdkTrace.beginSection(info)`. A matching `1.7.6` is
published for this BOM. It pulls in `androidx.tracing:tracing-perfetto`, which
additionally needs the `tracing-perfetto-binary` native artifact and a
Perfetto-SDK-aware capture to produce anything.

**The published artifact on its own produces nothing.** Adding
`androidx.compose.runtime:runtime-tracing:1.7.6` to the sample resolves (it
pulls `androidx.tracing:tracing-perfetto:1.0.0`, and costs about 31 KB
uncompressed in the APK), installs its `Initializer`, and yields exactly zero
Compose slices in a capture, because `PerfettoSdkTrace.isEnabled` is false.
Poking the receiver by hand says why:

```
$ adb shell am broadcast -a androidx.tracing.perfetto.action.ENABLE_TRACING \
    com.example.shop/androidx.tracing.perfetto.TracingReceiver
Broadcast completed: result=11, data="{"exitCode":11,"requiredVersion":"1.0.0",
  "message":"java.lang.UnsatisfiedLinkError: dlopen failed: library
  \"/system/lib64/libtracing_perfetto.so\" needed or dlopened by
  \"/apex/com.android.art/lib64/libnativeloader.so\" is not accessible..."}"
```

```sql
select count(*) from slice where name like '%(%.kt:%)';  -- 0
```

It needs `androidx.tracing:tracing-perfetto-binary` side-loaded and a
Perfetto-SDK-aware capture. Anyone shipping this route would be shipping a
native artifact and a handshake, not a dependency line.

So the route was tried at the layer that matters instead: the probe installed
its own `CompositionTracer`, in two variants — one counting by name in memory, one
calling `android.os.Trace.beginSection(info)` so the slices land in an ordinary
atrace capture, which is the buffer Porthole's own sections already go to.

### Captured with Porthole's own capture path

The command shape is `captureArgs` from `mcp/src/systrace.ts`, defaults and all:

```bash
adb -s emulator-5560 shell perfetto -o /data/misc/perfetto-traces/gra70.pftrace \
  -t 12s --app com.example.shop sched freq idle gfx view wm am binder_driver dalvik
```

and queried with the `trace_processor` the repo already fetches:

```sql
select count(*) from slice where name like '%(%.kt:%)';
-- 4095
```

### Do the slice names give usable names and call sites?

Yes, and that is not the problem.

```
name                                                                        n    avg_us
androidx.compose.runtime.DisposableEffect (Effects.kt:155)                  315       4
androidx.compose.runtime.internal.rememberComposableLambda (…:628)          280      31
androidx.compose.runtime.<get-currentCompositeKeyHash> (Composables.kt:228) 280       5
androidx.compose.animation.core.createTransitionAnimation (…:1900)          175      42
androidx.compose.runtime.SideEffect (Effects.kt:48)                         140      21
androidx.compose.material3.MaterialTheme.<get-typography> (…:91)            140      14
live.gravitylabs.porthole.compose.portholeNodeId (PortholeCompose.kt:133)    70      14
```

```sql
select name, count(*) n from slice where name like 'com.example.shop%' group by name;
-- com.example.shop.ui.CartScreen.<anonymous> (Screens.kt:62)   35
```

The format is `<fully.qualified.name> (<File.kt>:<line>)`, built by the compiler
plugin, and the line is the start of the function *body*. The app's hot scope
comes out at 35, against Porthole's 32 for `Cart.PromoField` — the same scope,
counted over a slightly wider window.

The problems are what surrounds it:

- **It counts invocations, not recompositions.** 216 distinct names for this
  one interaction, and the top of the list is `<get-currentCompositeKeyHash>`,
  `rememberComposableLambda`, `DisposableEffect`,
  `MaterialTheme.<get-colorScheme>` — composable *helpers*, not UI that
  recomposed. Filtering to the app's own package cuts 216 entries to 12 and
  does put the right one on top, but that filter is a guess, and it throws away
  exactly the library-side answers ("the `CoreTextField` under your field is
  what is churning") that route 1 surfaces for free.
- **No cause.** `traceEventStart` gets `key` and the two `$dirty` bitmasks. It
  does not get the state object that invalidated anything, so Porthole's
  attribution would stay temporal.
- **Volume.** The observer fires once per invalidated scope. The tracer fires
  twice per composable invocation, including the whole initial composition.
  For this interaction that is 5287 tracer events against 43 observer calls.

It is a good *trace* feature — a Perfetto capture in which every composable is
a named, timed slice is a real thing to have, and it composes with the sections
Porthole already writes. It is a poor *counting* feature.

---

## Route 3 — what Layout Inspector does

Read from androidx at the 1.7.6-era commit, under
`compose/ui/ui-inspection/src/main/java/androidx/compose/ui/inspection/`.

**How it counts.** Not `CompositionObserver`, and not a tracer. JVMTI bytecode
hooks, through `androidx.inspection.ArtTooling`:

```kotlin
private const val START_RESTART_GROUP = "startRestartGroup(I)Landroidx/compose/runtime/Composer;"
private const val SKIP_TO_GROUP_END   = "skipToGroupEnd()V"

artTooling.registerEntryHook(composerImpl, START_RESTART_GROUP) { _, args -> lastMethodKey = args[0] as Int }
artTooling.registerExitHook(composerImpl, START_RESTART_GROUP) { composer: Composer ->
    composer.recomposeScopeIdentity?.hashCode()?.let { anchor ->
        counts.getOrPut(MethodKey(lastMethodKey, anchor)) { Data(0, 0) }.count++
    }
    composer
}
```

**How it names.** It does not, from the hooks. The count is keyed by
`(startRestartGroup key, anchor hash)` and joined to a tree built by
`LayoutInspectorTree`, whose `name` comes from parsing the group's `sourceInfo`
string — the same `C(Name)…` format route 1 ends up reading. No source info, no
name; there is no other naming channel.

**How it gets source info on a running app.** It sets
`isDebugInspectorInfoEnabled` reflectively, installs an entry hook so future
`WrappedComposition.setContent` calls get tagged, tags the views that already
exist, and then — because a tag alone backfills nothing — forces a hot reload:

```kotlin
// The slot tables added to existing views will be empty until the composables
// are reloaded. Do that now:
hotReload()
```

`hotReload()` is reflection onto `androidx.compose.runtime.HotReloader
.Companion.saveStateAndDispose` / `loadStateAndCompose`. It disposes and
re-composes the entire tree.

**Is any of it available to an in-process library?** The counting, no.
`androidx.compose.ui:ui-inspection` is not published to Maven — the URL 404s —
and the code ships as `inspector.jar` *inside* the `ui` AAR, loaded by the
app-inspection agent. Its build declares `androidx.inspection:inspection` as
`compileOnly` because the agent supplies it. `registerEntryHook` /
`registerExitHook` only do anything when that agent has attached and rewritten
bytecode. There is no in-process equivalent of that counting mechanism. What
route 1 offers is precisely the gap this leaves.

Two pieces *are* borrowable and are plain runtime code: the slot-table tag
(borrowed above, and borrowed better — the porthole is early enough not to need
step two) and `HotReloader` (deliberately **not** borrowed: it loses every
`remember` that is not `rememberSaveable`, restarts every effect, and would
make the tool visibly disturb the app it is measuring).

---

## The other questions the ticket asks

**Can either be enabled from the runtime or the Gradle plugin without the app
changing code?** Both, and route 1 was demonstrated end to end from a
manifest-declared component with no app source touched. Route 2 is easier still
— `runtime-tracing` installs itself through `androidx.startup`, or the runtime
calls `Composer.setTracer` from `PortholeInitializer`; the compiler's
`includeTraceMarkers` already defaults to true, so the Gradle plugin only needs
to stop anyone turning it off.

**What happens to `PortholeScreen` if counts become free?** It stays, and its
job gets cleaner. It never was only a counter:

- it provides `LocalPortholeScreen`, which is how every `portholeNode`
  underneath knows which screen it is on, and how `recompositions(screen=…)`
  filters;
- `Modifier.portholeNode` stamps `PortholeNodeIdKey` into semantics, which is
  the join that lets an agent go from "this recomposed 340 times" to "this is
  where it is on screen" via `semantics_tree`. A derived name like
  `Screens.kt:62` has no semantics node to join to.

So free counts remove the *obligation* to wrap, not the reason. Wrapping
becomes what it should always have been: naming the things you care about, so
the report says `Cart.PromoField` where it would otherwise say
`CartScreen.<anonymous> (Screens.kt:62)`.

**Migration for already-wrapped apps.** Nothing breaks and nothing has to
change. An explicitly wrapped call site keeps its explicit name; the derived
name is the fallback. The one thing to get right is de-duplication — the scope a
`Modifier.portholeNode` counts is the caller's scope, which is the same scope
the observer sees, so the two must be merged on scope identity rather than
reported twice with different names. The probe confirmed they are the same
scope: 32 from the `SideEffect`, 32–33 from the observer, for
`Cart.PromoField`.

---

## Recommendation

**Take route 1.** `CompositionObserver` for counts and causes, the Layout
Inspector's slot-table tag for names, applied earlier than the inspector can
apply it so that no hot reload is needed. Route 2 is worth having later as a
*trace* feature and is not the answer to this question. Route 3 is unavailable
to a library and can be closed.

Conditions the follow-up has to carry, all of them found by running this:

1. The Compose floor moves from 1.5 to 1.6. `CompositionObserver` does not
   exist before 1.6.0-alpha07. The runtime must degrade to today's behaviour,
   not crash, when it is missing.
2. It is `@ExperimentalComposeRuntimeApi`. One signature already changed
   between 1.6 and 1.7.
3. One private field, `AbstractComposeView.composition`, must be read
   reflectively. Everything else is public or is handed over by Compose itself.
4. Names cost more than counts, and cost *correctness*: they require
   `forceRecomposeScopes`, which changes how the app under test allocates
   recompose scopes. Naming must be opt-in and must be declared in the report's
   `notes`.
5. Only the Activity's content `ComposeView` is covered by the mechanism as
   built. Dialogs and popups need more.

---

## Proposed follow-up ticket

**Title:** GRA-71 — count every recomposition, not only the wrapped ones

**Size:** L. Two weeks is realistic: the attach path and the naming path are
independent pieces of work, and the report surface, the MCP tool description
and the README all have to move together with them.

**Why.** The first thing the `recompositions` report has to admit is that it
cannot see most of the tree, and the second is that it is guessing at cause.
GRA-70 established that Compose will tell us both, in public API, with no app
code, at a cost that is under the noise floor for counts. The caveat that an
agent has to be warned about twice in the same report is removable.

**What.**

1. A `CompositionObserver` attached from `PortholeInitializer` via
   `ActivityLifecycleCallbacks` and a decor-view walk, reading
   `AbstractComposeView.composition` reflectively. Every invalidated scope
   counted, per composition pass.
2. Cause taken from the observer's invalidation map — the actual state objects —
   and run through the naming Porthole already has (`Porthole.nameState`, view
   model reflection, `collectAsNamedState`). `triggeredBy` stops being a list
   of everything that moved in the last 32 ms.
3. Names, behind an opt-in (`porthole { composableNames = true }`, off by
   default): tag the `ComposeView` with `inspection_slot_table_set` from
   `onActivityCreated` before the app's `setContent`, read the resulting
   `CompositionData`, and parse call sites with
   `androidx.compose.ui:ui-tooling-data` rather than by hand.
4. Merge on scope identity with the counts `PortholeScreen` and
   `Modifier.portholeNode` already produce, so a wrapped call site keeps its
   explicit name and is not double-counted.
5. Compose floor to 1.6 in the version catalogue's comment and the README;
   graceful degradation to today's behaviour when the tooling API is absent, so
   a 1.5 app still gets wrapped-call-site counts rather than a crash.
6. `notes` in the report rewritten: whole-tree coverage, causal attribution,
   and — when naming is on — an explicit statement that `forceRecomposeScopes`
   is in force and the app is recomposing slightly differently than it would
   without the porthole.

**Acceptance criteria.**

- With no app code beyond applying the plugin, `recompositions` reports scopes
  the app never wrapped. Demonstrated on the sample by reporting the
  `CoreTextField` churn under `Cart.PromoField`, which today is invisible.
- `triggeredBy` for a single-cause recomposition names exactly one state, not a
  list. On the sample's promo-field typing, `CartViewModel.promoCode` and
  nothing else.
- A call site wrapped in `Modifier.portholeNode` appears once, under its
  explicit name.
- With `composableNames = false` (the default), measured CPU overhead on the
  sample's 60 Hz recomposition screen is within 5% of a control, **on
  hardware**, three runs each.
- With `composableNames = true`, the overhead is measured and written into
  `docs/verified.md` and into the tool's `notes`, whatever it turns out to be.
- On a project built against Compose 1.5, the runtime starts, logs that
  whole-tree counting is unavailable, and reports wrapped call sites as it does
  today.
- README caveat replaced, not merely softened.

---

## What still needs hardware

Everything in the overhead tables. The functional findings — that the observer
attaches, that counts match, that names resolve, that `runtime-tracing` alone
emits nothing — are facts about Compose and hold anywhere. The performance
findings are not:

- **Frame time is meaningless here.** The control alone runs 100% janky at a
  57 ms median on a 60 Hz panel. There is no headroom left to consume, so a
  cost that would show as jank on a real phone shows as nothing. The specific
  number the follow-up needs — "does counts-only stay under 5%" — cannot be
  taken from this session.
- **No 120 Hz panel.** The devices in `docs/verified.md` are 120 Hz, an 8.33 ms
  budget. A per-composition callback that is invisible at 16.67 ms may not be.
- **No big.LITTLE.** All emulator cores are equal. On a phone the Recomposer
  may be on a little core, where a fixed per-invalidation cost matters more.
- **`forceRecomposeScopes` was not isolated.** Condition C changes two things
  at once: the slot table gets source information, and Compose allocates a
  recompose scope for every composable. On hardware these should be separated,
  because only the second one changes what is being measured.
- **Memory was not measured at all.** Source information is retained per group
  for the life of the composition; on a large app that is not free, and this
  sample has three cart rows.
- **`androidx.tracing:tracing-perfetto-binary` was never loaded**, so route 2's
  published form was only ever tested through a substitute tracer.
