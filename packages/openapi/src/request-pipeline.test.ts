import { SchemaGenerationError, schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { openapi } from "./plugin";
import {
  applyResponseContentType,
  createBodyValidatorContext,
  processContentNegotiation,
  processPreferHeader,
  validateResponse,
} from "./request-pipeline";

function makeContext(
  route: Schmock.RouteConfig,
  headers: Record<string, string>,
): Schmock.PluginContext {
  return {
    path: "/items",
    route,
    method: "GET",
    params: {},
    query: {},
    headers,
    state: new Map(),
    routeState: {},
  };
}

describe("OpenAPI request pipeline regressions", () => {
  it("compiles standard formats, custom OpenAPI formats, and 2020-12 keywords", () => {
    const { ajv } = createBodyValidatorContext();
    const uuid = ajv.compile({ type: "string", format: "uuid" });
    const int64 = ajv.compile({ type: "integer", format: "int64" });
    const tuple = ajv.compile({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: false,
    });

    expect(uuid("5df308c9-4c83-4e63-9fb7-7f8f7a64fa9d")).toBe(true);
    expect(uuid("not-a-uuid")).toBe(false);
    expect(int64(42)).toBe(true);
    expect(tuple(["value", 42])).toBe(true);
    expect(tuple([42, "value"])).toBe(false);
  });

  it("does not negotiate a guessed success status before the outcome is known", () => {
    const responses = new Map([
      [
        200,
        {
          description: "OK",
          contentTypes: ["application/json"],
        },
      ],
      [
        404,
        {
          description: "Missing",
          contentTypes: ["application/problem+json"],
        },
      ],
    ]);
    const context = makeContext(
      { "openapi:responses": responses },
      { accept: "application/problem+json" },
    );

    expect(processContentNegotiation(context)).toBeUndefined();
    expect(processContentNegotiation(context, 404)).toBeUndefined();
    expect(processContentNegotiation(context, 200)?.response).toEqual([
      406,
      {
        error: "Not Acceptable",
        code: "NOT_ACCEPTABLE",
        acceptable: ["application/json"],
      },
    ]);
  });

  it("selects Prefer examples from the negotiated media entry", async () => {
    const responses = new Map([
      [
        200,
        {
          description: "OK",
          contentTypes: ["application/json", "text/plain"],
          content: new Map([
            [
              "application/json",
              { examples: new Map([["example", { media: "json" }]]) },
            ],
            ["text/plain", { examples: new Map([["example", "plain"]]) }],
          ]),
        },
      ],
    ]);
    const context = makeContext(
      { "openapi:responses": responses },
      { accept: "text/plain", prefer: "example=example" },
    );

    const result = await processPreferHeader(context, { original: true });
    expect(result.response).toEqual([200, "plain"]);
  });

  it("does not borrow the JSON schema for a schema-less media entry", async () => {
    const responses = new Map([
      [
        200,
        {
          schema: {
            type: "object",
            properties: { jsonOnly: { type: "string", const: "json" } },
          },
          description: "OK",
          contentTypes: ["application/json", "text/plain"],
          content: new Map([
            [
              "application/json",
              {
                schema: {
                  type: "object",
                  properties: {
                    jsonOnly: { type: "string", const: "json" },
                  },
                },
              },
            ],
            ["text/plain", {}],
          ]),
        },
      ],
    ]);
    const context = makeContext(
      { "openapi:responses": responses },
      { accept: "text/plain", prefer: "code=200" },
    );

    const result = await processPreferHeader(context, { original: true });
    expect(result.response).toEqual([200, {}]);
  });

  it("throws instead of returning an empty body when Prefer: dynamic generation fails", async () => {
    const responses = new Map([
      [200, { schema: { anyOf: [] }, description: "OK" }],
    ]);
    const context = makeContext(
      { "openapi:responses": responses },
      { prefer: "dynamic=true" },
    );

    // Same rule as the static generator. End to end the pipeline wraps this as
    // PLUGIN_ERROR; called directly the SchemaGenerationError surfaces raw, with
    // the route in its message.
    await expect(
      processPreferHeader(context, { original: true }),
    ).rejects.toThrow(SchemaGenerationError);
    await expect(
      processPreferHeader(context, { original: true }),
    ).rejects.toThrow(/GET \/items/);
  });

  // Core does NOT normalize header case at `mock.handle`, so an all-caps header
  // from a direct-API caller has to negotiate exactly like a lowercase one. The
  // two ad-hoc `headers.accept ?? headers.Accept` lookups these pin replaced
  // missed every other casing.
  it("negotiates an all-caps ACCEPT header", () => {
    const responses = new Map([
      [200, { description: "OK", contentTypes: ["application/json"] }],
    ]);

    expect(
      processContentNegotiation(
        makeContext(
          { "openapi:responses": responses },
          { ACCEPT: "application/json" },
        ),
        200,
      ),
    ).toBeUndefined();

    expect(
      processContentNegotiation(
        makeContext(
          { "openapi:responses": responses },
          { ACCEPT: "application/xml" },
        ),
        200,
      )?.response,
    ).toEqual([
      406,
      {
        error: "Not Acceptable",
        code: "NOT_ACCEPTABLE",
        acceptable: ["application/json"],
      },
    ]);
  });

  it("honours an all-caps PREFER header", async () => {
    const responses = new Map([
      [200, { description: "OK" }],
      [
        201,
        {
          description: "Created",
          schema: {
            type: "object",
            properties: { made: { type: "string", const: "yes" } },
          },
        },
      ],
    ]);
    const context = makeContext(
      { "openapi:responses": responses },
      { PREFER: "code=201" },
    );

    const result = await processPreferHeader(context, { original: true });
    expect(result.response).toEqual([201, { made: "yes" }]);
  });

  it("preserves explicit Content-Type parameters during Accept checks", () => {
    const responses = profileResponses();
    const context = makeContext(
      { "openapi:responses": responses },
      { accept: "application/json;profile=b" },
    );
    const response = [
      200,
      { profile: "b" },
      { "content-type": "application/json;profile=b" },
    ] satisfies [number, unknown, Record<string, string>];

    expect(applyResponseContentType(context, response)).toEqual({
      response,
      rejected: false,
    });
  });

  it("validates an explicit parameterized Content-Type against its profile schema", () => {
    const context = makeContext(
      { "openapi:responses": profileResponses() },
      {},
    );
    const response = [
      200,
      { profile: "b" },
      { "content-type": "application/json;profile=b" },
    ] satisfies [number, unknown, Record<string, string>];

    expect(
      validateResponse(context, response, createBodyValidatorContext()),
    ).toBeUndefined();
  });

  it("validates against an exact key before an earlier wildcard declaration", () => {
    const schema = (source: string): Schmock.JSONSchema7 => ({
      type: "object",
      properties: { source: { type: "string", const: source } },
      required: ["source"],
    });
    const responses = new Map([
      [
        200,
        {
          description: "OK",
          contentTypes: ["application/*", "application/json"],
          content: new Map([
            ["application/*", { schema: schema("wildcard") }],
            ["application/json", { schema: schema("exact") }],
          ]),
        },
      ],
    ]);
    const context = makeContext(
      { "openapi:responses": responses },
      { accept: "application/json" },
    );

    expect(
      validateResponse(
        context,
        [200, { source: "exact" }],
        createBodyValidatorContext(),
      ),
    ).toBeUndefined();
  });
});

function profileResponses(): Map<
  number,
  import("./parser").ParsedResponseEntry
> {
  const schema = (profile: string): Schmock.JSONSchema7 => ({
    type: "object",
    properties: { profile: { type: "string", const: profile } },
    required: ["profile"],
  });
  return new Map([
    [
      200,
      {
        description: "OK",
        contentTypes: [
          "application/json;profile=a",
          "application/json;profile=b",
        ],
        content: new Map([
          ["application/json;profile=a", { schema: schema("a") }],
          ["application/json;profile=b", { schema: schema("b") }],
        ]),
      },
    ],
  ]);
}

/** Build an /items collection whose POST declares the given request media types. */
function specWithRequestContent(
  content: Record<string, unknown>,
): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: { title: "Media types", version: "1.0.0" },
    paths: {
      "/items": {
        get: {
          responses: {
            "200": {
              description: "List",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        itemId: { type: "integer" },
                        a: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          requestBody: { required: true, content },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      itemId: { type: "integer" },
                      a: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

const jsonAndXml = {
  "application/json": {
    schema: {
      type: "object",
      required: ["a"],
      properties: { a: { type: "string" } },
    },
  },
  "application/xml": {
    schema: {
      type: "object",
      required: ["b"],
      properties: { b: { type: "string" } },
    },
  },
};

async function mockFor(
  content: Record<string, unknown>,
  validateRequests = true,
): Promise<Schmock.CallableMockInstance> {
  const mock = schmock({ state: {} });
  mock.pipe(
    await openapi({ spec: specWithRequestContent(content), validateRequests }),
  );
  return mock;
}

describe("request media type selection", () => {
  it("rejects an undeclared content type with 415 and does not run the generator", async () => {
    const mock = await mockFor(jsonAndXml);

    const rejected = await mock.handle("POST", "/items", {
      body: { a: "value" },
      headers: { "content-type": "text/csv" },
    });

    expect(rejected.status).toBe(415);
    const body = rejected.body as Record<string, unknown>;
    expect(body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(body.supported).toEqual(
      expect.arrayContaining(["application/json", "application/xml"]),
    );

    const list = await mock.handle("GET", "/items");
    expect(list.body).toEqual([]);
  });

  it("validates against the schema of the declared media type, not the JSON one", async () => {
    const mock = await mockFor(jsonAndXml);

    const rejected = await mock.handle("POST", "/items", {
      body: { a: "value" },
      headers: { "content-type": "application/xml" },
    });

    expect(rejected.status).toBe(400);
    const body = rejected.body as { code: string; details: unknown };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(body.details)).toContain("b");
  });

  it("falls back to the JSON-ish schema when the request declares no content type", async () => {
    const mock = await mockFor(jsonAndXml);

    const created = await mock.handle("POST", "/items", {
      body: { a: "value" },
    });

    expect(created.status).toBe(201);
  });

  it("tolerates media type parameters", async () => {
    const mock = await mockFor(jsonAndXml);

    const created = await mock.handle("POST", "/items", {
      body: { a: "value" },
      headers: { "content-type": "application/json; charset=utf-8" },
    });

    expect(created.status).toBe(201);
  });

  it("honours a */* wildcard for any content type", async () => {
    const mock = await mockFor({
      "*/*": { schema: { type: "object" } },
    });

    const created = await mock.handle("POST", "/items", {
      body: { a: "value" },
      headers: { "content-type": "text/csv" },
    });

    expect(created.status).toBe(201);
  });

  it("honours a type/* wildcard only within its own type", async () => {
    const mock = await mockFor({
      "application/*": { schema: { type: "object" } },
    });

    const accepted = await mock.handle("POST", "/items", {
      body: { a: "value" },
      headers: { "content-type": "application/xml" },
    });
    expect(accepted.status).toBe(201);

    const rejected = await mock.handle("POST", "/items", {
      body: { a: "value" },
      headers: { "content-type": "text/csv" },
    });
    expect(rejected.status).toBe(415);
  });

  it("does not emit 415 when request validation is off", async () => {
    const mock = await mockFor(jsonAndXml, false);

    const created = await mock.handle("POST", "/items", {
      body: { a: "value" },
      headers: { "content-type": "text/csv" },
    });

    expect(created.status).toBe(201);
  });
});
