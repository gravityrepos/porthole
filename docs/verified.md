# Verified on hardware

What has been run on a physical phone, on which phone, and what it showed.
Emulator results are not recorded here; an emulator is a fixture.

Three device sessions exist. Two were on a Pixel 10 Pro XL on 2026-09-14 and
covered narrow questions. The third, on 2026-09-15, is the broad pass GRA-67
asks for and is written out in full below.

---

## Device 1 — Pixel 9 Pro Fold (2026-09-15)

```
ro.product.model          Pixel 9 Pro Fold
ro.build.fingerprint      google/comet_beta/comet:17/CP31.260623.012/16064790:user/release-keys
ro.build.version.release  17
ro.build.version.sdk      37
```

Session 15:19–17:00 local (America/Chicago). Build under test: `main` at
`1263738`, worktree `porthole-wt/GRA-67`. Sample installed as
`:sample:installRoomDebug` — `Installing APK 'sample-room-debug.apk' on
'Pixel 9 Pro Fold - 17'`. The MCP server was the real built `dist/index.js`
driven over a real stdio MCP handshake by a throwaway client, never the test
harness. `porthole_status` was read before and after every group of calls and
only groups whose connection state matched either side are reported.

**The phone was folded for the whole session.** `dumpsys display` shows the
inner display `state OFF` and the outer display (`1080 x 2424`, `displayId 0`)
`state ON` with `mActiveRenderFrameRate=120.00001` and modes 120/60. The panel
under test was therefore the cover display, also at 120 Hz, so the 8.33 ms
budget is the same one the ticket asks about.

### What was observed

**Connection and identity.** `porthole_status` reported `state: connected`,
`com.example.shop`, `Google Pixel 9 Pro Fold`, `sdkInt 37`, and thirteen
collectors: recompositions, semantics_tree, state, inflight, logs, nav_state,
frames, main_thread, workmanager, memory, device, exit_info, autowire.

**Sessions on disk (GRA-53).** Two session directories were created under
`mcp/.porthole/sessions/`, named
`com.example.shop_866ad940dae728f5_<startedAt>`, each holding
`events.ndjson`, `meta.json` and `watermark.json`. `porthole sessions` listed
both with real spans and sizes: 316 events / 77.9 KB and 44 events / 10.7 KB.

**Collectors produced plausible numbers, not merely present.** Over one
180-second window after three driven checkout cycles:
`http.calls 35` of which `http.failed 4` — all four `POST /v1/checkout → 402`,
which is the failure the sample is written to produce; `http.p95Ms 501`,
matching the sample's half-second stub latency; `db.queries 28` with
`db.onMainThread 0` and `db.p95Ms 2`; `work.runs 7` with `work.retries 4`;
`recompose.total 93`; `memory.peakHeapMb 24` against a 256 MB heap max.
`recompositions` named `Cart.PromoField` as the worst node at 34, attributed
to writes to a specific unnamed state object.

**`system_context` parses this device's AOSP shapes correctly.** Twelve
thermal sensors read back with real values (`LITTLE 32°C`, `BIG 32°C`,
`G3D 31°C`, `battery 25.9°C`), `throttling: "NONE"`, and per-core cpufreq at
`820000` of `1950000` kHz under governor `sched_pixel`. GRA-67's open question
2 — whether the four `dumpsys`/cpufreq parsers survive a real device — is
answered yes for this one.

**Navigation back stack on a real screen.** `nav_state` reported
`At cart/{cartId} with 3 entries on the stack`, with the current entry's
`args: {"cartId":"88213"}` resolved from the pattern, lifecycle states
(`home` CREATED, `cart/{cartId}` RESUMED), and the deep link
`android-app://androidx.navigation/cart/{cartId}`. This is a real back stack
read off a real device. It is **not** Navigation 3: the sample uses
`androidx.navigation.compose`'s `NavHost` with `Porthole.registerNavController`,
and `PortholeBackStack` — the Navigation 3 entry point — has no caller anywhere
outside the runtime and its no-op twin. See GRA-186.

**Cold start and warm start.** `am start -W` after a reinstall reported
`LaunchState: COLD, TotalTime: 451, WaitTime: 453`; a later relaunch after the
process was killed reported `LaunchState: COLD, TotalTime: 541`.

**A real, system-declared ANR.** The system declared it, not Porthole:

```
WindowManager: ANR in Window{cbccf8c com.example.shop/com.example.shop.ui.MainActivity}.
  Reason:Input dispatching timed out (... is not responding. Waited 5005ms for MotionEvent).
ActivityManager: ANR in com.example.shop (com.example.shop/.ui.MainActivity)
```

The OS then recorded the exit:

```
reason=6 (ANR) subreason=0 status=0
trace=/data/system/procexitstore/anr_2026-09-15-15-32-45-014.gz
description=user request after error: Input dispatching timed out (... Waited 5005ms for MotionEvent).
```

