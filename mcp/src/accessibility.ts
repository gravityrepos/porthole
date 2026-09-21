// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describeSemanticsTreeStats, semanticsTreeStats } from "./render.js";
import { whereForName } from "./sources.js";
import type { Confidence, Finding, Severity } from "./trace.js";

/**
 * GRA-72: the merged Compose semantics tree — what TalkBack reads — already
 * carries bounds, roles, text, state descriptions, actions and stable ids
 * (`runtime/.../collect/SemanticsCollector.kt`), and until this ticket
 * Porthole used it only to line a node up with its own recomposition count.
 * The same tree answers a short list of categorical, checkable questions
 * about accessibility that nobody in this loop otherwise answers:
 *
 *  - an interactive node with no label at all (`warning`)
 *  - a touch target measurably under the 48dp minimum (`warning` below
 *    24dp, `note` between 24dp and 48dp — see `TOUCH_TARGET_*` below for why
 *    the two are not the same severity)
 *  - a node that looks clickable but carries no click action, or the
 *    reverse (`note`)
 *  - a non-decorative image with no description (`note`)
 *  - a description repeated across siblings (`note`)
 *  - text whose box leaves it no room to grow at a large system font scale
 *    (`note`, `confidence: "correlated"` — see `TEXT_OVERFLOW_MARGIN_DP`)
 *
 * This module never talks to a live device — every export below is a pure
 * function over a tree already captured, plus the one small piece of
 * device state (density, font scale) needed to turn pixel bounds into
 * something a human threshold means anything against, and (QA F9,
 * `isAttributed` below) the project's own source tree, read the same
 * read-only, no-device way `sources.ts`'s `whereForName` already is from
 * `trace.ts`. `index.ts` is the only thing that knows how to fetch a tree
 * or a device profile; it calls in here once it has both.
 *
 * **Attribution (QA F9 — the EM's own ruling, 2026-09-13): "a finding
 * whose node is not attributable to the app's own composables is not a
 * finding. `stableId` is ours, and the instrumented-node coverage number
 * says how much of the screen we can speak for. Use both."** A raw
 * Compose semantics tree includes framework and library UI Porthole had no
 * hand in — `Modifier.clickable {}` with no explicit role is the ordinary
 * spelling for a plain clickable `Card`/`Row`, and library composables use
 * it constantly. Flagging every one of those is one note per list row, not
 * a defect anyone asked about. A node counts as attributable — and so does
 * everything beneath it, since a `PortholeScreen`/`portholeNode` wrapping a
 * whole screen or a whole row does not repeat itself on every descendant —
 * when it, or an ancestor, carries a `testTag` (a Porthole
 * `portholeNode`/`PortholeScreen` id becomes the wire `testTag` the same
 * way a plain `Modifier.testTag(...)` does, and both count: this is about
 * "an app author named this," not about which API did the naming), or its
 * own `text`/`contentDescription` resolves through `whereForName` to a
 * real declaration under the project root. A finding whose node (and every
 * ancestor) fails all three is not reported — it is counted in `coverage`
 * instead ("M possible defect(s) on nodes outside instrumented composables,
 * not reported"), never silently dropped.
 *
 * **Coverage, stated honestly.** This only ever sees what Compose's own
 * merged semantics tree exposes — a node drawn by a plain Android `View`
 * (no Compose wrapper) is invisible to this pass the same way it is
 * invisible to `semantics_tree` itself. A node Compose itself marked
 * `invisibleToUser` (QA F8) is skipped entirely, subtree and all — TalkBack
 * never reaches it either, so linting it would report defects on UI that
 * cannot actually be a defect in the one sense that matters here (nobody
 * using a screen reader ever encounters it) — and is counted separately
 * ("N node(s) hidden from assistive technology, not checked") rather than
 * folded into `nodesChecked`, which is reserved for nodes this pass
 * actually evaluated. `lintSemanticsTree`'s own `coverage` array is what
 * turns all of this into sentences a reader can act on rather than a
 * silent gap — including, always, the instrumented-node fraction
 * `render.ts`'s `semanticsTreeStats` already computes for `semantics_tree`
 * itself, reused here rather than a second, possibly-drifting copy of the
 * same number.
 *
 * **Explicitly out of scope** (do not extend this file to cover these
 * without a new ticket): colour contrast (nothing in the captured tree
 * carries a rendered colour), a View hierarchy's own accessibility tree,
 * and any claim of WCAG/platform compliance — this is a lint pass over what
 * the tree already proves, never a certification.
 */

