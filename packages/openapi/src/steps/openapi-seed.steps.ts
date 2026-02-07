import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/openapi-seed.feature");
const fixturesDir = resolve(import.meta.dirname, "../__fixtures__");

const scratchDir = resolve(import.meta.dirname, "../__fixtures__");

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;
  let specPath: string;

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

  Scenario(
    "Invalid seed count produces descriptive error",
    ({ Given, Then }) => {
      Given("a Petstore spec path", () => {
        specPath = `${fixturesDir}/petstore-swagger2.json`;
      });

      Then(
        'creating a mock with seed count "abc" should throw about non-negative integer',
        async () => {
          await expect(
            openapi({
              spec: specPath,
              seed: { pets: { count: "abc" as any } },
            }),
          ).rejects.toThrow("non-negative integer");
        },
      );
    },
  );

  Scenario(
    "Malformed seed file produces descriptive error",
    ({ Given, Then }) => {
      Given("a Petstore spec path", () => {
        specPath = `${fixturesDir}/petstore-swagger2.json`;
      });

      Then(
        "creating a mock with malformed seed file should throw about invalid JSON",
        async () => {
          const badFile = resolve(scratchDir, "__bad-seed-temp.json");
          writeFileSync(badFile, "NOT VALID JSON{{{");
          try {
            await expect(
              openapi({
                spec: specPath,
                seed: { pets: badFile },
              }),
            ).rejects.toThrow("invalid JSON");
          } finally {
            const { unlinkSync } = await import("node:fs");
            unlinkSync(badFile);
          }
        },
      );
    },
  );
});
