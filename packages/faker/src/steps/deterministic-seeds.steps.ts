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

  Scenario("Same seed produces same output", ({ Given, When, Then }) => {
    Given("a schema plugin with seed 42", () => {
      // seed will be passed during generation
    });

    When("I generate data twice with the same seed", () => {
      result1 = generateFromSchema({ schema: testSchema, seed: 42 });
      result2 = generateFromSchema({ schema: testSchema, seed: 42 });
    });

    Then("both outputs are identical", () => {
      expect(result1).toEqual(result2);
    });
  });

  Scenario("Different seeds produce different output", ({ Given, And, When, Then }) => {
    Given("a schema plugin with seed 42", () => {
      // setup done during generation
    });

    And("a schema plugin with seed 99", () => {
      // setup done during generation
    });

    When("I generate data from each", () => {
      result1 = generateFromSchema({ schema: testSchema, seed: 42 });
      result2 = generateFromSchema({ schema: testSchema, seed: 99 });
    });

    Then("the outputs are different", () => {
      expect(result1).not.toEqual(result2);
    });
  });
});