// ---------------------------------------------------------------------------
// the tree, as the wire actually shapes it (SemanticsNodeDto, Protocol.kt)
// ---------------------------------------------------------------------------

export interface SemanticsRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SemanticsNode {
  nodeId: number;
  stableId: string;
  role: string | null;
  testTag: string | null;
  text: string | null;
  contentDescription: string | null;
  bounds: SemanticsRect | null;
  actions: string[];
  flags: string[];
  children: SemanticsNode[];
  truncated: boolean;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRect(value: unknown): SemanticsRect | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const left = Number(r.left);
  const top = Number(r.top);
  const right = Number(r.right);
  const bottom = Number(r.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return { left, top, right, bottom };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Defensive by design — this reads the raw device reply the same tolerant
 * way every other RPC result in this codebase does (`num`/`str` in
 * trace.ts), rather than trusting the wire matches `SemanticsNodeDto`
 * exactly. A node this cannot make sense of (no `stableId`, the one field
 * every other producer keys off) is dropped rather than carried forward
 * half-built; its children are still walked, since a malformed parent is no
 * reason to also blind the pass to real children beneath it.
 */
export function parseSemanticsNode(value: unknown): SemanticsNode | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const stableId = asString(r.stableId);
  if (!stableId) return null;
  const rawChildren = Array.isArray(r.children) ? r.children : [];
  return {
    nodeId: Number.isFinite(Number(r.nodeId)) ? Number(r.nodeId) : -1,
    stableId,
    role: asString(r.role),
    testTag: asString(r.testTag),
    text: asString(r.text),
    contentDescription: asString(r.contentDescription),
    bounds: asRect(r.bounds),
    actions: asStringArray(r.actions),
    flags: asStringArray(r.flags),
    children: rawChildren.map(parseSemanticsNode).filter((n): n is SemanticsNode => n !== null),
    truncated: r.truncated === true,
  };
}

// ---------------------------------------------------------------------------
// thresholds — named, so a QA round can change one number in one place
// ---------------------------------------------------------------------------

/** Android's own documented minimum: a touch target under this is a real defect regardless of anything Compose might do about it automatically. */
const TOUCH_TARGET_MIN_DP = 48;

/**
 * GRA-72 open question 2, decided: Compose's `minimumInteractiveComponentSize`
 * modifier — wired into `IconButton`, `Checkbox`, `RadioButton`, `Switch`
 * and friends by default — pads a visually smaller target back up to 48dp
 * at touch-resolution time, invisibly to the semantics tree (`bounds` here
 * is always the *visual* bounds, never the padded touch bounds; there is no
 * signal in the captured tree for whether a parent disabled the minimum).
 * So a target measured between this and `TOUCH_TARGET_MIN_DP` is a `note`,
 * not a `warning`: it may already be fixed by a mechanism this pass cannot
 * see. Below this line the shortfall is too large for that automatic
 * padding to plausibly explain away, so it is a `warning`. This is a
 * documented, conservative simplification, not a claim that every gap
 * between 24 and 48dp is safe — the finding says so explicitly.
 */
const TOUCH_TARGET_WARNING_DP = 24;

/** Below this system font scale, text overflowing its box at a *larger* scale is not this pass's concern — 1.3 is the ticket's own line, chosen to skip the common, cosmetically-fine range and flag only a scale large enough that a tight box is a real risk. */
const FONT_SCALE_OVERFLOW_THRESHOLD = 1.3;

/** How close (in dp) a text node's box has to sit to its parent's on every edge to count as "no room to grow" — conservative on purpose (GRA-72's own instruction): a wide margin here undercounts real risk rather than crying wolf on every label with a few points of padding. */
const TEXT_OVERFLOW_MARGIN_DP = 4;

/**
 * Roles a `Role.Button`-shaped API sets deliberately, matching how Compose's
 * `Role` enum itself renders (`Role.toString()`). Anything else with a
 * click action but no role, or one of these with no click action, is a
 * click-mismatch candidate — see the "click/role mismatch" block inside
 * `lintSemanticsTree`'s own `visit`.
 */
const INTERACTIVE_ROLES = new Set(["Button", "Checkbox", "Switch", "RadioButton", "Tab", "DropdownList"]);

// ---------------------------------------------------------------------------
// the pass
// ---------------------------------------------------------------------------

export type AccessibilityFindingId =
  | "a11y-missing-label"
  | "a11y-touch-target-small"
  | "a11y-click-mismatch"
  | "a11y-image-no-description"
  | "a11y-duplicate-description"
  | "a11y-text-overflow-risk";

export interface AccessibilityOptions {
  /** px-per-dp (`DisplayMetrics.density`, `ProfileData.density`), or `null`/`0` when unknown — see `lintSemanticsTree`'s own comment for what runs anyway and what does not. */
  density: number | null;
  /** The system font scale at capture time (`resolveFontScale`); defaults to 1 (no scaling) when unknown, which simply never crosses `FONT_SCALE_OVERFLOW_THRESHOLD`. */
  fontScale: number;
  /** Device uptime ms the tree was captured at — every finding is placed there as a zero-width `window`, a snapshot of one instant, never a span. */
  capturedAt: number;
}

export interface AccessibilityResult {
  findings: Finding[];
  nodesChecked: number;
  /** Plain-English statements of what this pass did and did not look at — always non-empty, so a clean report still says what it covered. */
  coverage: string[];
}

function dpWidth(rect: SemanticsRect, density: number): number {
  return (rect.right - rect.left) / density;
}
function dpHeight(rect: SemanticsRect, density: number): number {
  return (rect.bottom - rect.top) / density;
}

function pathSegment(node: SemanticsNode, index: number): string {
  if (node.testTag) return `tag:${node.testTag}`;
  if (node.role) return `role:${node.role}`;
  return `i:${index}`;
}

function pointFinding(
  id: AccessibilityFindingId,
  severity: Severity,
  confidence: Confidence,
  title: string,
  detail: string,
  evidence: Record<string, unknown>,
  capturedAt: number,
): Finding {
  return {
    id,
    severity,
    confidence,
    title,
    detail,
    evidence,
    window: { from: capturedAt, to: capturedAt },
  };
}

/**
 * QA F9: is `node` itself attributable to the app? Three ways, any one is
 * enough — see this module's own doc comment for the EM ruling this
 * implements. `whereForName` is `undefined` (not merely unresolved)
 * whenever `PORTHOLE_PROJECT_ROOT` is unset, in which case this degrades to
 * "has a testTag" alone, the same conservative "off means off, never a
 * guess" rule `sources.ts` already follows everywhere else.
 */
function isAttributed(node: SemanticsNode): boolean {
  if (node.testTag) return true;
  if (node.text && whereForName(node.text)?.resolved) return true;
  if (node.contentDescription && whereForName(node.contentDescription)?.resolved) return true;
  return false;
}

/**
 * Walks the whole tree once, producing every finding in one pass rather
 * than one traversal per rule — the tree can legitimately be 1500 nodes
 * (`semantics_tree`'s own `maxNodes` default) and this runs on every
 * `accessibility` call plus, when a capture is in the window, every
 * `findings` call, so re-walking per rule is a real cost this avoids on
 * purpose.
 */
export function lintSemanticsTree(root: SemanticsNode | null, options: AccessibilityOptions): AccessibilityResult {
  const findings: Finding[] = [];
  const coverage = [
    "Only the Compose semantics tree is checked — a node drawn by a plain " +
      "Android View is invisible to this pass the same way it is invisible " +
      "to TalkBack reading the merged tree.",
  ];
  let nodesChecked = 0;
  let hiddenCount = 0;
  let unattributedCount = 0;
  let sawTruncation = false;
  const density = options.density && options.density > 0 ? options.density : null;
  if (!density) {
    coverage.push("Device density was not available, so touch-target-size checks were skipped entirely.");
  }

  /**
   * QA F8: `invisibleToUser` hides `node` and, per Compose semantics,
   * everything beneath it from every assistive technology — never counted
   * toward `nodesChecked`, never the subject of a rule (a clickable node
   * that is also invisibleToUser used to still earn a missing-label
   * warning; TalkBack never reaches it at all, so that warning was never
   * true), and never walked for its own children's sake either, since they
   * inherit the same invisibility.
   */
  function countHidden(node: SemanticsNode): void {
    hiddenCount++;
    for (const child of node.children) countHidden(child);
  }

  /** QA F9: records `candidate` as a real finding only when `attributed`; otherwise it becomes one of `unattributedCount`'s "possible defects," never silently dropped and never listed either. */
  function record(candidate: Finding, attributed: boolean): void {
    if (attributed) findings.push(candidate);
    else unattributedCount++;
  }

  function visit(node: SemanticsNode, parent: SemanticsNode | null, path: string, ancestorAttributed: boolean): void {
    if (node.flags.includes("invisibleToUser")) {
      countHidden(node);
      return;
    }

    nodesChecked++;
    if (node.truncated) sawTruncation = true;
    const attributed = ancestorAttributed || isAttributed(node);

    const isClickable = node.flags.includes("clickable");
    const isInteractiveLooking = isClickable || (node.role !== null && INTERACTIVE_ROLES.has(node.role));
    const hasLabel = Boolean(node.text || node.contentDescription);

    // -- missing label -----------------------------------------------------
    // GRA-72 open question 1: only an interactive node or a non-decorative
    // image is ever flagged here — a decorative icon with no description is
    // correct, not a defect, and never reaches this branch (it has neither
    // a click action nor an interactive role).
    if (isInteractiveLooking && !hasLabel) {
      record(
        pointFinding(
          "a11y-missing-label",
          "warning",
          "observed",
          `Interactive node has no label: ${path}`,
          "This node is clickable (or carries a role that implies it), but has neither " +
            "text nor a contentDescription — a screen reader has nothing to announce for it.",
          { stableId: node.stableId, path, testTag: node.testTag, role: node.role },
          options.capturedAt,
        ),
        attributed,
      );
    }

    // -- touch target too small ---------------------------------------------
    if (density && isClickable && node.bounds) {
      const w = dpWidth(node.bounds, density);
      const h = dpHeight(node.bounds, density);
      const minSide = Math.min(w, h);
      if (minSide < TOUCH_TARGET_MIN_DP) {
        const warning = minSide < TOUCH_TARGET_WARNING_DP;
        record(
          pointFinding(
            "a11y-touch-target-small",
            warning ? "warning" : "note",
            "observed",
            `Touch target measures ${Math.round(w)}x${Math.round(h)}dp: ${path}`,
            warning
              ? `Below ${TOUCH_TARGET_WARNING_DP}dp on its shortest side — too small for Compose's own ` +
                "automatic minimumInteractiveComponentSize padding to plausibly explain away."
              : `Under the ${TOUCH_TARGET_MIN_DP}dp minimum, but Compose may already pad this to ` +
                `${TOUCH_TARGET_MIN_DP}dp at touch time via minimumInteractiveComponentSize (IconButton, ` +
                "Checkbox and friends apply it by default) — this bounds figure is the visual size only, " +
                "not necessarily the real touch target, so treat this as worth a look rather than confirmed.",
            {
              stableId: node.stableId,
              path,
              testTag: node.testTag,
              measuredDp: { width: Math.round(w * 10) / 10, height: Math.round(h * 10) / 10 },
            },
            options.capturedAt,
          ),
          attributed,
        );
      }
    }

    // -- click/role mismatch -------------------------------------------------
    // Not "no click action registered" in the literal wire sense --
    // SemanticsCollector derives the "clickable" flag from the presence of
    // exactly that action, so the two can never disagree on the wire. What
    // is actually checkable, and useful: a role that implies "this is
    // actionable" with no click action behind it (looks interactive, is
    // not), and the reverse (is interactive, carries no role a screen
    // reader would announce as actionable).
    if (node.role !== null && INTERACTIVE_ROLES.has(node.role) && !isClickable) {
      record(
        pointFinding(
          "a11y-click-mismatch",
          "note",
          "observed",
          `Role ${node.role} with no click action: ${path}`,
          `This node's role (${node.role}) implies it is actionable, but it carries no click action of its own.`,
          { stableId: node.stableId, path, testTag: node.testTag, role: node.role },
          options.capturedAt,
        ),
        attributed,
      );
    } else if (isClickable && node.role === null) {
      record(
        pointFinding(
          "a11y-click-mismatch",
          "note",
          "observed",
          `Clickable node with no semantic role: ${path}`,
          "This node has a click action but no semantic role, so a screen reader may not announce it as actionable.",
          { stableId: node.stableId, path, testTag: node.testTag },
          options.capturedAt,
        ),
        attributed,
      );
    }

    // -- decorative-vs-real image ---------------------------------------------
    // GRA-72 open question 1: a decorative image marked invisibleToUser
    // never reaches here at all any more (F8 skips its whole node before
    // any rule runs), so the `!node.flags.includes("invisibleToUser")`
    // guard this used to need is gone — dead by construction now, not by
    // coincidence.
    if (node.role === "Image" && !node.contentDescription) {
      record(
        pointFinding(
          "a11y-image-no-description",
          "note",
          "observed",
          `Image has no description: ${path}`,
          "A Role.Image node with no contentDescription, and not marked invisibleToUser (which would mean " +
            "it was deliberately made decorative) — a screen reader has nothing to say about it.",
          { stableId: node.stableId, path, testTag: node.testTag },
          options.capturedAt,
        ),
        attributed,
      );
    }

    // -- text overflow risk at a large font scale -----------------------------
    if (
      density &&
      options.fontScale > FONT_SCALE_OVERFLOW_THRESHOLD &&
      node.text &&
      node.bounds &&
      parent?.bounds
    ) {
      const left = (node.bounds.left - parent.bounds.left) / density;
      const right = (parent.bounds.right - node.bounds.right) / density;
      const top = (node.bounds.top - parent.bounds.top) / density;
      const bottom = (parent.bounds.bottom - node.bounds.bottom) / density;
      const tight = [left, right, top, bottom].every((gap) => gap >= 0 && gap <= TEXT_OVERFLOW_MARGIN_DP);
      if (tight) {
        record(
          pointFinding(
            "a11y-text-overflow-risk",
            "note",
            "correlated",
            `Text box leaves little room to grow: ${path}`,
            `Font scale is ${options.fontScale}x (over the ${FONT_SCALE_OVERFLOW_THRESHOLD}x line this checks ` +
              `at) and this node's box sits within ${TEXT_OVERFLOW_MARGIN_DP}dp of its parent on every edge -- ` +
              "correlated, not observed: this is where overflow is plausible, not a confirmed clip.",
            { stableId: node.stableId, path, testTag: node.testTag, fontScale: options.fontScale },
            options.capturedAt,
          ),
          attributed,
        );
      }
    }

    // -- duplicated descriptions among this node's own (visible) children ----
    const visibleChildren = node.children.filter((c) => !c.flags.includes("invisibleToUser"));
    if (visibleChildren.length > 1) {
      const byDescription = new Map<string, SemanticsNode[]>();
      for (const child of visibleChildren) {
        if (!child.contentDescription) continue;
        const list = byDescription.get(child.contentDescription);
        if (list) list.push(child);
        else byDescription.set(child.contentDescription, [child]);
      }
      for (const [description, siblings] of byDescription) {
        if (siblings.length < 2) continue;
        record(
          pointFinding(
            "a11y-duplicate-description",
            "note",
            "observed",
            `${siblings.length} siblings share the description "${description}": ${path}`,
            "A screen reader announces the same description for each of these, with nothing to tell them apart.",
            {
              path,
              description,
              siblings: siblings.map((s) => ({ stableId: s.stableId, testTag: s.testTag })),
            },
            options.capturedAt,
          ),
          attributed,
        );
      }
    }

    node.children.forEach((child, i) => visit(child, node, `${path}/${pathSegment(child, i)}`, attributed));
  }

  if (root) visit(root, null, pathSegment(root, 0), false);

  if (sawTruncation) {
    coverage.push(
      "The capture was truncated -- it hit its own node/depth budget partway through, so part of the tree was never checked.",
    );
  }
  if (hiddenCount > 0) {
    coverage.push(`${hiddenCount} node(s) hidden from assistive technology, not checked.`);
  }
  if (unattributedCount > 0) {
    coverage.push(
      `${unattributedCount} possible defect(s) on nodes outside instrumented composables, not reported.`,
    );
  }
  // QA F9: the instrumented-node fraction `render.ts` already computes for
  // `semantics_tree`'s own summary, reused rather than a second, possibly-
  // drifting count of the same thing.
  const stats = semanticsTreeStats(root);
  const statsLine = describeSemanticsTreeStats(stats);
  if (statsLine) coverage.push(statsLine);

  return { findings, nodesChecked, coverage };
}

/** Sort order for `summarizeAccessibilityResult`'s own top-findings list — the same severity ordering `trace.ts`'s `sortBySeverity` uses. */
const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, note: 2 };

