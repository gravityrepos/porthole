# tools/avd

A pinned AVD, reproducible on a laptop and (via the parameters here) in CI.
Full narrative in `README.md#emulator`; this file is the quick reference.

## What's here

- `avd-spec.json` — the single pinned parameter file. Package id, the
  system image's own build id/incremental (read from `build.prop`, not just
  the API level), device profile, and the `config.ini` values that make two
  runs comparable (RAM, cores, GPU mode, density, refresh rate, snapshots
  off). A CI workflow reads the `ci` block to fill in
  `reactivecircus/android-emulator-runner`'s inputs — see that block's
  `$comment` for the one thing it cannot pin the same way this script does,
  and the post-boot check that closes the gap.
- `create.sh` — creates/converges the AVD on macOS, Linux, or Git Bash on
  Windows. Idempotent: safe to run again, and re-applies the pinned
  `config.ini` keys each time rather than only at creation.
- `create.ps1` — the same thing, native PowerShell, for a Windows laptop.

## Usage

```
# Windows
powershell -File tools\avd\create.ps1

# macOS / Linux / Git Bash
bash tools/avd/create.sh
```

Both require `ANDROID_HOME` or `ANDROID_SDK_ROOT` to point at an SDK with
`cmdline-tools` installed, and Node.js on PATH (`create.sh` only — used
solely to parse `avd-spec.json`, no other dependency). Downloading the
system image the first time is a real OS-image download; expect it to take
minutes, not seconds.

Boot the result yourself:

```
%ANDROID_HOME%\emulator\emulator.exe -avd porthole_avd_api35 -no-snapshot -gpu swiftshader_indirect
```

If a physical device is also attached, target the emulator explicitly
(`adb -s emulator-5554 ...`, or `ANDROID_SERIAL`) — with two devices
attached, an untargeted `adb`/Gradle install command fails outright or,
worse, succeeds against the wrong one.

## Why a build id, not just an API level

`system-images;android-35;google_atd;x86_64` names a package, not a fixed
set of bits. `avd-spec.json` also records the image's `ro.build.id` and
`ro.build.version.incremental`, read straight out of the downloaded image's
`build.prop`. Both scripts print a warning if what actually installed
doesn't match the recorded pin — that is the one signal that would tell you
Google has republished the image and this spec needs a deliberate re-pin.

## CI hand-off (GRA-101)

This ticket owns `tools/avd/` and `README.md#emulator` only —
`.github/workflows/*` belongs to GRA-101. `avd-spec.json`'s `ci` block is
written for that job to consume: the `inputs` map straight onto
`reactivecircus/android-emulator-runner`'s inputs, and
`postBootVerification` names the property and value a post-boot step should
assert against `adb shell getprop` before treating the run as trustworthy.
Nothing under `.github/` was created or edited by this ticket.
