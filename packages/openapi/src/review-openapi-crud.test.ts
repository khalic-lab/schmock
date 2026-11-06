/// <reference path="../../core/schmock.d.ts" />

import { SchemaGenerationError, schmock } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { detectCrudResources } from "./crud-detector.js";
import { applyOverrides } from "./crud-registration.js";
import { asSchemaGenerationError } from "./generators.js";
import { collectSchemaProperties } from "./list-envelope.js";
import { parseSpec } from "./parser.js";
import { openapi } from "./plugin.js";

const json = (schema: Record<string, unknown>) => ({
  "application/json": { schema },
});

function spec(paths: Record<string, unknown>) {
  return {
    openapi: "3.0.3",
    info: { title: "CRUD review", version: "1.0.0" },
    paths,
  };
}

async function mockOf(
  document: Record<string, unknown>,
  options: Partial<Schmock.OpenApiOptions> = {},
): Promise<Schmock.CallableMockInstance> {
  const mock = schmock({ state: {} });
  mock.pipe(await openapi({ spec: document, ...options }));
  return mock;
}

const pet = {
  type: "object",
  required: ["id", "name"],
  properties: { id: { type: "integer" }, name: { type: "string" } },
};

describe("CRUD review fixes", () => {
  describe("item envelopes on read, update and delete", () => {
    const petEnvelope = {
      type: "object",
      required: ["data"],
      properties: { data: pet },
    };
    const envelopeSpec = spec({
      "/pets": {
        get: {
          responses: {
            "200": {
              description: "list",
              content: json({
                type: "object",
                required: ["data"],
                properties: { data: { type: "array", items: pet } },
              }),
            },
          },
        },
        post: {
          requestBody: { content: json(pet) },
          responses: {
            "201": { description: "created", content: json(petEnvelope) },
          },
        },
      },
      "/pets/{petId}": {
        get: {
          responses: {
            "200": { description: "pet", content: json(petEnvelope) },
          },
        },
        patch: {
          requestBody: { content: json(pet) },
          responses: {
            "200": { description: "patched", content: json(petEnvelope) },
          },
        },
        delete: {
          responses: {
            "200": { description: "deleted", content: json(petEnvelope) },
          },
        },
      },
    });

    for (const validateResponses of [false, true]) {
      it(`answers every item operation in the declared envelope (validateResponses: ${validateResponses})`, async () => {
        const mock = await mockOf(envelopeSpec, { validateResponses });

        const created = await mock.handle("POST", "/pets", {
          body: { name: "rex" },
        });
        expect(created.status).toBe(201);
        expect(created.body).toEqual({ data: { id: 1, name: "rex" } });

        const read = await mock.handle("GET", "/pets/1");
        expect(read.status).toBe(200);
        expect(read.body).toEqual({ data: { id: 1, name: "rex" } });

        const patched = await mock.handle("PATCH", "/pets/1", {
          body: { name: "max" },
        });
        expect(patched.status).toBe(200);
        expect(patched.body).toEqual({ data: { id: 1, name: "max" } });

        // The stored row stays bare: the list carries it, not an envelope.
        const listed = await mock.handle("GET", "/pets");
        expect(listed.body).toEqual({ data: [{ id: 1, name: "max" }] });

        const deleted = await mock.handle("DELETE", "/pets/1");
        expect(deleted.status).toBe(200);
        expect(deleted.body).toEqual({ data: { id: 1, name: "max" } });

        const after = await mock.handle("GET", "/pets");
        expect(after.body).toEqual({ data: [] });
      });
    }

    it("passes the envelope contract, not the row, to onSchema", async () => {
      const seen: string[] = [];
      const mock = await mockOf(envelopeSpec, {
        onSchema: (schema, context) => {
          seen.push(
            `${context.method} ${Object.keys(schema.properties ?? {}).join(",")}`,
          );
          return undefined;
        },
      });
      await mock.handle("POST", "/pets", { body: { name: "rex" } });
      seen.length = 0;

      await mock.handle("GET", "/pets/1");
      expect(seen).toEqual(["GET data"]);
    });

    describe("onSchema on an enveloped create", () => {
      const metaEnvelopeSpec = spec({
        "/pets": {
          get: {
            responses: {
              "200": {
                description: "list",
                content: json({
                  type: "object",
                  properties: { data: { type: "array", items: pet } },
                }),
              },
            },
          },
          post: {
            responses: {
              "201": {
                description: "created",
                content: json({
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: pet,
                    meta: {
                      type: "object",
                      required: ["v"],
                      properties: { v: { type: "integer" } },
                    },
                  },
                }),
              },
            },
          },
        },
        "/pets/{petId}": {
          get: {
            responses: { "200": { description: "pet", content: json(pet) } },
          },
        },
      });

      it("hands the hook the response contract and generates the envelope from its result", async () => {
        const seen: string[] = [];
        const mock = await mockOf(metaEnvelopeSpec, {
          onSchema: (schema, context) => {
            seen.push(
              `${context.method} ${Object.keys(schema.properties ?? {}).join(",")}`,
            );
            if (context.method !== "POST" || !schema.properties?.meta) {
              return undefined;
            }
            return {
              ...schema,
              properties: {
                ...schema.properties,
                meta: {
                  type: "object",
                  required: ["traceId"],
                  properties: { traceId: { type: "string", const: "T-1" } },
                },
              },
            };
          },
        });

        const created = await mock.handle("POST", "/pets", {
          body: { name: "rex" },
        });
        expect(seen).toEqual(["POST data,meta"]);
        expect(created.status).toBe(201);
        expect(created.body).toEqual({
          data: { id: 1, name: "rex" },
          meta: { traceId: "T-1" },
        });
      });

      it("stores a field the hook adds to the wrapped item", async () => {
        const mock = await mockOf(metaEnvelopeSpec, {
          onSchema: (schema, context) => {
            const data = schema.properties?.data;
            if (context.method !== "POST" || typeof data !== "object") {
              return undefined;
            }
            return {
              ...schema,
              properties: {
                ...schema.properties,
                data: {
                  ...data,
                  required: ["id", "name", "nickname"],
                  properties: {
                    ...data.properties,
                    nickname: { type: "string", const: "N" },
                  },
                },
              },
            };
          },
        });

        const created = await mock.handle("POST", "/pets", {
          body: { name: "rex" },
        });
        expect(created.body).toMatchObject({
          data: { id: 1, name: "rex", nickname: "N" },
        });
        const read = await mock.handle("GET", "/pets/1");
        expect(read.body).toEqual({ id: 1, name: "rex", nickname: "N" });
      });
    });

    it("still replays the bare row when the item contract is not an envelope", async () => {
      const mock = await mockOf(
        spec({
          "/pets": {
            post: {
              responses: { "201": { description: "c", content: json(pet) } },
            },
          },
          "/pets/{petId}": {
            get: {
              responses: { "200": { description: "p", content: json(pet) } },
            },
          },
        }),
      );
      await mock.handle("POST", "/pets", { body: { name: "rex" } });
      const read = await mock.handle("GET", "/pets/1");
      expect(read.body).toEqual({ id: 1, name: "rex" });
    });

    it("does not read a nested object's id as an envelope when the item has no top-level id", async () => {
      // `/users/{id}` with an item that declares `userId`, not `id`: the id
      // property falls back to `id`, which only the nested `team` declares.
      const user = {
        type: "object",
        properties: {
          userId: { type: "integer" },
          name: { type: "string" },
          team: {
            type: "object",
            properties: { id: { type: "integer" }, label: { type: "string" } },
          },
        },
      };
      const parameters = [
        { name: "id", in: "path", required: true, schema: { type: "integer" } },
      ];
      const ok = { "200": { description: "u", content: json(user) } };
      const mock = await mockOf(
        spec({
          "/users": {
            get: {
              responses: {
                "200": {
                  description: "list",
                  content: json({ type: "array", items: user }),
                },
              },
            },
            post: {
              responses: { "201": { description: "c", content: json(user) } },
            },
          },
          "/users/{id}": {
            get: { parameters, responses: ok },
            patch: { parameters, responses: ok },
            delete: { parameters, responses: ok },
          },
        }),
      );
      const row = { userId: 7, name: "ann", team: { id: 3, label: "core" } };

      const created = await mock.handle("POST", "/users", { body: row });
      expect(created.body).toEqual({ ...row, id: 1 });
      const read = await mock.handle("GET", "/users/1");
      expect(read.body).toEqual({ ...row, id: 1 });
      const patched = await mock.handle("PATCH", "/users/1", {
        body: { name: "bob" },
      });
      expect(patched.body).toEqual({ ...row, id: 1, name: "bob" });
      const deleted = await mock.handle("DELETE", "/users/1");
      expect(deleted.body).toEqual({ ...row, id: 1, name: "bob" });
    });
  });

  describe("delete confirmation contracts", () => {
    const widget = {
      type: "object",
      required: ["id", "object", "name"],
      properties: {
        id: { type: "string" },
        object: { type: "string", enum: ["widget"] },
        name: { type: "string" },
      },
    };
    const deletedWidget = {
      type: "object",
      required: ["id", "object", "deleted"],
      properties: {
        id: { type: "string" },
        object: { type: "string", enum: ["widget"] },
        deleted: { type: "boolean", enum: [true] },
      },
    };
    const widgetSpec = (deleteSchema: Record<string, unknown>) =>
      spec({
        "/widgets": {
          get: {
            responses: {
              "200": {
                description: "list",
                content: json({ type: "array", items: widget }),
              },
            },
          },
          post: {
            responses: { "200": { description: "c", content: json(widget) } },
          },
        },
        "/widgets/{id}": {
          get: {
            responses: { "200": { description: "w", content: json(widget) } },
          },
          delete: {
            responses: {
              "200": { description: "deleted", content: json(deleteSchema) },
            },
          },
        },
      });

    for (const validateResponses of [false, true]) {
      it(`answers a declared confirmation object built around the row (validateResponses: ${validateResponses})`, async () => {
        const mock = await mockOf(widgetSpec(deletedWidget), {
          validateResponses,
        });
        await mock.handle("POST", "/widgets", { body: { name: "x" } });

        const deleted = await mock.handle("DELETE", "/widgets/1");
        expect(deleted.status).toBe(200);
        expect(deleted.body).toEqual({
          id: "1",
          object: "widget",
          deleted: true,
        });

        const list = await mock.handle("GET", "/widgets");
        expect(list.body).toEqual([]);
      });
    }

    it("replays the deleted row when the contract describes it", async () => {
      const mock = await mockOf(widgetSpec(widget), {
        validateResponses: true,
      });
      await mock.handle("POST", "/widgets", { body: { name: "x" } });

      const deleted = await mock.handle("DELETE", "/widgets/1");
      expect(deleted.status).toBe(200);
      expect(deleted.body).toMatchObject({ id: "1", name: "x" });
    });
  });

  describe("request fields on closed contracts and inherited names", () => {
    const closedPet = { ...pet, additionalProperties: false };
    const petsSpec = (item: Record<string, unknown>) =>
      spec({
        "/pets": {
          get: {
            responses: {
              "200": {
                description: "list",
                content: json({ type: "array", items: item }),
              },
            },
          },
          post: {
            responses: { "201": { description: "c", content: json(item) } },
          },
        },
        "/pets/{petId}": {
          get: {
            responses: { "200": { description: "p", content: json(item) } },
          },
          patch: {
            responses: { "200": { description: "p", content: json(item) } },
          },
          put: {
            responses: { "204": { description: "replaced" } },
          },
        },
      });

    function storedPets(mock: Schmock.CallableMockInstance): unknown[] {
      const rows = mock.getState()["openapi:collections:/pets"];
      return Array.isArray(rows) ? rows : [];
    }

    it("drops Object.prototype names on a closed create contract", async () => {
      const mock = await mockOf(petsSpec(closedPet));
      const created = await mock.handle("POST", "/pets", {
        body: {
          name: "rex",
          toString: "pwned",
          hasOwnProperty: "x",
          constructor: "c",
        },
      });
      expect(created.body).toEqual({ id: 1, name: "rex" });
      expect(Object.keys(storedPets(mock)[0] as object)).toEqual([
        "id",
        "name",
      ]);
    });

    it("collects declared properties named after Object.prototype members", () => {
      const text: JSONSchema7 = { type: "string" };
      const schema: JSONSchema7 = {
        properties: {
          id: { type: "integer" },
          constructor: text,
          toString: text,
        },
      };
      const declared = collectSchemaProperties(schema);
      expect(Object.keys(declared)).toEqual(["id", "constructor", "toString"]);
      expect("hasOwnProperty" in declared).toBe(false);
    });

    it("keeps schema properties that share a name with Object.prototype", async () => {
      const things = {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          constructor: { type: "string" },
          toString: { type: "string" },
        },
      };
      const mock = await mockOf(petsSpec(things), { validateResponses: true });
      const created = await mock.handle("POST", "/pets", {
        body: { constructor: "c1", toString: "s1" },
      });
      expect(created.status).toBe(201);
      expect(created.body).toEqual({
        id: 1,
        constructor: "c1",
        toString: "s1",
      });
    });

    it("stores a JSON __proto__ key as data, never as the row's prototype", async () => {
      const mock = await mockOf(petsSpec(pet));
      await mock.handle("POST", "/pets", {
        body: JSON.parse('{"name":"rex","__proto__":{"admin":true}}'),
      });
      await mock.handle("PATCH", "/pets/1", {
        body: JSON.parse('{"__proto__":{"root":true}}'),
      });

      const [row] = storedPets(mock);
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      const record = row as Record<string, unknown>;
      expect(record.admin).toBeUndefined();
      expect(record.root).toBeUndefined();
      expect(Object.hasOwn(record, "__proto__")).toBe(true);
    });

    for (const validateResponses of [false, true]) {
      it(`drops an undeclared field on a closed update contract (validateResponses: ${validateResponses})`, async () => {
        const mock = await mockOf(petsSpec(closedPet), { validateResponses });
        await mock.handle("POST", "/pets", { body: { name: "rex" } });

        const patched = await mock.handle("PATCH", "/pets/1", {
          body: { name: "max", undeclared: "stored" },
        });
        expect(patched.status).toBe(200);
        expect(patched.body).toEqual({ id: 1, name: "max" });

        const read = await mock.handle("GET", "/pets/1");
        expect(read.status).toBe(200);
        expect(read.body).toEqual({ id: 1, name: "max" });
      });
    }

    it("judges a bodiless update by the resource contract", async () => {
      const mock = await mockOf(petsSpec(closedPet), {
        validateResponses: true,
      });
      await mock.handle("POST", "/pets", { body: { name: "rex" } });

      const replaced = await mock.handle("PUT", "/pets/1", {
        body: { name: "max", undeclared: "stored" },
      });
      expect(replaced.status).toBe(204);

      const read = await mock.handle("GET", "/pets/1");
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ id: 1, name: "max" });
    });

    it("judges an update answering a closed confirmation by the resource contract", async () => {
      const confirmation = {
        type: "object",
        additionalProperties: false,
        properties: { updated: { type: "boolean" } },
      };
      const mock = await mockOf(
        spec({
          "/pets": {
            get: {
              responses: {
                "200": {
                  description: "list",
                  content: json({ type: "array", items: closedPet }),
                },
              },
            },
            post: {
              responses: {
                "201": { description: "c", content: json(closedPet) },
              },
            },
          },
          "/pets/{petId}": {
            get: {
              responses: {
                "200": { description: "p", content: json(closedPet) },
              },
            },
            patch: {
              responses: {
                "200": { description: "ok", content: json(confirmation) },
              },
            },
          },
        }),
      );
      await mock.handle("POST", "/pets", { body: { name: "rex" } });

      const patched = await mock.handle("PATCH", "/pets/1", {
        body: { name: "max", undeclared: "dropped" },
      });
      expect(patched.status).toBe(200);

      const read = await mock.handle("GET", "/pets/1");
      expect(read.body).toEqual({ id: 1, name: "max" });
    });
  });

  describe("composition-only and nullable create contracts", () => {
    const bank = {
      type: "object",
      required: ["id", "object", "routing_number"],
      properties: {
        id: { type: "integer" },
        object: { type: "string", enum: ["bank_account"] },
        routing_number: { type: "string" },
      },
    };
    const card = {
      type: "object",
      required: ["id", "object", "last4"],
      properties: {
        id: { type: "integer" },
        object: { type: "string", enum: ["card"] },
        last4: { type: "string" },
      },
    };
    const sourcesSpec = (source: Record<string, unknown>) =>
      spec({
        "/sources": {
          get: {
            responses: {
              "200": {
                description: "list",
                content: json({ type: "array", items: source }),
              },
            },
          },
          post: {
            responses: {
              "201": { description: "created", content: json(source) },
            },
          },
        },
        "/sources/{id}": {
          get: {
            responses: { "200": { description: "s", content: json(source) } },
          },
        },
      });

    for (const keyword of ["anyOf", "oneOf"]) {
      it(`generates a top-level ${keyword} create contract instead of echoing the request`, async () => {
        const mock = await mockOf(sourcesSpec({ [keyword]: [bank, card] }), {
          validateResponses: true,
          fakerSeed: 3,
        });

        const created = await mock.handle("POST", "/sources");
        expect(created.status).toBe(201);
        const body = created.body as Record<string, unknown>;
        expect(body.id).toBe(1);
        expect(["bank_account", "card"]).toContain(body.object);

        const read = await mock.handle("GET", "/sources/1");
        expect(read.status).toBe(200);
        expect(read.body).toEqual(body);
      });
    }

    const nullablePet = {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: ["name", "tag"],
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        tag: { type: "string" },
      },
      allOf: [{ required: ["id"] }],
    };

    it("reads a nullable allOf item through the normalizer's wrapper", async () => {
      const mock = await mockOf(
        spec({
          "/pets": {
            get: {
              responses: {
                "200": {
                  description: "list",
                  content: json({ type: "array", items: nullablePet }),
                },
              },
            },
            post: {
              responses: {
                "201": { description: "created", content: json(nullablePet) },
              },
            },
          },
        }),
        { validateResponses: true },
      );

      const created = await mock.handle("POST", "/pets", {
        body: { name: "rex", extra: "dropped" },
      });
      expect(created.status).toBe(201);
      expect(created.body).toEqual({
        id: 1,
        name: "rex",
        tag: expect.any(String),
      });
    });

    it("collects the properties inside the nullable wrapper", () => {
      const wrapped = {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: { id: { type: "integer" } },
            allOf: [{ properties: { name: { type: "string" } } }],
          },
        ],
        schmockNullable: true,
      } as Record<string, unknown>;
      expect(Object.keys(collectSchemaProperties(wrapped))).toEqual([
        "id",
        "name",
      ]);
    });
  });

  describe("singleton resources whose item holds an array", () => {
    const balanceTransaction = {
      type: "object",
      required: ["id", "amount"],
      properties: { id: { type: "string" }, amount: { type: "integer" } },
    };
    const dispute = {
      type: "object",
      required: ["id", "object", "amount", "balance_transactions"],
      properties: {
        id: { type: "string" },
        object: { type: "string", enum: ["dispute"] },
        amount: { type: "integer" },
        balance_transactions: {
          type: "array",
          minItems: 1,
          items: balanceTransaction,
        },
      },
    };
    const disputeSpec = spec({
      "/charges/{charge}/dispute": {
        get: {
          responses: { "200": { description: "d", content: json(dispute) } },
        },
        post: {
          responses: { "200": { description: "d", content: json(dispute) } },
        },
      },
    });

    for (const validateResponses of [false, true]) {
      it(`answers the declared item, not the collection, on GET (validateResponses: ${validateResponses})`, async () => {
        const mock = await mockOf(disputeSpec, {
          validateResponses,
          fakerSeed: 1,
        });

        const before = await mock.handle("GET", "/charges/ch_1/dispute");
        expect(before.status).toBe(200);
        expect(before.body).toMatchObject({ object: "dispute" });
        const transactions = (before.body as Record<string, unknown>)
          .balance_transactions;
        expect(Array.isArray(transactions) && transactions.length).toBeTruthy();

        const created = await mock.handle("POST", "/charges/ch_1/dispute", {
          body: { amount: 5 },
        });
        expect(created.status).toBe(200);

        const after = await mock.handle("GET", "/charges/ch_1/dispute");
        expect(after.status).toBe(200);
        const injected = (
          (after.body as Record<string, unknown>)
            .balance_transactions as unknown[]
        ).some(
          (row) =>
            typeof row === "object" &&
            row !== null &&
            (row as Record<string, unknown>).object === "dispute",
        );
        expect(injected).toBe(false);
      });
    }

    it("still injects the collection into a collection envelope that has an id", async () => {
      const item = {
        type: "object",
        properties: { id: { type: "integer" }, name: { type: "string" } },
      };
      const mock = await mockOf(
        spec({
          "/pets": {
            get: {
              responses: {
                "200": {
                  description: "list",
                  content: json({
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      data: { type: "array", items: item },
                    },
                  }),
                },
              },
            },
            post: {
              responses: { "201": { description: "c", content: json(item) } },
            },
          },
          "/pets/{id}": {
            get: {
              responses: { "200": { description: "p", content: json(item) } },
            },
          },
        }),
      );
      await mock.handle("POST", "/pets", { body: { name: "rex" } });
      const list = await mock.handle("GET", "/pets");
      expect((list.body as Record<string, unknown>).data).toEqual([
        { id: 1, name: "rex" },
      ]);
    });

    it("injects the collection into an envelope with an id when no item route exists", async () => {
      const item = {
        type: "object",
        properties: { id: { type: "integer" }, name: { type: "string" } },
      };
      const mock = await mockOf(
        spec({
          "/pets": {
            get: {
              responses: {
                "200": {
                  description: "list",
                  content: json({
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      data: { type: "array", items: item },
                    },
                  }),
                },
              },
            },
            post: {
              responses: { "201": { description: "c", content: json(item) } },
            },
          },
        }),
        { fakerSeed: 1 },
      );
      await mock.handle("POST", "/pets", { body: { name: "rex" } });
      const list = await mock.handle("GET", "/pets");
      expect((list.body as Record<string, unknown>).data).toEqual([
        { id: 1, name: "rex" },
      ]);
    });
  });

  describe("form bodies on CRUD create and update", () => {
    const formPet = {
      type: "object",
      required: ["id", "name", "age"],
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        age: { type: "integer" },
      },
    };
    const uploadPet = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
        photo: { type: "string", format: "binary" },
      },
    };
    const formSpec = spec({
      "/pets": {
        get: {
          responses: {
            "200": {
              description: "list",
              content: json({ type: "array", items: formPet }),
            },
          },
        },
        post: {
          requestBody: {
            content: {
              "multipart/form-data": { schema: uploadPet },
              "application/x-www-form-urlencoded": { schema: uploadPet },
            },
          },
          responses: { "201": { description: "c", content: json(formPet) } },
        },
      },
      "/pets/{petId}": {
        get: {
          responses: { "200": { description: "p", content: json(formPet) } },
        },
        put: {
          requestBody: {
            content: { "multipart/form-data": { schema: uploadPet } },
          },
          responses: { "200": { description: "p", content: json(formPet) } },
        },
        patch: {
          requestBody: {
            content: {
              "application/x-www-form-urlencoded": { schema: uploadPet },
            },
          },
          responses: { "200": { description: "p", content: json(formPet) } },
        },
      },
    });

    function multipart(fields: Record<string, string | Blob>): FormData {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) {
        form.append(name, value);
      }
      return form;
    }

    async function interceptedSend(
      mock: Schmock.CallableMockInstance,
      method: string,
      path: string,
      body: BodyInit,
    ): Promise<{ status: number; body: unknown }> {
      const handle = mock.intercept({ passthrough: false });
      try {
        const response = await fetch(`http://localhost${path}`, {
          method,
          body,
        });
        const text = await response.text();
        return {
          status: response.status,
          body: text ? JSON.parse(text) : undefined,
        };
      } finally {
        handle.restore();
      }
    }

    for (const validateRequests of [false, true]) {
      it(`stores the submitted multipart fields, typed, without the file (validateRequests: ${validateRequests})`, async () => {
        const mock = await mockOf(formSpec, {
          validateRequests,
          validateResponses: true,
        });

        const created = await mock.handle("POST", "/pets", {
          headers: { "content-type": "multipart/form-data; boundary=x" },
          body: multipart({
            name: "Rex",
            age: "3",
            photo: new Blob([new Uint8Array([1, 2, 3])]),
          }),
        });
        expect(created.status).toBe(201);
        expect(created.body).toEqual({ id: 1, name: "Rex", age: 3 });

        const replaced = await mock.handle("PUT", "/pets/1", {
          headers: { "content-type": "multipart/form-data; boundary=x" },
          body: multipart({ name: "Renamed" }),
        });
        expect(replaced.status).toBe(200);
        expect(replaced.body).toEqual({ id: 1, name: "Renamed", age: 3 });
      });
    }

    it("stores urlencoded fields as their declared types through fetch", async () => {
      const mock = await mockOf(formSpec, { validateResponses: true });

      const created = await interceptedSend(
        mock,
        "POST",
        "/pets",
        new URLSearchParams({ name: "Tom", age: "4" }),
      );
      expect(created).toEqual({
        status: 201,
        body: { id: 1, name: "Tom", age: 4 },
      });

      const patched = await interceptedSend(
        mock,
        "PATCH",
        "/pets/1",
        new URLSearchParams({ age: "5" }),
      );
      expect(patched).toEqual({
        status: 200,
        body: { id: 1, name: "Tom", age: 5 },
      });

      const read = await mock.handle("GET", "/pets/1");
      expect(read.body).toEqual({ id: 1, name: "Tom", age: 5 });
    });

    it("reads form fields by the request schema when validation is off", async () => {
      // The response contract does not declare `age`, the request schema does:
      // the field is coerced the way the request schema reads it.
      const loose = {
        type: "object",
        properties: { id: { type: "integer" }, name: { type: "string" } },
      };
      const mock = await mockOf(
        spec({
          "/pets": {
            get: {
              responses: {
                "200": {
                  description: "list",
                  content: json({ type: "array", items: loose }),
                },
              },
            },
            post: {
              requestBody: {
                content: {
                  "application/x-www-form-urlencoded": { schema: uploadPet },
                },
              },
              responses: { "201": { description: "c", content: json(loose) } },
            },
          },
        }),
      );
      const created = await mock.handle("POST", "/pets", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: { name: "Tom", age: "4" },
      });
      expect(created.body).toEqual({ id: 1, name: "Tom", age: 4 });
    });

    it("stores multipart fields sent through fetch", async () => {
      const mock = await mockOf(formSpec, { validateResponses: true });
      const created = await interceptedSend(
        mock,
        "POST",
        "/pets",
        multipart({
          name: "Rex",
          age: "3",
          photo: new Blob([new Uint8Array([1, 2, 3])]),
        }),
      );
      expect(created).toEqual({
        status: 201,
        body: { id: 1, name: "Rex", age: 3 },
      });
    });

    for (const validateRequests of [false, true]) {
      it(`stores the body a plugin piped later rewrote, read by the request schema (validateRequests: ${validateRequests})`, async () => {
        const mock = await mockOf(formSpec, { validateRequests });
        const rewrite: Schmock.Plugin = {
          name: "rewrite-body",
          beforeRequest(context) {
            const replacement = context.method === "POST" ? "Renamed" : "Max";
            return {
              context: { ...context, body: { name: replacement, age: "7" } },
            };
          },
          process(context, response) {
            return { context, response };
          },
        };
        mock.pipe(rewrite);
        const form = { "content-type": "application/x-www-form-urlencoded" };

        const created = await mock.handle("POST", "/pets", {
          headers: form,
          body: { name: "Tom", age: "4" },
        });
        expect(created.body).toEqual({ id: 1, name: "Renamed", age: 7 });

        const patched = await mock.handle("PATCH", "/pets/1", {
          headers: form,
          body: { name: "Tom" },
        });
        expect(patched.body).toEqual({ id: 1, name: "Max", age: 7 });
        const read = await mock.handle("GET", "/pets/1");
        expect(read.body).toEqual({ id: 1, name: "Max", age: 7 });
      });
    }
  });
});

