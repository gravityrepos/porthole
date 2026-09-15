// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./stripComments.js";
import { RIG_FILES } from "./rigFiles.js";

/**
 * GRA-183 follow-up: `vitest.workspace.ts`'s "rigs" project (fileParallelism:
 * false) exists to stop loopback-socket test files from contending with each
 * other under vitest's default parallelism, which is what produced CI-only
 * flakes on windows-latest. `RIG_FILES` (src/testing/rigFiles.ts) is the one
 * list both that config and this test read. A list kept in sync by hand
 * fails exactly when someone adds a new socket-rig file and forgets to add
 * it here — it would silently land in the parallel "unit" project instead.
 * Two checks close that gap:
 *
 *  1. every entry in RIG_FILES names a file that still exists (catches a
 *     typo or a rename left behind);
 *  2. every `*.test.ts` under `mcp/src` that opens a real socket is itself
 *     in RIG_FILES (catches a forgotten addition).
 *
 * "Opens a socket" is read off comment-stripped source text, the same
 * technique `device.test.ts`'s PROTOCOL_VERSION scan and `surface.test.ts`'s
 * ConnectionState guard use (`stripComments()`, `testing/stripComments.ts`) —
 * a comment mentioning "FakeDevice" must not count as evidence the file
 * imports it.
 *
 * The signal is deliberately broader than "imports FakeDevice or
 * TimelineServer by name". Most current rig files (index.test.ts,
 * surface.test.ts, capture.test.ts, watermark.test.ts) never reference those
 * class names directly — they call `testing/harness.ts`'s `buildRig()` or
 * `buildRingInState()`, which construct both internally. A check that only
 * matched the two literal class names would pass today (every current rig
 * file also happens to satisfy it, see SOCKET_MODULES below) and would say
 * nothing about the next `buildRig()`-only file, which is the common case
 * going forward. A raw `import net from "node:net"` — device.test.ts's own
 * hand-rolled fake device — is the other route in.
 */

const testingDir = fileURLToPath(new URL(".", import.meta.url));
const mcpRoot = fileURLToPath(new URL("../..", import.meta.url));
const srcDir = path.join(mcpRoot, "src");

/**
 * Reading one of these names off an import from the given module is what
 * "opens a real socket" means for this guard. `"*"` stands for "any import
 * from this module at all" — every named export of `node:net` implies a raw
 * socket, so there is no narrower list worth maintaining for it.
 */
const SOCKET_MODULES: ReadonlyArray<{ module: string; names: readonly string[] }> = [
  { module: "./testing/harness.js", names: ["FakeDevice", "buildRig", "buildRingInState"] },
  { module: "./timeline.js", names: ["TimelineServer"] },
  { module: "node:net", names: ["*"] },
];

/**
 * Every name an `import ... from "<module>"` statement binds, for the one
 * `module` given — covers this codebase's actual import shapes: a bare
 * default (`import net from "node:net"`), a named/braced clause possibly
 * spanning multiple lines (index.test.ts's own harness import does), a
 * `type` modifier on an individual specifier, and an `as` rename. Resolved
 * against comment-stripped source, so a mention inside a comment or a string
 * cannot masquerade as an import.
 */
function importedNamesFrom(strippedSource: string, module: string): string[] {
  const escapedModule = module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`import\\s+([^;]*?)\\s+from\\s+["']${escapedModule}["']`, "g");
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(strippedSource))) {
    const clause = match[1];
    const braced = clause.match(/\{([^}]*)\}/);
    if (braced) {
      for (const part of braced[1].split(",")) {
        const name = part
          .trim()
          .split(/\s+as\s+/)[0]
          .replace(/^type\s+/, "")
          .trim();
        if (name) names.push(name);
      }
    }
    const withoutBraces = clause.replace(/\{[^}]*\}/, "").trim();
    const defaultName = withoutBraces.split(",")[0]?.trim().replace(/,$/, "");
    if (defaultName) names.push(defaultName);
  }
  return names;
}

/** True if `source` (raw, not yet stripped) imports any socket-opening symbol. */
function opensASocket(source: string): boolean {
  const stripped = stripComments(source);
  for (const { module, names } of SOCKET_MODULES) {
    const imported = importedNamesFrom(stripped, module);
    if (imported.length === 0) continue;
    if (names.includes("*")) return true;
    if (imported.some((name) => names.includes(name))) return true;
  }
  return false;
}

/** Every `*.test.ts` under `dir`, recursively — mirrors vitest's own `src/**\/*.test.ts` include glob. */
function collectTestFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      found.push(full);
    }
  }
  return found;
}

/** `path.relative` normalised to forward slashes, matching RIG_FILES' own "src/..." spelling on every OS. */
function relativeToMcpRoot(absPath: string): string {
  return path.relative(mcpRoot, absPath).split(path.sep).join("/");
}

describe("GRA-183: RIG_FILES stays in sync with the test files that actually open a socket", () => {
  it("every RIG_FILES entry names a file that exists", () => {
    const missing = RIG_FILES.filter((rel) => !existsSync(path.join(mcpRoot, rel)));
    expect(missing, "RIG_FILES entries with no file on disk (typo, or a rename left behind)").toEqual([]);
  });

  it("every *.test.ts under mcp/src that opens a socket is listed in RIG_FILES", () => {
    const listed = new Set<string>(RIG_FILES);
    const unlisted = collectTestFiles(srcDir)
      .filter((abs) => opensASocket(readFileSync(abs, "utf8")))
      .map(relativeToMcpRoot)
      .filter((rel) => !listed.has(rel));

    expect(
      unlisted,
      "these files open a real socket but are missing from RIG_FILES — add them so vitest.workspace.ts serialises them too",
    ).toEqual([]);
  });

  // Sanity control, the same shape surface.test.ts's own guards use: a test
  // that only ever asserts an empty array is vacuously true if the scan
  // above silently found nothing to scan at all (an empty srcDir, or
  // collectTestFiles never actually walking into src/). This fails loudly if
  // that ever happens, rather than the two tests above passing for the wrong
  // reason.
  it("the scan actually found this package's test files (positive control)", () => {
    expect(testingDir.startsWith(srcDir), "this file's own directory should be under srcDir").toBe(true);
    const found = collectTestFiles(srcDir);
    expect(found.length).toBeGreaterThan(15);
    expect(found.some((f) => f.endsWith("rigFiles.test.ts"))).toBe(true);
  });
});
