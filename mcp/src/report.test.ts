// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { comparability, compareMetrics, renderComparison, renderReport } from "./report.js";
import type { Trace } from "./trace.js";

function trace(over: Partial<Trace> = {}): Trace {
  return {
    porthole: 1,
    scenario: "checkout",
    capturedAt: "2026-09-11T00:00:00Z",
    durationMs: 10_000,
    app: { packageName: "com.example.shop" },
    device: { model: "Pixel", refreshHz: 60, cores: 8, lowRamDevice: false },
    marks: [],
    metrics: {},
    findings: [],
    ...over,
  };
}

const kind = (before: Record<string, number>, after: Record<string, number>, key: string) =>
  compareMetrics(before, after).find((c) => c.key === key)?.kind;

describe("compareMetrics noise floors", () => {
  it("ignores a small relative move on a large metric", () => {
    // 3% is run-to-run drift. Reporting it trains people to switch the gate off.
    expect(kind({ "frames.p95Ms": 100 }, { "frames.p95Ms": 103 }, "frames.p95Ms")).toBe(
      "unchanged",
    );
  });

  it("ignores a large relative move on a tiny metric", () => {
    // 1ms to 2ms is +100%, and it is still 1ms.
    expect(kind({ "db.p95Ms": 1 }, { "db.p95Ms": 2 }, "db.p95Ms")).toBe("unchanged");
  });

  it("reports a move that clears both floors", () => {
    expect(kind({ "frames.p95Ms": 9 }, { "frames.p95Ms": 15 }, "frames.p95Ms")).toBe("regressed");
  });

  it("calls a decrease an improvement", () => {
    expect(kind({ "http.p95Ms": 480 }, { "http.p95Ms": 210 }, "http.p95Ms")).toBe("improved");
  });

  it("reports zero to non-zero however small, because it is categorical", () => {
    // The first main-thread query is not a 3% drift and no floor should hide it.
    expect(kind({ "db.onMainThread": 0 }, { "db.onMainThread": 1 }, "db.onMainThread")).toBe("new");
  });

  it("treats a metric absent from the baseline as zero", () => {
    expect(kind({}, { "work.retries": 2 }, "work.retries")).toBe("new");
  });

  it("says nothing when a metric did not move at all", () => {
    expect(kind({ "frames.missed": 12 }, { "frames.missed": 12 }, "frames.missed")).toBe(
      "unchanged",
    );
  });

  it("does not call a drop to zero a regression", () => {
    expect(kind({ "db.onMainThread": 4 }, { "db.onMainThread": 0 }, "db.onMainThread")).toBe(
      "improved",
    );
  });
});

describe("comparability", () => {
  it("allows two runs of the same scenario on the same device", () => {
    expect(comparability(trace(), trace())).toBeNull();
  });

  it("refuses two different scenarios", () => {
    expect(comparability(trace({ scenario: "a" }), trace({ scenario: "b" }))).toContain(
      "different scenarios",
    );
  });

  it("refuses different refresh rates, because the frame budget differs", () => {
    const before = trace({ device: { refreshHz: 60, cores: 8 } });
    const after = trace({ device: { refreshHz: 120, cores: 8 } });
    expect(comparability(before, after)).toContain("refresh rates");
  });

  it("refuses different core counts", () => {
    const before = trace({ device: { refreshHz: 60, cores: 4 } });
    const after = trace({ device: { refreshHz: 60, cores: 8 } });
    expect(comparability(before, after)).toContain("core counts");
  });

  it("does not treat two unknown values as a difference", () => {
    // A capture that attached to an app already running never saw the device
    // profile. Compared as numbers these become NaN !== NaN and refuse every
    // pair of traces that happen to be missing the same field.
    const partial = trace({ device: { model: "Pixel" } });
    expect(comparability(partial, partial)).toBeNull();
  });

  it("does not refuse when only one side knows a value", () => {
    const known = trace({ device: { refreshHz: 60, cores: 8 } });
    const unknown = trace({ device: { model: "Pixel" } });
    expect(comparability(known, unknown)).toBeNull();
  });
});

describe("renderComparison", () => {
  it("marks a refusal as refused rather than as a pass", () => {
    const result = renderComparison(trace({ scenario: "a" }), trace({ scenario: "b" }));
    expect(result.refused).toBe(true);
    expect(result.regressed).toBe(false);
    expect(result.text).toContain("refusing to compare");
  });

  it("counts a new metric as a regression", () => {
    const after = trace({ metrics: { "db.onMainThread": 2 } });
    const result = renderComparison(trace({ metrics: { "db.onMainThread": 0 } }), after);

    expect(result.regressed).toBe(true);
    expect(result.refused).toBe(false);
  });

  it("does not call an improvement a regression", () => {
    const before = trace({ metrics: { "http.p95Ms": 480 } });
    const after = trace({ metrics: { "http.p95Ms": 210 } });
    expect(renderComparison(before, after).regressed).toBe(false);
  });

  it("points out that the drivers differed", () => {
    const before = trace({ driver: "macrobenchmark" });
    const after = trace({ driver: "agent" });
    // Timings captured under a driver that reasons between steps drift for
    // reasons that are not the code's, and the reader should be told.
    expect(renderComparison(before, after).text).toContain("drivers differ");
  });
});

describe("renderReport", () => {
  it("says which lanes were checked and found quiet", () => {
    const text = renderReport(trace({ metrics: { "http.failed": 0, "db.onMainThread": 0 } }));
    expect(text).toContain("quiet:");
    expect(text).toContain("http");
  });

  it("does not claim a lane is quiet when it is not", () => {
    const text = renderReport(trace({ metrics: { "http.failed": 2 } }));
    expect(text).not.toMatch(/quiet:.*http/);
  });

  it("says so plainly when there is nothing to report", () => {
    expect(renderReport(trace())).toContain("nothing worth reporting");
  });

  it("keeps severity order and hangs the mark off the finding", () => {
    const text = renderReport(
      trace({
        findings: [
          {
            id: "main-thread-stall",
            severity: "error",
            confidence: "observed",
            title: "main thread blocked for 305ms",
            during: "block the main thread",
          },
          {
            id: "frames-dropped",
            severity: "warning",
            confidence: "observed",
            title: "158 frames missed",
          },
        ],
      }),
    );

    expect(text.indexOf("ERROR")).toBeLessThan(text.indexOf("WARNING"));
    expect(text).toContain('during "block the main thread"');
  });
});
