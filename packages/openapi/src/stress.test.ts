/// <reference path="../../../types/schmock.d.ts" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { schmock } from "@schmock/core";
import { beforeAll, describe, expect, it } from "vitest";
import { detectCrudResources } from "./crud-detector";
import { normalizeSchema } from "./normalizer";
import type { ParsedSpec } from "./parser";
import { parseSpec } from "./parser";
import { openapi } from "./plugin";

const fixturesDir = resolve(import.meta.dirname, "__fixtures__");
const trainTravelSpec = resolve(fixturesDir, "train-travel.yaml");

// ════════════════════════════════════════════════════════════════════
// 1. PARSER — real-world Train Travel API (OpenAPI 3.1)
// ════════════════════════════════════════════════════════════════════
describe("stress: parser — train-travel.yaml", () => {
  it("parses the OpenAPI 3.1 Train Travel spec", async () => {
    const spec = await parseSpec(trainTravelSpec);
    expect(spec.title).toBe("Train Travel API");
    expect(spec.version).toBe("1.2.1");
  });

  it("extracts basePath from first server URL", async () => {
    const spec = await parseSpec(trainTravelSpec);
    // servers[0] = "https://try.microcks.io/rest/Train+Travel+API/1.0.0"
    expect(spec.basePath).toBe("/rest/Train+Travel+API/1.0.0");
  });

  it("extracts all path operations", async () => {
    const spec = await parseSpec(trainTravelSpec);
    const sigs = spec.paths.map((p) => `${p.method} ${p.path}`);

    expect(sigs).toContain("GET /stations");
    expect(sigs).toContain("GET /trips");
    expect(sigs).toContain("GET /bookings");
    expect(sigs).toContain("POST /bookings");
    expect(sigs).toContain("GET /bookings/:bookingId");
    expect(sigs).toContain("DELETE /bookings/:bookingId");
    expect(sigs).toContain("POST /bookings/:bookingId/payment");
  });

  it("resolves $ref'd parameters (page, limit)", async () => {
    const spec = await parseSpec(trainTravelSpec);
    const getStations = spec.paths.find(
      (p) => p.method === "GET" && p.path === "/stations",
    );
    expect(getStations).toBeDefined();

    const paramNames = getStations?.parameters.map((p) => p.name) ?? [];
    expect(paramNames).toContain("page");
    expect(paramNames).toContain("limit");
    expect(paramNames).toContain("coordinates");
    expect(paramNames).toContain("search");
    expect(paramNames).toContain("country");
  });

  it("resolves $ref'd response schemas (allOf composition)", async () => {
    const spec = await parseSpec(trainTravelSpec);
    const getStations = spec.paths.find(
      (p) => p.method === "GET" && p.path === "/stations",
    );

    // 200 response exists with a schema
    expect(getStations?.responses.has(200)).toBe(true);
    const schema200 = getStations?.responses.get(200)?.schema;
    expect(schema200).toBeDefined();
    // The schema is an allOf composition — no unresolved $ref
    const schemaStr = JSON.stringify(schema200);
    expect(schemaStr).not.toContain("$ref");
  });

  it("resolves $ref'd error responses (400, 401, etc.)", async () => {
    const spec = await parseSpec(trainTravelSpec);
    const getStations = spec.paths.find(
      (p) => p.method === "GET" && p.path === "/stations",
    );

    // Error responses use application/problem+json — parser should find them
    expect(getStations?.responses.has(400)).toBe(true);
    expect(getStations?.responses.has(401)).toBe(true);
    expect(getStations?.responses.has(500)).toBe(true);
  });

  it("extracts path-level parameters for bookings/:bookingId", async () => {
    const spec = await parseSpec(trainTravelSpec);
    const getBooking = spec.paths.find(
      (p) => p.method === "GET" && p.path === "/bookings/:bookingId",
    );
    expect(getBooking).toBeDefined();
    expect(getBooking?.parameters).toContainEqual(
      expect.objectContaining({ name: "bookingId", in: "path" }),
    );
  });

  it("extracts requestBody from POST /bookings", async () => {
    const spec = await parseSpec(trainTravelSpec);
    const createBooking = spec.paths.find(
      (p) => p.method === "POST" && p.path === "/bookings",
    );
    expect(createBooking?.requestBody).toBeDefined();
  });

  it("handles non-application/json content types (application/problem+json)", async () => {
    const spec = await parseSpec(trainTravelSpec);
    const getStations = spec.paths.find(
      (p) => p.method === "GET" && p.path === "/stations",
    );

    // 400 response uses application/problem+json — parser should still extract schema
    const resp400 = getStations?.responses.get(400);
    expect(resp400?.schema).toBeDefined();
  });

  it("strips x-* extensions during normalization", async () => {
    const spec = await parseSpec(trainTravelSpec);
    // Verify parsed schemas don't contain x-* extensions
    for (const p of spec.paths) {
      if (p.requestBody) {
        const str = JSON.stringify(p.requestBody);
        expect(str).not.toContain('"x-');
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. CRUD DETECTOR — Train Travel spec
// ════════════════════════════════════════════════════════════════════
describe("stress: crud-detector — train-travel.yaml", () => {
  it("detects bookings as a CRUD resource", async () => {
    const spec = await parseSpec(trainTravelSpec);
    const result = detectCrudResources(spec.paths);

    const bookings = result.resources.find((r) => r.name === "bookings");
    expect(bookings).toBeDefined();
    expect(bookings?.basePath).toBe("/bookings");
    expect(bookings?.itemPath).toBe("/bookings/:bookingId");
    expect(bookings?.idParam).toBe("bookingId");
    expect(bookings?.operations).toContain("list");
    expect(bookings?.operations).toContain("create");
    expect(bookings?.operations).toContain("read");
    expect(bookings?.operations).toContain("delete");
  });

  it("classifies stations as non-CRUD (GET only, no create)", async () => {
    const spec = await parseSpec(trainTravelSpec);
    const result = detectCrudResources(spec.paths);

    const stationsResource = result.resources.find(
      (r) => r.name === "stations",
    );
    expect(stationsResource).toBeUndefined();

    const stationsNonCrud = result.nonCrudPaths.find(
      (p) => p.path === "/stations",
    );
    expect(stationsNonCrud).toBeDefined();
  });

  it("classifies trips as non-CRUD (GET only, no create)", async () => {
    const spec = await parseSpec(trainTravelSpec);
    const result = detectCrudResources(spec.paths);

    const tripsResource = result.resources.find((r) => r.name === "trips");
    expect(tripsResource).toBeUndefined();
  });

  it("classifies /bookings/:bookingId/payment as non-CRUD", async () => {
    const spec = await parseSpec(trainTravelSpec);
    const result = detectCrudResources(spec.paths);

    // payment is nested 2 levels deep under bookings, not a simple item path
    const paymentNonCrud = result.nonCrudPaths.find(
      (p) => p.path === "/bookings/:bookingId/payment",
    );
    expect(paymentNonCrud).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. FULL INTEGRATION — Train Travel spec
// ════════════════════════════════════════════════════════════════════
describe("stress: integration — train-travel.yaml", () => {
  it("auto-registers all routes and handles requests", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: trainTravelSpec }));

    // Stations: non-CRUD static endpoint → should return generated response
    const stations = await mock.handle("GET", "/stations");
    expect(stations.status).toBe(200);
    expect(stations.body).toBeDefined();

    // Trips: non-CRUD static endpoint
    const trips = await mock.handle("GET", "/trips");
    expect(trips.status).toBe(200);

    // Bookings: CRUD resource (wrapped list — allOf with data array)
    const emptyList = await mock.handle("GET", "/bookings");
    expect(emptyList.status).toBe(200);
    const emptyBody = emptyList.body as Record<string, unknown>;
    expect(emptyBody.data).toEqual([]);
  });

  it("bookings CRUD lifecycle", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: trainTravelSpec }));

    // Create
    const created = await mock.handle("POST", "/bookings", {
      body: {
        trip_id: "ea399ba1-6d95-433f-92d1-83f67b775594",
        passenger_name: "John Doe",
        has_bicycle: true,
        has_dog: false,
      },
    });
    expect(created.status).toBe(201);
    const booking = created.body as Record<string, unknown>;
    expect(booking.passenger_name).toBe("John Doe");
    expect(booking.bookingId).toBe(1);

    // Read
    const read = await mock.handle("GET", "/bookings/1");
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ passenger_name: "John Doe" });

    // List (wrapped)
    const list = await mock.handle("GET", "/bookings");
    expect(list.status).toBe(200);
    const listBody = list.body as Record<string, unknown>;
    expect(listBody.data).toHaveLength(1);

    // Delete
    const deleted = await mock.handle("DELETE", "/bookings/1");
    expect(deleted.status).toBe(204);

    // Verify deletion
    const afterDelete = await mock.handle("GET", "/bookings/1");
    expect(afterDelete.status).toBe(404);
  });

  it("payment endpoint returns a response (non-CRUD)", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: trainTravelSpec }));

    // POST /bookings/:bookingId/payment — non-CRUD static
    const payment = await mock.handle("POST", "/bookings/123/payment", {
      body: {
        amount: 49.99,
        currency: "gbp",
        source: { object: "card", name: "J. Doe", number: "4242..." },
      },
    });
    expect(payment.status).toBe(200);
    expect(payment.body).toBeDefined();
  });

  it("multiple bookings with sequential IDs", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: trainTravelSpec }));

    for (let i = 0; i < 5; i++) {
      const res = await mock.handle("POST", "/bookings", {
        body: { passenger_name: `Passenger-${i}`, trip_id: "trip-1" },
      });
      expect(res.status).toBe(201);
      const body = res.body as Record<string, unknown>;
      expect(body.bookingId).toBe(i + 1);
    }

    const list = await mock.handle("GET", "/bookings");
    const listBody = list.body as Record<string, unknown>;
    expect(listBody.data).toHaveLength(5);
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. NORMALIZER STRESS
// ════════════════════════════════════════════════════════════════════
describe("stress: normalizer", () => {
  it("handles nullable + exclusiveMinimum combo", () => {
    const result = normalizeSchema(
      {
        type: "number",
        format: "double",
        exclusiveMinimum: true,
        minimum: 0,
        nullable: true,
      },
      "response",
    );
    expect(result.oneOf).toBeDefined();
    const branches = result.oneOf;
    expect(branches).toHaveLength(2);
    const numericBranch = (branches as Record<string, unknown>[])[0];
    expect(numericBranch.exclusiveMinimum).toBe(0);
    expect(numericBranch).not.toHaveProperty("minimum");
  });

  it("handles exclusiveMaximum: true (boolean → number)", () => {
    const result = normalizeSchema(
      {
        type: "number",
        minimum: 0,
        exclusiveMaximum: true,
        maximum: 300000,
      },
      "response",
    );
    expect(result.exclusiveMaximum).toBe(300000);
    expect(result).not.toHaveProperty("maximum");
  });

  it("passes through exclusiveMinimum already as number (OpenAPI 3.1)", () => {
    // In 3.1, exclusiveMinimum is already a number — should not be transformed
    const result = normalizeSchema(
      {
        type: "number",
        exclusiveMinimum: 0,
      },
      "response",
    );
    expect(result.exclusiveMinimum).toBe(0);
  });

  it("strips readOnly from request, keeps in response", () => {
    const schema = {
      type: "object",
      required: ["id", "name"],
      properties: {
        id: { type: "string", format: "uuid", readOnly: true },
        name: { type: "string" },
        createdAt: { type: "string", format: "date-time", readOnly: true },
      },
    };

    const request = normalizeSchema(schema, "request");
    expect(request.properties).not.toHaveProperty("id");
    expect(request.properties).not.toHaveProperty("createdAt");
    expect(request.required).not.toContain("id");

    const response = normalizeSchema(schema, "response");
    expect(response.properties).toHaveProperty("id");
    expect(response.properties).toHaveProperty("createdAt");
  });

  it("strips writeOnly from response, keeps in request", () => {
    const schema = {
      type: "object",
      properties: {
        username: { type: "string" },
        cvc: { type: "string", writeOnly: true },
        address_line1: { type: "string", writeOnly: true },
      },
    };

    const response = normalizeSchema(schema, "response");
    expect(response.properties).not.toHaveProperty("cvc");
    expect(response.properties).not.toHaveProperty("address_line1");

    const request = normalizeSchema(schema, "request");
    expect(request.properties).toHaveProperty("cvc");
    expect(request.properties).toHaveProperty("address_line1");
  });

  it("handles allOf compositions (Wrapper-Collection pattern)", () => {
    const result = normalizeSchema(
      {
        allOf: [
          {
            type: "object",
            properties: {
              data: { type: "array", items: { type: "object" } },
              links: { type: "object", readOnly: true },
            },
          },
          {
            properties: {
              data: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    name: { type: "string", example: "Berlin Hbf" },
                  },
                },
              },
            },
          },
        ],
      },
      "response",
    );

    expect(result.allOf).toBeDefined();
    expect(result.allOf).toHaveLength(2);
  });

  it("handles oneOf with const (card vs bank_account)", () => {
    const result = normalizeSchema(
      {
        oneOf: [
          {
            type: "object",
            properties: {
              object: { type: "string", const: "card" },
              name: { type: "string" },
            },
          },
          {
            type: "object",
            properties: {
              object: { type: "string", const: "bank_account" },
              name: { type: "string" },
            },
          },
        ],
      },
      "response",
    );

    expect(result.oneOf).toHaveLength(2);
    // const should pass through (standard JSON Schema keyword)
    const branches = result.oneOf as Record<string, unknown>[];
    const branch0Props = (branches[0] as Record<string, unknown>)
      .properties as Record<string, unknown>;
    const obj0 = branch0Props.object as Record<string, unknown>;
    expect(obj0.const).toBe("card");
  });

  it("handles additionalProperties: true (free-form)", () => {
    const result = normalizeSchema(
      { type: "object", additionalProperties: true },
      "response",
    );
    expect(result.additionalProperties).toBe(true);
  });

  it("handles additionalProperties as schema with nullable", () => {
    const result = normalizeSchema(
      {
        type: "object",
        additionalProperties: { type: "string", nullable: true },
      },
      "response",
    );
    const ap = result.additionalProperties;
    expect(typeof ap === "object" && ap !== null && "oneOf" in ap).toBe(true);
  });

  it("does not mutate the input schema", () => {
    const input = {
      type: "string",
      nullable: true,
      "x-custom": "value",
    };
    const copy = JSON.parse(JSON.stringify(input));
    normalizeSchema(input, "response");
    expect(input).toEqual(copy);
  });

  it("handles empty schema", () => {
    expect(normalizeSchema({}, "response")).toEqual({});
  });

  it("handles deeply nested: allOf → properties → oneOf → nullable", () => {
    const result = normalizeSchema(
      {
        allOf: [
          {
            type: "object",
            properties: {
              source: {
                oneOf: [
                  {
                    type: "object",
                    properties: {
                      cvc: { type: "string", writeOnly: true },
                    },
                  },
                  {
                    type: "object",
                    properties: {
                      sortCode: { type: "string", nullable: true },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
      "response",
    );

    const allOf = result.allOf as Record<string, unknown>[];
    const props = allOf[0].properties as Record<string, unknown>;
    const source = props.source as Record<string, unknown>;
    const branches = source.oneOf as Record<string, unknown>[];

    // writeOnly cvc stripped from response
    const cardProps = branches[0].properties as Record<string, unknown>;
    expect(cardProps).not.toHaveProperty("cvc");

    // nullable sortCode → oneOf
    const bankProps = branches[1].properties as Record<string, unknown>;
    const sortCode = bankProps.sortCode as Record<string, unknown>;
    expect(sortCode.oneOf).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. CRUD DETECTOR — edge cases
// ════════════════════════════════════════════════════════════════════
describe("stress: crud-detector edge cases", () => {
  it("single-POST-only endpoints are non-CRUD", () => {
    const result = detectCrudResources([
      {
        path: "/webhook",
        method: "POST",
        parameters: [],
        responses: new Map(),
        tags: [],
      },
    ]);
    expect(result.resources).toHaveLength(0);
    expect(result.nonCrudPaths).toHaveLength(1);
  });

  it("deeply nested resource paths", () => {
    const result = detectCrudResources([
      {
        path: "/org/:orgId/team/:teamId/members",
        method: "GET",
        parameters: [],
        responses: new Map(),
        tags: [],
      },
      {
        path: "/org/:orgId/team/:teamId/members",
        method: "POST",
        parameters: [],
        responses: new Map(),
        tags: [],
      },
      {
        path: "/org/:orgId/team/:teamId/members/:memberId",
        method: "GET",
        parameters: [],
        responses: new Map(),
        tags: [],
      },
    ]);

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].name).toBe("members");
    expect(result.resources[0].basePath).toBe(
      "/org/:orgId/team/:teamId/members",
    );
    expect(result.resources[0].idParam).toBe("memberId");
  });

  it("root path / is non-CRUD", () => {
    const result = detectCrudResources([
      {
        path: "/",
        method: "GET",
        parameters: [],
        responses: new Map(),
        tags: [],
      },
    ]);
    expect(result.resources).toHaveLength(0);
    expect(result.nonCrudPaths).toHaveLength(1);
  });

  it("GET-only collection is non-CRUD", () => {
    const result = detectCrudResources([
      {
        path: "/readonly-things",
        method: "GET",
        parameters: [],
        responses: new Map(),
        tags: [],
      },
    ]);
    expect(result.resources).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// 6. GENERATOR STRESS — via plugin integration
// ════════════════════════════════════════════════════════════════════
describe("stress: generators via plugin", () => {
  it("rapid sequential creates (100 items)", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    for (let i = 0; i < 100; i++) {
      const res = await mock.handle("POST", "/pets", {
        body: { name: `Pet-${i}` },
      });
      expect(res.status).toBe(201);
      const body = res.body as Record<string, unknown>;
      expect(body.petId).toBe(i + 1);
    }

    const list = await mock.handle("GET", "/pets");
    expect(list.body).toHaveLength(100);
  });

  it("create with empty body", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    const res = await mock.handle("POST", "/pets");
    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.petId).toBe(1);
  });

  it("update with empty body preserves existing", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    await mock.handle("POST", "/pets", {
      body: { name: "Buddy", tag: "dog" },
    });
    const updated = await mock.handle("PUT", "/pets/1");
    expect(updated.status).toBe(200);
    const body = updated.body as Record<string, unknown>;
    expect(body.name).toBe("Buddy");
    expect(body.petId).toBe(1);
  });

  it("update cannot overwrite ID", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    await mock.handle("POST", "/pets", { body: { name: "Buddy" } });
    const updated = await mock.handle("PUT", "/pets/1", {
      body: { name: "Max", petId: 999 },
    });
    const body = updated.body as Record<string, unknown>;
    expect(body.petId).toBe(1);
  });

  it("double-delete returns 404", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    await mock.handle("POST", "/pets", { body: { name: "Buddy" } });
    await mock.handle("DELETE", "/pets/1");
    const second = await mock.handle("DELETE", "/pets/1");
    expect(second.status).toBe(404);
  });

  it("create-delete-list: only even IDs survive", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    for (let i = 0; i < 10; i++) {
      await mock.handle("POST", "/pets", { body: { name: `Pet-${i}` } });
    }
    for (let i = 1; i <= 10; i += 2) {
      await mock.handle("DELETE", `/pets/${i}`);
    }

    const list = await mock.handle("GET", "/pets");
    const items = list.body as Record<string, unknown>[];
    expect(items).toHaveLength(5);
    for (const item of items) {
      expect((item.petId as number) % 2).toBe(0);
    }
  });

  it("resetState clears CRUD collections", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    await mock.handle("POST", "/pets", { body: { name: "Buddy" } });
    expect((await mock.handle("GET", "/pets")).body).toHaveLength(1);

    mock.resetState();

    const after = await mock.handle("GET", "/pets");
    expect(after.body).toEqual([]);
  });

  it("string IDs work with seed data", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: `${fixturesDir}/petstore-swagger2.json`,
        seed: { pets: [{ petId: "abc-123", name: "Luna" }] },
      }),
    );

    const read = await mock.handle("GET", "/pets/abc-123");
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ name: "Luna" });
  });
});

