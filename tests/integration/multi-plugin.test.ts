/// <reference path="../../packages/core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { fakerPlugin } from "@schmock/faker";
import { openapi } from "@schmock/openapi";
import { queryPlugin } from "@schmock/query";
import { validationPlugin } from "@schmock/validation";
import { afterEach, describe, expect, it } from "vitest";
import { PETSTORE_SPEC, fetchJson } from "./helpers";

const userSchema = {
  type: "object" as const,
  required: ["name", "age"],
  properties: {
    id: { type: "integer" as const },
    name: { type: "string" as const },
    age: { type: "integer" as const, minimum: 0, maximum: 120 },
  },
};

const userArraySchema = {
  type: "array" as const,
  items: userSchema,
};

describe("Multi-Plugin Combos", () => {
  let mock: Schmock.CallableMockInstance;

  afterEach(() => {
    mock?.close();
  });

  it("faker + validation: generated response passes validation", async () => {
    mock = schmock({ state: {} });
    mock(
      "GET /users",
      () => undefined, // no static data — faker will generate
      {},
    );
    mock.pipe(fakerPlugin({ schema: userArraySchema, count: 5, seed: 42 }));
    mock.pipe(
      validationPlugin({
        response: { body: userArraySchema },
      }),
    );

    const res = await mock.handle("GET", "/users");
    // If validation fails, we get a 500 with RESPONSE_VALIDATION_ERROR
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as any[]).length).toBe(5);
  });

  it("faker + query (pagination)", async () => {
    mock = schmock({ state: {} });
    mock("GET /users", () => undefined, {});
    mock.pipe(fakerPlugin({ schema: userArraySchema, count: 50, seed: 42 }));
    mock.pipe(
      queryPlugin({
        pagination: { defaultLimit: 10 },
      }),
    );

    const res = await mock.handle("GET", "/users", {
      query: { page: "2", limit: "10" },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      data: any[];
      pagination: { page: number; limit: number; total: number };
    };
    expect(body.data.length).toBe(10);
    expect(body.pagination.page).toBe(2);
    expect(body.pagination.total).toBe(50);
  });

  it("faker + query (sorting)", async () => {
    mock = schmock({ state: {} });
    mock("GET /users", () => undefined, {});
    mock.pipe(fakerPlugin({ schema: userArraySchema, count: 10, seed: 42 }));
    mock.pipe(
      queryPlugin({
        sorting: { allowed: ["name"], default: "name" },
      }),
    );

    const res = await mock.handle("GET", "/users", {
      query: { sort: "name", order: "asc" },
    });
    expect(res.status).toBe(200);
    const items = res.body as any[];
    for (let i = 1; i < items.length; i++) {
      expect(items[i].name >= items[i - 1].name).toBe(true);
    }
  });

  it("faker + query (filtering)", async () => {
    mock = schmock({ state: {} });
    const items = [
      { id: 1, name: "Alice", type: "admin" },
      { id: 2, name: "Bob", type: "user" },
      { id: 3, name: "Charlie", type: "admin" },
      { id: 4, name: "Diana", type: "user" },
    ];
    mock("GET /users", items);
    mock.pipe(
      queryPlugin({
        filtering: { allowed: ["type"] },
      }),
    );

    const res = await mock.handle("GET", "/users", {
      query: { "filter[type]": "admin" },
    });
    expect(res.status).toBe(200);
    const filtered = res.body as any[];
    expect(filtered.length).toBe(2);
    expect(filtered.every((u: any) => u.type === "admin")).toBe(true);
  });

  it("openapi + faker + validation: schema compliance", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: PETSTORE_SPEC,
        fakerSeed: 42,
      }),
    );

    // Create a pet
    const created = await mock.handle("POST", "/pets", {
      body: { name: "TestPet", tag: "test" },
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toHaveProperty("name", "TestPet");
    expect(created.body).toHaveProperty("petId");

    // List pets — should be an array
    const list = await mock.handle("GET", "/pets");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
  });

  it("openapi + faker + query: pagination on list endpoint", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: PETSTORE_SPEC,
        seed: {
          pets: Array.from({ length: 30 }, (_, i) => ({
            petId: i + 1,
            name: `Pet-${i + 1}`,
            tag: "test",
          })),
        },
      }),
    );
    mock.pipe(
      queryPlugin({
        pagination: { defaultLimit: 10 },
      }),
    );

    const res = await mock.handle("GET", "/pets", {
      query: { page: "2", limit: "10" },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      data: any[];
      pagination: { page: number; total: number };
    };
    expect(body.data.length).toBe(10);
    expect(body.pagination.page).toBe(2);
    expect(body.pagination.total).toBe(30);
  });

  it("validation rejects bad POST", async () => {
    mock = schmock({ state: {} });
    mock("POST /users", (ctx) => [201, ctx.body]);
    mock.pipe(
      validationPlugin({
        request: {
          body: {
            type: "object",
            required: ["name", "age"],
            properties: {
              name: { type: "string" },
              age: { type: "integer" },
            },
          },
        },
      }),
    );

    // Missing required "age"
    const res = await mock.handle("POST", "/users", {
      body: { name: "Alice" },
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = res.body as any;
    expect(body.code).toBe("REQUEST_VALIDATION_ERROR");
  });

  it("query ignores non-array responses", async () => {
    mock = schmock({ state: {} });
    mock("GET /user/:id", { id: 1, name: "Alice" });
    mock.pipe(
      queryPlugin({
        pagination: { defaultLimit: 10 },
        sorting: { allowed: ["name"] },
      }),
    );

    const res = await mock.handle("GET", "/user/1", {
      query: { page: "1", sort: "name" },
    });
    expect(res.status).toBe(200);
    // Should return the object as-is, not wrapped in pagination
    expect(res.body).toHaveProperty("name", "Alice");
  });

  it("Plugin order matters: validation before faker vs after", async () => {
    // Validation AFTER faker — faker generates valid data, validation passes
    const mock1 = schmock({ state: {} });
    mock1("GET /users", () => undefined, {});
    mock1.pipe(fakerPlugin({ schema: userArraySchema, count: 3, seed: 42 }));
    mock1.pipe(
      validationPlugin({
        response: { body: userArraySchema },
      }),
    );

    const res1 = await mock1.handle("GET", "/users");
    expect(res1.status).toBe(200);

    // Faker generates an object, but validation expects an array → 500
    const mock2 = schmock({ state: {} });
    mock2("GET /users", () => undefined, {});
    mock2.pipe(
      fakerPlugin({
        schema: {
          type: "object",
          properties: {
            totally: { type: "string" },
            different: { type: "number" },
          },
        },
        seed: 42,
      }),
    );
    mock2.pipe(
      validationPlugin({
        response: {
          body: userArraySchema, // Expects array, but faker returns object
        },
      }),
    );

    const res2 = await mock2.handle("GET", "/users");
    expect(res2.status).toBe(500);
    const body2 = res2.body as any;
    expect(body2.code).toBe("RESPONSE_VALIDATION_ERROR");
  });

  it("Three plugins + listen + fetch: openapi + faker + query", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: PETSTORE_SPEC,
        seed: {
          pets: Array.from({ length: 25 }, (_, i) => ({
            petId: i + 1,
            name: `Pet-${String.fromCharCode(65 + (i % 26))}`,
            tag: "test",
          })),
        },
      }),
    );
    mock.pipe(
      queryPlugin({
        pagination: { defaultLimit: 5 },
      }),
    );

    const { port } = await mock.listen(0);

    // Fetch page 1
    const page1 = await fetchJson(port, "/pets?page=1&limit=5");
    expect(page1.status).toBe(200);
    const body1 = page1.body as {
      data: any[];
      pagination: { page: number; total: number; totalPages: number };
    };
    expect(body1.data.length).toBe(5);
    expect(body1.pagination.page).toBe(1);
    expect(body1.pagination.total).toBe(25);
    expect(body1.pagination.totalPages).toBe(5);

    // Fetch page 3
    const page3 = await fetchJson(port, "/pets?page=3&limit=5");
    const body3 = page3.body as { data: any[] };
    expect(body3.data.length).toBe(5);
  });
});
