/// <reference path="../../packages/core/schmock.d.ts" />

/**
 * Cross-cluster regressions.
 *
 * Every case here spans at least two of the Phase 3 remediation clusters, so
 * none of them belongs to a single unit suite: they fail only when two fixes
 * are combined, which is exactly the combination a per-cluster test cannot see.
 */

import { schmock } from "@schmock/core";
import { openapi } from "@schmock/openapi";
import { describe, expect, it } from "vitest";

// ─── Nullability × CRUD shape (M15 × M11/M14) ───────────────────────

const petItemSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
  },
} as const;

/**
 * Two CRUD resources whose list responses are nullable in the two shapes the
 * normalizer rewrites into `type: [T, "null"]`:
 *
 * - `/wrapped` — the array lives on a wrapper property, so list detection has
 *   to reach it through `findArrayProperty`;
 * - `/flat` — the response *is* the array, which only `hasType(schema, "array")`
 *   recognises once the type has become a union.
 *
 * A strict `schema.type === "array"` silently mis-shapes both.
 */
const NULLABLE_LIST_SPEC = {
  openapi: "3.0.3",
  info: { title: "Nullable lists", version: "1.0.0" },
  paths: {
    "/wrapped": {
      get: {
        responses: {
          "200": {
            description: "Wrapped list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      nullable: true,
                      items: petItemSchema,
                    },
                    total: { type: "integer" },
                  },
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
            content: { "application/json": { schema: petItemSchema } },
          },
        },
      },
    },
    "/wrapped/{id}": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: petItemSchema } },
          },
        },
      },
      delete: { responses: { "204": { description: "Deleted" } } },
    },
    "/flat": {
      get: {
        responses: {
          "200": {
            description: "Flat list",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  nullable: true,
                  items: petItemSchema,
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
            content: { "application/json": { schema: petItemSchema } },
          },
        },
      },
    },
    "/flat/{id}": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: petItemSchema } },
          },
        },
      },
      delete: { responses: { "204": { description: "Deleted" } } },
    },
  },
};

describe("nullable list schemas keep their CRUD shape", () => {
  it("honours a nullable wrapper property and a nullable flat array", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: NULLABLE_LIST_SPEC }));

    const createdWrapped = await mock.handle("POST", "/wrapped", {
      body: { name: "Wrapped" },
    });
    expect(createdWrapped.status).toBe(201);

    const wrapped = await mock.handle("GET", "/wrapped");
    expect(wrapped.status).toBe(200);
    const wrappedBody = wrapped.body as Record<string, unknown>;
    // The declared wrapper survives: a missed `hasType` site returns the bare
    // array here instead of `{ data: [...] }`.
    expect(Array.isArray(wrappedBody)).toBe(false);
    expect(wrappedBody.data).toHaveLength(1);
    expect((wrappedBody.data as Record<string, unknown>[])[0].name).toBe(
      "Wrapped",
    );

    const createdFlat = await mock.handle("POST", "/flat", {
      body: { name: "Flat" },
    });
    expect(createdFlat.status).toBe(201);

    const flat = await mock.handle("GET", "/flat");
    expect(flat.status).toBe(200);
    expect(Array.isArray(flat.body)).toBe(true);
    expect(flat.body).toHaveLength(1);
    expect((flat.body as Record<string, unknown>[])[0].name).toBe("Flat");
  });
});

// ─── Shared components × create contract × validation (M15 × M14) ───

/**
 * `Label` is `$ref`'d from two sibling properties of the *create* response.
 * `swagger-parser` dereferences both to the same object, so a normalizer that
 * marks a node visited without memoizing its result populates only the first
 * property and leaves the second `{}` — which then fails the plugin's own
 * response validator.
 */
const SHARED_COMPONENT_CREATE_SPEC = {
  openapi: "3.0.3",
  info: { title: "Shared components", version: "1.0.0" },
  components: {
    schemas: {
      Label: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
      },
    },
  },
  paths: {
    "/notes": {
      post: {
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "primary", "secondary"],
                  properties: {
                    id: { type: "integer" },
                    primary: { $ref: "#/components/schemas/Label" },
                    secondary: { $ref: "#/components/schemas/Label" },
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

describe("a component referenced twice on a create response", () => {
  it("populates both properties and passes response validation", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: SHARED_COMPONENT_CREATE_SPEC,
        validateResponses: true,
        fakerSeed: 42,
      }),
    );

    const created = await mock.handle("POST", "/notes", { body: {} });
    expect(created.status).toBe(201);

    const body = created.body as Record<string, Record<string, unknown>>;
    expect(typeof body.primary?.text).toBe("string");
    expect(typeof body.secondary?.text).toBe("string");
  });
});

// ─── Enveloped create contract × stored item × read (M14 × M12) ─────

