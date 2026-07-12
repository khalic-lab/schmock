import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    cache: false,
    globals: true,
    environment: "node",
    include: ["**/scripts/__tests__/**/*.test.ts"],
    testTimeout: 15000,
  },
});
