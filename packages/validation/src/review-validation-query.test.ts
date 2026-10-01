import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { type ValidationPluginOptions, validationPlugin } from "./index";

function context(
  overrides: Partial<Schmock.PluginContext> = {},
): Schmock.PluginContext {
  return {
    path: "/test",
    route: {},
    method: "GET",
    params: {},
    query: {},
    headers: {},
    state: new Map(),
    ...overrides,
  };
}

async function runBeforeRequest(
  plugin: Schmock.Plugin,
  pluginContext: Schmock.PluginContext,
): Promise<Schmock.PluginResult> {
  if (!plugin.beforeRequest) {
    throw new Error("Expected validation plugin to define beforeRequest");
  }
  const result = await plugin.beforeRequest(pluginContext);
  if (!result) {
    throw new Error("Expected beforeRequest to return a plugin result");
  }
  return result;
}

function creationError(options: ValidationPluginOptions): unknown {
  try {
    validationPlugin(options);
  } catch (error) {
    return error;
  }
  return undefined;
}

type ResponseRules = NonNullable<ValidationPluginOptions["response"]>;

const idSchema: ResponseRules["body"] = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer" } },
};

describe("validationPlugin response.statuses", () => {
  it("validates every status when statuses is omitted", async () => {
    const plugin = validationPlugin({ response: { body: idSchema } });
    const result = await plugin.process(
      context({ requestShortCircuited: true }),
      [403, { error: "forbidden" }],
    );
    expect(result.response).toMatchObject({
      status: 500,
      body: { code: "RESPONSE_VALIDATION_ERROR" },
    });
  });

  it("passes a short-circuited 4xx envelope through under 2xx scope", async () => {
    const plugin = validationPlugin({
      response: { body: idSchema, statuses: "2xx" },
    });
    const rejection = { status: 403, body: { code: "FORBIDDEN" } };
    const result = await plugin.process(
      context({ requestShortCircuited: true }),
      rejection,
    );
    expect(result.response).toBe(rejection);
  });

  it("treats a plain body as 200 and an absent body as 204", async () => {
    const only204 = validationPlugin({
      response: { body: { type: "null" }, statuses: [204] },
    });
    const plain = await only204.process(context(), { anything: true });
    expect(plain.response).toEqual({ anything: true });
    const absent = await only204.process(context(), undefined);
    expect(absent.response).toMatchObject({
      status: 500,
      body: { code: "RESPONSE_VALIDATION_ERROR" },
    });
  });

  it("uses the tuple status even when the tuple body is absent", async () => {
    const plugin = validationPlugin({
      response: { body: idSchema, statuses: "2xx" },
    });
    const result = await plugin.process(context(), [500, undefined]);
    expect(result.response).toEqual([500, undefined]);
  });

  it("snapshots the status list when the plugin is created", async () => {
    const statuses = [201];
    const plugin = validationPlugin({
      response: { body: idSchema, statuses },
    });
    statuses.push(200);
    const result = await plugin.process(context(), { id: "x" });
    expect(result.response).toEqual({ id: "x" });
  });

  it.each([
    ["an empty list", []],
    ["a status below 100", [99]],
    ["a status above 599", [600]],
    ["a fractional status", [200.5]],
    ["a non-numeric entry", ["200"]],
    ["an unknown keyword", "4xx"],
    ["null", null],
  ])("rejects %s at creation time", (_, statuses) => {
    const responseRules: ResponseRules = { body: idSchema };
    Reflect.set(responseRules, "statuses", statuses);
    expect(creationError({ response: responseRules })).toMatchObject({
      code: "VALIDATION_CONFIG_INVALID",
      context: { option: "response.statuses" },
    });
  });
});

