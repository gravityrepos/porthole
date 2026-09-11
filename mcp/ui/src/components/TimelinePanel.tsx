// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LANES, TICK_COUNT, type Lane } from "../timeline/lanes";
import { bounds, panBy, toTime, zoomAt } from "../timeline/geometry";
import { drawLane, readCss, type LaneScene } from "../timeline/draw";
import { hitLane, laneStat, navChips, spansForLane, type Hit } from "../lib/laneData";
import { missingIntegration, type SetupEntry } from "../lib/setup";
import type { TimelineStore } from "../store/TimelineStore";
import type { Span, ViewWindow } from "../types";

/** The gutter column, shared by the ruler and every lane so they stay aligned. */
const GUTTER = "clamp(150px, 18%, 178px)";

interface Props {
  store: TimelineStore;
  version: number;
  view: ViewWindow;
  onViewChange: (view: ViewWindow) => void;
  onFollowingChange: (following: boolean) => void;
  showFramework: boolean;
  setup: SetupEntry[];
  onSelect: (hit: Hit) => void;
  selectedSeq: number | null;
}

export function TimelinePanel({
  store,
  version,
  view,
  onViewChange,
  onFollowingChange,
  showFramework,
  setup,
  onSelect,
  selectedSeq,
}: Props) {
  const dragRef = useRef<{ active: boolean; x: number; moved: boolean }>({
    active: false,
    x: 0,
    moved: false,
  });
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  const spansByLane = useMemo(() => {
    const map = new Map<string, Span[]>();
    for (const lane of LANES) map.set(lane.key, spansForLane(lane, store.events));
    return map;
    // The array is mutated in place, so version is the dependency that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version]);

  const origin = useMemo(() => bounds(store.events).min, [store, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const ticks = useMemo(() => {
    const step = (view.end - view.start) / TICK_COUNT;
    return Array.from({ length: TICK_COUNT }, (_, i) => ({
      left: (i / TICK_COUNT) * 100,
      label: ((view.start + step * i - origin) / 1000).toFixed(1) + "s",
    }));
  }, [view, origin]);

  const onWheel = useCallback(
    (event: React.WheelEvent, width: number, x: number) => {
      onViewChange(zoomAt(view, toTime(x, view, width), event.deltaY > 0 ? 1.25 : 0.8));
    },
    [onViewChange, view],
  );

  const onDragMove = useCallback(
    (x: number, width: number) => {
      const deltaMs = ((dragRef.current.x - x) / Math.max(width, 1)) * (view.end - view.start);
      dragRef.current.x = x;
      dragRef.current.moved = true;
      onViewChange(panBy(view, deltaMs));
    },
    [onViewChange, view],
  );

  return (
    <section className="grid min-h-0 min-w-0 grid-rows-[30px_minmax(0,1fr)] bg-[var(--color-plot)]">
      <div
        className="grid min-w-0 border-b border-[var(--color-line)] bg-[var(--color-bar)]"
        style={{ gridTemplateColumns: `${GUTTER} minmax(0, 1fr)` }}
      >
        <div className="flex items-center gap-2 border-r border-[var(--color-line)] px-3">
          <span className="font-mono text-[10px] tracking-[0.12em] text-[var(--color-dim)]">
            TIMELINE
          </span>
          <span className="font-mono text-[10px] text-[var(--color-faint)]">
            {((view.end - view.start) / 1000).toFixed(1)}s
          </span>
        </div>
        <div className="relative">
          {ticks.map((tick) => (
            <div
              key={tick.left}
              className="absolute top-0 bottom-0 flex items-center border-l border-[#222a38] pl-1.5"
              style={{ left: `${tick.left}%` }}
            >
              <span className="font-mono text-[10px] text-[var(--color-muted)]">{tick.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto">
        {LANES.map((lane) => (
          <LaneRow
            key={lane.key}
            lane={lane}
            store={store}
            version={version}
            view={view}
            spans={spansByLane.get(lane.key) ?? []}
            showFramework={showFramework}
            missing={missingIntegration(lane.key, setup)}
            selectedSeq={selectedSeq}
            onSelect={onSelect}
            onTooltip={setTooltip}
            onWheel={onWheel}
            onDragStart={(x) => {
              dragRef.current = { active: true, x, moved: false };
              // Panning is a statement of intent: stop yanking the view back.
              onFollowingChange(false);
            }}
            onDragMove={onDragMove}
            onDragEnd={() => (dragRef.current.active = false)}
            dragRef={dragRef}
          />
        ))}
      </div>

      {tooltip && (
        <div
          className="pointer-events-none fixed z-50 max-w-[420px] rounded-md border border-[var(--color-edge)] bg-[#1b2230] px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-[var(--color-text)] shadow-xl"
          style={{ left: tooltip.x + 14, top: tooltip.y + 14 }}
        >
          {tooltip.text}
        </div>
      )}
    </section>
  );
}

interface RowProps {
  lane: Lane;
  store: TimelineStore;
  version: number;
  view: ViewWindow;
  spans: Span[];
  showFramework: boolean;
  missing: string | null;
  selectedSeq: number | null;
  onSelect: (hit: Hit) => void;
  onTooltip: (tip: { x: number; y: number; text: string } | null) => void;
  onWheel: (event: React.WheelEvent, width: number, x: number) => void;
  onDragStart: (x: number) => void;
  onDragMove: (x: number, width: number) => void;
  onDragEnd: () => void;
  dragRef: React.RefObject<{ active: boolean; x: number; moved: boolean }>;
}

function LaneRow({
  lane,
  store,
  version,
  view,
  spans,
  showFramework,
  missing,
  selectedSeq,
  onSelect,
  onTooltip,
  onWheel,
  onDragStart,
  onDragMove,
  onDragEnd,
  dragRef,
}: RowProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  /** Mirrors sizeRef for the DOM chips, which need a width to thin labels by. */
  const [plotWidth, setPlotWidth] = useState(0);

  const latest = useRef({ view, showFramework, spans });
  latest.current = { view, showFramework, spans };

  const render = useCallback(() => {
    const ctx = canvasRef.current?.getContext("2d");
    const { width, height } = sizeRef.current;
    if (!ctx || width === 0 || height === 0) return;

    const scene: LaneScene = {
      ctx,
      width,
      height,
      view: latest.current.view,
      events: store.events,
      spans: latest.current.spans,
      color: readCss(lane.color),
      showFramework: latest.current.showFramework,
    };
    drawLane(lane, scene);
  }, [lane, store]);

  useLayoutEffect(() => {
    const plot = plotRef.current;
    const canvas = canvasRef.current;
    if (!plot || !canvas) return;

    const resize = () => {
      const rect = plot.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { width: rect.width, height: rect.height };
      setPlotWidth(rect.width);
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
      render();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(plot);
    resize();
    return () => observer.disconnect();
  }, [render]);

  // A dirty flag and one long-lived loop, rather than a frame scheduled per
  // change. Scheduling per change meant the cleanup cancelled the pending frame
  // every time new data landed, and during a burst new data lands every frame —
  // so the draw could be starved by exactly the traffic it exists to show.
  const dirty = useRef(true);
  dirty.current = true;

  useEffect(() => {
    let handle = 0;
    const loop = () => {
      if (dirty.current) {
        dirty.current = false;
        render();
      }
      handle = requestAnimationFrame(loop);
    };
    handle = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(handle);
  }, [render]);

  const stat = useMemo(
    () => laneStat(lane, store.events, view, showFramework),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lane, store, version, view, showFramework],
  );

  const markers = useMemo(
    () =>
      lane.kind === "markers"
        ? navChips(store.events, view, plotWidth, lane.key)
        : { rules: [], chips: [] },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lane, store, version, view, plotWidth],
  );

  const point = (event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, width: rect.width };
  };

  return (
    <div
      className="grid min-w-0 border-b border-[var(--color-line-soft)] hover:bg-white/[0.014]"
      style={{ gridTemplateColumns: `${GUTTER} minmax(0, 1fr)`, height: lane.height }}
    >
      <div className="flex min-w-0 flex-col gap-1 overflow-hidden border-r border-[var(--color-line)] px-2.5 py-[9px]">
        <div className="flex min-w-0 items-center gap-[7px]">
          <span
            className="h-3 w-[3px] flex-none rounded-sm"
            style={{ background: `var(${lane.color})` }}
          />
          <span className="min-w-0 truncate font-mono text-[11.5px] text-[#cdd6e3]">
            {lane.label}
          </span>
        </div>
        <span
          className="truncate pl-2.5 font-mono text-[10px]"
          style={{ color: missing ? "var(--recompose)" : "var(--color-dim)" }}
          title={missing ?? undefined}
        >
          {missing ?? stat}
        </span>
      </div>

      <div
        ref={plotRef}
        className="relative min-w-0 cursor-crosshair overflow-hidden"
        onWheel={(event) => {
          const { x, width } = point(event);
          onWheel(event, width, x);
        }}
        onMouseDown={(event) => onDragStart(point(event).x)}
        onMouseUp={onDragEnd}
        onMouseMove={(event) => {
          const { x, width } = point(event);
          if (dragRef.current.active) {
            onDragMove(x, width);
            return;
          }
          const hit = hitLane(lane, store.events, spans, view, width, x, showFramework);
          onTooltip(hit ? { x: event.clientX, y: event.clientY, text: tipFor(hit) } : null);
        }}
        onMouseLeave={() => {
          onDragEnd();
          onTooltip(null);
        }}
        onClick={(event) => {
          if (dragRef.current.moved) return;
          const { x, width } = point(event);
          const hit = hitLane(lane, store.events, spans, view, width, x, showFramework);
          if (hit) onSelect(hit);
        }}
      >
        <canvas ref={canvasRef} className="block h-full w-full" />

        {markers.rules.map((rule) => (
          <span
            key={rule.seq}
            className="pointer-events-none absolute top-2 bottom-1.5"
            style={{
              left: `${rule.left}%`,
              width: selectedSeq === rule.seq ? 3 : 2,
              background: `var(${lane.color})`,
              opacity: selectedSeq === rule.seq ? 1 : 0.55,
            }}
          />
        ))}

        {markers.chips.map((chip) => (
          <span
            key={chip.seq}
            className="pointer-events-none absolute top-2 ml-[8px] rounded px-1.5 py-0.5 font-mono text-[10.5px] whitespace-nowrap"
            style={{
              left: `${chip.left}%`,
              color: `var(${lane.color})`,
              background: `color-mix(in srgb, var(${lane.color}) 14%, var(--color-plot))`,
              outline:
                selectedSeq === chip.seq
                  ? `1px solid color-mix(in srgb, var(${lane.color}) 60%, transparent)`
                  : "none",
            }}
          >
            {chip.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function tipFor(hit: Hit): string {
  const data: Record<string, unknown> =
    hit.kind === "span"
      ? { durationMs: hit.span.end - hit.span.start, open: hit.span.open, ...hit.span.data }
      : hit.event.data;

  return Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== "")
    .slice(0, 7)
    .map(([key, value]) => {
      const text = String(value).replace(/\s+/g, " ");
      return `${key}: ${text.length > 80 ? text.slice(0, 80) + "…" : text}`;
    })
    .join("\n");
}

export type { Hit };
