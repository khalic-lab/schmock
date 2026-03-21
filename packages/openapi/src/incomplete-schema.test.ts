/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { openapi } from "./plugin";

/**
 * Probe incomplete/malformed OpenAPI schemas to find blind spots
 * in the pipeline: parser → normalizer → faker → response generation.
 */

// ─── Helpers ───────────────────────────────────────────────────────

function spec3(
  paths: Record<string, unknown>,
  components?: Record<string, unknown>,
) {
  return {
    openapi: "3.0.3",
    info: { title: "Probe", version: "0.0.1" },
    paths,
    ...(components ? { components } : {}),
  };
}

async function probe(
  specObj: object,
  method: string,
  path: string,
  body?: unknown,
  openapiOpts?: Partial<import("./plugin").OpenApiOptions>,
) {
  const mock = schmock({ state: {} });
  mock.pipe(await openapi({ spec: specObj, ...openapiOpts }));
  return mock.handle(method as Schmock.HttpMethod, path, { body });
}

async function probeWithHeaders(
  specObj: object,
  method: string,
  path: string,
  headers: Record<string, string>,
  openapiOpts?: Partial<import("./plugin").OpenApiOptions>,
) {
  const mock = schmock({ state: {} });
  mock.pipe(await openapi({ spec: specObj, ...openapiOpts }));
  return mock.handle(method as Schmock.HttpMethod, path, { headers });
}

// ═══════════════════════════════════════════════════════════════════
// 1. Missing / empty structures
// ═══════════════════════════════════════════════════════════════════

describe("Incomplete specs: missing structures", () => {
  it("spec with empty paths object registers no routes", async () => {
    const res = await probe(spec3({}), "GET", "/anything");
    expect(res.status).toBe(404);
  });

  it("operation with no responses object", async () => {
    const res = await probe(spec3({ "/items": { get: {} } }), "GET", "/items");
    // Should still register the route, not crash
    expect([200, 404]).toContain(res.status);
  });

  it("response with no content/schema", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: { "200": { description: "OK" } },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
    // Body should be null or empty — no schema to generate from
    expect(
      res.body === null ||
        res.body === undefined ||
        (typeof res.body === "object" && Object.keys(res.body).length === 0),
    ).toBe(true);
  });

  it("response with empty schema object", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": { schema: {} },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
  });

  it("property with no type", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        name: {},
                        age: { description: "no type here" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
  });

  it("object with no properties key", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("object");
  });

  it("array with no items", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "array" },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Composition edge cases
// ═══════════════════════════════════════════════════════════════════

