import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import type { ParsedSpec } from "../parser";
import { parseSpec } from "../parser";
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

const freeContentTypeHeaderSpec = {
  openapi: "3.0.3",
  info: { title: "reports", version: "1.0.0" },
  paths: {
    "/report": {
      get: {
        responses: {
          "200": {
            description: "OK",
            headers: { "Content-Type": { schema: { type: "string" } } },
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { title: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

const profileSchema = (profile: string) => ({
  schema: {
    type: "object",
    required: ["profile"],
    properties: { profile: { type: "string", const: profile } },
  },
});

const pinnedHeaderSpec = {
  openapi: "3.0.3",
  info: { title: "reports", version: "1.0.0" },
  paths: {
    "/report": {
      get: {
        responses: {
          "200": {
            description: "OK",
            headers: {
              "X-Api-Version": {
                schema: { type: "string", const: "v2", enum: ["v1", "v2"] },
              },
              "Content-Type": {
                schema: { type: "string", const: "application/json;profile=b" },
              },
            },
            content: {
              "application/json;profile=a": profileSchema("a"),
              "application/json;profile=b": profileSchema("b"),
            },
          },
        },
      },
    },
  },
};

const unknownSchemeSpec = {
  openapi: "3.1.0",
  info: { title: "secured", version: "1.0.0" },
  components: { securitySchemes: { clientCert: { type: "magicLink" } } },
  security: [{ clientCert: [] }],
  paths: {
    "/ping": { get: { responses: { "200": { description: "OK" } } } },
  },
};

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;
  let parsed: ParsedSpec;

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

  Scenario(
    "A Content-Type response header with no fixed value is ignored",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock whose report response declares a Content-Type header of any string",
        async () => {
          mock = schmock();
          mock.pipe(await openapi({ spec: freeContentTypeHeaderSpec }));
        },
      );

      When("I fetch the report", async () => {
        response = await mock.handle("GET", "/report");
      });

      Then("the report response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And(
        "the report response content type is the negotiated {string}",
        (_, type) => {
          expect(response.headers["content-type"]).toBe(type);
        },
      );
    },
  );

  Scenario(
    "A security scheme the mock cannot simulate is reported, not dropped silently",
    ({ Given, When, Then }) => {
      Given(
        "an OpenAPI 3.1 spec whose operations require a scheme of an unknown type",
        () => {},
      );

      When("I parse the secured spec", async () => {
        parsed = await parseSpec(unknownSchemeSpec);
      });

      Then(
        "the parse warnings say the {string} scheme of type {string} is skipped",
        (_, name, type) => {
          expect(parsed.warnings).toContain(
            `security scheme "${name}": unsupported type "${type}", skipped; a requirement naming it is never satisfied`,
          );
        },
      );
    },
  );

  Scenario(
    "A response header pinned by const is sent with that value",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock whose report response pins its version and profile headers with const",
        async () => {
          mock = schmock();
          mock.pipe(
            await openapi({ spec: pinnedHeaderSpec, validateResponses: true }),
          );
        },
      );

      When("I fetch the pinned report", async () => {
        response = await mock.handle("GET", "/report");
      });

      Then("the pinned report has status 200", () => {
        expect(response.status).toBe(200);
      });

      And(
        "the pinned report's {string} header is {string}",
        (_, name, value) => {
          expect(response.headers[name]).toBe(value);
        },
      );

      And("the pinned report's content type is {string}", (_, type) => {
        // Kept under the name the spec declares it with.
        expect(response.headers["Content-Type"]).toBe(type);
      });

      And(
        "the pinned report body is the profile {string} representation",
        (_, profile) => {
          expect(response.body).toEqual({ profile });
        },
      );
    },
  );
});
