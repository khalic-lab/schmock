import { resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/openapi-crud.feature");
const fixturesDir = resolve(import.meta.dirname, "../__fixtures__");

const customStatusCrudSpec = {
  openapi: "3.0.3",
  info: { title: "Contract statuses", version: "1.0.0" },
  paths: {
    "/widgets": {
      get: {
        responses: {
          "206": {
            description: "Partial list",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { widgetId: { type: "integer" } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        responses: {
          "202": {
            description: "Accepted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { widgetId: { type: "integer" } },
                },
              },
            },
          },
        },
      },
    },
    "/widgets/{widgetId}": {
      get: { responses: { "203": { description: "Non-authoritative" } } },
      put: { responses: { "202": { description: "Accepted" } } },
      patch: { responses: { "204": { description: "No content" } } },
      delete: { responses: { "200": { description: "Deleted" } } },
    },
  },
};

const widgetSchema = {
  type: "object",
  properties: { widgetId: { type: "integer" }, name: { type: "string" } },
};

const jsonContent = { "application/json": { schema: widgetSchema } };

/** Build a widget spec whose item path declares exactly `itemMethods`. */
function widgetSpec(
  itemMethods: Record<string, unknown>,
  collectionExtras: Record<string, unknown> = {},
) {
  return {
    openapi: "3.0.3",
    info: { title: "Widgets", version: "1.0.0" },
    paths: {
      "/widgets": {
        get: {
          responses: {
            "200": {
              description: "List",
              content: {
                "application/json": {
                  schema: { type: "array", items: widgetSchema },
                },
              },
            },
          },
        },
        post: {
          responses: {
            "201": { description: "Created", content: jsonContent },
          },
        },
        ...collectionExtras,
      },
      "/widgets/{widgetId}": {
        get: {
          responses: { "200": { description: "OK", content: jsonContent } },
        },
        delete: { responses: { "204": { description: "Deleted" } } },
        ...itemMethods,
      },
    },
  };
}

const putOnlyWidgetSpec = widgetSpec({
  put: {
    responses: {
      "200": {
        description: "Updated",
        headers: {
          "x-replaced-by": {
            description: "Which method served the update",
            schema: { type: "string", enum: ["put"] },
          },
        },
        content: jsonContent,
      },
    },
  },
});

const patchOnlyWidgetSpec = widgetSpec({
  patch: {
    responses: { "200": { description: "Patched", content: jsonContent } },
  },
});

const perMethodContractWidgetSpec = widgetSpec({
  put: {
    responses: {
      "200": {
        description: "Replaced",
        headers: {
          "x-update-mode": {
            description: "How the update was applied",
            schema: { type: "string", enum: ["replace"] },
          },
        },
        content: jsonContent,
      },
    },
  },
  patch: { responses: { "204": { description: "No content" } } },
});

const extraMethodWidgetSpec = widgetSpec(
  {
    put: {
      responses: { "200": { description: "Updated", content: jsonContent } },
    },
    head: { responses: { "200": { description: "Exists" } } },
  },
  { options: { responses: { "204": { description: "Allowed" } } } },
);

const petSchema = {
  type: "object",
  properties: { petId: { type: "integer" }, name: { type: "string" } },
};

/** POST /things declares a full 201 contract the created body must satisfy. */
const contractThingSpec = {
  openapi: "3.0.3",
  info: { title: "Things", version: "1.0.0" },
  paths: {
    "/things": {
      post: {
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "createdAt"],
                  properties: {
                    id: { type: "string" },
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/things/{thingId}": {
      get: {
        parameters: [
          {
            name: "thingId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    createdAt: { type: "string" },
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

/** GET /widgets declares a different wrapper per media type. */
const mediaTypeWidgetSpec = {
  openapi: "3.0.3",
  info: { title: "Negotiated widgets", version: "1.0.0" },
  paths: {
    "/widgets": {
      get: {
        responses: {
          "200": {
            description: "List",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    kind: { type: "string", const: "json" },
                    data: { type: "array", items: widgetSchema },
                  },
                },
              },
              "application/xml": {
                schema: {
                  type: "object",
                  properties: {
                    kind: { type: "string", const: "xml" },
                    data: { type: "array", items: widgetSchema },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        responses: { "201": { description: "Created", content: jsonContent } },
      },
    },
    "/widgets/{widgetId}": {
      get: {
        responses: { "200": { description: "OK", content: jsonContent } },
      },
    },
  },
};

const petJsonContent = { "application/json": { schema: petSchema } };

/**
 * A pet resource whose mutating operations can each be turned into a rejection:
 * POST declares a 400 that `Prefer: code=400` can select, PUT declares only
 * `application/json` so an XML `Accept` is a 406, and DELETE declares a 200 body
 * requiring a property no stored item has, so `validateResponses` yields a 500.
 */
const transactionalSpec = {
  openapi: "3.0.3",
  info: { title: "Transactional pets", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "List",
            content: {
              "application/json": {
                schema: { type: "array", items: petSchema },
              },
            },
          },
        },
      },
      post: {
        responses: {
          "201": { description: "Created", content: petJsonContent },
          "400": {
            description: "Bad request",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: { type: "string" },
                    code: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/pets/{petId}": {
      get: {
        responses: { "200": { description: "OK", content: petJsonContent } },
      },
      put: {
        responses: {
          "200": { description: "Updated", content: petJsonContent },
        },
      },
      delete: {
        responses: {
          "200": {
            description: "Deleted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { deletedAt: { type: "string" } },
                  required: ["deletedAt"],
                },
              },
            },
          },
        },
      },
    },
  },
};

/** Build the CRUD operations for one collection path pair. */
function crudPathPair(itemParam: string, itemSchema: Record<string, unknown>) {
  const content = { "application/json": { schema: itemSchema } };
  return {
    collection: {
      get: {
        responses: {
          "200": {
            description: "List",
            content: {
              "application/json": {
                schema: { type: "array", items: itemSchema },
              },
            },
          },
        },
      },
      post: { responses: { "201": { description: "Created", content } } },
    },
    item: {
      get: { responses: { "200": { description: "OK", content } } },
      delete: { responses: { "204": { description: "Deleted" } } },
    },
    itemParam,
  };
}

const userSchema = {
  type: "object",
  properties: { userId: { type: "integer" }, name: { type: "string" } },
};

const rootUsers = crudPathPair("userId", userSchema);
const adminUsers = crudPathPair("userId", userSchema);
const ownerPets = crudPathPair("petId", petSchema);

/**
 * `/users` and `/admins/users` share a resource name, and
 * `/owners/{ownerId}/pets` is one collection per owner — all three must hold
 * independent state.
 */
const scopedSpec = {
  openapi: "3.0.3",
  info: { title: "Scoped collections", version: "1.0.0" },
  paths: {
    "/users": rootUsers.collection,
    "/users/{userId}": rootUsers.item,
    "/admins/users": adminUsers.collection,
    "/admins/users/{userId}": adminUsers.item,
    "/owners/{ownerId}/pets": ownerPets.collection,
    "/owners/{ownerId}/pets/{petId}": ownerPets.item,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNumericProperty(value: unknown, property: string): number {
  if (isRecord(value)) {
    const propertyValue = value[property];
    if (typeof propertyValue === "number") return propertyValue;
  }
  throw new Error(`Expected numeric response property ${property}`);
}

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;
  let createdId: number;

  Scenario("Full CRUD lifecycle", ({ Given, When, Then, And }) => {
    Given("a mock with the Petstore spec loaded", async () => {
      mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );
    });

    When("I create a pet named {string}", async (_, name: string) => {
      response = await mock.handle("POST", "/pets", {
        body: { name, tag: "dog" },
      });
      const body = response.body as Record<string, unknown>;
      createdId = body.petId as number;
    });

    Then("the create response has status 201", () => {
      expect(response.status).toBe(201);
    });

    And("the created pet has name {string}", (_, name: string) => {
      const body = response.body as Record<string, unknown>;
      expect(body.name).toBe(name);
    });

    When("I read the created pet", async () => {
      response = await mock.handle("GET", `/pets/${createdId}`);
    });

    Then("the read response has status 200", () => {
      expect(response.status).toBe(200);
    });

    And("the pet has name {string}", (_, name: string) => {
      const body = response.body as Record<string, unknown>;
      expect(body.name).toBe(name);
    });

    When("I update the pet name to {string}", async (_, name: string) => {
      response = await mock.handle("PUT", `/pets/${createdId}`, {
        body: { name },
      });
    });

    Then("the update response has status 200", () => {
      expect(response.status).toBe(200);
    });

    When("I list all pets", async () => {
      response = await mock.handle("GET", "/pets");
    });

    Then("the list contains {int} item", (_, count: number) => {
      expect(response.body).toHaveLength(count);
    });

    When("I delete the pet", async () => {
      response = await mock.handle("DELETE", `/pets/${createdId}`);
    });

    Then("the delete response has status 204", () => {
      expect(response.status).toBe(204);
    });

    When("I list all pets after deletion", async () => {
      response = await mock.handle("GET", "/pets");
    });

    Then("the list is empty", () => {
      expect(response.body).toEqual([]);
    });
  });

  Scenario(
    "Read non-existent resource returns 404",
    ({ Given, When, Then, And }) => {
      Given("a mock with the Petstore spec loaded", async () => {
        mock = schmock({ state: {} });
        mock.pipe(
          await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
        );
      });

      When("I read pet with id 999", async () => {
        response = await mock.handle("GET", "/pets/999");
      });

      Then("the response status is 404", () => {
        expect(response.status).toBe(404);
      });

      And("the response has error code {string}", (_, code: string) => {
        const body = response.body as Record<string, unknown>;
        expect(body.code).toBe(code);
      });
    },
  );

  Scenario(
    "Delete non-existent resource returns 404",
    ({ Given, When, Then }) => {
      Given("a mock with the Petstore spec loaded", async () => {
        mock = schmock({ state: {} });
        mock.pipe(
          await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
        );
      });

      When("I delete pet with id 999", async () => {
        response = await mock.handle("DELETE", "/pets/999");
      });

      Then("the response status is 404", () => {
        expect(response.status).toBe(404);
      });
    },
  );

  Scenario(
    "CRUD operations honor contract-declared success statuses",
    ({ Given, When, Then }) => {
      let customId: number;

      Given(
        "a mock with CRUD operations declaring custom success statuses",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: customStatusCrudSpec }));
        },
      );

      When("I create an item under the custom status contract", async () => {
        response = await mock.handle("POST", "/widgets", {
          body: { name: "custom" },
        });
        customId = getNumericProperty(response.body, "widgetId");
      });

      Then("the custom create response has status 202", () => {
        expect(response.status).toBe(202);
      });

      When("I read the item under the custom status contract", async () => {
        response = await mock.handle("GET", `/widgets/${customId}`);
      });

      Then("the custom read response has status 203", () => {
        expect(response.status).toBe(203);
      });

      When("I update the item under the custom status contract", async () => {
        response = await mock.handle("PUT", `/widgets/${customId}`, {
          body: { name: "updated" },
        });
      });

      Then("the custom update response has status 202", () => {
        expect(response.status).toBe(202);
      });

      When("I patch the item under the custom status contract", async () => {
        response = await mock.handle("PATCH", `/widgets/${customId}`, {
          body: { name: "patched" },
        });
      });

      Then("the custom patch response has status 204 without a body", () => {
        expect(response.status).toBe(204);
        expect(response.body).toBeUndefined();
      });

      When("I list items under the custom status contract", async () => {
        response = await mock.handle("GET", "/widgets");
      });

      Then("the custom list response has status 206", () => {
        expect(response.status).toBe(206);
      });

      When("I delete the item under the custom status contract", async () => {
        response = await mock.handle("DELETE", `/widgets/${customId}`);
      });

      Then("the custom delete response has status 200", () => {
        expect(response.status).toBe(200);
      });
    },
  );

  Scenario(
    "A PUT-only item contract does not expose PATCH",
    ({ Given, When, Then, And }) => {
      let widgetId: number;

      Given(
        "a mock with a spec declaring PUT but not PATCH on the item path",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: putOnlyWidgetSpec }));
        },
      );

      When("I create a widget", async () => {
        response = await mock.handle("POST", "/widgets", {
          body: { name: "gadget" },
        });
        widgetId = getNumericProperty(response.body, "widgetId");
      });

      And("I PATCH the widget", async () => {
        response = await mock.handle("PATCH", `/widgets/${widgetId}`, {
          body: { name: "patched" },
        });
      });

      Then("the response status is 404", () => {
        expect(response.status).toBe(404);
      });

      And("the response has error code {string}", (_, code: string) => {
        const body = response.body as Record<string, unknown>;
        expect(body.code).toBe(code);
      });

      When("I PUT the widget", async () => {
        response = await mock.handle("PUT", `/widgets/${widgetId}`, {
          body: { name: "replaced" },
        });
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And(
        "the response header {string} is {string}",
        (_, name: string, value: string) => {
          expect(response.headers[name]).toBe(value);
        },
      );
    },
  );

  Scenario(
    "A PATCH-only item contract does not expose PUT",
    ({ Given, When, Then, And }) => {
      let widgetId: number;

      Given(
        "a mock with a spec declaring PATCH but not PUT on the item path",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: patchOnlyWidgetSpec }));
        },
      );

      When("I create a widget", async () => {
        response = await mock.handle("POST", "/widgets", {
          body: { name: "gadget" },
        });
        widgetId = getNumericProperty(response.body, "widgetId");
      });

      And("I PUT the widget", async () => {
        response = await mock.handle("PUT", `/widgets/${widgetId}`, {
          body: { name: "replaced" },
        });
      });

      Then("the response status is 404", () => {
        expect(response.status).toBe(404);
      });

      And("the response has error code {string}", (_, code: string) => {
        const body = response.body as Record<string, unknown>;
        expect(body.code).toBe(code);
      });

      When("I PATCH the widget", async () => {
        response = await mock.handle("PATCH", `/widgets/${widgetId}`, {
          body: { name: "patched" },
        });
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });
    },
  );

  Scenario(
    "PUT and PATCH keep their own declared response contracts",
    ({ Given, When, Then, And }) => {
      let widgetId: number;

      Given(
        "a mock with a spec declaring PUT 200 with a header and PATCH 204 empty",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: perMethodContractWidgetSpec }));
        },
      );

      When("I create a widget", async () => {
        response = await mock.handle("POST", "/widgets", {
          body: { name: "gadget" },
        });
        widgetId = getNumericProperty(response.body, "widgetId");
      });

      And("I PUT the widget", async () => {
        response = await mock.handle("PUT", `/widgets/${widgetId}`, {
          body: { name: "replaced" },
        });
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And(
        "the response header {string} is {string}",
        (_, name: string, value: string) => {
          expect(response.headers[name]).toBe(value);
        },
      );

      When("I PATCH the widget", async () => {
        response = await mock.handle("PATCH", `/widgets/${widgetId}`, {
          body: { name: "patched" },
        });
      });

      Then("the response status is 204", () => {
        expect(response.status).toBe(204);
      });

      And("the response has no body", () => {
        expect(response.body).toBeUndefined();
      });

      And("the response does not have header {string}", (_, name: string) => {
        expect(response.headers[name]).toBeUndefined();
      });
    },
  );

  Scenario(
    "A Prefer code override does not commit a create",
    ({ Given, When, Then }) => {
      Given("a mock with a transactional pet spec", async () => {
        mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec: transactionalSpec }));
      });

      When("I create a pet forcing the 400 response", async () => {
        response = await mock.handle("POST", "/pets", {
          body: { name: "Buddy" },
          headers: { prefer: "code=400" },
        });
      });

      Then("the transactional response status is 400", () => {
        expect(response.status).toBe(400);
      });

      When("I list the transactional pets", async () => {
        response = await mock.handle("GET", "/pets");
      });

      Then("the transactional list is empty", () => {
        expect(response.body).toEqual([]);
      });
    },
  );

  Scenario(
    "An unacceptable media type does not commit an update",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with a transactional pet spec seeded with one pet",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: transactionalSpec,
              seed: { pets: [{ petId: 1, name: "Buddy" }] },
            }),
          );
        },
      );

      When("I update the seeded pet asking for XML", async () => {
        response = await mock.handle("PUT", "/pets/1", {
          body: { name: "Max" },
          headers: { accept: "application/xml" },
        });
      });

      Then("the transactional response status is 406", () => {
        expect(response.status).toBe(406);
      });

      When("I read the seeded pet", async () => {
        response = await mock.handle("GET", "/pets/1");
      });

      Then("the transactional response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the seeded pet still has name {string}", (_, name: string) => {
        const body = response.body as Record<string, unknown>;
        expect(body.name).toBe(name);
      });
    },
  );

  Scenario(
    "A response validation failure does not commit a delete",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with a transactional pet spec seeded with one pet and response validation",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: transactionalSpec,
              seed: { pets: [{ petId: 1, name: "Buddy" }] },
              validateResponses: true,
            }),
          );
        },
      );

      When("I delete the seeded pet", async () => {
        response = await mock.handle("DELETE", "/pets/1");
      });

      Then("the transactional response status is 500", () => {
        expect(response.status).toBe(500);
      });

      And(
        "the transactional response has error code {string}",
        (_, code: string) => {
          const body = response.body as Record<string, unknown>;
          expect(body.code).toBe(code);
        },
      );

      When("I read the seeded pet", async () => {
        response = await mock.handle("GET", "/pets/1");
      });

      Then("the transactional response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the seeded pet still has name {string}", (_, name: string) => {
        const body = response.body as Record<string, unknown>;
        expect(body.name).toBe(name);
      });

      When("I list the transactional pets", async () => {
        response = await mock.handle("GET", "/pets");
      });

      Then("the transactional list contains {int} item", (_, count: number) => {
        expect(response.body).toHaveLength(count);
      });
    },
  );

  Scenario(
    "Same-named collections at different paths are isolated",
    ({ Given, When, Then }) => {
      Given(
        "a mock with a spec declaring CRUD on two same-named collections",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: scopedSpec }));
        },
      );

      When("I create a user under the root collection", async () => {
        response = await mock.handle("POST", "/users", {
          body: { name: "Alice" },
        });
      });

      Then("the scoped response status is 201", () => {
        expect(response.status).toBe(201);
      });

      When("I list the admin users", async () => {
        response = await mock.handle("GET", "/admins/users");
      });

      Then("the scoped list is empty", () => {
        expect(response.body).toEqual([]);
      });

      When("I list the root users", async () => {
        response = await mock.handle("GET", "/users");
      });

      Then("the scoped list contains {int} item", (_, count: number) => {
        expect(response.body).toHaveLength(count);
      });
    },
  );

  Scenario(
    "Nested collections are isolated per parent id",
    ({ Given, When, Then }) => {
      let nestedPetId: number;

      Given(
        "a mock with a spec declaring CRUD on two same-named collections",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: scopedSpec }));
        },
      );

      When("I create a pet under owner 1", async () => {
        response = await mock.handle("POST", "/owners/1/pets", {
          body: { name: "Buddy" },
        });
        nestedPetId = getNumericProperty(response.body, "petId");
      });

      Then("the scoped response status is 201", () => {
        expect(response.status).toBe(201);
      });

      When("I list the pets of owner 2", async () => {
        response = await mock.handle("GET", "/owners/2/pets");
      });

      Then("the scoped list is empty", () => {
        expect(response.body).toEqual([]);
      });

      When("I list the pets of owner 1", async () => {
        response = await mock.handle("GET", "/owners/1/pets");
      });

      Then("the scoped list contains {int} item", (_, count: number) => {
        expect(response.body).toHaveLength(count);
      });

      When("I read owner 1's pet under owner 2", async () => {
        response = await mock.handle("GET", `/owners/2/pets/${nestedPetId}`);
      });

      Then("the scoped response status is 404", () => {
        expect(response.status).toBe(404);
      });
    },
  );

  Scenario(
    "Methods a CRUD group declares but CRUD cannot serve are still registered",
    ({ Given, When, Then }) => {
      Given(
        "a mock with a spec declaring HEAD on the item path and OPTIONS on the collection",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: extraMethodWidgetSpec }));
        },
      );

      When("I send HEAD to a widget", async () => {
        response = await mock.handle("HEAD", "/widgets/1");
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      When("I send OPTIONS to the widget collection", async () => {
        response = await mock.handle("OPTIONS", "/widgets");
      });

      Then("the response status is 204", () => {
        expect(response.status).toBe(204);
      });
    },
  );

  Scenario(
    "Schema overrides apply before CRUD detection and seeding",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with the Petstore spec, a list schema override and a generated seed",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: `${fixturesDir}/petstore-openapi3.json`,
              schemas: {
                "GET /pets": {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["petId", "nickname"],
                    properties: {
                      petId: { type: "integer" },
                      nickname: { type: "string" },
                    },
                  },
                },
              },
              seed: { pets: { count: 2 } },
            }),
          );
        },
      );

      When("I list all pets", async () => {
        response = await mock.handle("GET", "/pets");
      });

      Then("the list contains 2 seeded pets", () => {
        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(2);
      });

      And("every seeded pet has property {string}", (_, property: string) => {
        for (const item of response.body as Record<string, unknown>[]) {
          expect(item).toHaveProperty(property);
        }
      });

      And("no seeded pet has property {string}", (_, property: string) => {
        for (const item of response.body as Record<string, unknown>[]) {
          expect(item).not.toHaveProperty(property);
        }
      });
    },
  );

  Scenario(
    "Create returns the declared response contract",
    ({ Given, When, Then, And }) => {
      let created: Record<string, unknown>;

      Given(
        "a mock with a spec whose create declares a full item contract",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: contractThingSpec }));
        },
      );

      When("I create a thing labelled {string}", async (_, label: string) => {
        response = await mock.handle("POST", "/things", { body: { label } });
        created = response.body as Record<string, unknown>;
      });

      Then("the created thing has a string {string}", (_, key: string) => {
        expect(response.status).toBe(201);
        expect(typeof created[key]).toBe("string");
      });

      And("the created thing has property {string}", (_, key: string) => {
        expect(created).toHaveProperty(key);
      });

      And("the created thing has no property {string}", (_, key: string) => {
        expect(created).not.toHaveProperty(key);
      });

      When("I read the created thing by its returned id", async () => {
        response = await mock.handle("GET", `/things/${created.id}`);
      });

      Then("the contract read response has status 200", () => {
        expect(response.status).toBe(200);
      });
    },
  );

  Scenario(
    "onSchema is invoked for CRUD responses",
    ({ Given, When, Then, And }) => {
      const seen: Array<Record<string, unknown>> = [];

      Given(
        "a mock with the Petstore OpenAPI 3 spec and a recording onSchema callback",
        async () => {
          seen.length = 0;
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: `${fixturesDir}/petstore-openapi3.json`,
              onSchema: (schema, context) => {
                seen.push({ ...context });
                return {
                  ...schema,
                  properties: {
                    ...(schema.properties ?? {}),
                    generatedBy: { type: "string", const: "onSchema" },
                  },
                };
              },
            }),
          );
        },
      );

      When(
        "I create a pet named {string} through the recording mock",
        async (_, name: string) => {
          response = await mock.handle("POST", "/pets", { body: { name } });
        },
      );

      Then(
        "the onSchema callback recorded method {string} on path {string}",
        (_, method: string, path: string) => {
          expect(seen).toContainEqual(
            expect.objectContaining({ method, path }),
          );
        },
      );

      And(
        "the onSchema callback context carried params, query and headers",
        () => {
          const call = seen.find((c) => c.method === "POST");
          expect(call).toBeDefined();
          expect(call?.params).toBeDefined();
          expect(call?.query).toBeDefined();
          expect(call?.headers).toBeDefined();
        },
      );

      And(
        "the created pet has property {string} equal to {string}",
        (_, key: string, value: string) => {
          expect(response.status).toBe(201);
          expect(response.body).toHaveProperty(key, value);
        },
      );
    },
  );

  Scenario(
    "CRUD responses honor the negotiated media type",
    ({ Given, When, Then }) => {
      Given(
        "a mock with a spec whose widget list declares JSON and XML contracts",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: mediaTypeWidgetSpec }));
        },
      );

      When("I list widgets accepting {string}", async (_, accept: string) => {
        response = await mock.handle("GET", "/widgets", {
          headers: { accept },
        });
      });

      Then("the negotiated list body comes from the XML branch", () => {
        expect(response.status).toBe(200);
        const body = response.body as Record<string, unknown>;
        expect(body.kind).toBe("xml");
        expect(body.data).toEqual([]);
      });
    },
  );
});
