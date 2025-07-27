import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type { ParsedRoute } from "../parser";
import { parseRouteKey } from "../parser";

const feature = await loadFeature("../../features/route-key-format.feature");

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  let result: ParsedRoute;
  let error: Error | null = null;

  ScenarioOutline(
    "Valid route key formats",
    ({ When, Then, And }, variables) => {
      When("I parse route key {string}", () => {
        error = null;
        try {
          result = parseRouteKey(variables.key);
        } catch (e) {
          error = e as Error;
        }
      });

      Then("the method should be {string}", () => {
        expect(error).toBeNull();
        expect(result.method).toBe(variables.method);
      });

      And("the path should be {string}", () => {
        expect(result.path).toBe(variables.path);
      });
    },
  );

  ScenarioOutline("Invalid route key formats", ({ When, Then }, variables) => {
    When("I parse route key {string}", () => {
      error = null;
      try {
        result = parseRouteKey(variables.key);
      } catch (e) {
        error = e as Error;
      }
    });

    Then("an error should be thrown with message matching {string}", () => {
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(variables.error);
    });
  });

  Scenario("Extract parameters from path", ({ When, Then, And }) => {
    When("I parse route key {string}", (_, routeKey: string) => {
      result = parseRouteKey(routeKey);
    });

    Then("the method should be {string}", (_, expectedMethod: string) => {
      expect(result.method).toBe(expectedMethod);
    });

    And("the path should be {string}", (_, expectedPath: string) => {
      expect(result.path).toBe(expectedPath);
    });

    And("the parameters should be:", (_, docString: string) => {
      const expectedParams = JSON.parse(docString);
      expect(result.params).toEqual(expectedParams);
    });
  });

  Scenario("No parameters in simple path", ({ When, Then }) => {
    When("I parse route key {string}", (_, routeKey: string) => {
      result = parseRouteKey(routeKey);
    });

    Then("the parameters should be:", (_, docString: string) => {
      const expectedParams = JSON.parse(docString);
      expect(result.params).toEqual(expectedParams);
    });
  });

  Scenario("Path with query string placeholder", ({ When, Then, And }) => {
    When("I parse route key {string}", (_, routeKey: string) => {
      result = parseRouteKey(routeKey);
    });

    Then("the method should be {string}", (_, expectedMethod: string) => {
      expect(result.method).toBe(expectedMethod);
    });

    And("the path should be {string}", (_, expectedPath: string) => {
      expect(result.path).toBe(expectedPath);
    });

    And("query parameters are handled separately at runtime", () => {
      // This is a documentation scenario - query params are not part of the route key
      expect(result.path).not.toContain("?");
    });
  });

  Scenario("Complex nested paths", ({ When, Then, And }) => {
    When("I parse route key {string}", (_, routeKey: string) => {
      result = parseRouteKey(routeKey);
    });

    Then("the method should be {string}", (_, expectedMethod: string) => {
      expect(result.method).toBe(expectedMethod);
    });

    And("the path should be {string}", (_, expectedPath: string) => {
      expect(result.path).toBe(expectedPath);
    });

    And("the parameters should be:", (_, docString: string) => {
      const expectedParams = JSON.parse(docString);
      expect(result.params).toEqual(expectedParams);
    });
  });
});
