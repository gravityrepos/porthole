// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

const PREFIX = "porthole.";

/**
 * Only settled preferences belong here — how you like the tool laid out, not
 * what you were looking at. Anything that refers to a specific event is scoped
 * to a session that ends when the app restarts, and restoring it would point at
 * a different event or at nothing.
 */
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    // A value stored by an older build can be the wrong shape entirely.
    return typeof parsed === typeof fallback ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * useState that remembers. Storage can be missing or refused — a private
 * window, blocked site data — so every access is guarded and the preference
 * simply does not survive the reload.
 */
export function usePersistent<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => read(key, fallback));

  useEffect(() => {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // Nothing to do, and nothing worth telling the user about.
    }
  }, [key, value]);

  return [value, setValue] as const;
}
