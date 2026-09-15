// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom -- see App.render.test.tsx's top comment for
// why happy-dom over jsdom, and why it is opted into per-file rather than as
// the package default.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { InsightsPanel } from "./InsightsPanel";
import type { FindingsPayload } from "../types";

/**
 * GRA-173: the founder reported the right pane "flashing over and over"
 * before the cart was ever opened. The mechanism, confirmed rather than
 * assumed: the empty-state paragraph used to be gated on `payload &&
 * findings.length === 0 && !loading`, and `loading` flips true at the start
 * of *every* fetch -- including the ones `following` mode fires every
 * `DEBOUNCE_MS` with no user action at all. So once a window with zero
 * findings had rendered the paragraph once, the very next debounce cycle
 * flipped `loading` true and unmounted it, then flipped it back false and
 * remounted it, forever, for as long as the window kept moving and stayed
 * empty of findings.
 *
 * GRA-114 hoisted the fetch itself out of this component and into `App` --
 * `InsightsPanel` now takes `payload`/`loading` as plain props instead of
 * owning a `FindingsLoader`. That makes this regression simpler to prove,
 * not different in kind: drive the same prop transition (`payload` present
 * and non-empty-capable, `loading` flips true, `payload` unchanged) directly
 * with `rerender`, with no fake timers or fetch stand-in needed, and check
 * the paragraph is the exact same DOM node across the transition -- not
 * merely present again after a fresh mount, which `getByText` alone cannot
 * tell apart from "was unmounted and remounted in between."
 */

const emptyPayload: FindingsPayload = {
  window: { from: 0, to: 1000, ms: 1000 },
  eventsExamined: 0,
  findings: [],
  notes: [],
};

function renderPanel(props: Partial<Parameters<typeof InsightsPanel>[0]> = {}) {
  return render(
    <InsightsPanel
      payload={null}
      loading={false}
      error={null}
      onRefresh={vi.fn()}
      traces={[]}
      selectedTraceId={null}
      onSelectTrace={vi.fn()}
      {...props}
    />,
  );
}

afterEach(cleanup);

describe("InsightsPanel's empty state across a refresh (GRA-173)", () => {
  it("is not unmounted while a refresh that has not landed yet is in flight", () => {
    const { rerender } = renderPanel({ payload: emptyPayload, loading: false });
    const beforeRefresh = screen.getByText(/Nothing crossed a threshold/i);

    // Exactly what `following` mode does every `DEBOUNCE_MS` while nobody
    // has touched the cart: a new request starts (`loading` flips true)
    // before its response has replaced `payload`.
    rerender(
      <InsightsPanel
        payload={emptyPayload}
        loading={true}
        error={null}
        onRefresh={vi.fn()}
        traces={[]}
        selectedTraceId={null}
        onSelectTrace={vi.fn()}
      />,
    );
    const duringRefresh = screen.getByText(/Nothing crossed a threshold/i);
    expect(duringRefresh).toBe(beforeRefresh);

    // And once the (identical) response lands, still the same node.
    rerender(
      <InsightsPanel
        payload={emptyPayload}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
        traces={[]}
        selectedTraceId={null}
        onSelectTrace={vi.fn()}
      />,
    );
    expect(screen.getByText(/Nothing crossed a threshold/i)).toBe(beforeRefresh);
  });

  it("shows nothing before the first payload has ever landed, not the empty-state paragraph", () => {
    renderPanel({ payload: null, loading: true });
    expect(screen.queryByText(/Nothing crossed a threshold/i)).toBeNull();
  });
});

describe("InsightsPanel's trace chooser (GRA-114 ruling 4)", () => {
  it("lists a capture by its recorded time and lets it be chosen", () => {
    const onSelectTrace = vi.fn();
    renderPanel({
      traces: [
        { id: "cap-1", bytes: 100, recordedAt: "2026-09-15T10:00:00.000Z", coverage: { from: 0, to: 1000 } },
      ],
      onSelectTrace,
    });

    const select = screen.getByRole("combobox", { name: /trace capture/i }) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["", "cap-1"]);
    expect(select.options[1].disabled).toBe(false);
  });

  it("disables a capture whose coverage is null and cannot be chosen", () => {
    renderPanel({
      traces: [
        {
          id: "cap-broken",
          bytes: 10,
          recordedAt: "2026-09-15T10:00:00.000Z",
          coverage: null,
          reason: "trace_processor_shell was not found",
        },
      ],
    });

    const select = screen.getByRole("combobox", { name: /trace capture/i }) as HTMLSelectElement;
    expect(select.options[1].disabled).toBe(true);
    expect(select.options[1].title).toMatch(/trace_processor_shell/);
  });
});
