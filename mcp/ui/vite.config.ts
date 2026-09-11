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
});
