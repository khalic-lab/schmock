import { ResourceLimitError, SchmockError } from "@schmock/core";
import { MAX_SEED_FILE_BYTES } from "./limits.js";

/** Bytes requested per read; the size cap is checked after each one. */
const READ_CHUNK_BYTES = 64 * 1024;

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
  const fs = await import("node:fs");
  // Non-blocking, so a FIFO with no writer opens at once instead of freezing
  // the process until one appears, a `--watch` reload included. It changes
  // nothing for a regular file. Windows does not define the flag.
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    // A FIFO, a device or a procfs-style file reports a size of 0, which the
    // check below would wave through whatever it then streams.
    if (!stat.isFile()) {
      throw new SchmockError(
        `Seed file "${path}" is not a regular file`,
        "OPENAPI_INVALID_OPTION",
        { option: "seed", file: path },
      );
    }
    // Measured *before* the read: a read-then-measure check does not prevent
    // the allocation it exists to bound.
    if (stat.size > MAX_SEED_FILE_BYTES) {
      throw new ResourceLimitError(
        `seed file "${path}"`,
        MAX_SEED_FILE_BYTES,
        stat.size,
      );
    }
    // And again while reading, so a file that grows after the stat is still
    // stopped one chunk past the cap rather than read whole.
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = new Uint8Array(READ_CHUNK_BYTES);
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_SEED_FILE_BYTES) {
        throw new ResourceLimitError(
          `seed file "${path}"`,
          MAX_SEED_FILE_BYTES,
          total,
        );
      }
      chunks.push(chunk.subarray(0, read));
    }
    // `Buffer` decodes exactly as `readFileSync(path, "utf-8")` did: a BOM is
    // kept, where `TextDecoder` would drop it.
    return Buffer.concat(chunks, total).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}
