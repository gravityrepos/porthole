// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DETAIL,
  byteLength,
  compactJson,
  describeSemanticsTreeStats,
  describeTimelineHighlights,
  describeUnattributableFields,
  formatBytes,
  renderDetail,
  resolveDetail,
  semanticsTreeStats,
  sizeNote,
  timelineHighlights,
  unattributableStateFields,
} from "./render.js";

describe("resolveDetail", () => {
  it("defaults to summary — the EM's own ruling on this ticket", () => {
    expect(DEFAULT_DETAIL).toBe("summary");
    expect(resolveDetail(undefined)).toBe("summary");
  });

  it("passes an explicit level straight through", () => {
    expect(resolveDetail("normal")).toBe("normal");
    expect(resolveDetail("full")).toBe("full");
    expect(resolveDetail("summary")).toBe("summary");
  });
});

describe("compactJson", () => {
  it("never pretty-prints — no newlines or indentation, unlike JSON.stringify(x, null, 2)", () => {
    const value = { a: 1, b: { c: [1, 2, 3] } };
    const text = compactJson(value);
    expect(text).not.toMatch(/\n/);
    expect(text).toBe(JSON.stringify(value));
    expect(text).not.toBe(JSON.stringify(value, null, 2));
  });

  it("never returns the JS value undefined as a block's own text — 'null', a real string", () => {
    expect(compactJson(undefined)).toBe("null");
  });
});

describe("byteLength / formatBytes", () => {
  it("counts UTF-8 bytes, not JS string length — a multi-byte character costs more than one", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("≈")).toBe(3); // U+2248, 3 bytes in UTF-8, 1 UTF-16 code unit
  });

  it("formats under 1000 bytes as a bare count, then KB, then MB", () => {
    expect(formatBytes(42)).toBe("42B");
    expect(formatBytes(4_200)).toBe("4.2KB");
    expect(formatBytes(4_200_000)).toBe("4.2MB");
  });
});

describe("sizeNote", () => {
  it("names both this call's own size and the next level's, when there is a next level", () => {
    expect(sizeNote(120, { label: "normal", bytes: 4_500 })).toBe(
      " [120B returned; normal ≈ 4.5KB]",
    );
  });

  it('says only its own size when there is no next level (detail: "full", or nothing more to gain)', () => {
    expect(sizeNote(4_500, null)).toBe(" [4.5KB returned]");
  });
});

