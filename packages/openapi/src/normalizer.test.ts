import { resolve } from "node:path";
import type * as Schmock from "@schmock/core";
import { schmock } from "@schmock/core";
import { generateFromSchema } from "@schmock/faker";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { findArrayProperty } from "./list-envelope";
import { collectAccessModes, normalizeSchema } from "./normalizer";
import { openapi } from "./plugin";
import { hasType, isRecord } from "./utils";

function json(schema: object) {
  return { "application/json": { schema } };
}

function specWith(
  paths: object,
  schemas: object = {},
  version = "3.0.3",
): Record<string, unknown> {
  return {
    openapi: version,
    info: { title: "Normalizer", version: "1.0.0" },
    paths,
    components: { schemas },
  };
}

async function mockFor(
  spec: Record<string, unknown>,
  options: Omit<Schmock.OpenApiOptions, "spec"> = {},
): Promise<Schmock.CallableMockInstance> {
  const mock = schmock({ state: {} });
  mock.pipe(await openapi({ spec, ...options }));
  return mock;
}

/** Compile with the exact AJV the request pipeline uses (request-pipeline.ts). */
function accepts(schema: JSONSchema7, value: unknown): boolean {
  const ajv = new Ajv2020({
    allErrors: true,
    strictSchema: false,
    strictTypes: false,
  });
  return ajv.compile(schema)(value);
}

function acceptsNull(schema: JSONSchema7): boolean {
  return accepts(schema, null);
}

