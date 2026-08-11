import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect, vi } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature(
  "../../features/openapi-plugin-scope.feature",
);

const jsonObject = {
  type: "object",
  properties: { id: { type: "integer" }, name: { type: "string" } },
};

/** Spec with GLOBAL security — the source of the 401 leak onto foreign routes. */
const securedItemsSpec = {
  openapi: "3.0.3",
  info: { title: "Secured", version: "1.0.0" },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/items": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: jsonObject } },
          },
          "404": {
            description: "Missing",
            content: { "application/json": { schema: jsonObject } },
          },
        },
      },
    },
  },
};

/**
 * Second spec with NO security, on a path disjoint from `securedItemsSpec`:
 * the builder drops a duplicate method+path with "first registration wins", so
 * overlapping paths would test deduplication rather than ownership.
 */
const unsecuredThingsSpec = {
  openapi: "3.0.3",
  info: { title: "Unsecured", version: "1.0.0" },
  paths: {
    "/things": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: jsonObject } },
          },
        },
      },
    },
  },
};

const orderCallbackSpec = {
  openapi: "3.0.3",
  info: { title: "Orders", version: "1.0.0" },
  paths: {
    "/orders": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  item: { type: "string" },
                  callbackUrl: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: { "application/json": { schema: jsonObject } },
          },
        },
        callbacks: {
          orderStatus: {
            "{$request.body#/callbackUrl}": {
              post: {
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { status: { type: "string" } },
                      },
                    },
                  },
                },
                responses: { "200": { description: "OK" } },
              },
            },
          },
        },
      },
    },
  },
};

/**
 * Declares exactly one request media type, so `validateRequests: true` makes
 * the plugin's own route answer 415 for anything else — and carries global
 * security so an unguarded plugin would 401 the manual route before it ever
 * got as far as the media type. Both halves of the ownership guard are then
 * load-bearing: without it the manual POST answers 401, not 200.
 */
const validatingPostSpec = {
  openapi: "3.0.3",
  info: { title: "Validating", version: "1.0.0" },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/spec-items": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: { "application/json": { schema: jsonObject } },
          },
        },
      },
    },
  },
};

const notificationsSpec = {
  openapi: "3.0.3",
  info: { title: "Notifications", version: "1.0.0" },
  paths: {
    "/notifications": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: jsonObject } },
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
    "A manually registered route is untouched by the OpenAPI plugin",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with a secured spec and a manually registered route",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: securedItemsSpec, security: true }));
          mock("GET /manual", () => ({ ok: true }));
        },
      );

      When("I request the manual route without credentials", async () => {
        response = await mock.handle("GET", "/manual");
      });

      Then("the scope response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the scope response body is the manual payload", () => {
        expect(response.body).toEqual({ ok: true });
      });

      When("I request the spec route without credentials", async () => {
        response = await mock.handle("GET", "/items");
      });

      Then("the scope response status is 401", () => {
        expect(response.status).toBe(401);
      });
    },
  );

  Scenario(
    "Two OpenAPI plugins do not cross-apply security",
    ({ Given, When, Then }) => {
      Given(
        "a mock piping a secured spec and an unsecured spec on disjoint paths",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: securedItemsSpec, security: true }));
          mock.pipe(
            await openapi({ spec: unsecuredThingsSpec, security: true }),
          );
        },
      );

      When(
        "I request the unsecured plugin's route without credentials",
        async () => {
          response = await mock.handle("GET", "/things");
        },
      );

      Then("the scope response status is 200", () => {
        expect(response.status).toBe(200);
      });

      When(
        "I request the secured plugin's route without credentials",
        async () => {
          response = await mock.handle("GET", "/items");
        },
      );

      Then("the scope response status is 401", () => {
        expect(response.status).toBe(401);
      });
    },
  );

  Scenario(
    "A second OpenAPI plugin does not dispatch another plugin's callbacks",
    ({ Given, When, Then, And }) => {
      const dispatch = vi.fn(async () => undefined);

      Given(
        "a mock piping a callback-declaring spec and a second spec owning the dispatcher",
        async () => {
          dispatch.mockClear();
          mock = schmock({ state: {} });
          // Plugin A owns POST /orders and its callback, but has no dispatcher.
          mock.pipe(await openapi({ spec: orderCallbackSpec }));
          // Plugin B owns the dispatcher but a disjoint spec with no callbacks.
          mock.pipe(
            await openapi({
              spec: notificationsSpec,
              callbacks: { dispatch },
            }),
          );
        },
      );

      When("I post an order with a callback url", async () => {
        response = await mock.handle("POST", "/orders", {
          body: { item: "widget", callbackUrl: "https://example.test/hook" },
        });
      });

      Then("the scope response status is 201", () => {
        expect(response.status).toBe(201);
      });

      And("the callback dispatcher was never called", () => {
        expect(dispatch).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "Request media type checks do not reach a manually registered route",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with a validating spec and a manually registered POST route",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: validatingPostSpec,
              validateRequests: true,
              security: true,
            }),
          );
          mock("POST /manual", () => ({ ok: true }));
        },
      );

      When(
        "I post to the manual route with an undeclared content type",
        async () => {
          response = await mock.handle("POST", "/manual", {
            body: "id,name\n1,manual",
            headers: { "content-type": "text/csv" },
          });
        },
      );

      Then("the scope response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the scope response body is the manual payload", () => {
        expect(response.body).toEqual({ ok: true });
      });

      When(
        "I post to the spec route with an undeclared content type",
        async () => {
          // Credentials supplied on purpose: the point is the 415, not the 401
          // the same request would earn without them.
          response = await mock.handle("POST", "/spec-items", {
            body: "id,name\n1,spec",
            headers: {
              "content-type": "text/csv",
              authorization: "Bearer test-token",
            },
          });
        },
      );

      Then("the scope response status is 415", () => {
        expect(response.status).toBe(415);
      });
    },
  );

  Scenario(
    "Prefer header is ignored on non-OpenAPI routes",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with a secured spec and a manually registered route",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(await openapi({ spec: securedItemsSpec, security: true }));
          mock("GET /manual", () => ({ ok: true }));
        },
      );

      When(
        "I request the manual route with header prefer code 404",
        async () => {
          response = await mock.handle("GET", "/manual", {
            headers: { prefer: "code=404" },
          });
        },
      );

      Then("the scope response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the scope response body is the manual payload", () => {
        expect(response.body).toEqual({ ok: true });
      });
    },
  );
});
