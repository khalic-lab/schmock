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
    globals: true,
    environment: "node",
    include: ["src/**/*.steps.ts"],
    reporters: [["default", { summary: false }]],
  },
});
