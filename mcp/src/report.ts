// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { Finding, Trace } from "./trace.js";
import { frameBudgetMs } from "./trace.js";

/**
 * Lanes a reader should be told were checked and found quiet.
 *
 * Every key a lane can raise a finding from has to be listed here, or the
 * footer ends up contradicting the list above it: a capture with three wedged
 * HTTP calls printed "quiet: http" directly beneath the warning that named
 * them, because the lane keyed on `http.failed` alone and a call that never
 * returns never fails. The two must be added together, so a new lane metric is
 * only half-added until it appears in this table.
 */
const CHECKED: Array<{ label: string; keys: string[] }> = [
  { label: "http", keys: ["http.failed", "http.stillOpen"] },
  { label: "db", keys: ["db.onMainThread", "db.stillOpen"] },
  { label: "main thread", keys: ["mainThread.stalls"] },
  { label: "frames", keys: ["frames.missed"] },
  { label: "work", keys: ["work.retries", "work.failures", "work.stillOpen"] },
  { label: "memory", keys: ["memory.blockingGcMs"] },
];

const LABEL: Record<Finding["severity"], string> = {
  error: "ERROR  ",
  warning: "WARNING",
  note: "NOTE   ",
};

// Raw ANSI SGR codes — no dependency, for four escape sequences. Reset is a
// full SGR reset (`\x1b[0m`) rather than a scoped "un-bold"/"un-dim" code so
// that wrapping never depends on which attribute was opened.
const ANSI_RESET = "\x1b[0m";
const ANSI_RED = "\x1b[31m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_DIM = "\x1b[2m";

const SEVERITY_COLOR: Record<Finding["severity"], string> = {
  error: ANSI_RED,
  warning: ANSI_YELLOW,
  note: ANSI_DIM,
};

/**
 * Whether the severity token in a rendered report should carry colour.
 *
 * Colour belongs on the TTY path a human reads — never on a pipe, CI, or the
 * MCP tool result text an agent reads, where escape bytes are just noise a
 * model has to see past. So this is a question about one output stream, not
 * a global: `porthole capture` writes its summary to stderr while `porthole
 * report` writes to stdout, and the two can disagree about whether they are
 * a terminal (`cmd | less` redirects stdout but leaves stderr a TTY).
 * Callers pass the stream they are about to write to.
 *
 * NO_COLOR (https://no-color.org) is honoured unconditionally when set to
 * anything, including an empty string — the convention is "the variable is
 * present", not "the variable is truthy", so this checks `undefined` rather
 * than falsiness.
 */
export function shouldColor(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(stream.isTTY) && env.NO_COLOR === undefined;
}

function colorSeverity(severity: Finding["severity"], color: boolean): string {
  const label = LABEL[severity];
  return color ? `${SEVERITY_COLOR[severity]}${label}${ANSI_RESET}` : label;
}

export interface RenderReportOptions {
  /**
   * Colour the severity token. Defaults to false: plain text is the safe
   * default for every caller that does not explicitly opt in. That default —
   * not a TTY check inside this function — is what keeps the MCP `findings`
   * tool's text plain (it does not call this with `color: true`, and never
   * will; it does not even call this function) and keeps every existing
   * non-TTY test passing unchanged, by construction rather than by convention.
   */
  color?: boolean;
}

/**
 * One of the footer counts, saying how many of them never finished.
 *
 * The counts deliberately include spans that were still open when the capture
 * ended — a query that never came back still happened and still cost the wait.
 * But "40 queries" reads as forty completions to anyone who does not know that,
 * and this line is the part of the report people quote. The qualifier travels
 * with the number, the same way `atLeastMs` carries its own. It is left off
 * entirely when nothing was open, which is almost every run.
 */
function counted(trace: Trace, total: string, open: string, noun: string): string {
  const stillOpen = trace.metrics[open] ?? 0;
  const suffix = stillOpen > 0 ? ` (${stillOpen} still open)` : "";
  return `${trace.metrics[total]} ${noun}${suffix}`;
}

export function renderReport(trace: Trace, options: RenderReportOptions = {}): string {
  const color = options.color ?? false;
  const lines: string[] = [];
  const device = trace.device as Record<string, unknown>;
  const hz = Number(device.refreshHz) || 60;

  lines.push(
    [
      trace.scenario,
      `${(trace.durationMs / 1000).toFixed(1)}s`,
      `${device.model ?? "unknown device"} (${Math.round(hz)}Hz)`,
      trace.app.packageName,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  lines.push("");

  if (trace.findings.length === 0) {
    lines.push("  nothing worth reporting");
  }

  // Severity order, not grouped by mark. Grouping reads well until the first
  // marked run, where it drops an ERROR below two WARNINGs and defeats the one
  // job of a prioritised list. The mark rides along on the line instead.
  for (const finding of trace.findings) {
    lines.push(`  ${colorSeverity(finding.severity, color)}  ${finding.title}`);
    if (finding.during) lines.push(`           during "${finding.during}"`);
    if (finding.detail) lines.push(`           ${finding.detail}`);
  }

  const quiet = CHECKED.filter((lane) =>
    lane.keys.every((key) => (trace.metrics[key] ?? 0) === 0),
  ).map((lane) => lane.label);

  // Saying what was checked and found clean matters as much as the findings. A
  // report that only ever lists problems gives no signal that the things it did
  // not mention were looked at.
  if (quiet.length > 0) {
    lines.push("");
    lines.push(`  quiet: ${quiet.join(", ")}`);
  }

  lines.push("");
  lines.push(
    `  frame budget ${frameBudgetMs(hz)}ms · ` +
      `${trace.metrics["recompose.total"]} recompositions · ` +
      `${counted(trace, "http.calls", "http.stillOpen", "calls")} · ` +
      `${counted(trace, "db.queries", "db.stillOpen", "queries")}`,
  );
  if (trace.marks.length > 0) lines.push(`  ${trace.marks.length} marks`);
  if (trace.driver) lines.push(`  driver: ${trace.driver}`);

  return lines.join("\n") + "\n";
}

export interface Change {
  key: string;
  before: number;
  after: number;
  kind: "new" | "regressed" | "improved" | "unchanged";
}

/** Metrics where a larger number is better. Everything else is the other way. */
const HIGHER_IS_BETTER = new Set<string>();

/**
 * Below both of these, a difference is noise.
 *
 * Timing metrics move run to run. With only a relative floor a small absolute
 * change looks enormous; with only an absolute one a large metric never moves
 * enough. Without both, every run is a regression and the check gets switched
 * off, which is the real failure mode.
 */
const RELATIVE_FLOOR = 0.1;
const ABSOLUTE_FLOOR = 3;

export function compareMetrics(
  before: Record<string, number>,
  after: Record<string, number>,
): Change[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

  return keys.map((key) => {
    const a = before[key] ?? 0;
    const b = after[key] ?? 0;
    const worse = HIGHER_IS_BETTER.has(key) ? b < a : b > a;

    // Categorical, not a drift: the first main-thread query, the first failing
    // call. No floor should hide one of these.
    if (a === 0 && b > 0) return { key, before: a, after: b, kind: "new" as const };
    if (a === b) return { key, before: a, after: b, kind: "unchanged" as const };

    const absolute = Math.abs(b - a);
    const relative = a === 0 ? 1 : absolute / a;
    if (absolute < ABSOLUTE_FLOOR || relative < RELATIVE_FLOOR) {
      return { key, before: a, after: b, kind: "unchanged" as const };
    }

    return { key, before: a, after: b, kind: worse ? "regressed" : "improved" };
  });
}

/** Why two traces cannot honestly be compared, or null if they can. */
export function comparability(before: Trace, after: Trace): string | null {
  if (before.scenario !== after.scenario) {
    return `different scenarios: "${before.scenario}" and "${after.scenario}"`;
  }

  const a = before.device as Record<string, unknown>;
  const b = after.device as Record<string, unknown>;

  // Only a known difference counts. A capture that attached to an app already
  // running may not have seen the device profile, and two absent values are not
  // a mismatch — compared as numbers they become NaN !== NaN, which refuses
  // every pair of traces that happen to be missing the same field.
  const differs = (key: string): boolean => {
    const left = a[key];
    const right = b[key];
    if (left === undefined || right === undefined) return false;
    return left !== right;
  };

  if (differs("refreshHz")) {
    return `different refresh rates: ${a.refreshHz}Hz and ${b.refreshHz}Hz — frame budgets differ`;
  }
  if (differs("cores")) {
    return `different core counts: ${a.cores} and ${b.cores}`;
  }
  if (differs("lowRamDevice")) {
    return "one capture is from a low-RAM device and the other is not";
  }
  return null;
}

export function renderComparison(
  before: Trace,
  after: Trace,
): { text: string; regressed: boolean; refused: boolean } {
  const blocked = comparability(before, after);
  if (blocked) {
    return {
      text:
        `refusing to compare: ${blocked}\n\n` +
        "  A number from two runs that were never comparable is worse than no\n" +
        "  number, because someone will act on it.\n",
      regressed: false,
      refused: true,
    };
  }

  const changes = compareMetrics(before.metrics, after.metrics);
  const notable = changes.filter((c) => c.kind !== "unchanged");
  const unchanged = changes.length - notable.length;
  const lines: string[] = [];

  lines.push(`${after.scenario} · against a baseline of ${before.capturedAt}`);
  lines.push("");

  for (const change of notable) {
    const label = change.kind === "improved" ? "improved " : change.kind.toUpperCase().padEnd(9);
    const delta =
      change.kind === "new"
        ? "new"
        : `(${change.after > change.before ? "+" : ""}${Math.round(((change.after - change.before) / (change.before || 1)) * 100)}%)`;
    lines.push(`  ${label} ${change.key.padEnd(24)} ${change.before} → ${change.after}  ${delta}`);
  }

  if (notable.length === 0) lines.push("  nothing moved");
  lines.push("");
  lines.push(`  unchanged: ${unchanged} other metrics`);

  // An agentic driver reasons between steps and does not walk the same path
  // twice, so its timings drift for reasons that are not the code's.
  if (after.driver && after.driver !== before.driver) {
    lines.push("");
    lines.push(`  note: drivers differ ("${before.driver ?? "?"}" then "${after.driver}")`);
  }

  return {
    text: lines.join("\n") + "\n",
    regressed: notable.some((c) => c.kind === "regressed" || c.kind === "new"),
    refused: false,
  };
}
