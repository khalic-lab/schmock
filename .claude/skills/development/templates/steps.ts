import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { MockInstance } from "../types";

const feature = await loadFeature("../../features/{{FEATURE_FILE}}");

describeFeature(feature, ({ Scenario }) => {
  let mock: MockInstance<any>;
  let response: any;

  Scenario("{{SCENARIO_NAME}}", ({ Given, When, Then }) => {
    Given("{{GIVEN}}", () => {
      // TODO: setup
    });

    When("{{WHEN}}", async () => {
      // TODO: action
    });

    Then("{{THEN}}", () => {
      // TODO: assertion
    });
  });
});
