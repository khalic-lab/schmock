import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.steps.ts"],
    reporters: [
      ['default', { summary: false }]
    ]
  },
});
