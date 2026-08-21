import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Message } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Does the published package survive a real browser bundler?
 *
 * `browser-compat.test.ts` greps the built `dist/index.js` for Node-only
 * spellings. That catches what WE emit and nothing else, which is exactly how
 * this shipped: `@apidevtools/swagger-parser` is a bare `--external` in our
 * build, so its Node-only code lives in the CONSUMER's dependency graph rather
 * than in our text. Only a bundler resolving that graph can see it.
 *
 * The bundler has to be esbuild, not `bun build`. Bun's browser target
 * silently accepts `require("util")` inside a CJS dependency and rewrites it
 * into a shim that throws only when called — the build goes green and the app
 * dies at runtime. esbuild refuses to resolve it, which is what Angular's
 * application builder and Vite both do, and what reported this bug.
 */

const packageRoot = resolve(import.meta.dirname, "..");
const repoPackages = resolve(packageRoot, "..");

/**
 * Node built-ins a browser bundle may leave unresolved.
 *
 * A `node:`-prefixed dynamic `import()` on a branch that never runs in a
 * browser is the deliberate pattern in this repo (`seed.ts` for seed files,
 * `core/builder.ts` for `listen()`), and every browser bundler config stubs or
 * externalises the `node:` namespace. What must stay at zero is BARE built-ins
 * — `path`, `util`, `fs`, `url` — because those only ever arrive through a CJS
 * dependency's `require()`, which no bundler config can fix and which is what
 * actually broke.
 */
const ALLOWED_EXTERNALS = ["node:*"];

/**
 * `node:` specifiers that survive into the bundle, pinned so a new one cannot
 * appear without this list moving with it.
 *
 * They are externalised rather than banned so that a survivor shows up here as
 * a listed import instead of as a build error, which says more. `node:http` is
 * `@schmock/core`'s `listen()`, dynamically imported on a branch a browser
 * never takes. Nothing in `@schmock/openapi` itself reaches a `node:` import
 * any more, and `bun run build` fails outright if `node:fs` reappears in
 * `dist/index.browser.js`.
 */
const EXPECTED_NODE_IMPORTS = ["node:http"];

/**
 * An inline spec with an internal `$ref`, which is the case that decides
 * whether the fix is real: `dereferenceDocument` short-circuits only for a
 * document containing no `"$ref"` at all, and every realistic spec carries
 * `#/components/schemas` pointers.
 */
const INLINE_SPEC = {
  openapi: "3.0.3",
  info: { title: "Browser Bundle", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Pet" },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["id", "name"],
        properties: { id: { type: "integer" }, name: { type: "string" } },
      },
    },
  },
};

/** What an Angular `APP_INITIALIZER` doing this actually compiles to. */
const APP_SOURCE = `import { schmock } from "@schmock/core";
import { openapi } from "@schmock/openapi";
const mock = schmock({ state: {} });
mock.pipe(await openapi({ spec: ${JSON.stringify(INLINE_SPEC)} }));
export const listPets = () => mock.handle("GET", "/pets");`;

/**
 * A throwaway package whose only dependencies are the workspace packages,
 * linked by their real directories.
 *
 * Linking rather than importing `dist/index.js` by path is the point: package
 * resolution — the `exports` map and every condition in it — is part of what
 * is under test, and a relative import would walk straight past it.
 */
function createConsumer(): string {
  const dir = mkdtempSync(join(tmpdir(), "schmock-browser-bundle-"));
  const scope = join(dir, "node_modules", "@schmock");
  mkdirSync(scope, { recursive: true });
  for (const name of ["core", "faker", "openapi"]) {
    symlinkSync(resolve(repoPackages, name), join(scope, name), "dir");
  }
  return dir;
}

interface BundleResult {
  errors: Message[];
  externals: string[];
  code: string;
}

