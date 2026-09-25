import { readFileSync, realpathSync, statSync } from "node:fs";
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
  } catch {
    throw invalidSeed(
      `Seed entry "${key}" points to a missing file: ${entry}`,
      {
        resource: key,
      },
    );
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
 * Read a `--seed` manifest.
 *
 * Every entry shape is checked explicitly and anything unrecognised throws:
 * silently dropping a malformed entry used to start a server whose collections
 * were quietly empty. File entries resolve relative to the manifest rather than
 * the process CWD, and may not escape the manifest directory.
 *
 * @throws ResourceLimitError when the manifest exceeds `MAX_SEED_MANIFEST_BYTES`
 * @throws SchmockError `OPENAPI_INVALID_OPTION` for a manifest that is not a
 *   JSON object or holds an entry that is not an array, a file path inside the
 *   manifest directory, or `{ "count": <number> }`
 */
export function loadSeedFile(seedPath: string): Schmock.SeedConfig {
  const manifestPath = resolvePath(seedPath);
  // statSync before readFileSync: measuring after the read does not bound it.
  const { size } = statSync(manifestPath);
  if (size > MAX_SEED_MANIFEST_BYTES) {
    throw new ResourceLimitError(
      `seed manifest "${seedPath}"`,
      MAX_SEED_MANIFEST_BYTES,
      size,
    );
  }
  const baseDir = realpathSync(dirname(manifestPath));
  const raw = readFileSync(manifestPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidSeed(`Seed file "${seedPath}" contains invalid JSON`);
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
