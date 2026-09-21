// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import {
  lintSemanticsTree,
  parseSemanticsNode,
  recordSemanticsCapture,
  resetAccessibilityCaptureForTests,
  semanticsCaptureForWindow,
  summarizeAccessibilityResult,
  type SemanticsNode,
} from "./accessibility.js";
import { resetSourceIndexForTests } from "./sources.js";

/**
 * A hand-built fixture mirroring the real wire shape
 * (`SemanticsNodeDto`/`Protocol.kt`), the same "mirror the real capture
 * shape" allowance GRA-72's own AC names — density 2.0 (xhdpi, a round
 * number: 1dp == 2px) so every bounds figure below reads as its own dp size
 * halved, with nothing to compute by hand while reading a test.
 */
const DENSITY = 2;

function node(over: Partial<SemanticsNode> & { stableId: string }): SemanticsNode {
  return {
    nodeId: 1,
    role: null,
    testTag: null,
    text: null,
    contentDescription: null,
    bounds: null,
    actions: [],
    flags: [],
    children: [],
    truncated: false,
    ...over,
  };
}

/**
 * QA F9: a finding only surfaces when its node, or an ancestor, is
 * attributable to the app. Every fixture below that exercises one specific
 * *rule* (not attribution itself) roots its tree under a node carrying a
 * `testTag` — standing in for a `PortholeScreen`/`portholeNode` wrapping a
 * real screen — precisely so those tests keep proving what they always
 * proved: the rule logic, not the attribution filter. The attribution
 * filter gets its own dedicated describe block below, with fixtures that
 * deliberately do *not* do this.
 */
function attributedRoot(over: Partial<SemanticsNode> & { stableId: string }): SemanticsNode {
  return node({ testTag: "TestScreen", ...over });
}

function rect(leftDp: number, topDp: number, widthDp: number, heightDp: number) {
  return {
    left: leftDp * DENSITY,
    top: topDp * DENSITY,
    right: (leftDp + widthDp) * DENSITY,
    bottom: (topDp + heightDp) * DENSITY,
  };
}

// PORTHOLE_PROJECT_ROOT must stay unset for these tests -- `isAttributed`'s
// `whereForName` fallback degrades to "off" without it (see sources.ts),
// which is exactly what keeps every fixture's attribution story resting on
// `testTag` alone and predictable across machines/CI.
beforeEach(() => {
  delete process.env.PORTHOLE_PROJECT_ROOT;
  resetSourceIndexForTests();
});

describe("parseSemanticsNode", () => {
  it("parses a well-formed wire node, recursively", () => {
    const parsed = parseSemanticsNode({
      nodeId: 3,
      stableId: "abc123",
      role: "Button",
      testTag: "Cart.ClearPromo",
      text: null,
      contentDescription: null,
      bounds: { left: 0, top: 0, right: 96, bottom: 96 },
      actions: ["OnClick"],
      flags: ["clickable"],
      truncated: false,
      children: [{ stableId: "child1", children: [] }],
    });
    expect(parsed).toMatchObject({
      nodeId: 3,
      stableId: "abc123",
      role: "Button",
      testTag: "Cart.ClearPromo",
      bounds: { left: 0, top: 0, right: 96, bottom: 96 },
      actions: ["OnClick"],
      flags: ["clickable"],
    });
    expect(parsed?.children).toHaveLength(1);
    expect(parsed?.children[0].stableId).toBe("child1");
  });

  it("drops a node with no stableId -- the one field every producer keys off -- but still returns null rather than throwing", () => {
    expect(parseSemanticsNode({ role: "Button" })).toBeNull();
    expect(parseSemanticsNode(null)).toBeNull();
    expect(parseSemanticsNode("not an object")).toBeNull();
  });

  it("treats an absent bounds as null rather than {0,0,0,0}", () => {
    expect(parseSemanticsNode({ stableId: "x", children: [] })?.bounds).toBeNull();
  });
});

