import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceLimitError, SchmockError } from "@schmock/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MAX_SEED_FILE_BYTES } from "./limits";
import { readSeedFile } from "./seed-file";

/**
 * When set, `node:fs` reports this size for every stat, standing in for a
 * file that grows between the stat and the read.
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

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("readSeedFile", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "schmock-seed-file-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    statOverride.size = undefined;
  });

  describe("regular files", () => {
    it("reads one whole", async () => {
      const path = join(dir, "pets.json");
      writeFileSync(path, '[{"id":1}]');

      await expect(readSeedFile(path)).resolves.toBe('[{"id":1}]');
    });

    it("stops a file that grows past the cap after it was measured", async () => {
      const path = join(dir, "growing.json");
      writeFileSync(path, "x".repeat(MAX_SEED_FILE_BYTES + 1024));
      // The stat says ten bytes; the read finds the rest.
      statOverride.size = 10;

      const error = await failureOf(readSeedFile(path));

      expect(error).toBeInstanceOf(ResourceLimitError);
    });
  });

  describe("anything else", () => {
    posixOnly(
      "refuses a character device, which reports a size of 0",
      async () => {
        const error = await failureOf(readSeedFile("/dev/null"));

        expect(error).toBeInstanceOf(SchmockError);
        expect((error as SchmockError).code).toBe("OPENAPI_INVALID_OPTION");
        expect((error as Error).message).toContain("not a regular file");
      },
    );

    posixOnly("refuses a FIFO without waiting for a writer", async () => {
      // With a blocking open this never returns: nothing writes to the FIFO.
      const path = join(dir, "seed.fifo");
      execFileSync("mkfifo", [path]);

      const error = await failureOf(readSeedFile(path));

      expect((error as SchmockError).code).toBe("OPENAPI_INVALID_OPTION");
    });
  });
});
