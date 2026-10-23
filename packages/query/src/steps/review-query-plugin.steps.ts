import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { type QueryPluginOptions, queryPlugin } from "../index";

const feature = await loadFeature("../../features/review-query-plugin.feature");

function captureError(create: () => unknown): unknown {
  try {
    create();
  } catch (error) {
    return error;
  }
  return undefined;
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

const ERROR_ITEMS = [{ msg: "a" }, { msg: "b" }];

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;
  let creationError: unknown;

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

  // ── Sorting defaults (review 2026-10-23) ─────────────────────────────────

  function defaultSortedRoute(field: string, names: string[]): void {
    mock = schmock();
    mock(
      "GET /names",
      names.map((name) => ({ [field]: name })),
    ).pipe(
      queryPlugin({
        sorting: { allowed: [field], default: field, defaultOrder: "desc" },
      }),
    );
  }

  ScenarioOutline(
    "A sort or order value the plugin cannot use falls back to the configured defaults",
    ({ Given, When, Then }, variables) => {
      Given(
        "a route sorted by {string} descending by default with items {string}, {string} and {string}",
        (_, field: string, first: string, second: string, third: string) => {
          defaultSortedRoute(field, [first, second, third]);
        },
      );

      When(
        "I request the default-sorted route with sort {string} and order {string}",
        async () => {
          response = await mock.handle("GET", "/names", {
            query: { sort: variables.sort, order: variables.order },
          });
        },
      );

      Then(
        "the default-sorted names should be {string}, {string} and {string}",
        (_, first: string, second: string, third: string) => {
          expect(response.body).toEqual([
            { n: first },
            { n: second },
            { n: third },
          ]);
        },
      );
    },
  );

  Scenario(
    "An empty sort and order fall back to the configured defaults",
    ({ Given, When, Then }) => {
      Given(
        "a route sorted by {string} descending by default with items {string}, {string} and {string}",
        (_, field: string, first: string, second: string, third: string) => {
          defaultSortedRoute(field, [first, second, third]);
        },
      );

      When(
        "I request the default-sorted route with sort {string} and order {string}",
        async (_, sort: string, order: string) => {
          response = await mock.handle("GET", "/names", {
            query: { sort, order },
          });
        },
      );

      Then(
        "the default-sorted names should be {string}, {string} and {string}",
        (_, first: string, second: string, third: string) => {
          expect(response.body).toEqual([
            { n: first },
            { n: second },
            { n: third },
          ]);
        },
      );
    },
  );
});