describe("resource list overrides under validateResponses", () => {
  const user = {
    type: "object",
    required: ["id", "name"],
    properties: { id: { type: "integer" }, name: { type: "string" } },
  };
  const post = {
    type: "object",
    required: ["id", "title"],
    properties: { id: { type: "integer" }, title: { type: "string" } },
  };
  const overrideSpec = spec({
    "/users": {
      get: {
        responses: {
          "200": {
            description: "list",
            content: json({ type: "array", items: user }),
          },
        },
      },
      post: {
        responses: { "201": { description: "c", content: json(user) } },
      },
    },
    "/users/{id}": {
      get: {
        responses: { "200": { description: "u", content: json(user) } },
      },
    },
    "/posts": {
      get: {
        responses: {
          "200": {
            description: "list",
            content: json({
              type: "object",
              required: ["items", "total"],
              properties: {
                items: { type: "array", items: post },
                total: { type: "integer" },
              },
            }),
          },
        },
      },
      post: {
        responses: { "201": { description: "c", content: json(post) } },
      },
    },
    "/posts/{id}": {
      get: {
        responses: { "200": { description: "p", content: json(post) } },
      },
    },
  });

  it("validates the shape listWrapProperty and listFlat serve", async () => {
    const mock = await mockOf(overrideSpec, {
      validateResponses: true,
      resources: {
        users: { listWrapProperty: "data" },
        posts: { listFlat: true },
      },
    });
    await mock.handle("POST", "/users", { body: { name: "A" } });
    await mock.handle("POST", "/posts", { body: { title: "P" } });

    const users = await mock.handle("GET", "/users");
    expect(users.status).toBe(200);
    expect(users.body).toEqual({ data: [{ id: 1, name: "A" }] });

    const posts = await mock.handle("GET", "/posts");
    expect(posts.status).toBe(200);
    expect(posts.body).toEqual([{ id: 1, title: "P" }]);
  });

  it.each([
    ["2XX", { listFlat: true }, [{ id: 1, name: "A" }]],
    ["default", { listFlat: true }, [{ id: 1, name: "A" }]],
    ["2XX", { listWrapProperty: "items" }, { items: [{ id: 1, name: "A" }] }],
  ] as const)(
    "keeps the media types of a list declared under %s when %o reshapes it",
    async (statusKey, override, expected) => {
      const sharedSpec = spec({
        "/users": {
          get: {
            responses: {
              [statusKey]: {
                description: "list",
                content: json({
                  type: "object",
                  properties: { data: { type: "array", items: user } },
                }),
              },
            },
          },
          post: {
            responses: { "201": { description: "c", content: json(user) } },
          },
        },
        "/users/{id}": {
          get: {
            responses: { "200": { description: "u", content: json(user) } },
          },
        },
      });
      const mock = await mockOf(sharedSpec, {
        validateResponses: true,
        seed: { users: [{ id: 1, name: "A" }] },
        resources: { users: override },
      });

      const list = await mock.handle("GET", "/users");
      expect(list.status).toBe(200);
      expect(list.headers["content-type"]).toBe("application/json");
      expect(list.body).toEqual(expected);

      const xml = await mock.handle("GET", "/users", {
        headers: { accept: "application/xml" },
      });
      expect(xml.status).toBe(406);
    },
  );

  it.each<[string, Schmock.ResourceOverride]>([
    ["listFlat: false", { listFlat: false }],
    ['listWrapProperty: ""', { listWrapProperty: "" }],
  ])(
    "keeps a list's per-media-type contracts under %s",
    async (_label, override) => {
      const negotiatedSpec = spec({
        "/users": {
          get: {
            responses: {
              "200": {
                description: "list",
                content: {
                  ...json({ type: "array", items: user }),
                  "application/vnd.page+json": {
                    schema: {
                      type: "object",
                      required: ["items"],
                      properties: {
                        items: { type: "array", items: user },
                        total: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
          post: {
            responses: { "201": { description: "c", content: json(user) } },
          },
        },
        "/users/{id}": {
          get: {
            responses: { "200": { description: "u", content: json(user) } },
          },
        },
      });
      const mock = await mockOf(negotiatedSpec, {
        validateResponses: true,
        seed: { users: [{ id: 1, name: "A" }] },
        resources: { users: override },
      });

      const page = await mock.handle("GET", "/users", {
        headers: { accept: "application/vnd.page+json" },
      });
      expect(page.status).toBe(200);
      expect(page.headers["content-type"]).toBe("application/vnd.page+json");
      expect(page.body).toMatchObject({ items: [{ id: 1, name: "A" }] });

      const flat = await mock.handle("GET", "/users", {
        headers: { accept: "application/json" },
      });
      expect(flat.status).toBe(200);
      expect(flat.body).toEqual([{ id: 1, name: "A" }]);
    },
  );

  it("still checks the overridden list's items against the item contract", async () => {
    const mock = schmock({
      state: { "openapi:collections:/users": [{ id: 1 }] },
    });
    mock.pipe(
      await openapi({
        spec: overrideSpec,
        validateResponses: true,
        resources: { users: { listWrapProperty: "data" } },
      }),
    );
    const users = await mock.handle("GET", "/users");
    expect(users.status).toBe(500);
    expect(users.body).toMatchObject({ code: "RESPONSE_VALIDATION_ERROR" });
  });
});

describe("status-less schema overrides on a POST declaring 200 and 201", () => {
  const item = {
    type: "object",
    properties: { id: { type: "integer" }, old: { type: "string" } },
  };
  const patched: JSONSchema7 = {
    type: "object",
    required: ["patched"],
    properties: {
      id: { type: "integer" },
      patched: { type: "boolean", const: true },
    },
  };
  const both = {
    "200": { description: "existing", content: json(item) },
    "201": { description: "created", content: json(item) },
  };
  const upsertSpec = spec({
    "/upserts": {
      get: {
        responses: {
          "200": {
            description: "list",
            content: json({ type: "array", items: item }),
          },
        },
      },
      post: { responses: both },
    },
    "/upserts/{id}": {
      get: { responses: { "200": { description: "i", content: json(item) } } },
    },
    "/login": { post: { responses: both } },
  });

  it("patches the 201 a CRUD create answers with", async () => {
    const mock = await mockOf(upsertSpec, {
      schemas: { "POST /upserts": patched },
    });
    const created = await mock.handle("POST", "/upserts");
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ patched: true });
  });

  it("patches the 200 a non-CRUD POST answers with", async () => {
    const mock = await mockOf(upsertSpec, {
      schemas: { "POST /login": patched },
    });
    const response = await mock.handle("POST", "/login");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ patched: true });
  });
});

describe("asSchemaGenerationError", () => {
  it("describes a non-Error throw and keeps it as the cause", () => {
    const thrown = { reason: "faker gave up" };
    const error = asSchemaGenerationError(thrown, "GET /things");
    expect(error).toBeInstanceOf(SchemaGenerationError);
    expect(error.message).toBe(
      'Schema generation failed for route GET /things: {"reason":"faker gave up"}',
    );
    const context = (error as SchemaGenerationError).context as {
      originalError: Error;
    };
    expect(context.originalError.cause).toBe(thrown);
  });

  it("keeps an Error as the original error", () => {
    const thrown = new Error("boom");
    const error = asSchemaGenerationError(thrown, "GET /things");
    const context = (error as SchemaGenerationError).context as {
      originalError: Error;
    };
    expect(context.originalError).toBe(thrown);
  });
});

describe("settling a request once its response is final (#39)", () => {
  const openPet = {
    type: "object",
    properties: { id: { type: "integer" }, name: { type: "string" } },
  };
  const hook = (url: string) => ({
    notify: {
      [url]: { post: { responses: { "200": { description: "ok" } } } },
    },
  });
  const petsSpec = spec({
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "list",
            content: json({ type: "array", items: openPet }),
          },
        },
      },
      post: {
        responses: { "201": { description: "c", content: json(openPet) } },
        callbacks: hook("https://hooks.example/created"),
      },
    },
    "/pets/{petId}": {
      get: {
        responses: { "200": { description: "p", content: json(openPet) } },
      },
      patch: {
        responses: { "200": { description: "p", content: json(openPet) } },
      },
      delete: {
        responses: { "204": { description: "gone" } },
      },
    },
  });

  const failingPlugin = (
    name: string,
    fail: () => unknown,
  ): Schmock.Plugin => ({
    name,
    process(context) {
      return { context, response: fail() };
    },
  });

  async function pipedMock(
    options: Partial<Schmock.OpenApiOptions> = {},
    after?: Schmock.Plugin,
    config: Schmock.GlobalConfig = {},
  ) {
    const urls: string[] = [];
    const mock = schmock({ state: {}, ...config });
    mock.pipe(
      await openapi({
        spec: petsSpec,
        callbacks: {
          dispatch: (request) => {
            urls.push(request.url);
          },
        },
        ...options,
      }),
    );
    if (after) mock.pipe(after);
    return { mock, urls };
  }

  function stored(mock: Schmock.CallableMockInstance): unknown {
    return mock.getState()["openapi:collections:/pets"] ?? [];
  }

  it("stores nothing, and notifies no one, when a later plugin answers 500", async () => {
    const { mock, urls } = await pipedMock(
      {},
      failingPlugin("downstream-500", () => [500, { error: "downstream" }]),
    );

    const created = await mock.handle("POST", "/pets", {
      body: { name: "rex" },
    });
    expect(created.status).toBe(500);
    expect(stored(mock)).toEqual([]);
    expect(urls).toEqual([]);
  });

  it("stores nothing when a later plugin throws", async () => {
    const { mock, urls } = await pipedMock(
      {},
      failingPlugin("downstream-throw", () => {
        throw new Error("boom");
      }),
    );

    const created = await mock.handle("POST", "/pets", {
      body: { name: "rex" },
    });
    expect(created.status).toBe(500);
    expect(stored(mock)).toEqual([]);
    expect(urls).toEqual([]);
  });

  it("keeps a row a later 500 would have kept out of an update and a delete", async () => {
    let fail = false;
    const { mock } = await pipedMock(
      {},
      {
        name: "toggle",
        process(context, response) {
          return {
            context,
            response: fail ? [500, { error: "downstream" }] : response,
          };
        },
      },
    );
    await mock.handle("POST", "/pets", { body: { name: "rex" } });
    fail = true;
    await mock.handle("PATCH", "/pets/1", { body: { name: "max" } });
    await mock.handle("DELETE", "/pets/1");
    expect(stored(mock)).toEqual([{ id: 1, name: "rex" }]);
  });

  it("stores nothing for a request aborted during its delay", async () => {
    const { mock, urls } = await pipedMock({}, undefined, { delay: 1_000 });
    const controller = new AbortController();

    const pending = mock.handle("POST", "/pets", {
      body: { name: "rex" },
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stored(mock)).toEqual([]);
    expect(urls).toEqual([]);
  });

  it("commits before the callbacks, so a dispatcher that reads the mock sees the row", async () => {
    let seen: unknown;
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: petsSpec,
        callbacks: {
          dispatch: async () => {
            seen = (await mock.handle("GET", "/pets/1")).body;
          },
        },
      }),
    );

    await mock.handle("POST", "/pets", { body: { name: "rex" } });
    expect(seen).toEqual({ id: 1, name: "rex" });
  });

  it("stops delivering once the request is aborted during a pending dispatcher", async () => {
    const twoHooks = spec({
      "/pets": {
        get: {
          responses: {
            "200": {
              description: "list",
              content: json({ type: "array", items: openPet }),
            },
          },
        },
        post: {
          responses: { "201": { description: "c", content: json(openPet) } },
          callbacks: {
            ...hook("https://hooks.example/first"),
            second: hook("https://hooks.example/second").notify,
          },
        },
      },
    });
    let started: () => void = () => {};
    const dispatchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => {};
    const urls: string[] = [];
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: twoHooks,
        callbacks: {
          dispatch: (request) => {
            urls.push(request.url);
            started();
            return new Promise<void>((resolve) => {
              release = resolve;
            });
          },
        },
      }),
    );
    const controller = new AbortController();

    const pending = mock.handle("POST", "/pets", {
      body: { name: "rex" },
      signal: controller.signal,
    });
    await dispatchStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(urls).toEqual(["https://hooks.example/first"]);
  });

  it("answers each of two concurrent PATCHes with its own merge and stores both", async () => {
    const mock = schmock({
      state: { "openapi:collections:/pets": [{ id: 1, name: "rex" }] },
      delay: 20,
    });
    mock.pipe(await openapi({ spec: petsSpec }));

    const [a, b] = await Promise.all([
      mock.handle("PATCH", "/pets/1", { body: { tag: "new" } }),
      mock.handle("PATCH", "/pets/1", { body: { age: 9 } }),
    ]);
    expect(a.body).toEqual({ id: 1, name: "rex", tag: "new" });
    expect(b.body).toEqual({ id: 1, name: "rex", age: 9 });
    expect(stored(mock)).toEqual([{ id: 1, name: "rex", tag: "new", age: 9 }]);
  });

  it("fires no callback when a plugin piped earlier answers in beforeRequest", async () => {
    const urls: string[] = [];
    const mock = schmock({ state: {} });
    mock.pipe({
      name: "stub",
      beforeRequest(context) {
        return { context, response: [200, { stubbed: true }] };
      },
      process(context, response) {
        return { context, response };
      },
    });
    mock.pipe(
      await openapi({
        spec: petsSpec,
        callbacks: { dispatch: (request) => void urls.push(request.url) },
      }),
    );

    const answered = await mock.handle("POST", "/pets", {
      body: { name: "rex" },
    });
    expect(answered).toMatchObject({ status: 200, body: { stubbed: true } });
    expect(urls).toEqual([]);
    expect(stored(mock)).toEqual([]);
  });

  it("commits nothing and fires no callback when onError recovers a failed operation", async () => {
    const urls: string[] = [];
    const envelopeSpec = spec({
      "/pets": {
        get: {
          responses: {
            "200": {
              description: "list",
              content: json({ type: "array", items: openPet }),
            },
          },
        },
      },
      "/pets/{petId}": {
        get: {
          responses: { "200": { description: "p", content: json(openPet) } },
        },
        patch: {
          responses: {
            "200": {
              description: "p",
              content: json({ type: "object", properties: { data: openPet } }),
            },
          },
          callbacks: hook("https://hooks.example/updated"),
        },
      },
    });
    const mock = schmock({
      state: { "openapi:collections:/pets": [{ id: 1, name: "rex" }] },
    });
    mock.pipe(
      await openapi({
        spec: envelopeSpec,
        callbacks: { dispatch: (request) => void urls.push(request.url) },
        // Throws while the PATCH builds its envelope, after it staged the write.
        onSchema: (schema, { method }) => {
          if (method === "PATCH") throw new Error("hook failed");
          return schema;
        },
      }),
    );
    mock.pipe({
      name: "recover",
      process(context, response) {
        return { context, response };
      },
      onError() {
        return { status: 200, body: { recovered: true } };
      },
    });

    const answered = await mock.handle("PATCH", "/pets/1", {
      body: { name: "max" },
    });
    expect(answered).toMatchObject({ status: 200, body: { recovered: true } });
    expect(urls).toEqual([]);
    expect(stored(mock)).toEqual([{ id: 1, name: "rex" }]);
  });

  it("commits nothing when a later plugin throws and its onError recovers", async () => {
    const { mock, urls } = await pipedMock(
      {},
      {
        name: "throw-and-recover",
        process() {
          throw new Error("downstream failed");
        },
        onError() {
          return [200, { recovered: true }];
        },
      },
    );

    const answered = await mock.handle("POST", "/pets", {
      body: { name: "rex" },
    });
    expect(answered).toMatchObject({ status: 200, body: { recovered: true } });
    expect(urls).toEqual([]);
    expect(stored(mock)).toEqual([]);
  });

  it("commits nothing when openapi's own Prefer step throws and onError recovers", async () => {
    const urls: string[] = [];
    const preferSpec = spec({
      "/pets": {
        get: {
          responses: {
            "200": {
              description: "list",
              content: json({ type: "array", items: openPet }),
            },
          },
        },
        post: {
          responses: {
            "201": { description: "c", content: json(openPet) },
            "400": {
              description: "bad",
              content: json({
                type: "object",
                properties: { err: { type: "string" } },
              }),
            },
          },
          callbacks: hook("https://hooks.example/created"),
        },
      },
      "/pets/{petId}": {
        get: {
          responses: { "200": { description: "p", content: json(openPet) } },
        },
      },
    });
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: preferSpec,
        callbacks: { dispatch: (request) => void urls.push(request.url) },
        // Throws only for the 400 body `Prefer: code=400` asks for, after the
        // create generator staged its write.
        onSchema: (schema) => {
          if (schema.properties?.err) throw new Error("hook failed");
          return schema;
        },
      }),
    );
    mock.pipe({
      name: "recover",
      process(context, response) {
        return { context, response };
      },
      onError() {
        return { status: 201, body: { recovered: true } };
      },
    });

    const answered = await mock.handle("POST", "/pets", {
      body: { name: "rex" },
      headers: { prefer: "code=400" },
    });
    expect(answered).toMatchObject({ status: 201, body: { recovered: true } });
    expect(urls).toEqual([]);
    expect(stored(mock)).toEqual([]);
  });
});

