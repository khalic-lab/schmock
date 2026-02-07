import { resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/openapi-seed.feature");
const fixturesDir = resolve(import.meta.dirname, "../__fixtures__");

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;

  Scenario("Seed with inline objects", ({ Given, When, Then }) => {
    Given("a mock with Petstore spec and inline seed data", async () => {
      mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: `${fixturesDir}/petstore-swagger2.json`,
          seed: {
            pets: [
              { petId: 1, name: "Buddy" },
              { petId: 2, name: "Max" },
            ],
          },
        }),
      );
    });

    When("I list all pets", async () => {
      response = await mock.handle("GET", "/pets");
    });

    Then("the list contains {int} items", (_, count: number) => {
      expect(response.body).toHaveLength(count);
    });
  });

  Scenario("Seed with auto-generated data", ({ Given, When, Then }) => {
    Given(
      "a mock with Petstore spec and auto-generated seed of 5 pets",
      async () => {
        mock = schmock({ state: {} });
        mock.pipe(
          await openapi({
            spec: `${fixturesDir}/petstore-swagger2.json`,
            seed: {
              pets: { count: 5 },
            },
          }),
        );
      },
    );

    When("I list all seeded pets", async () => {
      response = await mock.handle("GET", "/pets");
    });

    Then("the seeded list contains {int} items", (_, count: number) => {
      expect(response.body).toHaveLength(count);
    });
  });

  Scenario(
    "Auto-increment IDs continue after seed",
    ({ Given, When, Then }) => {
      Given("a mock with Petstore spec and inline seed data", async () => {
        mock = schmock({ state: {} });
        mock.pipe(
          await openapi({
            spec: `${fixturesDir}/petstore-swagger2.json`,
            seed: {
              pets: [
                { petId: 1, name: "Buddy" },
                { petId: 2, name: "Max" },
              ],
            },
          }),
        );
      });

      When("I create a new pet named {string}", async (_, name: string) => {
        response = await mock.handle("POST", "/pets", {
          body: { name },
        });
      });

      Then("the new pet ID is greater than existing seed IDs", () => {
        const body = response.body as Record<string, unknown>;
        expect(body.petId).toBeGreaterThan(2);
      });
    },
  );
});