describe("lintSemanticsTree: missing label (GRA-72 AC -- the IconButton fixture)", () => {
  it("flags a clickable node with no text and no contentDescription as a warning, naming stableId and path", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [
        node({
          stableId: "iconbtn1",
          role: "Button",
          testTag: "Cart.ClearPromo",
          flags: ["clickable"],
          actions: ["OnClick"],
          bounds: rect(0, 0, 48, 48),
        }),
      ],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 5000 });
    const finding = result.findings.find((f) => f.id === "a11y-missing-label");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
    expect(finding?.confidence).toBe("observed");
    expect(finding?.evidence).toMatchObject({ stableId: "iconbtn1", testTag: "Cart.ClearPromo" });
    expect(finding?.window).toEqual({ from: 5000, to: 5000 });
  });

  it("does NOT flag a decorative icon with no description -- GRA-72 open question 1", () => {
    // No click action, no role implying interactivity: this is exactly the
    // "correct, not a defect" case the ticket names explicitly.
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "decorative-icon", role: "Image", flags: ["invisibleToUser"] })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings.find((f) => f.id === "a11y-missing-label")).toBeUndefined();
  });

  it("does not flag a clickable node that has text but no contentDescription", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "labeled", flags: ["clickable"], text: "Add" })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings.find((f) => f.id === "a11y-missing-label")).toBeUndefined();
  });
});

describe("lintSemanticsTree: touch target size (GRA-72 AC -- the 32dp fixture)", () => {
  it("reports a 32dp target as a note, with its measured size", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [
        node({
          stableId: "tiny1",
          testTag: "Cart.TinyTarget",
          flags: ["clickable"],
          contentDescription: "Clear promo code (small target)",
          bounds: rect(0, 0, 32, 32),
        }),
      ],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    const finding = result.findings.find((f) => f.id === "a11y-touch-target-small");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("note");
    expect(finding?.evidence).toMatchObject({
      stableId: "tiny1",
      measuredDp: { width: 32, height: 32 },
    });
  });

  it("promotes to warning below 24dp -- GRA-72 open question 2, decided", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "tinier", flags: ["clickable"], bounds: rect(0, 0, 20, 20) })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    const finding = result.findings.find((f) => f.id === "a11y-touch-target-small");
    expect(finding?.severity).toBe("warning");
  });

  it("says nothing about a 48dp+ target", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "ok", flags: ["clickable"], bounds: rect(0, 0, 48, 48) })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings.find((f) => f.id === "a11y-touch-target-small")).toBeUndefined();
  });

  it("skips touch-target checks entirely, and says why in coverage, when density is unknown", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "tiny", flags: ["clickable"], bounds: rect(0, 0, 10, 10) })],
    });
    const result = lintSemanticsTree(root, { density: null, fontScale: 1, capturedAt: 0 });
    expect(result.findings.find((f) => f.id === "a11y-touch-target-small")).toBeUndefined();
    expect(result.coverage.some((c) => c.includes("density"))).toBe(true);
  });

  it("never flags a non-clickable node, regardless of size", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "small-text", bounds: rect(0, 0, 5, 5) })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings.find((f) => f.id === "a11y-touch-target-small")).toBeUndefined();
  });
});

describe("lintSemanticsTree: click/role mismatch", () => {
  it("notes an interactive role with no click action", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "n1", role: "Checkbox", text: "Agree" })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    const finding = result.findings.find((f) => f.id === "a11y-click-mismatch");
    expect(finding?.severity).toBe("note");
    expect(finding?.detail).toContain("Checkbox");
  });

  it("notes a clickable node with no semantic role", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "n2", flags: ["clickable"], text: "Tap" })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    const finding = result.findings.find((f) => f.id === "a11y-click-mismatch");
    expect(finding?.detail).toContain("no semantic role");
  });

  it("says nothing when role and click action agree", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "n3", role: "Button", flags: ["clickable"], text: "Ok" })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings.find((f) => f.id === "a11y-click-mismatch")).toBeUndefined();
  });
});

describe("lintSemanticsTree: image without description", () => {
  it("notes a Role.Image node with no description, not marked decorative", () => {
    const root = attributedRoot({ stableId: "root", children: [node({ stableId: "img1", role: "Image" })] });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings.find((f) => f.id === "a11y-image-no-description")).toBeDefined();
  });

  it("says nothing about an image marked invisibleToUser -- deliberately decorative", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "img2", role: "Image", flags: ["invisibleToUser"] })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings.find((f) => f.id === "a11y-image-no-description")).toBeUndefined();
  });

  it("says nothing about an image that does carry a description", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "img3", role: "Image", contentDescription: "A cart icon" })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings.find((f) => f.id === "a11y-image-no-description")).toBeUndefined();
  });
});

