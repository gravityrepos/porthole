// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DbInspector } from "./components/DbInspector";
import { Header } from "./components/Header";
import { InsightsPanel } from "./components/InsightsPanel";
import { LogPane } from "./components/LogPane";
import { SelectionPanel } from "./components/SelectionPanel";
import { TimelinePanel } from "./components/TimelinePanel";
import { WindowPanel } from "./components/WindowPanel";
import { useDeviceStream } from "./store/useDeviceStream";
import { agentPrompt } from "./lib/agentPrompt";
import { summariseWindow } from "./lib/analysis";
import { usePersistent } from "./lib/persist";
import type { Hit } from "./lib/laneData";
import { useSetup } from "./lib/setup";
import { centreOn, fitView } from "./timeline/geometry";
import type { ConnectionState, Hello, ViewWindow } from "./types";

/** Window the event rate is averaged over, so the header reads steadily. */
const RATE_WINDOW_MS = 2000;

/**
 * GRA-166 item 5: UI-local mirror of `device.ts`'s `isAttached()` — true for
 * "handshaking" and "connected", false for "connecting" and "disconnected".
 * Duplicated rather than imported: `device.ts` imports `node:net` at module
 * scope for the real socket, so importing *any* value out of that module —
 * even an unrelated function — pulls the whole module, `node:net` included,
 * into the browser bundle. `types.ts`'s own comment on its `ConnectionState`
 * re-export documents the same constraint for a type (erased at build time,
 * so safe); this is the value-shaped version, which is not erased and so has
 * no safe import path. Confirmed the same way that comment was: `npx vite
 * build` after adding this produced no new Node built-ins in the bundle.
 *
 * Also deliberately NOT device.ts's never-guarded, throw-on-default
 * `isAttached()` (GRA-162). That throw is safe there because every
 * ConnectionState value in that process is produced by the same Node build;
 * here `connection` can arrive from a server a build ahead of this bundle,
 * so an unrecognised value is a real possibility to survive — same reasoning
 * as Header.tsx's `connectionDisplay`, which this switch matches in shape.
 *
 * The default matters, not just its absence of a throw: before this ticket
 * the setup probe used `store.connection === "connected"` directly, so an
 * unrecognised future state fell through to "not attached" the same way
 * "handshaking" did. The "handshaking" case is self-healing — the effect's
 * dependency changes the moment the literal string "connected" arrives, so
 * it re-fires on its own a moment later. An unrecognised state is not: unless
 * it happens to transition to literal "connected", nothing here ever
 * re-evaluates the decision, so the probe would stay silent for the rest of
 * the session. Defaulting to true costs one avoidable `/api/setup` fetch if
 * the guess is wrong; defaulting to false is the actual defect.
 */
export function isAttached(connection: ConnectionState): boolean {
  switch (connection) {
    case "connecting":
    case "disconnected":
      return false;
    case "handshaking":
    case "connected":
      return true;
    default:
      return true;
  }
}

/**
 * GRA-96: the protocol version this UI bundle was built expecting the app to
 * speak, mirroring `device.ts`'s `PROTOCOL_VERSION` by value rather than by
 * import, for the same node:net reason `isAttached` above is duplicated
 * rather than imported. The server-side check (`device.ts` /
 * `porthole_status`) is the one that actually refuses a mismatch; this is
 * the UI's own copy of the same fact, kept in sync by hand alongside it —
 * search this project for `PROTOCOL_VERSION` when changing either.
 */
const EXPECTED_PROTOCOL_VERSION = 1;

/**
 * GRA-96 AC3: "the UI surfaces it rather than showing 'connected' and empty
 * lanes." Null once `hello` has not landed yet or the versions agree;
 * otherwise the sentence rendered next to the connection state.
 */
export function protocolMismatchMessage(hello: Hello | null): string | null {
  if (!hello || hello.protocol === EXPECTED_PROTOCOL_VERSION) return null;
  return (
    `The app is speaking protocol ${hello.protocol}; this UI was built understanding protocol ` +
    `${EXPECTED_PROTOCOL_VERSION}. Update the app's Porthole runtime, or reload once the npm ` +
    "package this UI is served from has been updated to match."
  );
}

