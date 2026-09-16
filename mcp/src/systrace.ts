// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { open } from "node:fs/promises";

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
 * How many bytes `countPortholeLabels` reads at once.
 *
 * Large enough that a hundred-megabyte capture is a hundred `read()` calls,
 * not a hundred thousand; small enough that peak memory while scanning stays
 * a handful of megabytes rather than growing with the file. This is the
 * whole fix for GRA-89's heap-exhaustion half: the code this replaced read
 * the entire capture into a `Buffer` and then decoded the entire buffer into
 * a second, same-sized string before scanning either — two copies of
 * whatever the file's size happened to be, all at once.
 */
export const CHUNK_BYTES = 1024 * 1024;

/**
 * How much of one chunk's tail is re-scanned as part of the next.
 *
 * The marker is `porthole: ` (10 characters) plus the capture group's own
 * bound of up to 110 more, 120 characters at the outside. 128 bytes of
 * overlap — one byte per latin1 character — covers that with eight to
 * spare, so a marker whose bytes straddle a chunk boundary is always whole
 * in at least one of the two scans that see it: incomplete (and so
 * unmatched) in the chunk it starts in, complete once its own tail is
 * carried into the front of the next chunk's text.
 */
export const OVERLAP_BYTES = 128;

const PORTHOLE_MARKER = /porthole: ([^|\x00-\x1f]{1,110})/g;

/**
 * Whether the app's own sections made it into the capture — read a chunk at
 * a time rather than all at once.
 *
 * `index.ts` used to `readFileSync` the whole trace and hand this function
 * the resulting `Buffer`, which this then decoded whole with
 * `.toString("latin1")` before scanning it. At the tool's own 120s maximum a
 * real capture is hundreds of megabytes; doubling that into a same-sized JS
 * string is exactly the shape that exhausts Node's heap before the tool can
 * report anything. This reads and decodes `CHUNK_BYTES` at a time instead,
 * so peak memory is a small, fixed multiple of one chunk no matter how large
 * the capture is — see `systrace.test.ts`'s RSS-bound case, which measures
 * this rather than asserting it by argument.
 *
 * A byte search for the prefix, not a parse, exactly as before: slice names
 * are interned as plain strings in the protobuf, so finding one is good
 * evidence it is there and not finding it is good evidence it is not.
 *
 * Counting matches would overstate it — a name is referenced many times, not
 * interned once — so this keeps the same `Set` of distinct names the
 * non-streaming version used, which is also what makes the chunk overlap
 * cheap to get slightly too generous rather than exactly right: a name
 * re-matched out of the carried tail, because it happened to sit wholly
 * inside the last `OVERLAP_BYTES` of the previous chunk rather than
 * straddling the boundary, is a duplicate insert into a `Set`, not a double
 * count. Only a marker that is never matched in full, in either chunk, would
 * be missed — which is exactly what the overlap exists to prevent.
 */
export async function countPortholeLabels(filePath: string): Promise<number> {
  const names = new Set<string>();
  const handle = await open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let position = 0;
    let carry = "";
    while (position < size) {
      const toRead = Math.min(CHUNK_BYTES, size - position);
      const { bytesRead } = await handle.read(buffer, 0, toRead, position);
      if (bytesRead === 0) break; // defensive: a file truncated out from under this scan, not a loop forever re-reading zero bytes
      const text = carry + buffer.toString("latin1", 0, bytesRead);
      for (const match of text.matchAll(PORTHOLE_MARKER)) names.add(match[1].trimEnd());
      carry = text.slice(-OVERLAP_BYTES);
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return names.size;
}

export interface CaptureResult {
  path: string;
  bytes: number;
  seconds: number;
  categories: string[];
  /**
   * The packages `--app` was actually run with. GRA-186: `describeCapture`
   * needs this to tell "no package was named" (the app tag was never
   * enabled — nothing to investigate) apart from "a package was named and
   * the trace still came back unannotated" (the two are different problems
   * with different remedies, and conflating them is what GRA-186 was filed
   * against).
   */
  apps: string[];
  portholeLabels: number;
  /**
   * Whether the tool force-stopped and relaunched the target app for this
   * capture (`restartApp: true` in `index.ts`'s `capture_system_trace`).
   * `describeCapture` uses it only to warn that the trace contains a cold
   * start — it says nothing about whether the restart made labels appear.
   */
  restarted: boolean;
  notes: string[];
}

/** One sentence: whether it worked, how big, and whether it is annotated. */
export function describeCapture(result: CaptureResult): string {
  const mb = (result.bytes / (1024 * 1024)).toFixed(1);
  const parts = [`Captured ${result.seconds}s to ${result.path} (${mb}MB).`];

  parts.push(
    result.portholeLabels > 0
      ? `${result.portholeLabels} Porthole track(s) in it, so the app's own navigations, ` +
          "calls and queries are on the timeline."
      : result.apps.length === 0
        ? "No Porthole labels found — either no package was named, so the app tag was never " +
          "enabled, or the app was not running with the runtime attached. The trace is still " +
          "valid, it is just not annotated."
        : // GRA-186: on the Pixel 9 Pro Fold (Android 17) a process already
          // running when the session starts never picks up the newly-enabled
          // app tag — it is consulted once, at process attach, not re-read
          // live. Naming that here, rather than the old generic "package or
          // runtime is wrong" wording, is what turns a false "something is
          // misconfigured" reading into the actual, actionable remedy.
          `No Porthole labels found even though ${result.apps.join(", ")} was targeted — this ` +
          "device/build only reads the app trace tag when its process starts, so a process " +
          "already running before the capture began is never marked (seen on a Pixel 9 Pro " +
          "Fold, Android 17). Pass `restartApp: true`, or launch the app after the capture " +
          "starts, to catch it.",
  );

  if (result.restarted) {
    parts.push("The app was restarted for this capture, so it contains a cold start.");
  }

  parts.push("Open it at ui.perfetto.dev; nothing here reads it for you.");
  return [...parts, ...result.notes].join(" ");
}
