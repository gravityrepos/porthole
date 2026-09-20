// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import type { Hit } from "./laneData";
import { num, str } from "../types";

/**
 * Tone is only ever set from something the payload states outright — an HTTP
 * error class, a log level, a frame that missed, work that ran on the main
 * thread. Durations are left plain on purpose: "slow" is a judgement that
 * depends on what the call was doing, and the panel does not get to make it.
 */
export type Tone = "plain" | "good" | "warn" | "bad";

/** A field before it knows which payload key it came from. */
export type FieldBody =
  | { shape: "inline"; label: string; value: string; tone: Tone }
  | { shape: "block"; label: string; value: string; tone: Tone }
  | { shape: "chips"; label: string; items: string[] }
  | { shape: "pairs"; label: string; pairs: Array<[string, string]> };

export type Field = FieldBody & { key: string };

/** Field order per selection kind. Anything unlisted is appended, so a new
 *  runtime field shows up rather than silently vanishing. */
const ORDER: Record<string, string[]> = {
  nav: ["route", "args", "depth"],
  http: [
    "method",
    "url",
    "status",
    "durationMs",
    "phase",
    "reused",
    "protocol",
    "requestBytes",
    "responseBytes",
    "phases",
    "requestBody",
    "responseBody",
    "error",
  ],
  db: ["sql", "kind", "args", "durationMs", "thread", "onMainThread", "result", "error"],
  db_end: ["sql", "kind", "elapsedMs", "thread", "onMainThread", "result"],
  work: ["name", "state", "attempt", "durationMs", "retrying", "tags", "workId"],
  gc: ["count", "blocking", "pausedMs", "freedMb", "heapUsedMb", "heapMaxMb"],
  device: [
    "kind",
    "model",
    "sdkInt",
    "abi",
    "cores",
    "deviceRamMb",
    "lowRamDevice",
    "screenDp",
    "density",
    "refreshHz",
    "storageFreeMb",
    "storageTotalMb",
    "locale",
    "fontScale",
    "darkMode",
    "rotation",
    "orientation",
    "transport",
    "metered",
    "validated",
    "batteryPercent",
    "dozing",
    "powerSaver",
    "level",
    "activity",
    "change",
  ],
  memory: [
    "totalRamMb",
    "heapUsedMb",
    "heapMaxMb",
    "heapPercent",
    "javaRamMb",
    "nativeRamMb",
    "graphicsRamMb",
    "nativeMb",
    "threads",
    "allocKbPerSec",
    "allocTotalMb",
    "blockingGc",
    "blockingGcMs",
    "gcSinceLast",
    "gcTotal",
  ],
  recompose: ["name", "screen", "pass", "triggeredBy"],
  state_write: ["named", "yours", "unnamed", "keys"],
  frame: ["totalMs", "missedFrames", "worstPhase", "firstDraw"],
  blocked: ["durationMs", "top", "stack"],
  log: ["level", "tag", "message", "wallTime", "tid"],
};

/** Noise: identifiers and internals that earn their place in raw, not here. */
const HIDDEN = new Set(["id", "open", "seq"]);

/**
 * The one field that is the subject of the selection rather than a property of
 * it. Pulling it out of the list gives the panel a hierarchy: what this is,
 * then its attributes, then whatever bulk it carries.
 */
const SUBJECT: Record<string, string> = { http: "url", db: "sql", db_end: "sql" };

export interface GroupedFields {
  subject: Field | null;
  attributes: Field[];
  payloads: Field[];
}

/** A finding hit has its own fixed layout (SelectionPanel's `FindingDetail`)
 *  rather than going through the generic field pipeline below, which is
 *  built around a device event's or span's open-ended `data` bag — a finding
 *  has none. Excluded from the parameter type here so that stays true by
 *  construction, not by convention. */
export type FieldableHit = Exclude<Hit, { kind: "finding" }>;

/** Splits fields into the three tiers the panel lays out. */
export function groupFields(hit: FieldableHit): GroupedFields {
  const kind = hit.kind === "span" ? hit.lane.key : hit.event.event;
  const subjectKey = SUBJECT[kind];
  const group: GroupedFields = { subject: null, attributes: [], payloads: [] };

  for (const field of fieldsFor(hit)) {
    if (subjectKey && field.key === subjectKey) group.subject = field;
    else if (field.shape === "block") group.payloads.push(field);
    else group.attributes.push(field);
  }
  return group;
}

