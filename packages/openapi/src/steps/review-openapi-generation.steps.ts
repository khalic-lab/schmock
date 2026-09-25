import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature(
  "../../features/review-openapi-generation.feature",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(isRecord(value)).toBe(true);
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return Array.isArray(value) ? value : [];
}

/** Read a dotted path (`page.items`) out of a response body. */
function at(body: unknown, path: string): unknown {
  let current = body;
  for (const key of path.split(".")) {
    current = asRecord(current)[key];
  }
  return current;
}

function header(response: Schmock.Response, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(response.headers).find(
    ([key]) => key.toLowerCase() === target,
  )?.[1];
}

const json = (schema: Record<string, unknown>) => ({
  "application/json": { schema },
});

function spec(paths: Record<string, unknown>, components?: unknown) {
  return {
    openapi: "3.0.3",
    info: { title: "Review", version: "1.0.0" },
    paths,
    ...(components ? { components } : {}),
  };
}

// ── Pets (concurrency) ──────────────────────────────────────────────────────

const petSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    tag: { type: "string" },
    age: { type: "integer" },
  },
};

const patchPetsSpec = spec({
  "/pets": {
    get: {
      responses: {
        "200": {
          description: "List",
          content: json({ type: "array", items: petSchema }),
        },
      },
    },
  },
  "/pets/{petId}": {
    get: {
      responses: { "200": { description: "Pet", content: json(petSchema) } },
    },
    patch: {
      requestBody: { content: json(petSchema) },
      responses: { "200": { description: "Pet", content: json(petSchema) } },
    },
  },
});

// ── Zones (array ranking) ───────────────────────────────────────────────────

const zoneSchema = {
  type: "object",
  required: ["id", "name"],
  properties: { id: { type: "integer" }, name: { type: "string" } },
};

const messageSchema = {
  type: "object",
  required: ["code", "message"],
  properties: { code: { type: "integer" }, message: { type: "string" } },
};

function zonesSpec(shape: string) {
  const common = {
    errors: { type: "array", items: messageSchema },
    success: { type: "boolean" },
  };
  const result = { result: { type: "array", items: zoneSchema } };
  const envelope =
    shape === "allOf"
      ? {
          allOf: [
            { type: "object", properties: common },
            { type: "object", properties: result },
          ],
        }
      : {
          type: "object",
          required: ["errors", "success", "result"],
          properties: { ...common, ...result },
        };
  return spec({
    "/zones": {
      get: {
        responses: { "200": { description: "List", content: json(envelope) } },
      },
      post: {
        responses: {
          "201": { description: "Created", content: json(zoneSchema) },
        },
      },
    },
    "/zones/{zone_id}": {
      get: {
        responses: {
          "200": { description: "Zone", content: json(zoneSchema) },
        },
      },
    },
  });
}

// ── Pets (envelopes) ────────────────────────────────────────────────────────

const namedPetSchema = {
  type: "object",
  required: ["id", "name"],
  properties: { id: { type: "integer" }, name: { type: "string" } },
};

function petsEnvelopeSpec(
  listSchema: Record<string, unknown>,
  components?: Record<string, unknown>,
) {
  return spec(
    {
      "/pets": {
        get: {
          responses: {
            "200": { description: "List", content: json(listSchema) },
          },
        },
        post: {
          requestBody: { content: json(namedPetSchema) },
          responses: {
            "201": { description: "Created", content: json(namedPetSchema) },
          },
        },
      },
      "/pets/{petId}": {
        get: {
          responses: {
            "200": { description: "Pet", content: json(namedPetSchema) },
          },
        },
      },
    },
    components,
  );
}

/**
 * List envelopes whose `items` array hides behind a composition or omits
 * `items`, each with the OpenAPI version whose idiom it is.
 */
const composedArrayEnvelopes: Record<
  string,
  { openapi: string; items: unknown; components?: Record<string, unknown> }
