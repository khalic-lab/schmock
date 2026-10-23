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
});
