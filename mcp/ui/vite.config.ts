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
  // GRA-175: no `test` block here, and no `passWithNoTests` to set — this
  // file has none, so vitest falls back to its own default include glob and
  // its own default `passWithNoTests: false` for `vitest run`. Verified: a
  // glob matching zero files under this project prints "No test files
  // found, exiting with code 1", the same as the server suite. Left
  // unconfigured deliberately, not by omission: adding a `test` block whose
  // author forgets this default would be the easiest way to reintroduce the
  // zero-collection defect GRA-175 audited every runner for.
});