describe("the errorSchema resource override", () => {
  const user = {
    type: "object",
    required: ["id", "name"],
    properties: { id: { type: "integer" }, name: { type: "string" } },
  };
  const errorSchema: JSONSchema7 = {
    type: "object",
    required: ["message"],
    properties: { message: { type: "string", const: "OVERRIDE" } },
  };
  const usersSpec = spec({
    "/users": {
      get: {
        responses: {
          "200": {
            description: "list",
            content: json({ type: "array", items: user }),
          },
        },
      },
      post: {
        requestBody: { required: true, content: json(user) },
        responses: { "201": { description: "c", content: json(user) } },
      },
    },
    "/users/{id}": {
      get: {
        responses: { "200": { description: "u", content: json(user) } },
      },
      put: {
        requestBody: { required: true, content: json(user) },
        responses: { "200": { description: "u", content: json(user) } },
      },
      delete: { responses: { "204": { description: "gone" } } },
    },
  });

  it("covers only the 404 CRUD generates for a missing item", async () => {
    const parsed = await parseSpec(usersSpec);
    const [resource] = detectCrudResources(parsed.paths).resources;

    applyOverrides(resource, { errorSchema });

    const itemRoutes = resource.routes.filter(
      (route) =>
        route.op === "read" || route.op === "update" || route.op === "delete",
    );
    expect(itemRoutes).toHaveLength(3);
    for (const route of itemRoutes) {
      expect([...(route.meta.errorSchemas?.keys() ?? [])]).toEqual([404]);
      expect(route.meta.errorSchemas?.get(404)).toBe(errorSchema);
    }
  });

  it("shapes the 404 bodies and leaves request-validation 400s alone", async () => {
    const mock = await mockOf(usersSpec, {
      validateRequests: true,
      resources: { users: { errorSchema } },
    });

    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", { id: 999, name: "Ghost" }],
      ["DELETE", undefined],
    ] as const) {
      const missing = await mock.handle(method, "/users/999", { body });
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ message: "OVERRIDE" });
    }

    const invalid = await mock.handle("POST", "/users", {
      body: { id: 1, name: 5 },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: "VALIDATION_ERROR" });

    const first = await mock.handle("POST", "/users", {
      body: { id: 1, name: "A" },
    });
    const duplicate = await mock.handle("POST", "/users", {
      body: { id: 1, name: "B" },
    });
    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(201);
    expect(duplicate.body).toMatchObject({ id: 2, name: "B" });
  });
});

