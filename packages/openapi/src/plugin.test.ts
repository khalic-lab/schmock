import { resolve } from "node:path";
import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { openapi } from "./plugin";

const fixturesDir = resolve(import.meta.dirname, "__fixtures__");

describe("openapi plugin", () => {
  describe("Swagger 2.0 integration", () => {
    it("auto-registers all routes from Petstore spec", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );

      // List (should be empty initially)
      const listResponse = await mock.handle("GET", "/pets");
      expect(listResponse.status).toBe(200);
      expect(listResponse.body).toEqual([]);
    });

    it("CRUD lifecycle with Swagger 2.0", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );

      // Create
      const created = await mock.handle("POST", "/pets", {
        body: { name: "Buddy", tag: "dog" },
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: "Buddy", petId: 1 });

      // Read
      const read = await mock.handle("GET", "/pets/1");
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ name: "Buddy", petId: 1 });

      // Update
      const updated = await mock.handle("PUT", "/pets/1", {
        body: { name: "Max" },
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ name: "Max", petId: 1 });

      // List
      const list = await mock.handle("GET", "/pets");
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);

      // Delete
      const deleted = await mock.handle("DELETE", "/pets/1");
      expect(deleted.status).toBe(204);

      // Verify deletion
      const afterDelete = await mock.handle("GET", "/pets/1");
      expect(afterDelete.status).toBe(404);
      expect(afterDelete.body).toMatchObject({
        error: "Not found",
        code: "NOT_FOUND",
      });
    });

    it("handles non-CRUD endpoints", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );

      // Health endpoint — should return a generated response
      const health = await mock.handle("GET", "/health");
      expect(health.status).toBe(200);
      expect(health.body).toBeDefined();
    });
  });

  describe("OpenAPI 3.0 integration", () => {
    it("auto-registers routes from OpenAPI 3.0 spec", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-openapi3.json` }),
      );

      const list = await mock.handle("GET", "/pets");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body)).toBe(true);
    });
  });

  describe("seed data", () => {
    it("seeds inline data", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: `${fixturesDir}/petstore-swagger2.json`,
          seed: {
            pets: [
              { petId: 1, name: "Buddy" },
              { petId: 2, name: "Max" },
            ],
          },
        }),
      );

      const list = await mock.handle("GET", "/pets");
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(2);
    });

    it("seeds auto-generated data from schema", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: `${fixturesDir}/petstore-swagger2.json`,
          seed: {
            pets: { count: 5 },
          },
        }),
      );

      const list = await mock.handle("GET", "/pets");
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(5);
    });

    it("seeded data works with read endpoints", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: `${fixturesDir}/petstore-swagger2.json`,
          seed: {
            pets: [{ petId: 42, name: "Luna" }],
          },
        }),
      );

      const read = await mock.handle("GET", "/pets/42");
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ petId: 42, name: "Luna" });
    });

    it("continues auto-incrementing after seeded data", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: `${fixturesDir}/petstore-swagger2.json`,
          seed: {
            pets: [
              { petId: 1, name: "Buddy" },
              { petId: 2, name: "Max" },
            ],
          },
        }),
      );

      const created = await mock.handle("POST", "/pets", {
        body: { name: "New" },
      });
      expect(created.status).toBe(201);
      // Should get ID 3 since max existing ID is 2
      expect(created.body).toMatchObject({ petId: 3 });
    });
  });

  describe("404 handling", () => {
    it("returns 404 for non-existent items", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );

      const read = await mock.handle("GET", "/pets/999");
      expect(read.status).toBe(404);
      expect(read.body).toMatchObject({
        error: "Not found",
        code: "NOT_FOUND",
      });
    });
  });

  describe("state isolation", () => {
    it("isolates state between separate mock instances", async () => {
      const mock1 = schmock({ state: {} });
      mock1.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );

      const mock2 = schmock({ state: {} });
      mock2.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );

      await mock1.handle("POST", "/pets", { body: { name: "A" } });

      const list1 = await mock1.handle("GET", "/pets");
      const list2 = await mock2.handle("GET", "/pets");

      const body1 = list1.body;
      const body2 = list2.body;
      expect(Array.isArray(body1) && body1.length).toBe(1);
      expect(Array.isArray(body2) && body2.length).toBe(0);
    });
  });
});
