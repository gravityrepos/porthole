// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * GRA-183: the server test files that build a real loopback rig — a bare
 * `net.Server`, or `testing/harness.ts`'s `FakeDevice`/`buildRig`/
 * `buildRingInState`, or a real `TimelineServer` — and therefore contend
 * with each other for the OS scheduler under vitest's default file-level
 * parallelism. CI-only flakes on windows-latest (never ubuntu; four of the
 * last five 0.2.0 CI runs needed a rerun) traced back to exactly this.
 *
 * `vitest.workspace.ts` (the package root) reads this list to build the
 * "rigs" project, which runs with `fileParallelism: false` so no two of
 * these files are ever mid-handshake at once. `rigFiles.test.ts` (this
 * file's sibling) reads the same constant to prove the list is neither
 * missing a file that has since started opening a socket nor pointing at
 * one that no longer exists — one list, two readers, so they cannot drift
 * the way two independently-maintained copies would.
 *
 * Paths are relative to the `mcp/` package root (where `vitest.workspace.ts`
 * and `vitest.config.ts` live), matching vitest's own `include`/`exclude`
 * glob convention.
 */
export const RIG_FILES = [
  "src/capture.test.ts",
  "src/cli.test.ts",
  "src/device.test.ts",
  "src/devices.test.ts",
  "src/entrypoints.test.ts",
  "src/index.test.ts",
  "src/save.test.ts",
  "src/sessions-integration.test.ts",
  "src/setup.test.ts",
  "src/surface.test.ts",
  "src/timeline.test.ts",
  "src/watch.test.ts",
  "src/watermark.test.ts",
] as const;