describe("normalizeSchema", () => {
  describe("nullable", () => {
    it("converts nullable: true to a null-permitting type union plus the marker", () => {
      const result = normalizeSchema(
        { type: "string", nullable: true },
        "response",
      );
      expect(result).toEqual({
        type: ["string", "null"],
        schmockNullable: true,
      });
    });

    it("removes nullable: false without adding marker", () => {
      const result = normalizeSchema(
        { type: "string", nullable: false },
        "response",
      );
      expect(result).toEqual({ type: "string" });
    });
  });

  describe("nullable emits validation-visible null", () => {
    it("appends null to a scalar type", () => {
      const result = normalizeSchema(
        { type: "string", nullable: true },
        "response",
      );
      expect(result).toEqual({
        type: ["string", "null"],
        schmockNullable: true,
      });
      expect(acceptsNull(result)).toBe(true);
    });

    it("appends null once to an existing type union", () => {
      const result = normalizeSchema(
        { type: ["string", "integer"], nullable: true },
        "response",
      );
      expect(result.type).toEqual(["string", "integer", "null"]);
      expect(acceptsNull(result)).toBe(true);
    });

    it("widens an enum so the union actually accepts null", () => {
      const result = normalizeSchema(
        { type: "string", enum: ["a", "b"], nullable: true },
        "response",
      );
      expect(result.type).toEqual(["string", "null"]);
      expect(result.enum).toEqual(["a", "b", null]);
      expect(acceptsNull(result)).toBe(true);
    });

    it("wraps a composition-only nullable in anyOf with a null branch", () => {
      const result = normalizeSchema(
        { nullable: true, allOf: [{ type: "object" }] },
        "response",
      );
      expect(result).toEqual({
        anyOf: [{ type: "null" }, { allOf: [{ type: "object" }] }],
        schmockNullable: true,
      });
      expect(acceptsNull(result)).toBe(true);
    });

    it("wraps a typed nullable that also composes, so the branches cannot reject null", () => {
      const owner = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      for (const keyword of ["allOf", "anyOf", "oneOf"]) {
        const result = normalizeSchema(
          { type: "object", nullable: true, [keyword]: [owner] },
          "request",
        );
        expect(result).toEqual({
          anyOf: [{ type: "null" }, { type: "object", [keyword]: [owner] }],
          schmockNullable: true,
        });
        expect(acceptsNull(result)).toBe(true);
        expect(accepts(result, { name: "Ada" })).toBe(true);
        expect(accepts(result, "Ada")).toBe(false);
      }
    });

    it("lets a nullable typed allOf property accept null through the plugin", async () => {
      const mock = await mockFor(
        specWith(
          {
            "/pets": {
              post: {
                requestBody: {
                  required: true,
                  content: json({
                    type: "object",
                    required: ["owner"],
                    properties: {
                      owner: {
                        type: "object",
                        nullable: true,
                        allOf: [{ $ref: "#/components/schemas/Owner" }],
                      },
                    },
                  }),
                },
                responses: { "204": { description: "ok" } },
              },
            },
          },
          {
            Owner: { type: "object", properties: { name: { type: "string" } } },
          },
        ),
        { validateRequests: true },
      );

      const response = await mock.handle("POST", "/pets", {
        body: { owner: null },
      });
      expect(response.status).toBe(204);
    });

    it.each([
      ["a typed", { type: "object" }],
      ["an untyped", {}],
    ])(
      "rolls %s nullable allOf property to null about as often as any nullable value",
      async (_, typing) => {
        const owner = {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        };
        const pet = normalizeSchema(
          {
            type: "object",
            required: ["owner"],
            properties: {
              owner: { ...typing, nullable: true, allOf: [owner] },
            },
          },
          "response",
        );

        let nulls = 0;
        const runs = 300;
        for (let seed = 0; seed < runs; seed++) {
          const body = await generateFromSchema({ schema: pet, seed });
          if (isRecord(body) && body.owner === null) nulls++;
        }
        // NULLABLE_NULL_PROBABILITY is 5%: 15 of 300 on average.
        expect(nulls).toBeGreaterThan(runs * 0.01);
        expect(nulls).toBeLessThan(runs * 0.12);
      },
    );

    it("leaves a typeless composition-free schema alone but marks it", () => {
      const result = normalizeSchema({ nullable: true }, "response");
      expect(result).toEqual({ schmockNullable: true });
      expect(acceptsNull(result)).toBe(true);
    });

    it("keeps list detection working for a nullable array schema", () => {
      const result = normalizeSchema(
        { type: "array", items: { type: "string" }, nullable: true },
        "response",
      );
      expect(hasType(result, "array")).toBe(true);
      expect(acceptsNull(result)).toBe(true);

      const wrapped = normalizeSchema(
        {
          type: "object",
          properties: {
            data: { type: "array", items: { type: "string" }, nullable: true },
          },
        },
        "response",
      );
      expect(findArrayProperty(wrapped)).toEqual({
        property: "data",
        itemSchema: { type: "string" },
      });
    });

    it("keeps list detection working for a composition-only nullable schema", () => {
      const result = normalizeSchema(
        {
          nullable: true,
          allOf: [
            {
              type: "object",
              properties: {
                data: { type: "array", items: { type: "string" } },
              },
            },
          ],
        },
        "response",
      );

      expect(acceptsNull(result)).toBe(true);
      expect(findArrayProperty(result)).toEqual({
        property: "data",
        itemSchema: { type: "string" },
      });
    });
  });

  describe("shared subschemas", () => {
    it("normalizes a reused subschema in every slot instead of blanking it", () => {
      const shared = { type: "string", example: "hi" };
      const result = normalizeSchema(
        { type: "object", properties: { first: shared, second: shared } },
        "response",
      );

      const props = result.properties as Record<string, unknown>;
      expect(props.first).toEqual({ type: "string", default: "hi" });
      expect(props.second).toEqual({ type: "string", default: "hi" });
    });

    it("prunes required and writeOnly keys in both copies of a $ref that carries siblings", () => {
      // The dereferenced shape of `{ $ref: User, description }` beside a plain
      // `$ref: User`: a fresh object that shares User's `properties` and
      // `required` by reference.
      const user: Record<string, unknown> = {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "integer", readOnly: true },
          name: { type: "string" },
          password: { type: "string", writeOnly: true },
        },
      };
      const described = {
        description: "The reviewer",
        type: user.type,
        required: user.required,
        properties: user.properties,
      };

      for (const [first, second] of [
        [user, described],
        [described, user],
      ]) {
        const schema = {
          type: "object",
          properties: { first, second },
        };
        const request = normalizeSchema(schema, "request").properties as Record<
          string,
          JSONSchema7
        >;
        const response = normalizeSchema(schema, "response")
          .properties as Record<string, JSONSchema7>;

        for (const name of ["first", "second"]) {
          expect(request[name].required).toEqual(["name"]);
          expect(request[name].properties).not.toHaveProperty("id");
          expect(request[name].properties).toHaveProperty("password");
          expect(response[name].required).toEqual(["id", "name"]);
          expect(response[name].properties).toHaveProperty("id");
          expect(response[name].properties).not.toHaveProperty("password");
        }
      }
      expect(user.required).toEqual(["id", "name"]);
      expect(Object.keys(user.properties as object)).toEqual([
        "id",
        "name",
        "password",
      ]);
    });

    it("records readOnly for every property that references one flagged component", () => {
      const timestamp = { type: "string", format: "date-time", readOnly: true };
      const customer = {
        type: "object",
        properties: { createdAt: timestamp },
      };
      const result = normalizeSchema(
        {
          type: "object",
          properties: {
            customer,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
        "response",
      );

      expect([...collectAccessModes(result).readOnly].sort()).toEqual([
        "createdAt",
        "updatedAt",
      ]);
      const customerOut = (result.properties as Record<string, JSONSchema7>)
        .customer;
      expect([...collectAccessModes(customerOut).readOnly]).toEqual([
        "createdAt",
      ]);
      // The flag is recorded, then dropped from the generated schema.
      const updatedAt = (result.properties as Record<string, JSONSchema7>)
        .updatedAt;
      expect(updatedAt).not.toHaveProperty("readOnly");
    });

    it("pins discriminator branches without changing the shared component", () => {
      const cat = {
        type: "object",
        properties: { petType: { type: "string" }, meow: { type: "boolean" } },
      };
      const result = normalizeSchema(
        {
          type: "object",
          properties: {
            pet: {
              discriminator: {
                propertyName: "petType",
                "x-schmock-discriminator-values": [["cat"]],
              },
              oneOf: [cat],
            },
            plainCat: cat,
          },
        },
        "response",
      );

      const props = result.properties as Record<string, JSONSchema7>;
      const branch = (props.pet.oneOf as JSONSchema7[])[0];
      expect(branch.required).toEqual(["petType"]);
      expect(branch.properties?.petType).toEqual({
        type: "string",
        enum: ["cat"],
      });
      expect(props.plainCat).not.toHaveProperty("required");
      expect(props.plainCat.properties?.petType).toEqual({ type: "string" });
    });

    it("ends a self-cycle by leaving out the optional property that closes it", () => {
      const a: Record<string, unknown> = { type: "object", properties: {} };
      (a.properties as Record<string, unknown>).self = a;
      (a.properties as Record<string, unknown>).parent = { allOf: [a] };

      const result = normalizeSchema(a, "response");
      expect(result.properties).toEqual({});
    });
  });

  describe("recursive schemas", () => {
    /** Accepts anything, as an unconstrained schema does, but is not empty. */
    function expectOpenCut(schema: unknown): void {
      expect(schema).toBeTypeOf("object");
      expect(Object.keys(schema as object).length).toBeGreaterThan(0);
      const cut = schema as JSONSchema7;
      for (const value of [null, 1, "x", { deep: [1] }, [{ id: 1 }]]) {
        expect(accepts(cut, value)).toBe(true);
      }
    }

    function treeNode(): Record<string, unknown> {
      const node: Record<string, unknown> = {
        type: "object",
        required: ["id"],
        properties: { id: { type: "integer" } },
      };
      (node.properties as Record<string, unknown>).children = {
        type: "array",
        items: node,
      };
      return node;
    }

    it("defaults a recursive array to empty and keeps its items open", () => {
      const result = normalizeSchema(treeNode(), "response");
      const children = (result.properties as Record<string, JSONSchema7>)
        .children;

      expect(children.type).toBe("array");
      expect(children.default).toEqual([]);
      expectOpenCut(children.items);
      expect(
        accepts(result, {
          id: 1,
          children: [{ id: 2, children: [{ id: 3 }] }],
        }),
      ).toBe(true);
    });

    it("leaves a minItems recursive array without an empty default", () => {
      const node = treeNode();
      const props = node.properties as Record<string, Record<string, unknown>>;
      props.children.minItems = 1;

      const result = normalizeSchema(node, "response");
      const children = (result.properties as Record<string, JSONSchema7>)
        .children;
      expect(children).not.toHaveProperty("default");
      expectOpenCut(children.items);
    });

    it("cuts a required recursive property to an open schema", () => {
      const person: Record<string, unknown> = {
        type: "object",
        required: ["name", "manager"],
        properties: { name: { type: "string" } },
      };
      (person.properties as Record<string, unknown>).manager = person;

      const result = normalizeSchema(person, "request");
      expectOpenCut((result.properties as Record<string, unknown>).manager);
    });

    it("keeps an optional recursive property when the object is closed", () => {
      const person: Record<string, unknown> = {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" } },
      };
      (person.properties as Record<string, unknown>).manager = person;

      const result = normalizeSchema(person, "response");
      expectOpenCut((result.properties as Record<string, unknown>).manager);
      expect(accepts(result, { name: "a", manager: { name: "b" } })).toBe(true);
    });

    /**
     * The OAS 3.1 way to close a composition: `unevaluatedProperties: false`
     * on the composer, every name declared by an open `allOf` branch.
     */
    function closedComposition(): {
      node: Record<string, unknown>;
      branch: Record<string, unknown>;
    } {
      const branch: Record<string, unknown> = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      const node = { unevaluatedProperties: false, allOf: [branch] };
      (branch.properties as Record<string, unknown>).next = node;
      return { node, branch };
    }

    it("declares an optional recursive property a closed composer evaluates", () => {
      const { node } = closedComposition();

      for (const direction of ["request", "response"] as const) {
        const result = normalizeSchema(node, direction);
        const [branch] = result.allOf as JSONSchema7[];
        expectOpenCut((branch.properties as Record<string, unknown>).next);
        expect(
          accepts(result, { name: "a", next: { name: "b", next: {} } }),
        ).toBe(true);
        expect(accepts(result, { name: "a", bogus: 1 })).toBe(false);
      }
    });

    it("keeps a composer whose branch closes the cycle open to nested data", () => {
      // Entered at the branch, the cycle closes on the composer's own allOf.
      const { branch } = closedComposition();

      const result = normalizeSchema(branch, "request");
      const deep = { name: "a", next: { name: "b", next: { name: "c" } } };
      expect(accepts(result, deep)).toBe(true);
      expect(
        (result.properties as Record<string, JSONSchema7>).next.default,
      ).toBeNull();
    });

    it.each(["anyOf", "oneOf"])(
      "keeps a closed %s composer open to nested data through its branch",
      (keyword) => {
        const branch: Record<string, unknown> = {
          type: "object",
          properties: { name: { type: "string" } },
        };
        const other = {
          type: "object",
          required: ["other"],
          properties: { other: { type: "integer" } },
        };
        const node = {
          unevaluatedProperties: false,
          [keyword]: [branch, other],
        };
        (branch.properties as Record<string, unknown>).next = node;

        const result = normalizeSchema(branch, "request");
        expect(accepts(result, { name: "a", next: { name: "b" } })).toBe(true);
        expect(accepts(normalizeSchema(node, "request"), { bogus: 1 })).toBe(
          false,
        );
      },
    );

    it("lets a nullable composition idiom end in null", () => {
      const category: Record<string, unknown> = {
        type: "object",
        required: ["id", "parent"],
        properties: { id: { type: "integer" } },
      };
      (category.properties as Record<string, unknown>).parent = {
        allOf: [category],
        nullable: true,
      };

      const result = normalizeSchema(category, "response");
      const parent = (result.properties as Record<string, JSONSchema7>).parent;
      // json-schema-faker merges `allOf` without `default`, so the branch
      // that closed the cycle is gone and the wrapper itself ends in null.
      expect(parent).not.toHaveProperty("allOf");
      expect(parent.default).toBeNull();
      expectOpenCut(parent);
    });
  });

  describe("recursive schemas through the plugin", () => {
    const recursiveSchemas = {
      TreeNode: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "integer" },
          children: {
            type: "array",
            items: { $ref: "#/components/schemas/TreeNode" },
          },
        },
      },
      Person: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          manager: { $ref: "#/components/schemas/Person" },
        },
      },
      Category: {
        type: "object",
        required: ["id", "parent"],
        properties: {
          id: { type: "integer" },
          parent: {
            allOf: [{ $ref: "#/components/schemas/Category" }],
            nullable: true,
          },
        },
      },
      Comment: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string" },
          replies: {
            type: "array",
            items: { $ref: "#/components/schemas/Comment" },
          },
        },
      },
    };
    const get = (schema: object) => ({
      get: {
        responses: { "200": { description: "ok", content: json(schema) } },
      },
    });

    it("generates every self-referential shape instead of answering 500", async () => {
      const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
      const mock = await mockFor(
        specWith(
          {
            "/tree": get(ref("TreeNode")),
            "/person": get(ref("Person")),
            "/category": get(ref("Category")),
            "/comments": get({ type: "array", items: ref("Comment") }),
          },
          recursiveSchemas,
        ),
        { validateResponses: true, fakerSeed: 11 },
      );

      const tree = await mock.handle("GET", "/tree");
      expect(tree.status).toBe(200);
      expect(tree.body).toMatchObject({ children: [] });

      const person = await mock.handle("GET", "/person");
      expect(person.status).toBe(200);
      expect(person.body).not.toHaveProperty("manager");

      const category = await mock.handle("GET", "/category");
      expect(category.status).toBe(200);
      expect(category.body).toMatchObject({ parent: null });

      const comments = await mock.handle("GET", "/comments");
      expect(comments.status).toBe(200);
      for (const comment of comments.body as Array<Record<string, unknown>>) {
        expect(comment.replies).toEqual([]);
      }
    });

    it("still validates a deep request tree against the recursive schema", async () => {
      const mock = await mockFor(
        specWith(
          {
            "/tree": {
              post: {
                requestBody: {
                  required: true,
                  content: json({ $ref: "#/components/schemas/TreeNode" }),
                },
                responses: { "201": { description: "ok" } },
              },
            },
          },
          recursiveSchemas,
        ),
        { validateRequests: true },
      );

      const deep = {
        id: 1,
        children: [{ id: 2, children: [{ id: 3, children: [{ id: 4 }] }] }],
      };
      expect((await mock.handle("POST", "/tree", { body: deep })).status).toBe(
        201,
      );
      const invalid = { id: "one", children: [] };
      expect(
        (await mock.handle("POST", "/tree", { body: invalid })).status,
      ).toBe(400);
    });

    it("accepts a nested request under a 3.1 composer closed by unevaluatedProperties", async () => {
      const mock = await mockFor(
        specWith(
          {
            "/nodes": {
              post: {
                requestBody: {
                  required: true,
                  content: json({ $ref: "#/components/schemas/Node" }),
                },
                responses: { "204": { description: "ok" } },
              },
            },
          },
          {
            Node: {
              unevaluatedProperties: false,
              allOf: [
                {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    next: { $ref: "#/components/schemas/Node" },
                  },
                },
              ],
            },
          },
          "3.1.0",
        ),
        { validateRequests: true },
      );

      const nested = { name: "a", next: { name: "b", next: { name: "c" } } };
      expect(
        (await mock.handle("POST", "/nodes", { body: nested })).status,
      ).toBe(204);
      const bogus = { name: "a", bogus: 1 };
      expect(
        (await mock.handle("POST", "/nodes", { body: bogus })).status,
      ).toBe(400);
    });

    it("seeds and generates the Scalar Galaxy planets despite their recursion", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: resolve(__dirname, "__fixtures__/scalar-galaxy.yaml"),
          seed: { planets: { count: 2 } },
          fakerSeed: 5,
        }),
      );

      const list = await mock.handle("GET", "/planets");
      expect(list.status).toBe(200);
      const data = (list.body as { data: Array<Record<string, unknown>> }).data;
      expect(data).toHaveLength(2);

      const dynamic = await mock.handle("GET", `/planets/${data[0].id}`, {
        headers: { prefer: "dynamic=true" },
      });
      expect(dynamic.status).toBe(200);
      expect(dynamic.body).toHaveProperty("name");
    });
  });

  describe("readOnly / writeOnly", () => {
    it("strips readOnly fields from request schemas", () => {
      const result = normalizeSchema(
        {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "integer", readOnly: true },
            name: { type: "string" },
          },
        },
        "request",
      );
      expect(result.properties).not.toHaveProperty("id");
      expect(result.properties).toHaveProperty("name");
      expect(result.required).toEqual(["name"]);
    });

    it("keeps readOnly fields in response schemas", () => {
      const result = normalizeSchema(
        {
          type: "object",
          properties: {
            id: { type: "integer", readOnly: true },
            name: { type: "string" },
          },
        },
        "response",
      );
      expect(result.properties).toHaveProperty("id");
      expect(result.properties).toHaveProperty("name");
    });

    it("strips writeOnly fields from response schemas", () => {
      const result = normalizeSchema(
        {
          type: "object",
          properties: {
            password: { type: "string", writeOnly: true },
            name: { type: "string" },
          },
        },
        "response",
      );
      expect(result.properties).not.toHaveProperty("password");
      expect(result.properties).toHaveProperty("name");
    });

    it("drops a readOnly name from the required list of another allOf branch in requests", () => {
      const result = normalizeSchema(
        {
          allOf: [
            {
              type: "object",
              properties: {
                id: { type: "integer", readOnly: true },
                name: { type: "string" },
                password: { type: "string", writeOnly: true },
              },
              required: ["name"],
            },
            { required: ["id", "name"] },
          ],
          required: ["id"],
        },
        "request",
      );

      const branches = result.allOf as JSONSchema7[];
      expect(branches[1].required).toEqual(["name"]);
      expect(result).not.toHaveProperty("required");
      expect([...collectAccessModes(result).readOnly]).toEqual(["id"]);
      expect([...collectAccessModes(result).writeOnly]).toEqual(["password"]);
    });

    it("drops a writeOnly name from the required list of another allOf branch in responses", () => {
      const credentials = {
        type: "object",
        properties: { password: { type: "string", writeOnly: true } },
      };
      const result = normalizeSchema(
        {
          allOf: [
            {
              allOf: [credentials],
              properties: { name: { type: "string" } },
            },
            { required: ["name", "password"] },
          ],
        },
        "response",
      );

      const branches = result.allOf as JSONSchema7[];
      expect(branches[1].required).toEqual(["name"]);
      expect([...collectAccessModes(result).writeOnly]).toEqual(["password"]);
    });

    it("keeps a readOnly name required in responses and a writeOnly one in requests", () => {
      const schema = {
        allOf: [
          {
            type: "object",
            properties: {
              id: { type: "integer", readOnly: true },
              password: { type: "string", writeOnly: true },
            },
          },
          { required: ["id", "password"] },
        ],
      };

      const response = normalizeSchema(schema, "response");
      expect((response.allOf as JSONSchema7[])[1].required).toEqual(["id"]);
      const request = normalizeSchema(schema, "request");
      expect((request.allOf as JSONSchema7[])[1].required).toEqual([
        "password",
      ]);
    });

    it("keeps writeOnly fields in request schemas", () => {
      const result = normalizeSchema(
        {
          type: "object",
          properties: {
            password: { type: "string", writeOnly: true },
            name: { type: "string" },
          },
        },
        "request",
      );
      expect(result.properties).toHaveProperty("password");
    });
  });

  describe("examples → generated values", () => {
    // The Train Travel spec's trip uuid has seven hex digits in its first
    // group; its station uuids are well formed.
    const malformed = "4f4e4e1-c824-4d63-b37a-d8d698862f1d";
    const stationA = "efdbb9d1-02c2-4bc3-afb7-6788d8782b1e";
    const stationB = "b2e783e1-c824-4d63-b37a-d8d698862f1d";
    const UUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const pool = (entries: unknown[]) => ({
      "helpers.arrayElement": [entries],
    });

    function valueSpec(schema: object, version = "3.1.0") {
      return specWith(
        {
          "/value": {
            get: {
              responses: {
                "200": { description: "ok", content: json(schema) },
              },
            },
          },
        },
        {},
        version,
      );
    }

    /** One GET /value body per faker seed 0..seeds-1. */
    async function readSeeded(
      schema: object,
      seeds: number,
      version?: string,
    ): Promise<unknown[]> {
      const values: unknown[] = [];
      for (let fakerSeed = 0; fakerSeed < seeds; fakerSeed++) {
        const mock = await mockFor(valueSpec(schema, version), { fakerSeed });
        values.push((await mock.handle("GET", "/value")).body);
      }
      return values;
    }

    function listData(body: unknown): Record<string, unknown>[] {
      const data = isRecord(body) ? body.data : undefined;
      expect(Array.isArray(data)).toBe(true);
      return Array.isArray(data) ? data.filter(isRecord) : [];
    }

    it("copies example to default when default is not set", () => {
      const result = normalizeSchema(
        { type: "string", example: "hello" },
        "response",
      );
      expect(result.default).toBe("hello");
      expect(result).not.toHaveProperty("example");
    });

    it("preserves existing default when example is present", () => {
      const result = normalizeSchema(
        { type: "string", example: "hello", default: "world" },
        "response",
      );
      expect(result.default).toBe("world");
    });

    it("draws from several 3.1 examples entries instead of pinning one", () => {
      const result = normalizeSchema(
        { type: "string", examples: ["active", "idle"] },
        "response",
      );
      expect(result).not.toHaveProperty("default");
      expect(result).toHaveProperty("faker", pool(["active", "idle"]));
      expect(result.examples).toEqual(["active", "idle"]);
    });

    it("pins a single accepted examples entry as a default, like a 3.0 example", () => {
      for (const examples of [["active"], ["active", "active"]]) {
        const result = normalizeSchema(
          { type: "string", examples },
          "response",
        );
        expect(result.default).toBe("active");
        expect(result).not.toHaveProperty("faker");
      }
      expect(
        normalizeSchema(
          { type: ["string", "null"], examples: ["active"] },
          "response",
        ).default,
      ).toBe("active");
    });

    it.each([
      [
        "format",
        { type: "string", format: "uuid", examples: [malformed, stationA] },
        stationA,
      ],
      ["type", { type: "integer", examples: ["7", 7.5, 7] }, 7],
      [
        "pattern",
        { type: "string", pattern: "^[A-Z]{2}$", examples: ["de", "DE"] },
        "DE",
      ],
      ["enum", { type: "string", enum: ["a", "b"], examples: ["c", "b"] }, "b"],
      ["const", { const: "on", examples: ["off", "on"] }, "on"],
      [
        "length",
        {
          type: "string",
          minLength: 2,
          maxLength: 3,
          examples: ["a", "abcd", "ab"],
        },
        "ab",
      ],
      [
        "inclusive bounds",
        { type: "integer", minimum: 1, maximum: 10, examples: [0, 11, 5] },
        5,
      ],
      [
        "3.0 boolean exclusive bound",
        {
          type: "number",
          minimum: 0,
          exclusiveMinimum: true,
          examples: [0, 2.5],
        },
        2.5,
      ],
      [
        "3.1 numeric exclusive bound",
        { type: "number", exclusiveMaximum: 100, examples: [100, 95.3] },
        95.3,
      ],
      ["multipleOf", { type: "integer", multipleOf: 5, examples: [7, 10] }, 10],
    ])(
      "keeps only the examples entries the node's %s accepts",
      (_, schema, kept) => {
        const result = normalizeSchema(schema, "response");
        expect(result.default).toBe(kept);
        expect(result).not.toHaveProperty("faker");
      },
    );

    it("generates as before when the node accepts no examples entry", () => {
      const result = normalizeSchema(
        { type: "string", format: "uuid", examples: [malformed] },
        "response",
      );
      expect(result).not.toHaveProperty("default");
      expect(result).not.toHaveProperty("faker");
    });

    it("does not promote a 3.0 example its own node rejects", () => {
      for (const schema of [
        { type: "string", format: "uuid", example: malformed },
        { type: "integer", minimum: 1, example: 0 },
        { type: "integer", example: "7" },
        { type: "string", enum: ["a", "b"], example: "c" },
        { type: "string", maxLength: 2, example: "abc" },
        { type: "string", pattern: "^[0-9]+$", example: "abc" },
      ]) {
        const result = normalizeSchema(schema, "response");
        expect(result).not.toHaveProperty("default");
        expect(result).not.toHaveProperty("example");
      }
      expect(
        normalizeSchema(
          { type: "string", format: "uuid", example: stationA },
          "response",
        ).default,
      ).toBe(stationA);
    });

    it("promotes a null example only onto a node that accepts null", () => {
      expect(
        normalizeSchema(
          { type: "string", nullable: true, example: null },
          "response",
        ),
      ).toHaveProperty("default", null);
      expect(
        normalizeSchema(
          { type: ["string", "null"], example: null },
          "response",
        ),
      ).toHaveProperty("default", null);
      expect(
        normalizeSchema({ type: "string", example: null }, "response"),
      ).not.toHaveProperty("default");
    });

    it("leaves null out of an examples pool", () => {
      expect(
        normalizeSchema(
          { type: ["string", "null"], examples: [null, "a", "b"] },
          "response",
        ),
      ).toHaveProperty("faker", pool(["a", "b"]));
      expect(
        normalizeSchema(
          { type: "string", nullable: true, examples: [null, "a"] },
          "response",
        ).default,
      ).toBe("a");
    });

    it("lets a default pin the value whatever the examples say", () => {
      const result = normalizeSchema(
        {
          type: "string",
          default: "set",
          example: "one",
          examples: ["a", "b"],
        },
        "response",
      );
      expect(result.default).toBe("set");
      expect(result).not.toHaveProperty("faker");
    });

    it("ignores the examples array beside a 3.0 example, even one the node rejects", () => {
      const accepted = normalizeSchema(
        { type: "string", example: "one", examples: ["x", "y"] },
        "response",
      );
      expect(accepted.default).toBe("one");
      expect(accepted).not.toHaveProperty("faker");

      const rejected = normalizeSchema(
        {
          type: "string",
          format: "uuid",
          example: malformed,
          examples: [stationA, stationB],
        },
        "response",
      );
      expect(rejected).not.toHaveProperty("default");
      expect(rejected).not.toHaveProperty("faker");
    });

    it("never takes a value from examples on a composite node or from a composite entry", () => {
      for (const schema of [
        { type: "array", items: { type: "string" }, examples: [["a"], ["b"]] },
        { type: "object", examples: ["a", "b"] },
        { properties: { a: { type: "string" } }, examples: ["a", "b"] },
        { type: "string", examples: [{ a: 1 }, ["b"]] },
      ]) {
        const result = normalizeSchema(schema, "response");
        expect(result).not.toHaveProperty("default");
        expect(result).not.toHaveProperty("faker");
      }
      expect(
        normalizeSchema(
          { type: "string", examples: [{ a: 1 }, "x"] },
          "response",
        ).default,
      ).toBe("x");
    });

    // Each case: a node that composes, an entry a branch rejects, and an entry
    // the whole node accepts.
    it.each([
      [
        "allOf",
        { type: "string", allOf: [{ format: "uuid" }] },
        malformed,
        stationA,
      ],
      [
        "anyOf",
        { anyOf: [{ type: "string", format: "uuid" }, { type: "integer" }] },
        "zzz",
        7,
      ],
      [
        "oneOf",
        { type: "string", oneOf: [{ format: "uuid" }, { format: "email" }] },
        "nope",
        "x@y.co",
      ],
      ["not", { type: "string", not: { const: "x" } }, "x", "y"],
      [
        "if/then",
        {
          type: "string",
          if: { minLength: 2 },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
          then: { pattern: "^[A-Z]+$" },
        },
        "ab",
        "CD",
      ],
    ])(
      "checks an example against every branch of a node that composes with %s",
      (_, schema, rejected, accepted) => {
        // One accepted entry pins the value, as on any scalar node.
        const pinned = normalizeSchema(
          { ...schema, examples: [rejected, accepted] },
          "response",
        );
        expect(pinned.default).toBe(accepted);
        expect(pinned).not.toHaveProperty("faker");

        const none = normalizeSchema(
          { ...schema, examples: [rejected] },
          "response",
        );
        expect(none).not.toHaveProperty("default");
        expect(none).not.toHaveProperty("faker");

        // A 3.0 example is promoted only when the whole node accepts it.
        expect(
          normalizeSchema({ ...schema, example: accepted }, "response").default,
        ).toBe(accepted);
        const refused = normalizeSchema(
          { ...schema, example: rejected },
          "response",
        );
        expect(refused).not.toHaveProperty("default");
        expect(refused).not.toHaveProperty("example");
      },
    );

    it("draws from no pool on a node that composes, however many entries it accepts", () => {
      // json-schema-faker evaluates `faker` before the composition, and
      // @schmock/faker refuses a faker draw beside `not`.
      for (const schema of [
        { type: "string", not: { const: "x" }, examples: ["y", "z"] },
        {
          type: "string",
          allOf: [{ format: "uuid" }],
          examples: [stationA, stationB],
        },
      ]) {
        const result = normalizeSchema(schema, "response");
        expect(result).not.toHaveProperty("default");
        expect(result).not.toHaveProperty("faker");
      }
    });

    it("checks a composed node against its normalized branches", () => {
      // The 3.0 boolean exclusiveMinimum inside the branch is numeric by the
      // time the node is checked, so 0 is refused and 1 accepted.
      const result = normalizeSchema(
        {
          type: "integer",
          allOf: [{ minimum: 0, exclusiveMinimum: true }],
          examples: [0, 1],
        },
        "response",
      );
      expect(result.default).toBe(1);
      // A typeless allOf is read as an object and takes no example, as before.
      expect(
        normalizeSchema(
          { allOf: [{ type: "string" }], example: "x" },
          "response",
        ),
      ).not.toHaveProperty("default");
    });

    it("does not draw from a pool json-schema-faker would alter", () => {
      // A drawn value is cast to a type picked at random from a union, and
      // snapped onto a fractional multipleOf.
      for (const schema of [
        { type: ["string", "integer"], examples: ["a", 1] },
        { type: "number", multipleOf: 0.01, examples: [19.99, 5.49] },
      ]) {
        const result = normalizeSchema(schema, "response");
        expect(result).not.toHaveProperty("default");
        expect(result).not.toHaveProperty("faker");
      }
      // A faker keyword the spec declares is its own choice.
      expect(
        normalizeSchema(
          { type: "string", faker: "lorem.word", examples: ["a", "b"] },
          "response",
        ),
      ).toHaveProperty("faker", "lorem.word");
    });

    it("lets a node its own keywords cannot check keep its examples", () => {
      // Neither regular-expression grammar compiles "(", so the node cannot
      // tell, and the example is promoted as it always was.
      expect(
        normalizeSchema(
          { type: "string", pattern: "(", example: "x" },
          "response",
        ).default,
      ).toBe("x");
      // An unknown format constrains nothing, as in the request pipeline.
      expect(
        normalizeSchema(
          {
            type: "string",
            format: "iso-country-code",
            examples: ["DE", "FR"],
          },
          "response",
        ),
      ).toHaveProperty("faker", pool(["DE", "FR"]));
    });

    it("leaves what validation accepts unchanged", () => {
      const result = normalizeSchema(
        { type: "string", examples: ["active", "idle"] },
        "response",
      );
      expect(result).not.toHaveProperty("enum");
      expect(result).not.toHaveProperty("const");
      expect(accepts(result, "archived")).toBe(true);
      // @schmock/validation compiles draft-07 with Schmock's generation
      // keywords registered as vocabulary.
      const draft7 = new Ajv({ allErrors: true });
      draft7.addVocabulary([
        "faker",
        "schmockNullable",
        "schmockTrueProbability",
      ]);
      expect(draft7.compile(result)("archived")).toBe(true);
    });

    it("generates every value from the accepted examples, varied across seeds", async () => {
      const examples = ["active", "idle", "paused"];
      const values = await readSeeded(
        { type: "string", examples: [...examples, 42] },
        12,
      );
      for (const value of values) expect(examples).toContain(value);
      expect(new Set(values).size).toBeGreaterThan(1);
    });

    it("reproduces the same draws for the same faker seed", async () => {
      const schema = {
        type: "array",
        minItems: 8,
        maxItems: 8,
        items: { type: "string", examples: ["a", "b", "c"] },
      };
      const first = await readSeeded(schema, 3);
      expect(await readSeeded(schema, 3)).toEqual(first);
      for (const value of first.flat())
        expect(["a", "b", "c"]).toContain(value);
      expect(new Set(first.flat()).size).toBeGreaterThan(1);
    });

    it("draws numbers and dates from a pool", async () => {
      const integers = await readSeeded(
        { type: "integer", format: "int64", examples: [3, 7] },
        8,
      );
      for (const value of integers) expect([3, 7]).toContain(value);

      const dates = ["2024-02-01", "2024-03-01"];
      const drawnDates = await readSeeded(
        { type: "string", format: "date", examples: dates },
        8,
      );
      for (const value of drawnDates) expect(dates).toContain(value);

      // json-schema-faker restates a drawn date-time in its toISOString form.
      const instants = ["2024-02-01T10:00:00Z", "2024-03-01T10:00:00Z"];
      const restated = instants.map((instant) =>
        new Date(instant).toISOString(),
      );
      const drawnInstants = await readSeeded(
        { type: "string", format: "date-time", examples: instants },
        8,
      );
      for (const value of drawnInstants) expect(restated).toContain(value);
    });

    it("never generates a 3.1 examples entry its own node rejects", async () => {
      const mock = await mockFor(
        valueSpec({ type: "string", format: "uuid", examples: [malformed] }),
      );

      const ids = new Set<unknown>();
      for (let i = 0; i < 3; i++) {
        const { body } = await mock.handle("GET", "/value");
        expect(body).toMatch(UUID);
        ids.add(body);
      }
      expect(ids.has(malformed)).toBe(false);
      expect(ids.size).toBeGreaterThan(1);
    });

    it("never generates an example a composed node's branches reject", async () => {
      for (const examples of [
        { examples: [malformed, stationA] },
        { example: malformed },
      ]) {
        const uuids = await readSeeded(
          { type: "string", allOf: [{ format: "uuid" }], ...examples },
          6,
          "example" in examples ? "3.0.3" : undefined,
        );
        for (const value of uuids) expect(value).toMatch(UUID);
        expect(uuids).not.toContain(malformed);
      }

      // `not` rejects "x", so "y" is the one accepted entry, and the default
      // it becomes is what @schmock/faker returns.
      for (let fakerSeed = 0; fakerSeed < 4; fakerSeed++) {
        const mock = await mockFor(
          valueSpec({
            type: "string",
            not: { const: "x" },
            examples: ["x", "y"],
          }),
          { fakerSeed },
        );
        const response = await mock.handle("GET", "/value");
        expect(response.status).toBe(200);
        expect(response.body).toBe("y");
      }
    });

    it("never generates a 3.0 example its own node rejects", async () => {
      const values = await readSeeded(
        { type: "string", format: "uuid", example: malformed },
        3,
        "3.0.3",
      );
      for (const value of values) expect(value).toMatch(UUID);
      expect(values).not.toContain(malformed);
    });

    it("generates Train Travel stations from the spec's examples and trips with well-formed ids", async () => {
      const spec = resolve(__dirname, "__fixtures__/train-travel.yaml");
      const names = new Set<unknown>();
      for (let fakerSeed = 0; fakerSeed < 4; fakerSeed++) {
        const mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec, fakerSeed }));

        const stations = await mock.handle("GET", "/stations");
        for (const station of listData(stations.body)) {
          names.add(station.name);
          expect([stationA, stationB]).toContain(station.id);
        }

        const trips = await mock.handle("GET", "/trips");
        for (const trip of listData(trips.body)) {
          expect(trip.id).toMatch(UUID);
          expect(trip.id).not.toBe(malformed);
        }
      }
      expect([...names].sort()).toEqual([
        "Berlin Hauptbahnhof",
        "Paris Gare du Nord",
      ]);
    });

    it("mints distinct ids for created rows even when the id declares examples", async () => {
      for (const id of [
        { type: "integer", examples: [7, 9] },
        { type: "string", format: "uuid", examples: [stationA, stationB] },
      ]) {
        const pet = {
          type: "object",
          properties: { id, name: { type: "string" } },
        };
        const mock = await mockFor(
          specWith(
            {
              "/pets": {
                get: {
                  responses: {
                    "200": {
                      description: "ok",
                      content: json({ type: "array", items: pet }),
                    },
                  },
                },
                post: {
                  requestBody: { content: json(pet) },
                  responses: {
                    "201": { description: "created", content: json(pet) },
                  },
                },
              },
              "/pets/{id}": {
                parameters: [
                  { name: "id", in: "path", required: true, schema: id },
                ],
                get: {
                  responses: {
                    "200": { description: "ok", content: json(pet) },
                  },
                },
              },
            },
            {},
            "3.1.0",
          ),
        );

        const ids: unknown[] = [];
        for (const name of ["Rex", "Tom"]) {
          const created = await mock.handle("POST", "/pets", {
            body: { name },
          });
          expect(created.status).toBe(201);
          ids.push(isRecord(created.body) ? created.body.id : undefined);
        }
        expect(new Set(ids).size).toBe(2);
        for (const value of ids) expect(id.examples).not.toContain(value);
      }
    });

    it("answers drawn values that response validation accepts and validates requests as before", async () => {
      const status = {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", examples: ["active", "idle"] },
        },
      };
      const mock = await mockFor(
        specWith(
          {
            "/status": {
              get: {
                responses: {
                  "200": { description: "ok", content: json(status) },
                },
              },
              put: {
                requestBody: { required: true, content: json(status) },
                responses: { "204": { description: "saved" } },
              },
            },
          },
          {},
          "3.1.0",
        ),
        { validateRequests: true, validateResponses: true },
      );

      const read = await mock.handle("GET", "/status");
      expect(read.status).toBe(200);
      expect(isRecord(read.body) ? read.body.status : undefined).toMatch(
        /^(active|idle)$/,
      );

      const saved = await mock.handle("PUT", "/status", {
        body: { status: "archived" },
      });
      expect(saved.status).toBe(204);
    });

    it("hands the draw to an onSchema hook as a faker keyword it can remove to pin a value", async () => {
      const seen: unknown[] = [];
      const mock = await mockFor(
        valueSpec({
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", examples: ["active", "idle"] },
          },
        }),
        {
          onSchema: (schema) => {
            const status = isRecord(schema.properties)
              ? schema.properties.status
              : undefined;
            if (!isRecord(status)) return undefined;
            seen.push(status.faker);
            const { faker: _, ...pinned } = status;
            return {
              ...schema,
              properties: { status: { ...pinned, default: "archived" } },
            };
          },
        },
      );

      const { body } = await mock.handle("GET", "/value");
      expect(seen).toEqual([pool(["active", "idle"])]);
      expect(body).toEqual({ status: "archived" });
    });
  });

  describe("exclusiveMinimum/exclusiveMaximum boolean → number", () => {
    it("converts exclusiveMinimum: true to number format", () => {
      const result = normalizeSchema(
        { type: "number", minimum: 0, exclusiveMinimum: true },
        "response",
      );
      expect(result.exclusiveMinimum).toBe(0);
      expect(result).not.toHaveProperty("minimum");
    });

    it("removes exclusiveMinimum: false", () => {
      const result = normalizeSchema(
        { type: "number", minimum: 0, exclusiveMinimum: false },
        "response",
      );
      expect(result.minimum).toBe(0);
      expect(result).not.toHaveProperty("exclusiveMinimum");
    });

    it("converts exclusiveMaximum: true to number format", () => {
      const result = normalizeSchema(
        { type: "number", maximum: 100, exclusiveMaximum: true },
        "response",
      );
      expect(result.exclusiveMaximum).toBe(100);
      expect(result).not.toHaveProperty("maximum");
    });
  });

  describe("x-* extensions", () => {
    it("strips all x- prefixed properties", () => {
      const result = normalizeSchema(
        {
          type: "string",
          "x-custom": "value",
          "x-another": 42,
        },
        "response",
      );
      expect(result).not.toHaveProperty("x-custom");
      expect(result).not.toHaveProperty("x-another");
      expect(result.type).toBe("string");
    });
  });

  describe("a property named __proto__", () => {
    // JSON.parse makes `__proto__` an own key; an object literal would not.
    const parsed = (text: string) => JSON.parse(text) as Record<string, any>;

    it("stays an own property and leaves the prototype alone", () => {
      const result = normalizeSchema(
        parsed(
          '{"type":"object","properties":{"__proto__":{"type":"string"},"name":{"type":"string"}},' +
            '"patternProperties":{"__proto__":{"type":"number"}}}',
        ),
        "request",
      );
      const props = result.properties as Record<string, unknown>;
      const patterns = result.patternProperties as Record<string, unknown>;

      expect(Object.keys(props)).toEqual(["__proto__", "name"]);
      expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
      expect(Object.keys(patterns)).toEqual(["__proto__"]);
      expect(Object.getPrototypeOf(patterns)).toBe(Object.prototype);
    });

    it("keeps a boolean __proto__ property schema an own key", () => {
      const result = normalizeSchema(
        parsed(
          '{"type":"object","properties":{"__proto__":true,"name":{"type":"string"}}}',
        ),
        "request",
      );
      const props = result.properties as Record<string, unknown>;

      expect(Object.keys(props)).toEqual(["__proto__", "name"]);
      expect(Object.getOwnPropertyDescriptor(props, "__proto__")?.value).toBe(
        true,
      );
      expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
    });

    it("keeps a validated request body compilable", async () => {
      const mock = await mockFor(
        parsed(
          JSON.stringify(
            specWith({
              "/items": {
                post: {
                  requestBody: {
                    required: true,
                    content: json({
                      type: "object",
                      properties: { PROTO: { type: "string" }, name: {} },
                      required: ["name"],
                    }),
                  },
                  responses: { "201": { description: "ok" } },
                },
              },
            }),
          ).replace('"PROTO"', '"__proto__"'),
        ),
        { validateRequests: true },
      );

      const created = await mock.handle("POST", "/items", {
        body: { name: "x" },
      });
      expect(created.status).toBe(201);
    });
  });

  describe("deep recursion", () => {
    it("normalizes nested properties → items → oneOf", () => {
      const result = normalizeSchema(
        {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                oneOf: [
                  { type: "string", nullable: true },
                  { type: "integer", example: 42 },
                ],
              },
            },
          },
        },
        "response",
      );

      const itemsSchema = result.properties?.items;
      expect(itemsSchema).toBeDefined();
      const arraySchema = itemsSchema as Record<string, unknown>;
      const itemSchema = arraySchema.items as Record<string, unknown>;
      const branches = itemSchema.oneOf as Record<string, unknown>[];
      expect(branches).toHaveLength(2);
      // First branch: nullable string → schmockNullable marker
      expect(branches[0]).toHaveProperty("schmockNullable", true);
      expect(branches[0].type).toEqual(["string", "null"]);
      // Second branch: example → default
      expect(branches[1]).toHaveProperty("default", 42);
    });
  });

  describe("passthrough", () => {
    it("preserves standard JSON Schema 7 features", () => {
      const input = {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
          age: { type: "integer", minimum: 0, maximum: 150 },
          role: { type: "string", enum: ["admin", "user"] },
          email: { type: "string", pattern: "^[^@]+@[^@]+$" },
        },
        required: ["name"],
      };
      const result = normalizeSchema(input, "response");
      expect(result.properties?.name).toMatchObject({
        type: "string",
        minLength: 1,
        maxLength: 100,
      });
      expect(result.properties?.age).toMatchObject({
        type: "integer",
        minimum: 0,
        maximum: 150,
      });
      expect(result.required).toEqual(["name"]);
    });
  });

  describe("shared components through the plugin", () => {
    const userSchemas = {
      User: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "integer", readOnly: true },
          name: { type: "string" },
          password: { type: "string", writeOnly: true },
        },
      },
    };

    it("accepts a request that omits a readOnly id in a $ref copy that carries a description", async () => {
      for (const version of ["3.0.3", "3.1.0"]) {
        const pair = {
          type: "object",
          properties: {
            author: { $ref: "#/components/schemas/User" },
            reviewer: {
              $ref: "#/components/schemas/User",
              description: "The reviewer",
            },
          },
        };
        const mock = await mockFor(
          specWith(
            {
              "/reviews": {
                post: {
                  requestBody: { required: true, content: json(pair) },
                  responses: { "201": { description: "ok" } },
                },
              },
            },
            userSchemas,
            version,
          ),
          { validateRequests: true },
        );

        const response = await mock.handle("POST", "/reviews", {
          body: { author: { name: "a" }, reviewer: { name: "b" } },
        });
        expect(response.status).toBe(201);
      }
    });

    it("never returns a writeOnly value in either copy of a $ref that carries a description", async () => {
      const team = {
        type: "object",
        required: ["lead", "deputy"],
        properties: {
          deputy: {
            $ref: "#/components/schemas/User",
            description: "The deputy",
          },
          lead: { $ref: "#/components/schemas/User" },
          members: {
            type: "array",
            items: { $ref: "#/components/schemas/User" },
          },
        },
      };
      const mock = await mockFor(
        specWith(
          {
            "/team": {
              get: {
                responses: {
                  "200": { description: "ok", content: json(team) },
                },
              },
            },
          },
          {
            User: {
              ...userSchemas.User,
              required: ["name", "password"],
            },
          },
          "3.1.0",
        ),
        { fakerSeed: 3 },
      );

      for (let i = 0; i < 5; i++) {
        const response = await mock.handle("GET", "/team");
        expect(response.status).toBe(200);
        expect(JSON.stringify(response.body)).not.toContain("password");
      }
    });

    it("ignores client values for every property that references a shared readOnly component", async () => {
      const pet = { $ref: "#/components/schemas/Pet" };
      const mock = await mockFor(
        specWith(
          {
            "/pets": {
              post: {
                requestBody: { content: json(pet) },
                responses: { "201": { description: "ok", content: json(pet) } },
              },
              get: {
                responses: {
                  "200": {
                    description: "ok",
                    content: json({ type: "array", items: pet }),
                  },
                },
              },
            },
            "/pets/{id}": {
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  schema: { type: "integer" },
                },
              ],
              get: {
                responses: { "200": { description: "ok", content: json(pet) } },
              },
              patch: {
                requestBody: { content: json(pet) },
                responses: { "200": { description: "ok", content: json(pet) } },
              },
            },
          },
          {
            Timestamp: { type: "string", format: "date-time", readOnly: true },
            Pet: {
              type: "object",
              properties: {
                id: { type: "integer" },
                name: { type: "string" },
                createdAt: { $ref: "#/components/schemas/Timestamp" },
                updatedAt: { $ref: "#/components/schemas/Timestamp" },
              },
            },
          },
        ),
      );
      const client = "1999-01-01T00:00:00Z";

      const created = await mock.handle("POST", "/pets", {
        body: { name: "Rex", createdAt: client, updatedAt: client },
      });
      expect(created.status).toBe(201);
      const body = created.body as Record<string, unknown>;
      expect(body.createdAt).not.toBe(client);
      expect(body.updatedAt).not.toBe(client);

      const patched = await mock.handle("PATCH", `/pets/${body.id}`, {
        body: { updatedAt: client },
      });
      expect((patched.body as Record<string, unknown>).updatedAt).toBe(
        body.updatedAt,
      );
    });
  });

  describe("access modes across allOf branches through the plugin", () => {
    const account = {
      allOf: [
        { $ref: "#/components/schemas/Base" },
        { required: ["id", "name", "password"] },
      ],
    };
    const accountSchemas = {
      Base: {
        type: "object",
        properties: {
          id: { type: "integer", readOnly: true },
          name: { type: "string" },
          password: { type: "string", writeOnly: true },
        },
      },
    };

    it("accepts a request that omits a readOnly id another branch requires", async () => {
      const mock = await mockFor(
        specWith(
          {
            "/accounts": {
              post: {
                requestBody: { required: true, content: json(account) },
                responses: { "201": { description: "ok" } },
              },
            },
          },
          accountSchemas,
        ),
        { validateRequests: true },
      );

      const response = await mock.handle("POST", "/accounts", {
        body: { name: "Ada", password: "secret" },
      });
      expect(response.status).toBe(201);
    });

    it("never generates a writeOnly key another branch requires", async () => {
      const mock = await mockFor(
        specWith(
          {
            "/me": {
              get: {
                responses: {
                  "200": { description: "ok", content: json(account) },
                },
              },
            },
          },
          accountSchemas,
        ),
        { validateResponses: true },
      );

      const response = await mock.handle("GET", "/me");
      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty("password");
    });
  });

  describe("discriminator", () => {
    it("pins the mapping values on anyOf branches the way it does on oneOf", () => {
      const branch = (name: string) => ({
        type: "object",
        properties: {
          petType: { type: "string" },
          [name]: { type: "boolean" },
        },
      });
      for (const keyword of ["oneOf", "anyOf"]) {
        const result = normalizeSchema(
          {
            discriminator: {
              propertyName: "petType",
              "x-schmock-discriminator-values": [["cat"], ["dog", "puppy"]],
            },
            [keyword]: [branch("meow"), branch("bark")],
          },
          "response",
        );

        expect(result).not.toHaveProperty("discriminator");
        const [cat, dog] = result[keyword as "oneOf"] as JSONSchema7[];
        expect(cat.required).toEqual(["petType"]);
        expect(cat.properties?.petType).toEqual({
          type: "string",
          enum: ["cat"],
        });
        expect(dog.properties?.petType).toEqual({
          type: "string",
          enum: ["dog", "puppy"],
        });
      }
    });

    it("requires inline discriminator properties without inventing enum values", () => {
      const result = normalizeSchema(
        {
          discriminator: {
            propertyName: "petType",
            mapping: {
              dog: "#/components/schemas/Dog",
              cat: "#/components/schemas/Cat",
            },
          },
          oneOf: [
            {
              type: "object",
              properties: {
                petType: { type: "string" },
                bark: { type: "boolean" },
              },
            },
            {
              type: "object",
              properties: {
                petType: { type: "string" },
                purr: { type: "boolean" },
              },
            },
          ],
        },
        "response",
      );

      expect(result).not.toHaveProperty("discriminator");
      const branches = result.oneOf as Record<string, unknown>[];
      expect(branches).toHaveLength(2);

      // Each branch should have petType as required
      for (const branch of branches) {
        expect(branch.required).toContain("petType");
        expect(branch).not.toHaveProperty("properties.petType.enum");
      }
    });
  });
});
