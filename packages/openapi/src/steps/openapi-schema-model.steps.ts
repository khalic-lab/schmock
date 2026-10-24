import { resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect, type MockInstance, vi } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature(
  "../../features/openapi-schema-model.feature",
);
const fixturesDir = resolve(import.meta.dirname, "../__fixtures__");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(schema: object) {
  return { "application/json": { schema } };
}

function specWith(
  paths: object,
  schemas: object = {},
  version = "3.0.3",
): Record<string, unknown> {
  return {
    openapi: version,
    info: { title: "Schema model", version: "1.0.0" },
    paths,
    components: { schemas },
  };
}

const reviewSpec = specWith(
  {
    "/reviews": {
      post: {
        requestBody: {
          required: true,
          content: json({
            type: "object",
            properties: {
              author: { $ref: "#/components/schemas/User" },
              reviewer: {
                $ref: "#/components/schemas/User",
                description: "The reviewer",
              },
            },
          }),
        },
        responses: { "201": { description: "Created" } },
      },
    },
  },
  {
    User: {
      type: "object",
      required: ["id", "name"],
      properties: {
        id: { type: "integer", readOnly: true },
        name: { type: "string" },
      },
    },
  },
  "3.1.0",
);

const timestampPet = { $ref: "#/components/schemas/Pet" };
const timestampPetsSpec = specWith(
  {
    "/pets": {
      post: {
        requestBody: { content: json(timestampPet) },
        responses: {
          "201": { description: "Created", content: json(timestampPet) },
        },
      },
      get: {
        responses: {
          "200": {
            description: "OK",
            content: json({ type: "array", items: timestampPet }),
          },
        },
      },
    },
  },
  {
    Timestamp: { type: "string", format: "date-time", readOnly: true },
    Pet: {
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        createdAt: { $ref: "#/components/schemas/Timestamp" },
        updatedAt: { $ref: "#/components/schemas/Timestamp" },
      },
    },
  },
);

// The Train Travel spec's trip uuid has seven hex digits in its first group.
const MALFORMED_UUID = "4f4e4e1-c824-4d63-b37a-d8d698862f1d";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /trips/{id} answering a uuid that declares the malformed uuid as its
 * sample: a 3.1 `examples` entry, or a 3.0 `example`.
 */
function malformedTripIdSpec(
  version: "3.0.3" | "3.1.0",
): Record<string, unknown> {
  const sample =
    version === "3.1.0"
      ? { examples: [MALFORMED_UUID] }
      : { example: MALFORMED_UUID };
  return specWith(
    {
      "/trips/{id}": {
        get: {
          responses: {
            "200": {
              description: "OK",
              content: json({ type: "string", format: "uuid", ...sample }),
            },
          },
        },
      },
    },
    {},
    version,
  );
}

