// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * What the rest of the device was doing, from what adb can be asked directly.
 *
 * Porthole sees inside one process. When it reports a 400ms stall whose stack
 * bottoms out in a native read, or a janky frame dominated by swapBuffers, the
 * reason is usually below the app and it has no way to look — which is the
 * point at which a developer gives up and opens a system trace by hand.
 *
 * A good share of those cases are answerable without a trace at all: the device
 * was thermally throttled, the governor was holding the cores low, or something
 * else on the device was eating the CPU. Those come straight out of dumpsys and
 * sysfs, cost nothing, and need no extra tooling.
 *
 * Everything here parses defensively. `dumpsys` output varies by vendor and by
 * release, and the honest failure is to say a source could not be read rather
 * than to guess a number from a format that turned out to be different.
 */

const num = (value: string | undefined, fallback = NaN): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
};

export interface Thermal {
  /** Vendor names vary wildly; reported as given rather than normalised. */
  readings: Array<{ name: string; celsius: number }>;
  /** Present only when the device actually reports a throttling status. */
  throttling: string | null;
  hottest: { name: string; celsius: number } | null;
}

export interface Cpu {
  cores: Array<{ cpu: number; governor: string | null; curKhz: number; maxKhz: number }>;
  /** Cores running below their own maximum, which is what throttling looks like. */
  belowMax: number;
  /** Null when no core reported both a current and a maximum. */
  headroom: number | null;
}

export interface TopProcess {
  percent: number;
  name: string;
}

export interface SystemContext {
  thermal: Thermal | null;
  cpu: Cpu | null;
  top: TopProcess[];
  memory: { availableMb: number; totalMb: number; lowMemory: boolean } | null;
  /** Sources adb could not read, and why. Absence of data is never silent. */
  unavailable: Array<{ source: string; reason: string }>;
}

/**
 * `dumpsys thermalservice`.
 *
 * The interesting line is the status: devices report a throttling severity, and
 * anything above NONE means the system was deliberately slowing itself down —
 * which explains a regression that no code change can account for.
 */
/** android.os.Temperature throttling constants, as reported by ordinal. */
const SEVERITY: Record<string, string> = {
  "0": "NONE",
  "1": "LIGHT",
  "2": "MODERATE",
  "3": "SEVERE",
  "4": "CRITICAL",
  "5": "EMERGENCY",
  "6": "SHUTDOWN",
};

export function parseThermal(output: string): Thermal {
  const readings: Array<{ name: string; celsius: number }> = [];

  // Temperature{mValue=41.2, mType=3, mName=CPU, mStatus=0}
  //
  // Anchored on the type. The dump also lists CoolingDevice entries with the
  // identical inner shape, and an unanchored match read one of those as a
  // sensor: "hottest sensor tpu at 7964000°C", which is a throttling level.
  for (const match of output.matchAll(
    /Temperature\{mValue=([-\d.]+),\s*mType=\d+,\s*mName=([^,}]+)/g,
  )) {
    const celsius = num(match[1]);
    if (Number.isFinite(celsius)) readings.push({ name: match[2].trim(), celsius });
  }

  // Some devices name the status, some give the enum ordinal. Reported by
  // name either way, because "Thermal status 0" reads like a throttle.
  const raw = output.match(/Thermal Status:\s*(\w+)/i)?.[1] ?? null;
  const status = raw === null ? null : (SEVERITY[raw] ?? raw.toUpperCase());
  // The dump lists each sensor more than once, in different sections.
  const unique = [...new Map(readings.map((r) => [r.name, r])).values()];
  const hottest = unique.reduce<Thermal["hottest"]>(
    (worst, r) => (worst === null || r.celsius > worst.celsius ? r : worst),
    null,
  );

  return { readings: unique, throttling: status, hottest };
}

/**
 * Per-core frequency and governor, read out of sysfs in one shell round trip.
 *
 * A core pinned well below its maximum while the app is janking is the shape of
 * thermal or power-save throttling, and it is invisible from inside the process.
 */
