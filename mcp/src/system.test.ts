// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  describeSystem,
  parseCpu,
  parseMemory,
  parseThermal,
  parseTop,
  type SystemContext,
} from "./system.js";

/**
 * `dumpsys` output is not a stable interface. It differs by Android release and
 * by vendor, and a parser written against one device will meet formats it has
 * never seen. So the contract these pin is not "extracts the right number from
 * this string" — it is that an unrecognised format yields nothing rather than a
 * wrong number, because a plausible-looking wrong temperature is worse than an
 * admitted gap.
 *
 * The fixtures below were captured from a real device where marked. The rest
 * are deliberately malformed, which is the half that matters.
 */

describe("thermal", () => {
  it("reads sensors and the throttling status", () => {
    const out = parseThermal(`
Thermal Status: NONE
Current temperatures from HAL:
	Temperature{mValue=41.2, mType=3, mName=CPU, mStatus=0}
	Temperature{mValue=38.0, mType=1, mName=GPU, mStatus=0}
    `);
    expect(out.readings).toHaveLength(2);
    expect(out.hottest).toEqual({ name: "CPU", celsius: 41.2 });
    expect(out.throttling).toBe("NONE");
  });

  it("surfaces a throttling state, which is the reason to look at all", () => {
    expect(parseThermal("Thermal Status: SEVERE").throttling).toBe("SEVERE");
  });

  it("returns nothing rather than something from a format it does not know", () => {
    const out = parseThermal("some vendor wrote this differently: 41 degrees");
    expect(out.readings).toEqual([]);
    expect(out.hottest).toBeNull();
    expect(out.throttling).toBeNull();
  });
});

describe("cpu", () => {
  const probe = ["cpu0 schedutil 300000 2400000", "cpu1 schedutil 2400000 2400000"].join("\n");

  it("spots cores held below their own maximum", () => {
    const cpu = parseCpu(probe);
    expect(cpu.cores).toHaveLength(2);
    expect(cpu.belowMax).toBe(1);
    // cpu0 at 12.5% of max, cpu1 at 100%: 56% average, rounded.
    expect(cpu.headroom).toBe(56);
  });

  it("does not divide by a maximum it never read", () => {
    const cpu = parseCpu("cpu0 ? 0 0");
    expect(cpu.headroom).toBeNull();
    expect(cpu.belowMax).toBe(0);
  });

  it("ignores lines that are not cores", () => {
    expect(parseCpu("bash: cpufreq: No such file\ncpu0 schedutil 1 2").cores).toHaveLength(1);
  });
});

describe("top processes", () => {
  it("ranks by cpu, the app included", () => {
    const top = parseTop(`
Load: 1.5 / 1.2 / 0.9
  34% 1802/com.example.app: 20% user + 14% kernel
  12% 512/system_server: 8% user + 4% kernel
  2% 98/kswapd0: 0% user + 2% kernel
    `);
    expect(top[0]).toEqual({ percent: 34, name: "com.example.app" });
    expect(top.map((p) => p.name)).toContain("kswapd0");
  });

  it("yields nothing on output it does not recognise", () => {
    expect(parseTop("Permission denial")).toEqual([]);
  });
});

describe("memory", () => {
  it("reads total and free", () => {
    const mem = parseMemory("Total RAM: 8,123,456K (status normal)\n Free RAM: 1,048,576K");
    expect(mem?.totalMb).toBe(7933);
    expect(mem?.availableMb).toBe(1024);
    expect(mem?.lowMemory).toBe(false);
  });

  it("is null when it cannot find the total, rather than reporting zero", () => {
    // Zero would read as "no memory at all", which is a claim we did not make.
    expect(parseMemory("nothing familiar here")).toBeNull();
  });
});

describe("the summary", () => {
  const empty: SystemContext = {
    thermal: null,
    cpu: null,
    top: [],
    memory: null,
    unavailable: [],
  };

  it("states what was observed without concluding from it", () => {
    const line = describeSystem({
      ...empty,
      thermal: { readings: [], throttling: "MODERATE", hottest: { name: "CPU", celsius: 52 } },
      cpu: { cores: [], belowMax: 2, headroom: 40 },
    });
    expect(line).toContain("MODERATE");
    expect(line).toContain("40% of maximum");
    // Deliberately absent: any sentence explaining the app's behaviour. This
    // module does not know what the app was doing.
    expect(line).not.toMatch(/because|caused|therefore|slow/i);
  });

  it("says which sources it could not read", () => {
    const line = describeSystem({
      ...empty,
      unavailable: [{ source: "thermalservice", reason: "permission denied" }],
    });
    expect(line).toContain("Could not read: thermalservice");
  });

  it("does not pretend to an answer when nothing was readable", () => {
    expect(describeSystem(empty)).toBe("Nothing readable from the device.");
  });
});

/**
 * Captured from a real device, and every one of these was a bug the invented
 * fixtures above could not find. Written before a device was available, they
 * tested the format I assumed rather than the one that arrives.
 */
describe("what a real device actually returns", () => {
  it("refuses to divide readings that are not frequencies", () => {
    // An emulator's cpufreq files gave cur=5270965 and max=2, and dividing
    // them reported "263657263% of maximum clock" with total confidence.
    const cpu = parseCpu("cpu0 schedutil 5270965 2\ncpu1 schedutil 5275979 2");
    expect(cpu.headroom).toBeNull();
    expect(cpu.belowMax).toBe(0);
    expect(cpu.cores).toHaveLength(2); // still reported, just not compared
  });

  it("names a numeric throttling status instead of printing the ordinal", () => {
    // "Thermal status 0" reads as a throttle state. It is NONE.
    expect(parseThermal("Thermal Status: 0").throttling).toBe("NONE");
    expect(parseThermal("Thermal Status: 3").throttling).toBe("SEVERE");
  });

  it("drops the TOTAL row, which otherwise outranks every process", () => {
    const top = parseTop(`
    98% 680/system_server: 18% user + 80% kernel / faults: 206257 minor
    95% TOTAL: 20% user + 61% kernel + 0.1% iowait
    9% 532/surfaceflinger: 0.4% user + 8.6% kernel
    `);
    expect(top.map((p) => p.name)).not.toContain("TOTAL");
    expect(top[0].name).toBe("system_server");
  });

  it("reports each sensor once, though the dump lists it several times", () => {
    const out = parseThermal(`
      Temperature{mValue=30.2, mType=2, mName=battery, mStatus=0}
      Temperature{mValue=30.1, mType=3, mName=skin, mStatus=0}
      Temperature{mValue=30.1, mType=3, mName=skin, mStatus=0}
      Temperature{mValue=30.2, mType=2, mName=battery, mStatus=0}
    `);
    expect(out.readings).toHaveLength(2);
  });

  it("says nothing about the CPU when it could not read it", () => {
    // The summary has to omit the claim entirely, not soften it.
    const line = describeSystem({
      thermal: null,
      cpu: parseCpu("cpu0 schedutil 5270965 2"),
      top: [],
      memory: null,
      unavailable: [],
    });
    expect(line).not.toMatch(/maximum clock/);
  });
});
