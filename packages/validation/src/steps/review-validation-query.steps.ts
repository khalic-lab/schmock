import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
// @schmock/validation does not depend on @schmock/query, so the query plugin
// is imported from its sources for the combined review scenarios.
import { type QueryPluginOptions, queryPlugin } from "../../../query/src/index";
import { type ValidationPluginOptions, validationPlugin } from "../index";

const feature = await loadFeature(
  "../../features/review-validation-query.feature",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyRecord(response: Schmock.Response): Record<string, unknown> {
  if (!isRecord(response.body)) {
    throw new Error("Expected the response body to be an object");
  }
  return response.body;
}

function captureError(create: () => unknown): unknown {
  try {
    create();
  } catch (error) {
    return error;
  }
  return undefined;
}

function unauthorizedGuard(): Schmock.Plugin {
  return {
    name: "auth-guard",
    beforeRequest(context) {
      if (context.headers.authorization === undefined) {
        return { context, response: [401, { error: "unauthorized" }] };
      }
      return { context };
    },
    process(context, incomingResponse) {
      return { context, response: incomingResponse };
    },
  };
}

function rejectingGuard(response: unknown): Schmock.Plugin {
  return {
    name: "rejecting-guard",
    beforeRequest(context) {
      return { context, response };
    },
    process(context, incomingResponse) {
      return { context, response: incomingResponse };
    },
  };
}

type ResponseRules = NonNullable<ValidationPluginOptions["response"]>;

const objectWithIdAndName: ResponseRules["body"] = {
  type: "object",
  required: ["id", "name"],
  properties: { id: { type: "integer" }, name: { type: "string" } },
};

const ERROR_ITEMS = [{ msg: "a" }, { msg: "b" }];

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;
  let creationError: unknown;

  // ── Response validation scope (findings 38, 88) ─────────────────────────

  Scenario(
    "A 2xx-scoped response schema lets another plugin's rejection through",
    ({ Given, When, Then, And }) => {
      Given(
        "a guard that rejects unauthenticated requests with 401 before a 2xx-scoped array response schema",
        () => {
          mock = schmock();
          mock("GET /users", [{ id: 1 }])
            .pipe(unauthorizedGuard())
            .pipe(
              validationPlugin({
                response: { body: { type: "array" }, statuses: "2xx" },
              }),
            );
        },
      );

      When("I request the guarded list without credentials", async () => {
        response = await mock.handle("GET", "/users");
      });

      Then("the scoped response status should be {int}", (_, status) => {
        expect(response.status).toBe(status);
      });

      And(
        "the scoped response body should have error {string}",
        (_, error: string) => {
          expect(bodyRecord(response).error).toBe(error);
        },
      );
    },
  );

  Scenario(
    "A 2xx-scoped response schema leaves a route's error tuple alone",
    ({ Given, When, Then, And }) => {
      Given(
        "a route that returns a 404 tuple under a 2xx-scoped object response schema",
        () => {
          mock = schmock();
          mock("GET /users/:id", ({ params }) =>
            params.id === "1"
              ? { id: 1, name: "Ada" }
              : [404, { error: "not found" }],
          ).pipe(
            validationPlugin({
              response: { body: objectWithIdAndName, statuses: "2xx" },
            }),
          );
        },
      );

      When("I request a user that does not exist", async () => {
        response = await mock.handle("GET", "/users/2");
      });

      Then("the scoped response status should be {int}", (_, status) => {
        expect(response.status).toBe(status);
      });

      And(
        "the scoped response body should have error {string}",
        (_, error: string) => {
          expect(bodyRecord(response).error).toBe(error);
        },
      );
    },
  );

  Scenario(
    "A 2xx-scoped response schema still rejects an invalid success body",
    ({ Given, When, Then, And }) => {
      Given(
        "a route that returns an invalid success body under a 2xx-scoped object response schema",
        () => {
          mock = schmock();
          mock("GET /users/:id", { id: "not-a-number" }).pipe(
            validationPlugin({
              response: { body: objectWithIdAndName, statuses: "2xx" },
            }),
          );
        },
      );

      When("I request the invalid success body", async () => {
        response = await mock.handle("GET", "/users/1");
      });

      Then("the scoped response status should be {int}", (_, status) => {
        expect(response.status).toBe(status);
      });

      And(
        "the scoped response body should have code {string}",
        (_, code: string) => {
          expect(bodyRecord(response).code).toBe(code);
        },
      );
    },
  );

  Scenario(
    "An explicit status list validates only the listed statuses",
    ({ Given, When, Then, And }) => {
      let okResponse: Schmock.Response;
      let createdResponse: Schmock.Response;

      Given(
        "a response schema scoped to status 201 on routes answering 200 and 201 with invalid bodies",
        () => {
          mock = schmock();
          mock("GET /ok", { unexpected: true });
          mock("POST /created", () => [201, { unexpected: true }]);
          mock.pipe(
            validationPlugin({
              response: { body: objectWithIdAndName, statuses: [201] },
            }),
          );
        },
      );

      When("I request both scoped routes", async () => {
        okResponse = await mock.handle("GET", "/ok");
        createdResponse = await mock.handle("POST", "/created");
      });

      Then("the 200 route should answer 200 unchanged", () => {
        expect(okResponse.status).toBe(200);
        expect(okResponse.body).toEqual({ unexpected: true });
      });

      And(
        "the 201 route should answer 500 with code {string}",
        (_, code: string) => {
          expect(createdResponse.status).toBe(500);
          expect(bodyRecord(createdResponse).code).toBe(code);
        },
      );
    },
  );

  Scenario(
    "An invalid response status scope fails during plugin creation",
    ({ When, Then }) => {
      When(
        "I create a validation plugin with response statuses {string}",
        (_, statuses: string) => {
          const responseRules: ResponseRules = { body: { type: "object" } };
          Reflect.set(responseRules, "statuses", statuses);
          const options: ValidationPluginOptions = { response: responseRules };
          creationError = captureError(() => validationPlugin(options));
        },
      );

      Then(
        "plugin creation should fail with code {string}",
        (_, code: string) => {
          expect(creationError).toMatchObject({
            code,
            context: { option: "response.statuses", received: "3xx" },
          });
        },
      );
    },
  );

  // ── Header name case (finding 86) ────────────────────────────────────────

  Scenario(
    "A capitalized optional header property still enforces its constraints",
    ({ Given, When, Then, And }) => {
      Given(
        "a header schema with an optional {string} property of at least 8 characters",
        (_, name: string) => {
          mock = schmock();
          mock("GET /secure", { ok: true }).pipe(
            validationPlugin({
              request: {
                headers: {
                  type: "object",
                  properties: { [name]: { type: "string", minLength: 8 } },
                },
              },
            }),
          );
        },
      );

      When(
        "I send header {string} with value {string}",
        async (_, name: string, value: string) => {
          response = await mock.handle("GET", "/secure", {
            headers: { [name]: value },
          });
        },
      );

      Then("the header response status should be {int}", (_, status) => {
        expect(response.status).toBe(status);
      });

      And(
        "the header response body should have code {string}",
        (_, code: string) => {
          expect(bodyRecord(response).code).toBe(code);
        },
      );
    },
  );

  Scenario(
    "A capitalized required header property accepts a matching header",
    ({ Given, When, Then }) => {
      Given(
        "a header schema that requires an {string} property of at least 8 characters",
        (_, name: string) => {
          mock = schmock();
          mock("GET /secure", { ok: true }).pipe(
            validationPlugin({
              request: {
                headers: {
                  type: "object",
                  properties: { [name]: { type: "string", minLength: 8 } },
                  required: [name],
                },
              },
            }),
          );
        },
      );

      When(
        "I send header {string} with value {string}",
        async (_, name: string, value: string) => {
          response = await mock.handle("GET", "/secure", {
            headers: { [name]: value },
          });
        },
      );

      Then("the header response status should be {int}", (_, status) => {
        expect(response.status).toBe(status);
      });
    },
  );

  Scenario(
    "Header properties that differ only by case fail during plugin creation",
    ({ When, Then }) => {
      When(
        "I create a header schema with both {string} and {string} properties",
        (_, first: string, second: string) => {
          creationError = captureError(() =>
            validationPlugin({
              request: {
                headers: {
                  type: "object",
                  properties: {
                    [first]: { type: "string" },
                    [second]: { type: "string" },
                  },
                },
              },
            }),
          );
        },
      );

      Then(
        "plugin creation should fail with code {string}",
        (_, code: string) => {
          expect(creationError).toMatchObject({
            code,
            context: { option: "request.headers" },
          });
        },
      );
    },
  );

  // ── Query and header coercion (finding 87) ───────────────────────────────

  Scenario(
    "An integer query schema accepts a numeric query string",
    ({ Given, When, Then, And }) => {
      let receivedPage: unknown;

      Given("a query schema requiring an integer page of at least 1", () => {
        receivedPage = undefined;
        mock = schmock();
        mock("GET /items", ({ query }) => {
          receivedPage = query.page;
          return [{ id: 1 }];
        }).pipe(
          validationPlugin({
            request: {
              query: {
                type: "object",
                properties: { page: { type: "integer", minimum: 1 } },
              },
            },
          }),
        );
      });

      When(
        "I request the coerced list with query page {string}",
        async (_, page: string) => {
          response = await mock.handle("GET", "/items", { query: { page } });
        },
      );

      Then("the coerced response status should be {int}", (_, status) => {
        expect(response.status).toBe(status);
      });

      And(
        "the route should have received page as the string {string}",
        (_, page: string) => {
          expect(receivedPage).toBe(page);
        },
      );
    },
  );

  Scenario(
    "An integer query schema still rejects a non-numeric query string",
    ({ Given, When, Then, And }) => {
      Given("a query schema requiring an integer page of at least 1", () => {
        mock = schmock();
        mock("GET /items", [{ id: 1 }]).pipe(
          validationPlugin({
            request: {
              query: {
                type: "object",
                properties: { page: { type: "integer", minimum: 1 } },
              },
            },
          }),
        );
      });

      When(
        "I request the coerced list with query page {string}",
        async (_, page: string) => {
          response = await mock.handle("GET", "/items", { query: { page } });
        },
      );

      Then("the coerced response status should be {int}", (_, status) => {
        expect(response.status).toBe(status);
      });

      And(
        "the coerced response body should have code {string}",
        (_, code: string) => {
          expect(bodyRecord(response).code).toBe(code);
        },
      );
    },
  );

  Scenario(
    "An integer header schema accepts a numeric header value",
    ({ Given, When, Then }) => {
      Given(
        "a header schema requiring an integer {string} header",
        (_, name: string) => {
          mock = schmock();
          mock("GET /secure", { ok: true }).pipe(
            validationPlugin({
              request: {
                headers: {
                  type: "object",
                  properties: { [name]: { type: "integer" } },
                  required: [name],
                },
              },
            }),
          );
        },
      );

      When(
        "I send header {string} with value {string}",
        async (_, name: string, value: string) => {
          response = await mock.handle("GET", "/secure", {
            headers: { [name]: value },
          });
        },
      );

      Then("the header response status should be {int}", (_, status) => {
        expect(response.status).toBe(status);
      });
    },
  );

  // ── Query plugin on error responses (finding 40) ─────────────────────────

  Scenario(
    "A route's 4xx error array is not paginated",
    ({ Given, When, Then, And }) => {
      Given(
        "a paginated route that returns a 400 tuple with two error items",
        () => {
          mock = schmock();
          mock("GET /errors", () => [400, ERROR_ITEMS]).pipe(
            queryPlugin({ pagination: { defaultLimit: 1 } }),
          );
        },
      );

      When("I request the paginated error route", async () => {
        response = await mock.handle("GET", "/errors");
      });

      Then("the paginated response status should be {int}", (_, status) => {
        expect(response.status).toBe(status);
      });

      And(
        "the paginated response body should be the two unwrapped error items",
        () => {
          expect(response.body).toEqual(ERROR_ITEMS);
        },
      );
    },
  );

  Scenario(
    "A guard's 4xx rejection array is not paginated",
    ({ Given, When, Then, And }) => {
      Given(
        "a guard that rejects with a 422 tuple of two error items before a paginating query plugin",
        () => {
          mock = schmock();
          mock("GET /errors", [{ id: 1 }, { id: 2 }])
            .pipe(rejectingGuard([422, ERROR_ITEMS]))
            .pipe(queryPlugin({ pagination: { defaultLimit: 1 } }));
        },
      );

      When("I request the paginated error route", async () => {
        response = await mock.handle("GET", "/errors");
      });

      Then("the paginated response status should be {int}", (_, status) => {
        expect(response.status).toBe(status);
      });

      And(
        "the paginated response body should be the two unwrapped error items",
        () => {
          expect(response.body).toEqual(ERROR_ITEMS);
        },
      );
    },
  );

  // ── Query option validation and order case (finding 90) ──────────────────

  Scenario(
    "A default sort field outside the allowed list fails during plugin creation",
    ({ When, Then }) => {
      When(
        "I create a query plugin whose default sort field {string} is not in the allowed list",
        (_, field: string) => {
          creationError = captureError(() =>
            queryPlugin({ sorting: { allowed: ["name"], default: field } }),
          );
        },
      );

      Then(
        "plugin creation should fail with code {string}",
        (_, code: string) => {
          expect(creationError).toMatchObject({
            code,
            context: { option: "sorting.default", received: "nme" },
          });
        },
      );
    },
  );

  Scenario(
    "An unknown default sort order fails during plugin creation",
    ({ When, Then }) => {
      When(
        "I create a query plugin with default sort order {string}",
        (_, order: string) => {
          const sorting = { allowed: ["name"] };
          Reflect.set(sorting, "defaultOrder", order);
          const options: QueryPluginOptions = { sorting };
          creationError = captureError(() => queryPlugin(options));
        },
      );

      Then(
        "plugin creation should fail with code {string}",
        (_, code: string) => {
          expect(creationError).toMatchObject({
            code,
            context: { option: "sorting.defaultOrder", received: "DESC" },
          });
        },
      );
    },
  );

  Scenario(
    "The order query value is matched case-insensitively",
    ({ Given, When, Then }) => {
      Given(
        "a sortable route with items {string} and {string}",
        (_, first: string, second: string) => {
          mock = schmock();
          mock("GET /names", [{ n: first }, { n: second }]).pipe(
            queryPlugin({ sorting: { allowed: ["n"] } }),
          );
        },
      );

      When(
        "I request the sortable route with order {string}",
        async (_, order: string) => {
          response = await mock.handle("GET", "/names", {
            query: { sort: "n", order },
          });
        },
      );

      Then(
        "the sorted names should be {string} then {string}",
        (_, first: string, second: string) => {
          expect(response.body).toEqual([{ n: first }, { n: second }]);
        },
      );
    },
  );
});
