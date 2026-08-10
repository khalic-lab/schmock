import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { negotiateContentType } from "./content-negotiation";
import { openapi } from "./plugin";

// A `content` key may legally carry media-type parameters — the OAS 3.0
// Response Object example itself uses `text/plain; charset=utf-8`. Negotiation
// must compare the parameter-free form while still RETURNING the raw spec key,
// because the parsed `content` map and `contentTypes` are both keyed raw.
describe("negotiateContentType with a parameterized available type", () => {
  const available = ["application/json; charset=utf-8"];

  it.each([
    ["a bare exact type", "application/json"],
    ["the verbatim parameterized type", "application/json; charset=utf-8"],
    [
      "the parameterized type without a space",
      "application/json;charset=utf-8",
    ],
    ["a subtype wildcard", "application/*"],
    ["the full wildcard", "*/*"],
  ])("matches Accept with %s", (_label, accept) => {
    expect(negotiateContentType(accept, available)).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("still refuses a genuinely different type", () => {
    expect(negotiateContentType("text/xml", available)).toBeNull();
  });

  it("honours a q=0 exclusion written without the parameter", () => {
    // The exclusion is the MORE specific range, so it must win over `*/*`.
    expect(
      negotiateContentType("*/*, application/json;q=0", available),
    ).toBeNull();
  });

  it("leaves unparameterized negotiation unchanged", () => {
    expect(
      negotiateContentType("application/json", [
        "application/xml",
        "application/json",
      ]),
    ).toBe("application/json");
  });
});

describe("OAS3 response content keyed with a media-type parameter", () => {
  const spec = {
    openapi: "3.0.3",
    info: { title: "Items", version: "1.0.0" },
    paths: {
      "/items": {
        get: {
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json; charset=utf-8": {
                  schema: {
                    type: "object",
                    properties: {
                      marker: {
                        type: "string",
                        enum: ["from-parameterized-key"],
                      },
                    },
                    required: ["marker"],
                    additionalProperties: false,
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  async function get(accept?: string) {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec }));
    return mock.handle(
      "GET",
      "/items",
      accept === undefined ? undefined : { headers: { accept } },
    );
  }

  it.each([
    ["a bare exact Accept", "application/json"],
    ["the verbatim parameterized Accept", "application/json; charset=utf-8"],
    ["a subtype wildcard", "application/*"],
    ["the full wildcard", "*/*"],
    ["no Accept header", undefined],
  ])("serves 200 for %s", async (_label, accept) => {
    const res = await get(accept);
    expect(res.status).toBe(200);
    // Not a status-only assertion on purpose: a match that loses the raw key
    // resolves NO schema and no example, so the declared content would vanish.
    expect(res.body).toEqual({ marker: "from-parameterized-key" });
    // The raw spec key is what goes on the wire — parameters included.
    expect(res.headers?.["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("still returns 406 for a type the operation does not declare", async () => {
    const res = await get("text/xml");
    expect(res.status).toBe(406);
  });
});

// A CRUD route resolves its schema through `responseSchemasByMediaType`, a
// SECOND raw-keyed map. Matching an exact Accept for the first time must not
// hand that map a normalized key it does not hold — a lookup miss there is a
// 200 with a silently absent contract, which a status-only assertion misses.
describe("parameterized content key on a CRUD route", () => {
  const petSchema = {
    type: "object",
    properties: {
      petId: { type: "integer" },
      name: { type: "string" },
      marker: { type: "string", enum: ["crud-media-key"] },
    },
    required: ["petId", "name", "marker"],
  };

  const spec = {
    openapi: "3.0.3",
    info: { title: "Pets", version: "1.0.0" },
    paths: {
      "/pets": {
        get: {
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json; charset=utf-8": {
                  schema: { type: "array", items: petSchema },
                },
              },
            },
          },
        },
        post: {
          requestBody: {
            content: {
              "application/json": { schema: { type: "object" } },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json; charset=utf-8": { schema: petSchema },
              },
            },
          },
        },
      },
    },
  };

  it("resolves the CRUD contract for an exact Accept", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec }));

    const created = await mock.handle("POST", "/pets", {
      headers: { accept: "application/json" },
      body: { name: "Buddy" },
    });
    expect(created.status).toBe(201);
    // `marker` only exists on the parameterized-key schema, so its presence
    // proves `responseSchemasByMediaType` was hit with the key it holds.
    expect(created.body).toMatchObject({
      petId: 1,
      name: "Buddy",
      marker: "crud-media-key",
    });

    const list = await mock.handle("GET", "/pets", {
      headers: { accept: "application/json" },
    });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
  });
});