const account = {
  allOf: [
    { $ref: "#/components/schemas/Base" },
    { required: ["id", "name", "password"] },
  ],
};
const accountSchemas = {
  Base: {
    type: "object",
    properties: {
      id: { type: "integer", readOnly: true },
      name: { type: "string" },
      password: { type: "string", writeOnly: true },
    },
  },
};

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;

  AfterEachScenario(() => {
    vi.restoreAllMocks();
  });

  async function build(options: Schmock.OpenApiOptions): Promise<void> {
    mock = schmock({ state: {} });
    mock.pipe(await openapi(options));
  }

  Scenario(
    "A described copy of a component drops its readOnly id from the request contract",
    ({ Given, When, Then }) => {
      Given(
        "a request-validating mock whose review body references User plainly and with a description",
        async () => {
          await build({ spec: reviewSpec, validateRequests: true });
        },
      );

      When(
        "I post a review whose author and reviewer carry only a name",
        async () => {
          response = await mock.handle("POST", "/reviews", {
            body: { author: { name: "Ada" }, reviewer: { name: "Grace" } },
          });
        },
      );

      Then("the review response has status 201", () => {
        expect(response.status).toBe(201);
      });
    },
  );

  Scenario(
    "Every property that references a shared readOnly component ignores client values",
    ({ Given, When, Then, And }) => {
      Given(
        "a pets mock whose createdAt and updatedAt reference one readOnly Timestamp component",
        async () => {
          await build({ spec: timestampPetsSpec });
        },
      );

      When(
        'I create a pet sending createdAt and updatedAt "1999-01-01T00:00:00Z"',
        async () => {
          response = await mock.handle("POST", "/pets", {
            body: {
              name: "Rex",
              createdAt: "1999-01-01T00:00:00Z",
              updatedAt: "1999-01-01T00:00:00Z",
            },
          });
        },
      );

      Then("the created pet has status 201", () => {
        expect(response.status).toBe(201);
      });

      And(
        'neither timestamp of the created pet is "1999-01-01T00:00:00Z"',
        () => {
          expect(isRecord(response.body)).toBe(true);
          const body = isRecord(response.body) ? response.body : {};
          expect(body.createdAt).not.toBe("1999-01-01T00:00:00Z");
          expect(body.updatedAt).not.toBe("1999-01-01T00:00:00Z");
        },
      );
    },
  );

  Scenario(
    "A readOnly name that another allOf branch requires is not required in requests",
    ({ Given, When, Then }) => {
      Given(
        "a request-validating accounts mock whose second allOf branch requires the readOnly id",
        async () => {
          await build({
            spec: specWith(
              {
                "/accounts": {
                  post: {
                    requestBody: { required: true, content: json(account) },
                    responses: { "201": { description: "Created" } },
                  },
                },
              },
              accountSchemas,
            ),
            validateRequests: true,
          });
        },
      );

      When("I create an account with only a name and a password", async () => {
        response = await mock.handle("POST", "/accounts", {
          body: { name: "Ada", password: "secret" },
        });
      });

      Then("the account response has status 201", () => {
        expect(response.status).toBe(201);
      });
    },
  );

  Scenario(
    "A writeOnly name that another allOf branch requires is never generated",
    ({ Given, When, Then, And }) => {
      Given(
        "a response-validating profile mock whose second allOf branch requires the writeOnly password",
        async () => {
          await build({
            spec: specWith(
              {
                "/me": {
                  get: {
                    responses: {
                      "200": { description: "OK", content: json(account) },
                    },
                  },
                },
              },
              accountSchemas,
            ),
            validateResponses: true,
          });
        },
      );

      When("I read the profile", async () => {
        response = await mock.handle("GET", "/me");
      });

      Then("the profile response has status 200", () => {
        expect(response.status).toBe(200);
      });

      And('the profile has no "password" key', () => {
        expect(response.body).not.toHaveProperty("password");
      });
    },
  );

  Scenario(
    "A self-referential schema generates instead of failing",
    ({ Given, When, Then, And }) => {
      Given(
        "a response-validating mock whose tree node lists children of its own type and has an optional parent",
        async () => {
          const node = { $ref: "#/components/schemas/TreeNode" };
          await build({
            spec: specWith(
              {
                "/tree": {
                  get: {
                    responses: {
                      "200": { description: "OK", content: json(node) },
                    },
                  },
                },
              },
              {
                TreeNode: {
                  type: "object",
                  required: ["id", "children"],
                  properties: {
                    id: { type: "integer" },
                    parent: node,
                    children: { type: "array", items: node },
                  },
                },
              },
            ),
            validateResponses: true,
          });
        },
      );

      When("I read the tree", async () => {
        response = await mock.handle("GET", "/tree");
      });

      Then("the tree response has status 200", () => {
        expect(response.status).toBe(200);
      });

      And('the tree has no "parent" key and an empty "children" list', () => {
        expect(response.body).not.toHaveProperty("parent");
        expect(response.body).toHaveProperty("children", []);
      });
    },
  );

  Scenario(
    "The Scalar Galaxy planets seed from a count despite their recursion",
    ({ Given, When, Then, And }) => {
      Given(
        "the Scalar Galaxy spec seeded with 2 generated planets",
        async () => {
          await build({
            spec: resolve(fixturesDir, "scalar-galaxy.yaml"),
            seed: { planets: { count: 2 } },
          });
        },
      );

      When("I list the planets", async () => {
        response = await mock.handle("GET", "/planets");
      });

      Then("the planets response has status 200", () => {
        expect(response.status).toBe(200);
      });

      And("the planet list holds 2 planets", () => {
        const body = isRecord(response.body) ? response.body : {};
        expect(body.data).toHaveLength(2);
      });
    },
  );

  Scenario(
    "A nullable property that declares a type and an allOf accepts null",
    ({ Given, When, Then }) => {
      Given(
        "a request-validating mock whose pet owner is a nullable object composed with allOf",
        async () => {
          await build({
            spec: specWith(
              {
                "/pets": {
                  post: {
                    requestBody: {
                      required: true,
                      content: json({
                        type: "object",
                        required: ["owner"],
                        properties: {
                          owner: {
                            type: "object",
                            nullable: true,
                            allOf: [{ $ref: "#/components/schemas/Owner" }],
                          },
                        },
                      }),
                    },
                    responses: { "204": { description: "No Content" } },
                  },
                },
              },
              {
                Owner: {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
              },
            ),
            validateRequests: true,
          });
        },
      );

      When("I post a pet whose owner is null", async () => {
        response = await mock.handle("POST", "/pets", {
          body: { owner: null },
        });
      });

      Then("the pet response has status 204", () => {
        expect(response.status).toBe(204);
      });
    },
  );

  Scenario(
    "A 3.1 examples array supplies varied generated values",
    ({ Given, When, Then, And }) => {
      const examples = ["active", "idle", "paused"];
      let statusSpec: Record<string, unknown>;
      const statuses: unknown[] = [];

      Given(
        'a 3.1 mock whose status string declares the examples "active", "idle" and "paused"',
        () => {
          statusSpec = specWith(
            {
              "/status": {
                get: {
                  responses: {
                    "200": {
                      description: "OK",
                      content: json({ type: "string", examples }),
                    },
                  },
                },
              },
            },
            {},
            "3.1.0",
          );
        },
      );

      When("I read the status with 12 different faker seeds", async () => {
        for (let fakerSeed = 0; fakerSeed < 12; fakerSeed++) {
          await build({ spec: structuredClone(statusSpec), fakerSeed });
          response = await mock.handle("GET", "/status");
          expect(response.status).toBe(200);
          statuses.push(response.body);
        }
      });

      Then("every status is one of the examples", () => {
        expect(statuses).toHaveLength(12);
        for (const status of statuses) expect(examples).toContain(status);
      });

      And("more than one of the examples appears", () => {
        expect(new Set(statuses).size).toBeGreaterThan(1);
      });
    },
  );

  Scenario(
    "A 3.1 examples entry the schema rejects is never generated",
    ({ Given, When, Then }) => {
      const ids: unknown[] = [];

      Given(
        "a 3.1 mock whose trip id is a uuid declaring a malformed example",
        async () => {
          await build({ spec: malformedTripIdSpec("3.1.0") });
        },
      );

      When("I read the trip id three times", async () => {
        for (let i = 0; i < 3; i++) {
          ids.push((await mock.handle("GET", "/trips/1")).body);
        }
      });

      Then(
        "every trip id is a well-formed uuid and none is the example",
        () => {
          for (const id of ids) expect(id).toMatch(UUID_RE);
          expect(ids).not.toContain(MALFORMED_UUID);
        },
      );
    },
  );

  Scenario(
    "A 3.0 example the schema rejects is never generated",
    ({ Given, When, Then }) => {
      const ids: unknown[] = [];

      Given(
        "a 3.0 mock whose trip id is a uuid with a malformed example",
        async () => {
          await build({ spec: malformedTripIdSpec("3.0.3") });
        },
      );

      When("I read the trip id three times", async () => {
        for (let i = 0; i < 3; i++) {
          ids.push((await mock.handle("GET", "/trips/1")).body);
        }
      });

      Then(
        "every trip id is a well-formed uuid and none is the example",
        () => {
          for (const id of ids) expect(id).toMatch(UUID_RE);
          expect(ids).not.toContain(MALFORMED_UUID);
        },
      );
    },
  );

  Scenario(
    "Request validation still accepts a value the examples do not list",
    ({ Given, When, Then }) => {
      Given(
        'a 3.1 request-validating mock whose status body declares the examples "active" and "idle"',
        async () => {
          await build({
            spec: specWith(
              {
                "/status": {
                  put: {
                    requestBody: {
                      required: true,
                      content: json({
                        type: "object",
                        required: ["status"],
                        properties: {
                          status: {
                            type: "string",
                            examples: ["active", "idle"],
                          },
                        },
                      }),
                    },
                    responses: { "204": { description: "Saved" } },
                  },
                },
              },
              {},
              "3.1.0",
            ),
            validateRequests: true,
          });
        },
      );

      When('I save the status "archived"', async () => {
        response = await mock.handle("PUT", "/status", {
          body: { status: "archived" },
        });
      });

      Then("the save response has status 204", () => {
        expect(response.status).toBe(204);
      });
    },
  );

  Scenario(
    "Created rows get minted ids even when the id declares examples",
    ({ Given, When, Then }) => {
      const ids: unknown[] = [];

      Given(
        "a 3.1 pets mock whose integer id declares the examples 7 and 9",
        async () => {
          const id = { type: "integer", examples: [7, 9] };
          const pet = {
            type: "object",
            properties: { id, name: { type: "string" } },
          };
          await build({
            spec: specWith(
              {
                "/pets": {
                  get: {
                    responses: {
                      "200": {
                        description: "OK",
                        content: json({ type: "array", items: pet }),
                      },
                    },
                  },
                  post: {
                    requestBody: { content: json(pet) },
                    responses: {
                      "201": { description: "Created", content: json(pet) },
                    },
                  },
                },
                "/pets/{id}": {
                  parameters: [
                    { name: "id", in: "path", required: true, schema: id },
                  ],
                  get: {
                    responses: {
                      "200": { description: "OK", content: json(pet) },
                    },
                  },
                },
              },
              {},
              "3.1.0",
            ),
          });
        },
      );

      When('I create the pets "Rex" and "Tom"', async () => {
        for (const name of ["Rex", "Tom"]) {
          response = await mock.handle("POST", "/pets", { body: { name } });
          expect(response.status).toBe(201);
          ids.push(isRecord(response.body) ? response.body.id : undefined);
        }
      });

      Then("the created pets have the ids 1 and 2", () => {
        expect(ids).toEqual([1, 2]);
      });
    },
  );

  Scenario(
    "A composed scalar generates the one example its whole schema accepts",
    ({ Given, When, Then }) => {
      let statusSpec: Record<string, unknown>;
      const statuses: unknown[] = [];

      Given(
        'a 3.1 mock whose status string excludes "x" through not and declares the examples "x" and "y"',
        () => {
          statusSpec = specWith(
            {
              "/status": {
                get: {
                  responses: {
                    "200": {
                      description: "OK",
                      content: json({
                        type: "string",
                        not: { const: "x" },
                        examples: ["x", "y"],
                      }),
                    },
                  },
                },
              },
            },
            {},
            "3.1.0",
          );
        },
      );

      When("I read the status with 4 different faker seeds", async () => {
        for (let fakerSeed = 0; fakerSeed < 4; fakerSeed++) {
          await build({ spec: structuredClone(statusSpec), fakerSeed });
          response = await mock.handle("GET", "/status");
          expect(response.status).toBe(200);
          statuses.push(response.body);
        }
      });

      Then('every status is "y"', () => {
        expect(statuses).toEqual(["y", "y", "y", "y"]);
      });
    },
  );

  Scenario(
    "A resource whose paths end in a slash stores what it creates",
    ({ Given, When, Then, And }) => {
      Given(
        "a pets mock whose collection and item paths end in a slash",
        async () => {
          const pet = {
            type: "object",
            properties: { id: { type: "integer" }, name: { type: "string" } },
          };
          await build({
            spec: specWith({
              "/api/pets/": {
                get: {
                  responses: {
                    "200": {
                      description: "OK",
                      content: json({ type: "array", items: pet }),
                    },
                  },
                },
                post: {
                  requestBody: { content: json(pet) },
                  responses: {
                    "201": { description: "Created", content: json(pet) },
                  },
                },
              },
              "/api/pets/{id}/": {
                parameters: [
                  {
                    name: "id",
                    in: "path",
                    required: true,
                    schema: { type: "integer" },
                  },
                ],
                get: {
                  responses: {
                    "200": { description: "OK", content: json(pet) },
                  },
                },
              },
            }),
          });
        },
      );

      When('I create a pet named "Rex" at "/api/pets/"', async () => {
        response = await mock.handle("POST", "/api/pets/", {
          body: { name: "Rex" },
        });
        expect(response.status).toBe(201);
      });

      Then('reading "/api/pets/1/" returns the pet named "Rex"', async () => {
        const read = await mock.handle("GET", "/api/pets/1/");
        expect(read.status).toBe(200);
        expect(read.body).toEqual({ id: 1, name: "Rex" });
      });

      And('listing "/api/pets/" returns only the pet named "Rex"', async () => {
        const list = await mock.handle("GET", "/api/pets/");
        expect(list.body).toEqual([{ id: 1, name: "Rex" }]);
      });
    },
  );

  Scenario(
    "A missing row answers with the error schema the spec declares under default",
    ({ Given, When, Then, And }) => {
      Given(
        'a response-validating pets mock whose operations declare their errors only under "default"',
        async () => {
          const pet = {
            type: "object",
            properties: { id: { type: "integer" } },
          };
          const errors = {
            default: {
              description: "Error",
              content: json({
                type: "object",
                required: ["code", "message"],
                properties: {
                  code: { type: "integer" },
                  message: { type: "string" },
                },
              }),
            },
          };
          await build({
            spec: specWith({
              "/pets": {
                get: {
                  responses: {
                    "200": {
                      description: "OK",
                      content: json({ type: "array", items: pet }),
                    },
                    ...errors,
                  },
                },
              },
              "/pets/{id}": {
                parameters: [
                  {
                    name: "id",
                    in: "path",
                    required: true,
                    schema: { type: "integer" },
                  },
                ],
                get: {
                  responses: {
                    "200": { description: "OK", content: json(pet) },
                    ...errors,
                  },
                },
              },
            }),
            validateResponses: true,
          });
        },
      );

      When("I read pet 999", async () => {
        response = await mock.handle("GET", "/pets/999");
      });

      Then("the read response has status 404", () => {
        expect(response.status).toBe(404);
      });

      And('the error body has a numeric "code" and a string "message"', () => {
        const body = isRecord(response.body) ? response.body : {};
        expect(typeof body.code).toBe("number");
        expect(typeof body.message).toBe("string");
      });
    },
  );

  Scenario(
    "A polymorphic item schema whose variants declare a string id mints string ids",
    ({ Given, When, Then, And }) => {
      let createdId: unknown;

      Given(
        "a response-validating sources mock whose item is an anyOf of two variants with a string id",
        async () => {
          const variant = (extra: string) => ({
            type: "object",
            properties: { id: { type: "string" }, [extra]: { type: "string" } },
          });
          const source = { anyOf: [variant("last4"), variant("brand")] };
          await build({
            spec: specWith({
              "/sources": {
                post: {
                  requestBody: { content: json(source) },
                  responses: {
                    "201": { description: "Created", content: json(source) },
                  },
                },
              },
              "/sources/{sourceId}": {
                parameters: [
                  {
                    name: "sourceId",
                    in: "path",
                    required: true,
                    schema: { type: "string" },
                  },
                ],
                get: {
                  responses: {
                    "200": { description: "OK", content: json(source) },
                  },
                },
              },
            }),
            validateResponses: true,
          });
        },
      );

      When('I create a source with last4 "4242"', async () => {
        response = await mock.handle("POST", "/sources", {
          body: { last4: "4242" },
        });
      });

      Then("the created source has status 201 and a string id", () => {
        expect(response.status).toBe(201);
        createdId = isRecord(response.body) ? response.body.id : undefined;
        expect(typeof createdId).toBe("string");
      });

      And('reading the source by that id returns last4 "4242"', async () => {
        const read = await mock.handle("GET", `/sources/${createdId}`);
        expect(read.status).toBe(200);
        expect(read.body).toMatchObject({ id: createdId, last4: "4242" });
      });
    },
  );

  Scenario(
    "A TRACE operation is reported in debug mode instead of dropped silently",
    ({ Given, When, Then, And }) => {
      let traced: Record<string, unknown>;
      let warnSpy: MockInstance<typeof console.warn>;

      Given('a spec whose path "/x" declares GET and TRACE', () => {
        const ok = { responses: { "200": { description: "OK" } } };
        traced = specWith({ "/x": { get: ok, trace: ok } });
      });

      When("I load it in debug mode", async () => {
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
        await build({ spec: traced, debug: true });
      });

      Then(
        'a warning says the TRACE operation on "/x" is not supported',
        () => {
          const messages = warnSpy.mock.calls.map((call) =>
            call.map(String).join(" "),
          );
          expect(messages).toContain(
            "[@schmock/openapi] TRACE /x: TRACE is not supported, skipped",
          );
        },
      );

      And('GET "/x" still answers 200', async () => {
        expect((await mock.handle("GET", "/x")).status).toBe(200);
      });
    },
  );

  Scenario(
    "A discriminator beside anyOf generates each branch with its own mapping key",
    ({ Given, When, Then }) => {
      let petSpec: Record<string, unknown>;
      const pets: Record<string, unknown>[] = [];
      const animal = (sound: "meow" | "bark") => ({
        type: "object",
        required: ["petType", sound],
        properties: {
          petType: { type: "string" },
          [sound]: { type: "boolean" },
        },
      });

      Given(
        'a mock whose pet is a discriminated anyOf of Cat and Dog mapped as "cat" and "dog"',
        () => {
          petSpec = specWith(
            {
              "/pet": {
                get: {
                  responses: {
                    "200": {
                      description: "OK",
                      content: json({ $ref: "#/components/schemas/Pet" }),
                    },
                  },
                },
              },
            },
            {
              Pet: {
                anyOf: [
                  { $ref: "#/components/schemas/Cat" },
                  { $ref: "#/components/schemas/Dog" },
                ],
                discriminator: {
                  propertyName: "petType",
                  mapping: {
                    dog: "#/components/schemas/Dog",
                    cat: "#/components/schemas/Cat",
                  },
                },
              },
              Cat: animal("meow"),
              Dog: animal("bark"),
            },
          );
        },
      );

      When("I read the pet with 12 different faker seeds", async () => {
        for (let fakerSeed = 0; fakerSeed < 12; fakerSeed++) {
          await build({ spec: structuredClone(petSpec), fakerSeed });
          response = await mock.handle("GET", "/pet");
          expect(response.status).toBe(200);
          if (isRecord(response.body)) pets.push(response.body);
        }
      });

      Then(
        'every pet that meows has petType "cat" and every pet that barks has petType "dog"',
        () => {
          expect(pets).toHaveLength(12);
          for (const pet of pets) {
            expect(pet.petType).toBe("meow" in pet ? "cat" : "dog");
            expect("meow" in pet || "bark" in pet).toBe(true);
          }
        },
      );
    },
  );
});
