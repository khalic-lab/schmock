import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import type * as Schmock from "@schmock/core";
import { ResourceLimitError, SchmockError } from "@schmock/core";
import { MAX_SEED_MANIFEST_BYTES } from "@schmock/openapi";

/** Bytes requested per read; the size cap is checked after each one. */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * A manifest becomes the openapi plugin's `seed` option, so its mistakes carry
 * the code openapi raises for the same mistakes in that option.
 */
function invalidSeed(
  message: string,
  context: Record<string, string> = {},
): SchmockError {
  return new SchmockError(message, "OPENAPI_INVALID_OPTION", {
    option: "seed",
    ...context,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function isCountSource(value: unknown): value is { count: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "count" in value &&
    typeof value.count === "number"
  );
}

/**
 * Resolve a manifest file entry against the manifest directory, refusing escapes.
 *
 * Entries are resolved *then* checked, so an absolute `"/etc/passwd"` is
 * rejected rather than exempted, and both sides are `realpathSync`'d so a
 * symlink planted inside the manifest directory cannot point out of it (and so
 * a macOS `/tmp` → `/private/tmp` manifest still validates).
 */
function resolveSeedEntryPath(
  entry: string,
  key: string,
  baseDir: string,
): string {
  let real: string;
  try {
    real = realpathSync(resolvePath(baseDir, entry));
  } catch (error) {
    // Only ENOENT is a missing file. A symlink loop (ELOOP) or an unreadable
    // directory (EACCES) used to be reported as missing too, which sent the
    // user looking for a typo in a path that exists.
    if (errorCode(error) === "ENOENT") {
      throw invalidSeed(
        `Seed entry "${key}" points to a missing file: ${entry}`,
        { resource: key },
      );
    }
    const reason = errorMessage(error);
    throw invalidSeed(`Seed entry "${key}" could not be resolved: ${reason}`, {
      resource: key,
      reason,
    });
  }
  const rel = relative(baseDir, real);
  // `relative()` signals an escape only when the FIRST path segment is exactly
  // `..`. A plain `rel.startsWith("..")` also rejects in-directory files whose
  // name merely begins with `..` (e.g. `..data.json`, or a Kubernetes
  // ConfigMap mount whose real path runs through `..2024_.../`), which are
  // wholly inside baseDir. `rel === ""` guards the self-reference `"."`.
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw invalidSeed(
      `Seed entry "${key}" must stay inside the seed manifest directory: ${entry}`,
      { resource: key },
    );
  }
  return real;
}

/**
 * Read the manifest itself, the way the openapi plugin reads a seed file
 * (`seed-file.ts` there, which is async and not exported).
 */
function readManifest(manifestPath: string, seedPath: string): string {
  // Non-blocking, so a FIFO with no writer opens at once instead of freezing
  // startup, or a `--watch` reload, until one appears. It changes nothing for
  // a regular file. Windows does not define the flag.
  const fd = openSync(
    manifestPath,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fstatSync(fd);
    // A FIFO, a device or a procfs-style file reports a size of 0, which the
    // check below would wave through whatever it then streams.
    if (!stat.isFile()) {
      throw invalidSeed(`Seed file "${seedPath}" is not a regular file`);
    }
    // Measured *before* the read: a read-then-measure check does not prevent
    // the allocation it exists to bound.
    if (stat.size > MAX_SEED_MANIFEST_BYTES) {
      throw new ResourceLimitError(
        `seed manifest "${seedPath}"`,
        MAX_SEED_MANIFEST_BYTES,
        stat.size,
      );
    }
    // And again while reading, so a file that grows after the stat is still
    // stopped one chunk past the cap rather than read whole.
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = new Uint8Array(READ_CHUNK_BYTES);
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_SEED_MANIFEST_BYTES) {
        throw new ResourceLimitError(
          `seed manifest "${seedPath}"`,
          MAX_SEED_MANIFEST_BYTES,
          total,
        );
      }
      chunks.push(chunk.subarray(0, read));
    }
    // `Buffer` decodes exactly as `readFileSync(path, "utf-8")` did: a BOM is
    // kept, where `TextDecoder` would drop it.
    return Buffer.concat(chunks, total).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a `--seed` manifest.
 *
 * Every entry shape is checked explicitly and anything unrecognised throws:
 * silently dropping a malformed entry used to start a server whose collections
 * were quietly empty. File entries resolve relative to the manifest rather than
 * the process CWD, and may not escape the manifest directory.
 *
 * @throws ResourceLimitError when the manifest exceeds `MAX_SEED_MANIFEST_BYTES`
 * @throws SchmockError `OPENAPI_INVALID_OPTION` for a manifest that is not a
 *   regular file or not a JSON object, or that holds an entry that is not an
 *   array, a file path inside the manifest directory, or `{ "count": <number> }`
 */
export function loadSeedFile(seedPath: string): Schmock.SeedConfig {
  const manifestPath = resolvePath(seedPath);
  const raw = readManifest(manifestPath, seedPath);
  const baseDir = realpathSync(dirname(manifestPath));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // The parser's message carries the position, which is what finds the typo.
    const reason = errorMessage(error);
    throw invalidSeed(
      `Seed file "${seedPath}" contains invalid JSON: ${reason}`,
      { reason },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidSeed(
      `Seed file must contain a JSON object, got: ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
  }

  const result: Schmock.SeedConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      result[key] = value;
    } else if (typeof value === "string") {
      result[key] = resolveSeedEntryPath(value, key, baseDir);
    } else if (isCountSource(value)) {
      result[key] = value;
    } else {
      throw invalidSeed(
        `Seed entry "${key}" must be an array, a file path, or { "count": <number> }`,
        { resource: key },
      );
    }
  }
  return result;
}
