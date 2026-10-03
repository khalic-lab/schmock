import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const distFile = (name: string) => resolve(__dirname, "..", "dist", name);
const read = (name: string) => readFileSync(distFile(name), "utf8");
const hasIndex = existsSync(distFile("index.js"));
const hasWorker = existsSync(distFile("schmock-sw.js"));
const hasBin = existsSync(distFile("bin.js"));

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

  // An inlined copy of the interceptor would hold its own session and relay
  // nothing the app's mocks registered.
  it.skipIf(!hasIndex)(
    "dist/index.js imports @schmock/core/adapter as an external",
    () => {
      expect(read("index.js")).toMatch(
        /from\s*["']@schmock\/core\/adapter["']/,
      );
    },
  );

  it.skipIf(!hasWorker)(
    "dist/schmock-sw.js is a classic script with no module syntax",
    () => {
      const source = read("schmock-sw.js");
      expect(source).not.toMatch(/^\s*(import|export)\b/m);
      expect(source).not.toContain("@schmock");
    },
  );

  it.skipIf(!hasBin)("dist/bin.js starts with a node shebang", () => {
    expect(read("bin.js").startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
