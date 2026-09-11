import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The workspace's own UI package has its own suite; this one is the server.
    include: ["src/**/*.test.ts"],
  },
});
