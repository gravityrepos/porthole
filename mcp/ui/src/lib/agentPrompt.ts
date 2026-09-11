// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { DeviceEvent, ViewWindow } from "../types";
import { str } from "../types";

/**
 * Turns the current view into something you can paste at an assistant.
 *
 * The two halves of this tool share a clock but nothing that points at a moment
 * on it. Describing a spike in prose means the agent guesses a lookback and
 * hopes it overlaps; handing it the exact bounds means it can ask about the
 * thing you are actually looking at.
 */
export function agentPrompt(events: DeviceEvent[], view: ViewWindow): string {
  const from = Math.round(view.start);
  const to = Math.round(view.end);
  const inWindow = events.filter((event) => event.t >= from && event.t <= to);

  const counts = new Map<string, number>();
  for (const event of inWindow) counts.set(event.event, (counts.get(event.event) ?? 0) + 1);

  const summary =
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => `${kind} ${n}`)
      .join(", ") || "nothing";

  const screens = [
    ...new Set(
      inWindow
        .filter((event) => event.event === "recompose")
        .map((event) => str(event.data.screen)),
    ),
  ].filter(Boolean);
  const screenHint = screens.length === 1 ? ` The screen is "${screens[0]}".` : "";

  return `Using the Porthole MCP tools, look at device uptime ${from} to ${to}.
That window contains: ${summary}.${screenHint}
Start with recompositions {"from": ${from}, "to": ${to}}, frames and blocking over the same window, and logs {"from": ${from}, "to": ${to}, "level": "W"}.`;
}

/**
 * The same idea narrowed to one log line.
 *
 * A stack trace pasted on its own tells an agent what threw but not what the
 * app was doing when it did, so this carries the bounds of the surrounding
 * moment with it and leaves the trace intact underneath.
 */
export function logPrompt(event: DeviceEvent, events: DeviceEvent[]): string {
  const from = Math.max(0, Math.round(event.t - LOG_CONTEXT_MS));
  const to = Math.round(event.t + LOG_CONTEXT_MS);
  const around = events.filter((other) => other.t >= from && other.t <= to);

  const counts = new Map<string, number>();
  for (const other of around) counts.set(other.event, (counts.get(other.event) ?? 0) + 1);
  const summary =
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => `${kind} ${n}`)
      .join(", ") || "nothing";

  const level = str(event.data.level);
  const tag = str(event.data.tag);

  return `Using the Porthole MCP tools, explain this ${LEVEL_NAMES[level] ?? level} from "${tag}" at device uptime ${Math.round(event.t)}ms:

${str(event.data.message)}

The ${LOG_CONTEXT_MS * 2}ms around it contains: ${summary}.
For context, try recompositions {"from": ${from}, "to": ${to}}, frames and blocking over the same window, and logs {"from": ${from}, "to": ${to}, "level": "W"}.`;
}

/** How far either side of a line counts as "what was happening at the time". */
const LOG_CONTEXT_MS = 2000;

const LEVEL_NAMES: Record<string, string> = {
  V: "verbose line",
  D: "debug line",
  I: "info line",
  W: "warning",
  E: "error",
  F: "fatal error",
};
