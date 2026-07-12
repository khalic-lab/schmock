import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { generateFromSchema } from "../index";

const feature = await loadFeature("../../features/deterministic-seeds.feature");

const testSchema = {
  type: "object" as const,
  properties: {
    name: { type: "string" as const },
    age: { type: "integer" as const, minimum: 1, maximum: 100 },
  },
  required: ["name", "age"],
};

describeFeature(feature, ({ Scenario }) => {
  let result1: unknown;
  let result2: unknown;
  let seededArray1: unknown;
  let seededArray2: unknown;
  let differentSeedResult1: unknown;
  let differentSeedResult2: unknown;

  Scenario("Same seed produces same output", ({ Given, When, Then }) => {
    Given("a schema plugin with seed 42", () => {
      // seed will be passed during generation
    });

    When("I generate data twice with the same seed", async () => {
      result1 = await generateFromSchema({ schema: testSchema, seed: 42 });
      result2 = await generateFromSchema({ schema: testSchema, seed: 42 });
    });

    Then("both outputs are identical", () => {
      expect(result1).toEqual(result2);
    });
  });

  Scenario(
    "Different seeds produce different output",
    ({ Given, When, Then }) => {
      let firstSeed = 0;
      let secondSeed = 0;

      Given(
        "a schema plugin using seeds {int} and {int}",
        (_, seedA: number, seedB: number) => {
          firstSeed = seedA;
          secondSeed = seedB;
        },
      );

      When("I generate data once with each seed", async () => {
        differentSeedResult1 = await generateFromSchema({
          schema: testSchema,
          seed: firstSeed,
        });
        differentSeedResult2 = await generateFromSchema({
          schema: testSchema,
          seed: secondSeed,
        });
      });

      Then("the differently seeded outputs are distinct", () => {
        expect(differentSeedResult1).not.toEqual(differentSeedResult2);
      });
    },
  );

  Scenario(
    "Seeded arrays are reproducible without repeating every item",
    ({ Given, When, Then, And }) => {
      let count = 0;

      Given(
        "an array schema plugin with seed 42 and count {int}",
        (_, requestedCount: number) => {
          count = requestedCount;
        },
      );

      When("I generate the seeded array twice", async () => {
        const schema = {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              id: { type: "integer" as const },
              name: { type: "string" as const },
            },
            required: ["id", "name"],
          },
        };
        seededArray1 = await generateFromSchema({ schema, count, seed: 42 });
        seededArray2 = await generateFromSchema({ schema, count, seed: 42 });
      });

      Then("both seeded arrays are identical", () => {
        expect(seededArray1).toEqual(seededArray2);
      });

      And("the seeded array contains varied items", () => {
        expect(Array.isArray(seededArray1)).toBe(true);
        if (!Array.isArray(seededArray1)) {
          throw new Error("Expected seeded output to be an array");
        }
        const serialized = seededArray1.map((item) => JSON.stringify(item));
        expect(new Set(serialized).size).toBeGreaterThan(1);
      });
    },
  );
});
