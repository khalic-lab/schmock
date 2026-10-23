import { resolve } from "node:path";
import type * as Schmock from "@schmock/core";
import { schmock } from "@schmock/core";
import Ajv2020 from "ajv/dist/2020.js";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { findArrayProperty } from "./generators";
import { collectAccessModes, normalizeSchema } from "./normalizer";
import { openapi } from "./plugin";
import { hasType } from "./utils";

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

  describe("example → default", () => {
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