> = {
  // FastAPI / pydantic on 3.1: `Optional[list[Pet]]`.
  "an array or null through anyOf": {
    openapi: "3.1.0",
    items: {
      anyOf: [{ type: "array", items: namedPetSchema }, { type: "null" }],
    },
  },
  // The 3.0 idiom: `allOf: [{$ref}]` plus `nullable: true`.
  "a nullable allOf of an array": {
    openapi: "3.0.3",
    items: {
      allOf: [{ $ref: "#/components/schemas/PetList" }],
      nullable: true,
    },
    components: {
      schemas: { PetList: { type: "array", items: namedPetSchema } },
    },
  },
  "an array or an object through oneOf": {
    openapi: "3.0.3",
    items: {
      oneOf: [
        { type: "array", items: namedPetSchema },
        { type: "object", properties: { next: { type: "string" } } },
      ],
    },
  },
  // Valid in OAS 3.1 / JSON Schema 2020-12.
  "an array without items": {
    openapi: "3.1.0",
    items: { type: "array" },
  },
};

const orderedEnvelopes: Record<string, Record<string, unknown>> = {
  "items before total": {
    type: "object",
    required: ["items", "total"],
    properties: {
      items: { type: "array", items: namedPetSchema },
      total: { type: "integer" },
    },
  },
  // The Scalar Galaxy shape: the envelope assembled from allOf branches.
  "total between data and meta": {
    allOf: [
      {
        type: "object",
        required: ["data"],
        properties: { data: { type: "array", items: namedPetSchema } },
      },
      {
        type: "object",
        required: ["total"],
        properties: { total: { type: "integer" } },
      },
      {
        type: "object",
        required: ["meta"],
        properties: {
          meta: {
            type: "object",
            required: ["limit"],
            properties: { limit: { type: "integer" } },
          },
        },
      },
    ],
  },
  "page with items before size": {
    type: "object",
    required: ["page"],
    properties: {
      page: {
        type: "object",
        required: ["items", "size"],
        properties: {
          items: { type: "array", items: namedPetSchema },
          size: { type: "integer" },
        },
      },
    },
  },
};

const untypedEnvelope = {
  required: ["data", "total"],
  properties: {
    data: { type: "array", items: namedPetSchema },
    total: { type: "integer" },
  },
};

const nestedEnvelopes: Record<string, Record<string, unknown>> = {
  "page.items": {
    type: "object",
    required: ["page"],
    properties: {
      page: {
        type: "object",
        required: ["items", "size"],
        properties: {
          items: { type: "array", items: namedPetSchema },
          size: { type: "integer" },
        },
      },
    },
  },
  "_embedded.pets": {
    type: "object",
    required: ["_embedded", "_links"],
    properties: {
      _embedded: {
        type: "object",
        required: ["pets"],
        properties: { pets: { type: "array", items: namedPetSchema } },
      },
      _links: {
        type: "object",
        required: ["self"],
        properties: {
          self: {
            type: "object",
            required: ["href"],
            properties: { href: { type: "string" } },
          },
        },
      },
    },
  },
};

const settingsSchema = {
  type: "object",
  required: ["mode"],
  properties: { mode: { type: "string", enum: ["auto", "manual"] } },
};

const settingsSpec = spec({
  "/settings": {
    get: {
      responses: {
        "200": { description: "Settings", content: json(settingsSchema) },
      },
    },
    post: {
      responses: {
        "200": { description: "Settings", content: json(settingsSchema) },
      },
    },
  },
});

function nestedChild(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < depth; i++) {
    node = { type: "object", required: ["child"], properties: { child: node } };
  }
  return node;
}

function tallItemsSpec(depth: number) {
  const item = {
    type: "object",
    required: ["id", "child"],
    properties: { id: { type: "integer" }, child: nestedChild(depth) },
  };
  return spec({
    "/items": {
      get: {
        responses: {
          "200": {
            description: "List",
            content: json({
              type: "object",
              required: ["object", "has_more", "data"],
              properties: {
                object: { type: "string", enum: ["list"] },
                has_more: { type: "boolean" },
                data: { type: "array", items: item },
              },
            }),
          },
        },
      },
      post: {
        responses: { "201": { description: "Created", content: json(item) } },
      },
    },
    "/items/{itemId}": {
      get: {
        responses: { "200": { description: "Item", content: json(item) } },
      },
    },
  });
}

// ── Object examples ─────────────────────────────────────────────────────────

const examplePetsSpec = spec(
  {
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "List",
            content: json({
              type: "array",
              items: { $ref: "#/components/schemas/Pet" },
            }),
          },
        },
      },
      post: {
        responses: {
          "201": {
            description: "Created",
            content: json({ $ref: "#/components/schemas/Pet" }),
          },
        },
      },
    },
    "/featured": {
      get: {
        responses: {
          "200": {
            description: "Featured",
            content: json({ $ref: "#/components/schemas/Pet" }),
          },
        },
      },
    },
  },
  {
    schemas: {
      Pet: {
        type: "object",
        required: ["id", "name", "tag"],
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          tag: { type: "string" },
        },
        example: { name: "doggie" },
      },
    },
  },
);

