import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/prefer-header.feature");

const specWith404 = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/items": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    name: { type: "string" },
                  },
                },
              },
            },
          },
          "404": {
            description: "Not found",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: { type: "string", default: "Not found" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const itemSchema = {
  type: "object",
  required: ["id", "name"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
  },
};

const specWithStoredItem = {
  openapi: "3.0.3",
  info: { title: "Stored item", version: "1.0.0" },
  paths: {
    "/items": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "array", items: itemSchema },
              },
            },
          },
        },
      },
    },
    "/items/{id}": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: itemSchema } },
          },
        },
      },
    },
  },
};

const specWithExamples = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string" },
                  },
                },
                examples: {
                  dog: { value: { name: "Buddy", type: "dog" } },
                  cat: { value: { name: "Whiskers", type: "cat" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

const specWithMediaExamples = {
  openapi: "3.0.3",
  info: { title: "Media examples", version: "1.0.0" },
  paths: {
    "/media-example": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "object" },
                examples: {
                  json: { value: { representation: "json" } },
                },
              },
              "text/plain": {
                schema: { type: "string" },
                examples: {
                  plain: { value: "plain-example" },
                },
              },
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
    "Prefer code returns specific status code",
    ({ Given, When, Then }) => {
      Given(
        "a mock with an OpenAPI spec with 200 and 404 responses",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: specWith404 }));
        },
      );

      When('I request with Prefer header "code=404"', async () => {
        response = await mock.handle("GET", "/items", {
          headers: { prefer: "code=404" },
        });
      });

      Then("the response status is 404", () => {
        expect(response.status).toBe(404);
      });
    },
  );

  Scenario("Prefer example returns named example", ({ Given, When, Then }) => {
    Given("a mock with an OpenAPI spec with named examples", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: specWithExamples }));
    });

    When('I request with Prefer header "example=dog"', async () => {
      response = await mock.handle("GET", "/pets", {
        headers: { prefer: "example=dog" },
      });
    });

    Then('the response body name is "Buddy"', () => {
      const body = response.body as Record<string, unknown>;
      expect(body.name).toBe("Buddy");
    });
  });

  Scenario(
    "Prefer dynamic regenerates from schema",
    ({ Given, When, Then, And }) => {
      // A stored item is what the route answers without Prefer, so the dynamic
      // body is distinguishable from the default one: a schema-only spec made
      // both paths produce the same shape and the scenario could not fail.
      Given(
        'a mock with an OpenAPI spec storing one item named "Stored"',
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: specWithStoredItem,
              seed: { items: [{ id: 1, name: "Stored" }] },
              fakerSeed: 7,
            }),
          );
        },
      );

      When("I request the stored item without a Prefer header", async () => {
        response = await mock.handle("GET", "/items/1");
      });

      Then('the response body name is "Stored"', () => {
        expect(response.body).toEqual({ id: 1, name: "Stored" });
      });

      When(
        'I request the stored item with Prefer header "dynamic=true"',
        async () => {
          response = await mock.handle("GET", "/items/1", {
            headers: { prefer: "dynamic=true" },
          });
        },
      );

      Then('the response body "id" is a number', () => {
        expect(response.body).toMatchObject({ id: expect.any(Number) });
      });

      And('the response body "name" is a string other than "Stored"', () => {
        expect(response.body).toMatchObject({ name: expect.any(String) });
        expect(response.body).not.toMatchObject({ name: "Stored" });
      });
    },
  );

  Scenario(
    "Prefer example selects from the negotiated media type",
    ({ Given, When, Then, And }) => {
      Given("a mock with media-specific named examples", async () => {
        mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec: specWithMediaExamples }));
      });

      When(
        "I request the text example with Prefer and Accept headers",
        async () => {
          response = await mock.handle("GET", "/media-example", {
            headers: {
              accept: "text/plain",
              prefer: "example=plain",
            },
          });
        },
      );

      Then("the preferred response body is {string}", (_, body: string) => {
        expect(response.body).toBe(body);
      });

      And(
        "the preferred response content type is {string}",
        (_, contentType: string) => {
          expect(response.headers["content-type"]).toBe(contentType);
        },
      );
    },
  );
});
