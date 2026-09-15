# Provenance

Real `trace_processor_shell` stdout, not hand-written or hand-edited (GRA-111's rule: a
self-written fixture tests the format assumed, not the one that arrives).

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
