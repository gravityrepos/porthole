// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { logPrompt } from "../lib/agentPrompt";
import { usePersistent } from "../lib/persist";
import type { TimelineStore } from "../store/TimelineStore";
import type { DeviceEvent } from "../types";
import { str } from "../types";

const LEVEL_RANK: Record<string, number> = { V: 1, D: 2, I: 3, W: 4, E: 5, F: 6 };
/** Rows past this are trimmed from the front: the DOM is the bottleneck, not the data. */
const ROW_CAP = 600;

const DEFAULT_HEIGHT = 240;
const MIN_HEIGHT = 88;
/** The timeline is the point of the window, so it always keeps this much. */
const TIMELINE_FLOOR = 260;
/** Arrow-key step, so the divider is usable without a pointer. */
const NUDGE = 24;

const FILTERS = [
  { value: "V", label: "verbose" },
  { value: "I", label: "info+" },
  { value: "W", label: "warn+" },
  { value: "E", label: "error" },
];

interface Tone {
  level: string;
  message: string;
  edge: string;
}

function toneFor(level: string): Tone {
  if (level === "E" || level === "F") {
    return { level: "var(--danger)", message: "#ff8a82", edge: "var(--danger)" };
  }
  if (level === "W") return { level: "var(--db)", message: "var(--db)", edge: "var(--db)" };
  return { level: "#8ba2c0", message: "#9aa6b8", edge: "transparent" };
}

interface Props {
  store: TimelineStore;
  version: number;
  onSeek: (t: number) => void;
}

