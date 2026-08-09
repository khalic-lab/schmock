import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@schmock/core": resolve(__dirname, "../core/src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
  },
});
