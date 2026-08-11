import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceLimitError } from "@schmock/core";
import { MAX_SEED_MANIFEST_BYTES } from "@schmock/openapi";
import { afterEach, describe, expect, it } from "vitest";
import { loadSeedFile } from "./cli";

const created: string[] = [];

function makeDir(): string {
  // realpath so the macOS /tmp → /private/tmp symlink does not read as an escape.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "schmock-seed-")));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadSeedFile", () => {
  it("resolves a file entry against the manifest directory, not the CWD", () => {
    const dir = makeDir();
    const dataPath = join(dir, "pets.json");
    writeFileSync(dataPath, JSON.stringify([{ id: 1, name: "Rex" }]));
    const manifestPath = join(dir, "seed.json");
    writeFileSync(manifestPath, JSON.stringify({ pets: "./pets.json" }));

    const config = loadSeedFile(manifestPath);

    // An absolute realpath, not the "./pets.json" the manifest wrote — the old
    // behaviour handed that straight to loadSeed, which resolved it from CWD.
    expect(config.pets).toBe(realpathSync(dataPath));
  });

  it("rejects an entry that escapes the manifest directory", () => {
    const dir = makeDir();
    const outside = join(dir, "outside.json");
    writeFileSync(outside, "[]");
    const manifestDir = mkdtempSync(join(dir, "manifest-"));
    const manifestPath = join(manifestDir, "seed.json");
    writeFileSync(manifestPath, JSON.stringify({ pets: "../outside.json" }));

    expect(() => loadSeedFile(manifestPath)).toThrow(/must stay inside/);
  });

  it("rejects an absolute entry rather than exempting it", () => {
    const dir = makeDir();
    const manifestPath = join(dir, "seed.json");
    writeFileSync(manifestPath, JSON.stringify({ pets: "/etc/hosts" }));

    expect(() => loadSeedFile(manifestPath)).toThrow(/must stay inside/);
  });

  it("rejects a symlink inside the directory that targets a file outside it", () => {
    const dir = makeDir();
    const outside = join(dir, "outside.json");
    writeFileSync(outside, "[]");
    const manifestDir = mkdtempSync(join(dir, "manifest-"));
    symlinkSync(outside, join(manifestDir, "pets.json"));
    const manifestPath = join(manifestDir, "seed.json");
    writeFileSync(manifestPath, JSON.stringify({ pets: "./pets.json" }));

    expect(() => loadSeedFile(manifestPath)).toThrow(/must stay inside/);
  });

  it("accepts an in-directory file whose name begins with '..'", () => {
    // `relative()` returns "..data.json" for a sibling file — a leading `..`
    // that is NOT a traversal. A `startsWith("..")` check would reject this
    // wholly-inside file, which also breaks the Kubernetes ConfigMap layout
    // (keys resolve through a real `..2024_.../` directory).
    const dir = makeDir();
    const dataPath = join(dir, "..data.json");
    writeFileSync(dataPath, JSON.stringify([{ id: 1 }]));
    const manifestPath = join(dir, "seed.json");
    writeFileSync(manifestPath, JSON.stringify({ pets: "./..data.json" }));

    expect(loadSeedFile(manifestPath).pets).toBe(realpathSync(dataPath));
  });

  it("resolves a ConfigMap-style entry that runs through a '..'-prefixed dir", () => {
    const dir = makeDir();
    const dataDir = mkdtempSync(join(dir, "..2026_"));
    const dataPath = join(dataDir, "pets.json");
    writeFileSync(dataPath, JSON.stringify([{ id: 1 }]));
    symlinkSync(dataDir, join(dir, "..data"));
    symlinkSync(join("..data", "pets.json"), join(dir, "pets.json"));
    const manifestPath = join(dir, "seed.json");
    writeFileSync(manifestPath, JSON.stringify({ pets: "./pets.json" }));

    expect(loadSeedFile(manifestPath).pets).toBe(realpathSync(dataPath));
  });

  it("reports a missing entry target by name", () => {
    const dir = makeDir();
    const manifestPath = join(dir, "seed.json");
    writeFileSync(manifestPath, JSON.stringify({ pets: "./nope.json" }));

    expect(() => loadSeedFile(manifestPath)).toThrow(
      /points to a missing file/,
    );
  });

  it("rejects an unknown entry shape instead of dropping it silently", () => {
    const dir = makeDir();
    const manifestPath = join(dir, "seed.json");
    writeFileSync(manifestPath, JSON.stringify({ pets: 42 }));

    expect(() => loadSeedFile(manifestPath)).toThrow(
      /must be an array, a file path/,
    );
  });

  it("rejects a non-numeric count", () => {
    const dir = makeDir();
    const manifestPath = join(dir, "seed.json");
    writeFileSync(manifestPath, JSON.stringify({ pets: { count: "5" } }));

    expect(() => loadSeedFile(manifestPath)).toThrow(
      /must be an array, a file path/,
    );
  });

  it("accepts inline arrays and numeric counts", () => {
    const dir = makeDir();
    const manifestPath = join(dir, "seed.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ pets: [{ id: 1 }], owners: { count: 3 } }),
    );

    expect(loadSeedFile(manifestPath)).toEqual({
      pets: [{ id: 1 }],
      owners: { count: 3 },
    });
  });

  it("rejects a manifest above the byte budget", () => {
    const dir = makeDir();
    const manifestPath = join(dir, "seed.json");
    const filler = "x".repeat(MAX_SEED_MANIFEST_BYTES);
    writeFileSync(manifestPath, JSON.stringify({ pets: [{ note: filler }] }));

    expect(() => loadSeedFile(manifestPath)).toThrow(ResourceLimitError);
  });

  it("reports malformed JSON instead of leaking a raw SyntaxError", () => {
    const dir = makeDir();
    const manifestPath = join(dir, "seed.json");
    writeFileSync(manifestPath, "NOT JSON {{{");

    expect(() => loadSeedFile(manifestPath)).toThrow(/contains invalid JSON/);
  });

  it("rejects a top-level array manifest", () => {
    const dir = makeDir();
    const manifestPath = join(dir, "seed.json");
    writeFileSync(manifestPath, "[]");

    expect(() => loadSeedFile(manifestPath)).toThrow(
      /must contain a JSON object, got: array/,
    );
  });
});
