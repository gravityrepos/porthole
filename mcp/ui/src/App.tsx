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
import type { ViewWindow } from "./types";

/** Window the event rate is averaged over, so the header reads steadily. */
const RATE_WINDOW_MS = 2000;

export function App() {
  const { store, version } = useDeviceStream();
  const setup = useSetup(store.connection === "connected");
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
