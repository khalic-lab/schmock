/// <reference path="../../core/schmock.d.ts" />

import { SchmockError, schmock } from "@schmock/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { dispatchCallbacks } from "./callbacks.js";
import { selectResponseMediaType } from "./content-negotiation.js";
import type { CrudResource } from "./crud-detector.js";
import type {
  CrudOperationMeta,
  OnSchemaCallback,
  OnSchemaContext,
  OpenApiRefPolicy,
  ResourceOverride,
  SeedConfig,
  SeedSource,
} from "./index.js";
import * as loadDocumentModule from "./load-document.js";
import {
  createSchemaNormalizer,
  extractCallbacks,
  extractParameters,
  type ParseContext,
} from "./operation-extract.js";
import type { ParsedResponseEntry } from "./parser.js";
import * as parserModule from "./parser.js";
import { openapi } from "./plugin.js";
import type { RefPolicy } from "./ref-policy.js";
import {
  applyResponseContentType,
  createBodyValidatorContext,
  getResponseStatus,
  validateResponse,
} from "./request-pipeline.js";
import { loadSeed } from "./seed.js";

function makeContext(
  overrides: Partial<Schmock.PluginContext> = {},
): Schmock.PluginContext {
  return {
    path: "/pets",
    method: "POST",
    params: {},
    query: {},
    headers: {},
    body: undefined,
    state: new Map(),
    route: {},
    ...overrides,
  };
}

/** The URLs a single callback on `urlExpression` is dispatched to. */
async function dispatched(
  urlExpression: string,
  response: unknown,
): Promise<Array<{ url: string; body: unknown }>> {
  const requests: Array<{ url: string; body: unknown }> = [];
  await dispatchCallbacks(
    [{ urlExpression, method: "POST" }],
    (request) => {
      requests.push({ url: request.url, body: request.body });
    },
    makeContext(),
    response,
  );
  return requests;
}

describe("R9: callbacks read the response the way core delivers it", () => {
  // Headers that are not a string record make this NOT an envelope: core
  // sends the whole object as a 200 body.
  const notAnEnvelope = { status: 201, body: { id: 1 }, headers: { "x-n": 1 } };

  it("core delivers an object with non-string headers whole, as a 200", async () => {
    const mock = schmock();
    mock("POST /pets", () => notAnEnvelope);

    const response = await mock.handle("POST", "/pets");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(notAnEnvelope);
  });

  it("does not resolve $response.body#/id against a body the client never got", async () => {
    // The old callbacks copy unwrapped this object and dispatched .../1.
    expect(
      await dispatched("https://hooks.example/pets/{$response.body#/id}", {
        ...notAnEnvelope,
      }),
    ).toEqual([]);
  });

  it("resolves $response.body#/body/id against the delivered body", async () => {
    const requests = await dispatched(
      "https://hooks.example/pets/{$response.body#/body/id}",
      notAnEnvelope,
    );
    expect(requests.map((request) => request.url)).toEqual([
      "https://hooks.example/pets/1",
    ]);
  });

  it("falls back to the delivered body as the payload", async () => {
    const requests = await dispatched(
      "https://hooks.example/hook",
      notAnEnvelope,
    );
    expect(requests.map((request) => request.body)).toEqual([notAnEnvelope]);
  });

  it("still unwraps a well-formed envelope, tuple and plain body", async () => {
    const expression = "https://hooks.example/pets/{$response.body#/id}";
    const urls = async (response: unknown) =>
      (await dispatched(expression, response)).map((request) => request.url);

    expect(
      await urls({ status: 201, body: { id: 2 }, headers: { "x-n": "1" } }),
    ).toEqual(["https://hooks.example/pets/2"]);
    expect(await urls([201, { id: 3 }])).toEqual([
      "https://hooks.example/pets/3",
    ]);
    expect(await urls({ id: 4 })).toEqual(["https://hooks.example/pets/4"]);
  });
});

