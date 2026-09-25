import { resolve } from "node:path";
import { schmock } from "@schmock/core";
import Ajv2020 from "ajv/dist/2020.js";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import type { CrudResource } from "./crud-detector";
import { detectCrudResources } from "./crud-detector";
import {
  arrayPropertyPath,
  createUpdateGenerator,
  findArrayProperty,
  generateHeaderValues,
  PENDING_MUTATIONS_KEY,
} from "./generators";
import { collectAccessModes, normalizeSchema } from "./normalizer";
import { parseSpec } from "./parser";
import { openapi } from "./plugin";

const ajv = new Ajv2020({ strictSchema: false, strictTypes: false });

function accepts(schema: JSONSchema7, value: unknown): boolean {
  return ajv.compile(schema)(value);
}

const zone: JSONSchema7 = {
  type: "object",
  properties: { id: { type: "integer" }, name: { type: "string" } },
};
const message: JSONSchema7 = {
  type: "object",
  properties: { code: { type: "integer" }, message: { type: "string" } },
};
const link: JSONSchema7 = {
  type: "object",
  properties: { href: { type: "string" } },
};
const namedPet: JSONSchema7 = {
  type: "object",
  properties: { name: { type: "string" }, tag: { type: "string" } },
};

describe("findArrayProperty ranking (#13)", () => {
  it("prefers the array whose items declare an id over an earlier one", () => {
    const info = findArrayProperty({
      type: "object",
      properties: {
        errors: { type: "array", items: message },
        result: { type: "array", items: zone },
      },
    });
    expect(info.property).toBe("result");
    expect(arrayPropertyPath(info)).toEqual(["result"]);
    expect(info.itemSchema).toBe(zone);
  });

  it("ranks allOf branches the same way", () => {
    const info = findArrayProperty({
      allOf: [
        {
          type: "object",
          properties: { errors: { type: "array", items: message } },
        },
        {
          type: "object",
          properties: { result: { type: "array", items: zone } },
        },
      ],
    });
    expect(arrayPropertyPath(info)).toEqual(["result"]);
  });

  it("uses the id hint before the generic id", () => {
    const withPetId: JSONSchema7 = {
      type: "object",
      properties: { petId: { type: "integer" } },
    };
    const withId: JSONSchema7 = {
      type: "object",
      properties: { id: { type: "integer" } },
    };
    const info = findArrayProperty(
      {
        type: "object",
        properties: {
          related: { type: "array", items: withId },
          pets: { type: "array", items: withPetId },
        },
      },
      { idProperties: ["petId", "id"] },
    );
    expect(arrayPropertyPath(info)).toEqual(["pets"]);
  });

  it("falls back to a conventional name when no array declares an id", () => {
    const info = findArrayProperty({
      type: "object",
      properties: {
        links: { type: "array", items: link },
        data: { type: "array", items: namedPet },
      },
    });
    expect(arrayPropertyPath(info)).toEqual(["data"]);
  });

  it("prefers the array matching the known item schema", () => {
    const info = findArrayProperty(
      {
        type: "object",
        properties: {
          links: { type: "array", items: link },
          pets: { type: "array", items: namedPet },
        },
      },
      { itemSchema: namedPet },
    );
    expect(arrayPropertyPath(info)).toEqual(["pets"]);
  });

  it("skips an array of primitives in favour of an array of objects", () => {
    const info = findArrayProperty({
      type: "object",
      properties: {
        warnings: { type: "array", items: { type: "string" } },
        pets: { type: "array", items: namedPet },
      },
    });
    expect(arrayPropertyPath(info)).toEqual(["pets"]);
  });

  it("keeps the first array when nothing tells them apart", () => {
    const info = findArrayProperty({
      type: "object",
      properties: {
        first: { type: "array", items: namedPet },
        second: { type: "array", items: namedPet },
      },
    });
    expect(arrayPropertyPath(info)).toEqual(["first"]);
  });
});

