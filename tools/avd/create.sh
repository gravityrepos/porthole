#!/usr/bin/env bash
#
# Creates (or converges) the pinned Porthole AVD from tools/avd/avd-spec.json.
#
# THE PIN IS THE POINT. "android-35 google_atd x86_64" is a moving target --
# Google can and does republish a system image under the same package id with
# different bits behind it, and an AVD built from a bare API level drifts
# under you without warning. avd-spec.json additionally records the exact
# build (systemImage.buildId / buildIncremental, read from the image's own
# build.prop) so a re-run of this script, or a CI job months from now, can be
# checked against a known artefact instead of trusted on the tool's say-so.
#
# A CAPTURE FROM THIS AVD IS NOT A CAPTURE FROM A DEVICE. An emulator's
# absolute numbers -- frame times, query latencies, GC pauses -- come from
# software GPU rendering, a virtualised CPU and a host that is doing other
# things, none of which resemble a Pixel's silicon. That is not a caveat to
# footnote once; it is a category error waiting to happen every time someone
# is tempted to diff an emulator run against a physical-device baseline (or
# vice versa). Porthole's own `compare` already refuses cross-device
# comparisons it can detect (see mcp/src/report.ts, comparability()) --
# treat that refusal as intentional, not a bug to work around. The value of
# this AVD is comparing an emulator run against an earlier emulator run: the
# shape of the findings, and whether a change moved them, not the absolute
# numbers.
#
# Idempotent: re-running this script on an AVD that already exists does not
# recreate it, but DOES re-apply every pinned config.ini key, so a laptop's
# AVD from three months ago converges to the same knobs as one created today
# from the same spec. That is the actual idempotency contract -- "safe to
# run again", not "does nothing the second time".
#
# Usage: tools/avd/create.sh
# Reads: tools/avd/avd-spec.json
# Requires: ANDROID_HOME or ANDROID_SDK_ROOT set, or the SDK at the platform
#           default (see resolve_sdk_root below); Node.js on PATH (used only
#           to parse the JSON spec -- no other dependency).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPEC="$SCRIPT_DIR/avd-spec.json"

if [ ! -f "$SPEC" ]; then
  echo "error: spec file not found at $SPEC" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required to read avd-spec.json (parsing only, no runtime deps)" >&2
  exit 1
fi

# One node invocation, one line of shell-safe KEY=VALUE output per field, so
# the rest of this script stays plain bash instead of growing a JSON parser.
spec_vars() {
  node -e '
    const spec = require(process.argv[1]);
    const lines = [
      ["AVD_NAME", spec.avdName],
      ["PACKAGE_ID", spec.systemImage.packageId],
      ["BUILD_ID", spec.systemImage.buildId],
      ["BUILD_INCREMENTAL", spec.systemImage.buildIncremental],
      ["DEVICE_PROFILE", spec.device.profile],
      ["RAM_MB", spec.config.ramSizeMb],
      ["CORES", spec.config.cpuCores],
      ["GPU_MODE", spec.config.gpuMode],
      ["GPU_ENABLED", spec.config.gpuEnabled ? "yes" : "no"],
      ["LCD_DENSITY", spec.config.lcdDensity],
      ["REFRESH_HZ", spec.config.refreshRateHz],
      ["SNAPSHOTS", spec.config.snapshotsEnabled ? "yes" : "no"],
    ];
    for (const [k, v] of lines) {
      console.log(`${k}=${JSON.stringify(String(v))}`);
    }
  ' "$SPEC"
}

eval "$(spec_vars)"

resolve_sdk_root() {
  if [ -n "${ANDROID_HOME:-}" ]; then
    echo "$ANDROID_HOME"
    return
  fi
  if [ -n "${ANDROID_SDK_ROOT:-}" ]; then
    echo "$ANDROID_SDK_ROOT"
    return
  fi
  case "$(uname -s)" in
    Darwin) echo "$HOME/Library/Android/sdk" ;;
    Linux) echo "$HOME/Android/Sdk" ;;
    *) echo "${LOCALAPPDATA:-}/Android/Sdk" ;;
  esac
}

SDK_ROOT="$(resolve_sdk_root)"
if [ ! -d "$SDK_ROOT" ]; then
  echo "error: no Android SDK found at $SDK_ROOT (set ANDROID_HOME/ANDROID_SDK_ROOT)" >&2
  exit 1
fi

CMDLINE_BIN="$SDK_ROOT/cmdline-tools/latest/bin"
if [ ! -d "$CMDLINE_BIN" ]; then
  # Fall back to whatever versioned cmdline-tools directory exists.
  CMDLINE_BIN="$(find "$SDK_ROOT/cmdline-tools" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -r | head -n1)/bin"
fi
SDKMANAGER="$CMDLINE_BIN/sdkmanager"
AVDMANAGER="$CMDLINE_BIN/avdmanager"
[ -f "$SDKMANAGER" ] || SDKMANAGER="$SDKMANAGER.bat"
[ -f "$AVDMANAGER" ] || AVDMANAGER="$AVDMANAGER.bat"

