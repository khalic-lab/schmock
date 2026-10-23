import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature(
  "../../features/openapi-spec-extraction.feature",
);

const fileDownloadSpec = {
  swagger: "2.0",
  info: { title: "reports", version: "1.0.0" },
  paths: {
    "/report": {
      get: {
        produces: ["application/pdf"],
        responses: {
          "200": { description: "the report", schema: { type: "file" } },
        },
      },
    },
  },
};

const constrainedHeaderSpec = {
  swagger: "2.0",
  info: { title: "items", version: "1.0.0" },
  paths: {
    "/items": {
      get: {
        responses: {
          "200": {
            description: "OK",
            headers: {
              "X-Rate-Limit": { type: "integer", default: 100 },
              "X-Page-Size": { type: "integer", minimum: 10 },
              "X-Token": { type: "string", minLength: 8 },
            },
          },
        },
      },
    },
  },
};

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;

  Scenario(
    "A Swagger 2.0 file download answers with a binary body",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock from a Swagger 2.0 spec whose report download is a file",
        async () => {
          mock = schmock();
          mock.pipe(await openapi({ spec: fileDownloadSpec }));
        },
      );

      When("I download the report", async () => {
        response = await mock.handle("GET", "/report");
      });

      Then("the download response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the download response content type is {string}", (_, type) => {
        expect(response.headers["content-type"]).toBe(type);
      });
    },
  );

  Scenario(
    "Swagger 2.0 response headers honour their inline default, bounds and length",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock from a Swagger 2.0 spec whose item list declares constrained headers",
        async () => {
          mock = schmock();
          mock.pipe(await openapi({ spec: constrainedHeaderSpec }));
        },
      );

      When("I list the items", async () => {
        response = await mock.handle("GET", "/items");
      });

      Then("the rate limit header uses its default {string}", (_, value) => {
        expect(response.headers["X-Rate-Limit"]).toBe(value);
      });

      And("the page size header uses its minimum {string}", (_, value) => {
        expect(response.headers["X-Page-Size"]).toBe(value);
      });

      And("the token header is {string} at its minimum length", (_, value) => {
        expect(response.headers["X-Token"]).toBe(value);
      });
    },
  );
});
