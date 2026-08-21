import { SchmockError } from "@schmock/core";

/**
 * The browser build's stand-in for `seed-file.ts`.
 *
 * A browser has no filesystem, so a seed given as a path can only fail. It
 * fails by name and says what to do instead, rather than resolving to an empty
 * collection — a mock that serves nothing looks exactly like a mock that is
 * working until someone reads the page.
 */
export async function readSeedFile(path: string): Promise<string> {
  throw new SchmockError(
    "Loading seed data from a file path is not available in a browser build of " +
      `@schmock/openapi. Pass the seed for "${path}" as an inline array, or as ` +
      "{ count: n } to generate it from the schema.",
    "OPENAPI_NODE_ONLY",
    { feature: "seed file path" },
  );
}
