import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The debug log categories documented in docs/debug-mode.md.
 *
 * Categories are plain strings at the `DebugLogger.log()` call sites, so
 * nothing but this test stops a new one from appearing (or an old one from
 * disappearing) without the reference table following it. Adding a category is
 * fine — update this list and the table in the same change.
 */
const DOCUMENTED_CATEGORIES = [
  "config",
  "error",
  "event",
  "lifecycle",
  "pipeline",
  "plugin",
  "request",
  "response",
  "route",
  "server",
  "warning",
] as const;

function emittedCategories(): string[] {
  const found = new Set<string>();
  // Scan this directory only. It is the whole of core's source and contains no
  // node_modules, so a new emitter module is covered automatically without the
  // glob picking up the copies of core vendored under every other package.
  const sources = readdirSync(import.meta.dirname).filter(
    (file) =>
      file.endsWith(".ts") &&
      !file.includes(".test.") &&
      !file.endsWith(".steps.ts"),
  );
  for (const file of sources) {
    const source = readFileSync(join(import.meta.dirname, file), "utf8");
    // Covers both call forms: `.log("route", …)` and a biome-wrapped
    // `.log(\n  "route",\n  …)`.
    for (const match of source.matchAll(/\.log\(\s*"([a-z]+)"/g)) {
      found.add(match[1]);
    }
  }
  return [...found].sort();
}

describe("debug log categories", () => {
  it("emits exactly the documented set", () => {
    expect(emittedCategories()).toEqual([...DOCUMENTED_CATEGORIES]);
  });

  it("scans sources that actually contain log calls", () => {
    // Guards the assertion above against silently passing on empty input if a
    // file is renamed or the call form changes.
    expect(emittedCategories().length).toBeGreaterThan(0);
  });
});