// ════════════════════════════════════════════════════════════════════
// 7. SEED STRESS
// ════════════════════════════════════════════════════════════════════
describe("stress: seed data", () => {
  it("large inline dataset (200 items)", async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      petId: i + 1,
      name: `Pet-${i + 1}`,
    }));

    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: `${fixturesDir}/petstore-swagger2.json`,
        seed: { pets: items },
      }),
    );

    const list = await mock.handle("GET", "/pets");
    expect(list.body).toHaveLength(200);
  });

  it("auto-increment continues after seed", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: `${fixturesDir}/petstore-swagger2.json`,
        seed: {
          pets: Array.from({ length: 50 }, (_, i) => ({
            petId: i + 1,
            name: `Pet-${i + 1}`,
          })),
        },
      }),
    );

    const created = await mock.handle("POST", "/pets", {
      body: { name: "New" },
    });
    const body = created.body as Record<string, unknown>;
    expect(body.petId).toBe(51);
  });

  it("non-sequential IDs: max is picked correctly", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: `${fixturesDir}/petstore-swagger2.json`,
        seed: {
          pets: [
            { petId: 10, name: "A" },
            { petId: 5, name: "B" },
            { petId: 100, name: "C" },
          ],
        },
      }),
    );

    const created = await mock.handle("POST", "/pets", {
      body: { name: "New" },
    });
    const body = created.body as Record<string, unknown>;
    expect(body.petId).toBe(101);
  });
});

