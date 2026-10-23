import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/response-validation.feature");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const validResponseSpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/valid": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "integer" } },
                  required: ["id"],
                },
              },
            },
          },
        },
      },
    },
  },
};

const statusSpecificSpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/status": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: { type: "string" } },
            },
          },
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "integer" } },
                  required: ["id"],
                },
              },
            },
          },
        },
      },
    },
  },
};

const mediaSpecificSpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/media": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: { type: "string" } },
              "application/problem+json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string" } },
                  required: ["error"],
                },
              },
            },
          },
        },
      },
    },
  },
};

const explicitProfileSpec = {
  openapi: "3.0.3",
  info: { title: "Explicit profile", version: "1.0.0" },
  paths: {
    "/explicit-profile": {
      get: {
        responses: {
          "200": {
            description: "OK",
            headers: {
              "Content-Type": {
                schema: {
                  type: "string",
                  enum: ["application/json;profile=b"],
                },
              },
            },
            content: {
              "application/json;profile=a": {
                schema: {
                  type: "object",
                  properties: { profile: { type: "string", const: "a" } },
                  required: ["profile"],
                },
              },
              "application/json;profile=b": {
                schema: {
                  type: "object",
                  properties: { profile: { type: "string", const: "b" } },
                  required: ["profile"],
                },
              },
            },
          },
        },
      },
    },
  },
};

const generatedProfileContent = {
  "application/json;profile=a": {
    schema: {
      type: "object",
      properties: { profile: { type: "string", const: "a" } },
      required: ["profile"],
    },
  },
  "application/json;profile=b": {
    schema: {
      type: "object",
      properties: { profile: { type: "string", const: "b" } },
      required: ["profile"],
    },
  },
};

const generatedProfileHeader = {
  "Content-Type": {
    schema: {
      type: "string",
      enum: ["application/json;profile=b"],
    },
  },
};

const generatedProfileSpec = {
  openapi: "3.0.3",
  info: { title: "Generated response profiles", version: "1.0.0" },
  paths: {
    "/generated-profile": {
      get: {
        responses: {
          "200": {
            description: "Static profile",
            headers: generatedProfileHeader,
            content: generatedProfileContent,
          },
        },
      },
    },
    "/profile-items": {
      get: {
        responses: {
          "200": {
            description: "List",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { itemId: { type: "integer" } },
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
            description: "Created profile",
            headers: generatedProfileHeader,
            content: generatedProfileContent,
          },
        },
      },
    },
    "/profile-items/{itemId}": {
      get: {
        responses: {
          "200": {
            description: "Item",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { itemId: { type: "integer" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

const wildcardResponseSpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/range": {
      get: {
        responses: {
          "2XX": {
            description: "Any success",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { kind: { type: "string", const: "success" } },
                  required: ["kind"],
                },
              },
            },
          },
        },
      },
    },
  },
};

const defaultResponseSpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/fallback": {
      get: {
        responses: {
          default: {
            description: "Fallback",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { message: { type: "string" } },
                  required: ["message"],
                },
              },
            },
          },
        },
      },
    },
  },
};

const formattedResponseSpec = {
  openapi: "3.1.0",
  info: { title: "Formatted response", version: "1.0.0" },
  paths: {
    "/uuid": {
      get: {
        responses: {
          "200": {
            description: "UUID",
            content: {
              "application/json": {
                schema: { type: "string", format: "uuid" },
              },
            },
          },
        },
      },
    },
  },
};

const schemaLessMediaSpec = {
  openapi: "3.0.3",
  info: { title: "Schema-less media", version: "1.0.0" },
  paths: {
    "/schema-less-text": {
      get: {
        responses: {
          "200": {
            description: "Representations",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jsonOnly: { type: "string", const: "json" },
                  },
                  required: ["jsonOnly"],
                },
              },
              "text/plain": {},
            },
          },
        },
      },
    },
  },
};

