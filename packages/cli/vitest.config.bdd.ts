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
    // vitest-cucumber runs each step as its own test, and Vitest 5 clears mock
    // history before every test by default. Keep it across a scenario's steps.
    clearMocks: false,
    include: ["src/**/*.steps.ts"],
    testTimeout: 30_000,
    reporters: [["default", { summary: false }]],
  },
});