describe("findArrayProperty envelope shapes (#14)", () => {
  it("scans an envelope that omits type: object", () => {
    const info = findArrayProperty({
      properties: {
        data: { type: "array", items: zone },
        total: { type: "integer" },
      },
    });
    expect(arrayPropertyPath(info)).toEqual(["data"]);
    expect(info.property).toBe("data");
  });

  it("finds an array one level down", () => {
    const info = findArrayProperty({
      type: "object",
      properties: {
        page: {
          type: "object",
          properties: {
            items: { type: "array", items: zone },
            size: { type: "integer" },
          },
        },
      },
    });
    expect(arrayPropertyPath(info)).toEqual(["page", "items"]);
    expect(info.property).toBe("page");
    expect(info.itemSchema).toBe(zone);
  });

  it("finds a HAL _embedded array", () => {
    const info = findArrayProperty({
      type: "object",
      properties: {
        _links: {
          type: "object",
          properties: { self: { type: "object" } },
        },
        _embedded: {
          type: "object",
          properties: { zones: { type: "array", items: zone } },
        },
      },
    });
    expect(arrayPropertyPath(info)).toEqual(["_embedded", "zones"]);
  });

  it("prefers a top-level array over an equally ranked nested one", () => {
    const info = findArrayProperty({
      type: "object",
      properties: {
        meta: {
          type: "object",
          properties: { related: { type: "array", items: zone } },
        },
        zones: { type: "array", items: zone },
      },
    });
    expect(arrayPropertyPath(info)).toEqual(["zones"]);
  });

  it("keeps the single-level result shape unchanged", () => {
    expect(
      findArrayProperty({
        type: "object",
        properties: { data: { type: "array", items: zone } },
      }),
    ).toEqual({ property: "data", itemSchema: zone });
  });

  it("does not read an ordinary nested array as the list", () => {
    const info = findArrayProperty({
      type: "object",
      properties: {
        card_issuing: {
          type: "object",
          properties: {
            status_details: { type: "array", items: message },
          },
        },
      },
    });
    expect(arrayPropertyPath(info)).toBeUndefined();
  });

  it("admits a nested array under an envelope key even without an id", () => {
    const info = findArrayProperty({
      type: "object",
      properties: {
        page: {
          type: "object",
          properties: { items: { type: "array", items: namedPet } },
        },
      },
    });
    expect(arrayPropertyPath(info)).toEqual(["page", "items"]);
  });

  it("prefers the operation's own array over a generic wrapper's (allOf)", () => {
    const booking: JSONSchema7 = {
      type: "object",
      properties: { id: { type: "string" }, trip_id: { type: "string" } },
    };
    const info = findArrayProperty(
      {
        allOf: [
          {
            type: "object",
            properties: {
              data: { type: "array", items: { type: "object" } },
              links: { type: "object" },
            },
          },
          {
            properties: { data: { type: "array", items: booking } },
          },
        ],
      },
      { idProperties: ["bookingId", "id"] },
    );
    expect(arrayPropertyPath(info)).toEqual(["data"]);
    expect(info.itemSchema).toBe(booking);
  });

  it("returns the declared items object itself, not a copy", () => {
    const items: JSONSchema7 = { type: "object", properties: {} };
    expect(findArrayProperty({ type: "array", items }).itemSchema).toBe(items);
    expect(
      findArrayProperty({
        type: "object",
        properties: { data: { type: "array", items } },
      }).itemSchema,
    ).toBe(items);
  });
});

describe("example promotion (#15)", () => {
  it("does not promote an object example on an object node", () => {
    const out = normalizeSchema(
      {
        type: "object",
        properties: { name: { type: "string" } },
        example: { name: "doggie" },
      },
      "response",
    );
    expect(out).not.toHaveProperty("default");
    expect(out).not.toHaveProperty("example");
  });

  it("does not promote an array example", () => {
    const out = normalizeSchema(
      { type: "array", items: { type: "string" }, example: ["a", "b"] },
      "response",
    );
    expect(out).not.toHaveProperty("default");
  });

  it("still promotes a scalar example", () => {
    const out = normalizeSchema(
      { type: "string", example: "hello" },
      "response",
    );
    expect(out.default).toBe("hello");
  });

  it("does not promote a primitive example on an object-typed node", () => {
    const out = normalizeSchema(
      { type: "object", properties: {}, example: "nonsense" },
      "response",
    );
    expect(out).not.toHaveProperty("default");
  });

  it("keeps an explicit object default", () => {
    const out = normalizeSchema(
      { type: "object", properties: {}, default: { a: 1 } },
      "response",
    );
    expect(out.default).toEqual({ a: 1 });
  });
});

