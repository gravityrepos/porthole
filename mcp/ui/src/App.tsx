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
import { FindingsLoader } from "./lib/findingsLoader";
import { usePersistent } from "./lib/persist";
import type { Hit } from "./lib/laneData";
import { DEFAULT_LOOKBACK_SECONDS, saveRequestBody, saveWindow } from "./lib/save";
import { useSetup } from "./lib/setup";
import { centreOn, fitView } from "./timeline/geometry";
import type { ConnectionState, FindingsPayload, Hello, TraceListing, ViewWindow } from "./types";

/** How often `/api/traces` is re-polled — new captures are rare and land
 *  from an agent call, not from user interaction, so this only has to be
 *  frequent enough that a freshly-taken capture shows up in the chooser
 *  without a manual reload. Mirrors `useSetup`'s own re-ask interval. */
const TRACES_POLL_MS = 8000;

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

/**
 * GRA-96 QA follow-up: this workspace has no DOM-rendering test setup
 * (Header.tsx's `connectionDisplay` and InsightsPanel's `FindingsLoader` are
 * pulled out of their components for the same reason), and deliberately
 * stays that way — jsdom/happy-dom plus a testing-library is a real
 * dependency decision for the whole `ui` package, bigger than one ticket,
 * and should not arrive as a side effect of a fix pass. That left a real
 * gap: `protocolMismatchMessage` was tested directly, but the JSX condition
 * that decided *whether to render the banner at all* (`{protocolMismatch &&
 * (<div>...)}`, inline in App()'s JSX) was not exercised by anything, so
 * either that condition or the `protocolMismatch` variable feeding it could
 * be broken with the UI suite staying 124/124 green.
 *
 * The fix is to make the render *decision* — not just the message text — a
 * pure function, by having it return the actual node (or null) rather than
 * a boolean or a string. React elements are plain objects
 * (`{ type, props, ... }`) built by JSX/`React.createElement` at *call*
 * time, not by a DOM renderer, so `protocolBanner(hello).type` and
 * `.props.children` are inspectable in a plain Node test environment with
 * no jsdom involved — confirmed by the tests in App.test.tsx below, which
 * import this function and read `.type`/`.props` directly. App()'s JSX
 * collapses to `{protocolBanner(store.hello)}`, a single call with nothing
 * left beside it to mutate independently.
 *
 * This does not make the *rendering* tested — nothing proves App()'s JSX
 * still calls this function with the right argument, or that React actually
 * mounts what it returns. That residual gap is real, but it is now "does
 * the JSX invoke this one function correctly", which is a much smaller and
 * more obvious thing to get wrong than the condition-plus-variable pair this
 * replaces.
 */
export function protocolBanner(hello: Hello | null) {
  const message = protocolMismatchMessage(hello);
  if (!message) return null;
  return (
    <div
      role="alert"
      className="border-b border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-3.5 py-1.5 font-mono text-[11px] text-[var(--danger)]"
    >
      {message}
    </div>
  );
}

/**
 * GRA-114 ruling 4: what `/api/traces` lists, polled rather than fetched
 * once — a capture can land while the tab is open (an agent calling
 * `capture_system_trace`), and the chooser should notice without a reload.
 * `/api/traces` lists files on disk; unlike `useSetup`'s `/api/setup`, it
 * needs no device attachment, so this polls unconditionally from mount.
 */
