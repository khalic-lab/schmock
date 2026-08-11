import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/content-negotiation.feature");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const specWithJson = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/items": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "integer" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

const jsonCrudSpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
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
                  items: {
                    type: "object",
                    properties: {
                      itemId: { type: "integer" },
                      name: { type: "string" },
                    },
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
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    itemId: { type: "integer" },
                    name: { type: "string" },
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

const statusSpecificMediaSpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/status-media": {
      get: {
        responses: {
          "200": {
            description: "Success",
            content: {
              "application/json": { schema: { type: "object" } },
            },
          },
          "404": {
            description: "Missing",
            content: {
              "application/xml": { schema: { type: "string" } },
            },
          },
        },
      },
    },
  },
};

const negotiatedErrorCrudSpec = {
  openapi: "3.0.3",
  info: { title: "Negotiated errors", version: "1.0.0" },
  paths: {
    "/negotiated-items": {
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
    },
    "/negotiated-items/{itemId}": {
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
          "404": {
            description: "Missing",
            content: {
              "application/problem+json": {
                schema: {
                  type: "object",
                  properties: {
                    error: { type: "string" },
                    code: { type: "string" },
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

const dualMediaSpec = {
  openapi: "3.0.3",
  info: { title: "Dual media", version: "1.0.0" },
  paths: {
    "/dual": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "integer" } },
                },
              },
              "application/xml": {
                schema: {
                  type: "object",
                  properties: { id: { type: "integer" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

const profileMediaSpec = {
  openapi: "3.0.3",
  info: { title: "Profile media", version: "1.0.0" },
  paths: {
    "/profiles": {
      get: {
        responses: {
          "200": {
            description: "OK",
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

const wildcardMediaSpec = {
  openapi: "3.0.3",
  info: { title: "Wildcard media", version: "1.0.0" },
  paths: {
    "/wildcard": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/*": {
                schema: {
                  type: "object",
                  properties: {
                    wildcard: { type: "boolean", const: true },
                  },
                  required: ["wildcard"],
                },
              },
            },
          },
        },
      },
    },
  },
};

const overlappingMediaSpec = {
  openapi: "3.0.3",
  info: { title: "Overlapping media", version: "1.0.0" },
  paths: {
    "/overlapping": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/*": {
                schema: {
                  type: "object",
                  properties: {
                    source: { type: "string", const: "wildcard" },
                  },
                  required: ["source"],
                },
              },
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    source: { type: "string", const: "exact" },
                  },
                  required: ["source"],
                },
              },
            },
          },
        },
      },
    },
  },
};

const fullWildcardMediaSpec = {
  openapi: "3.0.3",
  info: { title: "Full wildcard media", version: "1.0.0" },
  paths: {
    "/full-wildcard": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "*/*": {
                schema: {
                  type: "object",
                  properties: { wildcard: { type: "boolean", const: true } },
                  required: ["wildcard"],
                },
              },
            },
          },
        },
      },
    },
  },
};

const requestMediaTypeSpec = {
  openapi: "3.0.3",
  info: { title: "Request media types", version: "1.0.0" },
  paths: {
    "/typed-items": {
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
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" } },
              },
            },
            "application/xml": {
              schema: {
                type: "object",
                required: ["label"],
                properties: { label: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    itemId: { type: "integer" },
                    name: { type: "string" },
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

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;

  Scenario("JSON accepted returns 200", ({ Given, When, Then }) => {
    Given("a mock with a spec defining JSON responses", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: specWithJson }));
    });

    When('I request with Accept header "application/json"', async () => {
      response = await mock.handle("GET", "/items", {
        headers: { accept: "application/json" },
      });
    });

    Then("the response status is 200", () => {
      expect(response.status).toBe(200);
    });
  });

  Scenario(
    "Unsupported content type returns 406",
    ({ Given, When, Then, And }) => {
      Given("a mock with a spec defining JSON responses", async () => {
        mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec: specWithJson }));
      });

      When('I request with Accept header "application/xml"', async () => {
        response = await mock.handle("GET", "/items", {
          headers: { accept: "application/xml" },
        });
      });

      Then("the response status is 406", () => {
        expect(response.status).toBe(406);
      });

      And('the error body has an "acceptable" array', () => {
        expect(isRecord(response.body)).toBe(true);
        if (!isRecord(response.body)) return;
        expect(Array.isArray(response.body.acceptable)).toBe(true);
        expect(response.body.acceptable).toContain("application/json");
      });
    },
  );

  Scenario(
    "Rejected content type does not run the route generator",
    ({ Given, When, Then, And }) => {
      let createResponse: Schmock.Response;
      let listResponse: Schmock.Response;

      Given("a mock with a spec defining JSON CRUD responses", async () => {
        mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec: jsonCrudSpec }));
      });

      When("I create an item requesting XML", async () => {
        createResponse = await mock.handle("POST", "/items", {
          body: { name: "blocked" },
          headers: { accept: "application/xml" },
        });
      });

      And("I list the JSON items", async () => {
        listResponse = await mock.handle("GET", "/items", {
          headers: { accept: "application/json" },
        });
      });

      Then("the create response status is 406", () => {
        expect(createResponse.status).toBe(406);
      });

      And("the negotiated collection is empty", () => {
        expect(listResponse.body).toEqual([]);
      });
    },
  );

  Scenario(
    "Media types from another status are not accepted",
    ({ Given, When, Then }) => {
      Given("a mock whose success is JSON but error is XML", async () => {
        mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec: statusSpecificMediaSpec }));
      });

      When('I request with Accept header "application/xml"', async () => {
        response = await mock.handle("GET", "/status-media", {
          headers: { accept: "application/xml" },
        });
      });

      Then("the response status is 406", () => {
        expect(response.status).toBe(406);
      });
    },
  );

  Scenario(
    "Unsupported request content type returns 415",
    ({ Given, When, Then, And }) => {
      Given(
        "a validating mock with a spec declaring JSON and XML request bodies",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: requestMediaTypeSpec,
              validateRequests: true,
            }),
          );
        },
      );

      When('I post an item with Content-Type "text/csv"', async () => {
        response = await mock.handle("POST", "/typed-items", {
          body: { name: "csv" },
          headers: { "content-type": "text/csv" },
        });
      });

      Then("the request response status is {number}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And('the error body has a "supported" array', () => {
        expect(isRecord(response.body)).toBe(true);
        if (!isRecord(response.body)) return;
        expect(response.body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
        expect(response.body.supported).toEqual(
          expect.arrayContaining(["application/json", "application/xml"]),
        );
      });
    },
  );

  Scenario(
    "Missing request content type falls back to the JSON schema",
    ({ Given, When, Then }) => {
      Given(
        "a validating mock with a spec declaring JSON and XML request bodies",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: requestMediaTypeSpec,
              validateRequests: true,
            }),
          );
        },
      );

      When("I post an item with no Content-Type header", async () => {
        response = await mock.handle("POST", "/typed-items", {
          body: { name: "untyped" },
        });
      });

      Then("the request response status is {number}", (_, status: number) => {
        expect(response.status).toBe(status);
      });
    },
  );

  Scenario(
    "A wildcard does not re-admit a type excluded with q=0",
    ({ Given, When, Then }) => {
      Given("a mock with a spec defining JSON and XML responses", async () => {
        mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec: dualMediaSpec }));
      });

      When("I request with Accept header {string}", async (_, accept) => {
        response = await mock.handle("GET", "/dual", {
          headers: { accept: String(accept) },
        });
      });

      Then("the negotiated content type is {string}", (_, contentType) => {
        expect(response.headers["content-type"]).toBe(String(contentType));
      });
    },
  );

  Scenario(
    "Excluding every declared type with q=0 returns 406",
    ({ Given, When, Then }) => {
      Given("a mock with a spec defining JSON and XML responses", async () => {
        mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec: dualMediaSpec }));
      });

      When("I request with Accept header {string}", async (_, accept) => {
        response = await mock.handle("GET", "/dual", {
          headers: { accept: String(accept) },
        });
      });

      Then("the response status is 406", () => {
        expect(response.status).toBe(406);
      });
    },
  );

  Scenario(
    "Error responses negotiate their own declared media type",
    ({ Given, When, Then, And }) => {
      Given(
        "a CRUD mock whose success is JSON and missing response is problem JSON",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: negotiatedErrorCrudSpec }));
        },
      );

      When(
        "I read a missing negotiated item requesting problem JSON",
        async () => {
          response = await mock.handle("GET", "/negotiated-items/999", {
            headers: { accept: "application/problem+json" },
          });
        },
      );

      Then("the negotiated missing response status is 404", () => {
        expect(response.status).toBe(404);
      });

      And(
        "the negotiated missing content type is {string}",
        (_, contentType: string) => {
          expect(response.headers["content-type"]).toBe(contentType);
        },
      );
    },
  );

  ScenarioOutline(
    "Media parameters and quality select the matching representation",
    ({ Given, When, Then, And }, variables) => {
      Given("a mock with profile-specific JSON responses", async () => {
        mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec: profileMediaSpec }));
      });

      When(
        "I request profile-specific content with Accept header {string}",
        async () => {
          response = await mock.handle("GET", "/profiles", {
            headers: { accept: variables.accept },
          });
        },
      );

      Then("the negotiated profile marker is {string}", () => {
        expect(response.body).toMatchObject({ profile: variables.profile });
      });

      And("the negotiated content type is {string}", () => {
        expect(response.headers["content-type"]).toBe(variables.contentType);
      });
    },
  );

  Scenario(
    "A declared media range produces a concrete Content-Type",
    ({ Given, When, Then, And }) => {
      Given("a mock with an application wildcard response", async () => {
        mock = schmock({ state: {} });
        mock.pipe(
          await openapi({
            spec: wildcardMediaSpec,
            validateResponses: true,
          }),
        );
      });

      When(
        "I request wildcard content as {string}",
        async (_, accept: string) => {
          response = await mock.handle("GET", "/wildcard", {
            headers: { accept },
          });
        },
      );

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the wildcard response marker is present", () => {
        expect(response.body).toMatchObject({ wildcard: true });
      });

      And(
        "the negotiated content type is {string}",
        (_, contentType: string) => {
          expect(response.headers["content-type"]).toBe(contentType);
        },
      );
    },
  );

  Scenario(
    "An exact content key beats an earlier wildcard key",
    ({ Given, When, Then, And }) => {
      Given(
        "a validating mock with a wildcard response before exact JSON",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: overlappingMediaSpec,
              validateResponses: true,
            }),
          );
        },
      );

      When("I request exact JSON from overlapping content keys", async () => {
        response = await mock.handle("GET", "/overlapping", {
          headers: { accept: "application/json" },
        });
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the overlapping response marker is {string}", (_, marker) => {
        expect(response.body).toMatchObject({ source: String(marker) });
      });
    },
  );

  Scenario(
    "A full wildcard declaration concretizes a wildcard Accept",
    ({ Given, When, Then, And }) => {
      Given("a mock with a full wildcard response", async () => {
        mock = schmock({ state: {} });
        mock.pipe(
          await openapi({
            spec: fullWildcardMediaSpec,
            validateResponses: true,
          }),
        );
      });

      When(
        "I request the image range with profile {string}",
        async (_, profile) => {
          response = await mock.handle("GET", "/full-wildcard", {
            headers: { accept: `image/*;profile=${String(profile)}` },
          });
        },
      );

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And(
        "the negotiated content type is {string}",
        (_, contentType: string) => {
          expect(response.headers["content-type"]).toBe(contentType);
        },
      );
    },
  );
});
