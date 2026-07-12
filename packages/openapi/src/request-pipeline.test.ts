import { describe, expect, it } from "vitest";
import {
  createBodyValidatorContext,
  processContentNegotiation,
  processPreferHeader,
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
});