const profileSpec = spec(
  {
    "/me": {
      get: {
        responses: {
          "200": {
            description: "Me",
            content: json({ $ref: "#/components/schemas/User" }),
          },
        },
      },
    },
  },
  {
    schemas: {
      User: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "integer", readOnly: true },
          name: { type: "string" },
          password: { type: "string", writeOnly: true },
        },
        example: { id: 1, name: "a", password: "hunter2" },
      },
    },
  },
);

// ── Users (access modes) ────────────────────────────────────────────────────

function usersSpec(userSchema: Record<string, unknown>) {
  const ref = { $ref: "#/components/schemas/User" };
  return spec(
    {
      "/users": {
        get: {
          responses: {
            "200": {
              description: "List",
              content: json({ type: "array", items: ref }),
            },
          },
        },
        post: {
          requestBody: { content: json(ref) },
          responses: { "201": { description: "Created", content: json(ref) } },
        },
      },
      "/users/{userId}": {
        get: {
          responses: { "200": { description: "User", content: json(ref) } },
        },
        put: {
          requestBody: { content: json(ref) },
          responses: { "200": { description: "User", content: json(ref) } },
        },
        patch: {
          requestBody: { content: json(ref) },
          responses: { "200": { description: "User", content: json(ref) } },
        },
      },
    },
    { schemas: { User: userSchema } },
  );
}

function writeOnlyUser(contract: string): Record<string, unknown> {
  return {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "integer", readOnly: true },
      name: { type: "string" },
      password: { type: "string", writeOnly: true },
    },
    ...(contract === "closed" ? { additionalProperties: false } : {}),
  };
}

const readOnlyUser = {
  type: "object",
  required: ["id", "name", "createdAt"],
  properties: {
    id: { type: "integer", readOnly: true },
    name: { type: "string" },
    createdAt: { type: "string", format: "date-time", readOnly: true },
  },
};

// ── Nullable typeless keywords ──────────────────────────────────────────────

function thingsSpec(keyword: string) {
  const status =
    keyword === "const"
      ? { const: "a", nullable: true }
      : { enum: ["a", "b"], nullable: true };
  return spec({
    "/things": {
      post: {
        requestBody: {
          required: true,
          content: json({ type: "object", properties: { status } }),
        },
        responses: { "204": { description: "Accepted" } },
      },
    },
  });
}

// ── Lone item reads ─────────────────────────────────────────────────────────

const loneUserSpec = spec({
  "/users/{username}": {
    get: {
      parameters: [
        {
          name: "username",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "User",
          content: json({
            type: "object",
            required: ["login"],
            properties: {
              login: { type: "string" },
              id: { type: "integer" },
            },
          }),
        },
      },
    },
  },
});

const repoSchema = {
  type: "object",
  required: ["name"],
  properties: { name: { type: "string" }, full_name: { type: "string" } },
};

const reposSpec = spec({
  "/repos/{owner}/{repo}": {
    get: {
      responses: { "200": { description: "Repo", content: json(repoSchema) } },
    },
    delete: { responses: { "204": { description: "Deleted" } } },
  },
});

// ── Response headers ────────────────────────────────────────────────────────

