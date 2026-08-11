import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";

const feature = await loadFeature("../../features/{{FEATURE_FILE}}");

describeFeature(feature, ({ Scenario }) => {
  Scenario("{{SCENARIO_NAME}}", ({ Given, When, Then }) => {
    let actual: unknown;

    Given("{{GIVEN}}", () => {
      // TODO: Arrange the scenario using this package's public API.
    });

    When("{{WHEN}}", async () => {
      // TODO: Perform the behavior and assign its result to actual.
      actual = undefined;
    });

    Then("{{THEN}}", () => {
      // TODO: Replace this placeholder with a behavior-specific assertion.
      expect(actual).toBeDefined();
    });
  });
});