export function App() {
  const { store, version } = useDeviceStream();
  const setup = useSetup(isAttached(store.connection));
  const protocolMismatch = protocolMismatchMessage(store.hello);
  // One extra view, so a path check earns its keep where a router would not.
  const [route, setRoute] = useState(() => location.pathname.replace(/\/+$/, ""));

  useEffect(() => {
    const onPop = () => setRoute(location.pathname.replace(/\/+$/, ""));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((path: string) => {
    history.pushState({}, "", path || "/");
    setRoute(path.replace(/\/+$/, ""));
  }, []);

  const [view, setView] = useState<ViewWindow>({ start: 0, end: 1000 });
  const [following, setFollowing] = usePersistent("following", true);
  /** Anonymous writes are background texture; off by default. */
  const [showFramework, setShowFramework] = usePersistent("framework", false);
  const [hit, setHit] = useState<Hit | null>(null);
  const [askLabel, setAskLabel] = useState("ask agent");
  const [copyLabel, setCopyLabel] = useState("copy trace");
  const [restartLabel, setRestartLabel] = useState("restart app");

  // Fit once, when the first batch arrives. After that the view is the user's,
  // and refitting under them would be rude.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || store.events.length === 0) return;
    fitted.current = true;
    setView(fitView(store.events));
  }, [store, version]);

  // This still produces a new `view` object on every store notification --
  // up to once an animation frame while `following` is on (GRA-80). Left
  // that way deliberately: `view` genuinely does move every frame here, so
  // there is no rounded-and-therefore-stable value to key this effect on
  // instead, and every consumer downstream that turns `view` into a network
  // request (InsightsPanel) rounds and debounces on its own side rather than
  // trusting App not to over-notify. Fixing it here would only trade one
  // "recompute more often than needed" for another -- the network storm the
  // ticket cared about is severed at InsightsPanel regardless of how often
  // this effect fires.
  useEffect(() => {
    if (!following || store.events.length === 0) return;
    setView((current) => {
      const span = current.end - current.start;
      const newest = store.events[store.events.length - 1].t;
      return { start: newest - span * 0.92, end: newest + span * 0.08 };
    });
  }, [store, version, following]);

  const summary = useMemo(
    () => summariseWindow(store.events, view),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version, view],
  );

  const eventsPerSecond = useMemo(() => {
    const events = store.events;
    if (events.length === 0) return 0;
    const newest = events[events.length - 1].t;
    let count = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (newest - events[i].t > RATE_WINDOW_MS) break;
      count += 1;
    }
    return Math.round((count / RATE_WINDOW_MS) * 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version]);

  const copy = useCallback(async (text: string, done: (label: string) => void, idle: string) => {
    try {
      await navigator.clipboard.writeText(text);
      done("copied");
      setTimeout(() => done(idle), 1200);
    } catch {
      // Clipboard access can be refused; the panel still shows the data.
    }
  }, []);

  const ask = useCallback(
    () => void copy(agentPrompt(store.events, view), setAskLabel, "ask agent"),
    [copy, store, view],
  );

  const copyTrace = useCallback(
    () =>
      void copy(
        JSON.stringify(
          store.events.filter((event) => event.t >= summary.from && event.t <= summary.to),
          null,
          2,
        ),
        setCopyLabel,
        "copy trace",
      ),
    [copy, store, summary],
  );

  // Restarting throws away whatever the app was doing, so it asks first. The
  // confirm lives here rather than in the header, which should not have to know
  // that the button is destructive.
  const restart = useCallback(async () => {
    if (!window.confirm("Force-stop the app and launch it again?")) return;
    setRestartLabel("restarting");
    try {
      const result = await fetch("/api/tools/restart", { method: "POST" }).then((r) => r.json());
      setRestartLabel(result.ok ? "restarted" : "restart failed");
      if (!result.ok) console.error("porthole restart:", result.output);
    } catch (error) {
      setRestartLabel("restart failed");
      console.error("porthole restart:", error);
    }
    setTimeout(() => setRestartLabel("restart app"), 1800);
  }, []);

  if (route === "/db") return <DbInspector onBack={() => go("/")} />;

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-[var(--color-bg)]">
      {/* Header plus the protocol-mismatch banner share the grid's "auto"
          row as one block, so adding the banner does not require touching
          Header.tsx's own layout or its grid-row placement. */}
      <div>
        <Header
          onOpenDatabase={() => go("/db")}
          onRestart={restart}
          restartLabel={restartLabel}
          connection={store.connection}
          hello={store.hello}
          eventsPerSecond={eventsPerSecond}
          following={following}
          showFramework={showFramework}
          onToggleFollowing={() => setFollowing((value) => !value)}
          onToggleFramework={() => setShowFramework((value) => !value)}
          onFit={() => setView(fitView(store.events))}
          onClear={() => {
            store.clear();
            fitted.current = false;
            setHit(null);
          }}
          onAsk={ask}
          askLabel={askLabel}
        />
        {/* GRA-96 AC3: right below the connection state, not buried in a
            panel — a mismatched build should be the first thing read, since
            every lane below can be silently wrong data instead of no data. */}
        {protocolMismatch && (
          <div
            role="alert"
            className="border-b border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-3.5 py-1.5 font-mono text-[11px] text-[var(--danger)]"
          >
            {protocolMismatch}
          </div>
        )}
      </div>

      <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_clamp(200px,30vw,332px)]">
        <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] border-r border-[var(--color-line)]">
          <TimelinePanel
            store={store}
            version={version}
            view={view}
            onViewChange={setView}
            onFollowingChange={setFollowing}
            showFramework={showFramework}
            setup={setup}
            onSelect={setHit}
            selectedSeq={hit?.kind === "event" ? hit.event.seq : null}
          />
          <LogPane
            store={store}
            version={version}
            onSeek={(t) => {
              setFollowing(false);
              setView((current) => centreOn(current, t));
            }}
          />
        </div>

        <aside className="grid min-h-0 min-w-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 overflow-y-auto bg-[var(--color-panel)] p-2">
          {/* Conclusions first: the panels below are the evidence for them. */}
          <InsightsPanel from={view.start} to={view.end} />
          <SelectionPanel hit={hit} />
          <WindowPanel
            summary={summary}
            onAsk={ask}
            onCopyTrace={copyTrace}
            copyLabel={copyLabel}
          />
        </aside>
      </div>
    </div>
  );
}
