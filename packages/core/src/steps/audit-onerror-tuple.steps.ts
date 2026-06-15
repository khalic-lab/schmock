import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";

const feature = await loadFeature("../../features/audit-onerror-tuple.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Awaited<ReturnType<Schmock.CallableMockInstance["handle"]>>;
  let thrownError: unknown;

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
            onError: (_error, _ctx) => {
              return [503, { error: "recovered" }] as [number, unknown];
            },
          });
        },
      );

      When('I handle a request to "GET /fail"', async () => {
        thrownError = undefined;
        try {
          response = await mock.handle("GET", "/fail");
        } catch (err) {
          thrownError = err;
        }
      });

      Then("the response status is 503", () => {
        expect(response.status).toBe(503);
      });

      And('the response body is \'{"error":"recovered"}\'', () => {
        expect(response.body).toEqual({ error: "recovered" });
      });

      And("no error is thrown", () => {
        expect(thrownError).toBeUndefined();
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
            onError: (_error, _ctx) => {
              return [
                503,
                { error: "recovered with headers" },
                { "x-recovery": "true" },
              ] as [number, unknown, Record<string, string>];
            },
          });
        },
      );

      When('I handle a request to "GET /fail-with-headers"', async () => {
        thrownError = undefined;
        try {
          response = await mock.handle("GET", "/fail-with-headers");
        } catch (err) {
          thrownError = err;
        }
      });

      Then("the response status is 503", () => {
        expect(response.status).toBe(503);
      });

      And('the response body is \'{"error":"recovered with headers"}\'', () => {
        expect(response.body).toEqual({ error: "recovered with headers" });
      });

      And("no error is thrown", () => {
        expect(thrownError).toBeUndefined();
      });
    },
  );
});
