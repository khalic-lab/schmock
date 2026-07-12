import { resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/openapi-crud.feature");
const fixturesDir = resolve(import.meta.dirname, "../__fixtures__");

const customStatusCrudSpec = {
  openapi: "3.0.3",
  info: { title: "Contract statuses", version: "1.0.0" },
  paths: {
    "/widgets": {
      get: {
        responses: {
          "206": {
            description: "Partial list",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { widgetId: { type: "integer" } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        responses: {
          "202": {
            description: "Accepted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { widgetId: { type: "integer" } },
                },
              },
            },
          },
        },
      },
    },
    "/widgets/{widgetId}": {
      get: { responses: { "203": { description: "Non-authoritative" } } },
      put: { responses: { "202": { description: "Accepted" } } },
      patch: { responses: { "204": { description: "No content" } } },
      delete: { responses: { "200": { description: "Deleted" } } },
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNumericProperty(value: unknown, property: string): number {
  if (isRecord(value)) {
    const propertyValue = value[property];
    if (typeof propertyValue === "number") return propertyValue;
  }
  throw new Error(`Expected numeric response property ${property}`);
}

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;
  let createdId: number;

  Scenario("Full CRUD lifecycle", ({ Given, When, Then, And }) => {
    Given("a mock with the Petstore spec loaded", async () => {
      mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );
    });

    When("I create a pet named {string}", async (_, name: string) => {
      response = await mock.handle("POST", "/pets", {
        body: { name, tag: "dog" },
      });
      const body = response.body as Record<string, unknown>;
      createdId = body.petId as number;
    });

    Then("the create response has status 201", () => {
      expect(response.status).toBe(201);
    });

    And("the created pet has name {string}", (_, name: string) => {
      const body = response.body as Record<string, unknown>;
      expect(body.name).toBe(name);
    });

    When("I read the created pet", async () => {
      response = await mock.handle("GET", `/pets/${createdId}`);
    });

    Then("the read response has status 200", () => {
      expect(response.status).toBe(200);
    });

    And("the pet has name {string}", (_, name: string) => {
      const body = response.body as Record<string, unknown>;
      expect(body.name).toBe(name);
    });

    When("I update the pet name to {string}", async (_, name: string) => {
      response = await mock.handle("PUT", `/pets/${createdId}`, {
        body: { name },
      });
    });

    Then("the update response has status 200", () => {
      expect(response.status).toBe(200);
    });

    When("I list all pets", async () => {
      response = await mock.handle("GET", "/pets");
    });

    Then("the list contains {int} item", (_, count: number) => {
      expect(response.body).toHaveLength(count);
    });

    When("I delete the pet", async () => {
      response = await mock.handle("DELETE", `/pets/${createdId}`);
    });

    Then("the delete response has status 204", () => {
      expect(response.status).toBe(204);
    });

    When("I list all pets after deletion", async () => {
      response = await mock.handle("GET", "/pets");
    });

    Then("the list is empty", () => {
      expect(response.body).toEqual([]);
    });
  });

  Scenario(
    "Read non-existent resource returns 404",
    ({ Given, When, Then, And }) => {
      Given("a mock with the Petstore spec loaded", async () => {
        mock = schmock({ state: {} });
        mock.pipe(
          await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
        );
      });

      When("I read pet with id 999", async () => {
        response = await mock.handle("GET", "/pets/999");
      });

      Then("the response status is 404", () => {
        expect(response.status).toBe(404);
      });

      And("the response has error code {string}", (_, code: string) => {
        const body = response.body as Record<string, unknown>;
        expect(body.code).toBe(code);
      });
    },
  );

  Scenario(
    "Delete non-existent resource returns 404",
    ({ Given, When, Then }) => {
      Given("a mock with the Petstore spec loaded", async () => {
        mock = schmock({ state: {} });
        mock.pipe(
          await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
        );
      });

      When("I delete pet with id 999", async () => {
        response = await mock.handle("DELETE", "/pets/999");
      });

      Then("the response status is 404", () => {
        expect(response.status).toBe(404);
      });
    },
  );

  Scenario(
    "CRUD operations honor contract-declared success statuses",
    ({ Given, When, Then }) => {
      let customId: number;

      Given(
        "a mock with CRUD operations declaring custom success statuses",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: customStatusCrudSpec }));
        },
      );

      When("I create an item under the custom status contract", async () => {
        response = await mock.handle("POST", "/widgets", {
          body: { name: "custom" },
        });
        customId = getNumericProperty(response.body, "widgetId");
      });

      Then("the custom create response has status 202", () => {
        expect(response.status).toBe(202);
      });

      When("I read the item under the custom status contract", async () => {
        response = await mock.handle("GET", `/widgets/${customId}`);
      });

      Then("the custom read response has status 203", () => {
        expect(response.status).toBe(203);
      });

      When("I update the item under the custom status contract", async () => {
        response = await mock.handle("PUT", `/widgets/${customId}`, {
          body: { name: "updated" },
        });
      });

      Then("the custom update response has status 202", () => {
        expect(response.status).toBe(202);
      });

      When("I patch the item under the custom status contract", async () => {
        response = await mock.handle("PATCH", `/widgets/${customId}`, {
          body: { name: "patched" },
        });
      });

      Then("the custom patch response has status 204 without a body", () => {
        expect(response.status).toBe(204);
        expect(response.body).toBeUndefined();
      });

      When("I list items under the custom status contract", async () => {
        response = await mock.handle("GET", "/widgets");
      });

      Then("the custom list response has status 206", () => {
        expect(response.status).toBe(206);
      });

      When("I delete the item under the custom status contract", async () => {
        response = await mock.handle("DELETE", `/widgets/${customId}`);
      });

      Then("the custom delete response has status 200", () => {
        expect(response.status).toBe(200);
      });
    },
  );
});
