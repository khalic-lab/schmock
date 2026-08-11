import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { fakerPlugin, generateFromSchema } from "./index";
import { generate, schemas } from "./test-utils";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  expect(isRecord(value)).toBe(true);
  if (!isRecord(value)) throw new Error("Expected generated object data");
}

function expectGeneratedUser(value: unknown): void {
  expectRecord(value);
  expect(value.id).toEqual(expect.any(String));
  expect(value.email).toEqual(expect.any(String));
  expect(value.firstName).toEqual(expect.any(String));
  expect(value.lastName).toEqual(expect.any(String));
  expect(value.createdAt).toEqual(expect.any(String));
}

function pluginContext(): Schmock.PluginContext {
  return {
    method: "GET",
    path: "/test",
    params: {},
    query: {},
    state: new Map(),
    routeState: {},
    headers: {},
    body: null,
    route: {},
  };
}

describe("Faker generation workload reliability", () => {
  describe("Representative schema workloads", () => {
    it("preserves simple object shape across repeated generation", async () => {
      const schema = schemas.simple.object({
        id: schemas.simple.number(),
        name: schemas.simple.string(),
        active: { type: "boolean" },
      });

      for (let seed = 0; seed < 10; seed += 1) {
        const result = await generateFromSchema({ schema, seed });
        expectRecord(result);
        expect(result.id).toEqual(expect.any(Number));
        expect(result.name).toEqual(expect.any(String));
        expect(result.active).toEqual(expect.any(Boolean));
      }
    });

    it("preserves a three-level nested object shape", async () => {
      const schema = schemas.nested.deep(
        3,
        schemas.simple.object({
          id: schemas.simple.number(),
          value: schemas.simple.string(),
        }),
      );

      let level = await generateFromSchema({ schema, seed: 42 });
      for (let depth = 0; depth < 3; depth += 1) {
        expectRecord(level);
        level = level.nested;
      }
      expectRecord(level);
      expect(level.id).toEqual(expect.any(Number));
      expect(level.value).toEqual(expect.any(String));
    });

    it("generates every item in a fixed-size object array", async () => {
      const schema = schemas.simple.array(
        schemas.simple.object({
          id: schemas.simple.number(),
          name: schemas.simple.string(),
        }),
        { minItems: 50, maxItems: 50 },
      );

      const result = await generateFromSchema({ schema, seed: 42 });
      expect(Array.isArray(result)).toBe(true);
      if (!Array.isArray(result)) throw new Error("Expected generated array");
      expect(result).toHaveLength(50);
      for (const item of result) {
        expectRecord(item);
        expect(item.id).toEqual(expect.any(Number));
        expect(item.name).toEqual(expect.any(String));
      }
    });

    it("honors constraints in a complex collection schema", async () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          users: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                email: { type: "string", format: "email" },
                age: { type: "integer", minimum: 18, maximum: 100 },
                tags: {
                  type: "array",
                  items: { type: "string", pattern: "^[a-z]+$" },
                  maxItems: 5,
                },
              },
              required: ["id", "email"],
            },
            minItems: 10,
            maxItems: 10,
          },
        },
        required: ["users"],
      };

      const result = await generateFromSchema({ schema, seed: 42 });
      expectRecord(result);
      expect(Array.isArray(result.users)).toBe(true);
      if (!Array.isArray(result.users)) {
        throw new Error("Expected users collection");
      }
      expect(result.users).toHaveLength(10);
      for (const user of result.users) {
        expectRecord(user);
        expect(user.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
        expect(user.email).toEqual(expect.any(String));
        expect(user.age).toBeGreaterThanOrEqual(18);
        expect(user.age).toBeLessThanOrEqual(100);
        expect(Array.isArray(user.tags)).toBe(true);
        if (!Array.isArray(user.tags)) throw new Error("Expected user tags");
        expect(user.tags.length).toBeLessThanOrEqual(5);
        for (const tag of user.tags) expect(tag).toMatch(/^[a-z]+$/);
      }
    });

    it("handles both small and large fixed array workloads", async () => {
      const sizes = [50, 500];

      for (const size of sizes) {
        const schema = schemas.simple.array(schemas.simple.string(), {
          minItems: size,
          maxItems: size,
        });
        const result = await generateFromSchema({ schema, seed: 42 });
        expect(Array.isArray(result)).toBe(true);
        if (!Array.isArray(result)) throw new Error("Expected generated array");
        expect(result).toHaveLength(size);
        expect(result.every((item) => typeof item === "string")).toBe(true);
      }
    });

    it("handles both narrow and wide object workloads", async () => {
      for (const width of [20, 100]) {
        const result = await generateFromSchema({
          schema: schemas.nested.wide(width),
          seed: 42,
        });
        expectRecord(result);
        expect(Object.keys(result)).toHaveLength(width);
        expect(
          Object.values(result).every((value) => typeof value === "string"),
        ).toBe(true);
      }
    });
  });

  describe("Plugin workloads", () => {
    it("constructs a plugin with stable metadata", () => {
      const plugin = fakerPlugin({ schema: schemas.complex.user() });

      expect(plugin.name).toBe("faker");
      expect(plugin.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it("generates a complete response through repeated plugin processing", async () => {
      const plugin = fakerPlugin({
        schema: schemas.complex.apiResponse(),
        seed: 42,
      });
      const context = pluginContext();
      let firstResponse: unknown;

      for (let iteration = 0; iteration < 10; iteration += 1) {
        const result = await plugin.process(context);
        expect(result.context).toBe(context);
        expectRecord(result.response);
        expect(result.response.success).toEqual(expect.any(Boolean));
        expect(Array.isArray(result.response.data)).toBe(true);
        if (iteration === 0) firstResponse = result.response;
        else expect(result.response).toEqual(firstResponse);
      }
    });

    it("applies template overrides under a representative workload", async () => {
      const schema = schemas.simple.object({
        id: schemas.simple.string(),
        userId: schemas.simple.string(),
        timestamp: schemas.simple.string(),
        message: schemas.simple.string(),
      });
      const timestamp = "2026-07-12T12:00:00.000Z";

      const result = await generateFromSchema({
        schema,
        seed: 42,
        overrides: {
          id: "{{params.id}}",
          userId: "{{state.user.id}}",
          timestamp: "{{state.timestamp}}",
          message: "User {{params.id}} at {{state.timestamp}}",
        },
        params: { id: "123" },
        state: { user: { id: "user-456" }, timestamp },
      });

      expect(result).toEqual({
        id: "123",
        userId: "user-456",
        timestamp,
        message: `User 123 at ${timestamp}`,
      });
    });
  });

  describe("Concurrent and repeated workloads", () => {
    it("keeps twenty concurrent generations isolated and well formed", async () => {
      const schema = schemas.complex.user();
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, seed) =>
          generateFromSchema({ schema, seed }),
        ),
      );

      expect(results).toHaveLength(20);
      for (const result of results) expectGeneratedUser(result);
      expect(
        new Set(results.map((result) => JSON.stringify(result))).size,
      ).toBe(20);
    });

    it("preserves shape under a hundred sequential generations", async () => {
      const schema = schemas.simple.object({
        id: schemas.simple.number(),
        data: schemas.simple.string(),
      });
      const results: unknown[] = [];

      for (let seed = 0; seed < 100; seed += 1) {
        const result = await generateFromSchema({ schema, seed });
        expectRecord(result);
        expect(result.id).toEqual(expect.any(Number));
        expect(result.data).toEqual(expect.any(String));
        results.push(result);
      }
      expect(
        new Set(results.map((result) => JSON.stringify(result))).size,
      ).toBe(100);
    });

    it("preserves generated shape across a thousand calls", async () => {
      const schema = schemas.simple.object({
        id: schemas.simple.number(),
        name: schemas.simple.string(),
      });
      const serializedResults = new Set<string>();

      for (let seed = 0; seed < 1_000; seed += 1) {
        const result = await generateFromSchema({ schema, seed });
        expectRecord(result);
        expect(result.id).toEqual(expect.any(Number));
        expect(result.name).toEqual(expect.any(String));
        serializedResults.add(JSON.stringify(result));
      }

      expect(serializedResults.size).toBe(1_000);
    });

    it("generates a thousand-item data structure", async () => {
      const schema = schemas.simple.array(
        schemas.simple.object({
          id: schemas.simple.string(),
          data: schemas.simple.string(),
        }),
        { minItems: 1_000, maxItems: 1_000 },
      );

      const result = await generateFromSchema({ schema, seed: 42 });
      expect(Array.isArray(result)).toBe(true);
      if (!Array.isArray(result)) throw new Error("Expected generated array");
      expect(result).toHaveLength(1_000);
      for (const item of result) {
        expectRecord(item);
        expect(item.id).toEqual(expect.any(String));
        expect(item.data).toEqual(expect.any(String));
      }
    });

    it("recovers after repeated resource-limit failures", async () => {
      const oversizedSchema = schemas.simple.array(schemas.simple.string(), {
        minItems: 50_001,
        maxItems: 50_001,
      });

      for (let iteration = 0; iteration < 100; iteration += 1) {
        await expect(
          generateFromSchema({ schema: oversizedSchema }),
        ).rejects.toThrow("array_max_items");
      }

      const recovered = await generateFromSchema({
        schema: schemas.simple.object({ id: schemas.simple.number() }),
        seed: 42,
      });
      expectRecord(recovered);
      expect(recovered.id).toEqual(expect.any(Number));
    });
  });

  describe("Repeated mapping and edge-case workloads", () => {
    it("keeps smart field mapping valid across multiple seeds", async () => {
      const schema = schemas.simple.object({
        email: schemas.simple.string(),
        firstName: schemas.simple.string(),
        phone: schemas.simple.string(),
      });
      const results: Record<string, unknown>[] = [];

      for (let seed = 0; seed < 10; seed += 1) {
        const result = await generateFromSchema({ schema, seed });
        expectRecord(result);
        expect(result.email).toEqual(expect.any(String));
        expect(result.firstName).toEqual(expect.any(String));
        expect(result.phone).toEqual(expect.any(String));
        results.push(result);
      }

      expect(new Set(results.map((result) => result.email)).size).toBe(10);
      expect(new Set(results.map((result) => result.firstName)).size).toBe(10);
    });

    it("reuses one plugin without changing seeded output", async () => {
      const plugin = fakerPlugin({ schema: schemas.complex.user(), seed: 42 });
      const context = pluginContext();
      const responses: unknown[] = [];

      for (let iteration = 0; iteration < 15; iteration += 1) {
        const result = await plugin.process(context);
        expectGeneratedUser(result.response);
        responses.push(result.response);
      }

      expect(responses).toEqual(Array.from({ length: 15 }, () => responses[0]));
    });

    it("handles an empty object schema", async () => {
      await expect(
        generateFromSchema({ schema: schemas.simple.object({}), seed: 42 }),
      ).resolves.toEqual({});
    });

    it("selects only declared values from a large enum", async () => {
      const countries = Array.from(
        { length: 200 },
        (_, index) => `country-${index}`,
      );
      const schema = schemas.simple.object({
        country: { type: "string", enum: countries },
      });
      const result = await generateFromSchema({ schema, seed: 42 });

      expectRecord(result);
      expect(countries).toContain(result.country);
    });

    it("generates samples matching a complex pattern", async () => {
      const pattern = /^[A-Z]{2}-[0-9]{4}-[a-z]{2}-[0-9A-F]{8}$/;
      const schema = schemas.simple.object({
        code: { type: "string", pattern: pattern.source },
      });
      const results = await generate.samples(schema, 10, { seed: 42 });

      expect(results).toHaveLength(10);
      for (const result of results) {
        expectRecord(result);
        expect(result.code).toMatch(pattern);
      }
    });

    it("satisfies one branch of a mixed constraint schema", async () => {
      const schema: JSONSchema7 = {
        anyOf: [
          {
            type: "object",
            properties: {
              type: { const: "A" },
              data: { type: "string", minLength: 100 },
            },
            required: ["type", "data"],
          },
          {
            type: "array",
            items: { type: "number", minimum: 0, maximum: 1_000 },
            minItems: 50,
          },
          {
            type: "string",
            pattern: "^[A-Za-z0-9+/]{100,}={0,2}$",
          },
        ],
      };

      const result = await generateFromSchema({ schema, seed: 42 });
      const isValidObject =
        isRecord(result) &&
        result.type === "A" &&
        typeof result.data === "string" &&
        result.data.length >= 100;
      const isValidArray =
        Array.isArray(result) &&
        result.length >= 50 &&
        result.every(
          (value) => typeof value === "number" && value >= 0 && value <= 1_000,
        );
      const isValidString =
        typeof result === "string" &&
        /^[A-Za-z0-9+/]{100,}={0,2}$/.test(result);

      expect(isValidObject || isValidArray || isValidString).toBe(true);
    });
  });
});
