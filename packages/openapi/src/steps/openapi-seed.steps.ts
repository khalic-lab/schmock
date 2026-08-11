import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { MAX_SEED_FILE_BYTES, MAX_SEED_ITEMS_PER_RESOURCE } from "../limits.js";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/openapi-seed.feature");
const fixturesDir = resolve(import.meta.dirname, "../__fixtures__");

const scratchDir = resolve(import.meta.dirname, "../__fixtures__");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${description} to be an object`);
  }
  return value;
}

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
        const body = requireRecord(response.body, "created pet response body");
        if (typeof body.petId !== "number") {
          throw new Error("Expected the created pet ID to be numeric");
        }
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
          const invalidCount = Number("abc");
          await expect(
            openapi({
              spec: specPath,
              seed: { pets: { count: invalidCount } },
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

  // Budgets fire at plugin construction, not per request, so the assertions
  // follow the "Invalid seed count" shape rather than driving a mock.
  Scenario(
    "Seed count above the item budget is rejected",
    ({ Given, Then }) => {
      Given("a Petstore spec path", () => {
        specPath = `${fixturesDir}/petstore-swagger2.json`;
      });

      Then(
        "creating a mock with an oversized seed count should throw about a resource limit",
        async () => {
          await expect(
            openapi({
              spec: specPath,
              seed: { pets: { count: MAX_SEED_ITEMS_PER_RESOURCE + 1 } },
            }),
          ).rejects.toThrow(/Resource limit exceeded for seed items/);
        },
      );
    },
  );

  Scenario(
    "Inline seed array above the item budget is rejected",
    ({ Given, Then }) => {
      Given("a Petstore spec path", () => {
        specPath = `${fixturesDir}/petstore-swagger2.json`;
      });

      Then(
        "creating a mock with an oversized inline seed array should throw about a resource limit",
        async () => {
          const oversized = Array.from(
            { length: MAX_SEED_ITEMS_PER_RESOURCE + 1 },
            (_, index) => ({ petId: index + 1, name: "x" }),
          );
          await expect(
            openapi({ spec: specPath, seed: { pets: oversized } }),
          ).rejects.toThrow(/Resource limit exceeded for seed items/);
        },
      );
    },
  );

  Scenario("Seed file above the byte budget is rejected", ({ Given, Then }) => {
    Given("a Petstore spec path", () => {
      specPath = `${fixturesDir}/petstore-swagger2.json`;
    });

    Then(
      "creating a mock with an oversized seed file should throw about a resource limit",
      async () => {
        const bigFile = resolve(scratchDir, "__big-seed-temp.json");
        // One padded row is enough to clear the cap without holding a huge
        // array in memory.
        writeFileSync(
          bigFile,
          JSON.stringify([{ note: "x".repeat(MAX_SEED_FILE_BYTES) }]),
        );
        try {
          await expect(
            openapi({ spec: specPath, seed: { pets: bigFile } }),
          ).rejects.toThrow(/Resource limit exceeded for seed file/);
        } finally {
          const { unlinkSync } = await import("node:fs");
          unlinkSync(bigFile);
        }
      },
    );
  });
});