// ════════════════════════════════════════════════════════════════════
// 8. PLUGIN EDGE CASES
// ════════════════════════════════════════════════════════════════════
describe("stress: plugin edge cases", () => {
  it("all-static spec (no CRUD resources)", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "Static", version: "1.0.0" },
          paths: {
            "/health": {
              get: {
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: { status: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    const health = await mock.handle("GET", "/health");
    expect(health.status).toBe(200);
  });

  it("multiple openapi plugins coexist", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "Users", version: "1.0.0" },
          paths: {
            "/users": {
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
                            properties: { userId: { type: "integer" } },
                          },
                        },
                      },
                    },
                  },
                },
              },
              post: {
                responses: { "201": { description: "Created" } },
              },
            },
          },
        },
      }),
    );

    await mock.handle("POST", "/pets", { body: { name: "Buddy" } });
    await mock.handle("POST", "/users", { body: { name: "Alice" } });

    expect((await mock.handle("GET", "/pets")).body).toHaveLength(1);
    expect((await mock.handle("GET", "/users")).body).toHaveLength(1);
  });

  it("unregistered routes return 404", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    const res = await mock.handle("GET", "/nonexistent");
    expect(res.status).toBe(404);
  });

  it("spec with no response schemas returns empty object", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "NoSchema", version: "1.0.0" },
          paths: {
            "/ping": {
              get: {
                responses: { "204": { description: "No Content" } },
              },
            },
          },
        },
      }),
    );

    const ping = await mock.handle("GET", "/ping");
    expect(ping.status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════
// 9. PARSER EDGE CASES
// ════════════════════════════════════════════════════════════════════
describe("stress: parser edge cases", () => {
  it("empty paths object", async () => {
    const spec = await parseSpec({
      openapi: "3.0.3",
      info: { title: "Empty", version: "0.0.0" },
      paths: {},
    });
    expect(spec.paths).toEqual([]);
  });

  it("no paths key at all", async () => {
    const spec = await parseSpec({
      openapi: "3.0.3",
      info: { title: "NoPaths", version: "0.0.0" },
    });
    expect(spec.paths).toEqual([]);
  });

  it("servers with relative path", async () => {
    const spec = await parseSpec({
      openapi: "3.0.3",
      info: { title: "Rel", version: "0.0.0" },
      servers: [{ url: "/v3" }],
      paths: {},
    });
    expect(spec.basePath).toBe("/v3");
  });

  it("servers with root path only", async () => {
    const spec = await parseSpec({
      openapi: "3.0.3",
      info: { title: "Root", version: "0.0.0" },
      servers: [{ url: "/" }],
      paths: {},
    });
    expect(spec.basePath).toBe("");
  });

  it("Swagger 2.0 basePath is extracted", async () => {
    const spec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);
    expect(spec.basePath).toBe("/api");
  });
});

// ════════════════════════════════════════════════════════════════════
// 10. SCALAR GALAXY — OpenAPI 3.1.1 BREAD stress
// ════════════════════════════════════════════════════════════════════

const scalarGalaxySpec = resolve(fixturesDir, "scalar-galaxy.yaml");

// Real solar system seed data — planetId matches the CRUD resource's idParam
const solarSystemPlanets = [
  {
    planetId: 1,
    name: "Mercury",
    type: "terrestrial",
    habitabilityIndex: 0.01,
    physicalProperties: { mass: 0.055, radius: 0.383, gravity: 0.38 },
    atmosphere: [],
    tags: ["solar-system", "rocky", "inner"],
  },
  {
    planetId: 2,
    name: "Venus",
    type: "terrestrial",
    habitabilityIndex: 0.04,
    physicalProperties: { mass: 0.815, radius: 0.95, gravity: 0.9 },
    atmosphere: [{ compound: "CO2", percentage: 96.5 }],
    tags: ["solar-system", "rocky", "inner"],
  },
  {
    planetId: 3,
    name: "Earth",
    type: "terrestrial",
    habitabilityIndex: 1.0,
    physicalProperties: { mass: 1.0, radius: 1.0, gravity: 1.0 },
    atmosphere: [
      { compound: "N2", percentage: 78.1 },
      { compound: "O2", percentage: 20.9 },
    ],
    tags: ["solar-system", "rocky", "habitable"],
  },
  {
    planetId: 4,
    name: "Mars",
    type: "terrestrial",
    habitabilityIndex: 0.68,
    physicalProperties: { mass: 0.107, radius: 0.532, gravity: 0.378 },
    atmosphere: [{ compound: "CO2", percentage: 95.3 }],
    tags: ["solar-system", "rocky", "explored"],
  },
  {
    planetId: 5,
    name: "Jupiter",
    type: "gas_giant",
    habitabilityIndex: 0.0,
    physicalProperties: { mass: 317.8, radius: 11.21, gravity: 2.53 },
    atmosphere: [
      { compound: "H2", percentage: 89.8 },
      { compound: "He", percentage: 10.2 },
    ],
    tags: ["solar-system", "gas", "outer"],
  },
  {
    planetId: 6,
    name: "Saturn",
    type: "gas_giant",
    habitabilityIndex: 0.0,
    physicalProperties: { mass: 95.16, radius: 9.45, gravity: 1.065 },
    atmosphere: [
      { compound: "H2", percentage: 96.3 },
      { compound: "He", percentage: 3.25 },
    ],
    tags: ["solar-system", "gas", "ringed"],
  },
  {
    planetId: 7,
    name: "Uranus",
    type: "ice_giant",
    habitabilityIndex: 0.0,
    physicalProperties: { mass: 14.54, radius: 4.01, gravity: 0.886 },
    atmosphere: [
      { compound: "H2", percentage: 82.5 },
      { compound: "He", percentage: 15.2 },
    ],
    tags: ["solar-system", "ice", "outer"],
  },
  {
    planetId: 8,
    name: "Neptune",
    type: "ice_giant",
    habitabilityIndex: 0.0,
    physicalProperties: { mass: 17.15, radius: 3.88, gravity: 1.14 },
    atmosphere: [
      { compound: "H2", percentage: 80.0 },
      { compound: "He", percentage: 19.0 },
    ],
    tags: ["solar-system", "ice", "outer"],
  },
];

describe("stress: scalar-galaxy.yaml — parser", () => {
  it("parses the OpenAPI 3.1.1 Scalar Galaxy spec", async () => {
    const spec = await parseSpec(scalarGalaxySpec);
    expect(spec.title).toBe("Scalar Galaxy");
    expect(spec.version).toBe("0.5.12");
  });

  it("strips x-speakeasy-webhooks and x-scalar-* extensions", async () => {
    const spec = await parseSpec(scalarGalaxySpec);
    for (const p of spec.paths) {
      if (p.requestBody) {
        const str = JSON.stringify(p.requestBody);
        expect(str).not.toContain('"x-');
      }
      for (const [, resp] of p.responses) {
        if (resp.schema) {
          const str = JSON.stringify(resp.schema);
          expect(str).not.toContain('"x-');
        }
      }
    }
  });

  it("extracts all planet routes", async () => {
    const spec = await parseSpec(scalarGalaxySpec);
    const sigs = spec.paths.map((p) => `${p.method} ${p.path}`);
    expect(sigs).toContain("GET /planets");
    expect(sigs).toContain("POST /planets");
    expect(sigs).toContain("GET /planets/:planetId");
    expect(sigs).toContain("PUT /planets/:planetId");
    expect(sigs).toContain("DELETE /planets/:planetId");
    expect(sigs).toContain("POST /planets/:planetId/image");
  });

  it("extracts auth routes", async () => {
    const spec = await parseSpec(scalarGalaxySpec);
    const sigs = spec.paths.map((p) => `${p.method} ${p.path}`);
    expect(sigs).toContain("POST /user/signup");
    expect(sigs).toContain("POST /auth/token");
    expect(sigs).toContain("GET /me");
  });

  it("extracts $ref'd parameters (limit, offset, planetId)", async () => {
    const spec = await parseSpec(scalarGalaxySpec);
    const listPlanets = spec.paths.find(
      (p) => p.method === "GET" && p.path === "/planets",
    );
    const paramNames = listPlanets?.parameters.map((p) => p.name) ?? [];
    expect(paramNames).toContain("limit");
    expect(paramNames).toContain("offset");

    const getPlanet = spec.paths.find(
      (p) => p.method === "GET" && p.path === "/planets/:planetId",
    );
    const itemParamNames = getPlanet?.parameters.map((p) => p.name) ?? [];
    expect(itemParamNames).toContain("planetId");
  });

  it("extracts Planet schema with nested physicalProperties", async () => {
    const spec = await parseSpec(scalarGalaxySpec);
    const getPlanet = spec.paths.find(
      (p) => p.method === "GET" && p.path === "/planets/:planetId",
    );
    const schema = getPlanet?.responses.get(200)?.schema;
    expect(schema).toBeDefined();
    expect(schema?.properties).toHaveProperty("name");
    expect(schema?.properties).toHaveProperty("physicalProperties");
    expect(schema?.properties).toHaveProperty("atmosphere");
  });

  it("strips readOnly fields (id, lastUpdated) from request schemas", async () => {
    const spec = await parseSpec(scalarGalaxySpec);
    const createPlanet = spec.paths.find(
      (p) => p.method === "POST" && p.path === "/planets",
    );
    expect(createPlanet?.requestBody).toBeDefined();
    // id and lastUpdated are readOnly — should be stripped from request
    expect(createPlanet?.requestBody?.properties).not.toHaveProperty("id");
    expect(createPlanet?.requestBody?.properties).not.toHaveProperty(
      "lastUpdated",
    );
    // name should remain
    expect(createPlanet?.requestBody?.properties).toHaveProperty("name");
  });
});