describe("the errorSchema override under validateResponses", () => {
  const user = {
    type: "object",
    required: ["id", "name"],
    properties: { id: { type: "integer" }, name: { type: "string" } },
  };
  const specError = {
    type: "object",
    required: ["message"],
    properties: { message: { type: "string" } },
    additionalProperties: false,
  };
  const errorSchema: JSONSchema7 = {
    type: "object",
    required: ["error"],
    properties: { error: { type: "string", const: "OVERRIDE" } },
  };
  const usersSpec = (errorKey: string) =>
    spec({
      "/users": {
        get: {
          responses: {
            "200": {
              description: "list",
              content: json({ type: "array", items: user }),
            },
          },
        },
        post: {
          responses: { "201": { description: "c", content: json(user) } },
        },
      },
      "/users/{id}": {
        get: {
          responses: {
            "200": { description: "u", content: json(user) },
            [errorKey]: { description: "nf", content: json(specError) },
          },
        },
        delete: {
          responses: {
            "204": { description: "gone" },
            [errorKey]: { description: "nf", content: json(specError) },
          },
        },
      },
    });

  it.each(["404", "4XX", "default"])(
    "validates a missing item's 404 against the override (spec declares %s)",
    async (errorKey) => {
      const mock = await mockOf(usersSpec(errorKey), {
        validateResponses: true,
        resources: { users: { errorSchema } },
      });

      for (const method of ["GET", "DELETE"] as const) {
        const missing = await mock.handle(method, "/users/99");
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ error: "OVERRIDE" });
        expect(missing.headers["content-type"]).toBe("application/json");
      }
    },
  );
});

