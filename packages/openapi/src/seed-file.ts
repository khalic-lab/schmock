import { ResourceLimitError } from "@schmock/core";
import { MAX_SEED_FILE_BYTES } from "./limits.js";

/**
 * Reading a seed file, behind the same build-time seam as `resolver.ts`.
 *
 * `seed.ts` used to inline this, with a dynamic `await import("node:fs")` so
 * that the built module stayed loadable in a browser. That worked as far as
 * our own bundle went but does not survive a CONSUMER's bundler: esbuild
 * resolves the target of a dynamic import at build time even on a branch that
 * can never run, so a browser build still failed on `node:fs`. Giving the read
 * its own module lets `scripts/build.ts` swap in `seed-file.browser.ts`, which
 * leaves the browser bundle with no reference to `node:` at all.
 *
 * The import stays dynamic here regardless, so the Node build also remains
 * loadable by a bundler that never looks at the `browser` condition.
 */
export async function readSeedFile(path: string): Promise<string> {
  const { readFileSync, statSync } = await import("node:fs");
  // Measured with statSync *before* the read: a read-then-measure check does
  // not prevent the allocation it exists to bound.
  const { size } = statSync(path);
  if (size > MAX_SEED_FILE_BYTES) {
    throw new ResourceLimitError(
      `seed file "${path}"`,
      MAX_SEED_FILE_BYTES,
      size,
    );
  }
  return readFileSync(path, "utf-8");
}