export function parseCpu(output: string): Cpu {
  const cores: Cpu["cores"] = [];

  // Emitted as `cpu0 governor 300000 2400000`, one core per line.
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || !parts[0].startsWith("cpu")) continue;
    const cpu = num(parts[0].slice(3));
    if (!Number.isFinite(cpu)) continue;
    cores.push({
      cpu,
      governor: parts[1] === "?" ? null : parts[1],
      curKhz: num(parts[2], 0),
      maxKhz: num(parts[3], 0),
    });
  }

  // A maximum below the current reading means these files are not the
  // frequencies we assumed — an emulator returns 5270965 and 2 — and
  // dividing them produced a confident 263657263% of maximum. Anything
  // that fails the ordering is treated as unreadable rather than believed.
  const comparable = cores.filter((c) => c.curKhz > 0 && c.maxKhz >= c.curKhz);
  const belowMax = comparable.filter((c) => c.curKhz < c.maxKhz * 0.9).length;
  const headroom = comparable.length
    ? Math.round(
        (comparable.reduce((sum, c) => sum + c.curKhz / c.maxKhz, 0) / comparable.length) * 100,
      )
    : null;

  return { cores, belowMax, headroom };
}

/** `dumpsys cpuinfo` — who was actually using the CPU, app included. */
/** Summary rows dumpsys mixes in among the processes. */
const AGGREGATES = new Set(["TOTAL", "TOTAL:", "IOW", "irq", "softirq"]);

export function parseTop(output: string, limit = 8): TopProcess[] {
  const out: TopProcess[] = [];
  // "  12% 1234/com.example: 8% user + 4% kernel", and without the pid on
  // some lines. The pid group has to be explicit: a lazy prefix matches empty
  // and lets "1234/com.example" through as the name.
  for (const match of output.matchAll(/^\s*([\d.]+)%\s+(?:\d+\/)?([^\s:]+):/gm)) {
    const percent = num(match[1]);
    if (!Number.isFinite(percent)) continue;
    // dumpsys ends with `95% TOTAL: ...`, which is the sum and not a
    // process. Left in, it is the busiest thing on every device.
    if (AGGREGATES.has(match[2])) continue;
    out.push({ percent, name: match[2] });
  }
  return out.sort((a, b) => b.percent - a.percent).slice(0, limit);
}

/** `dumpsys meminfo` — whether the device as a whole was under pressure. */
export function parseMemory(output: string): SystemContext["memory"] {
  const total = num(output.match(/Total RAM:\s*([\d,]+)/)?.[1]?.replace(/,/g, ""));
  const free = num(output.match(/Free RAM:\s*([\d,]+)/)?.[1]?.replace(/,/g, ""));
  if (!Number.isFinite(total)) return null;
  return {
    totalMb: Math.round(total / 1024),
    availableMb: Number.isFinite(free) ? Math.round(free / 1024) : 0,
    lowMemory: /lowMemory=true/i.test(output),
  };
}

/**
 * One sentence naming only what was actually observed.
 *
 * Deliberately does not conclude. "Two cores below maximum" is a fact; "the app
 * is slow because of throttling" is a guess, and this file has no idea what the
 * app was doing at the time.
 */
export function describeSystem(context: SystemContext): string {
  const parts: string[] = [];

  if (context.thermal?.throttling && context.thermal.throttling.toUpperCase() !== "NONE") {
    parts.push(`Thermal status ${context.thermal.throttling}.`);
  }
  if (context.thermal?.hottest) {
    parts.push(`Hottest sensor ${context.thermal.hottest.name} at ${context.thermal.hottest.celsius}°C.`);
  }
  if (context.cpu && context.cpu.headroom !== null) {
    parts.push(
      `CPUs at ${context.cpu.headroom}% of maximum clock` +
        (context.cpu.belowMax ? `, ${context.cpu.belowMax} core(s) well below.` : "."),
    );
  }
  if (context.top.length) {
    const other = context.top[0];
    parts.push(`Busiest process ${other.name} at ${other.percent}%.`);
  }
  if (context.memory) {
    parts.push(
      `${context.memory.availableMb}MB free of ${context.memory.totalMb}MB` +
        (context.memory.lowMemory ? " — system reports low memory." : "."),
    );
  }
  if (context.unavailable.length) {
    parts.push(`Could not read: ${context.unavailable.map((u) => u.source).join(", ")}.`);
  }

  return parts.length ? parts.join(" ") : "Nothing readable from the device.";
}

/** The single shell command that reads every core's governor and frequency. */
export const CPU_PROBE =
  "for c in /sys/devices/system/cpu/cpu[0-9]*; do " +
  "n=$(basename $c); " +
  "g=$(cat $c/cpufreq/scaling_governor 2>/dev/null || echo '?'); " +
  "f=$(cat $c/cpufreq/scaling_cur_freq 2>/dev/null || echo 0); " +
  "m=$(cat $c/cpufreq/cpuinfo_max_freq 2>/dev/null || echo 0); " +
  "echo \"$n $g $f $m\"; done";