describe("a 3.1 contract closed with unevaluatedProperties (hunt openapi-1-G18)", () => {
  const petRef = { $ref: "#/components/schemas/Pet" };
  const closedSpec = {
    openapi: "3.1.0",
    info: { title: "Closed by unevaluatedProperties", version: "1.0.0" },
    components: {
      schemas: {
        Base: {
          type: "object",
          properties: { id: { type: "integer", readOnly: true } },
        },
        Pet: {
          allOf: [
            { $ref: "#/components/schemas/Base" },
            {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string" } },
            },
          ],
          unevaluatedProperties: false,
        },
      },
    },
    paths: {
      "/pets": {
        get: {
          responses: {
            "200": {
              description: "list",
              content: json({ type: "array", items: petRef }),
            },
          },
        },
        post: {
          requestBody: { content: json(petRef) },
          responses: { "201": { description: "c", content: json(petRef) } },
        },
      },
      "/pets/{petId}": {
        parameters: [
          {
            name: "petId",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        get: {
          responses: { "200": { description: "p", content: json(petRef) } },
        },
        delete: {
          responses: { "200": { description: "d", content: json(petRef) } },
        },
      },
    },
  };

  it("drops an undeclared request field from the created and stored row", async () => {
    const mock = await mockOf(closedSpec, {
      validateRequests: false,
      validateResponses: true,
    });

    const created = await mock.handle("POST", "/pets", {
      body: { name: "rex", extra: 1 },
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: 1, name: "rex" });

    const list = await mock.handle("GET", "/pets");
    expect(list.body).toEqual([{ id: 1, name: "rex" }]);
  });

  it("does not count a row with an undeclared field as the delete contract", async () => {
    const mock = await mockOf(closedSpec, {
      seed: { pets: [{ id: 1, name: "rex", extra: 1 }] },
    });

    const deleted = await mock.handle("DELETE", "/pets/1");
    expect(deleted.status).toBe(200);
    expect(Object(deleted.body)).not.toHaveProperty("extra");
    expect(Object(deleted.body).name).toBe("rex");
  });
});

describe("a typed nullable create contract (hunt openapi-1-G16)", () => {
  const nullablePet = {
    type: "object",
    nullable: true,
    required: ["id", "name", "createdAt"],
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      createdAt: { type: "string", format: "date-time", readOnly: true },
    },
  };
  const petsSpec = spec({
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "list",
            content: json({ type: "array", items: nullablePet }),
          },
        },
      },
      post: {
        requestBody: { content: json(nullablePet) },
        responses: {
          "201": { description: "created", content: json(nullablePet) },
        },
      },
    },
    "/pets/{id}": {
      get: {
        responses: {
          "200": { description: "pet", content: json(nullablePet) },
        },
      },
    },
  });

  it("always generates the base, so the readOnly createdAt is never dropped", async () => {
    const mock = await mockOf(petsSpec, { validateResponses: true });

    // Faker rolls a nullable node to null ~5% of the time, so 200 unseeded
    // creates reach that roll with near certainty.
    const outcomes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const created = await mock.handle("POST", "/pets", {
        body: { name: "rex" },
      });
      const body = Object(created.body);
      outcomes.add(
        created.status !== 201
          ? `status ${created.status}`
          : Object.hasOwn(body, "createdAt")
            ? "complete"
            : "no createdAt",
      );
    }
    expect([...outcomes]).toEqual(["complete"]);
  });
});

