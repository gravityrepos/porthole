# Provenance

Real `trace_processor_shell` stdout for five of the eight questions — not hand-written or
hand-edited (GRA-111's rule: a self-written fixture tests the format assumed, not the one
that arrives). The other three (`startup.csv`, `monitor_contention.csv`, `cpu.csv`) are
hand-written, and say so, in their own section below — GRA-111's rule is why that has to be
said plainly rather than left for a reader to notice.

## The capture

- **Device**: Google Pixel 10 Pro XL (`mustang_beta`), Tensor G5, Android 17 (SDK 37).
  Build fingerprint `google/mustang_beta/mustang:17/CP41.260814.003.B1/16166531:user/release-keys`.
  Read from the trace's own `metadata` table (`android_build_fingerprint`,
  `android_device_manufacturer`, `android_sdk_version`, `android_soc_model`), not asserted —
  this is the same hardware named in `BRIEFING.md`'s hard-won facts as verified 2026-09-14.
- **App**: `com.example.shop` (the sample app), `upid` 19, `pid` 15712 in this trace.
- **Captured**: 2026-09-11T20:19:00.493Z (from the capture file's own name,
  `porthole-1789157940493.pftrace` — epoch ms — and cross-checked against the trace's own
  `clock_snapshot` REALTIME reading, which agrees to the second). `trace_uuid`
  `23bdaca4-6d4f-2a9d-fa24-a0737327468a`.
