import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const distFile = (name: string) => resolve(__dirname, "..", "dist", name);
const read = (name: string) => readFileSync(distFile(name), "utf8");
const hasIndex = existsSync(distFile("index.js"));

// Static ESM imports from node: modules; dynamic imports have no `from`.
function staticNodeImports(source: string): string[] {
  return source.match(/from\s*["']node:[^"']+["']/g) ?? [];
}

describe("dist shape", () => {
  it.skipIf(!hasIndex)("dist/index.js has no static node:* imports", () => {
    expect(staticNodeImports(read("index.js"))).toEqual([]);
  });

  it.skipIf(!hasIndex)(
    "dist/index.js imports @schmock/core as a bare external",
    () => {
      expect(read("index.js")).toMatch(/from\s*["']@schmock\/core["']/);
    },
  );

  it.skipIf(!hasIndex)("dist/index.js carries no copy of core", () => {
    expect(read("index.js")).not.toContain("schmock.fetch.passthrough");
  });
});