/** How many findings `summarizeAccessibilityResult` names before saying "+N more" — same "cut list" convention `describeUnattributableFields` (render.ts) already uses. */
const SUMMARY_FINDING_CAP = 5;

/**
 * QA F7 (blocker): at `detail: "summary"` — the default since GRA-68 — this
 * string *is* the entire user-visible answer; no payload is attached at
 * all. The one-line "N finding(s) over M node(s) checked" this used to
 * return failed the ticket's own acceptance criteria the moment GRA-68
 * shipped: no stableId, no path, no title, no coverage, at the level an
 * agent actually sees by default. This now carries, in order: the headline
 * count; the tally by severity; every coverage sentence
 * (`lintSemanticsTree`'s own array — hidden/unattributed/instrumented-
 * fraction included); and the worst `SUMMARY_FINDING_CAP` findings, each as
 * `<severity> <id> <stableId> <path/testTag> — <title>` (a touch-target
 * finding's `title` already carries its own measured size).
 */
export function summarizeAccessibilityResult(result: AccessibilityResult): string {
  const lines: string[] = [];

  lines.push(
    result.findings.length === 0
      ? `nothing found, ${result.nodesChecked} node(s) checked`
      : `${result.findings.length} finding(s) over ${result.nodesChecked} node(s) checked`,
  );

  if (result.findings.length > 0) {
    const bySeverity = new Map<string, number>();
    for (const f of result.findings) bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
    const tally = (["error", "warning", "note"] as const)
      .filter((s) => bySeverity.has(s))
      .map((s) => `${bySeverity.get(s)} ${s}`)
      .join(", ");
    lines.push(tally);
  }

  for (const sentence of result.coverage) lines.push(sentence);

  if (result.findings.length > 0) {
    const sorted = [...result.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    const shown = sorted.slice(0, SUMMARY_FINDING_CAP);
    for (const f of shown) {
      const evidence = (f.evidence ?? {}) as Record<string, unknown>;
      const stableId = typeof evidence.stableId === "string" ? evidence.stableId : "";
      const where =
        (typeof evidence.path === "string" && evidence.path) ||
        (typeof evidence.testTag === "string" && evidence.testTag) ||
        "";
      lines.push(`${f.severity} ${f.id} ${stableId} ${where} -- ${f.title}`);
    }
    const remaining = sorted.length - shown.length;
    if (remaining > 0) {
      lines.push(`+${remaining} more finding(s) -- call at detail: "normal" or "full" for the rest.`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// GRA-72 open question 3, decided: `findings` never pays for a fresh
// semantics capture on its own — that would add a live RPC to a tool every
// caller runs constantly, most of whom never asked about accessibility.
// Instead, whichever tool most recently captured the tree (the new
// `accessibility` tool, or the pre-existing `semantics_tree` tool — both
// legitimately "a semantics capture") records it here; `findings` only
// folds the resulting a11y findings in when that capture's own timestamp
// falls inside the window being asked about, and skips the check (and the
// cost of even asking) otherwise. Documented on `semanticsCaptureForWindow`
// below, not only here, since that is the function callers actually read.
// ---------------------------------------------------------------------------

export interface SemanticsCapture {
  capturedAt: number;
  root: SemanticsNode | null;
  density: number | null;
  fontScale: number;
}

let lastCapture: SemanticsCapture | null = null;

/** Called by every tool (`semantics_tree`, `accessibility`) that fetches a fresh tree from the device — the one place this module learns one exists. */
export function recordSemanticsCapture(capture: SemanticsCapture): void {
  lastCapture = capture;
}

/**
 * The most recent capture, but only when it actually falls inside
 * `[from, to]` — a capture from outside the window being asked about is not
 * "a semantics capture exists in the window," it is a stale one from
 * earlier or later, and folding its findings into an unrelated window would
 * misattribute them to a moment they do not describe. `null` here is what
 * tells `findings` to skip the fold-in (and the recompute) entirely.
 */
export function semanticsCaptureForWindow(from: number, to: number): SemanticsCapture | null {
  if (!lastCapture) return null;
  return lastCapture.capturedAt >= from && lastCapture.capturedAt <= to ? lastCapture : null;
}

/** Test-only: so one test's capture never leaks into another's "is there one in the window" check. */
export function resetAccessibilityCaptureForTests(): void {
  lastCapture = null;
}