- **File**: `porthole-1789157940493.pftrace`, 9,770,181 bytes. One of three real captures of
  the sample app taken that session (`porthole-1789157802606.pftrace`,
  `porthole-1789158282555.pftrace` are the other two, already referenced by
  `perfetto-stdout.test.ts`'s end-to-end `askTrace` test). Not committed — `.porthole/` is
  gitignored repo-wide; a capture this size has no business in git history. Copied in for this
  session only, from `C:\Users\james\dev\porthole\mcp\.porthole\traces\`.

## How these five files were produced (GRA-113)

GRA-113 added `MIN(ts)`/`MAX(ts)` to four of the five questions (`jank`, `binder`, `render`,
`slices` — see `QUESTIONS`' own comment in `perfetto.ts` for which and why), so those four
needed regenerating against the real binary with the new SQL. `thread_states`' SQL did not
change and `thread_states.csv` is untouched from before this ticket.

For each of the four changed questions, the exact SQL text from `perfetto.ts` (after
`$from`/`$to`/`$package` substitution) was written to a `.sql` file and run directly —
one question, one invocation, matching this directory's existing convention (not the
marker-batched shape `askTrace` produces at runtime; `matchBatch`'s own tests in
`perfetto-stdout.test.ts` build that shape by wrapping these same files, rather than
capturing it separately):

```
trace_processor_shell query -f <question>.sql porthole-1789157940493.pftrace > <question>.csv
```

with `trace_processor_shell` the plugin's own pinned v58.2 (Gradle task
`portholeTraceProcessor`'s cache, `~/.porthole/trace-processor/v58.2/trace_processor_shell.exe`
on this machine — SHA-256 verified at fetch time by that task, not re-verified here), and
`$from`/`$to` set to the whole trace's own bounds (`SELECT MIN(ts), MAX(ts) FROM slice`:
`542876129521493` to `542887021098923`) so each question answers over everything the capture
has to say, the same scope the pre-existing fixtures used.

stdout was redirected straight to the `.csv` file with no further editing — CRLF and all,
which is why this directory carries its own `.gitattributes` (`*.csv -text`) so git does not
rewrite the line endings on checkout. Byte-identical, not merely value-identical: `xxd`-compared
before and after the copy into `fixtures/stdout/`.

Row counts changed for `binder` versus the pre-GRA-113 fixture (3 rows before, 4 now) — this
capture's own binder activity across the trace's full bounds, not an edited value;
`perfetto-stdout.test.ts`'s row-count assertion was updated to match. `jank`, `render` and
`slices` kept the same row counts as before (3, 30, 200) with two new trailing columns each.

## `startup.csv`, `monitor_contention.csv`, `cpu.csv` — hand-written (GRA-61)

GRA-61 added three questions (`startup`, `monitor_contention`, the merged `cpu`). Its
acceptance criteria ask for each one validated against a real device trace; none was
available to this session — no `.pftrace` anywhere under `~/projects` (checked, including
the main checkout's `mcp/.porthole`, which GRA-67's device pass was said to have populated
and did not, at least not in a form this session could find), and `.porthole/` is
gitignored and per-checkout in any case, so even a prior session's capture would not have
carried over into this worktree.

What *was* available, and used: the real pinned v58.2 binary. `TraceProcessor.kt`'s own
pinned SHA-256 for `mac-arm64` (`9dbd484a...27d1507`) was fetched fresh from
`https://github.com/google/perfetto/releases/download/v58.2/mac-arm64.zip`, verified against
that exact pin with `shasum -a 256` before extracting anything, and used to run all three
new questions' exact SQL text (after `$from`/`$to`/`$package` substitution, and the full
eight-question batch in `buildScript`'s own marker-separated shape) against an empty trace.
Every one compiled and returned its expected header row with zero rows — `INCLUDE PERFETTO
MODULE android.startup.startups`, `android.startup.startup_breakdowns`,
`android.monitor_contention`, `linux.cpu.frequency` and `android.cpu.cluster_type` all
resolve at v58.2 with no pin bump, which was this ticket's first open question. That proves
the SQL compiles against the real binary; it does not, and cannot, prove what real values
come back, which needs a real trace this session did not have.

So these three files are hand-written — not captured, not edited from a capture — built to
the exact column set and quoting convention the five real files above establish (string
columns quoted, numeric columns bare unless the value is `[NULL]`, which is always quoted
regardless of the column's own type, matching `thread_states.csv`'s `io_wait` column
exactly), and CRLF line endings to match the more recent, GRA-113-regenerated four of the
five real files rather than `thread_states.csv`'s older LF. Each is built to exercise
something specific the real fixtures already prove the parser handles, applied to these
three questions' own shapes rather than invented ones:

- `startup.csv` — two startups. The first has a full breakdown (`bind_application`,
  `open_dex_files_from_oat`, `binder`, `launch_delay`, `monitor_contention`), matching the
  ticket's own list of what the platform's own attribution names. The second has no
  breakdown data at all, which is what `LEFT JOIN android_startup_opinionated_breakdown`
  actually produces for a startup nothing matched — one row, `reason`/`reason_dur` both
  `[NULL]` — rather than an invented edge case.
- `monitor_contention.csv` — one row blocking the main thread (comm-truncated blocking
  thread name, `DefaultDispatch` from a 27-character coroutine dispatcher name, the same
  16-byte truncation `thread_states.csv`'s `"om.example.shop"` already demonstrates, applied
  to a name a real Kotlin coroutine app would actually have) and one row that does not
  (`waiter_count` `[NULL]`, standing in for the module's own regex extraction failing to
  parse a slice name shaped slightly differently than it expects).
- `cpu.csv` — `main_thread` rows placing the app on a little core at low frequency (the
  `trace-cpu-placement` gate firing) and `other` rows naming a second, real process
  (`com.example.shop:sync`) rather than only the OS's own `system_server`, with `[NULL]` in
  every column the other `kind` does not use.

None of these three exercises an embedded quote — unlike a slice or method name, nothing
any of the three questions' own columns select is developer-supplied atrace text, so a real
capture would not put one there either. That edge is already pinned, and stays pinned, by
`perfetto-stdout.test.ts`'s existing generic `parseRows` tests, which are not tied to any
one question's fixture.

**Left for the hardware pass**: running all three questions' real SQL, and the merged
eight-question batch, against an actual device capture — confirming real values parse the
same way these hand-built ones do, and, for `cpu`, that the gate reads as intended (silent)
against a real idle-device trace, not only against the hand-built fixture rows
`perfetto.test.ts`'s "trace-cpu-placement" tests use to pin the threshold math.