describe("R9: request-pipeline on core's getResponseParts", () => {
  function nullableNoContentRoute(): Schmock.RouteConfig {
    const responses = new Map<number, ParsedResponseEntry>([
      [
        204,
        {
          description: "No content",
          contentTypes: ["application/json"],
          content: new Map([
            ["application/json", { schema: { type: "null" } }],
          ]),
        },
      ],
    ]);
    return { "openapi:responses": responses };
  }

  it("reads status the way core answers it", () => {
    expect(getResponseStatus(null)).toBe(204);
    expect(getResponseStatus(undefined)).toBe(204);
    expect(getResponseStatus({ id: 1 })).toBe(200);
    expect(getResponseStatus([201, { id: 1 }])).toBe(201);
    expect(getResponseStatus({ status: 202, body: {} })).toBe(202);
    // Not an envelope (headers are not a string record): a plain 200 body.
    expect(
      getResponseStatus({ status: 202, body: {}, headers: { "x-n": 1 } }),
    ).toBe(200);
  });

  it("keeps re-wrapping a plain null as no body", () => {
    const context = makeContext({ route: nullableNoContentRoute() });
    expect(applyResponseContentType(context, null)).toEqual({
      response: [204, undefined, { "content-type": "application/json" }],
      rejected: false,
    });
  });

  it("keeps validating a plain null as no body, and a carried null as null", () => {
    const context = makeContext({ route: nullableNoContentRoute() });
    const validator = createBodyValidatorContext();

    const plain = validateResponse(context, null, validator);
    expect(plain?.response).toMatchObject([
      500,
      { code: "RESPONSE_VALIDATION_ERROR", status: 204 },
    ]);
    expect(validateResponse(context, [204, null], validator)).toBeUndefined();
  });
});

describe("R3 and types-100/107: aliases of the ambient types", () => {
  it("aliases rather than mirrors each ambient type", () => {
    expectTypeOf<RefPolicy>().toEqualTypeOf<Schmock.OpenApiRefPolicy>();
    expectTypeOf<OpenApiRefPolicy>().toEqualTypeOf<Schmock.OpenApiRefPolicy>();
    expectTypeOf<SeedSource>().toEqualTypeOf<Schmock.SeedSource>();
    expectTypeOf<SeedConfig>().toEqualTypeOf<Schmock.SeedConfig>();
    expectTypeOf<OnSchemaCallback>().toEqualTypeOf<Schmock.OnSchemaCallback>();
    expectTypeOf<OnSchemaContext>().toEqualTypeOf<Schmock.OnSchemaContext>();
    expectTypeOf<ResourceOverride>().toEqualTypeOf<Schmock.ResourceOverride>();
    expectTypeOf<CrudOperationMeta>().toEqualTypeOf<Schmock.CrudOperationMeta>();
    expectTypeOf<
      NonNullable<Schmock.OpenApiOptions["onSchema"]>
    >().toEqualTypeOf<OnSchemaCallback>();
  });
});

describe("R15: one response media-type selection", () => {
  const declared = { contentTypes: ["application/json", "application/*"] };

  it("matches an explicit response Content-Type, whatever its case", () => {
    expect(
      selectResponseMediaType(
        declared,
        {},
        { "Content-Type": "application/xml" },
      ),
    ).toEqual({ mediaType: "application/xml", declared: "application/*" });
  });

  it("reports an undeclared explicit Content-Type with no declared key", () => {
    const selected = selectResponseMediaType(
      declared,
      {},
      { "content-type": "text/csv" },
    );
    expect(selected).toEqual({ mediaType: "text/csv" });
    expect(selected?.declared).toBeUndefined();
  });

  it("negotiates Accept, whatever its case, when no Content-Type is set", () => {
    expect(
      selectResponseMediaType(
        { contentTypes: ["application/xml", "application/json"] },
        { ACCEPT: "application/json" },
        {},
      ),
    ).toEqual({ mediaType: "application/json", declared: "application/json" });
  });

  it("takes the first declared type without Accept, and nothing when none is acceptable", () => {
    expect(
      selectResponseMediaType(
        { contentTypes: ["application/xml", "application/json"] },
        {},
        {},
      ),
    ).toEqual({ mediaType: "application/xml", declared: "application/xml" });
    expect(
      selectResponseMediaType(
        { contentTypes: ["application/xml"] },
        { accept: "text/html" },
        {},
      ),
    ).toBeUndefined();
    expect(selectResponseMediaType({}, {}, {})).toBeUndefined();
  });

  it("generates and validates against the same media type", async () => {
    const mock = schmock();
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "Profiles", version: "1.0.0" },
          paths: {
            "/report": {
              get: {
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/vnd.a+json": {
                        schema: {
                          type: "object",
                          properties: { a: { type: "integer" } },
                          required: ["a"],
                          additionalProperties: false,
                        },
                      },
                      "application/vnd.b+json": {
                        schema: {
                          type: "object",
                          properties: { b: { type: "string" } },
                          required: ["b"],
                          additionalProperties: false,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        validateResponses: true,
        fakerSeed: 7,
      }),
    );

    const response = await mock.handle("GET", "/report", {
      headers: { ACCEPT: "application/vnd.b+json" },
    });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/vnd.b+json");
    expect(Object.keys(response.body as object)).toEqual(["b"]);
  });

  it("applies a schemas override to a JSON media type spelled with parameters", async () => {
    const mock = schmock();
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "Override", version: "1.0.0" },
          paths: {
            "/thing": {
              get: {
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "Application/JSON; charset=utf-8": {
                        schema: {
                          type: "object",
                          properties: { original: { type: "string" } },
                          required: ["original"],
                        },
                      },
                      "application/xml": { schema: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
        schemas: {
          "GET /thing": {
            type: "object",
            properties: { patched: { type: "string", enum: ["yes"] } },
            required: ["patched"],
            additionalProperties: false,
          },
        },
      }),
    );

    const json = await mock.handle("GET", "/thing", {
      headers: { accept: "application/json" },
    });
    expect(json.body).toEqual({ patched: "yes" });

    const xml = await mock.handle("GET", "/thing", {
      headers: { accept: "application/xml" },
    });
    expect(typeof xml.body).toBe("string");
  });
});