if [ ! -f "$SDKMANAGER" ] || [ ! -f "$AVDMANAGER" ]; then
  echo "error: sdkmanager/avdmanager not found under $SDK_ROOT/cmdline-tools" >&2
  exit 1
fi

# --- 1. system image: install only if not already on disk ------------------
IMAGE_DIR="$SDK_ROOT/system-images/$(echo "$PACKAGE_ID" | tr ';' '/' | sed 's#^system-images/##')"
if [ -f "$IMAGE_DIR/source.properties" ]; then
  echo "system image already installed: $PACKAGE_ID"
else
  echo "installing system image: $PACKAGE_ID (this downloads an OS image; expect several minutes)"
  "$SDKMANAGER" --install "$PACKAGE_ID"
fi

# Record what actually landed on disk against what the spec pinned. A mismatch
# here means Google changed the bits behind this package id, or the spec is
# stale -- either way it is a finding, not something to silently proceed past.
ACTUAL_BUILD_ID="$(grep -o '^ro.build.id=.*' "$IMAGE_DIR/build.prop" 2>/dev/null | cut -d= -f2- || true)"
ACTUAL_INCREMENTAL="$(grep -o '^ro.build.version.incremental=.*' "$IMAGE_DIR/build.prop" 2>/dev/null | cut -d= -f2- || true)"
if [ -n "$ACTUAL_BUILD_ID" ] && [ "$ACTUAL_BUILD_ID" != "$BUILD_ID" ]; then
  echo "warning: installed image build id ($ACTUAL_BUILD_ID) does not match the pin in avd-spec.json ($BUILD_ID)" >&2
  echo "         this AVD will not be comparable to captures taken against the pinned build." >&2
fi
if [ -n "$ACTUAL_INCREMENTAL" ] && [ "$ACTUAL_INCREMENTAL" != "$BUILD_INCREMENTAL" ]; then
  echo "warning: installed image build incremental ($ACTUAL_INCREMENTAL) does not match the pin ($BUILD_INCREMENTAL)" >&2
fi

# --- 2. AVD: create only if it does not already exist -----------------------
AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
CONFIG_INI="$AVD_HOME/$AVD_NAME.avd/config.ini"

if [ -f "$CONFIG_INI" ]; then
  echo "AVD already exists: $AVD_NAME"
else
  echo "creating AVD: $AVD_NAME"
  # avdmanager asks whether to create a custom hardware profile; "no" keeps
  # the device profile's defaults, which we then override below anyway.
  echo "no" | "$AVDMANAGER" create avd \
    --name "$AVD_NAME" \
    --package "$PACKAGE_ID" \
    --device "$DEVICE_PROFILE"
fi

if [ ! -f "$CONFIG_INI" ]; then
  echo "error: expected config.ini at $CONFIG_INI after creation, not found" >&2
  exit 1
fi

# --- 3. config.ini: always converge the pinned keys --------------------------
# Applied on every run (not just at creation) so an AVD from an older run of
# this script ends up identical to one created fresh from today's spec.
set_ini_key() {
  local key="$1" value="$2"
  if grep -q "^${key} *=" "$CONFIG_INI"; then
    # In-place edit without relying on GNU-vs-BSD sed flag differences.
    tmp="$(mktemp)"
    awk -F= -v k="$key" -v v="$value" 'BEGIN{OFS="="} $1==k || $1==k" " {print k"="v; next} {print}' "$CONFIG_INI" > "$tmp"
    mv "$tmp" "$CONFIG_INI"
  else
    echo "${key}=${value}" >> "$CONFIG_INI"
  fi
}

set_ini_key "hw.ramSize" "$RAM_MB"
set_ini_key "hw.cpu.ncore" "$CORES"
set_ini_key "hw.gpu.enabled" "$GPU_ENABLED"
set_ini_key "hw.gpu.mode" "$GPU_MODE"
set_ini_key "hw.lcd.density" "$LCD_DENSITY"
set_ini_key "hw.lcd.refreshRate" "$REFRESH_HZ"
if [ "$SNAPSHOTS" = "yes" ]; then
  set_ini_key "snapshot.present" "yes"
else
  set_ini_key "snapshot.present" "no"
  set_ini_key "fastboot.forceColdBoot" "yes"
fi

echo ""
echo "AVD '$AVD_NAME' ready."
echo "  system image : $PACKAGE_ID"
echo "  build        : $BUILD_ID (incremental $BUILD_INCREMENTAL)"
echo "  ram/cores    : ${RAM_MB}MB / ${CORES}"
echo "  gpu mode     : $GPU_MODE"
echo "  density/hz   : $LCD_DENSITY / $REFRESH_HZ"
echo "  snapshots    : $SNAPSHOTS"
echo ""
echo "Boot it with, e.g.:"
echo "  \"$SDK_ROOT/emulator/emulator\" -avd $AVD_NAME -no-snapshot -gpu $GPU_MODE"
echo ""
echo "Remember: this is an emulator, not a device. Its absolute timings are not"
echo "a Pixel's. Compare emulator runs to emulator runs; see README.md#emulator."
