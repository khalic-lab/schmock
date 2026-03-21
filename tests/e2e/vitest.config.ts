import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const ANGULAR_MODULES = resolve(
  __dirname,
  "../../packages/angular/node_modules",
);

/**
 * Vite plugin that resolves @angular/* and rxjs imports from the
 * Angular package's node_modules (they aren't hoisted to the root).
 */
function angularResolver() {
  const require = createRequire(resolve(ANGULAR_MODULES, "_"));
  return {
    name: "angular-resolver",
    resolveId(source: string) {
      if (source.startsWith("@angular/") || source === "rxjs" || source.startsWith("rxjs/")) {
        return { id: require.resolve(source), external: false };
      }
    },
  };
}

export default defineConfig({
  plugins: [angularResolver()],
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
      "@schmock/angular": resolve(__dirname, "../../packages/angular/src"),
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
