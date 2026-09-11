// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { LEGEND } from "../timeline/lanes";
import type { ConnectionState, Hello } from "../types";

interface Props {
  connection: ConnectionState;
  hello: Hello | null;
  eventsPerSecond: number;
  following: boolean;
  showFramework: boolean;
  onToggleFollowing: () => void;
  onToggleFramework: () => void;
  onFit: () => void;
  onClear: () => void;
  onAsk: () => void;
  onOpenDatabase: () => void;
  onRestart: () => void;
  restartLabel: string;
  askLabel: string;
}

export function Header({
  connection,
  hello,
  eventsPerSecond,
  following,
  showFramework,
  onToggleFollowing,
  onToggleFramework,
  onFit,
  onClear,
  onAsk,
  onOpenDatabase,
  onRestart,
  restartLabel,
  askLabel,
}: Props) {
  const live = connection === "connected";
  const tone = live ? "var(--accent)" : "var(--danger)";
  const status = live
    ? `live · ${eventsPerSecond} evt/s`
    : connection === "connecting"
      ? "connecting"
      : "disconnected";

  return (
    <header className="flex min-h-[46px] flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-[var(--color-line)] bg-gradient-to-b from-[#181e29] to-[#141924] px-3.5 py-[7px]">
      <div className="flex items-center gap-[9px]">
        {/* The mark, at its drawn proportions. Always brand teal: the mark is
            single-colour by rule, and the pill beside it carries the state. */}
        <svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true" className="flex-none">
          <circle cx="16" cy="16" r="13.2" fill="none" stroke="var(--accent)" strokeWidth="2.6" />
          <circle cx="16" cy="16" r="3.5" fill="var(--accent)" />
        </svg>
        <span className="text-sm font-bold tracking-[0.16em] text-[#eef3fa]">PORTHOLE</span>
      </div>

      <span
        className="flex items-center gap-[7px] rounded-full border py-1 pr-2.5 pl-2"
        style={{
          background: `color-mix(in srgb, ${tone} 8%, transparent)`,
          borderColor: `color-mix(in srgb, ${tone} 30%, transparent)`,
        }}
      >
        <span
          className={`size-[7px] rounded-full ${live ? "ph-pulse" : ""}`}
          style={{ background: tone }}
        />
        <span className="font-mono text-[11px] tracking-[0.06em]" style={{ color: tone }}>
          {status}
        </span>
      </span>

      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1 font-mono text-[11.5px] text-[var(--color-muted)]">
        {hello ? (
          <>
            <span className="text-[#cfd8e5]">{hello.packageName}</span>
            <Slash />
            <span>{hello.device}</span>
            <Slash />
            <span>API {hello.sdkInt}</span>
            <Slash />
            <span>{hello.collectors.length} channels</span>
          </>
        ) : (
          <span>waiting for the app</span>
        )}
      </div>

      <div className="flex-1 basis-5" />

      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 pr-1">
        {LEGEND.map((entry) => (
          <span key={entry.name} className="flex items-center gap-[5px]">
            <span className="size-2 rounded-[2px]" style={{ background: `var(${entry.color})` }} />
            <span className="text-[11px] text-[#97a3b5]">{entry.name}</span>
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Chip
          active={showFramework}
          onClick={onToggleFramework}
          title="Show writes the tool cannot name, which is mostly Compose internals"
        >
          framework
        </Chip>
        <Chip
          active={following}
          onClick={onToggleFollowing}
          title="Pin the view to the newest event"
        >
          follow
        </Chip>
        <Chip onClick={onOpenDatabase} title="Read the app's own tables">
          database
        </Chip>
        <Chip onClick={onRestart} title="Force-stop the app and launch it again">
          {restartLabel}
        </Chip>
        <Chip onClick={onFit}>fit</Chip>
        <Chip onClick={onClear}>clear</Chip>
        <button
          onClick={onAsk}
          title="Copy a prompt describing the window you are looking at"
          className="cursor-pointer rounded-md border border-[var(--accent)] bg-[var(--accent)] px-[11px] py-[5px] font-mono text-[11px] font-medium text-[#0f1620] hover:brightness-110"
        >
          {askLabel}
        </button>
      </div>
    </header>
  );
}

function Slash() {
  return <span className="text-[#3d4658]">/</span>;
}

function Chip({
  active = false,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`cursor-pointer rounded-md border px-2.5 py-[5px] font-mono text-[11px] ${
        active
          ? "border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-[var(--accent)]"
          : "border-[var(--color-edge)] bg-[var(--color-control)] text-[#9aa6b8] hover:bg-[#222b3a] hover:text-[#dbe3ef]"
      }`}
    >
      {children}
    </button>
  );
}