describe("lintSemanticsTree: duplicated descriptions among siblings", () => {
  it("notes siblings that share a description, naming every one of them", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [
        node({ stableId: "s1", role: "Button", contentDescription: "Remove item" }),
        node({ stableId: "s2", role: "Button", contentDescription: "Remove item" }),
        node({ stableId: "s3", role: "Button", contentDescription: "Something else" }),
      ],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    const finding = result.findings.find((f) => f.id === "a11y-duplicate-description");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("note");
    const siblings = (finding?.evidence?.siblings as Array<{ stableId: string }>) ?? [];
    expect(siblings.map((s) => s.stableId).sort()).toEqual(["s1", "s2"]);
  });

  it("says nothing when every sibling's description is unique", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [
        node({ stableId: "s1", contentDescription: "First" }),
        node({ stableId: "s2", contentDescription: "Second" }),
      ],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings.find((f) => f.id === "a11y-duplicate-description")).toBeUndefined();
  });

  it("ignores an invisibleToUser sibling entirely -- it never counts toward a duplicate, and is never named", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [
        node({ stableId: "s1", role: "Button", contentDescription: "Remove item" }),
        node({ stableId: "hidden1", role: "Button", contentDescription: "Remove item", flags: ["invisibleToUser"] }),
      ],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings.find((f) => f.id === "a11y-duplicate-description")).toBeUndefined();
  });
});

describe("lintSemanticsTree: text overflow risk at a large font scale", () => {
  it("notes text whose box sits within the margin of its parent, only when fontScale exceeds the threshold", () => {
    const root = attributedRoot({
      stableId: "root",
      bounds: rect(0, 0, 100, 20),
      children: [node({ stableId: "text1", text: "A very long label", bounds: rect(0.5, 0.5, 99, 19) })],
    });
    const tight = lintSemanticsTree(root, { density: DENSITY, fontScale: 1.5, capturedAt: 0 });
    const finding = tight.findings.find((f) => f.id === "a11y-text-overflow-risk");
    expect(finding).toBeDefined();
    expect(finding?.confidence).toBe("correlated");
    expect(finding?.severity).toBe("note");

    const belowThreshold = lintSemanticsTree(root, { density: DENSITY, fontScale: 1.2, capturedAt: 0 });
    expect(belowThreshold.findings.find((f) => f.id === "a11y-text-overflow-risk")).toBeUndefined();
  });

  it("says nothing when the text box has real margin inside its parent", () => {
    const root = attributedRoot({
      stableId: "root",
      bounds: rect(0, 0, 100, 100),
      children: [node({ stableId: "text2", text: "Fine", bounds: rect(20, 20, 60, 20) })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 2, capturedAt: 0 });
    expect(result.findings.find((f) => f.id === "a11y-text-overflow-risk")).toBeUndefined();
  });
});

/**
 * QA F8: `invisibleToUser` used to be honoured only by the image rule — a
 * node that was both `clickable` and `invisibleToUser`, well under the
 * touch-target minimum, still earned a missing-label warning *and* a
 * touch-target warning, even though TalkBack skips that node (and
 * everything beneath it) entirely.
 */
describe("lintSemanticsTree: invisibleToUser hides a node and its whole subtree", () => {
  it("a clickable, tiny, invisibleToUser node earns no findings at all -- not missing-label, not touch-target", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [
        node({
          stableId: "hidden-tiny",
          flags: ["clickable", "invisibleToUser"],
          bounds: rect(0, 0, 10, 10),
        }),
      ],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings).toEqual([]);
  });

  it("is not counted toward nodesChecked, and is counted in coverage as hidden instead", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "hidden", flags: ["invisibleToUser"] })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.nodesChecked).toBe(1); // root only -- "hidden" is not checked
    expect(result.coverage.some((c) => c.includes("1 node(s) hidden from assistive technology"))).toBe(true);
  });

  it("hides the whole subtree, not just the node itself -- a descendant with its own real defect is never reached", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [
        node({
          stableId: "hidden-parent",
          flags: ["invisibleToUser"],
          children: [node({ stableId: "buried-defect", role: "Image" })],
        }),
      ],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings).toEqual([]);
    expect(result.nodesChecked).toBe(1); // root only
    // hidden-parent + buried-defect: two nodes hidden, not one.
    expect(result.coverage.some((c) => c.includes("2 node(s) hidden from assistive technology"))).toBe(true);
  });

  it("says nothing about hidden nodes in coverage when there are none", () => {
    const root = attributedRoot({ stableId: "root", children: [node({ stableId: "visible" })] });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.coverage.some((c) => c.includes("hidden from assistive technology"))).toBe(false);
  });
});

