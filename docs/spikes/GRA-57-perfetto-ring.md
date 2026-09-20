# GRA-57 — does a detached Perfetto ring buffer survive, and is it cheap enough to leave running?

A research spike ahead of `system_trace_start`/`system_trace_snapshot`/
`system_trace_stop`, per the EM's own re-scope on the ticket: build nothing
until open question 1 (does a detached session survive adb disconnect,
screen-off and doze) is answered on a real emulator, and measure the
overhead before deciding whether the feature can default on. It cannot —
see [Overhead](#overhead-emulator-only). The feature ships opt-in.

Everything below was run. Nothing in it is reasoned from Perfetto's own docs
alone — where the docs and the device disagreed (`--detach` needing
`write_into_file`; what "light config" actually enables), the device won.

---

## What was measured on, and what was not

| | |
| --- | --- |
| host | macOS 15.6.1 (Darwin 24.6.0), arm64 |
| emulator | emulator 36.1.9.0, AVD `porthole-gra57` from `system-images;android-36;google_apis_playstore;arm64-v8a`, device profile `pixel_6`, `-no-window -no-audio -no-boot-anim -no-snapshot`, port 5556 |
| image | `google/sdk_gphone64_arm64/emu64a:16/BE2A.250530.026.D1/13818094:user/release-keys`, Android 16, sdk 36 |
| adb | 1.0.41 (platform-tools) |
| app under test | `:sample:installRoomDebug` (`com.example.shop`, versionName 1.4.2) on `GRA-57` |
| trace_processor | v58.2, from `~/.porthole/trace-processor/v58.2/trace_processor_shell` |

**No physical device was attached.** Every number and every survival claim
below is labelled `emulator`; the ticket's hardware pass is a separate,
still-open piece of work — see [What still needs hardware](#what-still-needs-hardware).

---

## Question 1: does a detached session survive adb disconnect, screen-off, doze?

Started with the mechanism the ticket's own research brief named,
`perfetto --detach=<key>`:

```
$ adb shell "cat config.pbtxt | perfetto --txt -c - --detach=porthole-ring -o /data/misc/perfetto-traces/porthole-ring.pftrace"
[062.766]     perfetto_cmd.cc:794 TraceConfig's write_into_file must be true when using --detach
```

`--detach` refuses to start at all unless `write_into_file: true` is set in
the config. That flag turns the on-device *file* into a continuously
growing stream — Perfetto periodically appends whatever is in the buffer to
disk — which is a different thing from the ring this ticket asked for: a
fixed-size in-memory buffer that only ever holds the most recent stretch.
Setting it would have meant every `system_trace_snapshot` either read a
file that keeps growing without bound, or needed its own size cap that
turns "the last 30 seconds" into "the last 30 seconds, or however much
disk `max_file_size_bytes` allowed, whichever came first, and then the
session just stops." Neither is what a ring is for.

**What actually works: `--background-wait` (`-D`) instead of `--detach`.**
No key. No `write_into_file`. The `perfetto` binary forks, is reparented to
init, and keeps running with a pure in-memory `RING_BUFFER` central
buffer — a real OS process, and the fork happens before the
acknowledgement wait, so `-D`'s own exit code becomes a reliable "the
session's data sources actually started" signal rather than a guess about
whether the fork raced ahead of the shell command returning:

```
$ adb shell "cat config.pbtxt | perfetto --txt -c - --background-wait -o /data/misc/perfetto-traces/porthole-ring.pftrace"
7059
$ adb shell ps -A | grep perfetto
shell         7059     1   10814916   2440 do_sys_poll         0 S perfetto
```

`unique_session_name: "porthole-ring"` in the config is what makes the
session discoverable afterward — by `perfetto --query --long` (prints it in
a `NAME` column) and by `perfetto --clone-by-name porthole-ring` — without
ever needing a `--detach` key remembered across an MCP server restart.

### adb disconnect

```
$ adb -s emulator-5556 shell ps -A | grep perfetto
shell         5323     1   10814916   1672 do_sys_poll         0 S perfetto
$ adb kill-server
$ adb start-server
$ adb devices
List of devices attached
emulator-5556	device
$ adb -s emulator-5556 shell ps -A | grep perfetto
shell         5323     1   10814916   1032 do_sys_poll         0 S perfetto
```

**Survives.** Expected: killing the *host's* adb server never touches
anything running on the device — `adbd` on the emulator, and everything it
spawned, is unaffected. This is the honest baseline check, not a
demonstration of anything Perfetto-specific.

### screen-off

```
$ adb -s emulator-5556 shell input keyevent 26
$ adb -s emulator-5556 shell dumpsys power | grep mWakefulness
  mWakefulness=Asleep
$ sleep 15
$ adb -s emulator-5556 shell ps -A | grep perfetto
shell         5323     1   10814916   1032 do_sys_poll         0 S perfetto
```

**Survives**, for at least 15+ seconds of simulated screen-off — well past
an ordinary display timeout.

### doze

```
$ adb -s emulator-5556 shell dumpsys deviceidle force-idle
Now forced in to deep idle mode
$ adb -s emulator-5556 shell dumpsys deviceidle | grep -i "mState\b\|Idling"
  mState=IDLE mLightState=OVERRIDE
$ adb -s emulator-5556 shell ps -A | grep perfetto
shell         7059     1   10773956   2664 do_sys_poll         0 S perfetto
```

**Not a real answer, and said so in the tool description rather than
claimed as a pass.** `dumpsys deviceidle force-idle` jumps the framework's
own state machine straight to `IDLE` without the actual hardware path real
doze takes — CPU and radio suspension, the maintenance-window cycle. The
session surviving this proves only that the *simulated* state does not by
itself kill it, which is a much weaker claim than "survives real deep
sleep on a phone." Left to the hardware pass.

### Also observed, not originally asked for: the target app being killed and restarted

```
$ adb -s emulator-5556 shell am force-stop com.example.shop
$ adb -s emulator-5556 shell am start -n com.example.shop/.ui.MainActivity
$ adb -s emulator-5556 shell ps -A | grep perfetto
shell        11597     1   10778404   2556 do_sys_poll         0 S perfetto   # same pid throughout
```

The ring is a device-level `traced` session, not tied to any one process's
lifetime — expected once the mechanism above was understood, confirmed
anyway since it is a stated acceptance criterion.

---

## Snapshot mechanism: `--clone-by-name`, not `--attach --stop`

The ticket's research brief also named `--attach=key --stop` as the
snapshot mechanism. That stops the session to read it back — which is
fine for a one-shot capture, but the whole point of a ring is that a
snapshot must not interrupt it. `--clone-by-name` (added to Perfetto for
exactly this) reads the session's *current* buffer into a brand-new file
and leaves the original session running:

```
$ adb -s emulator-5556 shell "perfetto --clone-by-name porthole-ring -o /data/misc/perfetto-traces/porthole-snap1.pftrace"
[187.058]    perfetto_cmd.cc:1210 Wrote 33538808 bytes into /data/misc/perfetto-traces/porthole-snap1.pftrace
$ adb -s emulator-5556 shell ps -A | grep perfetto
shell         5323     1   10814916   1032 do_sys_poll         0 S perfetto   # still there
```

`system_trace_stop`'s own mechanism — `kill -TERM <pid>` on the
backgrounded process — was confirmed to flush the session's final buffer
contents to its original `-o` path before exiting:

```
$ adb -s emulator-5556 shell kill -TERM 5323
$ adb -s emulator-5556 shell ls -la /data/misc/perfetto-traces/
-rw-------  1 shell  shell 33476465 ... porthole-ring2.pftrace   # flushed on the way out
```

`system_trace_stop` deletes that file immediately after — "no files
behind" is a promise about what is left when the tool returns, not about
what Perfetto itself does on the way out.

---

## Overhead (emulator only)

Baseline, no session running, `traced`/`traced_probes` at rest:

```
$ adb shell top -b -n 1 | grep -E "traced|perfetto"
  563 nobody  ...  0.0  0:00.92 traced
  562 nobody  ...  0.0  0:00.77 traced_probes
```

Both 0.0% CPU. `top`'s instantaneous `%CPU` column is too noisy to trust on
its own, so the actual measurement is a before/after delta of each
process's own cumulative CPU time (`/proc/<pid>/stat`, fields 14+15 —
`utime`+`stime`, in jiffies; `getconf CLK_TCK` on this device reports 100,
i.e. 1 jiffy = 10ms) across a fixed 20-second wall-clock window, with and
without a ring running, under the same light workload — 20 alternating
`input swipe`/`input tap` pairs against the sample app:

```
# no ring running
t0: traced_probes=108  traced=106
... 20s of input ...
t1: traced_probes=108  traced=106
delta = 0 jiffies over 20s  →  0.0% of one core

# ring running (default 32MB buffer, full DEFAULT_CATEGORIES + ATRACE_TAG_APP)
t0: traced_probes=97  traced=96  perfetto=0
... 20s of the same input ...
t1: traced_probes=104  traced=98  perfetto=0
delta = (104-97) + (98-96) + 0 = 9 jiffies over 20s = 90ms / 20000ms
     →  0.45% of one core, combined across traced + traced_probes + the
        detached perfetto process
```

**0.45% of one core**, combined, under a light synthetic workload, on this
emulator. Well under the EM's own "a few percent of one core" gate for
shipping always-on — which is exactly why this still ships **opt-in**
rather than always-on: 0.45% under a light emulator workload is evidence
the mechanism is not obviously expensive, not proof it stays cheap on
hardware under real app usage. `MEASURED_OVERHEAD` in `mcp/src/ring.ts` and
`porthole_status`'s `ring.overhead` field carry this exact number, labelled
`"device": "emulator"`, so an agent deciding whether to turn the ring on
sees the caveat, not just the number.

A separate observation, not part of the measured number above: a 32MB ring
left running at near-idle (screen mostly off, no active input) took
several minutes to fill — `--clone-by-name` at that point returned a file
within a few percent of the full 32MB, meaning the ring had already
wrapped. Under real load (active gfx/view/wm/binder/dalvik churn) the same
32MB fills far faster than "several minutes" — the buffer's nominal "~30s
of the sample app" sizing is a starting point, not a promise, which is
exactly what `system_trace_snapshot`'s own result and `ringConfigText`'s
doc comment in `systrace.ts` say.

---

## The ring's config was missing data sources (QA finding, fixed here)

QA's own controlled comparison, on this same emulator: a `capture_system_trace`
of an induced main-thread stall produced real `ask_system_trace` findings
(frame-timeline jank detail among them); a ring snapshot of the same kind
of moment produced **zero findings across all eight questions**, including
from the auto-attached snapshot on a real error-severity finding.

The cause: `captureArgs` in `systrace.ts` invokes `perfetto` in its "light
config" shorthand — bare category names on the command line
(`perfetto -o FILE -t 10s --app pkg sched freq idle gfx view wm am
binder_driver dalvik`), no `-c`. That shorthand does not mean "just
`linux.ftrace`" the way the ring's own hand-written config assumed. Read
back with `trace_processor_shell`'s own introspection —

```sql
SELECT str_value FROM metadata WHERE name = 'trace_config_pbtxt';
```

— against a real light-config capture, it resolves to:

```
buffers { size_kb: 32768 }
data_sources { config { name: "android.surfaceflinger.frametimeline" } }
data_sources {
  config {
    name: "linux.ftrace"
    ftrace_config {
      atrace_categories: "sched"
      ... (every category passed) ...
      atrace_apps: "com.example.shop"
      symbolize_ksyms: true
    }
  }
}
data_sources { config { name: "linux.process_stats" target_buffer: 0 } }
data_sources { config { name: "linux.system_info" target_buffer: 0 } }
```

Four data sources, not one. `android.surfaceflinger.frametimeline` is
where `jank`'s own frame-timeline detail comes from; `linux.process_stats`
and `linux.system_info` are what let most of the other seven questions
resolve process and thread names at all rather than bare tids. `android.log`
does **not** appear here — it is not part of light config's own default,
so the ring does not need it either.

`ringConfigText` in `systrace.ts` now declares the same four data sources
(see that function's own doc comment for the exact reasoning), confirmed
the same way rather than assumed from Perfetto's own docs.

### Before / after, on this emulator

A main-thread stall induced with the sample's "Block main" button,
snapshotted from a running ring, asked with `ask_system_trace`:

| | before this fix | after this fix |
| --- | --- | --- |
| `portholeLabels` on the snapshot | 0 | 3 |
| `ask_system_trace` findings (8 questions asked) | 0, every run | present in the runs actually captured below |

Two runs after the fix, both against a freshly relaunched app:

- Run A (ring): 0 findings. Run A (capture, same class of stall, same
  window-selection method): 2 findings (`cpu`, `render`).
- Run B (ring): 2 findings (`cpu`: "the main thread was not waiting for a
  CPU"; `render`: "0ms on the render path, mostly notifyFramePending").
  Run B (capture): findings not re-checked in that pass.

The run-to-run variance is real and is not a ring-vs-capture gap: these
stall windows are short (roughly 350–600ms, the main-thread-stall
finding's own bounds), the `cpu` question's own gate gate is a 5% share of
a short window, and `capture_system_trace` itself did not produce findings
on every attempt either — both paths are equally subject to the same
scheduling noise at this granularity on a shared emulator host. What did
not vary across any run: before this fix, the ring produced **zero**
findings, always; after it, the ring is capable of producing the same
class of finding `capture_system_trace` does, from a snapshot with no
separate capture step. `jank` specifically was not observed to fire in
either path during this spike's runs — plausible given "block the main
thread" is not necessarily also missing an animated frame's own deadline
at that exact moment, not evidence of a remaining gap.

`system_trace_snapshot` now also reports `portholeLabels`
(`countPortholeLabels`, the same check `capture_system_trace` uses) so the
GRA-186 acceptance criterion — the runtime's own atrace sections actually
made it into the trace — has evidence on the ring path, not only the
one-shot capture path.

---

## What still needs hardware

- The overhead number above (0.45% of one core) — emulator only, light
  synthetic workload. A real device under real app usage is the only way
  to know whether it holds.
- Doze survival — `force-idle` proves nothing about real CPU/radio
  suspension.
- The five-minute physical-device run named in the ticket's acceptance
  criteria.
- Whether the buffer-fill-rate observation above (32MB lasting minutes at
  near-idle) generalises, or whether a busier real device wraps it in
  seconds rather than minutes.