export function fieldsFor(hit: FieldableHit): Field[] {
  const data: Record<string, unknown> =
    hit.kind === "span"
      ? { durationMs: Math.round(hit.span.end - hit.span.start), ...hit.span.data }
      : hit.event.data;

  const kind = hit.kind === "span" ? hit.lane.key : hit.event.event;
  const order = ORDER[kind] ?? [];

  // Two pairs say the same thing twice. A span's durationMs is computed from
  // its own start and end, which is the measurement elapsedMs reports; and a
  // stall's top is literally the first line of its stack.
  const skip = new Set(HIDDEN);
  if ("durationMs" in data) skip.add("elapsedMs");
  if ("stack" in data) skip.add("top");

  const keys = [
    ...order.filter((key) => key in data && !skip.has(key)),
    ...Object.keys(data).filter(unordered),
  ];

  function unordered(key: string): boolean {
    return !order.includes(key) && !skip.has(key);
  }

  return keys
    .map((key) => {
      const field = fieldFor(key, data[key]);
      return field && { ...field, key };
    })
    .filter((field): field is Field => Boolean(field));
}

function fieldFor(key: string, value: unknown): FieldBody | null {
  if (value === undefined || value === null || value === "") return null;

  switch (key) {
    case "args":
      return argsField(str(value));

    case "url":
    case "top":
      return { shape: "block", label: key, value: str(value), tone: "plain" };

    case "sql":
      return {
        shape: "block",
        label: "sql",
        value: str(value).replace(/`/g, ""),
        tone: "plain",
      };

    case "stack":
    case "message":
      return { shape: "block", label: key, value: str(value), tone: "plain" };

    case "requestBody":
    case "responseBody":
      return {
        shape: "block",
        label: key === "requestBody" ? "request" : "response",
        value: prettyJson(str(value)),
        tone: "plain",
      };

    case "error":
      return { shape: "block", label: "error", value: str(value), tone: "bad" };

    case "status": {
      const code = num(value);
      if (code === 0) return inline("status", "in flight", "warn");
      return inline("status", String(code), code >= 400 ? "bad" : code >= 300 ? "warn" : "good");
    }

    // GRA-66: OkHttp's own EventListener phase breakdown, one row per phase
    // actually observed (dns, connect, secureConnect, requestHeaders,
    // requestBody, responseHeaders, responseBody) — the same "pairs" shape
    // `args` already renders a small key/value table as. Absent entirely
    // for a call OkHttpPorthole never instrumented (a Ktor call with no
    // OkHttp engine underneath), which `fieldFor`'s own empty-value check
    // above already handles for free.
    case "phases": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      const pairs = Object.entries(value as Record<string, unknown>).map(
        ([name, ms]): [string, string] => [name, `${num(ms)}ms`],
      );
      return pairs.length ? { shape: "pairs", label: "phases", pairs } : null;
    }

    // Worth a row either way, unlike `dozing`/`powerSaver` above: whether a
    // call reused a pooled connection is exactly what "no dns/connect phase
    // of its own" (GRA-66's own acceptance criterion) needs a plain-English
    // answer for, not only silence-means-no.
    case "reused":
      return value === true || value === "true"
        ? inline("connection", "reused", "good")
        : inline("connection", "new");

    case "protocol":
      return inline("protocol", str(value));

    case "requestBytes":
    case "responseBytes":
      return inline(key === "requestBytes" ? "request size" : "response size", formatBytes(num(value)));

    case "level": {
      const level = str(value);
      const name = { V: "verbose", D: "debug", I: "info", W: "warn", E: "error", F: "fatal" };
      return inline(
        "level",
        name[level as keyof typeof name] ?? level,
        level === "W" ? "warn" : level === "E" || level === "F" ? "bad" : "plain",
      );
    }

    case "heapUsedMb":
    case "heapMaxMb":
    case "nativeMb":
    case "totalRamMb":
    case "javaRamMb":
    case "nativeRamMb":
    case "graphicsRamMb":
    case "allocTotalMb":
      return inline(
        {
          heapUsedMb: "heap used",
          heapMaxMb: "heap max",
          nativeMb: "native heap",
          totalRamMb: "total ram",
          javaRamMb: "java ram",
          nativeRamMb: "native ram",
          graphicsRamMb: "graphics",
          allocTotalMb: "allocated",
        }[key] ?? key,
        `${num(value)} MB`,
      );

    case "allocKbPerSec": {
      const kb = num(value);
      return inline("alloc rate", kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB/s` : `${kb} KB/s`);
    }

    case "deviceRamMb":
    case "storageFreeMb":
    case "storageTotalMb":
      return inline(
        { deviceRamMb: "device ram", storageFreeMb: "storage free", storageTotalMb: "storage" }[
          key
        ] ?? key,
        `${num(value)} MB`,
      );

    case "batteryPercent": {
      const percent = num(value, -1);
      if (percent < 0) return null;
      return inline("battery", `${percent}%`, percent <= 15 ? "warn" : "plain");
    }

    // Only worth a row when true. "powerSaver: false" is noise.
    case "dozing":
    case "powerSaver":
    case "lowRamDevice":
    case "metered":
      return value === "true" || value === true
        ? inline(
            {
              dozing: "dozing",
              powerSaver: "power saver",
              lowRamDevice: "low ram device",
              metered: "metered",
            }[key] ?? key,
            "yes",
            "warn",
          )
        : null;

    case "refreshHz":
      return inline("refresh", `${num(value)} Hz`);

    case "threads":
      return num(value) > 0 ? inline("threads", String(num(value))) : null;

    case "freedMb":
      return inline("freed", `${num(value)} MB`);

    case "pausedMs":
      return inline("paused", `${num(value)}ms`, num(value) >= 16 ? "bad" : "warn");

    case "blocking":
      return inline("blocking", String(num(value)), "bad");

    case "count":
      return inline("collections", String(num(value)));

    case "blockingGc":
      return inline("blocking GC", String(num(value)), "warn");

    case "blockingGcMs":
      return inline("GC pause", `${num(value)}ms`, num(value) >= 16 ? "bad" : "warn");

    case "heapPercent": {
      const percent = num(value);
      return inline(
        "of max",
        `${percent}%`,
        percent >= 90 ? "bad" : percent >= 75 ? "warn" : "plain",
      );
    }

    case "gcSinceLast":
      return num(value) > 0 ? inline("collections", String(num(value)), "warn") : null;

    case "durationMs":
    case "elapsedMs":
    case "totalMs":
      return inline(key === "totalMs" ? "frame time" : "duration", `${num(value)}ms`);

    case "missedFrames": {
      const missed = num(value);
      return inline(
        "missed",
        `${missed} frame${missed === 1 ? "" : "s"}`,
        missed > 0 ? "bad" : "plain",
      );
    }

    case "onMainThread":
      return value === true ? inline("thread", "main thread", "bad") : null;

    case "thread":
      return inline("thread", str(value), str(value) === "main" ? "bad" : "plain");

    case "firstDraw":
      return inline("first draw", value === true ? "yes" : "no");

    case "keys":
    case "named":
    case "yours":
    case "triggeredBy": {
      const items = asStrings(value);
      return items.length ? { shape: "chips", label: key, items } : null;
    }

    default: {
      if (Array.isArray(value)) {
        const items = asStrings(value);
        return items.length ? { shape: "chips", label: key, items } : null;
      }
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (text.includes("\n")) {
        return { shape: "block", label: key, value: text, tone: "plain" };
      }
      return inline(key, text);
    }
  }
}

