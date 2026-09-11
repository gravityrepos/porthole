// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Recording a Perfetto trace from the device, and saying what is in it.
 *
 * Deliberately does not return the trace. A ten-second capture is tens of
 * megabytes of protobuf, and the instinct to hand that to a model is the wrong
 * one — it is not summarisable by reading it, and the useful form is a file you
 * open in a trace viewer plus a sentence saying whether it is worth opening.
 *
 * What makes this worth having at all is that the app's own spans are already
 * inside it. The runtime writes its navigations, HTTP calls, queries and stalls
 * as atrace sections, so a capture arrives annotated with what the app was
 * doing rather than only what the kernel was doing.
 */

/**
 * A useful default for looking at jank.
 *
 * Note what is *not* here: `app`. The runtime's sections are written under
 * ATRACE_TAG_APP, and that tag is not a category — it is enabled per package
 * with perfetto's `--app`. Passing "app" in this list enables nothing, which
 * was verified by reading debug.atrace.tags.enableflags during a capture and
 * finding 0xa: VIEW and GRAPHICS set, ATRACE_TAG_APP (0x1000) clear. The
 * capture succeeded and contained no Porthole slices at all.
 */
export const DEFAULT_CATEGORIES = [
  "sched",
  "freq",
  "idle",
  "gfx",
  "view",
  "wm",
  "am",
  "binder_driver",
  "dalvik",
];

export interface CapturePlan {
  categories: string[];
  /** Packages whose ATRACE_TAG_APP sections are recorded. */
  apps: string[];
  seconds: number;
  devicePath: string;
  /** Warnings about the plan itself, before anything is recorded. */
  notes: string[];
}

/**
 * Works out what to record, and says when the request undercuts itself.
 *
 * Without a package in `apps`, the capture contains no Porthole sections and
 * gives no indication why — it simply succeeds and is unannotated, which reads
 * as the runtime being broken. So the absence is called out rather than left to
 * be discovered in a trace viewer.
 */
export function planCapture(options: {
  seconds?: number;
  categories?: string[];
  apps?: string[];
  now?: number;
}): CapturePlan {
  const notes: string[] = [];

  const seconds = Math.min(Math.max(Math.round(options.seconds ?? 10), 1), 120);
  if (options.seconds !== undefined && seconds !== Math.round(options.seconds)) {
    notes.push(`Duration clamped to ${seconds}s; 1 to 120 is the supported range.`);
  }

  const categories = (
    options.categories?.length ? [...options.categories] : [...DEFAULT_CATEGORIES]
  ).filter((c) => {
    // Passing it is harmless but does nothing, and someone who passed it
    // believes their app sections are being recorded. They are not.
    if (c === "app") {
      notes.push(
        "Dropped the `app` category: it is not one. App sections come from " +
          "ATRACE_TAG_APP, which is enabled per package — pass the package in `apps`.",
      );
      return false;
    }
    return true;
  });

  const apps = options.apps?.filter((a) => a.trim().length > 0) ?? [];
  if (apps.length === 0) {
    notes.push(
      "No app named, so this trace will have no Porthole sections in it. Pass the " +
        "package under test in `apps` to record the runtime's navigations, calls and stalls.",
    );
  }

  const stamp = options.now ?? Date.now();
  return {
    categories,
    apps,
    seconds,
    // The traced service writes here; a path under /sdcard is not writable by it.
    devicePath: `/data/misc/perfetto-traces/porthole-${stamp}.pftrace`,
    notes,
  };
}

/** The on-device command, in Perfetto's shorthand form. */
export function captureArgs(plan: CapturePlan): string[] {
  return [
    "shell",
    "perfetto",
    "-o",
    plan.devicePath,
    "-t",
    `${plan.seconds}s`,
    // One --app per package. This, not a category, is what turns on the tag
    // the runtime's sections are written under.
    ...plan.apps.flatMap((app) => ["--app", app]),
    ...plan.categories,
  ];
}

/**
 * Whether the app's own sections made it into the capture.
 *
 * A byte search for the prefix, not a parse. Slice names are interned as plain
 * strings in the protobuf, so finding it is good evidence they are there and
 * not finding it is good evidence they are not — which is the question worth
 * answering before someone opens a trace expecting annotations.
 *
 * Counting matches would overstate it: a name is interned once and referenced
 * many times, so the count is of distinct labels, not of slices.
 */
export function countPortholeLabels(trace: Buffer): number {
  const needle = Buffer.from("porthole: ", "utf8");
  let found = 0;
  let at = trace.indexOf(needle);
  while (at !== -1) {
    found += 1;
    at = trace.indexOf(needle, at + needle.length);
  }
  return found;
}

export interface CaptureResult {
  path: string;
  bytes: number;
  seconds: number;
  categories: string[];
  portholeLabels: number;
  notes: string[];
}

/** One sentence: whether it worked, how big, and whether it is annotated. */
export function describeCapture(result: CaptureResult): string {
  const mb = (result.bytes / (1024 * 1024)).toFixed(1);
  const parts = [`Captured ${result.seconds}s to ${result.path} (${mb}MB).`];

  parts.push(
    result.portholeLabels > 0
      ? `${result.portholeLabels} distinct Porthole labels are in it, so the app's own ` +
          "navigations, calls and queries are on the timeline."
      : "No Porthole labels found — either no package was named, so the app tag was never " +
          "enabled, or the app was not running with the runtime attached. The trace is still " +
          "valid, it is just not annotated.",
  );

  parts.push("Open it at ui.perfetto.dev; nothing here reads it for you.");
  return [...parts, ...result.notes].join(" ");
}
