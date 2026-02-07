import { resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/openapi-crud.feature");
const fixturesDir = resolve(import.meta.dirname, "../__fixtures__");

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
});
