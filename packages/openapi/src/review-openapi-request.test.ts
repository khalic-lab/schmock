/// <reference path="../../core/schmock.d.ts" />

import { SchmockError, schmock } from "@schmock/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchCallbacks } from "./callbacks.js";
import type { CrudResource } from "./crud-detector.js";
import type { ParsedCallback } from "./parser.js";
import { openapi } from "./plugin.js";
import { parsePreferHeader } from "./prefer.js";
import {
  CREATE_SUCCESS_STATUS_ORDER,
  findSuccessResponse,
  type ResponseStatusKey,
} from "./response-status.js";
import { assertValidSeedConfig } from "./seed.js";

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

function callback(urlExpression: string): ParsedCallback[] {
  return [{ urlExpression, method: "POST" }];
}

async function dispatchedUrls(
  urlExpression: string,
  context: Schmock.PluginContext,
  response: unknown,
  debug = false,
): Promise<string[]> {
  const urls: string[] = [];
  await dispatchCallbacks(
    callback(urlExpression),
    (request) => {
      urls.push(request.url);
    },
    context,
    response,
    { debug },
  );
  return urls;
}

const petsResource: CrudResource = {
  name: "pets",
  basePath: "/pets",
  itemPath: "/pets/:id",
  idParam: "id",
  idProperty: "id",
  idKind: "integer",
  operations: ["list", "create"],
  routes: [],
  schema: { type: "object", properties: { name: { type: "string" } } },
};

describe("parsePreferHeader (RFC 7240)", () => {
  it("reads several comma-separated directives at once", () => {
    expect(parsePreferHeader("code=404, example=dog")).toEqual({
      code: 404,
      example: "dog",
    });
  });

  it("accepts the bare dynamic token and a case-insensitive true", () => {
    expect(parsePreferHeader("dynamic")).toEqual({ dynamic: true });
    expect(parsePreferHeader("dynamic=TRUE")).toEqual({ dynamic: true });
    expect(parsePreferHeader('dynamic="true"')).toEqual({ dynamic: true });
    expect(parsePreferHeader("dynamic=false")).toEqual({});
  });

  it("matches preference names case-insensitively", () => {
    expect(parsePreferHeader("CODE=404")).toEqual({ code: 404 });
    expect(parsePreferHeader("Example=fluffy")).toEqual({ example: "fluffy" });
  });

  it("keeps the example value's case: example names are case-sensitive keys", () => {
    expect(parsePreferHeader("example=Fluffy")).toEqual({ example: "Fluffy" });
  });

  it("unquotes a quoted-string value, including escapes", () => {
    expect(parsePreferHeader('example="fluffy"')).toEqual({
      example: "fluffy",
    });
    expect(parsePreferHeader('example="a\\"b"')).toEqual({ example: 'a"b' });
  });

  it("does not split a quoted value on a comma or semicolon", () => {
    expect(parsePreferHeader('example="a,b;c", code=201')).toEqual({
      example: "a,b;c",
      code: 201,
    });
  });

  it("drops ;-parameters after the preference value", () => {
    expect(parsePreferHeader("example=fluffy; foo")).toEqual({
      example: "fluffy",
    });
    expect(parsePreferHeader("code=404; x=1")).toEqual({ code: 404 });
  });

  it("tolerates whitespace around the equals sign", () => {
    expect(parsePreferHeader('EXAMPLE = "sample"')).toEqual({
      example: "sample",
    });
  });

  it("ignores an empty example and a non-numeric code", () => {
    expect(parsePreferHeader('example=""')).toEqual({});
    expect(parsePreferHeader("code=abc")).toEqual({});
  });

  it("ignores preferences it does not own", () => {
    expect(parsePreferHeader("return=representation, respond-async")).toEqual(
      {},
    );
  });
});

