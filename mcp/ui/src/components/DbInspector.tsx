// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from "react";

interface Column {
  name: string;
  type: string;
}

interface Page {
  table?: string | null;
  columns?: Column[];
  rows?: Array<Array<string | null>>;
  total?: number;
  offset?: number;
  truncated?: boolean;
  error?: string;
}

interface Tables {
  database?: string | null;
  databases?: string[];
  tables?: Array<{ name: string; rows: number }>;
  error?: string;
}

const PAGE_SIZES = [50, 100, 250, 500];
/** Slow enough to stay out of the app's way; the counts are skipped anyway. */
const AUTO_MS = 2000;

/**
 * A read-only window onto the app's own tables.
 *
 * It asks the device every time rather than keeping a copy. A cached mirror of
 * a live database is wrong the moment the app writes, and being quietly wrong
 * is worse than being a refresh behind.
 */
export function DbInspector({ onBack }: { onBack: () => void }) {
  const [tables, setTables] = useState<Tables | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [sql, setSql] = useState("");
  const [running, setRunning] = useState(false);
  const [pageSize, setPageSize] = useState(100);
  const [auto, setAuto] = useState(false);

  const loadTables = useCallback(async () => {
    try {
      setTables(await fetch("/api/db/tables").then((r) => r.json()));
    } catch (error) {
      setTables({ error: (error as Error).message });
    }
  }, []);

  const loadRows = useCallback(
    async (name: string, at: number, size = pageSize, withCount = true) => {
      setRunning(true);
      try {
        const next: Page = await fetch(
          `/api/db/rows?table=${encodeURIComponent(name)}&limit=${size}&offset=${at}` +
            (withCount ? "" : "&count=0"),
        ).then((r) => r.json());
        // A poll skips COUNT(*), so it carries the last known total forward
        // rather than blanking the footer every two seconds.
        setPage((current) =>
          withCount || next.error ? next : { ...next, total: current?.total ?? -1 },
        );
      } catch (error) {
        setPage({ error: (error as Error).message });
      } finally {
        setRunning(false);
      }
    },
    [pageSize],
  );

  const runSql = useCallback(async () => {
    if (!sql.trim()) return;
    setRunning(true);
    setTable(null);
    try {
      setPage(await fetch(`/api/db/query?sql=${encodeURIComponent(sql)}`).then((r) => r.json()));
    } catch (error) {
      setPage({ error: (error as Error).message });
    } finally {
      setRunning(false);
    }
  }, [sql]);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  // Polling is opt-in and refreshes only the page in front of you. Refreshing
  // the table list would re-run a COUNT(*) per table on the app's own
  // connection, and SQLite answers that with a scan — too much to spend on the
  // chance that something changed.
  useEffect(() => {
    if (!auto || !table) return;
    const timer = setInterval(() => void loadRows(table, offset, pageSize, false), AUTO_MS);
    return () => clearInterval(timer);
  }, [auto, table, offset, pageSize, loadRows]);

  const open = (name: string) => {
    setTable(name);
    setOffset(0);
    void loadRows(name, 0);
  };

  const refresh = () => {
    void loadTables();
    if (table) void loadRows(table, offset);
  };

  const step = (by: number) => {
    if (!table) return;
    const next = Math.max(0, offset + by);
    setOffset(next);
    void loadRows(table, next);
  };

  const resize = (size: number) => {
    setPageSize(size);
    setOffset(0);
    if (table) void loadRows(table, 0, size);
  };

  const shown = page?.rows?.length ?? 0;
  const counted = page?.total ?? -1;
  // A poll carries the last count forward, and the app can write in between, so
  // the count can be disproved by the rows on screen. "rows 1-6 of 5" is worse
  // than not saying: drop it until a refresh re-counts.
  const total = counted >= 0 && offset + shown > counted ? -1 : counted;

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-[var(--color-bg)]">
      <header className="flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-line)] bg-gradient-to-b from-[#181e29] to-[#141924] px-3.5 py-[7px]">
        <button
          onClick={onBack}
          className="cursor-pointer rounded-md border border-[var(--color-edge)] bg-[var(--color-control)] px-2.5 py-[5px] font-mono text-[11px] text-[#9aa6b8] hover:text-[#dbe3ef]"
        >
          ‹ timeline
        </button>
        <span className="text-sm font-bold tracking-[0.16em] text-[#eef3fa]">DATABASE</span>
        <span className="font-mono text-[11.5px] text-[var(--color-muted)]">
          {tables?.database ?? "—"}
        </span>

        <div className="flex-1 basis-4" />

        <input
          value={sql}
          onChange={(event) => setSql(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void runSql()}
          placeholder="SELECT … (read only)"
          className="min-w-[180px] flex-1 basis-[260px] rounded-md border border-[#262e3c] bg-[#11161f] px-2.5 py-[5px] font-mono text-[11px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-muted)]"
        />
        <button
          onClick={() => void runSql()}
          className="cursor-pointer rounded-md border border-[var(--color-edge)] bg-[var(--color-control)] px-2.5 py-[5px] font-mono text-[11px] text-[#9aa6b8] hover:text-[#dbe3ef]"
        >
          run
        </button>
        <button
          onClick={refresh}
          className="cursor-pointer rounded-md border border-[var(--accent)] bg-[var(--accent)] px-[11px] py-[5px] font-mono text-[11px] text-[#0f1620] hover:brightness-110"
        >
          {running ? "…" : "refresh"}
        </button>
      </header>

      <div className="grid min-h-0 grid-cols-[clamp(150px,20%,230px)_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-r border-[var(--color-line)] bg-[var(--color-panel)] py-2">
          <div className="px-3 pb-1.5 font-mono text-[10px] tracking-[0.12em] text-[var(--color-dim)]">
            TABLES
          </div>
          {tables?.error && (
            <div className="px-3 py-2 font-mono text-[11px] text-[var(--danger)]">
              {tables.error}
            </div>
          )}
          {(tables?.tables ?? []).map((entry) => (
            <button
              key={entry.name}
              onClick={() => open(entry.name)}
              className={`flex w-full items-baseline justify-between gap-2 px-3 py-[5px] text-left font-mono text-[11.5px] hover:bg-white/[0.03] ${
                table === entry.name ? "bg-[#1d2532] text-[#dbe3ef]" : "text-[#9aa6b8]"
              }`}
            >
              <span className="truncate">{entry.name}</span>
              <span className="text-[10px] text-[var(--color-dim)]">
                {entry.rows < 0 ? "?" : entry.rows}
              </span>
            </button>
          ))}
        </aside>

        <section className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]">
          <div className="min-h-0 overflow-auto">
            {page?.error ? (
              <div className="m-3 rounded-md border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] p-3 font-mono text-[11.5px] text-[#ff8a82]">
                {page.error}
              </div>
            ) : page?.columns?.length ? (
              <table className="w-max min-w-full border-collapse font-mono text-[11.5px]">
                <thead className="sticky top-0 bg-[var(--color-bar)]">
                  <tr>
                    {page.columns.map((column, index) => (
                      <th
                        key={column.name}
                        className={`border-b border-[var(--color-line)] bg-[var(--color-bar)] px-2.5 py-1.5 text-left font-normal whitespace-nowrap text-[#cdd6e3] ${
                          index === 0
                            ? "sticky left-0 z-20 border-r border-[var(--color-line)]"
                            : ""
                        }`}
                      >
                        {column.name}
                        <span className="ml-1.5 text-[9.5px] text-[var(--color-faint)]">
                          {column.type}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(page.rows ?? []).map((row, index) => (
                    <tr key={index} className="hover:bg-white/[0.02]">
                      {row.map((cell, cellIndex) => (
                        <td
                          key={cellIndex}
                          className={`max-w-[380px] truncate border-b border-[var(--color-line-soft)] px-2.5 py-[5px] whitespace-nowrap ${
                            cellIndex === 0
                              ? "sticky left-0 z-10 border-r border-[var(--color-line)] bg-[var(--color-bg)]"
                              : ""
                          }`}
                          style={{ color: cell === null ? "var(--color-faint)" : "#9aa6b8" }}
                          title={cell ?? "null"}
                        >
                          {cell === null ? "null" : cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="p-4 font-mono text-[11.5px] text-[var(--color-muted)]">
                {table ? "no rows" : "Pick a table, or run a SELECT."}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2.5 border-t border-[var(--color-line)] bg-[var(--color-bar)] px-3 py-1.5 font-mono text-[10.5px] text-[var(--color-dim)]">
            <span>
              {shown === 0
                ? "no rows"
                : table
                  ? `rows ${(offset + 1).toLocaleString()}-${(offset + shown).toLocaleString()}` +
                    (total >= 0 ? ` of ${total.toLocaleString()}` : "")
                  : `${shown.toLocaleString()} row${shown === 1 ? "" : "s"}`}
              {page?.truncated ? " · truncated at 500" : ""}
            </span>

            <div className="flex-1" />

            {table && (
              <>
                <button
                  onClick={() => setAuto((value) => !value)}
                  title="Re-read this page every 2s. Row counts are not re-run."
                  className={`cursor-pointer rounded border px-2 py-[2px] ${
                    auto
                      ? "border-[color-mix(in_srgb,var(--accent)_35%,transparent)] text-[var(--accent)]"
                      : "border-[var(--color-edge)]"
                  }`}
                >
                  auto
                </button>
                <select
                  value={pageSize}
                  onChange={(event) => resize(Number(event.target.value))}
                  className="cursor-pointer rounded border border-[var(--color-edge)] bg-[var(--color-control)] px-1 py-[2px] text-[var(--color-dim)]"
                >
                  {PAGE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size} / page
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => step(-pageSize)}
                  disabled={offset === 0}
                  className="cursor-pointer rounded border border-[var(--color-edge)] px-2 py-[2px] disabled:opacity-40"
                >
                  prev
                </button>
                <button
                  onClick={() => step(pageSize)}
                  disabled={shown < pageSize}
                  className="cursor-pointer rounded border border-[var(--color-edge)] px-2 py-[2px] disabled:opacity-40"
                >
                  next
                </button>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
