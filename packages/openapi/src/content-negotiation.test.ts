import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import {
  negotiateContentType,
  negotiateContentTypeMatch,
} from "./content-negotiation";
import { openapi } from "./plugin";

// A `content` key may legally carry media-type parameters — the OAS 3.0
// Response Object example itself uses `text/plain; charset=utf-8`. Negotiation
// must retain the raw spec key because the parsed `content` map and
// `contentTypes` are both keyed raw.
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

describe("parameter-specific Accept negotiation", () => {
  const available = [
    "application/json;profile=a",
    "application/json;profile=b",
  ];

  it("selects the representation whose media parameters match", () => {
    expect(negotiateContentType("application/json;profile=b", available)).toBe(
      "application/json;profile=b",
    );
  });

  it("applies a parameter-specific q=0 only to matching representations", () => {
    expect(
      negotiateContentType(
        "application/json;profile=b;q=0, application/json;q=0.8",
        available,
      ),
    ).toBe("application/json;profile=a");
  });

  it("recognizes q before a media parameter", () => {
    expect(
      negotiateContentType(
        "application/json;q=0;profile=b, application/json;q=0.8",
        available,
      ),
    ).toBe("application/json;profile=a");
  });

  it("compares charset values case-insensitively", () => {
    expect(
      negotiateContentType("application/json;charset=utf-8", [
        "application/json;charset=UTF-8",
      ]),
    ).toBe("application/json;charset=UTF-8");
  });

  it("keeps non-charset parameter values case-sensitive", () => {
    expect(
      negotiateContentType("application/json;profile=B", available),
    ).toBeNull();
  });
});

describe("declared response media ranges", () => {
  it("canonicalizes a concrete candidate to the most-specific declaration", () => {
    expect(
      negotiateContentTypeMatch("application/json", [
        "application/*",
        "application/json",
      ]),
    ).toEqual({
      declared: "application/json",
      contentType: "application/json",
    });
  });

  it("uses the concrete accepted subtype for an application wildcard", () => {
    expect(
      negotiateContentType("application/problem+json", ["application/*"]),
    ).toBe("application/problem+json");
  });

  it("uses the concrete accepted type for a full wildcard", () => {
    expect(negotiateContentType("text/plain", ["*/*"])).toBe("text/plain");
  });

  it("uses a concrete JSON default when no Accept header is sent", () => {
    expect(negotiateContentType("", ["application/*"])).toBe(
      "application/json",
    );
    expect(negotiateContentType("", ["*/*"])).toBe("application/json");
  });

  it("concretizes a wildcard Accept and preserves its parameters", () => {
    expect(negotiateContentType("image/*;profile=preview", ["*/*"])).toBe(
      "image/png;profile=preview",
    );
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
