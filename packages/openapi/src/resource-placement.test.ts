import { resolve } from "node:path";
import { schmock } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { normalizeSchema, withoutExampleValues } from "./normalizer";
import { openapi } from "./plugin";

const DYNAMIC = { prefer: "dynamic=true" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(schema: object) {
  return { "application/json": { schema } };
}

/** The records of a list body: a flat array, or the array under `data`. */
function entries(body: unknown): Record<string, unknown>[] {
  const list = Array.isArray(body) ? body : isRecord(body) ? body.data : body;
  expect(Array.isArray(list)).toBe(true);
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

/**
 * A pets resource (list, create, read) whose Pet declares `id` and `name` as
 * given. `list` wraps the list body (`{ data: [Pet] }`) or not; `item` wraps
 * the read body (`{ data: Pet }`) or not.
 */
function petsSpec(options: {
  id: object;
  name?: object;
  version?: string;
  list?: "flat" | "envelope";
  item?: "bare" | "envelope";
}) {
  const pet = {
    type: "object",
    required: ["id", "name"],
    properties: { id: options.id, name: options.name ?? { type: "string" } },
  };
  const list =
    options.list === "envelope"
      ? {
          type: "object",
          properties: {
            data: { type: "array", minItems: 4, maxItems: 4, items: pet },
          },
        }
      : { type: "array", minItems: 4, maxItems: 4, items: pet };
  const item =
    options.item === "envelope"
      ? { type: "object", required: ["data"], properties: { data: pet } }
      : pet;
  return {
    openapi: options.version ?? "3.0.3",
    info: { title: "pets", version: "1.0.0" },
    paths: {
      "/pets": {
        get: {
          responses: { "200": { description: "list", content: json(list) } },
        },
        post: {
          requestBody: { content: json(pet) },
          responses: { "201": { description: "created", content: json(pet) } },
        },
      },
      "/pets/{petId}": {
        get: {
          parameters: [
            {
              name: "petId",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: { "200": { description: "one", content: json(item) } },
        },
      },
    },
  };
}

async function mockFor(
  spec: object,
  options: { fakerSeed?: number; validateResponses?: boolean } = {},
): Promise<Schmock.CallableMockInstance> {
  const mock = schmock({ state: {} });
  mock.pipe(await openapi({ spec, ...options }));
  return mock;
}

describe("a CRUD resource's id in generated bodies", () => {
  describe("generated lists", () => {
    it("gives Scalar Galaxy's planets distinct ids under Prefer: dynamic=true", async () => {
      // Planet.id declares `examples: [1]`, which pinned every id to 1.
      const mock = await mockFor(
        resolve(import.meta.dirname, "__fixtures__/scalar-galaxy.yaml"),
        { fakerSeed: 42 },
      );

      const response = await mock.handle("GET", "/planets", {
        headers: DYNAMIC,
      });

      expect(response.status).toBe(200);
      const planets = entries(response.body);
      const ids = planets.map((planet) => planet.id);
      expect(ids.length).toBeGreaterThan(1);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain(1);
      // Every other property still generates from its examples.
      for (const planet of planets) {
        expect(["Mars", "Jupiter", "HD 40307g"]).toContain(planet.name);
      }
      expect(isRecord(response.body) && response.body.meta).toMatchObject({
        limit: 10,
        offset: 0,
        total: 100,
      });
    });

    it.each([
      ["a 3.0 example", { type: "integer", example: 1 }, "3.0.3"],
      ["one 3.1 examples entry", { type: "integer", examples: [1] }, "3.1.0"],
      [
        "a pool of 3.1 examples",
        { type: "integer", examples: [1, 2] },
        "3.1.0",
      ],
    ])(
      "generates distinct list ids when the id declares %s",
      async (_, id, version) => {
        for (const list of ["flat", "envelope"] as const) {
          const mock = await mockFor(petsSpec({ id, version, list }), {
            fakerSeed: 7,
          });

          const response = await mock.handle("GET", "/pets", {
            headers: DYNAMIC,
          });

          const ids = entries(response.body).map((pet) => pet.id);
          expect(ids).toHaveLength(4);
          expect(new Set(ids).size).toBe(4);
        }
      },
    );

    it("leaves the id a value under Prefer: code=200 too", async () => {
      const mock = await mockFor(
        petsSpec({ id: { type: "integer", example: 1 } }),
        { fakerSeed: 7 },
      );

      const response = await mock.handle("GET", "/pets", {
        headers: { prefer: "code=200" },
      });

      const ids = entries(response.body).map((pet) => pet.id);
      expect(new Set(ids).size).toBe(4);
    });

    it("keeps a default the spec declares on the id", async () => {
      const mock = await mockFor(
        petsSpec({ id: { type: "integer", default: 5, example: 1 } }),
      );

      const response = await mock.handle("GET", "/pets", {
        headers: DYNAMIC,
      });

      expect(entries(response.body).map((pet) => pet.id)).toEqual([5, 5, 5, 5]);
    });

    it("still pins a property that is not the id to its single example", async () => {
      const mock = await mockFor(
        petsSpec({
          id: { type: "integer", example: 1 },
          name: { type: "string", example: "Rex" },
        }),
      );

      const response = await mock.handle("GET", "/pets", {
        headers: DYNAMIC,
      });

      expect(entries(response.body).map((pet) => pet.name)).toEqual([
        "Rex",
        "Rex",
        "Rex",
        "Rex",
      ]);
    });

    it("validates a dynamic list as it validated before", async () => {
      const mock = await mockFor(
        petsSpec({ id: { type: "integer", minimum: 1, example: 1 } }),
        { validateResponses: true },
      );

      const response = await mock.handle("GET", "/pets", {
        headers: DYNAMIC,
      });

      expect(response.status).toBe(200);
      for (const pet of entries(response.body)) {
        expect(pet.id).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe("generated items", () => {
    it("takes no id from the examples in an item envelope under Prefer: dynamic=true", async () => {
      const ids = new Set<unknown>();
      for (let fakerSeed = 0; fakerSeed < 4; fakerSeed++) {
        const mock = await mockFor(
          petsSpec({ id: { type: "integer", example: 1 }, item: "envelope" }),
          { fakerSeed },
        );
        const response = await mock.handle("GET", "/pets/9", {
          headers: DYNAMIC,
        });
        expect(response.status).toBe(200);
        const data = isRecord(response.body) ? response.body.data : undefined;
        ids.add(isRecord(data) ? data.id : undefined);
      }
      expect(ids.has(undefined)).toBe(false);
      expect(ids.size).toBeGreaterThan(1);
    });

    it("takes no id from the examples when a lookup-only read answers from its schema", async () => {
      const pet = {
        type: "object",
        properties: {
          id: { type: "integer", example: 1 },
          name: { type: "string", example: "Rex" },
        },
      };
      const spec = {
        openapi: "3.0.3",
        info: { title: "lookup", version: "1.0.0" },
        paths: {
          "/pets/{id}": {
            get: {
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  schema: { type: "integer" },
                },
              ],
              responses: { "200": { description: "one", content: json(pet) } },
            },
          },
        },
      };

      const bodies: unknown[] = [];
      for (let fakerSeed = 0; fakerSeed < 4; fakerSeed++) {
        const mock = await mockFor(spec, { fakerSeed });
        bodies.push((await mock.handle("GET", "/pets/3")).body);
      }

      const ids = new Set(bodies.map((body) => isRecord(body) && body.id));
      expect(ids.size).toBeGreaterThan(1);
      for (const body of bodies) expect(body).toMatchObject({ name: "Rex" });
    });

    it("takes no id from the examples when a lookup-only read declares only a default response", async () => {
      // findRepresentativeResponse answers a default-only operation as 200, so
      // the success-body filter applies to it like any declared 2xx.
      const pet = {
        type: "object",
        properties: {
          id: { type: "integer", example: 1 },
          name: { type: "string", example: "Rex" },
        },
      };
      const spec = {
        openapi: "3.0.3",
        info: { title: "lookup", version: "1.0.0" },
        paths: {
          "/pets/{id}": {
            get: {
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  schema: { type: "integer" },
                },
              ],
              responses: {
                default: { description: "one", content: json(pet) },
              },
            },
          },
        },
      };

      const bodies: unknown[] = [];
      for (let fakerSeed = 0; fakerSeed < 4; fakerSeed++) {
        const mock = await mockFor(spec, { fakerSeed });
        const response = await mock.handle("GET", "/pets/3");
        expect(response.status).toBe(200);
        bodies.push(response.body);
      }

      const ids = new Set(bodies.map((body) => isRecord(body) && body.id));
      expect(ids.size).toBeGreaterThan(1);
      for (const body of bodies) expect(body).toMatchObject({ name: "Rex" });
    });

    it("takes no id from the examples in the item a singleton list route declares", async () => {
      // GET and POST on one path, answering one shape: the GET is the item,
      // and its array is a field of it.
      const dispute = {
        type: "object",
        required: ["id", "object"],
        properties: {
          id: { type: "string", example: "dp_1" },
          object: { type: "string", example: "dispute" },
          balance_transactions: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" } },
            },
          },
        },
      };
      const spec = {
        openapi: "3.0.3",
        info: { title: "disputes", version: "1.0.0" },
        paths: {
          "/charges/{charge}/dispute": {
            get: {
              responses: {
                "200": { description: "d", content: json(dispute) },
              },
            },
            post: {
              responses: {
                "200": { description: "d", content: json(dispute) },
              },
            },
          },
        },
      };

      const mock = await mockFor(spec, { fakerSeed: 3 });
      const read = await mock.handle("GET", "/charges/ch_1/dispute");

      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ object: "dispute" });
      expect(isRecord(read.body) && typeof read.body.id).toBe("string");
      expect(isRecord(read.body) && read.body.id).not.toBe("dp_1");
    });

    it("leaves an id a hook pins on its own copy of the contract", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: petsSpec({ id: { type: "integer", example: 1 } }),
          onSchema: (schema) => {
            const items = isRecord(schema.items) ? schema.items : {};
            const properties = isRecord(items.properties)
              ? items.properties
              : {};
            return {
              ...schema,
              items: {
                ...items,
                properties: {
                  ...properties,
                  id: { type: "integer", default: 3 },
                },
              },
            };
          },
        }),
      );

      const response = await mock.handle("GET", "/pets", {
        headers: DYNAMIC,
      });

      expect(entries(response.body).map((pet) => pet.id)).toEqual([3, 3, 3, 3]);
    });

    it("keeps minting stored ids", async () => {
      const mock = await mockFor(
        petsSpec({ id: { type: "integer", examples: [7] }, version: "3.1.0" }),
      );

      await mock.handle("POST", "/pets", { body: { name: "Rex" } });
      await mock.handle("POST", "/pets", { body: { name: "Tom" } });

      const listed = await mock.handle("GET", "/pets");
      expect(entries(listed.body).map((pet) => pet.id)).toEqual([1, 2]);
    });
  });

  describe("withoutExampleValues", () => {
    function normalized(schema: object): Record<string, unknown> {
      const result: JSONSchema7 = normalizeSchema(
        { type: "object", properties: { id: schema } },
        "response",
      );
      const id = result.properties?.id;
      if (!isRecord(id)) throw new Error("no id property");
      return id;
    }

    it("drops the default a 3.0 example or one examples entry became", () => {
      for (const id of [
        normalized({ type: "integer", example: 1 }),
        normalized({ type: "integer", examples: [1] }),
      ]) {
        expect(id.default).toBe(1);
        const stripped = withoutExampleValues(id);
        expect(stripped).not.toHaveProperty("default");
        expect(stripped).not.toBe(id);
        // The normalized node is shared, and stays as it was.
        expect(id.default).toBe(1);
      }
    });

    it("drops the pool several examples became, and keeps the examples", () => {
      const id = normalized({ type: "integer", examples: [1, 2] });
      expect(id).toHaveProperty("faker");
      const stripped = withoutExampleValues(id);
      expect(stripped).not.toHaveProperty("faker");
      expect(stripped.examples).toEqual([1, 2]);
    });

    it("keeps what the spec declares itself", () => {
      for (const id of [
        normalized({ type: "integer", default: 5, example: 1 }),
        normalized({
          type: "string",
          faker: "lorem.word",
          examples: ["a", "b"],
        }),
        normalized({ type: "integer" }),
      ]) {
        expect(withoutExampleValues(id)).toBe(id);
      }
    });

    it("keeps a value written over the derived one since", () => {
      const id = normalized({ type: "integer", example: 1 });
      expect(withoutExampleValues({ ...id, default: 3 })).toHaveProperty(
        "default",
        3,
      );
      const replaced = { ...id };
      replaced.default = 3;
      expect(withoutExampleValues(replaced).default).toBe(3);
    });

    it("drops a derived value inside a nullable wrapper or an allOf branch", () => {
      const nullable = normalized({
        type: "integer",
        nullable: true,
        allOf: [{ minimum: 1 }],
        example: 4,
      });
      expect(nullable.schmockNullable).toBe(true);
      const unwrapped = withoutExampleValues(nullable);
      expect(JSON.stringify(unwrapped)).not.toContain('"default"');

      const branch = normalized({
        allOf: [{ type: "integer", example: 4 }],
      });
      expect(JSON.stringify(branch)).toContain('"default":4');
      expect(JSON.stringify(withoutExampleValues(branch))).not.toContain(
        '"default"',
      );
    });
  });
});