export function LogPane({ store, version, onSeek }: Props) {
  const [minLevel, setMinLevel] = usePersistent("logLevel", "I");
  const [filter, setFilter] = useState("");
  const [tailing, setTailing] = usePersistent("tailing", true);
  const [collapsed, setCollapsed] = usePersistent("logCollapsed", false);
  const [height, setHeight] = usePersistent("logHeight", DEFAULT_HEIGHT);
  /** Seqs of rows opened out. Several can be open at once, to compare two traces. */
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ y: number; height: number } | null>(null);

  const clamp = useCallback(
    (value: number) =>
      Math.max(
        MIN_HEIGHT,
        Math.min(value, Math.max(MIN_HEIGHT, window.innerHeight - TIMELINE_FLOOR)),
      ),
    [],
  );

  // The window can shrink under a height that was fine when it was set, and a
  // stored height arrives having never been checked against this window at all.
  useEffect(() => {
    const onResize = () => setHeight((current) => clamp(current));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp, setHeight]);

  const { rows, total } = useMemo(() => {
    const min = LEVEL_RANK[minLevel] ?? 1;
    const query = filter.trim().toLowerCase();
    let count = 0;
    const matched: DeviceEvent[] = [];

    for (const event of store.events) {
      if (event.event !== "log") continue;
      count += 1;
      if ((LEVEL_RANK[str(event.data.level)] ?? 0) < min) continue;
      if (
        query &&
        !(str(event.data.tag) + " " + str(event.data.message)).toLowerCase().includes(query)
      ) {
        continue;
      }
      matched.push(event);
    }

    return { rows: matched.slice(-ROW_CAP), total: count };
    // version is the dependency that matters: the array is mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version, minLevel, filter]);

  useEffect(() => {
    if (!tailing || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [rows, tailing]);

  return (
    <section
      className="relative grid min-w-0 border-t border-[var(--color-line)] bg-[#0f141d]"
      style={{ gridTemplateRows: collapsed ? "auto" : `auto ${height}px` }}
    >
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the log pane"
          aria-valuenow={Math.round(height)}
          tabIndex={0}
          className="absolute inset-x-0 -top-[3px] z-10 h-[7px] cursor-row-resize hover:bg-[color-mix(in_srgb,var(--accent)_45%,transparent)] focus-visible:bg-[var(--accent)]"
          onPointerDown={(event) => {
            dragRef.current = { y: event.clientY, height };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag) return;
            // Dragging up makes the pane taller, which is why the delta inverts.
            setHeight(clamp(drag.height + (drag.y - event.clientY)));
          }}
          onPointerUp={(event) => {
            dragRef.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onDoubleClick={() => setHeight(clamp(DEFAULT_HEIGHT))}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") setHeight((current) => clamp(current + NUDGE));
            else if (event.key === "ArrowDown") setHeight((current) => clamp(current - NUDGE));
            else return;
            event.preventDefault();
          }}
        />
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-[var(--color-line)] bg-[var(--color-bar)] px-3 py-1.5">
        <span className="font-mono text-[10px] tracking-[0.12em] text-[var(--color-dim)]">
          LOGCAT
        </span>

        <div className="flex gap-0.5 rounded-md border border-[#262e3c] bg-[#11161f] p-0.5">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              onClick={() => setMinLevel(option.value)}
              className={`cursor-pointer rounded px-2 py-0.5 font-mono text-[10.5px] ${
                minLevel === option.value
                  ? "bg-[#232c3b] text-[#dbe3ef]"
                  : "text-[var(--color-dim)] hover:text-[#dbe3ef]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="flex max-w-[240px] min-w-[100px] flex-1 basis-[120px] items-center gap-1.5 rounded-md border border-[#262e3c] bg-[#11161f] px-2.5 py-[3px]">
          <span className="text-[11px] text-[#4d5768]">⌕</span>
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="filter tag or message"
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-muted)]"
          />
        </label>

        <span className="font-mono text-[10.5px] text-[var(--color-muted)]">
          {total === 0 ? "no output" : `${rows.length} of ${total}`}
        </span>

        <div className="flex-1" />

        <Pill active={tailing} onClick={() => setTailing((value) => !value)}>
          {tailing ? "tailing" : "tail"}
        </Pill>
        <Pill active={false} onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? "show" : "hide"}
        </Pill>
      </div>

      {!collapsed && (
        <div
          ref={listRef}
          className="min-h-0 overflow-y-auto py-1"
          onScroll={(event) => {
            const el = event.currentTarget;
            // Scrolling up is a statement of intent: stop yanking the view down.
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            if (!atBottom && tailing) setTailing(false);
          }}
        >
          {rows.map((event) => (
            <LogRow
              key={event.seq}
              event={event}
              open={expanded.has(event.seq)}
              onToggle={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (!next.delete(event.seq)) next.add(event.seq);
                  return next;
                })
              }
              onSeek={() => onSeek(event.t)}
              events={store.events}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface RowProps {
  event: DeviceEvent;
  open: boolean;
  onToggle: () => void;
  onSeek: () => void;
  events: DeviceEvent[];
}

/**
 * One line, and what you can do with it.
 *
 * A stack trace used to be reachable only as a native tooltip, which cannot be
 * selected, cannot be copied, and gets cut off by the platform anyway — so the
 * one thing you want from a crash, its text, was the one thing out of reach.
 */
function LogRow({ event, open, onToggle, onSeek, events }: RowProps) {
  const level = str(event.data.level);
  const tone = toneFor(level);
  const wall = str(event.data.wallTime);
  const message = str(event.data.message);
  const [copied, setCopied] = useState("");

  const copy = (text: string, label: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(label);
        setTimeout(() => setCopied(""), 1200);
      })
      .catch(() => {
        // Refused clipboard access; the text is on screen and selectable.
      });
  };

  return (
    <div className="border-l-2" style={{ borderLeftColor: tone.edge }}>
      <div
        onClick={onToggle}
        title={open ? "click to close" : "click to open this line"}
        className="grid cursor-pointer grid-cols-[10px_92px_14px_minmax(0,0.5fr)_minmax(0,2fr)] gap-2.5 py-[3px] pr-3.5 pl-2 font-mono text-[11.5px] leading-normal hover:bg-white/[0.025]"
      >
        <span className={`text-[var(--color-dim)] transition-transform ${open ? "rotate-90" : ""}`}>
          ›
        </span>
        <span className="text-[var(--color-muted)]">
          {wall ? wall.slice(6, 18) : (event.t / 1000).toFixed(2) + "s"}
        </span>
        <span className="font-semibold" style={{ color: tone.level }}>
          {level}
        </span>
        <span className="truncate text-[#7fb2ff]">{str(event.data.tag)}</span>
        <span className={open ? "" : "truncate"} style={{ color: tone.message }}>
          {open ? message.split("\n")[0] : message}
        </span>
      </div>

      {open && (
        <div className="px-3.5 pt-1 pb-2.5 pl-[26px]">
          <pre
            className="m-0 max-h-64 overflow-auto rounded-md border border-[#242c3a] bg-[var(--color-tile)] p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap select-text [overflow-wrap:anywhere]"
            style={{ color: tone.message }}
          >
            {message}
          </pre>

          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <RowButton onClick={() => copy(message, "trace")}>
              {copied === "trace" ? "copied" : "copy"}
            </RowButton>
            <RowButton onClick={() => copy(logPrompt(event, events), "prompt")}>
              {copied === "prompt" ? "copied" : "ask agent"}
            </RowButton>
            <RowButton onClick={onSeek}>center timeline</RowButton>
          </div>
        </div>
      )}
    </div>
  );
}

function RowButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={(event) => {
        // The row toggles on click; a button inside it must not also close it.
        event.stopPropagation();
        onClick();
      }}
      className="cursor-pointer rounded border border-[var(--color-edge)] bg-[var(--color-control)] px-2 py-[3px] font-mono text-[10.5px] text-[var(--color-muted)] hover:text-[#dbe3ef]"
    >
      {children}
    </button>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`cursor-pointer rounded-[5px] border px-2.5 py-[3px] font-mono text-[10.5px] ${
        active
          ? "border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-[var(--accent)]"
          : "border-[var(--color-edge)] bg-[var(--color-control)] text-[var(--color-muted)] hover:text-[#dbe3ef]"
      }`}
    >
      {children}
    </button>
  );
}