const limitsSpec = spec({
  "/limits": {
    get: {
      responses: {
        "200": {
          description: "Limits",
          headers: {
            "X-Remaining": { schema: { type: "integer", nullable: true } },
            "X-Limit": { schema: { type: "integer", minimum: 1 } },
            "X-Floor": {
              schema: { type: "integer", minimum: 5, exclusiveMinimum: true },
            },
            "X-Meta": {
              schema: {
                type: "object",
                properties: { a: { type: "integer" } },
                default: { a: 1 },
              },
            },
          },
          content: json({ type: "object", properties: {} }),
        },
      },
    },
  },
});

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;
  let responses: Schmock.Response[] = [];

  async function build(options: Schmock.OpenApiOptions): Promise<void> {
    mock = schmock({ state: {} });
    mock.pipe(await openapi(options));
  }

  const seedRex = async () => {
    await build({
      spec: patchPetsSpec,
      seed: { pets: [{ id: 1, name: "rex", tag: "old", age: 1 }] },
    });
  };

  const expectStoredRex = async () => {
    const stored = await mock.handle("GET", "/pets/1");
    expect(stored.status).toBe(200);
    expect(stored.body).toEqual({ id: 1, name: "rex", tag: "new", age: 9 });
  };

  Scenario(
    "Concurrent PATCHes to one item keep both updates",
    ({ Given, When, Then, And }) => {
      Given(
        'a pets mock seeded with pet 1 named "rex" with tag "old" and age 1',
        seedRex,
      );

      When(
        'two PATCH requests to pet 1 run concurrently, one setting tag "new" and one setting age 9',
        async () => {
          responses = await Promise.all([
            mock.handle("PATCH", "/pets/1", { body: { tag: "new" } }),
            mock.handle("PATCH", "/pets/1", { body: { age: 9 } }),
          ]);
        },
      );

      Then("both PATCH responses have status 200", () => {
        expect(responses.map((r) => r.status)).toEqual([200, 200]);
      });

      And("the PATCH that committed last answered with both updates", () => {
        // Whichever commit ran second merged onto the first, and its response
        // is the row it stored.
        expect(responses.map((r) => r.body)).toContainEqual({
          id: 1,
          name: "rex",
          tag: "new",
          age: 9,
        });
      });

      And('pet 1 is stored with tag "new" and age 9', expectStoredRex);
    },
  );

  Scenario(
    "Concurrent PATCHes through the fetch interceptor keep both updates",
    ({ Given, When, Then }) => {
      Given(
        'a pets mock seeded with pet 1 named "rex" with tag "old" and age 1',
        seedRex,
      );

      When(
        'two intercepted fetch PATCHes to pet 1 run concurrently, one setting tag "new" and one setting age 9',
        async () => {
          const handle = mock.intercept({ passthrough: false });
          try {
            const patch = (body: Record<string, unknown>) =>
              fetch("http://localhost/pets/1", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              });
            const results = await Promise.all([
              patch({ tag: "new" }),
              patch({ age: 9 }),
            ]);
            expect(results.map((r) => r.status)).toEqual([200, 200]);
          } finally {
            handle.restore();
          }
        },
      );

      Then('pet 1 is stored with tag "new" and age 9', expectStoredRex);
    },
  );

  ScenarioOutline(
    "A list envelope that declares another array first still carries the resource",
    ({ Given, When, Then, And }, variables) => {
      Given(
        'a zones mock whose list envelope is a <shape> declaring "errors" before "result", seeded with 2 zones',
        async () => {
          await build({
            spec: zonesSpec(variables.shape),
            seed: { zones: { count: 2 } },
            fakerSeed: 7,
          });
        },
      );

      When("I list the zones", async () => {
        response = await mock.handle("GET", "/zones");
      });

      Then("the list response has status 200", () => {
        expect(response.status).toBe(200);
      });

      And('the listed zones are the 2 seeded zones under "result"', () => {
        const zones = asArray(at(response.body, "result"));
        expect(zones.map((zone) => asRecord(zone).id)).toEqual([1, 2]);
        for (const zone of zones) {
          expect(typeof asRecord(zone).name).toBe("string");
        }
      });

      And('no entry of "errors" carries a zone id', () => {
        const errors = at(response.body, "errors");
        for (const entry of Array.isArray(errors) ? errors : []) {
          expect(asRecord(entry)).not.toHaveProperty("id");
          expect(asRecord(entry)).not.toHaveProperty("zone_id");
        }
      });

      And("reading zone 1 returns a zone with a name", async () => {
        const zone = await mock.handle("GET", "/zones/1");
        expect(zone.status).toBe(200);
        expect(typeof asRecord(zone.body).name).toBe("string");
        expect(asRecord(zone.body).id).toBe(1);
      });
    },
  );

  const createRex = async () => {
    const created = await mock.handle("POST", "/pets", {
      body: { name: "Rex" },
    });
    expect(created.status).toBe(201);
  };

  Scenario(
    "An untyped list envelope keeps its declared shape",
    ({ Given, And, When, Then }) => {
      Given(
        'a pets mock whose list envelope declares "data" and "total" without a type',
        async () => {
          await build({ spec: petsEnvelopeSpec(untypedEnvelope) });
        },
      );

      And('a pet named "Rex" has been created', createRex);

      When("I list the pets", async () => {
        response = await mock.handle("GET", "/pets");
      });

      Then("the list response has status 200", () => {
        expect(response.status).toBe(200);
      });

      And('the list body carries the created pet under "data"', () => {
        expect(at(response.body, "data")).toEqual([{ id: 1, name: "Rex" }]);
      });

      And('the list body has a numeric "total"', () => {
        expect(typeof asRecord(response.body).total).toBe("number");
      });
    },
  );

  ScenarioOutline(
    "A nested list envelope carries the collection at the nested path",
    ({ Given, And, When, Then }, variables) => {
      Given(
        'a pets mock whose list envelope nests the items under "<path>", with response validation',
        async () => {
          await build({
            spec: petsEnvelopeSpec(nestedEnvelopes[variables.path]),
            validateResponses: true,
          });
        },
      );

      And('a pet named "Rex" has been created', createRex);

      When("I list the pets", async () => {
        response = await mock.handle("GET", "/pets");
      });

      Then("the list response has status 200", () => {
        expect(response.status).toBe(200);
      });

      And('the list body carries the created pet under "<path>"', () => {
        expect(at(response.body, variables.path)).toEqual([
          { id: 1, name: "Rex" },
        ]);
      });
    },
  );

  ScenarioOutline(
    "A list envelope whose array is <shape> still carries the collection",
    ({ Given, And, When, Then }, variables) => {
      Given(
        'a pets mock whose list envelope declares "items" as <shape> next to "total", with response validation',
        async () => {
          const envelope = composedArrayEnvelopes[variables.shape];
          expect(envelope).toBeDefined();
          await build({
            spec: {
              ...petsEnvelopeSpec(
                {
                  type: "object",
                  required: ["items", "total"],
                  properties: {
                    items: envelope.items,
                    total: { type: "integer" },
                  },
                },
                envelope.components,
              ),
              openapi: envelope.openapi,
            },
            validateResponses: true,
          });
        },
      );

      And('a pet named "Rex" has been created', createRex);

      When("I list the pets", async () => {
        response = await mock.handle("GET", "/pets");
      });

      Then("the list response has status 200", () => {
        expect(response.status).toBe(200);
      });

      And('the list body carries the created pet under "items"', () => {
        expect(at(response.body, "items")).toEqual([{ id: 1, name: "Rex" }]);
      });
    },
  );

  ScenarioOutline(
    "A list envelope keeps its declared key order",
    ({ Given, And, When, Then }, variables) => {
      Given('a pets mock whose list envelope is "<envelope>"', async () => {
        const envelope = orderedEnvelopes[variables.envelope];
        expect(envelope).toBeDefined();
        await build({ spec: petsEnvelopeSpec(envelope) });
      });

      And('a pet named "Rex" has been created', createRex);

      When("I list the pets", async () => {
        response = await mock.handle("GET", "/pets");
      });

      Then("the list response has status 200", () => {
        expect(response.status).toBe(200);
      });

      And(
        `the list body's keys at "<level>" are "<keys>" in that order`,
        () => {
          const level =
            variables.level === "."
              ? response.body
              : at(response.body, variables.level);
          expect(Object.keys(asRecord(level))).toEqual(
            variables.keys.split(","),
          );
        },
      );
    },
  );

  Scenario(
    "A list contract with no array serves the declared object",
    ({ Given, When, Then, And }) => {
      Given(
        "a settings mock whose list response is an object without any array, with response validation",
        async () => {
          await build({ spec: settingsSpec, validateResponses: true });
        },
      );

      When("I list the settings", async () => {
        response = await mock.handle("GET", "/settings");
      });

      Then("the list response has status 200", () => {
        expect(response.status).toBe(200);
      });

      And('the list body is an object with a "mode"', () => {
        expect(["auto", "manual"]).toContain(asRecord(response.body).mode);
      });
    },
  );

  Scenario(
    "A tall item under a list envelope keeps the envelope's siblings",
    ({ Given, When, Then, And }) => {
      Given(
        "an items mock whose item nests 13 levels deep under an object, has_more, data envelope, seeded with 1 item, with response validation",
        async () => {
          await build({
            spec: tallItemsSpec(13),
            seed: { items: { count: 1 } },
            validateResponses: true,
            fakerSeed: 1,
          });
        },
      );

      When("I list the items", async () => {
        response = await mock.handle("GET", "/items");
      });

      Then("the list response has status 200", () => {
        expect(response.status).toBe(200);
      });

      And(
        'the list body has "object" equal to "list" and a boolean "has_more"',
        () => {
          const body = asRecord(response.body);
          expect(body.object).toBe("list");
          expect(typeof body.has_more).toBe("boolean");
        },
      );

      And('the list body carries 1 item under "data"', () => {
        const items = asArray(at(response.body, "data"));
        expect(items).toHaveLength(1);
        expect(asRecord(items[0]).id).toBe(1);
      });
    },
  );

  Scenario(
    "A partial object example does not replace generated objects",
    ({ Given, When, Then, And }) => {
      Given(
        "a pets mock whose Pet schema carries a partial example, seeded with 3 pets, with response validation",
        async () => {
          await build({
            spec: examplePetsSpec,
            seed: { pets: { count: 3 } },
            validateResponses: true,
          });
        },
      );

      When("I list the pets", async () => {
        response = await mock.handle("GET", "/pets");
      });

      Then("the list response has status 200", () => {
        expect(response.status).toBe(200);
      });

      And('every listed pet has a "tag"', () => {
        const pets = asArray(response.body);
        expect(pets).toHaveLength(3);
        for (const pet of pets) {
          expect(typeof asRecord(pet).tag).toBe("string");
        }
      });

      When("I get the featured pet", async () => {
        response = await mock.handle("GET", "/featured");
      });

      Then('the featured pet response has status 200 and a "tag"', () => {
        expect(response.status).toBe(200);
        expect(typeof asRecord(response.body).tag).toBe("string");
      });
    },
  );

  Scenario(
    "A writeOnly field in an object example is not returned",
    ({ Given, When, Then }) => {
      Given(
        "a profile mock whose User example includes a writeOnly password",
        async () => {
          await build({ spec: profileSpec });
        },
      );

      When("I get the current user", async () => {
        response = await mock.handle("GET", "/me");
      });

      Then('the current user response has status 200 and no "password"', () => {
        expect(response.status).toBe(200);
        expect(asRecord(response.body)).not.toHaveProperty("password");
      });
    },
  );

  ScenarioOutline(
    "writeOnly fields are neither echoed nor stored",
    ({ Given, When, Then, And }, variables) => {
      Given(
        "a users mock with a writeOnly password under an <contract> contract, with request and response validation",
        async () => {
          await build({
            spec: usersSpec(writeOnlyUser(variables.contract)),
            validateRequests: true,
            validateResponses: true,
          });
        },
      );

      When('I create a user named "a" with password "hunter2"', async () => {
        response = await mock.handle("POST", "/users", {
          body: { name: "a", password: "hunter2" },
        });
      });

      Then('the create response has status 201 and no "password"', () => {
        expect(response.status).toBe(201);
        expect(asRecord(response.body)).not.toHaveProperty("password");
      });

      And('reading user 1 returns no "password"', async () => {
        const read = await mock.handle("GET", "/users/1");
        expect(read.status).toBe(200);
        expect(asRecord(read.body)).not.toHaveProperty("password");
      });

      And('listing users returns no "password"', async () => {
        const list = await mock.handle("GET", "/users");
        expect(list.status).toBe(200);
        for (const user of asArray(list.body)) {
          expect(asRecord(user)).not.toHaveProperty("password");
        }
      });

      When('I replace user 1 with name "z" and password "p2"', async () => {
        response = await mock.handle("PUT", "/users/1", {
          body: { name: "z", password: "p2" },
        });
      });

      Then('the replace response has status 200 and no "password"', () => {
        expect(response.status).toBe(200);
        expect(asRecord(response.body)).not.toHaveProperty("password");
      });

      And('reading user 1 returns the name "z" and no "password"', async () => {
        const read = await mock.handle("GET", "/users/1");
        expect(asRecord(read.body).name).toBe("z");
        expect(asRecord(read.body)).not.toHaveProperty("password");
      });
    },
  );

  Scenario(
    "Client-sent readOnly fields do not overwrite server values",
    ({ Given, When, Then }) => {
      let createdAt: unknown;

      Given("a users mock with a readOnly createdAt", async () => {
        await build({ spec: usersSpec(readOnlyUser) });
      });

      When(
        'I create a user named "b" with createdAt "1999-01-01T00:00:00Z"',
        async () => {
          response = await mock.handle("POST", "/users", {
            body: { name: "b", createdAt: "1999-01-01T00:00:00Z" },
          });
        },
      );

      Then(`the created user's createdAt is not "1999-01-01T00:00:00Z"`, () => {
        expect(response.status).toBe(201);
        createdAt = asRecord(response.body).createdAt;
        expect(typeof createdAt).toBe("string");
        expect(createdAt).not.toBe("1999-01-01T00:00:00Z");
      });

      When(
        'I patch user 1 with createdAt "2000-02-02T00:00:00Z" and name "c"',
        async () => {
          response = await mock.handle("PATCH", "/users/1", {
            body: { name: "c", createdAt: "2000-02-02T00:00:00Z" },
          });
        },
      );

      Then('user 1 keeps its createdAt and has the name "c"', async () => {
        expect(response.status).toBe(200);
        const read = await mock.handle("GET", "/users/1");
        expect(asRecord(read.body).createdAt).toBe(createdAt);
        expect(asRecord(read.body).name).toBe("c");
      });
    },
  );

  ScenarioOutline(
    "A nullable typeless <keyword> accepts null",
    ({ Given, When, Then }, variables) => {
      Given(
        "a mock whose request body declares a nullable typeless <keyword> status, with request validation",
        async () => {
          await build({
            spec: thingsSpec(variables.keyword),
            validateRequests: true,
          });
        },
      );

      When("I post a thing whose status is null", async () => {
        response = await mock.handle("POST", "/things", {
          body: { status: null },
        });
      });

      Then("the thing request is accepted", () => {
        expect(response.status).toBe(204);
      });
    },
  );

  Scenario(
    "A lone item GET answers from its declared schema",
    ({ Given, When, Then }) => {
      Given(
        "a mock whose spec declares only GET /users/{username}",
        async () => {
          await build({ spec: loneUserSpec });
        },
      );

      When('I get user "octocat"', async () => {
        response = await mock.handle("GET", "/users/octocat");
      });

      Then('the user response has status 200 and a "login"', () => {
        expect(response.status).toBe(200);
        expect(typeof asRecord(response.body).login).toBe("string");
      });
    },
  );

  Scenario(
    "A seeded lone item GET still serves its seeded rows",
    ({ Given, When, Then }) => {
      Given(
        'a mock whose spec declares only GET /users/{username}, seeded with user "octocat"',
        async () => {
          await build({
            spec: loneUserSpec,
            seed: { users: [{ username: "octocat", login: "octocat" }] },
          });
        },
      );

      When('I get user "octocat"', async () => {
        response = await mock.handle("GET", "/users/octocat");
      });

      Then('the user response has status 200 and the login "octocat"', () => {
        expect(response.status).toBe(200);
        expect(asRecord(response.body).login).toBe("octocat");
      });

      When('I get user "nobody"', async () => {
        response = await mock.handle("GET", "/users/nobody");
      });

      Then("the user response has status 404", () => {
        expect(response.status).toBe(404);
      });
    },
  );

  Scenario(
    "A resource whose collection path ends in a parameter is named after its last literal segment",
    ({ Given, When, Then }) => {
      Given(
        'a mock declaring GET and DELETE on /repos/{owner}/{repo}, seeded under "repos" with repo "hello"',
        async () => {
          await build({
            spec: reposSpec,
            seed: { repos: [{ repo: "hello", name: "hello" }] },
          });
        },
      );

      When('I get repo "hello" of owner "octo"', async () => {
        response = await mock.handle("GET", "/repos/octo/hello");
      });

      Then('the repo response has status 200 and the name "hello"', () => {
        expect(response.status).toBe(200);
        expect(asRecord(response.body).name).toBe("hello");
      });
    },
  );

  Scenario(
    "Response headers honour nullable types and bounds, and skip object defaults",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with a route declaring a nullable integer, a bounded integer, an exclusive-bounded integer and an object-default header",
        async () => {
          await build({ spec: limitsSpec });
        },
      );

      When("I get the limits route", async () => {
        response = await mock.handle("GET", "/limits");
      });

      Then('header "X-Remaining" is "0"', () => {
        expect(header(response, "X-Remaining")).toBe("0");
      });

      And('header "X-Limit" is "1"', () => {
        expect(header(response, "X-Limit")).toBe("1");
      });

      And('header "X-Floor" is "6"', () => {
        expect(header(response, "X-Floor")).toBe("6");
      });

      And('header "X-Meta" is absent', () => {
        expect(header(response, "X-Meta")).toBeUndefined();
      });
    },
  );
});
