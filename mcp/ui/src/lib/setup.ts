// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

export interface SetupEntry {
  name: string;
  onClasspath: boolean;
  instrumented: boolean;
  hint?: string;
}

/**
 * Which integrations back each lane.
 *
 * More than one can: an app might use OkHttp or Ktor, Room or SQLDelight, and
 * instrumenting either is enough for the lane to carry data.
 */
const LANE_INTEGRATIONS: Record<string, string[]> = {
  http: ["okhttp", "ktor"],
  db: ["room", "sqlite"],
  nav: ["navigation"],
};

/**
 * Why a lane is empty, or null if there is no reason to say anything.
 *
 * An empty lane looks the same whether the app made no requests or whether
 * nobody put a porthole on the client. Only the second is worth a message, and
 * only when the library is actually on the classpath — an app with no database
 * should never be told about Room.
 */
export function missingIntegration(laneKey: string, setup: SetupEntry[]): string | null {
  const names = LANE_INTEGRATIONS[laneKey];
  if (!names || setup.length === 0) return null;

  const relevant = setup.filter((entry) => names.includes(entry.name) && entry.onClasspath);
  if (relevant.length === 0) return null;
  if (relevant.some((entry) => entry.instrumented)) return null;

  return relevant.map((entry) => entry.name).join(" or ") + " not instrumented";
}

/** The hints themselves, for the one place that spells out what to do. */
export function missingHints(setup: SetupEntry[]): SetupEntry[] {
  return setup.filter((entry) => entry.onClasspath && !entry.instrumented && entry.hint);
}

/**
 * Asked for once when the app connects, and again a moment later.
 *
 * The answer is only meaningful after the app has built its clients, and the
 * first ask often lands before that.
 */
export function useSetup(connected: boolean): SetupEntry[] {
  const [setup, setSetup] = useState<SetupEntry[]>([]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;

    const ask = async () => {
      try {
        const result: unknown = await fetch("/api/setup").then((r) => r.json());
        if (!cancelled && Array.isArray(result)) setSetup(result as SetupEntry[]);
      } catch {
        // The device answers this one; if it cannot, the lanes simply say less.
      }
    };

    void ask();
    const later = setTimeout(() => void ask(), 6000);
    return () => {
      cancelled = true;
      clearTimeout(later);
    };
  }, [connected]);

  return setup;
}
