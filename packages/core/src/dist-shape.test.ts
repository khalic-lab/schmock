import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression coverage for issue #395 — a top-level `import { createServer }
 * from "node:http"` in `dist/builder.js` was preserved by browser bundlers
 * (esbuild / Angular / Vite) even when `.listen()` was never called, causing
 * `node:http` resolution failures in browsers.
 *
 * Inspect published artifacts: top-level `node:http` imports must not exist.
 * `node:http` may only appear inside dynamic imports (`await import(...)`).
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
    it("dist/builder.js has no static node:* imports", () => {
      const src = readFileSync(resolve(distRoot, "builder.js"), "utf8");
      expect(staticNodeImports(src)).toEqual([]);
    });

    it("dist/index.js has no static node:* imports", () => {
      const src = readFileSync(resolve(distRoot, "index.js"), "utf8");
      expect(staticNodeImports(src)).toEqual([]);
    });
  },
);
