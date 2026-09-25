import { resolve } from "node:path";
import { schmock } from "@schmock/core";
import { build, type Message } from "esbuild";
import { describe, expect, it } from "vitest";
import { openapi } from "./plugin";

/**
 * Core-builder review fixes that need this package: esbuild is a dev
 * dependency of @schmock/openapi only, and the tuple-header guard is trusted
 * by openapi's response pipeline.
 */

const coreEntry = resolve(import.meta.dirname, "../../core/src/index.ts");

function describeErrors(errors: readonly Message[]): string {
  return errors
    .map((error) => `${error.text} (from ${error.location?.file ?? "?"})`)
    .join("\n");
}

describe("@schmock/core in an esbuild browser bundle", () => {
  it("bundles with platform browser and no externals, leaving listen()'s node:http unresolved", async () => {
    // The Angular application builder's settings: platform "browser" and no
    // `node:*` externals. esbuild resolves a dynamic import's specifier at
    // build time even on a branch a browser never takes, unless the import
    // expression handles its own rejection.
    const result = await build({
      entryPoints: [coreEntry],
      bundle: true,
      format: "esm",
      platform: "browser",
      // No tsconfig discovery: the repo root's `paths` must not steer this.
      tsconfigRaw: {},
      metafile: true,
      write: false,
      logLevel: "silent",
    }).catch((error: { errors?: Message[] }) => error);

    const errors = "errors" in result ? (result.errors ?? []) : [];
    expect(describeErrors(errors)).toBe("");

    const externals = new Set<string>();
    const metafile = "metafile" in result ? result.metafile : undefined;
    for (const output of Object.values(metafile?.outputs ?? {})) {
      for (const imported of output.imports ?? []) {
        if (imported.external) externals.add(imported.path);
      }
    }
    expect([...externals]).toEqual(["node:http"]);
  }, 60_000);
});

const PETS_SPEC = {
  openapi: "3.0.3",
  info: { title: "Tuple headers", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { ok: { type: "integer" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

async function mockWithUpstreamTuple(
  headers: unknown,
): Promise<Schmock.CallableMockInstance> {
  const mock = schmock();
  mock.pipe({
    name: "upstream-tuple",
    process: (context) => ({ context, response: [200, { ok: 1 }, headers] }),
  });
  mock.pipe(await openapi({ spec: PETS_SPEC }));
  return mock;
}

function bodyField(response: Schmock.Response, field: string): unknown {
  const body = response.body;
  return typeof body === "object" && body !== null && field in body
    ? Reflect.get(body, field)
    : undefined;
}

describe("openapi with a status tuple whose headers are not a string record", () => {
  it("serves a tuple whose headers element is undefined", async () => {
    const mock = await mockWithUpstreamTuple(undefined);

    const response = await mock.handle("GET", "/pets");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: 1 });
  });

  it("does not crash inside openapi on a null headers element", async () => {
    const mock = await mockWithUpstreamTuple(null);

    const response = await mock.handle("GET", "/pets");

    expect(bodyField(response, "code")).not.toBe("PLUGIN_ERROR");
    expect(String(bodyField(response, "error"))).not.toContain(
      "Object.entries",
    );
  });
});
