import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@schmock/core": resolve(__dirname, "../../packages/core/src"),
      "@schmock/faker": resolve(__dirname, "../../packages/faker/src"),
      "@schmock/express": resolve(__dirname, "../../packages/express/src"),
      "@schmock/validation": resolve(
        __dirname,
        "../../packages/validation/src",
      ),
      "@schmock/query": resolve(__dirname, "../../packages/query/src"),
      "@schmock/openapi": resolve(__dirname, "../../packages/openapi/src"),
      "@schmock/cli": resolve(__dirname, "../../packages/cli/src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    root: __dirname,
    include: ["**/*.test.ts"],
    testTimeout: 30_000,
  },
});