describe("count seeding on an id named __proto__ (hunt openapi-1-G38)", () => {
  // Built from JSON so `__proto__` is an OWN key, as a parsed spec file has it.
  const protoPet = JSON.parse(`{
    "type": "object",
    "required": ["__proto__", "name"],
    "properties": {
      "__proto__": { "type": "integer" },
      "name": { "type": "string" }
    }
  }`);
  const protoSpec = spec({
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "list",
            content: json({ type: "array", items: protoPet }),
          },
        },
      },
      post: {
        requestBody: { content: json(protoPet) },
        responses: { "201": { description: "c", content: json(protoPet) } },
      },
    },
    "/pets/{__proto__}": {
      parameters: [
        {
          name: "__proto__",
          in: "path",
          required: true,
          schema: { type: "integer" },
        },
      ],
      get: {
        responses: { "200": { description: "p", content: json(protoPet) } },
      },
    },
  });

  it("writes each generated id as an own property and resumes the counter past it", async () => {
    const mock = await mockOf(protoSpec, {
      seed: { pets: { count: 2 } },
      fakerSeed: 1,
    });

    const list = await mock.handle("GET", "/pets");
    const rows: unknown[] = Array.isArray(list.body) ? list.body : [];
    const ids = rows.map(
      (row) => Object.getOwnPropertyDescriptor(Object(row), "__proto__")?.value,
    );
    expect(ids).toEqual([1, 2]);
    expect((await mock.handle("GET", "/pets/1")).status).toBe(200);

    const created = await mock.handle("POST", "/pets", {
      body: { name: "c" },
    });
    expect(
      Object.getOwnPropertyDescriptor(created.body, "__proto__")?.value,
    ).toBe(3);
    expect((await mock.handle("GET", "/pets/3")).status).toBe(200);
  });
});

