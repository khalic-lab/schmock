import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const distFile = (name: string) => resolve(__dirname, "..", "dist", name);
const read = (name: string) => readFileSync(distFile(name), "utf8");
// Only an unbuilt package skips: once dist/index.js exists, the worker and
// the bin are asserted, so a build that stops emitting them fails here.
const hasIndex = existsSync(distFile("index.js"));
const hasTypes = existsSync(distFile("index.d.ts"));

// Static ESM imports from node: modules; dynamic imports have no `from`.
function staticNodeImports(source: string): string[] {
  return source.match(/from\s*["']node:[^"']+["']/g) ?? [];
}

const RELATIVE_SPECIFIER =
  /(?:from\s*|import\(\s*)["'](\.{1,2}\/[^"']+)\.js["']/g;

/** Every declaration file a consumer compiles from dist/index.d.ts, by path under dist/. */
function reachableDeclarations(): Map<string, string> {
  const reached = new Map<string, string>();
  const pending = ["index.d.ts"];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name)) continue;
    const source = read(name);
    reached.set(name, source);
    for (const [, specifier] of source.matchAll(RELATIVE_SPECIFIER)) {
      pending.push(
        posix.normalize(posix.join(posix.dirname(name), `${specifier}.d.ts`)),
      );
    }
  }
  return reached;
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

  // `init` copies this file; nothing else in the release gate looks for it.
  it.skipIf(!hasIndex)(
    "dist/schmock-sw.js ships beside dist/index.js as a classic script with no module syntax",
    () => {
      expect(existsSync(distFile("schmock-sw.js"))).toBe(true);
      const source = read("schmock-sw.js");
      expect(source).not.toMatch(/^\s*(import|export)\b/m);
      expect(source).not.toContain("@schmock");
    },
  );

  // Transferable exists only in the DOM and webworker libs, so a consumer
  // compiling without them (skipLibCheck off) would fail on it.
  it.skipIf(!hasTypes)(
    "the declarations dist/index.d.ts reaches name no Transferable",
    () => {
      const reached = reachableDeclarations();
      expect([...reached.keys()]).toContain("types.d.ts");
      const naming = [...reached]
        .filter(([, source]) => /\bTransferable\b/.test(source))
        .map(([name]) => name);
      expect(naming).toEqual([]);
    },
  );

  it.skipIf(!hasIndex)(
    "dist/bin.js ships beside dist/index.js and starts with a node shebang",
    () => {
      expect(existsSync(distFile("bin.js"))).toBe(true);
      expect(read("bin.js").startsWith("#!/usr/bin/env node")).toBe(true);
    },
  );
});