function useTraces(): TraceListing[] {
  const [traces, setTraces] = useState<TraceListing[]>([]);

  useEffect(() => {
    let cancelled = false;

    const ask = async () => {
      try {
        const body: unknown = await fetch("/api/traces").then((r) => r.json());
        const list = (body as { traces?: unknown }).traces;
        if (!cancelled && Array.isArray(list)) setTraces(list as TraceListing[]);
      } catch {
        // The chooser simply keeps showing whatever it last knew about.
      }
    };

    void ask();
    const interval = setInterval(() => void ask(), TRACES_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return traces;
}

export function App() {
  const { store, version } = useDeviceStream();
  const setup = useSetup(isAttached(store.connection));
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
  const [restartLabel, setRestartLabel] = useState("restart app");

  // GRA-116: "keep the last N seconds, from where you are already looking".
  // Persisted the same way `following`/`showFramework` are -- a developer who
  // just set their preferred lookback should not have it forgotten on the
  // next reload.
  const [lookbackSeconds, setLookbackSeconds] = usePersistent(
    "lookbackSeconds",
    DEFAULT_LOOKBACK_SECONDS,
  );
  const [saveLabel, setSaveLabel] = useState("keep");
  const [savePath, setSavePath] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // GRA-114: hoisted out of InsightsPanel. One FindingsLoader, constructed
  // once, so the findings lane and the panel read the same fetch instead of
  // each running its own — the "one request per settled view" ruling is
  // structural because of this, not something either consumer has to get
  // right on its own.
  const [findingsPayload, setFindingsPayload] = useState<FindingsPayload | null>(null);
  const [findingsLoading, setFindingsLoading] = useState(false);
  const [findingsError, setFindingsError] = useState<string | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const traces = useTraces();

  const findingsLoaderRef = useRef<FindingsLoader | null>(null);
  if (findingsLoaderRef.current === null) {
    findingsLoaderRef.current = new FindingsLoader({
      onStart: () => {
        setFindingsLoading(true);
        setFindingsError(null);
      },
      onSuccess: (body) => {
        setFindingsPayload(body);
        setFindingsLoading(false);
      },
      onError: (message) => {
        setFindingsError(message);
        setFindingsLoading(false);
      },
    });
  }

  useEffect(() => {
    return () => findingsLoaderRef.current?.dispose();
  }, []);

  // Sub-pixel changes to `view` (every animation frame while panning or
  // following) never reach this effect at all once rounded, the same
  // reasoning InsightsPanel used to apply to its own `from`/`to` props.
  const findingsFrom = Math.round(view.start);
  const findingsTo = Math.round(view.end);

  useEffect(() => {
    findingsLoaderRef.current?.schedule(findingsFrom, findingsTo, selectedTraceId ?? undefined);
  }, [findingsFrom, findingsTo, selectedTraceId]);

  const refreshFindings = useCallback(
    () => findingsLoaderRef.current?.runNow(findingsFrom, findingsTo, selectedTraceId ?? undefined),
    [findingsFrom, findingsTo, selectedTraceId],
  );

  // A trace can vanish from `/api/traces` (or arrive with unreadable
  // coverage) after it was chosen — falling back to null rather than
  // whatever stale coverage was last known keeps the ruler's band honest.
  const traceCoverage = useMemo(
    () => traces.find((t) => t.id === selectedTraceId)?.coverage ?? null,
    [traces, selectedTraceId],
  );

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

  // GRA-116: replaces the old **copy trace** control (an unbounded JSON blob
  // on the clipboard) with the real thing -- a named trace file on disk,
  // through the same save path `save_moment` already uses server-side.
  const save = useCallback(async () => {
    const newestEventT = store.events.length > 0 ? store.events[store.events.length - 1].t : null;
    const window = saveWindow({ following, view, lookbackSeconds, newestEventT });
    if (!window) {
      setSaveError("Nothing buffered yet to save.");
      setSavePath(null);
      return;
    }
    setSaveLabel("saving");
    setSaveError(null);
    try {
      const response = await fetch("/api/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(saveRequestBody(window)),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message = (body as { error?: unknown }).error;
        setSaveError(typeof message === "string" ? message : "The save failed.");
        setSavePath(null);
        setSaveLabel("save failed");
      } else {
        setSavePath((body as { out: string }).out);
        setSaveError(null);
        setSaveLabel("kept");
      }
    } catch (error) {
      setSaveError((error as Error).message);
      setSavePath(null);
      setSaveLabel("save failed");
    }
    setTimeout(() => setSaveLabel("keep"), 1800);
  }, [store, following, view, lookbackSeconds]);

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
          packageMismatch={store.packageMismatch}
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
          lookbackSeconds={lookbackSeconds}
          onLookbackSecondsChange={setLookbackSeconds}
          onSave={() => void save()}
          saveLabel={saveLabel}
          savePath={savePath}
          saveError={saveError}
        />
        {/* GRA-96 AC3: right below the connection state, not buried in a
            panel — a mismatched build should be the first thing read, since
            every lane below can be silently wrong data instead of no data.
            A single call to the tested protocolBanner() above, not an
            inline condition — see that function's comment. */}
        {protocolBanner(store.hello)}
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
            findings={findingsPayload?.findings ?? []}
            findingsWindow={findingsPayload?.window ?? null}
            findingsLoading={findingsLoading}
            hasFindingsPayload={findingsPayload !== null}
            selectedFindingId={hit?.kind === "finding" ? hit.finding.id : null}
            traceLoaded={selectedTraceId !== null}
            traceCoverage={traceCoverage}
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
          <InsightsPanel
            payload={findingsPayload}
            loading={findingsLoading}
            error={findingsError}
            onRefresh={refreshFindings}
            traces={traces}
            selectedTraceId={selectedTraceId}
            onSelectTrace={setSelectedTraceId}
          />
          <SelectionPanel
            hit={hit}
            traces={traces}
            selectedTraceId={selectedTraceId}
            contextWindow={findingsPayload?.window ?? null}
          />
          <WindowPanel summary={summary} onAsk={ask} />
        </aside>
      </div>
    </div>
  );
}