describe("dispatchCallbacks URL expressions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stringifies a numeric response-body value", async () => {
    const urls = await dispatchedUrls(
      "https://hooks.example/pets/{$response.body#/id}",
      makeContext(),
      [201, { id: 7 }],
    );
    expect(urls).toEqual(["https://hooks.example/pets/7"]);
  });

  it("stringifies a boolean request-body value", async () => {
    const urls = await dispatchedUrls(
      "https://hooks.example/flag/{$request.body#/enabled}",
      makeContext({ body: { enabled: false } }),
      undefined,
    );
    expect(urls).toEqual(["https://hooks.example/flag/false"]);
  });

  it("stringifies a number in the query-string form from the OpenAPI example", async () => {
    const urls = await dispatchedUrls(
      "http://notificationServer.com?transactionId={$response.body#/id}&name={$request.body#/name}",
      makeContext({ body: { name: "rex" } }),
      [201, { id: 12 }],
    );
    expect(urls).toEqual([
      "http://notificationServer.com?transactionId=12&name=rex",
    ]);
  });

  it("reads a request header case-insensitively", async () => {
    const urls = await dispatchedUrls(
      "{$request.header.X-Hook}",
      makeContext({ headers: { "X-Hook": "https://hooks.example/a" } }),
      undefined,
    );
    expect(urls).toEqual(["https://hooks.example/a"]);
  });

  it.each([
    [
      "a missing body pointer",
      "{$request.body#/callbackUrl}/x/{$request.body#/missing}",
    ],
    [
      "an object value",
      "{$request.body#/callbackUrl}/x/{$request.body#/nested}",
    ],
    ["a null value", "{$request.body#/callbackUrl}/x/{$request.body#/nothing}"],
    [
      "a missing header",
      "{$request.body#/callbackUrl}/x/{$request.header.x-absent}",
    ],
    [
      "a missing query parameter",
      "{$request.body#/callbackUrl}/x/{$request.query.absent}",
    ],
    [
      "a missing path parameter",
      "{$request.body#/callbackUrl}/x/{$request.path.absent}",
    ],
    [
      "a missing response pointer",
      "{$request.body#/callbackUrl}/x/{$response.body#/absent}",
    ],
  ])(
    "skips the callback on %s, and says why under debug",
    async (_label, expression) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const context = makeContext({
        body: {
          callbackUrl: "https://hooks.example",
          nested: { a: 1 },
          nothing: null,
        },
      });

      expect(
        await dispatchedUrls(expression, context, [201, { id: 1 }]),
      ).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();

      expect(
        await dispatchedUrls(expression, context, [201, { id: 1 }], true),
      ).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain("could not resolve");
    },
  );
});

describe("assertValidSeedConfig", () => {
  it("rejects a key that names no detected resource, listing the resources", () => {
    let caught: unknown;
    try {
      assertValidSeedConfig({ petz: [] }, [petsResource]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchmockError);
    expect(caught).toMatchObject({
      code: "OPENAPI_UNKNOWN_SEED_RESOURCE",
      context: { key: "petz", resources: ["pets"] },
    });
  });

  it("rejects an unknown file-path key before any file is read", () => {
    expect(() =>
      assertValidSeedConfig({ petz: "./does-not-exist.json" }, [petsResource]),
    ).toThrow(/matches no CRUD resource/);
  });

  it.each([
    ["a number", 42],
    ["a string", "./seed.json"],
    ["an array", [{ id: 1 }]],
    ["null", null],
  ])("rejects %s as the whole seed option", (_label, value) => {
    expect(() => assertValidSeedConfig(value, [petsResource])).toThrow(
      expect.objectContaining({
        code: "OPENAPI_INVALID_OPTION",
        message: expect.stringContaining("fakerSeed"),
      }),
    );
  });

  it.each([
    ["a misspelt count", { counts: 3 }],
    ["a number", 3],
    ["null", null],
  ])("rejects %s as a seed entry", (_label, value) => {
    expect(() =>
      assertValidSeedConfig({ pets: value }, [petsResource]),
    ).toThrow(expect.objectContaining({ code: "OPENAPI_INVALID_OPTION" }));
  });

  it("accepts every documented source shape for a known resource", () => {
    expect(() =>
      assertValidSeedConfig({ pets: [] }, [petsResource]),
    ).not.toThrow();
    expect(() =>
      assertValidSeedConfig({ pets: "./pets.json" }, [petsResource]),
    ).not.toThrow();
    expect(() =>
      assertValidSeedConfig({ pets: { count: 2 } }, [petsResource]),
    ).not.toThrow();
  });
});

describe("findSuccessResponse preference order", () => {
  const responses = new Map<ResponseStatusKey, string>([
    [200, "exists"],
    [201, "created"],
  ]);

  it("keeps 200 first by default", () => {
    expect(findSuccessResponse(responses)).toEqual([200, "exists"]);
  });

  it("prefers 201 under the create order", () => {
    expect(findSuccessResponse(responses, CREATE_SUCCESS_STATUS_ORDER)).toEqual(
      [201, "created"],
    );
  });

  it("falls back to 200 under the create order when 201 is not declared", () => {
    const only200 = new Map<ResponseStatusKey, string>([[200, "exists"]]);
    expect(findSuccessResponse(only200, CREATE_SUCCESS_STATUS_ORDER)).toEqual([
      200,
      "exists",
    ]);
  });
});

describe("onSchema context under Prefer on a static route", () => {
  it("passes the template path and the five documented fields", async () => {
    const paths: string[] = [];
    const keys: string[][] = [];
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "Static", version: "1.0.0" },
          paths: {
            "/static/{x}/info": {
              get: {
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: { ok: { type: "boolean" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        onSchema: (_schema, context) => {
          paths.push(context.path);
          keys.push(Object.keys(context).sort());
          return undefined;
        },
      }),
    );

    const response = await mock.handle("GET", "/static/7/info", {
      headers: { prefer: "dynamic=true" },
    });

    expect(response.status).toBe(200);
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths)).toEqual(new Set(["/static/:x/info"]));
    for (const fields of keys) {
      expect(fields).toEqual(["headers", "method", "params", "path", "query"]);
    }
  });
});
