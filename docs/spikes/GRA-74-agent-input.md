# GRA-74 — should the agent be able to take one step in the app?

A research spike ahead of any actuator in Porthole. The question is not how
to make a tap work — all three candidate mechanisms work — but whether an
observer should grow a hand at all, and if so, the narrowest hand that is
worth owning.

Every mechanism below was tried on an emulator against the sample's cart
screen, 20–25 repetitions each, with success rates and latencies measured
rather than estimated. Two of the findings are not about the feature at all:
they are pre-existing bugs the experiment tripped over, and both are
prerequisites rather than consequences — see
[Two things that have to be fixed first](#two-things-that-have-to-be-fixed-first).

---

## What was measured on, and what was not

| | |
| --- | --- |
| host | macOS 15.6.1 (Darwin 24.6.0), arm64 |
| emulator | emulator 36.1.9.0, AVD `porthole-gra74` from `system-images;android-36;google_apis_playstore;arm64-v8a`, device profile `pixel_6`, `-no-window -no-audio -no-boot-anim -no-snapshot`, port 5578 |
| image | `google/sdk_gphone64_arm64/emu64a:16/BE2A.250530.026.D1/13818094:user/release-keys`, Android 16, sdk 36 |
| screen | 1080x2400, density 420, gesture navigation |
| adb | 1.0.41 (platform-tools 36.0.0) |
| app under test | `:sample:installRoomDebug` (`com.example.shop`, versionName 1.4.2), plus a scratch `:sample:installRoomStaging` for the safety question |
| transport | `adb forward tcp:8774 localabstract:porthole.com.example.shop`, newline-delimited JSON spoken directly, not through the MCP server |

**No physical device was attached.** The ticket's "real device" acceptance
criteria become emulator measurements here, labelled as such; the hardware
pass is still open — see [What still needs hardware](#what-still-needs-hardware).

Latencies were taken on the host, from the moment the act was issued. The
device's own clock was mapped to the host's with an NTP-style handshake
against `nav_state`'s `capturedAt` (best of five, round trip 1.4ms), so
device-stamped events and host-stamped commands sit on one axis.

---

## Question 1: the three delivery mechanisms

### (a) `adb shell input tap x y`, at the node's bounds from `semantics_tree`

The bounds in `semantics_tree` are `boundsInRoot`. On this sample the Compose
root fills the window edge to edge, so root coordinates and screen pixels are
the same numbers and a tap at the centre of a node's bounds lands on it. That
is a property of this app, not of the API: a `ComposeView` hosted inside a
View hierarchy, or a dialog, roots somewhere other than (0,0) and the identity
stops holding. Nothing in the payload says which case you are in.

```bash
# the shape of every trial
adb -s emulator-5578 shell input tap 138 317        # centre of the "Add" button's bounds
adb -s emulator-5578 shell input text SAVE10        # after a tap that focused the field
```

### (b) an accessibility service

Not built. The one empirical question worth settling was whether the enablement
story is survivable for a debug tool, and it is:

```bash
adb -s emulator-5578 shell settings put secure enabled_accessibility_services \
    com.android.systemui.accessibility.accessibilitymenu/.AccessibilityMenuService
adb -s emulator-5578 shell settings put secure accessibility_enabled 1
adb -s emulator-5578 shell dumpsys accessibility | grep -A3 "Bound services"
#   Bound services:{Service[label=Accessibility Menu, ...]}
#   Enabled services:{{com.android.systemui.accessibility.accessibilitymenu/...}}
```

On Android 16, from the plain adb shell, with no user interaction and no root,
the service binds. The Android 13+ "restricted setting" gate applies to the
Settings UI toggle for sideloaded apps, not to this path. Writing a component
that does not exist is silently dropped (`enabled_accessibility_services` reads
back `null`), so the setting is not a free-form claim — the service has to be
real and installed.

So (b) is feasible. It is also, for what Porthole needs, the most expensive of
the three by a wide margin: a new manifest component, a service process with
its own lifecycle, an `AccessibilityNodeInfo` tree that is *not* the semantics
tree Porthole already publishes (so `stableId` does not address it, and a second
identity scheme would have to be invented and reconciled), and a global,
device-wide capability that reads every app on the device rather than the one
under test. The whole of Porthole's security argument is "device-local, app-local,
debug-only". An accessibility service is device-global by construction. It buys
exactly one thing (b) has that the others do not: gesture synthesis
(`dispatchGesture`) with real timing. Nothing in the loop needs that.

**Assessment: viable, rejected on cost and on scope.** It is the right mechanism
for a general-purpose device driver and the wrong one for an observer that wants
to nudge the app it is already inside.

### (c) invoking the node's own semantics action in-process

`SemanticsCollector` captures `actions` as *labels only* — the mapping over
`config` keeps `value.label ?: key.name` and discards the `AccessibilityAction`
itself. Nothing is held, so nothing can be invoked from a captured tree. A
scratch RPC re-walks the live tree, recomputes the same `stableId` path hashes
`capture()` produces, and invokes the matching node's action on the main thread.
See [Scratch code](#scratch-code-summarised-and-reverted).

```jsonc
{"id": 7, "method": "gra74_act", "params": {"stableId": "b5175c78", "verb": "tap"}}
{"id": 7, "ok": true, "result": {"found":"true","ok":"true","mainThread":"true","postToRunUs":"14333","atMs":"1345819"}}
```

### Success rates and latency

25 repetitions each, on the sample's cart. "issue" is the host-side wall time
of the call itself; "effect" is the first reactive event on the socket; "frame"
is the first `frame` event; "verify" is how long a poll of `semantics_tree`
then took to see the change. All times in ms, min / p50 / max.

| trial | mechanism | target | ok | issue | effect | frame | verify |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | `adb input tap` | "Add" button | **25/25** | 28.6 / 33.6 / 77.3 | 24.5 / 30.3 / 67.9 | 51.7 / 63.7 / 165.4 | 12.6 / 22.6 / 35.1 |
| A2 | `adb input tap` | row "+" | **25/25** | 27.4 / 35.1 / 65.4 | 26.1 / 33.1 / 63.8 | 51.9 / 65.0 / 134.7 | 11.9 / 19.0 / 31.3 |
| A3 | `adb input tap` + `input text` | promo field | **25/25** | 102.2 / 182.5 / 495.1 | 23.7 / 32.6 / 63.0 | 53.4 / 76.4 / 258.4 | 11.3 / 14.8 / 22.7 |
| C1 | in-process `OnClick` | "Add" button | **25/25** | 9.0 / 16.0 / 56.8 | 9.0 / 19.8 / 40.7 | 66.5 / 133.2 / 405.9 | 32.8 / 51.3 / 119.2 |
| C2 | in-process `OnClick` | row "+" | **25/25** | 8.9 / 13.4 / 37.5 | 9.6 / 14.6 / 32.4 | 61.1 / 110.8 / 224.9 | 20.9 / 32.2 / 86.2 |
| C3 | in-process `SetText` | promo field | **25/25** | 7.1 / 8.7 / 53.0 | 7.5 / 9.4 / 58.0 | 39.9 / 63.5 / 241.0 | 13.9 / 19.2 / 108.0 |

150 acts, 150 successes, both mechanisms. Neither is unreliable on a screen
that is sitting still. The separation is not in the success rate.

The `issue` column is the honest cost difference: an `adb shell` round trip is
~34ms and in-process is ~13ms, and A3's 182ms p50 is two adb round trips
(`input tap` then `input text`) rather than anything the app did. Against a
2.5s settle (below) neither matters much, but a loop that takes twenty steps
pays it twenty times.

### Negative control: acting on something inert

25 `adb input tap`s at the centre of a plain, non-clickable `Text`, and 25
in-process taps at a node with no `OnClick`:

| control | runs with zero reactive events | what the caller was told |
| --- | --- | --- |
| `adb input tap` on an inert `Text` | 24/25 (one stray `log`) | nothing — `input tap` exits 0 either way |
| in-process tap on a node with no `OnClick` | 25/25 | `{"found":"true","ok":"false","error":"node has no OnClick"}` |

No frames were drawn in either control. This is the sharpest practical
difference between the two mechanisms: **(c) reports its own failure and (a)
cannot.** `adb shell input tap` returns 0 for a tap that hit nothing, a tap
that hit the wrong thing, and a tap that hit the right thing. The only way to
tell is to look afterwards.

### Does `stableId` survive the UI changing under a tap?

Three different answers, and the difference matters more than any latency here.

**Rotation: yes, completely.** Portrait to landscape, 50 nodes to 25 (fewer
list rows fit), 25 ids in common and **zero new ids** — everything that still
exists kept its id, including all 12 of the screen's controls. `Add` is
`b5175c78` in both orientations.

| | portrait | landscape |
| --- | --- | --- |
| `Add` stableId | `b5175c78` | `b5175c78` |
| `Add` bounds | (42, 265, 234, 370) | (170, 200, 362, 305) |
| ids in common | 25 of 50 | 25 of 25, 0 new |
| of those, bounds changed | 23 | |

**Process restart: yes, for everything that is not a lazy-list child.** Across
a `force-stop` and a relaunch, 18 nodes were present both times; 14 kept their
`stableId` and 4 changed. All four were list rows and their children.

**Scroll: no.** This is the negative result.

| after | rows in tree | row ids in common with the start | nodes in common | gone | new |
| --- | --- | --- | --- | --- | --- |
| one 700px swipe | 8 | 1 of 6 | 25 of 50 | 25 | 35 |
| three more | 8 | 0 | 20 | 30 | 40 |
| six more | 9 | 0 | 20 | 30 | 45 |

`stableId` is a path hash whose discriminator for these nodes is
`portholeNodeId`, which is `name + "#" + currentCompositeKeyHash` — and inside
`items(items, key = { it.id })` the composite key hash incorporates the item
key. So an id is bound to *an item*, not to a slot: the same row keeps its id
for as long as it stays composed, and no id is ever silently reassigned to a
different item (0 reuses observed across every scroll above). That is the good
half. The bad half is that the set of addressable ids turns over completely as
the list scrolls, so "tap the row for item X" only works while item X happens
to be composed, and an id the agent read thirty seconds ago is very likely gone.

**And the bounds fail dangerously.** A row that has scrolled out of view but is
still composed stays in the tree with its id intact and its bounds collapsed to
`(0,0,0,0)`:

```
    5eddeba5 Ceramic Mug (0,0,0,0)
    9b96466d Canvas Tote (186,1086,490,1149)
    ...
    2c8f0fcb Canvas Tote (0,0,0,0)
```

Two of every eight rows, in every scrolled capture. The centre of that
rectangle is (0, 0) — a real screen coordinate, at the top-left, which on this
sample is inert and on an app with an up-arrow or a close button in the app bar
is not. Nothing in the payload distinguishes "this node is at the origin" from
"this node has no position". A coordinate driver that does not special-case
zero bounds will, sooner or later, press the back arrow because it meant to
press a list row.

Tapping stale coordinates was measured directly: portrait coordinates issued
while the device was in landscape produced no change at all (item count 62
before and after); coordinates re-read after the rotation worked first time
(62 → 63). Coordinates are valid until the next layout pass and not one moment
longer.

Synthesized scrolls themselves are safe: 20 consecutive
`input swipe 540 1800 540 1100 250` gestures never once left the cart screen.
One unexplained escape to the Home screen did occur during a coordinate-driven
session, between a stale-coordinate tap and the next capture; it could not be
attributed and is reported as unexplained rather than pinned on a mechanism.

### Does invoking a semantics action bypass the input pipeline, and the frame?

**The input pipeline: yes, entirely. The frame: no.** `atrace input view gfx wm am`
over six acts of each kind:

| slice | 6 × `adb input tap` | 6 × in-process `OnClick` |
| --- | --- | --- |
| `deliverInputEvent` | **6** | **0** |
| `DrawFrame` | 5 | 7 |

And from Porthole's own side, a `frame` event was observed for **25 of 25 acts
in every one of C1, C2 and C3** — 75 of 75. The reason is structural rather
than lucky: the action lambda runs on the main thread and writes snapshot
state, and everything downstream of that write — invalidation, recomposition,
layout, draw — is the same code path a real tap reaches. What is bypassed is
everything *upstream*: hit testing, gesture recognition, the ripple, and the
`MotionEvent` itself.

That bypass is not free, and the text field shows exactly where it bites.
Starting from a freshly composed screen with nothing focused:

| act | field focused after | IME shown after | value written |
| --- | --- | --- | --- |
| `adb input tap` on the field | yes | yes | — |
| in-process `OnClick` on the field | yes | yes | — |
| in-process `SetText` on the field | **no** | **no** | yes |

`OnClick` on a text field is faithful, because Compose wires that action to the
same focus request a tap triggers. `SetText` is not: it writes a value into a
field that was never focused and never raised a keyboard, which is a state no
user can reach. A `type` verb built on `SetText` produces app states that are
real to the code and impossible in the product.

**Action coverage** on the cart screen (50 nodes): 18 carry `OnClick`, 18
`RequestFocus`, 1 `SetText`, 1 `OnLongClick`, 1 each `ScrollBy` and
`ScrollToIndex`. Zero nodes are flagged `clickable` without also offering
`OnClick`, so on this sample there is no node (c) can see and cannot act on.
In-process `ScrollBy` was tried and works (`{"found":"true","ok":"true"}`, first
row moved from Ceramic Mug to Canvas Tote).

### The three, side by side

| | (a) `adb input tap` | (b) accessibility service | (c) in-process action |
| --- | --- | --- | --- |
| tried here | yes, 75 acts | enablement only | yes, 75 acts |
| success rate | 75/75 | — | 75/75 |
| issue latency p50 | 34ms | — | 13ms |
| addressed by | screen coordinates | `AccessibilityNodeInfo` (a second identity scheme) | `stableId`, already published |
| survives rotation | no — coordinates must be re-read | n/a | yes |
| survives scroll | no — off-screen rows report `(0,0,0,0)` | n/a | id survives while composed; set turns over |
| reports its own failure | no, always exits 0 | yes | yes, `found`/`no OnClick` |
| goes through input dispatch | yes (6/6 `deliverInputEvent`) | yes | **no** (0/6) |
| produces a frame | yes | yes | **yes** (75/75) |
| respects hit testing / occlusion | yes | yes | **no** |
| new surface to own | none | a service, a process, a second tree | ~100 lines in the runtime |

---

## Question 2: the smallest useful verb set

Argued from what the sample's cart and the agentic loop actually need, not from
what a test framework usually ships.

**`tap(stableId)` — yes.** It is the whole of the loop's need. Every finding
Porthole produces on this screen is reachable by pressing one button:
"Block main" for a stall, "StrictMode" for a violation, "Checkout" for the
failing HTTP call, "Animate totals" for the recomposition storm the
`recompose-hotspot` report exists to explain. The gap the agent has today is
that it can read the finding and cannot reproduce it. One verb closes that.

**`type(stableId, text)` — no, not in the first cut.** `SetText` writes a value
into an unfocused field with no IME, which is a state a user cannot produce, so
anything the agent concludes from it is about the code and not the product. The
honest version is a `tap` to focus followed by real key input, which is two
mechanisms in one verb. The sample has exactly one text field and nothing in
the loop needs it. Leave it out and say why.

**`scroll` — no, not in the first cut.** It works (`ScrollBy`, above), and it is
the one verb with a real argument for inclusion: `stableId` addressing is
useless for a row that is not currently composed, and scrolling is how you
compose it. But that argument only bites on a list longer than a screen with a
target the agent already knows about, which is not the loop's current shape.
Ship `tap` and see whether "I can see the id but it scrolled away" is a real
complaint before answering it.

**`back` — no, and it is worth saying why rather than just omitting it.** There
is no semantics action for system back anywhere in the tree (checked: zero nodes
offer anything back- or dismiss-shaped), so `back` cannot ride mechanism (c) at
all. It would have to be `adb shell input keyevent 4`, which means the verb set
spans two mechanisms with two different failure modes and two different safety
stories. It is also overloaded in a way that bit this spike: the same keyevent
dismisses the IME when one is up and pops the navigation stack when one is not,
and telling those apart from outside requires `dumpsys input_method`. A verb
whose meaning depends on invisible state is a bad first verb.

**The verb set is `tap`.** One verb, one mechanism, one failure mode.

---

## Question 3: is nav + recomposition + frames enough to replace an explicit wait?

**Partly. It replaces the wait for the UI to respond. It does not replace the
wait for the app to settle, and it cannot tell you that nothing happened.**

Three separate questions hide inside "is it done", and the event stream answers
them with very different confidence. Measured over 40 acts with a 3.0s
observation window, polling `inflight` every 120ms throughout:

| | adb tap "Add" (n=20) | in-process tap "Add" (n=20) |
| --- | --- | --- |
| first signal event | 31.5 / 74.3 / **227.8** | 7.8 / 12.6 / **31.6** |
| first `frame` event | 66.7 / 143.6 / **511.5** | 46.1 / 93.2 / **200.5** |
| last signal event | 950.4 / 1018.9 / **1246.2** | 464.0 / 482.3 / **1192.0** |
| largest gap between signals | 68.2 / 121.5 / **382.3** | 304.2 / 400.7 / **728.4** |
| `inflight` last seen non-empty | 445.3 / 503.0 / **951.0** | 398.7 / 415.5 / **491.1** |
| `frame` observed | 20/20 | 20/20 |

min / p50 / max, ms.

The load-bearing numbers: a frame always arrived, at worst 512ms after the act
(and at worst 406ms over the separate 75 in-process trials). `inflight` was
non-empty in **40 of 40** acts and was last seen busy at 951ms. The largest
gap between two consecutive signal events inside one burst was **728ms** — so
any quiescence window shorter than that declares "done" while the app is still
working. In an earlier 80-act pass with a 2.5s window one adb tap's *first*
signal did not arrive until 1021ms, which is what rules out any short "nothing
within N ms means nothing happened" test.

**The rule that would have worked in every run measured here:**

1. **Delivered** — the mechanism says so. Mechanism (c) returns `found` and
   `ok` synchronously. Mechanism (a) has nothing to offer here, which is on its
   own a reason to prefer (c).
2. **Responded** — a `frame` event whose `t` is after the act. Cap at 1500ms
   (worst observed 512ms, ~3x margin). No frame within the cap means the act
   changed nothing visible; it does not mean it changed nothing.
3. **Settled** — after that frame, `inflight` reports zero open HTTP calls,
   queries and work items on two consecutive polls, **and** no
   `recompose`/`state_write`/`frame`/`nav`/`http_*`/`db_*`/`work_start` event
   has arrived for 800ms (worst observed intra-burst gap 728ms). Cap the whole
   thing at 3000ms (worst observed last-signal 1246ms + 800ms ≈ 2.0s).
4. **Nothing happened** is never concluded from silence. It is concluded from
   the mechanism's own answer (`found: false`, `no OnClick`) or from the
   semantics tree being unchanged after step 3 completes or times out.

That is a real answer to "can it replace an explicit wait" — yes, for step 2,
which is the one a person would otherwise hand-tune — but it needs `inflight`
alongside the event stream, and it needs the caps. The recomposition lane
specifically adds nothing here that `frame` does not already provide: every act
that recomposed also drew.

---

## Question 4: what can actually be enforced

Porthole already has the right precedent for this, and it is the database
inspector: read-only "is enforced on the device rather than assumed from the
socket being loopback". The same standard applied here separates a short
enforceable list from a longer documented one.

### Enforceable

**The debuggable flag.** `(applicationInfo.flags and FLAG_DEBUGGABLE) != 0` is
a fact the runtime can read in one line. It does not read it today, and the
`hello` handshake reports `debuggable = true` as a hardcoded literal. That is
not hypothetical: `PortholeExtension.debugBuildTypes` documents
`debugBuildTypes.set(listOf("debug", "staging"))` as supported usage, and
`AndroidWiring.wire()` adds the real `:runtime` dependency and all four
`resValue`s to every build type in that list without ever consulting
`buildType.isDebuggable`. Demonstrated:

```bash
# scratch: a "staging" build type, isDebuggable = false, applicationIdSuffix ".staging"
./gradlew :sample:installRoomStaging
adb shell dumpsys package com.example.shop.staging | grep pkgFlags
#   pkgFlags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]        <- no DEBUGGABLE
adb forward tcp:8775 localabstract:porthole.com.example.shop.staging
# hello -> {"packageName":"com.example.shop.staging","debuggable":true,...}, 15 collectors
# semantics_tree answers, log capture live, db inspector live
```

A non-debuggable build carries the full runtime and tells the MCP server it is
debuggable. This is the single most enforceable gate available and it is
currently a literal. It is also a prerequisite: an actuator gated on a claim
that is false is not gated.

**An explicit opt-in that travels in the APK.** A generated
`porthole_allow_agent_input` bool, written by `porthole { allowAgentInput.set(true) }`
through the same `buildType.resValue` mechanism `porthole_strict_mode` already
uses, read with `resources.getBoolean` and defaulting to **false** when absent.
This is enforceable in the strongest available sense: it is compiled into the
build, so it cannot be flipped by the host, by an MCP argument, or by anything
the agent says. A build without it refuses every act, and says so.

**The socket being device-local.** Already true by construction since GRA-199 —
an abstract-namespace Unix socket, reachable only from the device, requiring
`adb forward` and therefore USB debugging authorisation to reach at all. No
change needed; it is part of the argument.

### Not enforceable — documented, and reported

**"Points at a local backend."** This cannot be gated. The runtime has no idea
what the app's base URL is; it learns a host only when a request is made, from
the OkHttp and Ktor interceptors. The hostname does survive redaction
(`recentHttp` shows `http://localhost:39795/v1/carts/99001?include=*&token=*`),
so a retroactive check — "every host observed so far resolves to loopback or a
private range" — is buildable, but it is vacuously true before the first call,
blind to gRPC, WebViews, sockets and anything not going through the two
instrumented clients, and one `Refresh` away from being wrong. It belongs in a
warning on every act's result, not in a gate. **What happens when the app points
at a real backend is therefore: the act goes through.** The only honest defence
is the opt-in resource above — a developer who sets `allowAgentInput` in a build
wired to production has made a decision, and the tool should make that decision
loud (`porthole_status`, every tool's banner, the timeline pill, in the same
danger tone the applicationId mismatch already uses) rather than pretend to
prevent it.

**The applicationId suffix.** A convention, not a property. An app can ship any
applicationId it likes and a suffix proves nothing about where the build points.
Worth reporting next to the backend warning; worthless as a gate.

**Being on an emulator.** Detectable — `Build.HARDWARE` is `ranchu`,
`ro.kernel.qemu` is `1`, the fingerprint says `sdk_gphone64_arm64` — but
trivially spoofable, and requiring it would make the feature useless on the real
devices people actually debug on. Report, never gate.

### The posture, then

Off by default; on only via `porthole { allowAgentInput.set(true) }`, which
compiles a `false`-by-default bool into the APK; refused outright in a build
whose `FLAG_DEBUGGABLE` is clear, once that is a real check; and every act's
result carries the hosts observed so far, flagged when any of them is not
loopback. Three of those four are enforced on the device. The fourth — the
backend — is a warning, and the doc should say it is a warning rather than
dress it up.

---

## Question 5: the honest alternative — integrate with Maestro

The integration already exists, and that is the strongest form of this argument.
`porthole capture` wraps a command:

```bash
porthole capture --scenario checkout --out trace.json -- maestro test flows/checkout.yaml
```

The README is explicit that this is the design — "it wraps a command rather than
asking anything of it, so `connectedAndroidTest`, Maestro, a shell script and an
agentic driver are all just a command" — and `compare`'s `--driver` flag exists
precisely so two runs driven differently are not compared as if they were the
same. Porthole observes; something else drives. Nothing needs building.

A *deeper* Maestro integration would mean one of: Porthole emitting a
`Porthole.mark()` per Maestro step so findings name the step they fell under
(Maestro runs out of process, so this needs Maestro to tell Porthole, and Maestro
has no hook for it); or Porthole generating a `.yaml` flow from a semantics tree
(a flow generator, not an observer); or Porthole invoking Maestro per step
(paying a JVM process launch per tap, several hundred ms, to get exactly the
coordinate tap mechanism (a) already provides for 34ms).

**Is it better?** For reproducing a scenario, running it in CI, gating a
regression: yes, unambiguously, and the existing wrapper is the right amount of
integration. For the thing this ticket is actually about — an agent mid-turn
that has just read a finding and wants to see it again — no. Writing a flow file,
shelling out to Maestro, and waiting for it to install and start is not "one
step"; it is authoring a test. The two are not competing. The recommendation
below keeps the wrapper as the answer for scenarios and adds one verb for the
turn-level case, and the scope boundary exists to stop the second from growing
into the first.

---

## Two things that have to be fixed first

Both were found by the experiment rather than designed for, and both are
prerequisites rather than nice-to-haves.

**`semantics_tree` races Compose, and an act-then-observe loop is what makes it
show.** `SemanticsCollector.capture()` is called straight from the socket IO
thread and reads `SemanticsNode.config` and `boundsInRoot` there. On a quiet
screen it never fails. Polled every ~50ms while the cart is being tapped, it
failed 4 times in 60 captures (6.7%):

```
IllegalArgumentException: Detected multithreaded access to SnapshotStateObserver:
previousThreadId=2, currentThread={id=78, name=porthole-io}. Note that observation
on multiple threads in layout/draw is not supported.
```

Every measurement in this document was taken through a retry wrapper because of
it. A person reading a tree once an hour will never see this; the loop this
ticket proposes hits it constantly, and the completion rule in Question 3 polls
the tree by design. The fix is a main-thread hop with a bounded timeout — the
pattern `StartupCollector`, `AutoWire` and `MainThreadWatchdog` already use —
and it is the same hop mechanism (c) needs anyway, so it is shared work rather
than a tax.

**`hello`'s `debuggable` is a literal, not a check.** Covered in Question 4. An
actuator gated on it would be gated on nothing.

---

## Recommendation: build, narrowly

**Build mechanism (c) as a single tool exposing a single verb, `tap(stableId)`,
opt-in at build time and off by default. Do not build the coordinate path as the
primary mechanism, do not build the accessibility service, and keep
`porthole capture`'s command wrapper as the answer for anything scenario-shaped.**

The reasoning, in the order the evidence supports it:

The reliability question is settled and it settles nothing: 150 of 150 acts
succeeded across both mechanisms. The choice has to be made on failure modes,
and there the separation is wide. Mechanism (a) is addressed by coordinates that
are invalid after the next layout pass, reports success for a tap that hit
nothing, and collapses an off-screen-but-composed node's bounds to `(0,0,0,0)` —
a rectangle whose centre is a real, pressable coordinate at the top-left of the
screen. Mechanism (c) is addressed by the identity Porthole already publishes and
already claims is stable, says `found: false` when it is not there and
`no OnClick` when it cannot act, and is 2.5x cheaper per act. For a caller that
must reason about what it just did, being told beats having to look.

The cost is small and it is mostly shared. The scratch RPC is under a hundred
lines, and the main-thread hop it needs is a bug fix that is owed regardless.

The honesty cost is real and must be stated in the tool's own description rather
than in a doc nobody reads: an in-process action bypasses hit testing and gesture
recognition entirely (0 of 6 `deliverInputEvent` slices against 6 of 6 for adb),
so it can press a button a user could not reach because something is drawn on
top of it. It does *not* bypass the frame — 75 of 75 acts drew one — so
everything the agent then observes about cost, recomposition and jank is the
same thing a real tap produces. The correct claim is "this exercised the app's
code", never "a user can do this", and the tool should say so where the agent
will read it.

`type` and `scroll` are deliberately excluded. `SetText` writes into an
unfocused field with no IME, which is a state the product cannot produce, and
`scroll` is a real need only once "the id scrolled away" turns out to be a real
complaint. `back` is excluded because there is no semantics action for it, so
including it would put a second mechanism into a one-mechanism tool on day one.

**If any of the following is not true, do not build it:** the `semantics_tree`
main-thread race is fixed; `debuggable` is a real check; the opt-in is a
generated resource in the APK rather than a host-side setting or a tool
argument. Each of those is what stops "one step" from being something a build
can do without its author having decided it should.

### Follow-up ticket

> **Title:** `tap(stableId)` — one opt-in, in-process step for the agent
>
> **Why.** The agent can read that the main thread blocked, and it can read
> which button caused it, and it cannot press that button. Every finding it
> reports needs a person to reproduce it before it can be investigated, which
> is the one manual step in an otherwise closed loop. GRA-74 measured the three
> ways to close it (`docs/spikes/GRA-74-agent-input.md`): coordinate taps and
> in-process semantics actions both succeed 75/75 on the sample's cart, and the
> in-process path wins on every failure mode — it is addressed by `stableId`
> rather than by coordinates that expire at the next layout pass, it reports
> `found: false` and `no OnClick` where `adb input tap` silently exits 0, and it
> costs 13ms against 34ms.
>
> **What.**
> - A runtime RPC `tap` taking a `stableId`, re-walking the live semantics tree
>   on the **main thread**, recomputing the same path hashes `SemanticsCollector.capture()`
>   produces, and invoking that node's `SemanticsActions.OnClick`. Synchronous
>   result: `found`, `invoked`, and the reason when either is false.
> - Gated on a generated `porthole_allow_agent_input` bool resource, written by
>   `porthole { allowAgentInput.set(true) }` through the same `buildType.resValue`
>   path `porthole_strict_mode` uses, **defaulting to false** when absent, and on
>   `FLAG_DEBUGGABLE` being set. Both refusals name the reason.
> - One MCP tool, `tap`, `readOnlyHint: false`, whose description states in its
>   own text that the input pipeline is bypassed — the action is invoked
>   directly, so hit testing and occlusion are not respected — and that the frame
>   it produces is real.
> - The result carries the completion evidence GRA-74 derived: the first `frame`
>   after the act (cap 1500ms), then `inflight` empty on two consecutive polls
>   plus 800ms of event silence (cap 3000ms), plus the hosts observed so far with
>   any non-loopback host flagged.
>
> **Acceptance criteria.**
> 1. A build without `allowAgentInput` refuses every `tap` and the refusal names
>    the Gradle line to add. A build whose `FLAG_DEBUGGABLE` is clear refuses,
>    and says which of the two gates failed.
> 2. `tap` on a `stableId` that is not in the tree returns `found: false`; on a
>    node with no `OnClick` returns `invoked: false` with the reason. Neither
>    throws, neither is reported as success.
> 3. The action runs on the main thread. A test asserts the invoking thread, and
>    a test asserts a `tap` issued while the screen is actively recomposing
>    neither fails nor corrupts a concurrent `semantics_tree`.
> 4. 25 consecutive `tap`s on the sample's "Add" succeed and the cart count
>    advances by 25, on an emulator, in CI.
> 5. The MCP tool description says the input pipeline is bypassed. A test pins
>    that sentence, the way the existing description tests do.
> 6. Hardware: the 25-tap run and the completion-rule caps are re-measured on one
>    physical device before the tool loses its experimental marking.
>
> **Size:** M. The runtime side is small (~150 lines with the gates); the MCP
> tool, the Gradle resource, the completion logic and the tests are the bulk.
>
> **Blocked on:** the `semantics_tree` main-thread race, and `hello`'s
> `debuggable` becoming a real check. Both are separate tickets and both are
> prerequisites — the first because this tool needs the same main-thread hop and
> because the completion rule polls the tree, the second because a gate on a
> hardcoded `true` is not a gate.
>
> **Scope boundary — explicitly not in this ticket.** No `type`, no `scroll`, no
> `back`, no gestures, no long press. No sequences, no scripts, no retries, no
> "tap until": one verb, one call, the agent decides the next step from what it
> observes. No coordinate fallback — if the node has no `OnClick`, the answer is
> that it has no `OnClick`. No accessibility service. No replacement for
> `porthole capture`'s command wrapper, which stays the answer for anything that
> wants to run a whole scenario.

---

## Scratch code (summarised, and reverted)

Nothing below is committed. Both files were restored to their committed state
before this document was committed; `git status` is clean.

- `runtime/.../collect/SemanticsCollector.kt` — added `gra74Act(stableId, verb, arg)`:
  posts to `Handler(Looper.getMainLooper())`, waits on a `CountDownLatch` with a
  5s bound, and a `locate()` recursion mirroring `convert()`'s path construction
  exactly (same `childDiscriminators`, same `stableId` hash) so the ids it
  matches are the ids `semantics_tree` hands out. Verbs: `tap` →
  `SemanticsActions.OnClick`, `type` → `SetText(AnnotatedString(arg))`, `scroll`
  → `ScrollBy(0f, arg)`. Returns `found`, `ok`, `mainThread`, `postToRunUs`,
  `atMs`, and `error` when it cannot act. ~60 lines.
- `runtime/.../Porthole.kt` — one `method("gra74_act")` registration and one
  `buildJsonObject` import. ~10 lines.
- `sample/build.gradle.kts` — a `staging` build type (`isDebuggable = false`,
  `applicationIdSuffix = ".staging"`, debug signing) and
  `debugBuildTypes.set(listOf("debug", "staging"))`, purely to demonstrate the
  Question 4 gap. ~12 lines.

The measurement harness (a threaded NDJSON client, the clock sync, and the trial
runners) lived outside the repo and is not part of the diff.

---

## What still needs hardware

- Every latency in every table. An emulator's input injection, its scheduler and
  its `swiftshader` GPU are all unlike a phone's, and the adb-versus-in-process
  gap (34ms against 13ms) is exactly the kind of number a USB round trip to a
  real device changes.
- The completion rule's caps. The 800ms quiescence window and the 3000ms overall
  cap come from a worst-observed 728ms gap and a worst-observed 1246ms last
  signal, both on a near-idle emulator. A thermally throttled phone under real
  app load is the only thing that says whether those hold.
- The `semantics_tree` race's 6.7% failure rate under churn. It is a scheduling
  race; its frequency on real hardware is unknown and could be higher or lower.
- Whether `boundsInRoot` and screen pixels coincide on devices with display
  cutouts, three-button navigation, or a non-edge-to-edge activity. Everything
  in Question 1's mechanism (a) assumes they do, which held here and is a
  property of this sample and this emulator.
- The one unexplained navigation to the Home screen during a coordinate-driven
  session. It reproduced neither in 20 scroll swipes nor in 150 taps, and it is
  recorded here as unexplained rather than closed.