describe("nullable typeless keywords (#62)", () => {
  it("adds null to a typeless enum", () => {
    const out = normalizeSchema(
      { enum: ["a", "b"], nullable: true },
      "request",
    );
    expect(accepts(out, null)).toBe(true);
    expect(accepts(out, "a")).toBe(true);
    expect(accepts(out, "c")).toBe(false);
  });

  it("turns a typeless nullable const into an enum with null", () => {
    const out = normalizeSchema({ const: "a", nullable: true }, "request");
    expect(accepts(out, null)).toBe(true);
    expect(accepts(out, "a")).toBe(true);
    expect(accepts(out, "b")).toBe(false);
  });

  it("turns a typed nullable const into an enum with null", () => {
    const out = normalizeSchema(
      { type: "string", const: "a", nullable: true },
      "request",
    );
    expect(accepts(out, null)).toBe(true);
    expect(accepts(out, "a")).toBe(true);
    expect(accepts(out, "b")).toBe(false);
  });

  it("keeps the schmockNullable marker", () => {
    const out = normalizeSchema(
      { enum: ["a", "b"], nullable: true },
      "response",
    );
    expect(out).toHaveProperty("schmockNullable", true);
  });
});

describe("access modes (#16)", () => {
  const user = {
    type: "object",
    properties: {
      id: { type: "integer", readOnly: true },
      name: { type: "string" },
      password: { type: "string", writeOnly: true },
    },
  };

  it("records the properties each direction strips or keeps", () => {
    for (const direction of ["request", "response"] as const) {
      const modes = collectAccessModes(normalizeSchema(user, direction));
      expect([...modes.readOnly]).toEqual(["id"]);
      expect([...modes.writeOnly]).toEqual(["password"]);
    }
  });

  it("follows allOf branches", () => {
    const modes = collectAccessModes(
      normalizeSchema(
        { allOf: [user, { type: "object", properties: {} }] },
        "response",
      ),
    );
    expect(modes.writeOnly.has("password")).toBe(true);
  });

  it("is empty for a schema that was never normalized", () => {
    const modes = collectAccessModes({ type: "object" });
    expect(modes.readOnly.size).toBe(0);
    expect(modes.writeOnly.size).toBe(0);
  });

  it("reaches the resource when the list path is declared first", async () => {
    const spec = await parseSpec({
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
                      items: { $ref: "#/components/schemas/User" },
                    },
                  },
                },
              },
            },
          },
          post: { responses: { "201": { description: "Created" } } },
        },
        "/users/{userId}": {
          get: {
            responses: {
              "200": {
                description: "User",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Base: {
            type: "object",
            properties: { id: { type: "integer", readOnly: true } },
          },
          User: {
            allOf: [
              { $ref: "#/components/schemas/Base" },
              {
                type: "object",
                properties: {
                  name: { type: "string" },
                  password: { type: "string", writeOnly: true },
                },
              },
            ],
          },
        },
      },
    });
    const [resource] = detectCrudResources(spec.paths).resources;
    expect(resource.accessModes?.writeOnly.has("password")).toBe(true);
    expect(resource.accessModes?.readOnly.has("id")).toBe(true);
  });
});

