import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";

/**
 * Builds the package twice: once for Node, once for a browser.
 *
 * The two differ only in which modules answer to a handful of imports. A module
 * `x.ts` with a sibling `x.browser.ts` is physically replaced by that sibling in
 * the browser build — `resolver.ts` (which owns every use of
 * `@apidevtools/swagger-parser`) and `seed-file.ts` (which owns `node:fs`).
 *
 * Why a build-time swap rather than a runtime flag or a lazy import:
 *
 * - A lazy `await import()` does not help. esbuild — which Angular's
 *   application builder and Vite both use — resolves the target of a dynamic
 *   import at build time even when the branch holding it can never run, so the
 *   Node-only graph is pulled in and fails to resolve regardless. This was
 *   measured, not assumed.
 * - Injecting an implementation from the entry point would mean every importer
 *   of `parser.ts` had to install one first, and the test suite imports
 *   `parser.ts` directly. Swapping the module keeps the seam invisible to
 *   everything except this file.
 *
 * `browser-bundle.test.ts` bundles a real consumer with esbuild and fails if
 * any Node-only code comes back, so this arrangement cannot silently rot.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(packageRoot, "src");

const EXTERNAL = [
  "@apidevtools/swagger-parser",
  "@schmock/core",
  "@schmock/faker",
  "ajv",
  "ajv/dist/2020.js",
  "ajv-formats",
];

/** Modules with a `.browser.ts` sibling, by their import specifier stem. */
function browserVariants(): Map<string, string> {
  const variants = new Map<string, string>();
  for (const entry of readdirSync(sourceDir)) {
    if (!entry.endsWith(".browser.ts")) continue;
    const stem = entry.slice(0, -".browser.ts".length);
    variants.set(stem, resolve(sourceDir, entry));
  }
  return variants;
}

function swapPlugin(variants: Map<string, string>): BunPlugin {
  const stems = [...variants.keys()];
  if (stems.length === 0) throw new Error("no .browser.ts variants found");
  const filter = new RegExp(`^\\./(${stems.join("|")})\\.js$`);

  return {
    name: "browser-variants",
    setup(builder) {
      builder.onResolve({ filter }, (args) => {
        const stem = filter.exec(args.path)?.[1];
        const replacement = stem === undefined ? undefined : variants.get(stem);
        if (replacement === undefined) return undefined;
        return { path: replacement };
      });
    },
  };
}

async function run(): Promise<void> {
  const variants = browserVariants();

  const builds = [
    { entry: "src/index.ts", naming: "index.js", plugins: [] as BunPlugin[] },
    {
      entry: "src/index.ts",
      naming: "index.browser.js",
      plugins: [swapPlugin(variants)],
    },
  ];

  for (const { entry, naming, plugins } of builds) {
    const result = await Bun.build({
      entrypoints: [resolve(packageRoot, entry)],
      outdir: resolve(packageRoot, "dist"),
      naming: { entry: naming },
      target: "browser",
      minify: true,
      external: EXTERNAL,
      plugins,
    });

    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error(`build failed for ${naming}`);
    }
  }

  // The swap is the whole point of the browser build, so verify it rather than
  // trusting it: a plugin that silently stops matching would otherwise ship a
  // browser bundle that is just the Node one under a different name.
  const browserBundle = await Bun.file(
    resolve(packageRoot, "dist/index.browser.js"),
  ).text();
  for (const forbidden of ["@apidevtools/swagger-parser", "node:fs"]) {
    if (browserBundle.includes(forbidden)) {
      throw new Error(
        `dist/index.browser.js still references ${forbidden}; the module swap did not apply`,
      );
    }
  }
}

await run();
