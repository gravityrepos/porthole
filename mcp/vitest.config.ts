import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The workspace's own UI package has its own suite; this one is the server.
    include: ["src/**/*.test.ts"],
    // GRA-175: deliberately NOT set. `passWithNoTests` defaults to false for
    // `vitest run` (verified: pointing this suite at a glob matching zero
    // files prints "No test files found, exiting with code 1"), which is
    // what CI and `npm test` need — a renamed test file, a mistyped
    // `include`, or an empty `src/` should fail the build, not pass it
    // silently. Setting this to true would be the exact zero-collection
    // defect GRA-175 audited every runner for.
  },
});
