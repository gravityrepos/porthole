// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { DeviceEvent, Span } from "../types";
import { list, num, str } from "../types";

/**
 * Pairs `X_start` with `X_end` by id, so open work renders as a bar rather than
 * two unrelated dots. A call still in flight runs to the newest event, which is
 * what "still going" looks like on a time axis.
 */
export function buildSpans(events: DeviceEvent[], prefix: string): Span[] {
  const open = new Map<string, { start: number; data: Record<string, unknown>; id: string }>();
  const spans: Span[] = [];

  for (const event of events) {
    if (event.event === prefix + "_start") {
      const id = str(event.data.id);
      open.set(id, { start: event.t, data: event.data, id });
    } else if (event.event === prefix + "_end") {
      const id = str(event.data.id);
      const started = open.get(id);
      open.delete(id);
      spans.push({
        id,
        start: started ? started.start : event.t - num(event.data.elapsedMs),
        end: event.t,
        open: false,
        data: { ...(started?.data ?? {}), ...event.data },
      });
    }
  }

  const newest = events.length ? events[events.length - 1].t : 0;
  for (const [, started] of open) {
    spans.push({
      id: started.id,
      start: started.start,
      end: newest,
      open: true,
      data: started.data,
    });
  }

  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Anonymous, but carrying one of the app's own types: unregistered state that
 * belongs to you. It belongs in the "yours" half, because that is what it is.
 */
export function isYours(event: DeviceEvent): boolean {
  return list(event.data.named).length > 0 || list(event.data.yours).length > 0;
}

export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + (parsed.search ? "?…" : "");
  } catch {
    return url;
  }
}
