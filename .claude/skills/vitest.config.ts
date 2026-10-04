import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Rooted here, so a run from the repo root never collects the copies under
  // .claude/worktrees.
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    globals: true,
    environment: "node",
    include: ["**/scripts/__tests__/**/*.test.ts"],
    testTimeout: 15000,
  },
});