describe("renderDetail — the shared decision every tool's ok() routes through", () => {
  const summary = "3 finding(s) over 10s.";
  const normalPayload = { findings: [1, 2, 3] };

  it('"summary": no payload at all, and the note names "normal" as the next level', () => {
    const decision = renderDetail({ summary, normalPayload, detail: "summary" });
    expect(decision.payload).toBeUndefined();
    expect(decision.summaryText).toContain(summary);
    expect(decision.summaryText).toMatch(/returned; normal ≈/);
  });

  it('"normal": the payload is exactly normalPayload, unchanged', () => {
    const decision = renderDetail({ summary, normalPayload, detail: "normal" });
    expect(decision.payload).toBe(normalPayload);
  });

  it('"normal" with no distinct "full": the note says only its own size — nothing more to gain', () => {
    const decision = renderDetail({ summary, normalPayload, detail: "normal" });
    expect(decision.summaryText).not.toMatch(/full ≈/);
  });

  it('"normal" with a distinct, bigger "full": the note names what "full" would cost', () => {
    const fullPayload = { findings: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
    const decision = renderDetail({ summary, normalPayload, fullPayload, detail: "normal" });
    expect(decision.summaryText).toMatch(/full ≈/);
  });

  it('"full" with no distinct payload falls back to normalPayload, exactly', () => {
    const decision = renderDetail({ summary, normalPayload, detail: "full" });
    expect(decision.payload).toBe(normalPayload);
    expect(decision.summaryText).not.toMatch(/≈/); // nothing past "full" to estimate
  });

  it('"full" with a distinct payload returns that payload, not normalPayload', () => {
    const fullPayload = { findings: [1, 2, 3, 4, 5] };
    const decision = renderDetail({ summary, normalPayload, fullPayload, detail: "full" });
    expect(decision.payload).toBe(fullPayload);
  });

  it("the reported bytes match the actual bytes returned — GRA-68's own acceptance criterion", () => {
    // "normal"/"full" carry a real payload block; the note's own claimed
    // size for THIS call must equal the byte length of the JSON this
    // decision actually hands back, not an estimate of it.
    for (const detail of ["normal", "full"] as const) {
      const decision = renderDetail({ summary, normalPayload, detail });
      const actualPayloadBytes = byteLength(compactJson(decision.payload));
      const claimed = /\[(\d+)B returned/.exec(decision.summaryText);
      expect(claimed, `no byte count in "${decision.summaryText}"`).not.toBeNull();
      expect(Number(claimed![1])).toBe(actualPayloadBytes);
    }
  });

  it('fullBytesHint estimates the "next level" cost at "normal" when no real full payload is available', () => {
    const decision = renderDetail({
      summary,
      normalPayload,
      fullBytesHint: 99_000,
      detail: "normal",
    });
    expect(decision.summaryText).toContain("full ≈ 99.0KB");
  });

  it("a real fullPayload always wins over fullBytesHint when both are given", () => {
    const fullPayload = { findings: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }; // bigger than normalPayload
    const decision = renderDetail({
      summary,
      normalPayload,
      fullPayload,
      fullBytesHint: 500_000,
      detail: "normal",
    });
    const actualFullBytes = byteLength(compactJson(fullPayload));
    expect(decision.summaryText).toContain(`full ≈ ${formatBytes(actualFullBytes)}`);
  });

  it('fullBytesHint is never consulted at "summary" — its own next level is always "normal"', () => {
    const decision = renderDetail({
      summary,
      normalPayload,
      fullBytesHint: 999_999,
      detail: "summary",
    });
    expect(decision.summaryText).not.toMatch(/999\.9KB|1\.0MB/);
    expect(decision.summaryText).toMatch(/normal ≈/);
  });
});

describe("timelineHighlights (GRA-91, folded into GRA-68)", () => {
  it("finds the one-second bucket with the most events, only once there is a second bucket to be busier than", () => {
    const single = timelineHighlights([
      { t: 1_000, event: "recompose" },
      { t: 1_500, event: "recompose" },
    ]);
    expect(single.busiestSecond).toBeNull(); // one bucket only — "busiest" means nothing yet

    const two = timelineHighlights([
      { t: 1_000, event: "recompose" },
      { t: 1_500, event: "recompose" },
      { t: 2_000, event: "recompose" },
    ]);
    expect(two.busiestSecond).toEqual({ startMs: 1_000, count: 2 });
  });

  it("finds the largest gap between consecutive events", () => {
    const h = timelineHighlights([
      { t: 1_000, event: "a" },
      { t: 1_100, event: "b" },
      { t: 9_000, event: "c" },
    ]);
    expect(h.longestGap).toEqual({ fromMs: 1_100, toMs: 9_000, ms: 7_900 });
  });

  it("finds the earliest event kind that occurred exactly once, when there is one", () => {
    const h = timelineHighlights([
      { t: 1_000, event: "recompose" },
      { t: 1_100, event: "recompose" },
      { t: 1_200, event: "screenshot" },
      { t: 1_300, event: "nav" },
      { t: 1_400, event: "nav" },
    ]);
    expect(h.onceOnly).toEqual({ kind: "screenshot", atMs: 1_200 });
  });

  it("says nothing that happened exactly once when every kind repeats", () => {
    const h = timelineHighlights([
      { t: 1_000, event: "recompose" },
      { t: 1_100, event: "recompose" },
    ]);
    expect(h.onceOnly).toBeNull();
  });

  it("handles an empty window without throwing", () => {
    const h = timelineHighlights([]);
    expect(h).toEqual({ busiestSecond: null, longestGap: null, onceOnly: null });
    expect(describeTimelineHighlights(h)).toBe("");
  });

  it("describeTimelineHighlights names all three, when all three exist", () => {
    const text = describeTimelineHighlights({
      busiestSecond: { startMs: 1_000, count: 5 },
      longestGap: { fromMs: 1_000, toMs: 3_000, ms: 2_000 },
      onceOnly: { kind: "screenshot", atMs: 1_200 },
    });
    expect(text).toContain("busiest second at t=1000 (5 events)");
    expect(text).toContain("longest gap 2000ms");
    expect(text).toContain("only one screenshot");
  });
});

describe("semanticsTreeStats (GRA-91, folded into GRA-68)", () => {
  it("counts nodes, unlabelled nodes, and instrumented (testTag-carrying) nodes", () => {
    const root = {
      testTag: "root",
      children: [
        { text: "Buy now" },
        { contentDescription: "cart icon", testTag: "cart" },
        { children: [{}] }, // unlabelled, uninstrumented, one more level
      ],
    };
    const stats = semanticsTreeStats(root);
    expect(stats.nodeCount).toBe(5);
    // root (testTag only, no text/desc), the nested "{ children: [...] }"
    // node, and its "{}" leaf — three nodes with neither text nor
    // contentDescription.
    expect(stats.unlabelledCount).toBe(3);
    expect(stats.instrumentedCount).toBe(2); // root, cart
    expect(stats.anyTruncated).toBe(false);
  });

  it("notices a truncated node anywhere in the tree", () => {
    const stats = semanticsTreeStats({ children: [{ truncated: true }] });
    expect(stats.anyTruncated).toBe(true);
  });

  it("a null root counts as zero nodes, not an error", () => {
    expect(semanticsTreeStats(null).nodeCount).toBe(0);
    expect(describeSemanticsTreeStats(semanticsTreeStats(null))).toBe("");
  });

  it("describeSemanticsTreeStats reports a percentage, rounded", () => {
    const text = describeSemanticsTreeStats({
      nodeCount: 3,
      unlabelledCount: 1,
      instrumentedCount: 1,
      anyTruncated: false,
    });
    expect(text).toBe("3 node(s), 1 unlabelled, 1 instrumented (33% coverage).");
  });
});

describe("unattributableStateFields (GRA-91, folded into GRA-68)", () => {
  it("names each unattributable field and the API that would fix it", () => {
    const fields = unattributableStateFields([
      {
        name: "CartViewModel",
        fields: [
          { key: "CartViewModel.items", kind: "MutableState", attributable: true },
          { key: "CartViewModel.pricesFlow", kind: "StateFlow", attributable: false },
          { key: "CartViewModel.rawFlag", kind: "plain", attributable: false },
        ],
      },
    ]);
    expect(fields).toEqual([
      { key: "CartViewModel.pricesFlow", kind: "StateFlow", fix: "collectAsNamedState" },
      {
        key: "CartViewModel.rawFlag",
        kind: "plain",
        fix: expect.stringContaining("not a State or Flow at all"),
      },
    ]);
  });

  it("says nothing when every field is attributable", () => {
    const fields = unattributableStateFields([
      { name: "X", fields: [{ key: "X.a", kind: "MutableState", attributable: true }] },
    ]);
    expect(fields).toEqual([]);
    expect(describeUnattributableFields(fields)).toBe("");
  });

  it("caps the described list and says how many more, past the cap", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      key: `Owner.field${i}`,
      kind: "StateFlow",
      attributable: false,
    }));
    const fields = unattributableStateFields([{ name: "Owner", fields: many }]);
    const text = describeUnattributableFields(fields);
    expect(text).toContain("+4 more");
    expect(text).toContain("Owner.field0");
    expect(text).not.toContain("Owner.field11");
  });
});
