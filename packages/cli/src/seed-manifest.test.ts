import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceLimitError, SchmockError } from "@schmock/core";
import { MAX_SEED_MANIFEST_BYTES } from "@schmock/openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSeedFile } from "./seed-manifest";

/**
 * When set, `node:fs` reports this size for every stat, standing in for a
 * manifest that grows between the stat and the read.
 */
const statOverride = vi.hoisted(() => ({
  size: undefined as number | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const shrink = <T extends object>(stats: T): T => {
    if (statOverride.size === undefined) return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
      size: statOverride.size,
    });
  };
  const overrides = {
    statSync: ((...args: Parameters<typeof actual.statSync>) =>
      shrink(actual.statSync(...args) as object)) as typeof actual.statSync,
    fstatSync: ((...args: Parameters<typeof actual.fstatSync>) =>
      shrink(actual.fstatSync(...args))) as typeof actual.fstatSync,
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

const posixOnly = process.platform === "win32" ? it.skip : it;

function failureOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the action to throw");
}

const created: string[] = [];

function makeDir(): string {
  // realpath so the macOS /tmp → /private/tmp symlink does not read as an escape.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "schmock-seed-")));
  created.push(dir);
  return dir;
}

afterEach(() => {
  statOverride.size = undefined;
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

  posixOnly(
    "reports an entry that exists but cannot be resolved by the reason, not as missing",
    () => {
      const dir = makeDir();
      // A symlink loop: the entry exists, realpath fails with ELOOP.
      symlinkSync(join(dir, "b.json"), join(dir, "a.json"));
      symlinkSync(join(dir, "a.json"), join(dir, "b.json"));
      const manifestPath = join(dir, "seed.json");
      writeFileSync(manifestPath, JSON.stringify({ pets: "./a.json" }));

      const error = failureOf(() => loadSeedFile(manifestPath));

      expect(error).toBeInstanceOf(SchmockError);
      expect((error as Error).message).not.toContain("missing file");
      expect(error).toMatchObject({
        code: "OPENAPI_INVALID_OPTION",
        message: expect.stringMatching(
          /^Seed entry "pets" could not be resolved: ELOOP\b/,
        ),
        context: {
          option: "seed",
          resource: "pets",
          reason: expect.stringMatching(/^ELOOP\b/),
        },
      });
    },
  );

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

  describe("reading the manifest", () => {
    it("stops a manifest that grows past the cap after it was measured", () => {
      const dir = makeDir();
      const manifestPath = join(dir, "seed.json");
      const filler = "x".repeat(MAX_SEED_MANIFEST_BYTES);
      writeFileSync(manifestPath, JSON.stringify({ pets: [{ note: filler }] }));
      // The stat says ten bytes; the read finds the rest.
      statOverride.size = 10;

      expect(() => loadSeedFile(manifestPath)).toThrow(ResourceLimitError);
    });

    it("refuses a directory as not a regular file", () => {
      const dir = makeDir();
      const manifestPath = join(dir, "seed.json");
      mkdirSync(manifestPath);

      const error = failureOf(() => loadSeedFile(manifestPath));

      expect(error).toBeInstanceOf(SchmockError);
      expect(error).toMatchObject({
        code: "OPENAPI_INVALID_OPTION",
        message: `Seed file "${manifestPath}" is not a regular file`,
        context: { option: "seed" },
      });
    });

    posixOnly("refuses a character device, which reports a size of 0", () => {
      const error = failureOf(() => loadSeedFile("/dev/null"));

      expect(error).toMatchObject({
        code: "OPENAPI_INVALID_OPTION",
        message: 'Seed file "/dev/null" is not a regular file',
      });
    });

    posixOnly("refuses a FIFO without waiting for a writer", () => {
      // With a blocking open this never returns: nothing writes to the FIFO.
      const dir = makeDir();
      const manifestPath = join(dir, "seed.fifo");
      execFileSync("mkfifo", [manifestPath]);

      const error = failureOf(() => loadSeedFile(manifestPath));

      expect(error).toMatchObject({ code: "OPENAPI_INVALID_OPTION" });
    });
  });
});
