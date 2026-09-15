import { defineWorkspace } from "vitest/config";
import { RIG_FILES } from "./src/testing/rigFiles.js";

// GRA-183: CI-only flakes (never ubuntu; four of the last five 0.2.0 CI runs
// needed a rerun, and it reproduced once on the founder's own Windows
// laptop) all shared one shape - a test file that opens a real loopback
// socket (testing/harness.ts's FakeDevice, a bare net.Server, or a real
// TimelineServer) racing another such file for the OS scheduler under
// vitest's default file-level parallelism. `retry: 2` (GRA-53) already
// absorbs a genuine environment stall; what it cannot absorb is a *differing
// assertion* on the first CI instance of this ticket, which is the signal a
// scheduling race rather than a timeout was in play.
//
// The fix is runner configuration, not the tests: split the suite into two
// vitest projects (see the second comment below for why they do not
// `extends` vitest.config.ts). `rigs` is exactly the files RIG_FILES names —
// see `src/testing/rigFiles.ts` for what "opens a real loopback rig" means
// and why `src/testing/rigFiles.test.ts` exists: a list kept in sync by hand
// fails exactly when someone adds a new socket-rig file and forgets to add
// it here, so that test scans mcp/src for the same signal this comment
// describes and fails if a rig file is un-listed or a listed file no longer
// exists. entrypoints.test.ts is in RIG_FILES even though its own comment
// says it never starts a socket in *its* usage of TimelineServer - it still
// imports the class directly, which is the same signal a future file that
// really does start one would give, and the guard test treats that import as
// sufficient reason to serialise it rather than trying to tell "imports it"
// apart from "starts it" by reading intent instead of code.
// fileParallelism: false serialises RIG_FILES' files against each other;
// `unit` is everything else and stays exactly as parallel as before.
//
// Measured, not assumed: `extends: "./vitest.config.ts"` plus a project's own
// narrower `test.include` does NOT replace the extended config's include
// glob - vitest unions the two arrays. With `extends` in place here, the
// "rigs" project's include ended up as vitest.config.ts's
// ["src/**/*.test.ts"] union RIG_FILES, which reduces to
// ["src/**/*.test.ts"] since that glob already matches everything - so
// "rigs" silently ran every test file instead of only the ones RIG_FILES
// names. `exclude` happened to work correctly under `extends` only because
// vitest.config.ts sets no `exclude` of its own for it to union against.
// Both projects below are therefore self-contained rather than
// `extends`-ing vitest.config.ts: vitest.config.ts has nothing else worth
// sharing today (just the one include glob, reproduced here in "unit"), and
// self-contained include arrays are the only shape that is not silently
// widened by a later change to vitest.config.ts's own include.
export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["src/**/*.test.ts"],
      exclude: [...RIG_FILES],
    },
  },
  {
    test: {
      name: "rigs",
      include: [...RIG_FILES],
      fileParallelism: false,
    },
  },
]);