**The shipped sample cannot produce this on its own.** Its only main-thread
block is `Thread.sleep(450)` in `CartViewModel.blockTheMainThread()`, and
450 ms is far below the 5 s input-dispatch timeout. Three injection strategies
failed against it: a 30-tap device-side loop, 25 parallel `input tap` calls
(rejected by `InputDispatcher` as `Invalid DOWN event - pointers already
down`), and `monkey --throttle 0 -v 400` (400 events injected in 181 ms, no
stall). The ANR above was obtained by raising that one sleep to 9000 ms,
rebuilding, and reinstalling; **that edit was reverted before commit and is not
in the tree.** See GRA-185.

**Exit reporting (GRA-58).** After relaunching, `porthole_status` carried:

```
"exits": { "recent": [ {
  "reason": "REASON_ANR",
  "timestamp": "2026-09-15T20:33:43.769Z",
  "versionName": "1.4.2", "versionAssumed": true,
  "topAppFrame": "com.example.shop.ui.CartViewModel.blockTheMainThread(CartViewModel.kt:148)"
} ] }
```

The top app frame is the blocking method at the exact line that was blocking.
`porthole_status { exitTrace: 1789504423769 }` returned the full trace, 136,234
characters, beginning `Subject: Input dispatching timed out ... Timeout: 5005`
with the build fingerprint and the full thread dump. The `exitTrace` argument
takes a **number**, while `exits.recent[].timestamp` is an ISO **string**;
quoting the reported timestamp straight back is a validation error. See
GRA-187.

**The watermark banner across unrelated tools (GRA-55).** One server process,
no timeline UI open (port 8678 unbound, checked). `nav_state` first — no
banner, `sinceLast: null`. A real ANR was then forced. The next call, `state`,
an unrelated tool, led with:

```
⚠ Since your last call: 1 database query ran on the main thread, main thread
blocked for 8917ms. Call `findings {"since":"last"}`.
```

and carried `sinceLast: {"errors":2,"firstAt":10395958,"lastAt":10450705}`.
The 8917 ms it measured is the 9000 ms block, independently observed by the
watchdog to within 83 ms. The banner names the stall that caused the ANR
rather than the word "ANR", because the app survived this one (the dialog was
dismissed with Wait) and so no exit existed to name.

**Trim-memory is observed.** `am send-trim-memory com.example.shop
RUNNING_CRITICAL` (exit 0) produced the finding "the system asked for memory
back 1 time — worst level: running critical". `COMPLETE` was refused by the OS
with `Unable to set a background trim level on a foreground process`, so the
background-pressure path was not exercised. No low-memory **kill** was
produced, so `REASON_LOW_MEMORY` remains unverified on hardware.

**Redaction.** Zero occurrences of `do-not-log` and zero occurrences of the
device serial across everything Porthole emitted: both session trees, both
`.pftrace` captures, the saved moment JSON, the rendered report, the captured
logcat and every saved tool output. The only file in the artifact directory
containing the serial is the driving script this pass wrote itself.

### What was wrong

1. **The frame budget in `findings` is wrong whenever the window does not
   contain app startup.** Proven both ways on this device, minutes apart, same
   session, same 120 Hz panel:

   - `findings { sinceMs: 400000 }` → `71 frames missed their deadline
     (budget 8.3ms at 120Hz)` — correct.
   - `findings { sinceMs: 180000 }` → `48 frames missed their deadline
     (budget 16.7ms at 60Hz)` — wrong, and reproduced in two further windows.

   `findings` reads the refresh rate from the `device`/`profile` event, which
   the runtime emits once at startup, and falls back to 60 when that event is
   not inside the requested window (`trace.ts:648,651`). The missed-frame
   *count* comes from the device, which used the correct 8.33 ms interval, so
   the number is right while the budget printed beside it is off by 2×, stated
   as fact with `confidence: "observed"`. It propagates into saved artifacts:
   `porthole report` headed the saved moment
   `Google Pixel 9 Pro Fold (60Hz)`. This is GRA-67's own acceptance criterion
   "at least one device at 90Hz or above, with frame findings using the right
   budget", and it fails. See GRA-188.

2. **A Perfetto capture on this device carried no Porthole labels.** Two
   ten-second captures while driving the app, one with the package defaulted
   and one with `packages: ["com.example.shop"]` named explicitly, both
   returned `portholeLabels: 0` and the prose "No Porthole labels found". The
   captures are otherwise real — 4.2 MB, `sched`/`gfx`/`am`/`binder_driver`
   data, the app's own process present as `om.example.shop` (kernel `comm` is
   16 bytes, as expected). Checked the honest way, by reading the trace rather
   than a tag property: the only `porthole` strings in either binary are the
   runtime's own **thread** names (`porthole-memory`, `porthole-recomp`,
   `porthole-watchd`, `porthole-writer`), and there are no `porthole: ` atrace
   section names at all. The connected collector list also contains no atrace
   or span collector. This contradicts the 2026-09-14 Pixel 10 Pro XL result
   and fails GRA-67's "a Perfetto capture with Porthole labels present, on both
   devices". See GRA-189.

