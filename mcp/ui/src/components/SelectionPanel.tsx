// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { groupFields, rawText, type Field, type Tone } from "../lib/fields";
import { deviceLabel, type Hit } from "../lib/laneData";
import { shortUrl } from "../lib/spans";
import { num, str, type Finding } from "../types";

interface Props {
  hit: Hit | null;
}

const TONE: Record<Tone, string> = {
  plain: "#cfd8e5",
  good: "var(--accent)",
  warn: "var(--recompose)",
  bad: "var(--danger)",
};

/**
 * The selection pane: only what actually changes when you click a mark. The
 * window-wide counts live in WindowPanel, because they are true of the visible
 * range whether or not anything is selected.
 */
export function SelectionPanel({ hit }: Props) {
  const heading = hit ? headingFor(hit) : null;
  const [showRaw, setShowRaw] = useState(false);

  return (
    <section className="flex max-h-[42vh] min-h-0 min-w-0 flex-col border-b border-[var(--color-line)]">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-3.5 py-2.5">
        <span className="font-mono text-[10px] tracking-[0.12em] text-[var(--color-dim)]">
          SELECTION
        </span>
        <span className="font-mono text-[10px] text-[var(--color-muted)]">
          {hit ? hit.lane.label : "—"}
        </span>
      </div>

      <div className="min-h-0 min-w-0 overflow-y-auto px-3.5 pt-3 pb-4">
        <div className="flex items-center gap-2">
          <span
            className="size-2 flex-none rounded-[2px]"
            style={{ background: heading ? `var(${heading.color})` : "var(--color-faint)" }}
          />
          <span className="min-w-0 text-sm font-semibold text-[#f0f4fa] [overflow-wrap:anywhere]">
            {heading ? heading.title : "Nothing selected"}
          </span>
        </div>
        <div
          className="mt-1 truncate font-mono text-[11px] text-[#9aa6b8]"
          title={heading?.subtitle}
        >
          {heading ? heading.subtitle : "Click a mark on any lane."}
        </div>

        {hit && (
          <>
            <Detail hit={hit} />

            <button
              onClick={() => setShowRaw((value) => !value)}
              className="mt-3 cursor-pointer font-mono text-[10px] tracking-[0.1em] text-[var(--color-dim)] hover:text-[#9aa6b8]"
            >
              {showRaw ? "HIDE RAW" : "SHOW RAW"}
            </button>

            {showRaw && (
              <pre className="mt-2 mb-0 rounded-lg border border-[#242c3a] bg-[var(--color-tile)] p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[#9aa6b8] [overflow-wrap:anywhere]">
                {rawTextFor(hit)}
              </pre>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** `rawText` is built around an event's or span's `data` bag, which a
 *  finding does not have (see `FieldableHit`'s comment in fields.ts) — this
 *  is its finding-shaped equivalent, in the same `key: value` style. */
function rawTextFor(hit: Hit): string {
  if (hit.kind !== "finding") return rawText(hit);
  const { finding } = hit;
  const lines = [
    `id: ${finding.id}`,
    `severity: ${finding.severity}`,
    `confidence: ${finding.confidence}`,
    `source: ${finding.source}`,
    `title: ${finding.title}`,
  ];
  if (finding.detail) lines.push(`detail: ${finding.detail}`);
  if (finding.spanning) lines.push("spanning: true");
  else if (finding.window) lines.push(`window: ${finding.window.from}..${finding.window.to}`);
  if (finding.count !== undefined) lines.push(`count: ${finding.count}`);
  return lines.join("\n");
}

/** The same three CSS variables `InsightsPanel`'s `SEVERITY` table and the
 *  findings lane's canvas both read, so a finding's colour agrees everywhere
 *  it appears (GRA-114). */
const SEVERITY_COLOR: Record<Finding["severity"], string> = {
  error: "--color-danger",
  warning: "--color-recompose",
  note: "--color-muted",
};

function headingFor(hit: Hit): { title: string; subtitle: string; color: string } {
  if (hit.kind === "finding") {
    const { finding } = hit;
    return {
      title: finding.title,
      subtitle: `${finding.severity} · ${finding.confidence} · ${finding.source}`,
      color: SEVERITY_COLOR[finding.severity],
    };
  }

  const { lane } = hit;

  if (hit.kind === "span") {
    const data = hit.span.data;
    const duration = Math.round(hit.span.end - hit.span.start);
    if (lane.key === "http") {
      return {
        title: `${str(data.method)} ${shortUrl(str(data.url))}`,
        subtitle: `${str(data.status) || "in flight"} · ${duration}ms`,
        color: lane.color,
      };
    }
    if (lane.key === "work") {
      const attempt = num(data.attempt);
      return {
        title: str(data.name) || "work",
        subtitle: [
          str(data.state).toLowerCase() || "running",
          `${duration}ms`,
          // WorkInfo counts the first run as 1, so anything above it is a retry.
          attempt > 1 ? `attempt ${attempt}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        color: lane.color,
      };
    }
    const table = str(data.sql).match(/(?:from|into|update|table|join)\s+`?(\w+)/i)?.[1];
    return {
      title: table ? `${str(data.kind)} ${table}` : str(data.kind) || "query",
      subtitle: `${duration}ms · ${str(data.thread)}`,
      color: lane.color,
    };
  }

  const event = hit.event;
  switch (event.event) {
    case "recompose":
      return {
        title: str(event.data.name) || "recomposition",
        subtitle: `${str(event.data.screen) || "—"} · pass ${str(event.data.pass)}`,
        color: lane.color,
      };
    case "state_write":
      return {
        title: "State write",
        subtitle: (event.data.named as string[] | undefined)?.join(", ") || "anonymous",
        color: lane.color,
      };
    case "frame":
      return {
        title: `${num(event.data.totalMs)}ms frame`,
        subtitle: `${num(event.data.missedFrames)} missed · ${str(event.data.worstPhase)}`,
        color: lane.color,
      };
    case "blocked":
      return {
        title: `Main thread stalled ${num(event.data.durationMs)}ms`,
        subtitle: str(event.data.top).split("(")[0] || "—",
        color: lane.color,
      };
    case "db_end":
      return {
        title: "Database on the main thread",
        subtitle: `${num(event.data.elapsedMs)}ms · ${str(event.data.kind)}`,
        color: lane.color,
      };
    case "device":
      return {
        title: deviceTitle(event),
        subtitle: str(event.data.kind),
        color: lane.color,
      };
    case "gc": {
      const blocking = num(event.data.blocking);
      const paused = num(event.data.pausedMs);
      return {
        title:
          num(event.data.count) === 1
            ? "Garbage collection"
            : `${num(event.data.count)} collections`,
        subtitle: blocking
          ? `${blocking} blocking · ${paused}ms paused`
          : `heap ${num(event.data.heapUsedMb)} MB · ran alongside the app`,
        color: blocking ? "--danger" : lane.color,
      };
    }
    case "memory": {
      const ram = num(event.data.totalRamMb);
      return {
        title: ram > 0 ? `${ram} MB total ram` : `${num(event.data.heapUsedMb)} MB heap`,
        subtitle: [
          `heap ${num(event.data.heapUsedMb)}/${num(event.data.heapMaxMb)} MB`,
          `${num(event.data.threads)} threads`,
        ].join(" · "),
        color: lane.color,
      };
    }
    case "nav":
      return { title: str(event.data.route), subtitle: "navigation", color: lane.color };
    case "log":
      return {
        title: str(event.data.tag),
        subtitle: str(event.data.message).split("\n")[0].slice(0, 70),
        color: lane.color,
      };
    default:
      return { title: event.event, subtitle: "—", color: lane.color };
  }
}

/**
 * Three tiers, so the eye has somewhere to start: the subject of the selection,
 * then its attributes packed into a grid, then whatever bulk it carries. Before
 * this, a full URL and a one-word method were laid out identically.
 */
function Detail({ hit }: { hit: Hit }) {
  // Ruling 3: title and severity/confidence/source already sit in the
  // heading above (via `headingFor`); this is `detail` and `window`, the two
  // facts a finding has that nothing above already shows. A finding has no
  // open-ended `data` bag the way an event or span does, so it never goes
  // through `groupFields` — see `FieldableHit`'s own comment in fields.ts.
  if (hit.kind === "finding") return <FindingDetail finding={hit.finding} />;

  const { subject, attributes, payloads } = groupFields(hit);

  return (
    <div className="mt-3 flex flex-col gap-3.5">
      {subject && subject.shape === "block" && (
        <div>
          <Label block>{subject.label}</Label>
          <pre
            className="mt-1 mb-0 max-h-32 overflow-auto rounded-md border border-[#242c3a] border-l-2 bg-[var(--color-tile)] py-2 pr-2 pl-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-[#dbe3ef] [overflow-wrap:anywhere]"
            style={{ borderLeftColor: `var(${hit.lane.color})` }}
          >
            {subject.value}
          </pre>
        </div>
      )}

      {attributes.length > 0 && (
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(102px,1fr))] gap-x-3 gap-y-2.5">
          {attributes.map((field, index) => (
            <Attribute key={`${field.key}-${index}`} field={field} />
          ))}
        </dl>
      )}

      {payloads.map((field, index) => (
        <div key={`${field.key}-${index}`}>
          <Label block>{field.label}</Label>
          <pre
            className="mt-1 mb-0 max-h-44 overflow-auto rounded-md border border-[#242c3a] bg-[var(--color-tile)] p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
            style={{ color: field.shape === "block" ? TONE[field.tone] : undefined }}
          >
            {field.shape === "block" ? field.value : ""}
          </pre>
        </div>
      ))}
    </div>
  );
}

/** A finding's own detail layout: its `detail` sentence, then its window on
 *  the device's uptime clock — a point (`from` == `to`), a span, or, for a
 *  `spanning` finding, a note that it describes the whole window asked
 *  about rather than a moment inside it. */
function FindingDetail({ finding }: { finding: Finding }) {
  return (
    <div className="mt-3 flex flex-col gap-3.5">
      {finding.detail && (
        <p className="text-[12px] leading-snug text-[var(--color-fg)]">
          {finding.detail}
        </p>
      )}
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(102px,1fr))] gap-x-3 gap-y-2.5">
        <div className="min-w-0">
          <Label>window</Label>
          <div className="mt-0.5 font-mono text-[12px]">
            {finding.spanning
              ? "the whole window asked about"
              : finding.window
                ? finding.window.from === finding.window.to
                  ? `${Math.round(finding.window.from)}ms`
                  : `${Math.round(finding.window.from)}–${Math.round(finding.window.to)}ms`
                : "unplaced"}
          </div>
        </div>
      </dl>
    </div>
  );
}

/** A short label-over-value cell. Wide shapes take the full row. */
function Attribute({ field }: { field: Field }) {
  if (field.shape === "inline") {
    return (
      <div className="min-w-0">
        <Label>{field.label}</Label>
        <div
          className="mt-0.5 font-mono text-[12px] [overflow-wrap:anywhere]"
          style={{ color: TONE[field.tone] }}
        >
          {field.value}
        </div>
      </div>
    );
  }

  if (field.shape === "chips") {
    return (
      <div className="col-span-full min-w-0">
        <Label>{field.label}</Label>
        <div className="mt-1 flex flex-wrap gap-1">
          {field.items.map((item, index) => (
            <span
              key={`${item}-${index}`}
              className="rounded bg-[color-mix(in_srgb,var(--write)_12%,transparent)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--write)] [overflow-wrap:anywhere]"
            >
              {item}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (field.shape === "pairs") {
    return (
      <div className="col-span-full min-w-0">
        <Label>{field.label}</Label>
        <div className="mt-1 flex flex-col gap-px overflow-hidden rounded-md border border-[#242c3a] bg-[#242c3a]">
          {field.pairs.map(([name, value]) => (
            <div
              key={name}
              className="flex items-baseline justify-between gap-2 bg-[var(--color-tile)] px-2 py-1"
            >
              <span className="font-mono text-[10.5px] text-[var(--color-dim)]">{name}</span>
              <span className="min-w-0 font-mono text-[11px] text-[#d5dde9] [overflow-wrap:anywhere]">
                {value}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

function Label({ children, block = false }: { children: React.ReactNode; block?: boolean }) {
  return (
    <span
      className={`font-mono text-[9.5px] tracking-[0.1em] text-[var(--color-dim)] uppercase ${
        block ? "" : "truncate"
      }`}
    >
      {typeof children === "string" ? children.replace(/([a-z])([A-Z])/g, "$1 $2") : children}
    </span>
  );
}

/** A device event's headline: the chip text, with the profile spelled out. */
function deviceTitle(event: { data: Record<string, unknown> }): string {
  const data = event.data;
  if (str(data.kind) === "profile") {
    return `${str(data.model)} · Android API ${str(data.sdkInt)}`;
  }
  return deviceLabel(event as never);
}