async function bundleForBrowser(consumerDir: string): Promise<BundleResult> {
  const result = await build({
    stdin: {
      contents: APP_SOURCE,
      resolveDir: consumerDir,
      loader: "js",
      sourcefile: "app-initializer.js",
    },
    bundle: true,
    format: "esm",
    // The Angular application builder's own setting. Without it esbuild
    // resolves `path`/`util` to the real Node modules and proves nothing.
    platform: "browser",
    external: ALLOWED_EXTERNALS,
    // Suppresses tsconfig discovery. The repo root maps `@schmock/*` onto
    // `packages/*/src` via `paths`, and esbuild honours that from any
    // directory beneath it — bypassing both `dist` and the `exports` map this
    // test exists to exercise.
    tsconfigRaw: {},
    metafile: true,
    write: false,
    logLevel: "silent",
  }).catch((error: { errors?: Message[] }) => error);

  const externals = new Set<string>();
  const metafile = "metafile" in result ? result.metafile : undefined;
  for (const output of Object.values(metafile?.outputs ?? {})) {
    for (const imported of output.imports ?? []) {
      if (imported.external) externals.add(imported.path);
    }
  }

  return {
    errors: result.errors ?? [],
    externals: [...externals].sort(),
    code: "outputFiles" in result ? (result.outputFiles?.[0]?.text ?? "") : "",
  };
}

function describeErrors(errors: Message[]): string {
  return errors
    .map((e) => `${e.text} (from ${e.location?.file ?? "unknown"})`)
    .join("\n");
}

describe("browser bundling", () => {
  let consumerDir: string;
  let result: BundleResult;

  beforeAll(async () => {
    consumerDir = createConsumer();
    result = await bundleForBrowser(consumerDir);
  }, 120_000);

  afterAll(() => {
    rmSync(consumerDir, { recursive: true, force: true });
  });

  it("resolves an inline-spec app initializer with no bare Node built-ins", () => {
    // The reported failure verbatim: `Could not resolve "path"` from
    // json-schema-ref-parser, `Could not resolve "util"` from swagger-parser's
    // CJS `lib/util.js`.
    expect(describeErrors(result.errors)).toBe("");
  });

  it("actually bundles the package rather than resolving to nothing", () => {
    // Every other assertion here is satisfiable by an empty bundle or by a
    // browser build that throws on every spec, so this one keeps them honest:
    // the code has to be real, and `openapi()` has to have produced routes.
    expect(result.code.length).toBeGreaterThan(10_000);
    expect(result.code).toContain("@schmock/openapi");
  });

  it("emits no dynamic-require shim", () => {
    // esbuild emits this for a CJS `require()` it cannot resolve. Reaching the
    // browser it throws `Dynamic require of "util" is not supported` — inside
    // an `APP_INITIALIZER` that aborts bootstrap with no failed request and no
    // error anyone connects to the mock, so every data-driven page just renders
    // empty.
    expect(result.code).not.toContain("Dynamic require of");
  });

  it("pulls in no Node built-ins at all", () => {
    expect(result.externals).toEqual(EXPECTED_NODE_IMPORTS);
  });

  it("runs, and serves the inline spec's route", async () => {
    // Resolving is not working. This is the half the build check cannot see:
    // the reported app compiled fine once `path`/`fs` were marked external and
    // then died on the first line it executed.
    //
    // Importing the bundle as ESM is a fair stand-in for a browser on the one
    // thing that matters here: `require` is undefined in an ES module, so a
    // dynamic-require shim throws exactly the `Dynamic require of "util" is
    // not supported` that ended the reported app's bootstrap.
    const bundlePath = join(consumerDir, "bundle.mjs");
    writeFileSync(bundlePath, result.code, "utf-8");

    const { listPets } = (await import(pathToFileURL(bundlePath).href)) as {
      listPets: () => Promise<{ status: number; body: unknown }>;
    };
    const { status, body } = await listPets();

    expect(status).toBe(200);
    // The `$ref` to `#/components/schemas/Pet` has to have been resolved for
    // the generator to know a pet has an `id` and a `name`.
    expect(Array.isArray(body)).toBe(true);
    for (const pet of body as Array<Record<string, unknown>>) {
      expect(typeof pet.id).toBe("number");
      expect(typeof pet.name).toBe("string");
    }
  }, 60_000);
});
