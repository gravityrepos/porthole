import { defineWorkspace } from "vitest/config";

// GRA-183: CI-only flakes (never ubuntu; four of the last five 0.2.0 CI runs
// needed a rerun, and it reproduced once on the founder's own Windows
// laptop) all shared one shape - a test file that opens a real loopback
// socket (testing/harness.ts's FakeDevice, a bare net.Server, or a spawned
// subprocess talking stdio) racing another such file for the OS scheduler
// under vitest's default file-level parallelism. `retry: 2` (GRA-53) already
// absorbs a genuine environment stall; what it cannot absorb is a *differing
// assertion* on the first CI instance of this ticket, which is the signal a
// scheduling race rather than a timeout was in play.
//
// The fix is runner configuration, not the tests: split the suite into two
// vitest projects (see the second comment below for why they do not
// `extends` vitest.config.ts). `rigs` is exactly the files that build a
// real loopback rig
// (confirmed by reading each one for FakeDevice.start/TimelineServer/
// net.createServer - see the ticket for the file-by-file check, and note
// entrypoints.test.ts was deliberately left out of this list: it spawns
// subprocesses over stdio, not a loopback socket, so it is not the resource
// this ticket's flakes contended over). fileParallelism: false serialises
// just those files against each other; `unit` is everything else and stays
// exactly as parallel as before.
const RIG_FILES = [
  "src/capture.test.ts",
  "src/cli.test.ts",
  "src/device.test.ts",
  "src/index.test.ts",
  "src/save.test.ts",
  "src/sessions-integration.test.ts",
  "src/surface.test.ts",
  "src/timeline.test.ts",
  "src/watermark.test.ts",
];

// Measured, not assumed: `extends: "./vitest.config.ts"` plus a project's own
// narrower `test.include` does NOT replace the extended config's include
// glob - vitest unions the two arrays. With `extends` in place here, the
// "rigs" project's include ended up as vitest.config.ts's
// ["src/**/*.test.ts"] union RIG_FILES, which reduces to
// ["src/**/*.test.ts"] since that glob already matches everything - so
// "rigs" silently ran every test file (entrypoints.test.ts included, which
// is deliberately NOT in RIG_FILES) instead of only the nine. `exclude`
// happened to work correctly under `extends` only because vitest.config.ts
// sets no `exclude` of its own for it to union against. Both projects below
// are therefore self-contained rather than `extends`-ing vitest.config.ts:
// vitest.config.ts has nothing else worth sharing today (just the one
// include glob, reproduced here in "unit"), and self-contained include
// arrays are the only shape that is not silently widened by a later change
// to vitest.config.ts's own include.
export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["src/**/*.test.ts"],
      exclude: RIG_FILES,
    },
  },
  {
    test: {
      name: "rigs",
      include: RIG_FILES,
      fileParallelism: false,
    },
  },
]);
