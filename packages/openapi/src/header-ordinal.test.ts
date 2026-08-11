import { schmock } from "@schmock/core";
import { generateFromSchema } from "@schmock/faker";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openapi } from "./plugin.js";
import { isRecord } from "./utils.js";

vi.mock("@schmock/faker", () => ({
  generateFromSchema: vi.fn(),
}));

const generateFromSchemaMock = vi.mocked(generateFromSchema);

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolver: (() => void) | undefined;
  return {
    promise: new Promise<void>((resolve) => {
      resolver = resolve;
    }),
    resolve: () => resolver?.(),
  };
}

interface GenerationGate {
  entered: Deferred;
  blocked: Deferred;
}

function createGate(): GenerationGate {
  return { entered: deferred(), blocked: deferred() };
}

let gate = createGate();

function schemaPropertyConst(schema: unknown, property: string): unknown {
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
  const definition = schema.properties[property];
  return isRecord(definition) ? definition.const : undefined;
}

const itemSchema = {
  type: "object",
  properties: {
    itemId: { type: "integer" },
    kind: { type: "string", const: "slow" },
  },
  required: ["itemId", "kind"],
};

const requestIdHeader = {
  "X-Request-Id": {
    schema: { type: "string", format: "uuid" },
  },
};

const spec = {
  openapi: "3.0.3",
  info: { title: "Header order", version: "1.0.0" },
  paths: {
    "/items": {
      get: {
        responses: {
          "200": {
            description: "List",
            headers: requestIdHeader,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: itemSchema },
                    kind: { type: "string", const: "wrapped" },
                  },
                  required: ["data", "kind"],
                },
              },
            },
          },
        },
      },
      post: {
        responses: {
          "201": {
            description: "Created",
            headers: requestIdHeader,
            content: { "application/json": { schema: itemSchema } },
          },
        },
      },
    },
    "/items/{itemId}": {
      get: {
        responses: {
          "200": {
            description: "Item",
            content: { "application/json": { schema: itemSchema } },
          },
        },
      },
    },
    "/health": {
      get: {
        responses: {
          "200": {
            description: "OK",
            headers: requestIdHeader,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    kind: { type: "string", const: "fast" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

async function createMock(seed: number): Promise<Schmock.CallableMockInstance> {
  const mock = schmock({ state: {} });
  mock.pipe(await openapi({ spec, fakerSeed: seed }));
  return mock;
}

async function concurrentRequestIds(seed: number): Promise<string[]> {
  gate = createGate();
  const mock = await createMock(seed);
  const create = mock.handle("POST", "/items", { body: {} });
  await gate.entered.promise;
  const health = await mock.handle("GET", "/health");
  gate.blocked.resolve();
  const created = await create;
  return [created.headers["X-Request-Id"], health.headers["X-Request-Id"]];
}

describe("seeded response header request ordinals", () => {
  beforeEach(() => {
    generateFromSchemaMock.mockReset();
    generateFromSchemaMock.mockImplementation(async ({ schema }) => {
      const kind = schemaPropertyConst(schema, "kind");
      if (kind === "slow") {
        gate.entered.resolve();
        await gate.blocked.promise;
      }
      if (isRecord(schema) && isRecord(schema.properties)) {
        if ("data" in schema.properties) return { data: [], kind: "wrapped" };
        return { kind: typeof kind === "string" ? kind : "generated" };
      }
      return {};
    });
  });

  it("assigns ordinals when concurrent requests start, not when they finish", async () => {
    const firstMock = await concurrentRequestIds(42);
    const secondMock = await concurrentRequestIds(42);

    expect(firstMock).toEqual([
      "00000000-0000-4000-9000-000042000000",
      "00000000-0000-4000-9000-000042000001",
    ]);
    expect(secondMock).toEqual(firstMock);
  });

  it("generates wrapped-list headers once", async () => {
    const mock = await createMock(42);
    const list = await mock.handle("GET", "/items");
    const health = await mock.handle("GET", "/health");

    expect(list.headers["X-Request-Id"]).toBe(
      "00000000-0000-4000-9000-000042000000",
    );
    expect(health.headers["X-Request-Id"]).toBe(
      "00000000-0000-4000-9000-000042000001",
    );
  });
});