3. **`frames` and `findings` print the same quantity differently.** `frames`
   reports `frameIntervalMs: 8` and says "budget 8ms"; `findings` says
   "8.3ms at 120Hz". The runtime keeps full precision internally
   (`frameIntervalNanos`, used for `missedFrames`) and truncates only for
   display, so classification is unaffected — but two tools describing one
   panel disagree in print. Folded into GRA-188.

4. **The first `findings` call of a session examines a zero-length window.**
   On the first call `frames` says "First call this session: `since: last` has
   nothing to start from yet, so this is the whole buffer" and reports on all
   of it; `findings` instead resolved `{from: 9632051, to: 9632051, ms: 0}` and
   answered "Nothing crossed a threshold in the 0s examined (1 events)" while
   92 events sat in the buffer. It does disclose the window, so it is not
   dishonest, but the two tools' first-call defaults differ. See GRA-190.

### What was not reached, and why

- **A blocking GC — not induced.** Two `gc` events were observed
  (`{count:1, heapUsedMb:7, heapMaxMb:256, freedMb:5}` and one freeing 17 MB),
  and neither carried `blocking` or `pausedMs`: the runtime only emits those
  when ART's `art.gc.blocking-gc-count` / `-time` counters move, and no
  stop-the-world collection happened. `memory.blockingGcMs` was 0 in every
  window measured. The sample has no allocation-storm affordance and its heap
  peaked at 24 MB of a 256 MB maximum, so there is nothing in it that can force
  one. `am send-trim-memory RUNNING_CRITICAL` did not produce one either.
  **The `blocking-gc` finding remains never-observed on hardware.**
- **Thermal throttling — not attempted, deliberately.** It is the founder's
  daily phone and reaching a throttling state means deliberately overheating
  it. `system_context` read `throttling: "NONE"` throughout at 32 °C.
- **Deep-sleep clock divergence (GRA-113's device AC) — not reached.** The time
  box ended first.
- **The timeline UI on device data (GRA-114 / 115 / 116 device ACs) — not
  reached.** The time box ended first. No claim either way.
- **The 30-minute streamed read-back under `--max-old-space-size=64` — not
  run.** The box could not hold a 30-minute recording.
- **A second physical device — not covered by this session.** GRA-67 asks for
  two devices end to end. See below for what the other device actually has.

---

## Device 2 — Pixel 10 Pro XL (2026-09-14), from two narrower sessions

Both sessions are recorded in full in the team scratchpad
(`DEVICE-VERIFY.md`, `DEVICE-VERIFY-2.md`). Neither was an end-to-end pass, so
this device does **not** satisfy GRA-67's two-device criterion; it is
summarised here so the record is in one place.

```
ro.product.model      Pixel 10 Pro XL
ro.build.fingerprint  google/mustang_beta/mustang:17/CP41.260814.003.B1/16166531:user/release-keys
release 17 · sdk 37 · serial ending 05BB · user build (ro.debuggable = 0)
```

**Session A — 2026-09-14, ~10:22–10:40.** Install, connect and capture were
proven: the real Kotlin collectors emit and the real TypeScript parser accepts
what they emit. `findings` on first call reproduced GRA-152, worse than the
ticket predicted. **The device physically detached at ~10:33, mid-run**, so the
Perfetto / `ask_system_trace` step was never started. One install defect was
recorded.

**Session B — 2026-09-14, 23:35–23:46.** A stability-gated sampling run,
106,897 stable samples over four runs, aimed at GRA-163 and the B3 bug. It
found zero tools reporting `connected: true` about a dead process in any state,
including 545 `handshaking` samples taken against an app that was not running.
A force-stop's socket close reached the server 324 ms after the command, and
the reported `disconnectedAt` fell 1 ms after the last live sample and 4 ms
before the first post-mortem one. `capture_system_trace` and `system_context`
were deliberately never invoked in that session.

**What that device contributed to the shared facts:** `perfetto --app <pkg>`
works on Android 17 / API 37 and a capture there carried `porthole: http`,
`recompose` and `screen` slices with real durations — which is precisely what
the Pixel 9 Pro Fold failed to reproduce on 2026-09-15 (see GRA-189). The
CLOCK_MONOTONIC ↔ CLOCK_BOOTTIME offset was measured at 12,272.83 s and held
to 183 ns across nine minutes, so one `clock_snapshot` per capture is enough.

---

## Standing gaps after 2026-09-15

- Two devices end to end: **not met.** One broad pass (Pixel 9 Pro Fold) and
  two narrow sessions on a second device.
- A blocking GC observed: **not met**, with the reason written above.
- Perfetto labels on both devices: **not met** — present on the Pixel 10 Pro XL
  on 09-14, absent on the Pixel 9 Pro Fold on 09-15.
- Thermal throttling reached: **not met**, deliberately.
- Navigation 3's back stack: **not met** — the sample does not use Navigation 3.
- A cheap or old device: never attached.
- Multi-process apps and Compose versions other than the catalog's: untouched.
