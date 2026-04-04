/// <reference path="../../packages/core/schmock.d.ts" />

import { schmock, SchemaValidationError } from "@schmock/core";
import { fakerPlugin } from "@schmock/faker";
import { queryPlugin } from "@schmock/query";
import { validationPlugin } from "@schmock/validation";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const userSchema: Schmock.JSONSchema7 = {
  type: "object",
  required: ["id", "name", "age"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    age: { type: "integer", minimum: 0, maximum: 120 },
  },
};

const userArraySchema: Schmock.JSONSchema7 = {
  type: "array",
  items: userSchema,
};

// ---------------------------------------------------------------------------
// Faker Plugin — standalone
// ---------------------------------------------------------------------------

describe("Faker Plugin (standalone)", () => {
  let mock: Schmock.CallableMockInstance;

  afterEach(() => {
    mock?.close();
  });

  it("generates data matching the JSON Schema shape", async () => {
    mock = schmock({ state: {} });
    mock("GET /users/:id", () => undefined, {});
    mock.pipe(fakerPlugin({ schema: userSchema, seed: 1 }));

    const res = await mock.handle("GET", "/users/42");

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("id");
    expect(body).toHaveProperty("name");
    expect(body).toHaveProperty("age");
    expect(typeof body.id).toBe("number");
    expect(typeof body.name).toBe("string");
    expect(typeof body.age).toBe("number");
  });

  it("count option generates the correct number of array items", async () => {
    mock = schmock({ state: {} });
    mock("GET /users", () => undefined, {});
    mock.pipe(fakerPlugin({ schema: userArraySchema, count: 7, seed: 1 }));

    const res = await mock.handle("GET", "/users");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBe(7);
  });

  it("overrides option injects specific values into generated data", async () => {
    mock = schmock({ state: {} });
    mock("GET /users/:id", () => undefined, {});
    mock.pipe(
      fakerPlugin({
        schema: userSchema,
        seed: 1,
        overrides: { name: "OverriddenName", age: 99 },
      }),
    );

    const res = await mock.handle("GET", "/users/1");

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.name).toBe("OverriddenName");
    expect(body.age).toBe(99);
  });

  it("seed option produces deterministic output", async () => {
    const results: unknown[] = [];

    for (let i = 0; i < 2; i++) {
      const m = schmock({ state: {} });
      m("GET /users/:id", () => undefined, {});
      m.pipe(fakerPlugin({ schema: userSchema, seed: 42 }));
      const res = await m.handle("GET", "/users/1");
      results.push(res.body);
      m.close();
    }

    expect(results[0]).toEqual(results[1]);
  });

  it("invalid schema throws at plugin creation time (fail-fast)", () => {
    expect(() =>
      fakerPlugin({ schema: {} as Schmock.JSONSchema7 }),
    ).toThrow(SchemaValidationError);
  });
});

// ---------------------------------------------------------------------------
// Validation Plugin — standalone
// ---------------------------------------------------------------------------