/**
 * QA F9 -- the EM's own ruling (2026-09-13): "a finding whose node is not
 * attributable to the app's own composables is not a finding." A bare
 * `Modifier.clickable {}` with no role is the ordinary shape of a plain
 * clickable Card/Row, everywhere in Compose (including inside library
 * code) -- flagging every one is one note per list row, not a defect
 * anyone asked about.
 */
describe("lintSemanticsTree: attribution -- only nodes the app can speak for are reported", () => {
  it("a clickable row with no role and no testTag anywhere in its ancestry is NOT reported", () => {
    // No PortholeScreen/portholeNode, no plain testTag, nowhere in the
    // tree -- exactly the unattributable library/framework UI the ruling
    // exists to keep quiet about.
    const root = node({
      stableId: "root",
      children: [node({ stableId: "row1", flags: ["clickable"], text: "Item" })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings.find((f) => f.id === "a11y-click-mismatch")).toBeUndefined();
  });

  it("the same clickable row IS reported once an ancestor carries a testTag (a PortholeScreen wrapping the list)", () => {
    const root = node({
      stableId: "root",
      testTag: "Cart", // stands in for PortholeScreen("Cart")
      children: [node({ stableId: "row1", flags: ["clickable"], text: "Item" })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    const finding = result.findings.find((f) => f.id === "a11y-click-mismatch");
    expect(finding).toBeDefined();
    expect(finding?.evidence).toMatchObject({ stableId: "row1" });
  });

  it("an unattributable finding is counted in coverage as a possible defect, not silently dropped", () => {
    const root = node({
      stableId: "root",
      children: [node({ stableId: "row1", flags: ["clickable"], text: "Item" })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings).toEqual([]);
    expect(
      result.coverage.some((c) => c.includes("1 possible defect(s) on nodes outside instrumented composables")),
    ).toBe(true);
  });

  it("a node's own testTag attributes it even with no attributable ancestor", () => {
    const root = node({
      stableId: "root",
      children: [node({ stableId: "row1", testTag: "Cart.RemoveButton", flags: ["clickable"], text: "Item" })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings.find((f) => f.id === "a11y-click-mismatch")).toBeDefined();
  });

  it("coverage always states the instrumented-node fraction (reusing render.ts's own semanticsTreeStats)", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "instrumented", testTag: "Cart.Row", text: "Item" })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    // 2 nodes total (root + instrumented child), both carry a testTag here.
    expect(result.coverage.some((c) => /\d+ node\(s\), \d+ unlabelled, \d+ instrumented/.test(c))).toBe(true);
  });
});

describe("summarizeAccessibilityResult and coverage", () => {
  it("says 'nothing found, N nodes checked' explicitly on a clean tree, as its own first line", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "clean1", text: "Hello" }), node({ stableId: "clean2", text: "World" })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings).toEqual([]);
    expect(result.nodesChecked).toBe(3);
    const summary = summarizeAccessibilityResult(result);
    expect(summary.split("\n")[0]).toBe("nothing found, 3 node(s) checked");
  });

  it("QA F7: carries every coverage sentence, not just the headline count", () => {
    const result = lintSemanticsTree(null, { density: null, fontScale: 1, capturedAt: 0 });
    const summary = summarizeAccessibilityResult(result);
    for (const sentence of result.coverage) {
      expect(summary).toContain(sentence);
    }
  });

  it("QA F7: carries the severity tally and the top findings, worst first, each with stableId, path/testTag and title", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [
        node({ stableId: "img1", role: "Image" }), // note
        node({
          stableId: "iconbtn1",
          role: "Button",
          testTag: "Cart.ClearPromo",
          flags: ["clickable"],
          bounds: rect(0, 0, 48, 48),
        }), // warning (missing label)
      ],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    const summary = summarizeAccessibilityResult(result);

    expect(summary).toContain("1 warning, 1 note");
    expect(summary).toContain("iconbtn1");
    expect(summary).toContain("Cart.ClearPromo");
    expect(summary).toContain("a11y-missing-label");
    // Worst (warning) named before the note.
    expect(summary.indexOf("a11y-missing-label")).toBeLessThan(summary.indexOf("a11y-image-no-description"));
  });

  it("QA F7: caps the listed findings and says how many more there are", () => {
    const children: SemanticsNode[] = [];
    for (let i = 0; i < 8; i++) {
      children.push(node({ stableId: `img${i}`, role: "Image" }));
    }
    const root = attributedRoot({ stableId: "root", children });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.findings.length).toBe(8);
    const summary = summarizeAccessibilityResult(result);
    expect(summary).toContain("+3 more finding(s)");
  });

  it("always states the Compose-only coverage caveat, even on a clean, untruncated tree", () => {
    const result = lintSemanticsTree(attributedRoot({ stableId: "root" }), {
      density: DENSITY,
      fontScale: 1,
      capturedAt: 0,
    });
    expect(result.coverage.some((c) => c.includes("Compose semantics tree"))).toBe(true);
  });

  it("adds a truncation caveat when any node in the tree was truncated", () => {
    const root = attributedRoot({ stableId: "root", children: [node({ stableId: "cut", truncated: true })] });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.coverage.some((c) => c.toLowerCase().includes("truncat"))).toBe(true);
  });

  it("checks zero nodes and still returns a coverage statement for a null root", () => {
    const result = lintSemanticsTree(null, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    expect(result.nodesChecked).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.coverage.length).toBeGreaterThan(0);
  });
});

