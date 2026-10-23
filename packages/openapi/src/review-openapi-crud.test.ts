/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
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
});