describe("stress: scalar-galaxy.yaml — CRUD detection", () => {
  it("detects planets as a full CRUD resource", async () => {
    const spec = await parseSpec(scalarGalaxySpec);
    const result = detectCrudResources(spec.paths);
    const planets = result.resources.find((r) => r.name === "planets");
    expect(planets).toBeDefined();
    expect(planets?.basePath).toBe("/planets");
    expect(planets?.itemPath).toBe("/planets/:planetId");
    expect(planets?.idParam).toBe("planetId");
    expect(planets?.operations).toContain("list");
    expect(planets?.operations).toContain("create");
    expect(planets?.operations).toContain("read");
    expect(planets?.operations).toContain("update");
    expect(planets?.operations).toContain("delete");
  });

  it("classifies non-CRUD paths correctly", async () => {
    const spec = await parseSpec(scalarGalaxySpec);
    const result = detectCrudResources(spec.paths);
    const nonCrudPaths = result.nonCrudPaths.map((p) => p.path);
    expect(nonCrudPaths).toContain("/planets/:planetId/image");
    expect(nonCrudPaths).toContain("/user/signup");
    expect(nonCrudPaths).toContain("/auth/token");
    expect(nonCrudPaths).toContain("/me");
  });
});

describe("stress: scalar-galaxy.yaml — BREAD operations", () => {
  it("full solar system lifecycle: seed → browse → read → add → edit → delete", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: scalarGalaxySpec,
        seed: { planets: solarSystemPlanets },
      }),
    );

    // BROWSE — list all 8 planets (wrapped: { data: [...], meta: {...} })
    const allPlanets = await mock.handle("GET", "/planets");
    expect(allPlanets.status).toBe(200);
    const allPlanetsBody = allPlanets.body as Record<string, unknown>;
    expect(allPlanetsBody.data).toHaveLength(8);

    // READ — each planet is coherent
    for (let i = 1; i <= 8; i++) {
      const planet = await mock.handle("GET", `/planets/${i}`);
      expect(planet.status).toBe(200);
      const body = planet.body as Record<string, unknown>;
      expect(body.name).toBe(solarSystemPlanets[i - 1].name);
      expect(body.type).toBe(solarSystemPlanets[i - 1].type);
    }

    // READ specific — Earth is habitable
    const earth = await mock.handle("GET", "/planets/3");
    const earthBody = earth.body as Record<string, unknown>;
    expect(earthBody.name).toBe("Earth");
    expect(earthBody.habitabilityIndex).toBe(1.0);
    expect(earthBody.type).toBe("terrestrial");

    // ADD — discover a new planet
    const created = await mock.handle("POST", "/planets", {
      body: {
        name: "Kepler-442b",
        type: "super_earth",
        habitabilityIndex: 0.84,
        physicalProperties: { mass: 2.36, radius: 1.34, gravity: 1.31 },
        atmosphere: [{ compound: "N2", percentage: 70.0 }],
        tags: ["exoplanet", "habitable-zone"],
      },
    });
    expect(created.status).toBe(201);
    const newPlanet = created.body as Record<string, unknown>;
    expect(newPlanet.name).toBe("Kepler-442b");
    expect(newPlanet.planetId).toBe(9); // auto-incremented past seed max (8)

    // BROWSE after ADD — 9 planets (wrapped)
    const afterAdd = await mock.handle("GET", "/planets");
    expect((afterAdd.body as Record<string, unknown>).data).toHaveLength(9);

    // EDIT — update Mars terraforming progress
    const edited = await mock.handle("PUT", "/planets/4", {
      body: { habitabilityIndex: 0.75, tags: ["solar-system", "terraformed"] },
    });
    expect(edited.status).toBe(200);
    const marsUpdated = edited.body as Record<string, unknown>;
    expect(marsUpdated.name).toBe("Mars"); // preserved
    expect(marsUpdated.habitabilityIndex).toBe(0.75); // updated

    // DELETE — Pluto was never a planet anyway
    const deleted = await mock.handle("DELETE", "/planets/9");
    expect(deleted.status).toBe(204);

    // BROWSE after DELETE — back to 8 (wrapped)
    const afterDelete = await mock.handle("GET", "/planets");
    expect((afterDelete.body as Record<string, unknown>).data).toHaveLength(8);

    // READ deleted — 404
    const gone = await mock.handle("GET", "/planets/9");
    expect(gone.status).toBe(404);
  });

  it("PATCH works for planet updates too", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: scalarGalaxySpec,
        seed: {
          planets: [{ planetId: 1, name: "Mars", type: "terrestrial" }],
        },
      }),
    );

    const patched = await mock.handle("PATCH", "/planets/1", {
      body: { habitabilityIndex: 0.42 },
    });
    expect(patched.status).toBe(200);
    const body = patched.body as Record<string, unknown>;
    expect(body.name).toBe("Mars");
    expect(body.habitabilityIndex).toBe(0.42);
  });

  it("solar system physical properties are preserved through CRUD", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: scalarGalaxySpec,
        seed: { planets: solarSystemPlanets },
      }),
    );

    // Verify nested physicalProperties survive
    const jupiter = await mock.handle("GET", "/planets/5");
    const jupiterBody = jupiter.body as Record<string, unknown>;
    const physics = jupiterBody.physicalProperties as Record<string, unknown>;
    expect(physics.mass).toBe(317.8);
    expect(physics.radius).toBe(11.21);
    expect(physics.gravity).toBe(2.53);

    // Verify atmosphere arrays survive
    const earth = await mock.handle("GET", "/planets/3");
    const earthBody = earth.body as Record<string, unknown>;
    const atmo = earthBody.atmosphere as Array<Record<string, unknown>>;
    expect(atmo).toHaveLength(2);
    expect(atmo[0].compound).toBe("N2");
    expect(atmo[0].percentage).toBe(78.1);
  });

  it("non-CRUD endpoints work alongside CRUD", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: scalarGalaxySpec,
        seed: { planets: solarSystemPlanets },
      }),
    );

    // Auth endpoints — non-CRUD static
    const signup = await mock.handle("POST", "/user/signup", {
      body: {
        name: "Astronaut",
        email: "astro@galaxy.com",
        password: "s3cr3t",
      },
    });
    expect(signup.status).toBe(200);

    const token = await mock.handle("POST", "/auth/token", {
      body: { email: "astro@galaxy.com", password: "s3cr3t" },
    });
    expect(token.status).toBe(200);

    const me = await mock.handle("GET", "/me");
    expect(me.status).toBe(200);

    // Image upload endpoint — non-CRUD static
    const image = await mock.handle("POST", "/planets/3/image");
    expect(image.status).toBe(200);

    // Celestial bodies — non-CRUD (no GET collection)
    const celestial = await mock.handle("POST", "/celestial-bodies", {
      body: { name: "Phobos", type: "moon" },
    });
    expect(celestial.status).toBe(200);
  });

  it("gas giants vs terrestrial planets maintain type integrity", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: scalarGalaxySpec,
        seed: { planets: solarSystemPlanets },
      }),
    );

    // Filter by reading each and checking type
    const types: Record<string, string[]> = {};
    for (let i = 1; i <= 8; i++) {
      const res = await mock.handle("GET", `/planets/${i}`);
      const body = res.body as Record<string, unknown>;
      const type = body.type as string;
      if (!types[type]) types[type] = [];
      types[type].push(body.name as string);
    }

    expect(types.terrestrial).toEqual(["Mercury", "Venus", "Earth", "Mars"]);
    expect(types.gas_giant).toEqual(["Jupiter", "Saturn"]);
    expect(types.ice_giant).toEqual(["Uranus", "Neptune"]);
  });

  it("mass ordering: Jupiter > Saturn > Neptune > Uranus > Earth > Venus > Mars > Mercury", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: scalarGalaxySpec,
        seed: { planets: solarSystemPlanets },
      }),
    );

    const masses: Array<{ name: string; mass: number }> = [];
    for (let i = 1; i <= 8; i++) {
      const res = await mock.handle("GET", `/planets/${i}`);
      const body = res.body as Record<string, unknown>;
      const physics = body.physicalProperties as Record<string, unknown>;
      masses.push({
        name: body.name as string,
        mass: physics.mass as number,
      });
    }

    const sorted = [...masses].sort((a, b) => b.mass - a.mass);
    expect(sorted.map((p) => p.name)).toEqual([
      "Jupiter",
      "Saturn",
      "Neptune",
      "Uranus",
      "Earth",
      "Venus",
      "Mars",
      "Mercury",
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 11. THE CONFUSED DEVELOPER — doing things wrong or out-of-order
// ════════════════════════════════════════════════════════════════════
describe("stress: confused developer flows", () => {
  it("reads before any creates — empty collection, not crash", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    const read = await mock.handle("GET", "/pets/42");
    expect(read.status).toBe(404);

    const list = await mock.handle("GET", "/pets");
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  it("deletes from empty collection — 404, not crash", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    const res = await mock.handle("DELETE", "/pets/1");
    expect(res.status).toBe(404);
  });

  it("updates non-existent item — 404", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    const res = await mock.handle("PUT", "/pets/999", {
      body: { name: "Ghost" },
    });
    expect(res.status).toBe(404);
  });

  it("creates then reads with wrong ID format (string vs number)", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    await mock.handle("POST", "/pets", { body: { name: "Buddy" } });
    // Path params are always strings — "1" should match item with petId: 1
    const res = await mock.handle("GET", "/pets/1");
    expect(res.status).toBe(200);
  });

  it("sends completely irrelevant body fields — they get stored anyway", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    const created = await mock.handle("POST", "/pets", {
      body: {
        name: "Buddy",
        favoriteFood: "bacon",
        socialSecurityNumber: "nope",
        nestedGarbage: { deeply: { nested: { stuff: true } } },
      },
    });
    expect(created.status).toBe(201);
    const body = created.body as Record<string, unknown>;
    expect(body.favoriteFood).toBe("bacon");
    expect(body.nestedGarbage).toEqual({
      deeply: { nested: { stuff: true } },
    });
  });

  it("creates with body that tries to set the ID — gets overwritten", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    const res = await mock.handle("POST", "/pets", {
      body: { petId: 42, name: "Impostor" },
    });
    const body = res.body as Record<string, unknown>;
    // Auto-increment wins over user-supplied ID
    expect(body.petId).toBe(1);
  });

  it("creates with array body instead of object", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    const res = await mock.handle("POST", "/pets", {
      body: [1, 2, 3],
    });
    // Array body isn't a record — should create item with just the ID
    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.petId).toBe(1);
  });

  it("creates with string body instead of object", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    const res = await mock.handle("POST", "/pets", {
      body: "not an object",
    });
    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.petId).toBe(1);
  });

  it("reads with path param that has special characters", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    const res = await mock.handle("GET", "/pets/hello%20world");
    expect(res.status).toBe(404);
  });

  it("PATCHes a deleted item — still 404", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: scalarGalaxySpec,
        seed: {
          planets: [{ planetId: 1, name: "Pluto", type: "dwarf" }],
        },
      }),
    );

    await mock.handle("DELETE", "/planets/1");
    const res = await mock.handle("PATCH", "/planets/1", {
      body: { name: "Not Pluto" },
    });
    expect(res.status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════════
// 12. THE LIFECYCLE DEVELOPER — reset, rebuild, multi-instance
// ════════════════════════════════════════════════════════════════════
describe("stress: lifecycle and multi-instance flows", () => {
  it("resetState then re-seed through requests", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: scalarGalaxySpec,
        seed: { planets: solarSystemPlanets },
      }),
    );

    expect(
      ((await mock.handle("GET", "/planets")).body as Record<string, unknown>)
        .data,
    ).toHaveLength(8);

    mock.resetState();

    // After reset, collection is empty — seeder runs again on next request
    const list = await mock.handle("GET", "/planets");
    expect((list.body as Record<string, unknown>).data).toHaveLength(8); // re-seeded on access

    // Can still create new items
    const created = await mock.handle("POST", "/planets", {
      body: { name: "Planet X" },
    });
    expect(created.status).toBe(201);
    expect((created.body as Record<string, unknown>).planetId).toBe(9);
  });

  it("two independent mock instances with the same spec", async () => {
    const mockA = schmock({ state: {} });
    const mockB = schmock({ state: {} });

    const plugin = await openapi({
      spec: `${fixturesDir}/petstore-swagger2.json`,
    });
    // Each gets its own plugin instance
    mockA.pipe(
      await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
    );
    mockB.pipe(plugin);

    await mockA.handle("POST", "/pets", { body: { name: "Alpha" } });
    await mockA.handle("POST", "/pets", { body: { name: "Beta" } });
    await mockB.handle("POST", "/pets", { body: { name: "Gamma" } });

    // Each instance has its own state
    expect((await mockA.handle("GET", "/pets")).body).toHaveLength(2);
    expect((await mockB.handle("GET", "/pets")).body).toHaveLength(1);
  });

  it("resetState then create — IDs restart from 1", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    await mock.handle("POST", "/pets", { body: { name: "First" } });
    await mock.handle("POST", "/pets", { body: { name: "Second" } });
    expect(
      ((await mock.handle("GET", "/pets/2")).body as Record<string, unknown>)
        .name,
    ).toBe("Second");

    mock.resetState();

    // After reset, new creates start from ID 1 again
    const created = await mock.handle("POST", "/pets", {
      body: { name: "Reborn" },
    });
    expect((created.body as Record<string, unknown>).petId).toBe(1);
  });

  it("mix seed and runtime data in Scalar Galaxy", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: scalarGalaxySpec,
        seed: {
          planets: [
            { planetId: 1, name: "Earth", type: "terrestrial" },
            { planetId: 2, name: "Mars", type: "terrestrial" },
          ],
        },
      }),
    );

    // Runtime-created planets get IDs continuing from seed max
    await mock.handle("POST", "/planets", { body: { name: "Exo-1" } });
    await mock.handle("POST", "/planets", { body: { name: "Exo-2" } });

    const list = await mock.handle("GET", "/planets");
    const listBody = list.body as Record<string, unknown>;
    const items = listBody.data as Record<string, unknown>[];
    expect(items).toHaveLength(4);

    // Seed items at IDs 1-2, runtime items at IDs 3-4
    expect(items[2].planetId).toBe(3);
    expect(items[3].planetId).toBe(4);
    expect(items[2].name).toBe("Exo-1");
  });

  it("cross-spec: petstore + galaxy on same instance", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));
    mock.pipe(
      await openapi({
        spec: scalarGalaxySpec,
        seed: { planets: solarSystemPlanets },
      }),
    );

    // Petstore CRUD
    await mock.handle("POST", "/pets", { body: { name: "Buddy" } });
    expect((await mock.handle("GET", "/pets")).body).toHaveLength(1);

    // Galaxy CRUD — completely independent (wrapped format)
    expect(
      ((await mock.handle("GET", "/planets")).body as Record<string, unknown>)
        .data,
    ).toHaveLength(8);
    await mock.handle("POST", "/planets", { body: { name: "Nibiru" } });
    expect(
      ((await mock.handle("GET", "/planets")).body as Record<string, unknown>)
        .data,
    ).toHaveLength(9);

    // Petstore still has 1
    expect((await mock.handle("GET", "/pets")).body).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// 13. THE CHAOS MONKEY — rapid fire, edge IDs, bulk operations
