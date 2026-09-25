/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { openapi } from "./plugin";

/**
 * OpenAPI-level regressions for the faker-mapping review findings: the
 * generator runs through @schmock/faker, so these pin what a spec author sees.
 */

function spec(version: string, schema: Record<string, unknown>) {
  return {
    openapi: version,
    info: { title: "Review", version: "1.0.0" },
    paths: {
      "/report": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema } },
            },
          },
        },
      },
    },
  };
}

async function fetchReport(
  document: object,
  fakerSeed?: number,
): Promise<unknown> {
  const mock = schmock({ state: {} });
  mock.pipe(await openapi({ spec: document, fakerSeed }));
  const response = await mock.handle("GET", "/report");
  expect(response.status).toBe(200);
  return response.body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("OpenAPI examples beat field-name heuristics (#20)", () => {
  it("returns property examples verbatim", async () => {
    const document = spec("3.0.3", {
      type: "object",
      properties: {
        status: { type: "string", example: "active" },
        active: { type: "boolean", example: false },
        count: { type: "integer", example: 3 },
        version: { type: "string", example: "v1" },
      },
      required: ["status", "active", "count", "version"],
    });
    for (let seed = 1; seed <= 10; seed++) {
      expect(await fetchReport(document, seed)).toEqual({
        status: "active",
        active: false,
        count: 3,
        version: "v1",
      });
    }
  });
});

describe("OpenAPI 3.1 nullable unions (#18, #70)", () => {
  it("nulls a native `type: [T, null]` field about as often as 3.0 nullable", async () => {
    const body = await fetchReport(
      spec("3.1.0", {
        type: "array",
        minItems: 200,
        maxItems: 200,
        items: {
          type: "object",
          properties: {
            nick: { type: ["string", "null"] },
            version: { type: ["integer", "null"] },
          },
          required: ["nick", "version"],
        },
      }),
      11,
    );
    if (!Array.isArray(body)) throw new Error("expected an array body");
    const items = body.filter(isRecord);
    expect(items).toHaveLength(200);
    expect(items.filter((item) => item.nick === null).length).toBeLessThan(40);
    for (const item of items) {
      if (item.version !== null)
        expect(Number.isInteger(item.version)).toBe(true);
    }
  });

  it("keeps nested data behind a nullable oneOf reference most of the time", async () => {
    const document = {
      ...spec("3.1.0", {
        type: "array",
        minItems: 200,
        maxItems: 200,
        items: {
          type: "object",
          properties: {
            owner: {
              oneOf: [{ $ref: "#/components/schemas/Owner" }, { type: "null" }],
            },
          },
          required: ["owner"],
        },
      }),
      components: {
        schemas: {
          Owner: {
            type: "object",
            properties: { email: { type: "string" } },
            required: ["email"],
          },
        },
      },
    };
    const body = await fetchReport(document, 5);
    if (!Array.isArray(body)) throw new Error("expected an array body");
    const owners = body.filter(isRecord).map((item) => item.owner);
    expect(owners.filter((owner) => owner === null).length).toBeLessThan(40);
    for (const owner of owners) {
      if (owner !== null && isRecord(owner)) {
        expect(owner.email).toMatch(/@/);
      }
    }
  });
});

describe("allOf compositions keep boolean weighting (#23)", () => {
  it("weights isDeleted inside an allOf of a $ref base", async () => {
    const document = {
      ...spec("3.0.3", {
        type: "array",
        minItems: 300,
        maxItems: 300,
        items: {
          allOf: [
            { $ref: "#/components/schemas/Base" },
            { type: "object", properties: { id: { type: "integer" } } },
          ],
        },
      }),
      components: {
        schemas: {
          Base: {
            type: "object",
            properties: { isDeleted: { type: "boolean" } },
            required: ["isDeleted"],
          },
        },
      },
    };
    const body = await fetchReport(document, 9);
    if (!Array.isArray(body)) throw new Error("expected an array body");
    const trues = body.filter(
      (item) => isRecord(item) && item.isDeleted === true,
    ).length;
    expect(trues / body.length).toBeLessThan(0.2);
  });
});