describe("CRUD detection (#13, #64)", () => {
  async function detect(paths: Record<string, unknown>) {
    const spec = await parseSpec({
      openapi: "3.0.3",
      info: { title: "Detect", version: "1.0.0" },
      paths,
    });
    return detectCrudResources(spec.paths);
  }

  const ok = (schema: Record<string, unknown>) => ({
    "200": {
      description: "OK",
      content: { "application/json": { schema } },
    },
  });

  it("marks a lone item GET as a lookup", async () => {
    const { resources } = await detect({
      "/users/{username}": { get: { responses: ok({ type: "object" }) } },
    });
    expect(resources).toHaveLength(1);
    expect(resources[0].operations).toEqual(["read"]);
    expect(resources[0].lookupOnly).toBe(true);
  });

  it("does not mark a list+read resource as a lookup", async () => {
    const { resources } = await detect({
      "/articles": { get: { responses: ok({ type: "array", items: {} }) } },
      "/articles/{articleId}": { get: { responses: ok({ type: "object" }) } },
    });
    expect(resources[0].operations).toEqual(["list", "read"]);
    expect(resources[0].lookupOnly).toBeFalsy();
  });

  it("does not mark an item group with writes as a lookup", async () => {
    const { resources } = await detect({
      "/users/{username}": {
        get: { responses: ok({ type: "object" }) },
        delete: { responses: { "204": { description: "Gone" } } },
      },
    });
    expect(resources[0].lookupOnly).toBeFalsy();
  });

  it("names a resource whose collection path ends in a parameter after its last literal segment", async () => {
    const { resources } = await detect({
      "/repos/{owner}/{repo}": {
        get: { responses: ok({ type: "object" }) },
        delete: { responses: { "204": { description: "Gone" } } },
      },
    });
    expect(resources[0].name).toBe("repos");
    expect(resources[0].basePath).toBe("/repos/:owner");
  });

  it("takes the resource schema from the ranked list array", async () => {
    const { resources } = await detect({
      "/zones": {
        get: {
          responses: ok({
            type: "object",
            properties: {
              errors: { type: "array", items: message },
              result: { type: "array", items: zone },
            },
          }),
        },
        post: { responses: { "201": { description: "Created" } } },
      },
      "/zones/{zone_id}": { get: { responses: ok(zone) } },
    });
    const [resource] = resources;
    expect(Object.keys(resource.schema?.properties ?? {})).toEqual([
      "id",
      "name",
    ]);
    expect(resource.idProperty).toBe("id");
  });
});

describe("response headers (#72)", () => {
  function one(schema: JSONSchema7): string | undefined {
    return generateHeaderValues({ "X-H": { schema, description: "" } })["X-H"];
  }

  it("emits a nullable integer", () => {
    expect(one({ type: ["integer", "null"] })).toBe("0");
  });

  it("emits a nullable string and boolean", () => {
    expect(one({ type: ["string", "null"] })).toBe("");
    expect(one({ type: ["boolean", "null"] })).toBe("false");
  });

  it("honours an inclusive minimum", () => {
    expect(one({ type: "integer", minimum: 1 })).toBe("1");
  });

  it("honours an exclusive minimum", () => {
    expect(one({ type: "integer", exclusiveMinimum: 5 })).toBe("6");
  });

  it("honours a negative maximum", () => {
    expect(one({ type: "integer", maximum: -3 })).toBe("-3");
    expect(one({ type: "integer", exclusiveMaximum: -3 })).toBe("-4");
  });

  it("finds a value inside a fractional number range", () => {
    const value = Number(
      one({ type: "number", exclusiveMinimum: 0.5, maximum: 0.7 }),
    );
    expect(value).toBeGreaterThan(0.5);
    expect(value).toBeLessThanOrEqual(0.7);
  });

  it("honours a string minLength", () => {
    expect(one({ type: "string", minLength: 3 })).toHaveLength(3);
  });

  it("drops an object or array default instead of stringifying it", () => {
    expect(one({ type: "object", default: { a: 1 } })).toBeUndefined();
    expect(one({ type: "array", default: ["a"] })).toBeUndefined();
  });

  it("falls through a non-primitive default to the type placeholder", () => {
    expect(one({ type: "integer", default: { a: 1 } })).toBe("0");
  });

  it("skips a null enum value", () => {
    expect(one({ enum: [null, "x"] })).toBe("x");
  });
});

