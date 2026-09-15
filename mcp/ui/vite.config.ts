// GRA-190: plain Vite's `UserConfig` type has no `test` property, so adding
// a `test` block under vite's own `defineConfig` fails `tsc -b` with
// "Object literal may only specify known properties, and 'test' does not
// exist" — even though `vite build` alone doesn't care, which is exactly
// why this file's own project convention is to check the real `npm run
// build` (`tsc -b && vite build`), not just a type-check (see README.md's
// CI section). Two more-obvious fixes were tried and measured to fail
// worse: switching this file's `defineConfig` import to "vitest/config"
// (vitest's own recommended pattern) fails differently, because
// vitest@2.1.9 carries its own nested vite@5.4.21
// (`vitest/node_modules/vite`, confirmed with `npm ls vite`) — binding
// `plugins: [react(), tailwindcss()]`, typed against this project's own
// vite@6.4.3, to vite@5's structurally different `Plugin` type; and a bare
// `/// <reference types="vitest/config" />` doesn't merge either, because
// vitest's own `declare module "vite" { interface UserConfig { test } }`
// (in `vitest/dist/chunks/vite.*.d.ts`) resolves "vite" from *its* nested
// copy too, so the augmentation lands on a different module instance than
// the one this file's own `import ... from "vite"` resolves to — two
// same-named but distinct types, as far as the checker is concerned. Fixing
// the duplicate vite install itself would mean an `overrides` entry in
// mcp/package.json, outside this ticket's `Owns` (dev dependency and
// scripts only). This local, minimal augmentation sidesteps all of that: it
// declares `test` directly on whichever "vite" module *this file* resolves
// (unambiguous, since there is only one such resolution here), typed just
// narrowly enough for what this file actually sets.
declare module "vite" {
  interface UserConfig {
    test?: {
      coverage?: {
        exclude?: string[];
      };
    };
  }
}

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The built app is served by the Porthole timeline server, not by a CDN, so it
// goes out as relative paths into ui/dist and gets shipped in the npm package.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5273,
    // `npm run dev` gives hot reload against a live device: the timeline server
    // still owns the socket to the app, and Vite proxies through to it.
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8678", ws: true },
      "/api": { target: "http://127.0.0.1:8678" },
    },
  },
  // GRA-175: no `include`/`passWithNoTests` set in the `test` block below —
  // vitest still falls back to its own default include glob and its own
  // default `passWithNoTests: false` for `vitest run`. Verified: a glob
  // matching zero files under this project prints "No test files found,
  // exiting with code 1", the same as the server suite. Left unconfigured
  // deliberately, not by omission: adding an `include` whose author forgets
  // this default would be the easiest way to reintroduce the zero-collection
  // defect GRA-175 audited every runner for.
  test: {
    coverage: {
      // GRA-190: v8's `all: true` default walks this project's own
      // directory (mcp/ui), so its build output would otherwise show up as
      // untested "source" the moment `npm run build` has been run once
      // locally. Test files are already excluded by the provider's own
      // default; named here anyway so the intent reads the same as the
      // server's vitest.config.ts rather than depending on a default this
      // file doesn't otherwise rely on.
      exclude: ["**/*.test.ts", "**/*.test.tsx", "dist/**"],
    },
  },
});