describe("R15: seed failures are coded SchmockErrors", () => {
  const schemaless: CrudResource = {
    name: "items",
    basePath: "/items",
    itemPath: "/items/:id",
    idParam: "id",
    idProperty: "id",
    idKind: "integer",
    operations: ["list"],
    routes: [],
  };

  async function seedError(
    config: SeedConfig,
    resources: CrudResource[] = [],
  ): Promise<SchmockError> {
    const error: unknown = await loadSeed(config, resources).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    if (!(error instanceof SchmockError)) {
      throw new Error(`expected a SchmockError, got ${String(error)}`);
    }
    return error;
  }

  async function withSeedFile(
    content: string,
    run: (path: string) => Promise<void>,
  ): Promise<void> {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const directory = mkdtempSync(join(import.meta.dirname, ".tmp-seed-"));
    const path = join(directory, "seed.json");
    writeFileSync(path, content);
    try {
      await run(path);
    } finally {
      rmSync(directory, { recursive: true });
    }
  }

  it("codes an unparseable seed file, message unchanged", async () => {
    await withSeedFile("not json {{{", async (path) => {
      const error = await seedError({ items: path });
      expect(error.code).toBe("OPENAPI_INVALID_OPTION");
      expect(error.message).toBe(
        `Seed file "${path}" for resource "items" contains invalid JSON`,
      );
      expect(error.context).toEqual({
        option: "seed",
        resource: "items",
        file: path,
      });
    });
  });

  it("codes a seed file that is not a JSON array", async () => {
    await withSeedFile('{"not":"an array"}', async (path) => {
      const error = await seedError({ items: path });
      expect(error.code).toBe("OPENAPI_INVALID_OPTION");
      expect(error.message).toBe(
        `Seed file "${path}" for resource "items" must contain a JSON array`,
      );
    });
  });

  it("codes an invalid count", async () => {
    const error = await seedError({ items: { count: -1 } });
    expect(error.code).toBe("OPENAPI_INVALID_OPTION");
    expect(error.message).toBe(
      'Seed count for "items" must be a non-negative integer, got: -1',
    );
    expect(error.context).toEqual({ option: "seed", resource: "items" });
  });

  it("codes a count for a resource with no schema", async () => {
    const error = await seedError({ items: { count: 2 } }, [schemaless]);
    expect(error.code).toBe("OPENAPI_INVALID_OPTION");
    expect(error.message).toBe(
      'Cannot auto-generate seed for "items": no schema found in spec',
    );
  });

  it("surfaces the code from openapi() itself", async () => {
    const { join } = await import("node:path");
    await withSeedFile("[", async (path) => {
      await expect(
        openapi({
          spec: join(
            import.meta.dirname,
            "__fixtures__/petstore-swagger2.json",
          ),
          seed: { pets: path },
        }),
      ).rejects.toMatchObject({
        code: "OPENAPI_INVALID_OPTION",
        message: `Seed file "${path}" for resource "pets" contains invalid JSON`,
      });
    });
  });
});

