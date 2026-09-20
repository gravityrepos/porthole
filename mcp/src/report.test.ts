// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  comparability,
  compareMetrics,
  renderComparison,
  renderReport,
  shouldColor,
} from "./report.js";
import type { Trace } from "./trace.js";

const ESCAPE = /\x1b/;

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

  it("does not call the http lane quiet when calls were still open", () => {
    // A hang is the loudest thing a capture can hold. Keying the lane on
    // http.failed alone made a run with three wedged calls print "quiet: http"
    // directly beneath the warning that named them.
    const text = renderReport(trace({ metrics: { "http.failed": 0, "http.stillOpen": 3 } }));
    expect(text).not.toMatch(/quiet:.*http/);
  });

  it("does not call the db lane quiet when queries were still open", () => {
    const text = renderReport(trace({ metrics: { "db.onMainThread": 0, "db.stillOpen": 1 } }));
    expect(text).not.toMatch(/quiet:.*db/);
  });

  it("does not call the work lane quiet when jobs were still open", () => {
    const text = renderReport(
      trace({ metrics: { "work.retries": 0, "work.failures": 0, "work.stillOpen": 2 } }),
    );
    expect(text).not.toMatch(/quiet:.*work/);
  });

  it("still calls a lane quiet when nothing in it was open", () => {
    const text = renderReport(
      trace({ metrics: { "http.failed": 0, "http.stillOpen": 0, "db.stillOpen": 4 } }),
    );
    expect(text).toMatch(/quiet:.*http/);
    expect(text).not.toMatch(/quiet:.*db/);
  });

  it("says how many of the counted calls and queries never finished", () => {
    // The counts include spans that never ended, so the bare number reads as
    // completions to anyone who does not know that. The qualifier travels with
    // it, the same way atLeastMs does.
    const text = renderReport(
      trace({
        metrics: {
          "http.calls": 12,
          "http.stillOpen": 3,
          "db.queries": 40,
          "db.stillOpen": 1,
          "recompose.total": 0,
        },
      }),
    );
    expect(text).toContain("12 calls (3 still open)");
    expect(text).toContain("40 queries (1 still open)");
  });

  it("leaves the counts unqualified when everything finished", () => {
    const text = renderReport(
      trace({
        metrics: {
          "http.calls": 12,
          "http.stillOpen": 0,
          "db.queries": 40,
          "recompose.total": 0,
        },
      }),
    );
    expect(text).toContain("12 calls · 40 queries");
    expect(text).not.toContain("still open");
  });

  it("says so plainly when there is nothing to report", () => {
    expect(renderReport(trace())).toContain("nothing worth reporting");
  });

  it("prints a resolved where beneath its finding (GRA-201)", () => {
    const text = renderReport(
      trace({
        findings: [
          {
            id: "main-thread-stall",
            severity: "error",
            confidence: "observed",
            title: "main thread blocked for 305ms",
            where: { resolved: true, path: "app/src/main/kotlin/CartViewModel.kt", line: 148 },
          },
        ],
      }),
    );
    expect(text).toContain("at app/src/main/kotlin/CartViewModel.kt:148");
  });

  it("says nothing about where when it did not resolve — a report is not the place for a reason code", () => {
    const text = renderReport(
      trace({
        findings: [
          {
            id: "main-thread-stall",
            severity: "error",
            confidence: "observed",
            title: "main thread blocked for 305ms",
            where: { resolved: false, reason: "ambiguous" },
          },
        ],
      }),
    );
    expect(text).not.toContain("at ");
    expect(text).not.toContain("ambiguous");
  });

  /**
   * GRA-103: a finding `porthole capture --systrace` pulled out of the
   * system trace is tagged `[trace]` so it reads differently from one the
   * runtime itself observed — the same `source` distinction `/api/findings`
   * (timeline.ts) already carries, now visible in the CLI's own report.
   */
  it("tags a trace-sourced finding, and leaves a porthole-sourced one alone (GRA-103)", () => {
    const text = renderReport(
      trace({
        findings: [
          {
            id: "trace-frame-deadline",
            severity: "error",
            confidence: "observed",
            title: "the frame timeline recorded 1× missed_frame",
            source: "trace",
          },
          {
            id: "main-thread-stall",
            severity: "error",
            confidence: "observed",
            title: "main thread blocked for 305ms",
            source: "porthole",
          },
        ],
      }),
    );
    expect(text).toContain("[trace] the frame timeline recorded 1× missed_frame");
    expect(text).toContain("main thread blocked for 305ms");
    expect(text).not.toContain("[trace] main thread blocked for 305ms");
  });

  it("tags nothing when a finding carries no source at all — every trace written before GRA-103", () => {
    const text = renderReport(
      trace({
        findings: [
          {
            id: "main-thread-stall",
            severity: "error",
            confidence: "observed",
            title: "main thread blocked for 305ms",
          },
        ],
      }),
    );
    expect(text).not.toContain("[trace]");
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

describe("renderReport colour (GRA-142)", () => {
  // Every test above this one calls renderReport(trace) with no options —
  // this is the actual regression surface: nothing here changes unless the
  // implementation stops treating "no options" as "plain text".
  it("stays plain with no escape bytes at all when color is not requested (the default every existing caller uses)", () => {
    const text = renderReport(
      trace({
        findings: [
          { id: "e", severity: "error", confidence: "observed", title: "an error" },
          { id: "w", severity: "warning", confidence: "correlated", title: "a warning" },
          { id: "n", severity: "note", confidence: "observed", title: "a note" },
        ],
      }),
    );
    expect(text).not.toMatch(ESCAPE);
  });

  // The forced-TTY test the ticket asks for by name: report.test.ts and
  // capture.test.ts both run non-TTY (vitest's stdout/stderr are piped), so
  // a suite that only ever calls renderReport(trace) with the implicit
  // default would stay green over a colour path that was never wired up at
  // all, or wired up backwards. Forcing it via options.color — rather than
  // monkey-patching process.stdout.isTTY, which this function does not even
  // read — exercises exactly the branch a real terminal would take.
  it("forces the TTY path via options.color and asserts the escape sequence around ERROR and its absence around a nearby 'observed'", () => {
    const text = renderReport(
      trace({
        findings: [
          {
            id: "main-thread-stall",
            severity: "error",
            confidence: "observed",
            title: "main thread blocked for 305ms",
            // Deliberately contains the word "observed" so the test can prove
            // the escape wraps only the severity token and does not bleed
            // into adjacent plain text — confidence itself is not rendered
            // by renderReport today, so this is the closest real text to
            // check the AC's literal wording against.
            detail: "observed for 305ms, not merely correlated",
          },
        ],
      }),
      { color: true },
    );

    // Red, then a full reset, wrapping exactly the padded "ERROR  " label.
    expect(text).toContain("\x1b[31mERROR  \x1b[0m");

    const observedIndex = text.indexOf("observed");
    expect(observedIndex).toBeGreaterThan(-1);
    // No escape byte anywhere in a window around "observed" — proves the
    // colouring did not leak past the severity token onto the detail line.
    const window = text.slice(Math.max(0, observedIndex - 10), observedIndex + 20);
    expect(window).not.toMatch(ESCAPE);
  });

  it("colours warning amber (yellow) and note dim, distinctly from error's red", () => {
    const text = renderReport(
      trace({
        findings: [
          { id: "e", severity: "error", confidence: "observed", title: "an error" },
          { id: "w", severity: "warning", confidence: "observed", title: "a warning" },
          { id: "n", severity: "note", confidence: "correlated", title: "a note" },
        ],
      }),
      { color: true },
    );
    expect(text).toContain("\x1b[31mERROR  \x1b[0m");
    expect(text).toContain("\x1b[33mWARNING\x1b[0m");
    expect(text).toContain("\x1b[2mNOTE   \x1b[0m");
  });

  it("does not colour anything when there are no findings — nothing to wrap", () => {
    const text = renderReport(trace(), { color: true });
    expect(text).not.toMatch(ESCAPE);
  });
});

describe("shouldColor (GRA-142)", () => {
  it("is true only on a TTY with NO_COLOR unset", () => {
    expect(shouldColor({ isTTY: true }, {})).toBe(true);
  });

  it("is false when the stream is not a TTY, regardless of NO_COLOR", () => {
    expect(shouldColor({ isTTY: false }, {})).toBe(false);
    expect(shouldColor({}, {})).toBe(false);
  });

  it("is false on a TTY once NO_COLOR is set, however it is set", () => {
    expect(shouldColor({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    // NO_COLOR's own convention is presence, not truthiness — an empty value
    // still counts as "set" and must still disable colour.
    expect(shouldColor({ isTTY: true }, { NO_COLOR: "" })).toBe(false);
  });
});