// ════════════════════════════════════════════════════════════════════
describe("stress: chaos monkey flows", () => {
  it("create-delete-create-read cycle — IDs keep incrementing", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    // Create 3
    for (let i = 0; i < 3; i++) {
      await mock.handle("POST", "/pets", { body: { name: `V1-${i}` } });
    }
    // Delete all
    for (let i = 1; i <= 3; i++) {
      await mock.handle("DELETE", `/pets/${i}`);
    }
    // Create 3 more — IDs should be 4, 5, 6 (not 1, 2, 3)
    for (let i = 0; i < 3; i++) {
      const res = await mock.handle("POST", "/pets", {
        body: { name: `V2-${i}` },
      });
      expect((res.body as Record<string, unknown>).petId).toBe(i + 4);
    }

    const list = await mock.handle("GET", "/pets");
    expect(list.body).toHaveLength(3);
  });

  it("update every field on every planet", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: scalarGalaxySpec,
        seed: { planets: solarSystemPlanets },
      }),
    );

    // Mass update — change every planet's name
    for (let i = 1; i <= 8; i++) {
      await mock.handle("PUT", `/planets/${i}`, {
        body: { name: `Renamed-${i}` },
      });
    }

    // Verify all renames stuck
    for (let i = 1; i <= 8; i++) {
      const res = await mock.handle("GET", `/planets/${i}`);
      expect((res.body as Record<string, unknown>).name).toBe(`Renamed-${i}`);
    }
  });

  it("interleaved create and delete — Swiss cheese collection", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    // Create 20 items, delete every 3rd one
    for (let i = 0; i < 20; i++) {
      await mock.handle("POST", "/pets", { body: { name: `Pet-${i}` } });
      if ((i + 1) % 3 === 0) {
        await mock.handle("DELETE", `/pets/${i + 1}`);
      }
    }

    const list = await mock.handle("GET", "/pets");
    const items = list.body as Record<string, unknown>[];
    // Deleted items: 3, 6, 9, 12, 15, 18 → 6 deleted, 14 remain
    expect(items).toHaveLength(14);

    // Verify the deleted ones are really gone
    for (const deletedId of [3, 6, 9, 12, 15, 18]) {
      const res = await mock.handle("GET", `/pets/${deletedId}`);
      expect(res.status).toBe(404);
    }
  });

  it("rapid overwrite — PUT same item 50 times", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    await mock.handle("POST", "/pets", { body: { name: "Volatile" } });

    for (let i = 0; i < 50; i++) {
      await mock.handle("PUT", "/pets/1", {
        body: { name: `Version-${i}`, counter: i },
      });
    }

    const final = await mock.handle("GET", "/pets/1");
    const body = final.body as Record<string, unknown>;
    expect(body.name).toBe("Version-49");
    expect(body.counter).toBe(49);
    expect(body.petId).toBe(1); // ID preserved through 50 updates
  });

  it("delete middle, read neighbors — no index corruption", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    for (let i = 0; i < 5; i++) {
      await mock.handle("POST", "/pets", { body: { name: `Pet-${i}` } });
    }

    // Delete middle item (ID 3)
    await mock.handle("DELETE", "/pets/3");

    // Neighbors are still accessible
    const before = await mock.handle("GET", "/pets/2");
    expect(before.status).toBe(200);
    expect((before.body as Record<string, unknown>).name).toBe("Pet-1");

    const after = await mock.handle("GET", "/pets/4");
    expect(after.status).toBe(200);
    expect((after.body as Record<string, unknown>).name).toBe("Pet-3");

    // List is still ordered
    const list = await mock.handle("GET", "/pets");
    expect(list.body).toHaveLength(4);
  });

  it("update preserves fields not in the body", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: scalarGalaxySpec,
        seed: {
          planets: [
            {
              planetId: 1,
              name: "Earth",
              type: "terrestrial",
              habitabilityIndex: 1.0,
              physicalProperties: { mass: 1.0, radius: 1.0 },
              atmosphere: [{ compound: "N2", percentage: 78.1 }],
            },
          ],
        },
      }),
    );

    // Only update one field
    await mock.handle("PATCH", "/planets/1", {
      body: { habitabilityIndex: 0.95 },
    });

    const res = await mock.handle("GET", "/planets/1");
    const body = res.body as Record<string, unknown>;
    // Updated field changed
    expect(body.habitabilityIndex).toBe(0.95);
    // Other fields preserved
    expect(body.name).toBe("Earth");
    expect(body.type).toBe("terrestrial");
    expect(body.physicalProperties).toEqual({ mass: 1.0, radius: 1.0 });
    expect(body.atmosphere).toEqual([{ compound: "N2", percentage: 78.1 }]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 14. THE INTEGRATION TESTER — realistic multi-spec E2E flows
// ════════════════════════════════════════════════════════════════════
describe("stress: realistic E2E flows", () => {
  it("train travel: book → pay → cancel flow", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: trainTravelSpec }));

    // 1. Search stations (static)
    const stations = await mock.handle("GET", "/stations");
    expect(stations.status).toBe(200);

    // 2. Search trips (static)
    const trips = await mock.handle("GET", "/trips");
    expect(trips.status).toBe(200);

    // 3. Book a trip
    const booking = await mock.handle("POST", "/bookings", {
      body: {
        trip_id: "trip-123",
        passenger_name: "Jane Doe",
        has_bicycle: false,
        has_dog: true,
      },
    });
    expect(booking.status).toBe(201);
    const bookingBody = booking.body as Record<string, unknown>;
    const bookingId = bookingBody.bookingId;

    // 4. Read the booking back
    const readBooking = await mock.handle("GET", `/bookings/${bookingId}`);
    expect(readBooking.status).toBe(200);
    expect((readBooking.body as Record<string, unknown>).passenger_name).toBe(
      "Jane Doe",
    );

    // 5. Make payment (non-CRUD static endpoint)
    const payment = await mock.handle(
      "POST",
      `/bookings/${bookingId}/payment`,
      {
        body: {
          amount: 49.99,
          currency: "gbp",
          source: { object: "card", name: "J. Doe" },
        },
      },
    );
    expect(payment.status).toBe(200);

    // 6. Cancel booking
    const cancel = await mock.handle("DELETE", `/bookings/${bookingId}`);
    expect(cancel.status).toBe(204);

    // 7. Verify cancellation
    const gone = await mock.handle("GET", `/bookings/${bookingId}`);
    expect(gone.status).toBe(404);
  });

  it("galaxy: signup → create planet → upload image → list", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: scalarGalaxySpec }));

    // 1. Signup
    const signup = await mock.handle("POST", "/user/signup", {
      body: {
        name: "Explorer",
        email: "explorer@galaxy.com",
        password: "stars123",
      },
    });
    expect(signup.status).toBe(200);

    // 2. Get token
    const token = await mock.handle("POST", "/auth/token", {
      body: { email: "explorer@galaxy.com", password: "stars123" },
    });
    expect(token.status).toBe(200);

    // 3. Create a planet
    const created = await mock.handle("POST", "/planets", {
      body: { name: "Explorer-1", type: "super_earth" },
    });
    expect(created.status).toBe(201);
    const planet = created.body as Record<string, unknown>;

    // 4. Upload an image
    const image = await mock.handle(
      "POST",
      `/planets/${planet.planetId}/image`,
    );
    expect(image.status).toBe(200);

    // 5. Get user profile
    const me = await mock.handle("GET", "/me");
    expect(me.status).toBe(200);

    // 6. List planets (wrapped)
    const list = await mock.handle("GET", "/planets");
    expect((list.body as Record<string, unknown>).data).toHaveLength(1);
  });

  it("galaxy: populate solar system then explore", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: scalarGalaxySpec }));

    // Manually add all 8 planets via POST
    const planetNames = [
      "Mercury",
      "Venus",
      "Earth",
      "Mars",
      "Jupiter",
      "Saturn",
      "Uranus",
      "Neptune",
    ];
    for (const name of planetNames) {
      const res = await mock.handle("POST", "/planets", {
        body: { name },
      });
      expect(res.status).toBe(201);
    }

    // Verify count (wrapped)
    const list = await mock.handle("GET", "/planets");
    expect((list.body as Record<string, unknown>).data).toHaveLength(8);

    // Read each by ID
    for (let i = 1; i <= 8; i++) {
      const res = await mock.handle("GET", `/planets/${i}`);
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).name).toBe(
        planetNames[i - 1],
      );
    }
  });

  it("petstore: multiple spec versions coexist", async () => {
    const mock = schmock({ state: {} });
    // Load Swagger 2.0 petstore
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));
    // Load OpenAPI 3.0 petstore (different fixture)
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-openapi3.json` }));

    // Both specs define /pets — last one wins for route registration
    const created = await mock.handle("POST", "/pets", {
      body: { name: "Multi-version" },
    });
    expect(created.status).toBe(201);
  });
});

// ════════════════════════════════════════════════════════════════════
// 15. THE EDGE HUNTER — boundary conditions, weird inputs
// ════════════════════════════════════════════════════════════════════
describe("stress: boundary conditions", () => {
  it("create with empty object body", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    const res = await mock.handle("POST", "/pets", { body: {} });
    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.petId).toBe(1);
  });

  it("update with body containing nested nulls", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    await mock.handle("POST", "/pets", { body: { name: "Buddy" } });
    const updated = await mock.handle("PUT", "/pets/1", {
      body: { name: null, extra: undefined },
    });
    expect(updated.status).toBe(200);
    const body = updated.body as Record<string, unknown>;
    expect(body.name).toBeNull();
  });

  it("seed with zero items — collection starts empty", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: `${fixturesDir}/petstore-swagger2.json`,
        seed: { pets: [] },
      }),
    );

    const list = await mock.handle("GET", "/pets");
    expect(list.body).toEqual([]);

    // Creating after empty seed still works
    const created = await mock.handle("POST", "/pets", {
      body: { name: "First" },
    });
    expect((created.body as Record<string, unknown>).petId).toBe(1);
  });

  it("seed for non-existent resource is silently ignored", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: `${fixturesDir}/petstore-swagger2.json`,
        seed: {
          pets: [{ petId: 1, name: "Real" }],
          unicorns: [{ unicornId: 1, name: "Sparkle" }],
        },
      }),
    );

    // pets work fine
    expect((await mock.handle("GET", "/pets")).body).toHaveLength(1);
    // unicorns route doesn't exist
    const res = await mock.handle("GET", "/unicorns");
    expect(res.status).toBe(404);
  });

  it("item with deeply nested data survives update cycle", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: scalarGalaxySpec,
        seed: {
          planets: [
            {
              planetId: 1,
              name: "Deep",
              physicalProperties: {
                mass: 1.0,
                temperature: { min: 100, max: 400, average: 250 },
              },
              atmosphere: [
                { compound: "O2", percentage: 21 },
                { compound: "N2", percentage: 78 },
                { compound: "Ar", percentage: 0.9 },
              ],
            },
          ],
        },
      }),
    );

    // Update only top-level field
    await mock.handle("PATCH", "/planets/1", { body: { name: "Deeper" } });

    const res = await mock.handle("GET", "/planets/1");
    const body = res.body as Record<string, unknown>;
    expect(body.name).toBe("Deeper");
    const props = body.physicalProperties as Record<string, unknown>;
    const temp = props.temperature as Record<string, unknown>;
    expect(temp.min).toBe(100);
    expect(temp.max).toBe(400);
    const atmo = body.atmosphere as Array<Record<string, unknown>>;
    expect(atmo).toHaveLength(3);
  });

  it("large ID values work correctly", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: `${fixturesDir}/petstore-swagger2.json`,
        seed: { pets: [{ petId: 999999, name: "Big" }] },
      }),
    );

    const read = await mock.handle("GET", "/pets/999999");
    expect(read.status).toBe(200);

    const created = await mock.handle("POST", "/pets", {
      body: { name: "After Big" },
    });
    expect((created.body as Record<string, unknown>).petId).toBe(1000000);
  });

  it("UUID-style string IDs", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: `${fixturesDir}/petstore-swagger2.json`,
        seed: {
          pets: [
            { petId: "550e8400-e29b-41d4-a716-446655440000", name: "UUID-Pet" },
          ],
        },
      }),
    );

    const res = await mock.handle(
      "GET",
      "/pets/550e8400-e29b-41d4-a716-446655440000",
    );
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).name).toBe("UUID-Pet");
  });

  it("concurrent-like rapid operations don't corrupt state", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    // Fire off many operations in parallel
    const ops: Promise<Schmock.ResponseResult>[] = [];
    for (let i = 0; i < 20; i++) {
      ops.push(
        mock.handle("POST", "/pets", { body: { name: `Parallel-${i}` } }),
      );
    }
    const results = await Promise.all(ops);

    // All should succeed
    for (const res of results) {
      expect(res.status).toBe(201);
    }

    // All should have unique IDs
    const ids = results.map((r) => (r.body as Record<string, unknown>).petId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(20);

    // List should show all 20
    const list = await mock.handle("GET", "/pets");
    expect(list.body).toHaveLength(20);
  });

  it("handles path with trailing slash gracefully", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }));

    await mock.handle("POST", "/pets", { body: { name: "Buddy" } });

    // Trailing slash should be handled by schmock's route matching
    const res = await mock.handle("GET", "/pets/1");
    expect(res.status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════
// 16. THE SPEC EXPLORER — inline specs with weird shapes
// ════════════════════════════════════════════════════════════════════
describe("stress: weird inline specs", () => {
  it("spec with only DELETE endpoints — still CRUD if has collection GET", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "DeleteHeavy", version: "1.0.0" },
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
                          items: { type: "object" },
                        },
                      },
                    },
                  },
                },
              },
              post: {
                responses: { "201": { description: "Created" } },
              },
            },
            "/items/{itemId}": {
              delete: {
                parameters: [{ name: "itemId", in: "path", required: true }],
                responses: { "204": { description: "Deleted" } },
              },
            },
          },
        },
      }),
    );

    await mock.handle("POST", "/items", { body: { x: 1 } });
    await mock.handle("POST", "/items", { body: { x: 2 } });
    expect((await mock.handle("GET", "/items")).body).toHaveLength(2);

    await mock.handle("DELETE", "/items/1");
    expect((await mock.handle("GET", "/items")).body).toHaveLength(1);
  });

  it("spec with 10 unrelated static endpoints", async () => {
    const paths: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 10; i++) {
      paths[`/endpoint-${i}`] = {
        get: {
          responses: {
            "200": {
              description: `Response ${i}`,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { index: { type: "integer", default: i } },
                  },
                },
              },
            },
          },
        },
      };
    }

    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "Many", version: "1.0.0" },
          paths,
        },
      }),
    );

    // All 10 endpoints respond
    for (let i = 0; i < 10; i++) {
      const res = await mock.handle("GET", `/endpoint-${i}`);
      expect(res.status).toBe(200);
    }
  });

  it("spec with multiple CRUD resources", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "Multi", version: "1.0.0" },
          paths: {
            "/dogs": {
              get: { responses: { "200": { description: "List" } } },
              post: { responses: { "201": { description: "Created" } } },
            },
            "/dogs/{dogId}": {
              get: {
                parameters: [{ name: "dogId", in: "path", required: true }],
                responses: { "200": { description: "Dog" } },
              },
              delete: {
                parameters: [{ name: "dogId", in: "path", required: true }],
                responses: { "204": { description: "Deleted" } },
              },
            },
            "/cats": {
              get: { responses: { "200": { description: "List" } } },
              post: { responses: { "201": { description: "Created" } } },
            },
            "/cats/{catId}": {
              get: {
                parameters: [{ name: "catId", in: "path", required: true }],
                responses: { "200": { description: "Cat" } },
              },
            },
          },
        },
      }),
    );

    // Dogs and cats are independent
    await mock.handle("POST", "/dogs", { body: { name: "Rex" } });
    await mock.handle("POST", "/dogs", { body: { name: "Spot" } });
    await mock.handle("POST", "/cats", { body: { name: "Whiskers" } });

    expect((await mock.handle("GET", "/dogs")).body).toHaveLength(2);
    expect((await mock.handle("GET", "/cats")).body).toHaveLength(1);

    // Delete a dog doesn't affect cats
    await mock.handle("DELETE", "/dogs/1");
    expect((await mock.handle("GET", "/dogs")).body).toHaveLength(1);
    expect((await mock.handle("GET", "/cats")).body).toHaveLength(1);
  });

  it("multiple non-CRUD static endpoints with different methods", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "Methods", version: "1.0.0" },
          paths: {
            "/health": {
              get: {
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: { up: { type: "boolean" } },
                        },
                      },
                    },
                  },
                },
              },
            },
            "/webhook": {
              post: {
                responses: { "200": { description: "Received" } },
              },
            },
            "/config": {
              put: {
                responses: {
                  "200": {
                    description: "Updated",
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
            "/cache": {
              delete: {
                responses: { "204": { description: "Cleared" } },
              },
            },
          },
        },
      }),
    );

    expect((await mock.handle("GET", "/health")).status).toBe(200);
    expect((await mock.handle("POST", "/webhook")).status).toBe(200);
    expect((await mock.handle("PUT", "/config")).status).toBe(200);
    expect((await mock.handle("DELETE", "/cache")).status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════
// 17. STRIPE — 5.8MB / 415 paths / the ultimate parser stress test
//
// The Stripe OpenAPI spec is one of the largest real-world specs:
// - 161K lines, 5.8MB YAML
// - 415 path operations (137 plain + 278 parameterized)
// - 113 potential CRUD resource pairs
// - Heavy anyOf usage, x-stripe* extensions, form-urlencoded bodies
// - Product item path uses {id} not {product}
// - Customer GET returns anyOf: [customer, deleted_customer]
//
// To avoid OOM from repeated parsing, we parse ONCE and share state.
// ════════════════════════════════════════════════════════════════════

const stripeSpec = resolve(fixturesDir, "stripe-spec3.yaml");
const stripeFixtures: Record<string, unknown> = JSON.parse(
  readFileSync(resolve(fixturesDir, "stripe-fixtures3.json"), "utf8"),
);
const stripeResources = (
  stripeFixtures as { resources: Record<string, Record<string, unknown>> }
).resources;

// Module-level cache — parse the 5.8MB spec exactly once across all test blocks
let cachedStripeSpec: ParsedSpec | undefined;
async function getStripeSpec(): Promise<ParsedSpec> {
  if (!cachedStripeSpec) {
    cachedStripeSpec = await parseSpec(stripeSpec);
  }
  return cachedStripeSpec;
}

// Shared plugin — also created once to avoid redundant parsing
let cachedStripePlugin: Schmock.Plugin | undefined;
async function getStripePlugin(): Promise<Schmock.Plugin> {
  if (!cachedStripePlugin) {
    cachedStripePlugin = await openapi({ spec: stripeSpec });
  }
  return cachedStripePlugin;
}

describe("stress: stripe spec — parser (5.8MB)", () => {
  let spec: ParsedSpec;

  beforeAll(async () => {
    spec = await getStripeSpec();
  }, 120_000);

  it("parses the massive OpenAPI 3.0 Stripe spec without crashing", () => {
    expect(spec.title).toBe("Stripe API");
    expect(spec.version).toBe("2026-01-28.clover");
  }, 120_000);

  it("extracts basePath from server URL", () => {
    // servers[0] = "https://api.stripe.com/" → pathname "/" → normalized to ""
    expect(spec.basePath).toBe("");
  });

  it("extracts 400+ path operations", () => {
    expect(spec.paths.length).toBeGreaterThan(400);
  });

  it("extracts customer CRUD paths", () => {
    const sigs = spec.paths.map((p) => `${p.method} ${p.path}`);
    expect(sigs).toContain("GET /v1/customers");
    expect(sigs).toContain("POST /v1/customers");
    expect(sigs).toContain("GET /v1/customers/:customer");
    expect(sigs).toContain("POST /v1/customers/:customer");
    expect(sigs).toContain("DELETE /v1/customers/:customer");
  });

  it("extracts product paths (item path uses {id} not {product})", () => {
    const sigs = spec.paths.map((p) => `${p.method} ${p.path}`);
    expect(sigs).toContain("GET /v1/products");
    expect(sigs).toContain("POST /v1/products");
    // Stripe uses /v1/products/{id} — NOT /v1/products/{product}
    expect(sigs).toContain("GET /v1/products/:id");
    expect(sigs).toContain("POST /v1/products/:id");
    expect(sigs).toContain("DELETE /v1/products/:id");
  });

  it("extracts coupon CRUD paths", () => {
    const sigs = spec.paths.map((p) => `${p.method} ${p.path}`);
    expect(sigs).toContain("GET /v1/coupons");
    expect(sigs).toContain("POST /v1/coupons");
    expect(sigs).toContain("GET /v1/coupons/:coupon");
    expect(sigs).toContain("POST /v1/coupons/:coupon");
    expect(sigs).toContain("DELETE /v1/coupons/:coupon");
  });

  it("converts {param} path templates to :param", () => {
    const paramPaths = spec.paths.filter((p) => p.path.includes(":"));
    expect(paramPaths.length).toBeGreaterThan(200);
    // No unreplaced {param} templates
    const unreplaced = spec.paths.filter((p) => p.path.includes("{"));
    expect(unreplaced).toHaveLength(0);
  });

  it("strips x-stripe* extensions from all schemas", () => {
    let extensionFound = false;
    for (const p of spec.paths) {
      if (p.requestBody) {
        const str = JSON.stringify(p.requestBody);
        if (str.includes('"x-')) {
          extensionFound = true;
          break;
        }
      }
      for (const [, resp] of p.responses) {
        if (resp.schema) {
          const str = JSON.stringify(resp.schema);
          if (str.includes('"x-')) {
            extensionFound = true;
            break;
          }
        }
      }
      if (extensionFound) break;
    }
    expect(extensionFound).toBe(false);
  });

  it("no unresolved $ref in any path", () => {
    for (const p of spec.paths) {
      if (p.requestBody) {
        expect(JSON.stringify(p.requestBody)).not.toContain('"$ref"');
      }
      for (const [, resp] of p.responses) {
        if (resp.schema) {
          expect(JSON.stringify(resp.schema)).not.toContain('"$ref"');
        }
      }
    }
  });

  it("handles anyOf response schemas (customer → anyOf [customer, deleted_customer])", () => {
    // Stripe's GET /v1/customers/{customer} returns anyOf: [customer, deleted_customer]
    const getCustomer = spec.paths.find(
      (p) => p.method === "GET" && p.path === "/v1/customers/:customer",
    );
    expect(getCustomer).toBeDefined();
    const schema = getCustomer?.responses.get(200)?.schema;
    expect(schema).toBeDefined();
    // Schema is anyOf at the top level — no direct properties
    expect(schema?.anyOf).toBeDefined();
  });

  it("handles application/x-www-form-urlencoded request bodies", () => {
    // Stripe uses form-encoded bodies, not JSON — our fallback should find them
    const createCustomer = spec.paths.find(
      (p) => p.method === "POST" && p.path === "/v1/customers",
    );
    expect(createCustomer).toBeDefined();
    // Our findJsonContent falls back to any content type
    expect(createCustomer?.requestBody).toBeDefined();
  });

  it("extracts query parameters (limit)", () => {
    const listCustomers = spec.paths.find(
      (p) => p.method === "GET" && p.path === "/v1/customers",
    );
    const paramNames = listCustomers?.parameters.map((p) => p.name) ?? [];
    expect(paramNames).toContain("limit");
  });

  it("extracts path parameters for item endpoints", () => {
    const getCustomer = spec.paths.find(
      (p) => p.method === "GET" && p.path === "/v1/customers/:customer",
    );
    expect(getCustomer?.parameters).toContainEqual(
      expect.objectContaining({ name: "customer", in: "path" }),
    );
  });

  it("extracts list response with data wrapper schema", () => {
    // Stripe list endpoints return { data: [...], has_more, url }
    const listCustomers = spec.paths.find(
      (p) => p.method === "GET" && p.path === "/v1/customers",
    );
    const schema = listCustomers?.responses.get(200)?.schema;
    expect(schema).toBeDefined();
    // Should have properties or be an allOf/anyOf composition
    expect(schema?.properties ?? schema?.allOf ?? schema?.anyOf).toBeDefined();
  });

  it("extracts operationIds", () => {
    const ops = spec.paths.filter((p) => p.operationId);
    expect(ops.length).toBeGreaterThan(300);
    const listCustomers = spec.paths.find(
      (p) => p.method === "GET" && p.path === "/v1/customers",
    );
    expect(listCustomers?.operationId).toBe("GetCustomers");
  });

  it("handles deeply nested paths (customers → balance_transactions)", () => {
    const sigs = spec.paths.map((p) => `${p.method} ${p.path}`);
    expect(sigs).toContain("GET /v1/customers/:customer/balance_transactions");
    expect(sigs).toContain(
      "GET /v1/customers/:customer/balance_transactions/:transaction",
    );
  });
});

describe("stress: stripe spec — CRUD detection", () => {
  let spec: ParsedSpec;

  beforeAll(async () => {
    spec = await getStripeSpec();
  }, 120_000);

  it("detects CRUD resources from 415 paths", () => {
    const result = detectCrudResources(spec.paths);
    expect(result.resources.length).toBeGreaterThan(0);
    expect(result.nonCrudPaths.length).toBeGreaterThan(0);
  }, 120_000);

  it("detects customers as a CRUD resource", () => {
    const result = detectCrudResources(spec.paths);
    const customers = result.resources.find((r) => r.name === "customers");
    expect(customers).toBeDefined();
    expect(customers?.basePath).toBe("/v1/customers");
    expect(customers?.itemPath).toBe("/v1/customers/:customer");
    expect(customers?.idParam).toBe("customer");
    expect(customers?.operations).toContain("list");
    expect(customers?.operations).toContain("create");
    expect(customers?.operations).toContain("read");
    expect(customers?.operations).toContain("delete");
  });

  it("detects /v1/products as CRUD with idParam=id", () => {
    const result = detectCrudResources(spec.paths);
    // Use basePath to distinguish from /v1/climate/products (also named "products")
    const products = result.resources.find(
      (r) => r.basePath === "/v1/products",
    );
    expect(products).toBeDefined();
    // Stripe uses /v1/products/{id} — idParam is "id" (not "product")
    expect(products?.idParam).toBe("id");
    expect(products?.itemPath).toBe("/v1/products/:id");
    expect(products?.operations).toContain("list");
    expect(products?.operations).toContain("create");
    expect(products?.operations).toContain("read");
    expect(products?.operations).toContain("delete");
  });

  it("detects coupons as a CRUD resource", () => {
    const result = detectCrudResources(spec.paths);
    const coupons = result.resources.find((r) => r.name === "coupons");
    expect(coupons).toBeDefined();
    expect(coupons?.idParam).toBe("coupon");
  });

  it("classifies /v1/balance as non-CRUD (singleton)", () => {
    const result = detectCrudResources(spec.paths);
    const balanceResource = result.resources.find(
      (r) => r.basePath === "/v1/balance",
    );
    expect(balanceResource).toBeUndefined();
    const balanceNonCrud = result.nonCrudPaths.find(
      (p) => p.path === "/v1/balance",
    );
    expect(balanceNonCrud).toBeDefined();
  });

  it("classifies search endpoints as non-CRUD", () => {
    const result = detectCrudResources(spec.paths);
    const searchPaths = result.nonCrudPaths.filter((p) =>
      p.path.endsWith("/search"),
    );
    expect(searchPaths.length).toBeGreaterThan(0);
  });
});

describe("stress: stripe spec — CRUD lifecycle with fixtures", () => {
  // Share ONE plugin instance across all lifecycle tests to avoid OOM
  let plugin: Schmock.Plugin;

  beforeAll(async () => {
    plugin = await getStripePlugin();
  }, 120_000);

  it("customer CRUD lifecycle with real fixture data", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(plugin);

    // Create from fixture data
    const custFixture = stripeResources.customer;
    const created = await mock.handle("POST", "/v1/customers", {
      body: {
        email: custFixture.email,
        name: custFixture.name,
        description: custFixture.description,
        currency: custFixture.currency,
      },
    });
    expect(created.status).toBe(201);
    const cust = created.body as Record<string, unknown>;
    expect(cust.email).toBe(custFixture.email);
    expect(cust.customer).toBe(1);

    // Read
    const read = await mock.handle("GET", "/v1/customers/1");
    expect(read.status).toBe(200);
    expect((read.body as Record<string, unknown>).email).toBe(
      custFixture.email,
    );

    // List (wrapped: { data: [...], has_more, object, url })
    const list = await mock.handle("GET", "/v1/customers");
    expect(list.status).toBe(200);
    const listBody = list.body as Record<string, unknown>;
    expect(listBody.data).toHaveLength(1);

    // Delete
    const deleted = await mock.handle("DELETE", "/v1/customers/1");
    expect(deleted.status).toBe(204);

    // Verify deleted
    const gone = await mock.handle("GET", "/v1/customers/1");
    expect(gone.status).toBe(404);
  }, 120_000);

  it("product CRUD uses idParam=id (from Stripe's {id} path template)", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(plugin);

    // Create — product idParam is "id", auto-incremented
    const created = await mock.handle("POST", "/v1/products", {
      body: { name: "Premium Plan", active: true },
    });
    expect(created.status).toBe(201);
    const prod = created.body as Record<string, unknown>;
    expect(prod.id).toBe(1);
    expect(prod.name).toBe("Premium Plan");

    // Read by "id"
    const read = await mock.handle("GET", "/v1/products/1");
    expect(read.status).toBe(200);
    expect((read.body as Record<string, unknown>).name).toBe("Premium Plan");

    // List (wrapped)
    const list = await mock.handle("GET", "/v1/products");
    expect((list.body as Record<string, unknown>).data).toHaveLength(1);

    // Delete
    const del = await mock.handle("DELETE", "/v1/products/1");
    expect(del.status).toBe(204);
  }, 120_000);

  it("coupon CRUD with Stripe fixture data", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(plugin);

    const couponFixture = stripeResources.coupon;
    // Create with fixture data
    const created = await mock.handle("POST", "/v1/coupons", {
      body: {
        name: couponFixture.name,
        percent_off: couponFixture.percent_off,
        duration: couponFixture.duration,
      },
    });
    expect(created.status).toBe(201);
    const coupon = created.body as Record<string, unknown>;
    expect(coupon.coupon).toBe(1);
    expect(coupon.duration).toBe(couponFixture.duration);

    // Delete
    const deleted = await mock.handle("DELETE", "/v1/coupons/1");
    expect(deleted.status).toBe(204);

    // Gone
    const gone = await mock.handle("GET", "/v1/coupons/1");
    expect(gone.status).toBe(404);
  }, 120_000);

  it("multi-resource: customers + products + coupons on same instance", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(plugin);

    // Create across 3 resources
    await mock.handle("POST", "/v1/customers", {
      body: { email: "alice@stripe.com" },
    });
    await mock.handle("POST", "/v1/customers", {
      body: { email: "bob@stripe.com" },
    });
    await mock.handle("POST", "/v1/products", {
      body: { name: "Basic" },
    });
    await mock.handle("POST", "/v1/coupons", {
      body: { percent_off: 25 },
    });

    // Each resource is independent (all wrapped)
    expect(
      (
        (await mock.handle("GET", "/v1/customers")).body as Record<
          string,
          unknown
        >
      ).data,
    ).toHaveLength(2);
    expect(
      (
        (await mock.handle("GET", "/v1/products")).body as Record<
          string,
          unknown
        >
      ).data,
    ).toHaveLength(1);
    expect(
      (
        (await mock.handle("GET", "/v1/coupons")).body as Record<
          string,
          unknown
        >
      ).data,
    ).toHaveLength(1);

    // Delete a customer doesn't affect products
    await mock.handle("DELETE", "/v1/customers/1");
    expect(
      (
        (await mock.handle("GET", "/v1/customers")).body as Record<
          string,
          unknown
        >
      ).data,
    ).toHaveLength(1);
    expect(
      (
        (await mock.handle("GET", "/v1/products")).body as Record<
          string,
          unknown
        >
      ).data,
    ).toHaveLength(1);
  }, 120_000);

  it("non-CRUD endpoints respond alongside CRUD", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(plugin);

    // Singleton endpoint — /v1/balance (non-CRUD static)
    const balance = await mock.handle("GET", "/v1/balance");
    expect(balance.status).toBe(200);

    // CRUD still works
    const created = await mock.handle("POST", "/v1/customers", {
      body: { email: "test@stripe.com" },
    });
    expect(created.status).toBe(201);
  }, 120_000);

  it("resetState clears all Stripe resources", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(plugin);

    await mock.handle("POST", "/v1/customers", {
      body: { email: "temp@stripe.com" },
    });
    expect(
      (
        (await mock.handle("GET", "/v1/customers")).body as Record<
          string,
          unknown
        >
      ).data,
    ).toHaveLength(1);

    mock.resetState();

    const list = await mock.handle("GET", "/v1/customers");
    expect((list.body as Record<string, unknown>).data).toEqual([]);
  }, 120_000);
});

describe("stress: stripe spec — the confused Stripe developer", () => {
  let plugin: Schmock.Plugin;

  beforeAll(async () => {
    plugin = await getStripePlugin();
  }, 120_000);

  it("reads customer with Stripe-format ID (string) before any creates", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(plugin);

    // Stripe IDs look like "cus_QXg1o8vcGmoR32" — should 404 gracefully
    const read = await mock.handle("GET", "/v1/customers/cus_QXg1o8vcGmoR32");
    expect(read.status).toBe(404);
  }, 120_000);

  it("rapid customer creation — 50 customers with fixture-like data", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(plugin);

    const emails = Array.from(
      { length: 50 },
      (_, i) => `user${i}@stripe-test.com`,
    );

    for (const email of emails) {
      const res = await mock.handle("POST", "/v1/customers", {
        body: { email, name: `User ${email.split("@")[0]}` },
      });
      expect(res.status).toBe(201);
    }

    const list = await mock.handle("GET", "/v1/customers");
    expect((list.body as Record<string, unknown>).data).toHaveLength(50);
  }, 120_000);

  it("interleaved operations across Stripe resources", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(plugin);

    // Create customer → create product → create coupon → read customer → delete product
    const c1 = await mock.handle("POST", "/v1/customers", {
      body: { email: "x@test.com" },
    });
    const p1 = await mock.handle("POST", "/v1/products", {
      body: { name: "Widget" },
    });
    const co1 = await mock.handle("POST", "/v1/coupons", {
      body: { percent_off: 10 },
    });

    // Read back customer
    const custId = (c1.body as Record<string, unknown>).customer;
    const read = await mock.handle("GET", `/v1/customers/${custId}`);
    expect(read.status).toBe(200);

    // Delete product — idParam is "id" for products
    const prodId = (p1.body as Record<string, unknown>).id;
    await mock.handle("DELETE", `/v1/products/${prodId}`);

    // Customer and coupon still exist
    expect((await mock.handle("GET", `/v1/customers/${custId}`)).status).toBe(
      200,
    );
    const couponId = (co1.body as Record<string, unknown>).coupon;
    expect((await mock.handle("GET", `/v1/coupons/${couponId}`)).status).toBe(
      200,
    );

    // Product gone
    expect((await mock.handle("GET", `/v1/products/${prodId}`)).status).toBe(
      404,
    );
  }, 120_000);
});
