<#
.SYNOPSIS
  Creates (or converges) the pinned Porthole AVD from tools/avd/avd-spec.json.

.DESCRIPTION
  THE PIN IS THE POINT. "android-35 google_atd x86_64" is a moving target --
  Google can and does republish a system image under the same package id with
  different bits behind it, and an AVD built from a bare API level drifts
  under you without warning. avd-spec.json additionally records the exact
  build (systemImage.buildId / buildIncremental, read from the image's own
  build.prop) so a re-run of this script, months from now, can be checked
  against a known artefact instead of trusted on the tool's say-so.

  A CAPTURE FROM THIS AVD IS NOT A CAPTURE FROM A DEVICE. An emulator's
  absolute numbers -- frame times, query latencies, GC pauses -- come from
  software GPU rendering, a virtualised CPU and a host doing other things,
  none of which resemble a Pixel's silicon. That is not a footnote-once
  caveat; it is a category error waiting to happen the moment someone diffs
  an emulator run against a physical-device baseline (or vice versa).
  Porthole's own `compare` already refuses cross-device comparisons it can
  detect (mcp/src/report.ts, comparability()) -- that refusal is intentional,
  not a bug to route around. This AVD's value is comparing an emulator run
  against an earlier emulator run: the shape of the findings, and whether a
  change moved them, not the absolute numbers.

  Idempotent: re-running this script on an AVD that already exists does not
  recreate it, but DOES re-apply every pinned config.ini key, so an AVD from
  an earlier run of this script converges to the same knobs as one created
  fresh from today's spec. That is the actual idempotency contract -- "safe
  to run again", not "does nothing the second time".

.NOTES
  Requires ANDROID_HOME or ANDROID_SDK_ROOT, or the SDK at the platform
  default (%LOCALAPPDATA%\Android\Sdk). No dependency beyond PowerShell's
  built-in ConvertFrom-Json.
#>

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$specPath = Join-Path $scriptDir "avd-spec.json"
if (-not (Test-Path $specPath)) {
  Write-Error "spec file not found at $specPath"
  exit 1
}
$spec = Get-Content $specPath -Raw | ConvertFrom-Json

$avdName = $spec.avdName
$packageId = $spec.systemImage.packageId
$buildId = $spec.systemImage.buildId
$buildIncremental = $spec.systemImage.buildIncremental
$deviceProfile = $spec.device.profile
$ramMb = $spec.config.ramSizeMb
$cores = $spec.config.cpuCores
$gpuMode = $spec.config.gpuMode
$gpuEnabled = if ($spec.config.gpuEnabled) { "yes" } else { "no" }
$lcdDensity = $spec.config.lcdDensity
$refreshHz = $spec.config.refreshRateHz
$snapshotsEnabled = [bool]$spec.config.snapshotsEnabled

function Resolve-SdkRoot {
  if ($env:ANDROID_HOME) { return $env:ANDROID_HOME }
  if ($env:ANDROID_SDK_ROOT) { return $env:ANDROID_SDK_ROOT }
  return Join-Path $env:LOCALAPPDATA "Android\Sdk"
}

$sdkRoot = Resolve-SdkRoot
if (-not (Test-Path $sdkRoot)) {
  Write-Error "no Android SDK found at $sdkRoot (set ANDROID_HOME/ANDROID_SDK_ROOT)"
  exit 1
}

$cmdlineBin = Join-Path $sdkRoot "cmdline-tools\latest\bin"
if (-not (Test-Path $cmdlineBin)) {
  $versioned = Get-ChildItem (Join-Path $sdkRoot "cmdline-tools") -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
  if ($versioned) { $cmdlineBin = Join-Path $versioned.FullName "bin" }
}
$sdkmanager = Join-Path $cmdlineBin "sdkmanager.bat"
$avdmanager = Join-Path $cmdlineBin "avdmanager.bat"
if (-not (Test-Path $sdkmanager) -or -not (Test-Path $avdmanager)) {
  Write-Error "sdkmanager/avdmanager not found under $sdkRoot\cmdline-tools"
  exit 1
}

# --- 1. system image: install only if not already on disk -------------------
$imageRelPath = ($packageId -split ";")[1..3] -join "\"
$imageDir = Join-Path $sdkRoot "system-images\$imageRelPath"
$sourcePropsPath = Join-Path $imageDir "source.properties"