describe("Validation Plugin (standalone)", () => {
  let mock: Schmock.CallableMockInstance;

  const bodySchema: Schmock.JSONSchema7 = {
    type: "object",
    required: ["name", "age"],
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
    },
  };

  afterEach(() => {
    mock?.close();
  });

  it("valid request body passes through to response", async () => {
    mock = schmock({ state: {} });
    mock("POST /users", (ctx) => [201, ctx.body]);
    mock.pipe(validationPlugin({ request: { body: bodySchema } }));

    const res = await mock.handle("POST", "/users", {
      body: { name: "Alice", age: 30 },
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.name).toBe("Alice");
    expect(body.age).toBe(30);
  });

  it("invalid request body returns 400 with validation error details", async () => {
    mock = schmock({ state: {} });
    mock("POST /users", (ctx) => [201, ctx.body]);
    mock.pipe(validationPlugin({ request: { body: bodySchema } }));

    const res = await mock.handle("POST", "/users", {
      body: { name: "Alice" }, // missing required "age"
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = res.body as Record<string, unknown>;
    expect(body.code).toBe("REQUEST_VALIDATION_ERROR");
    expect(body.details).toBeDefined();
  });

  it("invalid response body returns 500 with validation error details", async () => {
    mock = schmock({ state: {} });
    // Handler returns data that violates the response schema
    mock("GET /users", () => ({ wrong: "shape" }));
    mock.pipe(
      validationPlugin({
        response: { body: { type: "array", items: userSchema } },
      }),
    );

    const res = await mock.handle("GET", "/users");

    expect(res.status).toBe(500);
    const body = res.body as Record<string, unknown>;
    expect(body.code).toBe("RESPONSE_VALIDATION_ERROR");
    expect(body.details).toBeDefined();
  });

  it("query parameter validation works", async () => {
    mock = schmock({ state: {} });
    mock("GET /search", () => [200, []]);
    mock.pipe(
      validationPlugin({
        request: {
          query: {
            type: "object",
            required: ["q"],
            properties: {
              q: { type: "string", minLength: 1 },
            },
          },
        },
      }),
    );

    // Missing required "q"
    const bad = await mock.handle("GET", "/search", { query: {} });
    expect(bad.status).toBe(400);
    expect((bad.body as any).code).toBe("QUERY_VALIDATION_ERROR");

    // Valid query
    const good = await mock.handle("GET", "/search", {
      query: { q: "hello" },
    });
    expect(good.status).toBe(200);
  });

  it("header validation with case normalization works", async () => {
    mock = schmock({ state: {} });
    mock("GET /protected", () => [200, { ok: true }]);
    mock.pipe(
      validationPlugin({
        request: {
          headers: {
            type: "object",
            required: ["authorization"],
            properties: {
              authorization: { type: "string" },
            },
          },
        },
      }),
    );

    // Missing authorization header
    const bad = await mock.handle("GET", "/protected", { headers: {} });
    expect(bad.status).toBe(400);
    expect((bad.body as any).code).toBe("HEADER_VALIDATION_ERROR");

    // Authorization provided with mixed case (should be normalized)
    const good = await mock.handle("GET", "/protected", {
      headers: { Authorization: "Bearer token123" },
    });
    expect(good.status).toBe(200);
  });

  it("custom error status codes (requestErrorStatus, responseErrorStatus)", async () => {
    mock = schmock({ state: {} });
    mock("POST /items", (ctx) => [201, ctx.body]);
    mock.pipe(
      validationPlugin({
        request: { body: bodySchema },
        response: {
          body: {
            type: "object",
            required: ["name", "age"],
            properties: {
              name: { type: "string" },
              age: { type: "integer" },
            },
          },
        },
        requestErrorStatus: 422,
        responseErrorStatus: 502,
      }),
    );

    // Invalid request -> custom 422
    const reqErr = await mock.handle("POST", "/items", {
      body: { name: 123 }, // name should be string
      headers: { "content-type": "application/json" },
    });
    expect(reqErr.status).toBe(422);
    expect((reqErr.body as any).code).toBe("REQUEST_VALIDATION_ERROR");

    // Set up another mock with a handler that returns bad response data
    const mock2 = schmock({ state: {} });
    mock2("GET /items", () => ({ invalid: true })); // missing required fields
    mock2.pipe(
      validationPlugin({
        response: {
          body: {
            type: "object",
            required: ["name", "age"],
            properties: {
              name: { type: "string" },
              age: { type: "integer" },
            },
          },
        },
        responseErrorStatus: 502,
      }),
    );

    const resErr = await mock2.handle("GET", "/items");
    expect(resErr.status).toBe(502);
    expect((resErr.body as any).code).toBe("RESPONSE_VALIDATION_ERROR");

    mock2.close();
  });
});

// ---------------------------------------------------------------------------
// Query Plugin — standalone
// ---------------------------------------------------------------------------

describe("Query Plugin (standalone)", () => {
  let mock: Schmock.CallableMockInstance;

  const items = [
    { id: 1, name: "Alice", role: "admin", score: 90 },
    { id: 2, name: "Bob", role: "user", score: 75 },
    { id: 3, name: "Charlie", role: "admin", score: 85 },
    { id: 4, name: "Diana", role: "user", score: 92 },
    { id: 5, name: "Eve", role: "admin", score: 88 },
    { id: 6, name: "Frank", role: "user", score: 70 },
    { id: 7, name: "Grace", role: "admin", score: 95 },
    { id: 8, name: "Hank", role: "user", score: 60 },
    { id: 9, name: "Ivy", role: "admin", score: 82 },
    { id: 10, name: "Jack", role: "user", score: 77 },
  ];

  afterEach(() => {
    mock?.close();
  });

  it("pagination returns correct page/limit/total/totalPages", async () => {
    mock = schmock({ state: {} });
    mock("GET /users", items);
    mock.pipe(queryPlugin({ pagination: { defaultLimit: 3 } }));

    const res = await mock.handle("GET", "/users", {
      query: { page: "2", limit: "3" },
    });

    expect(res.status).toBe(200);
    const body = res.body as {
      data: any[];
      pagination: { page: number; limit: number; total: number; totalPages: number };
    };
    expect(body.data.length).toBe(3);
    expect(body.pagination.page).toBe(2);
    expect(body.pagination.limit).toBe(3);
    expect(body.pagination.total).toBe(10);
    expect(body.pagination.totalPages).toBe(4); // ceil(10/3)
  });

  it("sorting by allowed field works (asc and desc)", async () => {
    mock = schmock({ state: {} });
    mock("GET /users", items);
    mock.pipe(queryPlugin({ sorting: { allowed: ["name", "score"] } }));

    // Sort by name ascending
    const asc = await mock.handle("GET", "/users", {
      query: { sort: "name", order: "asc" },
    });
    expect(asc.status).toBe(200);
    const ascItems = asc.body as typeof items;
    for (let i = 1; i < ascItems.length; i++) {
      expect(ascItems[i].name >= ascItems[i - 1].name).toBe(true);
    }

    // Sort by score descending (new mock to avoid mutation)
    const mock2 = schmock({ state: {} });
    mock2("GET /users", items);
    mock2.pipe(queryPlugin({ sorting: { allowed: ["name", "score"] } }));

    const desc = await mock2.handle("GET", "/users", {
      query: { sort: "score", order: "desc" },
    });
    expect(desc.status).toBe(200);
    const descItems = desc.body as typeof items;
    for (let i = 1; i < descItems.length; i++) {
      expect(descItems[i].score <= descItems[i - 1].score).toBe(true);
    }
    mock2.close();
  });

  it("filtering by allowed field works", async () => {
    mock = schmock({ state: {} });
    mock("GET /users", items);
    mock.pipe(queryPlugin({ filtering: { allowed: ["role"] } }));

    const res = await mock.handle("GET", "/users", {
      query: { "filter[role]": "admin" },
    });

    expect(res.status).toBe(200);
    const filtered = res.body as typeof items;
    expect(filtered.length).toBe(5);
    expect(filtered.every((u) => u.role === "admin")).toBe(true);
  });

  it("combined pagination + sorting + filtering works", async () => {
    mock = schmock({ state: {} });
    mock("GET /users", items);
    mock.pipe(
      queryPlugin({
        filtering: { allowed: ["role"] },
        sorting: { allowed: ["score"] },
        pagination: { defaultLimit: 2 },
      }),
    );

    // Filter to admins (5 items), sort by score desc, page 1 limit 2
    const res = await mock.handle("GET", "/users", {
      query: {
        "filter[role]": "admin",
        sort: "score",
        order: "desc",
        page: "1",
        limit: "2",
      },
    });

    expect(res.status).toBe(200);
    const body = res.body as {
      data: typeof items;
      pagination: { page: number; limit: number; total: number; totalPages: number };
    };

    // 5 admins total, page size 2 -> 3 pages
    expect(body.pagination.total).toBe(5);
    expect(body.pagination.totalPages).toBe(3);
    expect(body.pagination.page).toBe(1);
    expect(body.data.length).toBe(2);

    // Data should be sorted by score descending
    expect(body.data[0].score >= body.data[1].score).toBe(true);
    // All items should be admins
    expect(body.data.every((u) => u.role === "admin")).toBe(true);
  });

  it("sorting by non-allowed field is ignored", async () => {
    mock = schmock({ state: {} });
    mock("GET /users", items);
    mock.pipe(queryPlugin({ sorting: { allowed: ["name"] } }));

    // Try to sort by "score" which is not in allowed list
    const res = await mock.handle("GET", "/users", {
      query: { sort: "score", order: "asc" },
    });

    expect(res.status).toBe(200);
    const result = res.body as typeof items;
    // Items should be in original order (not sorted by score)
    expect(result.map((u) => u.id)).toEqual(items.map((u) => u.id));
  });

  it("filtering by non-allowed field is ignored", async () => {
    mock = schmock({ state: {} });
    mock("GET /users", items);
    mock.pipe(queryPlugin({ filtering: { allowed: ["role"] } }));

    // Try to filter by "name" which is not in allowed list
    const res = await mock.handle("GET", "/users", {
      query: { "filter[name]": "Alice" },
    });

    expect(res.status).toBe(200);
    const result = res.body as typeof items;
    // All items should be returned since filter field is not allowed
    expect(result.length).toBe(10);
  });
});
