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
  /** GRA-116: seconds the "keep" control saves back from now while following the live edge. Ignored while zoomed/panned. */
  lookbackSeconds: number;
  onLookbackSecondsChange: (seconds: number) => void;
  onSave: () => void;
  saveLabel: string;
  /** The path `POST /api/save` just wrote, or null before any save (or after one that failed). */
  savePath: string | null;
  /** One line, or null when the last save attempt succeeded (or none has happened yet). */
  saveError: string | null;
}

interface ConnectionDisplay {
  /** A CSS colour, used for both the dot and its label. */
  tone: string;
  label: string;
  /** Only "connected" pulses — it is the one state actually receiving events. */
  pulse: boolean;
}

/**
 * GRA-161: what the pill says, pulled out of Header() so it can be tested
 * without rendering a component — this workspace has no DOM-rendering test
 * setup (see Header.test.tsx), the same reason FindingsLoader lives outside
 * InsightsPanel.
 *
 * The switch below is intentionally NOT the never-guarded, throw-on-default
 * pattern `device.ts`'s pendingMessage() and the server-side isAttached() /
 * isConnected() / isHandshaking() use (GRA-162). Those run in a Node process
 * where every ConnectionState value is produced by this same build, so a
 * value outside the union really is unreachable and throwing to say so is
 * safe. Here it is not: `connection` arrives over a WebSocket as a plain
 * string, and the browser tab can be a slightly older build than the server
 * sending it (a deploy mid-flight, a stale reload) — so a state this
 * particular build's `ConnectionState` does not know about is a real
 * possibility this render has to survive, not a bug to throw on.
 *
 * That is also the actual content of GRA-161 AC4 and GRA-162's shared
 * argument: before this ticket, an unrecognised string fell through to the
 * `else` branch, which was "disconnected" — a state this build has never
 * heard of rendered as a proven failure. The `default` case below is the
 * fix: unknown gets the same neutral treatment as "connecting" (a transient,
 * unproven state, not an alarm), with the raw value kept in the label so it
 * is debuggable rather than silently swallowed.
 */
export function connectionDisplay(
  connection: ConnectionState,
  eventsPerSecond: number,
): ConnectionDisplay {
  switch (connection) {
    case "connected":
      return { tone: "var(--accent)", label: `live · ${eventsPerSecond} evt/s`, pulse: true };
    case "handshaking":
      // GRA-161 AC2: neither the green "connected" pill (the app has not
      // checked in yet, so that claim is not true) nor the red
      // "disconnected" one (the socket is up; nothing has failed) — its own
      // wording, matching the server's HANDSHAKE_PENDING_MESSAGE in
      // substance: connected to the device, waiting on the app.
      return { tone: "var(--color-muted)", label: "connected · waiting on app", pulse: false };
    case "connecting":
      // Also neutral, not the red it was before this ticket: dialling the
      // socket has not failed at anything yet either. Handshaking and
      // connecting are both "in progress, not proven bad" and now read that
      // way instead of the pill inconsistently calling one of them a
      // failure and not the other.
      return { tone: "var(--color-muted)", label: "connecting", pulse: false };
    case "disconnected":
      return { tone: "var(--danger)", label: "disconnected", pulse: false };
    default:
      // See the function comment: deliberately not exhaustive-strict here.
      return { tone: "var(--color-muted)", label: `state: ${connection as string}`, pulse: false };
  }
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
  lookbackSeconds,
  onLookbackSecondsChange,
  onSave,
  saveLabel,
  savePath,
  saveError,
}: Props) {
  const { tone, label, pulse } = connectionDisplay(connection, eventsPerSecond);

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
          className={`size-[7px] rounded-full ${pulse ? "ph-pulse" : ""}`}
          style={{ background: tone }}
        />
        <span className="font-mono text-[11px] tracking-[0.06em]" style={{ color: tone }}>
          {label}
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
        {/* GRA-116: the "keep" control. The N-second lookback only means
            anything while following the live edge -- zoomed/panned away, the
            saved window is exactly what the ruler shows, with nothing to
            configure -- so the input is hidden rather than shown disabled. */}
        {following && (
          <input
            type="number"
            min={1}
            value={lookbackSeconds}
            onChange={(event) => {
              const seconds = Math.round(Number(event.target.value));
              if (Number.isFinite(seconds) && seconds > 0) onLookbackSecondsChange(seconds);
            }}
            title="Seconds to keep, ending now"
            aria-label="seconds to keep"
            className="w-12 rounded-md border border-[var(--color-edge)] bg-[var(--color-control)] px-1.5 py-[5px] text-center font-mono text-[11px] text-[#dbe3ef]"
          />
        )}
        <Chip
          onClick={onSave}
          title={
            following
              ? `Save the last ${lookbackSeconds}s as a trace file`
              : "Save the visible window as a trace file"
          }
        >
          {saveLabel}
        </Chip>
        <button
          onClick={onAsk}
          title="Copy a prompt describing the window you are looking at"
          className="cursor-pointer rounded-md border border-[var(--accent)] bg-[var(--accent)] px-[11px] py-[5px] font-mono text-[11px] font-medium text-[#0f1620] hover:brightness-110"
        >
          {askLabel}
        </button>
      </div>

      {/* A flex-basis-full child on a flex-wrap row always starts a new
          line, so the result (or error) shows on its own row below the
          controls rather than fighting them for space. */}
      {(savePath || saveError) && (
        <div className="flex w-full basis-full flex-wrap items-center gap-2.5 font-mono text-[11px]">
          {savePath && (
            <>
              <input
                readOnly
                value={savePath}
                onFocus={(event) => event.currentTarget.select()}
                aria-label="saved trace path"
                title="The trace file just written -- click to select, then copy"
                className="min-w-0 flex-1 rounded-md border border-[var(--color-edge)] bg-[var(--color-control)] px-2 py-1 text-[#dbe3ef]"
              />
              {/* Ruling 1, verbatim: GRA-57 (the system trace ring) is not in
                  0.2.0, so every save through this control is Porthole-only. */}
              <span className="text-[var(--color-muted)]">
                Porthole half only; no system trace was attached.
              </span>
            </>
          )}
          {saveError && (
            <span role="alert" className="text-[var(--danger)]">
              {saveError}
            </span>
          )}
        </div>
      )}
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