if (Test-Path $sourcePropsPath) {
  Write-Output "system image already installed: $packageId"
} else {
  Write-Output "installing system image: $packageId (this downloads an OS image; expect several minutes)"
  & $sdkmanager --install $packageId
}

$buildPropPath = Join-Path $imageDir "build.prop"
if (Test-Path $buildPropPath) {
  $buildProp = Get-Content $buildPropPath
  $actualBuildId = ($buildProp | Where-Object { $_ -match '^ro\.build\.id=' }) -replace '^ro\.build\.id=', ''
  $actualIncremental = ($buildProp | Where-Object { $_ -match '^ro\.build\.version\.incremental=' }) -replace '^ro\.build\.version\.incremental=', ''
  # Write-Warning rather than Write-Error here: with $ErrorActionPreference
  # = "Stop" (set at the top of this script), Write-Error is a terminating
  # error and would abort on the *first* mismatch found, before the second
  # check runs and before the combined failure message below can print.
  # Write-Warning is unaffected by $ErrorActionPreference, so both checks
  # run and report before the script actually fails.
  $pinMismatch = $false
  if ($actualBuildId -and $actualBuildId -ne $buildId) {
    Write-Warning "installed image build id ($actualBuildId) does not match the pin in avd-spec.json ($buildId)"
    $pinMismatch = $true
  }
  if ($actualIncremental -and $actualIncremental -ne $buildIncremental) {
    Write-Warning "installed image build incremental ($actualIncremental) does not match the pin ($buildIncremental)"
    $pinMismatch = $true
  }
  if ($pinMismatch) {
    # A pinned AVD that silently runs on the wrong build produces
    # measurements nobody can trust -- this is the one check that is the
    # whole point of the ticket, so it fails the script rather than warn
    # and carry on. Re-pin avd-spec.json deliberately (see its
    # systemImage.$comment) if Google has genuinely republished this
    # package id with different bits behind it.
    Write-Error "this AVD would not be comparable to captures taken against the pinned build. Re-pin avd-spec.json's systemImage.buildId/buildIncremental deliberately, or remove the stale image and re-run."
  }
}

# --- 2. AVD: create only if it does not already exist ------------------------
$avdHome = if ($env:ANDROID_AVD_HOME) { $env:ANDROID_AVD_HOME } else { Join-Path $env:USERPROFILE ".android\avd" }
$configIniPath = Join-Path $avdHome "$avdName.avd\config.ini"

if (Test-Path $configIniPath) {
  Write-Output "AVD already exists: $avdName"
} else {
  Write-Output "creating AVD: $avdName"
  # avdmanager asks whether to create a custom hardware profile; feeding it
  # "no" keeps the device profile's defaults, which we override below anyway.
  "no" | & $avdmanager create avd --name $avdName --package $packageId --device $deviceProfile
}

if (-not (Test-Path $configIniPath)) {
  Write-Error "expected config.ini at $configIniPath after creation, not found"
  exit 1
}

# --- 3. config.ini: always converge the pinned keys --------------------------
# Applied on every run (not just at creation) so an AVD from an older run of
# this script ends up identical to one created fresh from today's spec.
#
# Byte parity with create.sh matters here, not just content parity: two
# scripts that agree on every value but disagree on encoding still produce a
# "pinned" AVD that is not actually the same artefact. PowerShell 5.1's
# `Set-Content -Encoding utf8` writes a UTF-8 BOM, and both Set-Content and
# Add-Content join lines with `[Environment]::NewLine` (CRLF on Windows) --
# create.sh's awk/echo pipeline does neither. So this reads and rewrites the
# whole file ourselves: decode as UTF-8 ignoring any BOM that avdmanager's
# own output happened to include, normalize every line ending to LF before
# touching anything (so an untouched line does not silently keep a CRLF
# create.sh would never have written), then write back with
# [System.Text.UTF8Encoding]::new($false) -- UTF-8, no BOM -- joined with
# LF only.
$noBomUtf8 = New-Object System.Text.UTF8Encoding($false)

function Read-IniLines {
  param([string]$Path)
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  $text = $text -replace "`r`n", "`n"
  # Strip exactly one trailing newline before splitting, the same way awk's
  # per-record read treats "line\n" as one record rather than two ("line"
  # and ""). Skipping this turns every well-formed (newline-terminated)
  # file into one with a phantom blank last line, which then survives as a
  # real blank line in the middle of the file the moment anything is
  # appended after it.
  if ($text.EndsWith("`n")) { $text = $text.Substring(0, $text.Length - 1) }
  return $text -split "`n"
}