function inline(label: string, value: string, tone: Tone = "plain"): FieldBody {
  return { shape: "inline", label, value, tone };
}

/** GRA-66: `requestBytes`/`responseBytes` are always a real byte count off `EventListener.requestBodyEnd`/`responseBodyEnd`, never a preview — this only picks the unit, the same way the RAM fields above already do at a coarser (MB-only) grain. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

/**
 * Two shapes arrive under this name. Navigation sends a Bundle, which Android
 * prints as {cartId=88123}; a query sends its bind arguments, which are
 * positional. Pairs for the first, an ordered list for the second.
 */
function argsField(text: string): FieldBody | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "{}" || trimmed === "[]") return null;

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const pairs = trimmed
      .slice(1, -1)
      .split(", ")
      .map((entry) => entry.split("="))
      .filter((parts) => parts.length >= 2)
      .map(([name, ...rest]): [string, string] => [name, rest.join("=")]);
    if (pairs.length) return { shape: "pairs", label: "args", pairs };
  }

  const items = trimmed
    .split(", ")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? { shape: "chips", label: "args", items } : null;
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** The escape hatch: everything the device sent, as sent. */
export function rawText(hit: FieldableHit): string {
  const data =
    hit.kind === "span"
      ? {
          durationMs: Math.round(hit.span.end - hit.span.start),
          open: hit.span.open,
          ...hit.span.data,
        }
      : hit.event.data;

  return Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return text.includes("\n")
        ? `${key}:\n${text
            .split("\n")
            .map((line) => "  " + line)
            .join("\n")}`
        : `${key}: ${text}`;
    })
    .join("\n");
}
