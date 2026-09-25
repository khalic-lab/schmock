import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { openapi } from "./plugin";

function specWithResponse(schema: Record<string, unknown>) {
  return {
    openapi: "3.0.3",
    info: { title: "review", version: "1.0.0" },
    paths: {
      "/thing": {
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

async function statuses(
  schema: Record<string, unknown>,
  requests: number,
): Promise<{ statuses: number[]; bodies: unknown[] }> {
  const mock = schmock();
  mock.pipe(
    await openapi({
      spec: specWithResponse(schema),
      validateResponses: true,
    }),
  );
  const seen: number[] = [];
  const bodies: unknown[] = [];
  for (let index = 0; index < requests; index += 1) {
    const response = await mock.handle("GET", "/thing", {
      headers: { accept: "application/json" },
    });
    seen.push(response.status);
    bodies.push(response.body);
  }
  return { statuses: seen, bodies };
}

describe("review: faker output passes the openapi response validator", () => {
  it("serves byte-format fields that pass ajv-formats (finding 17)", async () => {
    const { statuses: seen, bodies } = await statuses(
      {
        type: "object",
        properties: {
          signature: { type: "string", format: "byte" },
          thumbnail: { type: "string", format: "byte" },
        },
        required: ["signature", "thumbnail"],
      },
      40,
    );
    expect(
      seen.filter((status) => status !== 200),
      JSON.stringify(bodies[0]),
    ).toEqual([]);
  });

  it("serves lone lower bounds above 1000 inside their range (finding 19)", async () => {
    const { statuses: seen, bodies } = await statuses(
      {
        type: "object",
        properties: {
          year: { type: "integer", minimum: 1900 },
          createdAt: { type: "integer", minimum: 1_600_000_000 },
          depth: { type: "integer", maximum: -5000 },
        },
        required: ["year", "createdAt", "depth"],
      },
      20,
    );
    expect(
      seen.filter((status) => status !== 200),
      JSON.stringify(bodies[0]),
    ).toEqual([]);
  });

  it("serves an envelope with a nested 100-item array (finding 24)", async () => {
    const { statuses: seen, bodies } = await statuses(
      {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              results: {
                type: "array",
                maxItems: 3,
                items: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    tags: {
                      type: "array",
                      maxItems: 100,
                      items: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      3,
    );
    expect(seen, JSON.stringify(bodies[0])).toEqual([200, 200, 200]);
  });
});