describe("minting ids past seeds the counter cannot continue", () => {
  const usersSpec = (id: JSONSchema7) => {
    const userSchema = {
      type: "object",
      properties: { id, name: { type: "string" } },
    };
    return spec({
      "/users": {
        get: {
          responses: {
            "200": {
              description: "list",
              content: json({ type: "array", items: userSchema }),
            },
          },
        },
        post: {
          requestBody: { content: json(userSchema) },
          responses: { "201": { description: "c", content: json(userSchema) } },
        },
      },
      "/users/{id}": {
        get: {
          parameters: [{ name: "id", in: "path", required: true, schema: id }],
          responses: { "200": { description: "u", content: json(userSchema) } },
        },
      },
    });
  };

  async function createIds(
    mock: Schmock.CallableMockInstance,
    count: number,
  ): Promise<unknown[]> {
    const ids: unknown[] = [];
    for (let index = 0; index < count; index += 1) {
      const created = await mock.handle("POST", "/users", {
        body: { name: `n${index}` },
      });
      expect(created.status).toBe(201);
      ids.push((created.body as { id: unknown }).id);
    }
    return ids;
  }

  it("mints distinct ids after a string id past Number.MAX_SAFE_INTEGER", async () => {
    const seededId = "175928847299117063";
    const mock = await mockOf(usersSpec({ type: "string" }), {
      seed: { users: [{ id: seededId, name: "seed" }] },
    });

    const ids = await createIds(mock, 3);
    expect(new Set([seededId, ...ids]).size).toBe(4);
  });

  it("does not mint an integer seed at 2^53 again", async () => {
    const seededId = 2 ** 53;
    const mock = await mockOf(usersSpec({ type: "integer", format: "int64" }), {
      seed: { users: [{ id: seededId, name: "seed" }] },
    });

    const ids = await createIds(mock, 2);
    expect(new Set([seededId, ...ids]).size).toBe(3);
  });

  it("refuses to mint an id the counter can no longer represent", async () => {
    const mock = await mockOf(usersSpec({ type: "integer" }), {
      seed: {
        users: [{ id: Number.MAX_SAFE_INTEGER - 1, name: "seed" }],
      },
    });

    const [last] = await createIds(mock, 1);
    expect(last).toBe(Number.MAX_SAFE_INTEGER);
    const exhausted = await mock.handle("POST", "/users", {
      body: { name: "over" },
    });
    expect(exhausted.status).toBe(500);
    const list = await mock.handle("GET", "/users");
    expect((list.body as unknown[]).length).toBe(2);
  });

  it("mints whole ids after a fractional integer seed", async () => {
    // A fractional id is no counter the scheme minted: resuming from it
    // minted 3.5, 4.5, … for an integer id.
    const mock = await mockOf(usersSpec({ type: "integer" }), {
      seed: { users: [{ id: 2.5, name: "seed" }] },
    });

    const ids = await createIds(mock, 2);
    expect(ids).toEqual([1, 2]);
  });

  it("keeps a synthetic uuid valid after a seed at the top node", async () => {
    const seededId = "00000000-0000-4000-8000-999999999999";
    const mock = await mockOf(usersSpec({ type: "string", format: "uuid" }), {
      validateResponses: true,
      seed: { users: [{ id: seededId, name: "seed" }] },
    });

    const ids = await createIds(mock, 2);
    expect(new Set([seededId, ...ids]).size).toBe(3);
  });
});