function Write-IniLines {
  param([string]$Path, [string[]]$Lines)
  # create.sh's awk rewrite terminates every record (ORS="\n") and its
  # append path (`echo ... >> file`) always adds a trailing "\n" too, so a
  # config.ini touched by that script is always newline-terminated. Match
  # that unconditionally rather than only when the input happened to be.
  [System.IO.File]::WriteAllText($Path, (($Lines -join "`n") + "`n"), $noBomUtf8)
}

function Set-IniKey {
  param([string]$Path, [string]$Key, [string]$Value)
  $lines = Read-IniLines $Path
  $pattern = "^$([regex]::Escape($Key))\s*="
  if ($lines -match $pattern) {
    $lines = $lines | ForEach-Object {
      if ($_ -match $pattern) { "$Key=$Value" } else { $_ }
    }
    Write-IniLines -Path $Path -Lines $lines
  } else {
    # Matches create.sh's `echo "$key=$value" >> file`: appended as one more
    # line after whatever was already there (including a trailing blank
    # entry left behind by the `-split` above if the file ended in a
    # newline, which reproduces create.sh's own trailing-newline behavior).
    $lines += "$Key=$Value"
    Write-IniLines -Path $Path -Lines $lines
  }
}

Set-IniKey -Path $configIniPath -Key "hw.ramSize" -Value $ramMb
Set-IniKey -Path $configIniPath -Key "hw.cpu.ncore" -Value $cores
Set-IniKey -Path $configIniPath -Key "hw.gpu.enabled" -Value $gpuEnabled
Set-IniKey -Path $configIniPath -Key "hw.gpu.mode" -Value $gpuMode
Set-IniKey -Path $configIniPath -Key "hw.lcd.density" -Value $lcdDensity
# hw.lcd.refreshRate does not exist as an emulator hardware property (see
# emulator/lib/hardware-properties.ini) and is silently ignored -- the real
# key controlling the guest display's refresh rate is hw.lcd.vsync.
Set-IniKey -Path $configIniPath -Key "hw.lcd.vsync" -Value $refreshHz
if ($snapshotsEnabled) {
  Set-IniKey -Path $configIniPath -Key "snapshot.present" -Value "yes"
} else {
  # A pinned AVD's whole point is a reproducible, cold-start boot, so every
  # snapshot-related key has to agree that snapshots are off -- not just the
  # ones that happen to win by precedence. fastboot.forceColdBoot alone was
  # observed (QA on a471739) to still leave the AVD writing a
  # 'default_boot' snapshot on exit, because fastboot.forceFastBoot and the
  # firstboot.* keys were left at the pixel_6 profile's defaults (all "yes").
  # Setting all five together removes the drift instead of relying on one
  # key outranking four contradictory ones.
  Set-IniKey -Path $configIniPath -Key "snapshot.present" -Value "no"
  Set-IniKey -Path $configIniPath -Key "fastboot.forceColdBoot" -Value "yes"
  Set-IniKey -Path $configIniPath -Key "fastboot.forceFastBoot" -Value "no"
  Set-IniKey -Path $configIniPath -Key "firstboot.bootFromLocalSnapshot" -Value "no"
  Set-IniKey -Path $configIniPath -Key "firstboot.saveToLocalSnapshot" -Value "no"
}

Write-Output ""
Write-Output "AVD '$avdName' ready."
Write-Output "  system image : $packageId"
Write-Output "  build        : $buildId (incremental $buildIncremental)"
Write-Output "  ram/cores    : ${ramMb}MB / $cores"
Write-Output "  gpu mode     : $gpuMode"
Write-Output "  density/hz   : $lcdDensity / $refreshHz"
Write-Output "  snapshots    : $(if ($snapshotsEnabled) {'yes'} else {'no'})"
Write-Output ""
Write-Output "Boot it with, e.g.:"
Write-Output "  & `"$sdkRoot\emulator\emulator.exe`" -avd $avdName -no-snapshot -gpu $gpuMode"
Write-Output ""
Write-Output "Remember: this is an emulator, not a device. Its absolute timings are not"
Write-Output "a Pixel's. Compare emulator runs to emulator runs; see README.md#emulator."