/**
 * A create response that wraps the resource in an envelope (`{ data: Widget }`)
 * rather than returning the widget directly. The stored item must stay
 * widget-shaped so `GET /widgets/{id}` replays a widget, while the create
 * response must still satisfy the declared envelope so `validateResponses`
 * passes. `additionalPropsFalse` closes the envelope, which a naive generator
 * that stamps client fields + id at the envelope root cannot satisfy.
 */
function envelopeSpec(additionalPropsFalse: boolean) {
  const widget = {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
    },
  } as const;
  const envelope: Record<string, unknown> = {
    type: "object",
    required: ["data"],
    properties: { data: widget },
  };
  if (additionalPropsFalse) envelope.additionalProperties = false;
  return {
    openapi: "3.0.3",
    info: { title: "Enveloped create", version: "1.0.0" },
    paths: {
      "/widgets": {
        get: {
          responses: {
            "200": {
              description: "List",
              content: {
                "application/json": {
                  schema: { type: "array", items: widget },
                },
              },
            },
          },
        },
        post: {
          responses: {
            "201": {
              description: "Created",
              content: { "application/json": { schema: envelope } },
            },
          },
        },
      },
      "/widgets/{widgetId}": {
        get: {
          parameters: [
            {
              name: "widgetId",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": {
              description: "One",
              content: { "application/json": { schema: widget } },
            },
          },
        },
      },
    },
  };
}

describe("an enveloped create response", () => {
  for (const closed of [false, true]) {
    it(`stores the bare resource and returns a valid ${
      closed ? "closed" : "open"
    } envelope`, async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: envelopeSpec(closed),
          validateResponses: true,
          fakerSeed: 7,
        }),
      );

      const created = await mock.handle("POST", "/widgets", {
        body: { name: "Cog" },
      });
      // The envelope is contract-valid — no response-validation 500, even
      // closed — and the resource rides inside `data`, not at the root.
      expect(created.status).toBe(201);
      const data = (created.body as { data: Record<string, unknown> }).data;
      expect(data.name).toBe("Cog");
      expect(data.id).toBeDefined();
      expect((created.body as Record<string, unknown>).id).toBeUndefined();

      // The STORED item is widget-shaped, so reading it back resolves rather
      // than 404-ing on a fabricated id nested under `data`.
      const read = await mock.handle("GET", `/widgets/${data.id}`);
      expect(read.status).toBe(200);
      expect((read.body as Record<string, unknown>).name).toBe("Cog");

      const list = await mock.handle("GET", "/widgets");
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect((list.body as Record<string, unknown>[])[0].name).toBe("Cog");
    });
  }
});

// ─── Parser policy × pipeline × server contract (M16 × M17 × M18) ───

const swagger2PetSchema = {
  type: "object",
  required: ["name"],
  properties: {
    petId: { type: "integer" },
    name: { type: "string" },
  },
} as const;

/**
 * Swagger 2 carries media types on `consumes`/`produces` rather than on a
 * `content` map, and `basePath` is deliberately *not* applied to the
 * registered routes.
 */
const SWAGGER2_SPEC = {
  swagger: "2.0",
  info: { title: "Swagger 2 negotiation", version: "1.0.0" },
  basePath: "/api",
  consumes: ["application/json"],
  produces: ["application/json"],
  paths: {
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "List",
            schema: { type: "array", items: swagger2PetSchema },
          },
        },
      },
      post: {
        parameters: [
          {
            name: "body",
            in: "body",
            required: true,
            schema: swagger2PetSchema,
          },
        ],
        responses: {
          "201": { description: "Created", schema: swagger2PetSchema },
        },
      },
    },
    "/pets/{petId}": {
      get: {
        responses: { "200": { description: "OK", schema: swagger2PetSchema } },
      },
      delete: { responses: { "204": { description: "Deleted" } } },
    },
  },
};

describe("Swagger 2 produces, consumes and basePath", () => {
  it("negotiates produces, enforces consumes and never prefixes with basePath", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: SWAGGER2_SPEC, validateRequests: true }));

    // `produces` activates negotiation and fills in the response media type.
    const list = await mock.handle("GET", "/pets");
    expect(list.status).toBe(200);
    expect(list.headers["content-type"]).toBe("application/json");

    // `consumes` is the request-side content map: anything else is a 415.
    const rejected = await mock.handle("POST", "/pets", {
      body: "petId,name\n1,csv",
      headers: { "content-type": "text/csv" },
    });
    expect(rejected.status).toBe(415);
    expect((rejected.body as Record<string, unknown>).code).toBe(
      "UNSUPPORTED_MEDIA_TYPE",
    );
    expect((rejected.body as Record<string, unknown>).supported).toContain(
      "application/json",
    );

    const accepted = await mock.handle("POST", "/pets", {
      body: { name: "Rex" },
      headers: { "content-type": "application/json" },
    });
    expect(accepted.status).toBe(201);

    // `basePath` is documentation, not a prefix.
    expect((await mock.handle("GET", "/api/pets")).status).toBe(404);
  });
});