describe("update commit merges onto the live row (#12, #141)", () => {
  const resource: CrudResource = {
    name: "pets",
    basePath: "/pets",
    itemPath: "/pets/:petId",
    idParam: "petId",
    idProperty: "id",
    idKind: "integer",
    operations: ["update"],
    routes: [],
  };

  it("keeps both updates when two generators run before either commits", async () => {
    const key = "openapi:collections:/pets";
    const state: Record<string, unknown> = {
      [key]: [{ id: 1, name: "rex", tag: "old", age: 1 }],
    };
    const update = createUpdateGenerator(resource);
    const run = async (body: Record<string, unknown>) => {
      const pluginState = new Map<string, unknown>();
      const response = await update({
        method: "PATCH",
        path: "/pets/1",
        params: { petId: "1" },
        query: {},
        headers: {},
        state,
        body,
        pluginState,
      });
      const pending = pluginState.get(PENDING_MUTATIONS_KEY);
      return { response, pending: Array.isArray(pending) ? pending : [] };
    };

    const a = await run({ tag: "new" });
    const b = await run({ age: 9 });
    for (const commit of [...a.pending, ...b.pending]) commit();

    expect(state[key]).toEqual([{ id: 1, name: "rex", tag: "new", age: 9 }]);
    // Each response reflects the row its own commit wrote.
    expect(a.response).toEqual({ id: 1, name: "rex", tag: "new", age: 1 });
    expect(b.response).toEqual({ id: 1, name: "rex", tag: "new", age: 9 });
  });

  it("writes nothing when the row vanished before the commit", async () => {
    const key = "openapi:collections:/pets";
    const state: Record<string, unknown> = {
      [key]: [{ id: 1, name: "rex" }],
    };
    const pluginState = new Map<string, unknown>();
    await createUpdateGenerator(resource)({
      method: "PATCH",
      path: "/pets/1",
      params: { petId: "1" },
      query: {},
      headers: {},
      state,
      body: { name: "max" },
      pluginState,
    });
    state[key] = [];
    const pending = pluginState.get(PENDING_MUTATIONS_KEY);
    for (const commit of Array.isArray(pending) ? pending : []) {
      if (typeof commit === "function") commit();
    }
    expect(state[key]).toEqual([]);
  });
});

describe("list envelope key order (cold-review openapi-5)", () => {
  it("serves the Scalar Galaxy planets list as data, then meta", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: resolve(import.meta.dirname, "__fixtures__/scalar-galaxy.yaml"),
        fakerSeed: 1,
      }),
    );
    const response = await mock.handle("GET", "/planets");
    expect(response.status).toBe(200);
    expect(Object.keys(Object(response.body))).toEqual(["data", "meta"]);
  });
});

describe("list envelopes naming prototype keys (cold-review openapi-1)", () => {
  // Built from JSON so `__proto__` is an OWN key, as a parsed spec file has it;
  // an object literal would set the prototype instead and prove nothing.
  const pollutingSpec = () =>
    JSON.parse(`{
      "openapi": "3.0.3",
      "info": { "title": "Proto", "version": "1.0.0" },
      "paths": {
        "/items": {
          "get": { "responses": { "200": { "description": "List", "content": {
            "application/json": { "schema": {
              "type": "object",
              "properties": { "__proto__": {
                "type": "object",
                "properties": { "headers": {
                  "type": "array", "items": { "$ref": "#/components/schemas/Item" }
                } }
              } }
            } } } } } },
          "post": {
            "requestBody": { "content": { "application/json": {
              "schema": { "$ref": "#/components/schemas/Item" } } } },
            "responses": { "201": { "description": "Created", "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/Item" } } } } }
          }
        },
        "/items/{itemId}": {
          "get": { "responses": { "200": { "description": "Item", "content": {
            "application/json": { "schema": { "$ref": "#/components/schemas/Item" } } } } } }
        }
      },
      "components": { "schemas": { "Item": {
        "type": "object",
        "properties": { "id": { "type": "integer" }, "name": { "type": "string" } }
      } } }
    }`);

  it("leaves Object.prototype alone and keeps other mocks' envelopes working", async () => {
    try {
      const mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: pollutingSpec() }));
      await mock.handle("POST", "/items", { body: { name: "created-one" } });
      await mock.handle("GET", "/items");

      expect(Object.hasOwn(Object.prototype, "headers")).toBe(false);
      expect(Reflect.get({}, "headers")).toBeUndefined();

      const other = schmock();
      other("POST /things", () => ({ status: 201, body: { id: 7 } }));
      const created = await other.handle("POST", "/things");
      expect(created.status).toBe(201);
      expect(created.body).toEqual({ id: 7 });
    } finally {
      Reflect.deleteProperty(Object.prototype, "headers");
    }
  });

  it("does not read a prototype-named property as the list array", () => {
    const item: JSONSchema7 = {
      type: "object",
      properties: { id: { type: "integer" } },
    };
    for (const name of ["__proto__", "constructor", "prototype"]) {
      const properties: Record<string, JSONSchema7> = {};
      Object.defineProperty(properties, name, {
        value: {
          type: "object",
          properties: { data: { type: "array", items: item } },
        },
        enumerable: true,
      });
      const info = findArrayProperty({ type: "object", properties });
      expect(arrayPropertyPath(info)).toBeUndefined();
    }
  });
});