describe("validationPlugin header name case", () => {
  it("applies a capitalized dependencies entry to the lowercased header", async () => {
    const plugin = validationPlugin({
      request: {
        headers: {
          type: "object",
          dependencies: { "X-Api-Key": ["X-Client-Id"] },
        },
      },
    });
    const missing = await runBeforeRequest(
      plugin,
      context({ headers: { "x-api-key": "abcdefghij" } }),
    );
    expect(missing.response).toMatchObject({
      status: 400,
      body: { code: "HEADER_VALIDATION_ERROR" },
    });
    const present = await runBeforeRequest(
      plugin,
      context({
        headers: { "x-api-key": "abcdefghij", "x-client-id": "client" },
      }),
    );
    expect(present.response).toBeUndefined();
  });

  it("matches capitalized names declared behind a local $ref", async () => {
    const plugin = validationPlugin({
      request: {
        headers: {
          $ref: "#/definitions/Headers",
          definitions: {
            Headers: {
              type: "object",
              properties: { "X-Api-Key": { type: "string", minLength: 8 } },
              required: ["X-Api-Key"],
            },
          },
        },
      },
    });
    const valid = await runBeforeRequest(
      plugin,
      context({ headers: { "X-API-KEY": "abcdefghij" } }),
    );
    expect(valid.response).toBeUndefined();
    const short = await runBeforeRequest(
      plugin,
      context({ headers: { "x-api-key": "short" } }),
    );
    expect(short.response).toMatchObject({ status: 400 });
  });

  it("accepts a capitalized property under additionalProperties false", async () => {
    const plugin = validationPlugin({
      request: {
        headers: {
          type: "object",
          properties: { "Content-Type": { const: "application/json" } },
          additionalProperties: false,
        },
      },
    });
    const result = await runBeforeRequest(
      plugin,
      context({ headers: { "content-type": "application/json" } }),
    );
    expect(result.response).toBeUndefined();
  });

  it("rejects a required name that differs only by case from a property", () => {
    expect(
      creationError({
        request: {
          headers: {
            type: "object",
            properties: { "x-api-key": { type: "string" } },
            required: ["X-Api-Key"],
          },
        },
      }),
    ).toMatchObject({
      code: "VALIDATION_CONFIG_INVALID",
      context: { option: "request.headers" },
    });
  });

  it("does not rewrite the caller's header schema", () => {
    const headers = {
      type: "object" as const,
      properties: { "X-Api-Key": { type: "string" as const } },
      required: ["X-Api-Key"],
    };
    validationPlugin({ request: { headers } });
    expect(Object.keys(headers.properties)).toEqual(["X-Api-Key"]);
    expect(headers.required).toEqual(["X-Api-Key"]);
  });

  it("ignores case-colliding names inside header property schemas", () => {
    expect(
      creationError({
        request: {
          headers: {
            type: "object",
            properties: {
              "x-meta": {
                type: "string",
                not: { type: "object", properties: { ID: {}, id: {} } },
              },
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("still rejects a case collision reached through a $ref", () => {
    expect(
      creationError({
        request: {
          headers: {
            allOf: [{ $ref: "#/$defs/Auth" }],
            properties: { "x-api-key": { type: "string" } },
            $defs: {
              Auth: { type: "object", required: ["X-Api-Key"] },
            },
          },
        },
      }),
    ).toMatchObject({
      code: "VALIDATION_CONFIG_INVALID",
      context: { option: "request.headers" },
    });
  });

  const shortKey = {
    type: "object" as const,
    properties: { "X-Api-Key": { type: "string" as const, minLength: 8 } },
  };

  it.each<[string, ValidationPluginOptions["request"]]>([
    ["anyOf", { headers: { anyOf: [shortKey] } }],
    ["oneOf", { headers: { oneOf: [shortKey] } }],
    [
      "then",
      {
        headers: {
          if: { type: "object" },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
          then: shortKey,
        },
      },
    ],
    ["else", { headers: { if: false, else: shortKey } }],
    ["not", { headers: { not: { required: ["X-Api-Key"] } } }],
    [
      "a schema-form dependency",
      { headers: { dependencies: { "x-a": shortKey } } },
    ],
  ])("matches a capitalized name declared under %s", async (_, request) => {
    const plugin = validationPlugin({ request });
    const result = await runBeforeRequest(
      plugin,
      context({ headers: { "x-a": "1", "x-api-key": "short" } }),
    );
    expect(result.response).toMatchObject({
      status: 400,
      body: { code: "HEADER_VALIDATION_ERROR" },
    });
  });

  it("rejects a case collision reached through anyOf", () => {
    expect(
      creationError({
        request: {
          headers: {
            anyOf: [{ type: "object", required: ["X-Api-Key"] }],
            properties: { "x-api-key": { type: "string" } },
          },
        },
      }),
    ).toMatchObject({
      code: "VALIDATION_CONFIG_INVALID",
      context: { option: "request.headers" },
    });
  });

  it("matches capitalized names from another slot's $id resource", async () => {
    const plugin = validationPlugin({
      request: {
        body: {
          $id: "https://example.test/shared.json",
          type: "object",
          definitions: {
            Headers: {
              type: "object",
              properties: { "X-Api-Key": { type: "string", minLength: 8 } },
              required: ["X-Api-Key"],
            },
          },
        },
        headers: {
          $ref: "https://example.test/shared.json#/definitions/Headers",
        },
      },
    });
    const valid = await runBeforeRequest(
      plugin,
      context({ headers: { "x-api-key": "abcdefghij" } }),
    );
    expect(valid.response).toBeUndefined();
    const short = await runBeforeRequest(
      plugin,
      context({ headers: { "x-api-key": "short" } }),
    );
    expect(short.response).toMatchObject({ status: 400 });
  });
});

describe("validationPlugin header names behind $ref corners", () => {
  const apiKeyHeaders = {
    type: "object" as const,
    required: ["X-Api-Key"],
    properties: { "X-Api-Key": { type: "string" as const, minLength: 8 } },
  };

  async function expectKeyedBySchemaSpelling(
    request: ValidationPluginOptions["request"],
  ): Promise<void> {
    const plugin = validationPlugin({ request });
    const valid = await runBeforeRequest(
      plugin,
      context({ headers: { "x-api-key": "abcdefghij" } }),
    );
    expect(valid.response).toBeUndefined();
    const short = await runBeforeRequest(
      plugin,
      context({ headers: { "x-api-key": "short" } }),
    );
    expect(short.response).toMatchObject({
      status: 400,
      body: { code: "HEADER_VALIDATION_ERROR" },
    });
  }

  it("follows a whole-resource $ref without a fragment", async () => {
    await expectKeyedBySchemaSpelling({
      body: { $id: "https://example.test/hdr.json", ...apiKeyHeaders },
      headers: { $ref: "https://example.test/hdr.json" },
    });
  });

  it("resolves a relative $ref against the header schema's own $id", async () => {
    await expectKeyedBySchemaSpelling({
      headers: {
        $id: "https://example.test/h/root.json",
        allOf: [{ $ref: "defs.json#/definitions/Headers" }],
        definitions: {
          Defs: {
            $id: "defs.json",
            definitions: { Headers: apiKeyHeaders },
          },
        },
      },
    });
  });

  it("skips a $ref whose target is a boolean schema", async () => {
    await expectKeyedBySchemaSpelling({
      headers: {
        ...apiKeyHeaders,
        allOf: [{ $ref: "#/definitions/Anything" }],
        definitions: { Anything: true },
      },
    });
  });

  it.each([
    ["a missing local definition", "#/definitions/missing"],
    ["an unknown resource", "https://example.test/nope.json"],
  ])("leaves an unresolvable $ref to Ajv (%s)", (_, ref) => {
    const error = creationError({
      request: {
        headers: { ...apiKeyHeaders, allOf: [{ $ref: ref }] },
      },
    });
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).toMatchObject({
      message: expect.stringContaining(`can't resolve reference ${ref}`),
    });
  });
});

describe("validationPlugin header names seen by name keywords", () => {
  const schema = {
    type: "object" as const,
    properties: { "X-Api-Key": { type: "string" as const } },
    patternProperties: { "^x-": { type: "string" as const, maxLength: 12 } },
  };

  it("applies a lowercase patternProperties key to undeclared headers", async () => {
    const plugin = validationPlugin({ request: { headers: schema } });
    const result = await runBeforeRequest(
      plugin,
      context({ headers: { "X-Trace-Id": "0123456789abc" } }),
    );
    expect(result.response).toMatchObject({
      status: 400,
      body: { details: [{ instancePath: "/x-trace-id" }] },
    });
  });

  it("keys a declared header by the schema's spelling for patternProperties", async () => {
    const plugin = validationPlugin({ request: { headers: schema } });
    const result = await runBeforeRequest(
      plugin,
      context({ headers: { "x-api-key": "0123456789abcdefghijklmno" } }),
    );
    expect(result.response).toBeUndefined();
  });
});

describe("validationPlugin query and header coercion", () => {
  it("does not mutate the request query while coercing", async () => {
    const plugin = validationPlugin({
      request: {
        query: {
          type: "object",
          properties: {
            page: { type: "integer" },
            active: { type: "boolean" },
          },
        },
      },
    });
    const query = { page: "2", active: "true" };
    const result = await runBeforeRequest(plugin, context({ query }));
    expect(result.response).toBeUndefined();
    expect(query).toEqual({ page: "2", active: "true" });
    expect(result.context.query).toEqual({ page: "2", active: "true" });
  });

  it("applies numeric range keywords to query values", async () => {
    const mock = schmock();
    mock("GET /items", [{ id: 1 }]).pipe(
      validationPlugin({
        request: {
          query: {
            type: "object",
            properties: { limit: { type: "number", maximum: 50 } },
          },
        },
      }),
    );
    const accepted = await mock.handle("GET", "/items", {
      query: { limit: "25" },
    });
    const rejected = await mock.handle("GET", "/items", {
      query: { limit: "51" },
    });
    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(400);
  });

  const numberQuery = validationPlugin({
    request: {
      query: {
        type: "object",
        properties: {
          count: { type: "number" },
          flag: { type: "boolean" },
        },
      },
    },
  });

  it.each([
    "Infinity",
    "-Infinity",
    "1e400",
    "1".repeat(400),
    "0x10",
    "0b11",
    "0o7",
    "1e1",
    " 7 ",
    "+5",
    ".5",
  ])("rejects %j, which a route would read differently", async (count) => {
    const result = await runBeforeRequest(
      numberQuery,
      context({ query: { count } }),
    );
    expect(result.response).toMatchObject({
      status: 400,
      body: {
        code: "QUERY_VALIDATION_ERROR",
        details: [
          {
            instancePath: "/count",
            keyword: "type",
            params: { value: count },
          },
        ],
      },
    });
  });

  it.each(["0", "-3", "2.5", "007"])(
    "accepts the plain decimal %j",
    async (count) => {
      const result = await runBeforeRequest(
        numberQuery,
        context({ query: { count } }),
      );
      expect(result.response).toBeUndefined();
    },
  );

  it("leaves non-numeric coercions alone", async () => {
    const result = await runBeforeRequest(
      numberQuery,
      context({ query: { flag: "true", extra: "Infinity" } }),
    );
    expect(result.response).toBeUndefined();
  });

  it("escapes the header name in the error path", async () => {
    const plugin = validationPlugin({
      request: {
        headers: {
          type: "object",
          properties: { "x-a/b~c": { type: "integer" } },
        },
      },
    });
    const result = await runBeforeRequest(
      plugin,
      context({ headers: { "x-a/b~c": "Infinity" } }),
    );
    expect(result.response).toMatchObject({
      status: 400,
      body: {
        code: "HEADER_VALIDATION_ERROR",
        details: [{ instancePath: "/x-a~1b~0c" }],
      },
    });
  });

  it("keeps request bodies strictly typed", async () => {
    const plugin = validationPlugin({
      request: {
        body: {
          type: "object",
          properties: { count: { type: "integer" } },
        },
      },
    });
    const result = await runBeforeRequest(
      plugin,
      context({ method: "POST", body: { count: "3" } }),
    );
    expect(result.response).toMatchObject({
      status: 400,
      body: { code: "REQUEST_VALIDATION_ERROR" },
    });
  });

  it("keeps response bodies strictly typed", async () => {
    const plugin = validationPlugin({ response: { body: idSchema } });
    const result = await plugin.process(context(), { id: "1" });
    expect(result.response).toMatchObject({
      status: 500,
      body: { code: "RESPONSE_VALIDATION_ERROR" },
    });
  });
});
