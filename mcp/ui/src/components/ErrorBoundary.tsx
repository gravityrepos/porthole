// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
}

/**
 * A render error used to blank the page, which is a bad failure for a debugger:
 * the trace is still on the server, and the thing you were looking at when it
 * broke is exactly what someone needs in order to fix it.
 *
 * So this says what broke, keeps it copyable, and points at the snapshot the
 * data is still sitting in.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: info.componentStack ?? "" });
    console.error("porthole ui crashed", error, info.componentStack);
  }

  private report(): string {
    const { error, stack } = this.state;
    return [`${error?.name}: ${error?.message}`, error?.stack, stack].filter(Boolean).join("\n\n");
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid h-full place-items-center overflow-auto bg-[var(--color-bg)] p-6">
        <div className="w-full max-w-[620px]">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-[2px] bg-[var(--danger)]" />
            <span className="font-mono text-[10px] tracking-[0.12em] text-[var(--color-dim)]">
              PORTHOLE UI
            </span>
          </div>

          <h1 className="mt-2 text-base font-semibold text-[#f0f4fa]">The timeline view crashed</h1>
          <p className="mt-1.5 text-[12.5px] leading-[1.6] text-[#9aa6b8]">
            The recording itself is unaffected — it lives in the server, not this page. Reloading
            reconnects and redraws it. If it crashes again, the report below is the useful part.
          </p>

          <pre className="mt-3 max-h-[40vh] overflow-auto rounded-lg border border-[#242c3a] bg-[var(--color-tile)] p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[#ff8a82] [overflow-wrap:anywhere]">
            {this.report()}
          </pre>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => location.reload()}
              className="cursor-pointer rounded-md bg-[var(--accent)] px-3 py-1.5 font-mono text-[11px] text-[#0f1620] hover:brightness-110"
            >
              reload
            </button>
            <button
              onClick={() => void navigator.clipboard.writeText(this.report()).catch(() => {})}
              className="cursor-pointer rounded-md border border-[var(--color-edge)] bg-[var(--color-control)] px-3 py-1.5 font-mono text-[11px] text-[var(--color-muted)] hover:text-[#dbe3ef]"
            >
              copy report
            </button>
            <a
              href="/api/events"
              className="rounded-md border border-[var(--color-edge)] bg-[var(--color-control)] px-3 py-1.5 font-mono text-[11px] text-[var(--color-muted)] hover:text-[#dbe3ef]"
            >
              open raw capture
            </a>
          </div>
        </div>
      </div>
    );
  }
}