describe("Incomplete specs: composition edge cases", () => {
  it("empty allOf array", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { allOf: [] },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
  });

  it("empty oneOf array", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { oneOf: [] },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
  });

  it("empty anyOf array", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { anyOf: [] },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
  });

  it("allOf with one empty branch", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      allOf: [
                        {
                          type: "object",
                          properties: { id: { type: "integer" } },
                        },
                        {},
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("object");
  });

  it("discriminator with missing propertyName", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      discriminator: {},
                      oneOf: [
                        {
                          type: "object",
                          properties: { x: { type: "string" } },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
  });

  it("enum with empty array", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        status: { type: "string", enum: [] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Type edge cases
// ═══════════════════════════════════════════════════════════════════

describe("Incomplete specs: type edge cases", () => {
  it("invalid type keyword", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "banana" },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    // Should not crash — may return empty or 200 with fallback
    expect(res.status).toBe(200);
  });

  it("property with type as array (OpenAPI 3.1 style)", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        value: { type: ["string", "null"] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
  });

  it("required lists non-existent property", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["ghost"],
                      properties: {
                        name: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("object");
  });

  it("additionalProperties: true", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      additionalProperties: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
  });

  it("additionalProperties: false with no properties", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      additionalProperties: false,
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("object");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Spec-level edge cases
// ═══════════════════════════════════════════════════════════════════

describe("Incomplete specs: spec-level edge cases", () => {
  it("missing info object", async () => {
    const res = await probe(
      {
        openapi: "3.0.3",
        paths: {
          "/x": {
            get: {
              responses: {
                "200": {
                  description: "OK",
                  content: {
                    "application/json": { schema: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
      "GET",
      "/x",
    );
    expect(res.status).toBe(200);
  });

  it("only 'default' response code (no numeric)", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              default: {
                description: "fallback",
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
      }),
      "GET",
      "/items",
    );
    // 'default' is skipped by parser — route may register with no responses
    expect([200, 404]).toContain(res.status);
  });

  it("path with no operations (empty object)", async () => {
    const res = await probe(spec3({ "/empty": {} }), "GET", "/empty");
    expect(res.status).toBe(404);
  });

  it("non-JSON content type only", async () => {
    const res = await probe(
      spec3({
        "/file": {
          get: {
            responses: {
              "200": {
                description: "A file",
                content: {
                  "application/octet-stream": {
                    schema: { type: "string", format: "binary" },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/file",
    );
    expect([200, 404]).toContain(res.status);
  });

  it("POST with requestBody but no schema", async () => {
    const res = await probe(
      spec3({
        "/items": {
          post: {
            requestBody: {
              content: { "application/json": {} },
            },
            responses: {
              "201": {
                description: "Created",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { id: { type: "integer" } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "POST",
      "/items",
      { name: "test" },
    );
    // Should not crash on missing requestBody schema
    expect([200, 201, 404]).toContain(res.status);
  });

  it("deeply nested schema (10 levels)", async () => {
    let schema: any = { type: "string" };
    for (let i = 0; i < 10; i++) {
      schema = { type: "object", properties: { nested: schema } };
    }

    const res = await probe(
      spec3({
        "/deep": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: { "application/json": { schema } },
              },
            },
          },
        },
      }),
      "GET",
      "/deep",
    );
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("object");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. CRUD detection edge cases
// ═══════════════════════════════════════════════════════════════════

describe("Incomplete specs: CRUD edge cases", () => {
  it("collection path with POST but no GET", async () => {
    const res = await probe(
      spec3({
        "/items": {
          post: {
            responses: {
              "201": {
                description: "Created",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { id: { type: "integer" } },
                    },
                  },
                },
              },
            },
          },
        },
        "/items/{id}": {
          get: {
            parameters: [
              { name: "id", in: "path", schema: { type: "integer" } },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        name: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "POST",
      "/items",
      { name: "test" },
    );
    expect([200, 201]).toContain(res.status);
  });

  it("item path exists but collection path has no array response", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { count: { type: "integer" } },
                    },
                  },
                },
              },
            },
          },
        },
        "/items/{id}": {
          get: {
            parameters: [
              { name: "id", in: "path", schema: { type: "integer" } },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { id: { type: "integer" } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
    );
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. schemas option (runtime schema patching)
// ═══════════════════════════════════════════════════════════════════

describe("schemas option", () => {
  it("patches response schema for route with empty schema", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: { "application/json": { schema: {} } },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
      undefined,
      {
        schemas: {
          "GET /items": {
            type: "object",
            properties: { id: { type: "integer" }, name: { type: "string" } },
          },
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("name");
  });

  it("patches specific status code response", async () => {
    const res = await probeWithHeaders(
      spec3({
        "/items": {
          post: {
            responses: {
              "201": {
                description: "Created",
                content: { "application/json": { schema: {} } },
              },
            },
          },
        },
      }),
      "POST",
      "/items",
      { prefer: "code=201" },
      {
        schemas: {
          "POST /items 201": {
            type: "object",
            properties: {
              id: { type: "integer" },
              created: { type: "boolean" },
            },
          },
        },
      },
    );
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("created");
  });

  it("creates 200 response entry when route has no 2xx responses", async () => {
    const res = await probe(
      spec3({
        "/health": {
          get: {
            responses: {
              "500": { description: "Error" },
            },
          },
        },
      }),
      "GET",
      "/health",
      undefined,
      {
        schemas: {
          "GET /health": {
            type: "object",
            properties: { status: { type: "string" } },
          },
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status");
  });

  it("user schema replaces parsed schema entirely", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { old: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
      undefined,
      {
        schemas: {
          "GET /items": {
            type: "object",
            properties: { replaced: { type: "boolean" } },
          },
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("replaced");
    expect(res.body).not.toHaveProperty("old");
  });

  it("works with Prefer: dynamic=true after patching", async () => {
    const res = await probeWithHeaders(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: { "application/json": { schema: {} } },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
      { prefer: "dynamic=true" },
      {
        schemas: {
          "GET /items": {
            type: "object",
            properties: { fresh: { type: "integer" } },
          },
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("fresh");
  });

  it("ignores schemas for routes not in the spec", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { a: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
      undefined,
      {
        schemas: {
          "GET /nonexistent": {
            type: "object",
            properties: { x: { type: "string" } },
          },
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("a");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. onSchema callback (runtime schema hook)
// ═══════════════════════════════════════════════════════════════════

describe("onSchema callback", () => {
  it("returned schema replaces original for generation", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { old: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
      undefined,
      {
        onSchema: () => ({
          type: "object",
          properties: { patched: { type: "boolean" } },
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("patched");
    expect(res.body).not.toHaveProperty("old");
  });

  it("void return keeps original schema", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { original: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
      undefined,
      {
        onSchema: () => undefined,
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("original");
  });

  it("receives correct path and method in context", async () => {
    let capturedCtx: { method: string; path: string } | undefined;
    await probe(
      spec3({
        "/users": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { id: { type: "integer" } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/users",
      undefined,
      {
        onSchema: (_schema, ctx) => {
          capturedCtx = ctx;
        },
      },
    );
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.method).toBe("GET");
    expect(capturedCtx?.path).toBe("/users");
  });

  it("works with Prefer: dynamic=true", async () => {
    const res = await probeWithHeaders(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { old: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
      { prefer: "dynamic=true" },
      {
        onSchema: () => ({
          type: "object",
          properties: { dynamic_patched: { type: "integer" } },
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("dynamic_patched");
  });

  it("works with Prefer: code=N", async () => {
    const res = await probeWithHeaders(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { old: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
      { prefer: "code=200" },
      {
        onSchema: () => ({
          type: "object",
          properties: { code_patched: { type: "boolean" } },
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("code_patched");
  });

  it("works with static (non-Prefer) responses", async () => {
    const res = await probe(
      spec3({
        "/items": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { old: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "GET",
      "/items",
      undefined,
      {
        onSchema: () => ({
          type: "object",
          properties: { static_patched: { type: "number" } },
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("static_patched");
  });
});
