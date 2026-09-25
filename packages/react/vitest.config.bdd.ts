import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Test sibling packages from source, not whatever dist/ was last built.
  resolve: {
    alias: {
      "@schmock/core": resolve(__dirname, "../core/src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.steps.{ts,tsx}"],
    testTimeout: 30_000,
    reporters: [["default", { summary: false }]],
  },
});
