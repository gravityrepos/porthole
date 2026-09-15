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

    // GRA-190: coverage.exclude, not coverage.include — the provider's own
    // default `all: true` walks the whole project directory looking for
    // source-shaped files, and this project's directory is `mcp/`, not just
    // `mcp/src/`. Measured without this block: v8 coverage for a run of only
    // `src/**/*.test.ts` still reported zero-coverage entries for every file
    // under `mcp/ui/src/**`, because that directory sits inside the same
    // project root and nothing told the provider it belongs to a different
    // suite entirely (mcp/ui has its own vitest run and its own `ui` flag —
    // see mcp/ui/vite.config.ts). `ui/**` is therefore excluded wholesale
    // here, not just `ui/dist/**`: the built output was never the only thing
    // leaking in, the source was too. `src/testing/**` is test harness code
    // (FakeDevice, the rig-file list, the comment-stripping engine the
    // guard tests share) exercised only indirectly, through the tests it
    // supports, so counting it as "server" coverage would credit test
    // infrastructure with the coverage its own tests are meant to measure.
    coverage: {
      // "**/*.test.ts" rather than "src/**/*.test.ts": scripts/ has its own
      // node:test file (check-readme-vitest-counts.test.mjs) that is not a
      // vitest test at all — see that file's own header for why it is kept
      // off vitest's include globs — but v8's `all: true` default still
      // finds it, and it showed up as a covered "source" file the first
      // time this ran without an exclude for `.mjs` test files too.
      exclude: ["**/*.test.ts", "**/*.test.mjs", "src/testing/**", "dist/**", "ui/**"],
    },
  },
});
