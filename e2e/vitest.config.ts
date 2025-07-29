import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 120000, // 2 minutes for E2E tests
    hookTimeout: 60000,  // 1 minute for setup/teardown
    include: ["tests/**/*.e2e.test.ts"],
    // Run E2E tests sequentially to avoid port conflicts
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true
      }
    }
  },
});