describe("the stableId a finding names resolves through the same tree semantics_tree would return", () => {
  it("never invents or rewrites a stableId -- it is carried through from the parsed node, verbatim", () => {
    const root = attributedRoot({
      stableId: "root",
      children: [node({ stableId: "deadbeef", flags: ["clickable"], bounds: rect(0, 0, 10, 10) })],
    });
    const result = lintSemanticsTree(root, { density: DENSITY, fontScale: 1, capturedAt: 0 });
    const stableIds = result.findings.map((f) => f.evidence?.stableId);
    expect(stableIds).toContain("deadbeef");
    // And the same id is exactly what a raw (unlinted) parse of the same
    // wire tree would carry for that node -- the pass never touches it.
    const parsedAgain = parseSemanticsNode({
      stableId: "root",
      children: [{ stableId: "deadbeef", flags: ["clickable"], bounds: rect(0, 0, 10, 10) }],
    });
    expect(parsedAgain?.children[0].stableId).toBe("deadbeef");
  });
});

describe("the semantics-capture cache (GRA-72 open question 3: findings' fold-in)", () => {
  beforeEach(() => resetAccessibilityCaptureForTests());

  it("is empty until something records a capture", () => {
    expect(semanticsCaptureForWindow(0, 1_000_000)).toBeNull();
  });

  it("is visible only when the requested window actually covers the capture's own timestamp", () => {
    recordSemanticsCapture({ capturedAt: 5_000, root: null, density: 2, fontScale: 1 });
    expect(semanticsCaptureForWindow(0, 10_000)).not.toBeNull();
    expect(semanticsCaptureForWindow(0, 4_999)).toBeNull();
    expect(semanticsCaptureForWindow(5_001, 10_000)).toBeNull();
  });

  it("a later recording replaces the earlier one entirely -- there is only ever one capture in force", () => {
    recordSemanticsCapture({ capturedAt: 1_000, root: null, density: 2, fontScale: 1 });
    recordSemanticsCapture({ capturedAt: 9_000, root: null, density: 3, fontScale: 1.5 });
    expect(semanticsCaptureForWindow(0, 1_000)).toBeNull();
    expect(semanticsCaptureForWindow(8_000, 10_000)).toMatchObject({ capturedAt: 9_000, density: 3 });
  });
});
