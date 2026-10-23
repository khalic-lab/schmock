import { resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
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

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;

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
    "A 3.1 examples array becomes the generation default the way a 3.0 example does",
    ({ Given, When, Then }) => {
      Given(
        'a 3.1 mock whose status string declares the examples "active" and "idle"',
        async () => {
          await build({
            spec: specWith(
              {
                "/status": {
                  get: {
                    responses: {
                      "200": {
                        description: "OK",
                        content: json({
                          type: "string",
                          examples: ["active", "idle"],
                        }),
                      },
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

      When("I read the status", async () => {
        response = await mock.handle("GET", "/status");
      });

      Then('the status is "active"', () => {
        expect(response.body).toBe("active");
      });
    },
  );
});
