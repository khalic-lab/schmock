import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression coverage for issue #395 — bun's `--target node` injected an
 * unused `createRequire` shim (`import { createRequire } from "node:module"`)
 * into the published bundle, breaking browser bundlers even though Angular
 * itself only runs in browsers.
 */
const distRoot = resolve(__dirname, "..", "dist");

// Static ESM imports from node: modules — `from "node:..."`. Dynamic imports
// (`await import("node:...")`) have no `from` clause and are not matched.
function staticNodeImports(src: string): string[] {
  return src.match(/from\s*["']node:[^"']+["']/g) ?? [];
}

describe.skipIf(!existsSync(distRoot))(
  "dist shape — browser compatibility (#395)",
  () => {
    it("dist/index.js has no static node:* imports", () => {
      const src = readFileSync(resolve(distRoot, "index.js"), "utf8");
      expect(staticNodeImports(src)).toEqual([]);
    });
  },
);