const nullableRequestSpec = {
  openapi: "3.0.3",
  info: { title: "Nullable request", version: "1.0.0" },
  paths: {
    "/profiles": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["nickname"],
                properties: { nickname: { type: "string", nullable: true } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

const nullableResponseSpec = {
  openapi: "3.0.3",
  info: { title: "Nullable response", version: "1.0.0" },
  paths: {
    "/things": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    a: { type: "string", nullable: true },
                    b: { type: "string", nullable: true },
                    c: { type: "string", nullable: true },
                    d: { type: "string", nullable: true },
                    e: { type: "string", nullable: true },
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

const itemsWithout404Spec = {
  openapi: "3.0.3",
  info: { title: "Items without 404", version: "1.0.0" },
  paths: {
    "/items": {
      get: {
        responses: {
          "200": {
            description: "List",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Item" },
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
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Item" },
              },
            },
          },
        },
      },
    },
    "/items/{itemId}": {
      get: {
        parameters: [
          {
            name: "itemId",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        responses: {
          "200": {
            description: "Item",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Item" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Item: {
        type: "object",
        required: ["itemId", "name"],
        properties: {
          itemId: { type: "integer" },
          name: { type: "string" },
        },
      },
    },
  },
};

const petsWithoutProducesSpec = {
  swagger: "2.0",
  info: { title: "Pets without produces", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "List",
            schema: { type: "array", items: { $ref: "#/definitions/Pet" } },
          },
        },
      },
      post: {
        responses: {
          "201": {
            description: "Created",
            schema: { $ref: "#/definitions/Pet" },
          },
        },
      },
    },
    "/pets/{petId}": {
      get: {
        parameters: [
          { name: "petId", in: "path", required: true, type: "integer" },
        ],
        responses: {
          "200": { description: "Pet", schema: { $ref: "#/definitions/Pet" } },
        },
      },
    },
  },
  definitions: {
    Pet: {
      type: "object",
      required: ["petId", "name"],
      properties: { petId: { type: "integer" }, name: { type: "string" } },
    },
  },
};

const centPricedProductsSpec = {
  openapi: "3.0.3",
  info: { title: "Cent-priced products", version: "1.0.0" },
  paths: {
    "/products": {
      get: {
        responses: {
          "200": {
            description: "List",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Product" },
                },
              },
            },
          },
        },
      },
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Product" },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Product" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Product: {
        type: "object",
        required: ["price"],
        properties: {
          productId: { type: "integer" },
          price: { type: "number", multipleOf: 0.01 },
        },
      },
    },
  },
};

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;

  Scenario("Valid response passes validation", ({ Given, When, Then }) => {
    Given("a mock with response validation enabled", async () => {
      mock = schmock();
      mock.pipe(
        await openapi({
          spec: validResponseSpec,
          validateResponses: true,
        }),
      );
    });

    When("I request a valid generated response", async () => {
      response = await mock.handle("GET", "/valid", {
        headers: { accept: "application/json" },
      });
    });

    Then("the response status is 200", () => {
      expect(response.status).toBe(200);
    });
  });

  Scenario(
    "Response validation uses the actual status",
    ({ Given, When, Then, And }) => {
      Given("a mock with status-specific response schemas", async () => {
        mock = schmock();
        mock.pipe(
          await openapi({
            spec: statusSpecificSpec,
            validateResponses: true,
            onSchema: () => ({ type: "string", const: "valid-for-200" }),
          }),
        );
      });

      When(
        "I request status 201 with a body valid only for status 200",
        async () => {
          response = await mock.handle("GET", "/status", {
            headers: {
              accept: "application/json",
              prefer: "code=201",
            },
          });
        },
      );

      Then("the response status is 500", () => {
        expect(response.status).toBe(500);
      });

      And(
        "the response validation error code is {string}",
        (_, code: string) => {
          expect(isRecord(response.body)).toBe(true);
          if (!isRecord(response.body)) return;
          expect(response.body.code).toBe(code);
        },
      );
    },
  );

  Scenario(
    "Response validation uses the negotiated media type",
    ({ Given, When, Then, And }) => {
      Given("a mock with media-type-specific response schemas", async () => {
        mock = schmock();
        mock.pipe(
          await openapi({
            spec: mediaSpecificSpec,
            validateResponses: true,
            onSchema: () => ({ type: "string", const: "wrong-media" }),
          }),
        );
      });

      When("I request a response as {string}", async (_, mediaType: string) => {
        response = await mock.handle("GET", "/media", {
          headers: { accept: mediaType },
        });
      });

      Then("the response status is 500", () => {
        expect(response.status).toBe(500);
      });

      And(
        "the response validation error code is {string}",
        (_, code: string) => {
          expect(isRecord(response.body)).toBe(true);
          if (!isRecord(response.body)) return;
          expect(response.body.code).toBe(code);
        },
      );
    },
  );

  Scenario(
    "Generated responses use the negotiated media-type schema",
    ({ Given, When, Then, And }) => {
      Given("a mock generating media-type-specific responses", async () => {
        mock = schmock();
        mock.pipe(
          await openapi({ spec: mediaSpecificSpec, validateResponses: true }),
        );
      });

      When("I request a response as {string}", async (_, mediaType: string) => {
        response = await mock.handle("GET", "/media", {
          headers: { accept: mediaType },
        });
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And(
        "the generated response has a non-empty {string} field",
        (_, field: string) => {
          expect(isRecord(response.body)).toBe(true);
          if (!isRecord(response.body)) return;
          const value = response.body[field];
          expect(typeof value).toBe("string");
          expect(value).not.toBe("");
        },
      );
    },
  );

  Scenario(
    "Explicit response Content-Type parameters select the matching schema",
    ({ Given, When, Then, And }) => {
      Given(
        "a validating mock with explicit profile response content type",
        async () => {
          mock = schmock();
          mock.pipe(
            await openapi({
              spec: explicitProfileSpec,
              validateResponses: true,
            }),
          );
        },
      );

      When(
        "I request explicit response profile {string}",
        async (_, profile) => {
          response = await mock.handle("GET", "/explicit-profile", {
            headers: { accept: `application/json;profile=${String(profile)}` },
          });
        },
      );

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the explicit profile response marker is {string}", (_, profile) => {
        expect(response.body).toMatchObject({ profile: String(profile) });
      });

      And(
        "the explicit response content type is {string}",
        (_, contentType) => {
          const header = Object.entries(response.headers).find(
            ([name]) => name.toLowerCase() === "content-type",
          )?.[1];
          expect(header).toBe(String(contentType));
        },
      );
    },
  );

  Scenario(
    "Generated Content-Type selects static and CRUD response schemas",
    ({ Given, When, Then, And }) => {
      let profileResponses: Schmock.Response[];

      Given(
        "a validating mock with profile-labelled static and CRUD responses",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: generatedProfileSpec,
              validateResponses: true,
            }),
          );
        },
      );

      When(
        "I request both profile-labelled responses without Accept",
        async () => {
          profileResponses = await Promise.all([
            mock.handle("GET", "/generated-profile"),
            mock.handle("POST", "/profile-items", { body: {} }),
          ]);
        },
      );

      Then("both profile-labelled responses succeed", () => {
        expect(profileResponses.map(({ status }) => status)).toEqual([
          200, 201,
        ]);
      });

      And("both profile-labelled bodies use profile {string}", (_, profile) => {
        for (const profileResponse of profileResponses) {
          expect(profileResponse.body).toMatchObject({
            profile: String(profile),
          });
        }
      });

      And(
        "both profile-labelled responses declare {string}",
        (_, contentType) => {
          for (const profileResponse of profileResponses) {
            const header = Object.entries(profileResponse.headers).find(
              ([name]) => name.toLowerCase() === "content-type",
            )?.[1];
            expect(header).toBe(String(contentType));
          }
        },
      );
    },
  );

  Scenario(
    "Response validation supports status class wildcards",
    ({ Given, When, Then }) => {
      Given("a mock with a validated 2XX response", async () => {
        mock = schmock();
        mock.pipe(
          await openapi({
            spec: wildcardResponseSpec,
            validateResponses: true,
          }),
        );
      });

      When("I request status 201 covered by the wildcard", async () => {
        response = await mock.handle("GET", "/range", {
          headers: { accept: "application/json", prefer: "code=201" },
        });
      });

      Then("the response status is 201", () => {
        expect(response.status).toBe(201);
      });
    },
  );

  Scenario(
    "Response validation falls back to the default response",
    ({ Given, When, Then }) => {
      Given("a mock with a validated default response", async () => {
        mock = schmock();
        mock.pipe(
          await openapi({ spec: defaultResponseSpec, validateResponses: true }),
        );
      });

      When("I request undeclared status 418", async () => {
        response = await mock.handle("GET", "/fallback", {
          headers: { accept: "application/json", prefer: "code=418" },
        });
      });

      Then("the response status is 418", () => {
        expect(response.status).toBe(418);
      });
    },
  );

  Scenario(
    "Standard OpenAPI formats compile and validate",
    ({ Given, When, Then, And }) => {
      Given("a mock with a validated UUID response", async () => {
        mock = schmock();
        mock.pipe(
          await openapi({
            spec: formattedResponseSpec,
            validateResponses: true,
          }),
        );
      });

      When("I request the UUID response", async () => {
        response = await mock.handle("GET", "/uuid", {
          headers: { accept: "application/json" },
        });
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the generated response is a UUID", () => {
        expect(typeof response.body).toBe("string");
        expect(response.body).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      });
    },
  );

  Scenario(
    "Schema-less media does not inherit another representation's schema",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock whose JSON response has a schema and text response has none",
        async () => {
          mock = schmock();
          mock.pipe(await openapi({ spec: schemaLessMediaSpec }));
        },
      );

      When("I request the schema-less text response", async () => {
        response = await mock.handle("GET", "/schema-less-text", {
          headers: { accept: "text/plain" },
        });
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the text response does not contain the JSON-only field", () => {
        expect(isRecord(response.body)).toBe(true);
        if (!isRecord(response.body)) return;
        expect(response.body).not.toHaveProperty("jsonOnly");
      });
    },
  );

  Scenario(
    "Nullable request field accepts an explicit null",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with request validation and a nullable request field",
        async () => {
          mock = schmock();
          mock.pipe(
            await openapi({
              spec: nullableRequestSpec,
              validateRequests: true,
            }),
          );
        },
      );

      When("I post an explicit null for the nullable field", async () => {
        response = await mock.handle("POST", "/profiles", {
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: { nickname: null },
        });
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the response is not a validation error", () => {
        if (!isRecord(response.body)) return;
        expect(response.body.code).not.toBe("VALIDATION_ERROR");
      });
    },
  );

  Scenario(
    "Nullable response field passes response validation when generated as null",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with response validation and a seeded nullable response field",
        async () => {
          mock = schmock();
          mock.pipe(
            await openapi({
              spec: nullableResponseSpec,
              validateResponses: true,
              fakerSeed: 45,
            }),
          );
        },
      );

      When("I request the seeded nullable response", async () => {
        response = await mock.handle("GET", "/things", {
          headers: { accept: "application/json", prefer: "dynamic=true" },
        });
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the nullable response field is null", () => {
        expect(isRecord(response.body)).toBe(true);
        if (!isRecord(response.body)) return;
        expect(response.body.a).toBeNull();
      });
    },
  );
  Scenario(
    "An undeclared status is reported as a structured response validation error",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock validating responses for an item read that declares no 404",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: itemsWithout404Spec,
              validateResponses: true,
            }),
          );
        },
      );

      When("I read an item that does not exist", async () => {
        response = await mock.handle("GET", "/items/42");
      });

      Then("the response status is 500", () => {
        expect(response.status).toBe(500);
      });

      And(
        "the response validation error code is {string}",
        (_, code: string) => {
          expect(isRecord(response.body)).toBe(true);
          if (!isRecord(response.body)) return;
          expect(response.body.code).toBe(code);
        },
      );

      And(
        "the response validation error reports status {int}",
        (_, status: number) => {
          expect(response.body).toMatchObject({
            status,
            details: [
              {
                path: "/",
                message: `status ${status} is not declared by the operation`,
                keyword: "status",
              },
            ],
          });
        },
      );

      And("the response validation error carries no media type", () => {
        expect(isRecord(response.body)).toBe(true);
        if (!isRecord(response.body)) return;
        expect(Object.keys(response.body)).not.toContain("mediaType");
      });
    },
  );

  Scenario(
    "A Swagger 2.0 response without produces keeps its validation details",
    ({ Given, When, Then, And }) => {
      Given(
        "a Swagger 2.0 mock validating responses with a seeded pet missing its name",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: petsWithoutProducesSpec,
              validateResponses: true,
              seed: { pets: [{ petId: 1 }] },
            }),
          );
        },
      );

      When("I read the seeded pet", async () => {
        response = await mock.handle("GET", "/pets/1");
      });

      Then("the response status is 500", () => {
        expect(response.status).toBe(500);
      });

      And(
        "the response validation error code is {string}",
        (_, code: string) => {
          expect(isRecord(response.body)).toBe(true);
          if (!isRecord(response.body)) return;
          expect(response.body.code).toBe(code);
        },
      );

      And(
        "the response validation error reports the missing property {string}",
        (_, property: string) => {
          expect(response.body).toMatchObject({
            status: 200,
            details: [
              {
                path: "/",
                message: `must have required property '${property}'`,
                keyword: "required",
              },
            ],
          });
        },
      );
    },
  );
  Scenario(
    "An exact decimal amount satisfies a fractional multipleOf",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock validating requests and responses for products priced in whole cents",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: centPricedProductsSpec,
              validateRequests: true,
              validateResponses: true,
            }),
          );
        },
      );

      // 19.99 / 0.01 is 1998.9999999999998 in floating point.
      When("I create a product priced 19.99", async () => {
        response = await mock.handle("POST", "/products", {
          headers: { "content-type": "application/json" },
          body: { price: 19.99 },
        });
      });

      Then("the response status is 201", () => {
        expect(response.status).toBe(201);
      });

      And("the created product is priced 19.99", () => {
        expect(response.body).toMatchObject({ price: 19.99 });
      });
    },
  );
});
