// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A controllable stand-in for `trace_processor_shell`, for tests that need
 * `askTrace` (perfetto.ts) to run against a real, spawnable binary rather
 * than the injectable `RunFn` `runBatch` itself takes — `askTrace` hardcodes
 * the real `runScript`, so nothing lower than "an actual process this
 * project's own `spawn` call can run" reaches it. Built on the same idiom as
 * `fakeAdb.ts`'s `buildFakeAdb`: every response comes from an environment
 * variable, not a fixed dispatcher, so a test only has to say what a
 * question should answer, not extend a shared if/else chain.
 *
 * Ignores its own argv entirely (`query -f - <trace>`, per `askTrace`'s real
 * invocation) — everything it needs is the SQL script on stdin, which is
 * where the marker protocol `perfetto.ts`'s `buildScript`/`matchBatch` speak
 * lives. A question this fixture's `plan` does not mention answers `[]`
 * rows, the same "no rows" a real, quiet trace would report.
 */

export interface FakeTraceProcessorSpec {
  rows?: Array<Record<string, string | number | null>>;
  /** When set, this question's own marker prints but no data follows — the same shape a query that fails to compile leaves in trace_processor's real stdout. */
  fail?: string;
}

export interface FakeTraceProcessor {
  /** Pass as `traceProcessor`/`PORTHOLE_TRACE_PROCESSOR`, or as `options.findTraceProcessor` in capture.ts. */
  binaryPath: string;
  cleanup(): void;
}

const FAKE_TRACE_PROCESSOR_SOURCE = `
let sql = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { sql += chunk; });
process.stdin.on("end", () => {
  const plan = JSON.parse(process.env.PORTHOLE_TEST_FAKE_TP_PLAN || "{}");
  const markers = [...sql.matchAll(/SELECT 'porthole:([0-9a-f]{16}):([\\w.]+)' AS marker;/g)];
  let stdout = "";
  for (const [, nonce, id] of markers) {
    stdout += '"marker"\\n"porthole:' + nonce + ":" + id + '"\\n\\n';
    const spec = plan[id] || { rows: [] };
    if (spec.fail) {
      process.stdout.write(stdout);
      process.stderr.write(spec.fail);
      process.exit(1);
    }
    const rows = spec.rows || [];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : ["value"];
    stdout += columns.map((c) => '"' + c + '"').join(",") + "\\n";
    for (const row of rows) {
      stdout += columns.map((c) => (row[c] === null ? '"[NULL]"' : '"' + row[c] + '"')).join(",") + "\\n";
    }
    stdout += "\\n";
  }
  process.stdout.write(stdout);
  process.exit(0);
});
`;

export function buildFakeTraceProcessor(plan: Record<string, FakeTraceProcessorSpec>): FakeTraceProcessor {
  const root = mkdtempSync(path.join(tmpdir(), "porthole-faketp-"));
  const scriptPath = path.join(root, "fake-trace-processor.cjs");
  writeFileSync(scriptPath, FAKE_TRACE_PROCESSOR_SOURCE);

  const isWindows = process.platform === "win32";
  const binaryPath = path.join(root, isWindows ? "trace_processor_shell.cmd" : "trace_processor_shell");
  if (isWindows) {
    writeFileSync(binaryPath, `@"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    writeFileSync(binaryPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
    chmodSync(binaryPath, 0o755);
  }

  process.env.PORTHOLE_TEST_FAKE_TP_PLAN = JSON.stringify(plan);

  return {
    binaryPath,
    cleanup() {
      delete process.env.PORTHOLE_TEST_FAKE_TP_PLAN;
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