describe("R11: parser split and ParseContext", () => {
  function context(overrides: Partial<ParseContext> = {}): ParseContext {
    return {
      dialect: "oas3",
      normalize: createSchemaNormalizer(),
      warnings: [],
      ...overrides,
    };
  }

  it("re-exports enrichResolverError from parser.ts", () => {
    expect(parserModule.enrichResolverError).toBe(
      loadDocumentModule.enrichResolverError,
    );
  });

  it("reads parameters only from an array, and body only in Swagger 2.0", () => {
    const oas3 = context();
    expect(extractParameters({ name: "x" }, oas3, "GET /x")).toEqual([]);
    expect(
      extractParameters([{ name: "b", in: "body" }], oas3, "GET /x"),
    ).toEqual([]);
    expect(oas3.warnings).toEqual([
      'GET /x: parameter "b" has unsupported location "body", skipped',
    ]);

    const swagger2 = context({ dialect: "swagger2" });
    expect(
      extractParameters(
        [{ name: "b", in: "body", required: true, schema: { type: "object" } }],
        swagger2,
        "POST /x",
      ),
    ).toMatchObject([{ name: "b", in: "body", required: true }]);
    expect(swagger2.warnings).toEqual([]);
  });

  it("extracts callbacks for OpenAPI 3.x only", () => {
    const operation = {
      callbacks: {
        onEvent: {
          "{$request.body#/url}": {
            post: {
              requestBody: {
                content: {
                  "application/json": { schema: { type: "object" } },
                },
              },
            },
          },
        },
      },
    };
    expect(extractCallbacks(operation, context())).toMatchObject([
      { urlExpression: "{$request.body#/url}", method: "POST" },
    ]);
    expect(
      extractCallbacks(operation, context({ dialect: "swagger2" })),
    ).toBeUndefined();
    expect(extractCallbacks({}, context())).toBeUndefined();
  });

  it("inherits Swagger 2.0 root consumes/produces unless an operation declares its own", async () => {
    const spec = await parserModule.parseSpec({
      swagger: "2.0",
      info: { title: "Root media types", version: "1.0.0" },
      consumes: ["application/xml"],
      produces: ["application/xml"],
      paths: {
        "/inherit": {
          post: {
            parameters: [
              { name: "body", in: "body", schema: { type: "object" } },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
        "/own": {
          post: {
            consumes: ["text/plain"],
            produces: ["Application/JSON; charset=utf-8"],
            parameters: [
              { name: "body", in: "body", schema: { type: "string" } },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    });

    const byPath = new Map(spec.paths.map((path) => [path.path, path]));
    expect([...(byPath.get("/inherit")?.requestContent?.keys() ?? [])]).toEqual(
      ["application/xml"],
    );
    expect(byPath.get("/inherit")?.responses.get(200)?.contentTypes).toEqual([
      "application/xml",
    ]);
    expect([...(byPath.get("/own")?.requestContent?.keys() ?? [])]).toEqual([
      "text/plain",
    ]);
    expect(byPath.get("/own")?.responses.get(200)?.contentTypes).toEqual([
      "application/json",
    ]);
    expect(byPath.get("/own")?.parameters).toEqual([]);
  });

  it("keeps the per-operation warning order: parameters, responses, path template", async () => {
    const spec = await parserModule.parseSpec({
      openapi: "3.0.3",
      info: { title: "Warnings", version: "1.0.0" },
      paths: {
        "/a/{x}{y}": {
          get: {
            parameters: [{ name: "q", in: "nowhere" }],
            responses: { abc: { description: "?" } },
          },
        },
      },
    });

    expect(spec.warnings).toEqual([
      'GET /a/{x}{y}: parameter "q" has unsupported location "nowhere", skipped',
      'GET /a/{x}{y}: response status key "abc" is not recognized, skipped',
      "GET /a/{x}{y}: path parameters {x} and {y} are adjacent, so no request decides where one ends, skipped",
    ]);
    expect(spec.paths).toEqual([]);
  });
});
