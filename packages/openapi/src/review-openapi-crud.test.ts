/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { collectSchemaProperties } from "./generators.js";
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
      const declared = collectSchemaProperties({
        properties: {
          id: { type: "integer" },
          constructor: { type: "string" },
          toString: { type: "string" },
        },
      });
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
  const patched = {
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
