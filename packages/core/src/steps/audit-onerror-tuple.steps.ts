import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";

const feature = await loadFeature("../../features/audit-onerror-tuple.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Awaited<ReturnType<Schmock.CallableMockInstance["handle"]>>;

  Scenario(
    "2-element tuple from onError recovers with correct status and body",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with a plugin whose process throws and onError returns a 2-element tuple",
        () => {
          mock = schmock({ state: {} });
          mock("GET /fail", null, {}).pipe({
            name: "failing-plugin",
            process: (_ctx, _response) => {
              throw new Error("simulated failure");
            },
            onError: () => [503, { error: "recovered" }],
          });
        },
      );

      When('I handle a request to "GET /fail"', async () => {
        response = await mock.handle("GET", "/fail");
      });

      Then("the response status is 503", () => {
        expect(response.status).toBe(503);
      });

      And('the response body is \'{"error":"recovered"}\'', () => {
        expect(response.body).toEqual({ error: "recovered" });
      });
    },
  );

  Scenario(
    "3-element tuple from onError recovers and includes custom headers",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with a plugin whose process throws and onError returns a 3-element tuple with headers",
        () => {
          mock = schmock({ state: {} });
          mock("GET /fail-with-headers", null, {}).pipe({
            name: "failing-plugin-headers",
            process: (_ctx, _response) => {
              throw new Error("simulated failure with headers");
            },
            onError: () => [
              503,
              { error: "recovered with headers" },
              { "x-recovery": "true" },
            ],
          });
        },
      );

      When('I handle a request to "GET /fail-with-headers"', async () => {
        response = await mock.handle("GET", "/fail-with-headers");
      });

      Then("the response status is 503", () => {
        expect(response.status).toBe(503);
      });

      And('the response body is \'{"error":"recovered with headers"}\'', () => {
        expect(response.body).toEqual({ error: "recovered with headers" });
      });

      And(
        "the response header {string} is {string}",
        (_, header: string, value: string) => {
          expect(response.headers[header]).toBe(value);
        },
      );
    },
  );
});
