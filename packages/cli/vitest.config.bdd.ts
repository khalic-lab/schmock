import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@schmock/core": resolve(__dirname, "../core/src"),
      "@schmock/openapi": resolve(__dirname, "../openapi/src"),
    },
  },
  test: {
    include: ["src/**/*.steps.ts"],
    testTimeout: 30_000,
    reporters: [["default", { summary: false }]],
  },
});
