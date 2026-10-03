import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Test sibling packages from source, not whatever dist/ was last built.
  // The string alias also serves @schmock/core/adapter, so tests and steps
  // share one interceptor module (one activeSession).
  resolve: {
    alias: {
      "@schmock/core": resolve(__dirname, "../core/src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.steps.ts"],
  },
});
