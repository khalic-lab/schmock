import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { queryPlugin } from "../index";

const feature = await loadFeature("../../features/query-plugin.feature");

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${description} to be an object`);
  }
  return value;
}

function requireRecordArray(
  value: unknown,
  description: string,
): Record<string, unknown>[] {
  if (!isUnknownArray(value)) {
    throw new Error(`Expected ${description} to be an array`);
  }
  return value.map((item) => requireRecord(item, `${description} item`));
}

function requirePaginatedBody(response: Schmock.Response) {
  const body = requireRecord(response.body, "paginated response body");
  return {
    data: requireRecordArray(body.data, "paginated response data"),
    pagination: requireRecord(body.pagination, "pagination metadata"),
  };
}

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;

  // Generate test data
  const generateItems = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      name: `Item ${i + 1}`,
    }));

  const namedItems = [
    { id: 1, name: "Charlie" },
    { id: 2, name: "Alice" },
    { id: 3, name: "Bob" },
  ];

  const categorizedItems = [
    { id: 1, name: "Alice", role: "admin" },
    { id: 2, name: "Bob", role: "user" },
    { id: 3, name: "Charlie", role: "admin" },
    { id: 4, name: "Dave", role: "user" },
    { id: 5, name: "Eve", role: "moderator" },
  ];

  Scenario(
    "Basic pagination with default settings",
    ({ Given, When, Then, And }) => {
      Given("I create a mock with 25 items and pagination plugin", () => {
        mock = schmock();
        mock("GET /items", generateItems(25)).pipe(
          queryPlugin({
            pagination: { defaultLimit: 10, maxLimit: 100 },
          }),
        );
      });

      When("I request page 1", async () => {
        response = await mock.handle("GET", "/items", {
          query: { page: "1" },
        });
      });

      Then("I should receive {int} items", (_, count: number) => {
        expect(requirePaginatedBody(response).data).toHaveLength(count);
      });

      And("the pagination total should be {int}", (_, total: number) => {
        expect(requirePaginatedBody(response).pagination.total).toBe(total);
      });

      And(
        "the pagination totalPages should be {int}",
        (_, totalPages: number) => {
          expect(requirePaginatedBody(response).pagination.totalPages).toBe(
            totalPages,
          );
        },
      );
    },
  );

  Scenario("Pagination with custom limit", ({ Given, When, Then, And }) => {
    Given("I create a mock with 25 items and pagination plugin", () => {
      mock = schmock();
      mock("GET /items", generateItems(25)).pipe(
        queryPlugin({
          pagination: { defaultLimit: 10, maxLimit: 100 },
        }),
      );
    });

    When("I request page 1 with limit 5", async () => {
      response = await mock.handle("GET", "/items", {
        query: { page: "1", limit: "5" },
      });
    });

    Then("I should receive {int} items", (_, count: number) => {
      expect(requirePaginatedBody(response).data).toHaveLength(count);
    });

    And(
      "the pagination totalPages should be {int}",
      (_, totalPages: number) => {
        expect(requirePaginatedBody(response).pagination.totalPages).toBe(
          totalPages,
        );
      },
    );
  });

  Scenario("Sort items ascending by name", ({ Given, When, Then, And }) => {
    Given("I create a mock with named items and sorting plugin", () => {
      mock = schmock();
      mock("GET /items", namedItems).pipe(
        queryPlugin({
          sorting: { allowed: ["name", "id"], default: "id" },
        }),
      );
    });

    When(
      "I request with sort {string} order {string}",
      async (_, sort: string, order: string) => {
        response = await mock.handle("GET", "/items", {
          query: { sort, order },
        });
      },
    );

    Then("the first item name should be {string}", (_, name: string) => {
      const items = requireRecordArray(response.body, "sorted response body");
      expect(items.at(0)?.name).toBe(name);
    });

    And("the last item name should be {string}", (_, name: string) => {
      const items = requireRecordArray(response.body, "sorted response body");
      expect(items.at(-1)?.name).toBe(name);
    });
  });

  Scenario("Sort items descending by name", ({ Given, When, Then, And }) => {
    Given("I create a mock with named items and sorting plugin", () => {
      mock = schmock();
      mock("GET /items", namedItems).pipe(
        queryPlugin({
          sorting: { allowed: ["name", "id"], default: "id" },
        }),
      );
    });

    When(
      "I request with sort {string} order {string}",
      async (_, sort: string, order: string) => {
        response = await mock.handle("GET", "/items", {
          query: { sort, order },
        });
      },
    );

    Then("the first item name should be {string}", (_, name: string) => {
      const items = requireRecordArray(response.body, "sorted response body");
      expect(items.at(0)?.name).toBe(name);
    });

    And("the last item name should be {string}", (_, name: string) => {
      const items = requireRecordArray(response.body, "sorted response body");
      expect(items.at(-1)?.name).toBe(name);
    });
  });

  Scenario("Filter items by field value", ({ Given, When, Then, And }) => {
    Given("I create a mock with categorized items and filtering plugin", () => {
      mock = schmock();
      mock("GET /items", categorizedItems).pipe(
        queryPlugin({
          filtering: { allowed: ["role"] },
        }),
      );
    });

    When("I request with filter role {string}", async (_, role: string) => {
      response = await mock.handle("GET", "/items", {
        query: { "filter[role]": role },
      });
    });

    Then("I should receive {int} filtered items", (_, count: number) => {
      expect(
        requireRecordArray(response.body, "filtered response body"),
      ).toHaveLength(count);
    });

    And("all items should have role {string}", (_, role: string) => {
      const items = requireRecordArray(response.body, "filtered response body");
      for (const item of items) {
        expect(item.role).toBe(role);
      }
    });
  });

  Scenario(
    "Combined pagination, sorting, and filtering",
    ({ Given, When, Then, And }) => {
      const users = [
        { id: 1, name: "Dave", role: "admin" },
        { id: 2, name: "Alice", role: "user" },
        { id: 3, name: "Charlie", role: "admin" },
        { id: 4, name: "Bob", role: "admin" },
        { id: 5, name: "Eve", role: "user" },
        { id: 6, name: "Frank", role: "admin" },
        { id: 7, name: "Grace", role: "user" },
        { id: 8, name: "Hank", role: "admin" },
        { id: 9, name: "Ivy", role: "user" },
        { id: 10, name: "Jack", role: "admin" },
        { id: 11, name: "Karen", role: "user" },
        { id: 12, name: "Leo", role: "admin" },
        { id: 13, name: "Mona", role: "user" },
        { id: 14, name: "Nate", role: "admin" },
        { id: 15, name: "Olivia", role: "user" },
        { id: 16, name: "Paul", role: "admin" },
        { id: 17, name: "Quinn", role: "user" },
        { id: 18, name: "Rose", role: "admin" },
        { id: 19, name: "Sam", role: "user" },
        { id: 20, name: "Tina", role: "admin" },
      ];

      Given("I create a mock with 20 users and full query plugin", () => {
        mock = schmock();
        mock("GET /users", users).pipe(
          queryPlugin({
            pagination: { defaultLimit: 10, maxLimit: 100 },
            sorting: { allowed: ["name", "id"] },
            filtering: { allowed: ["role"] },
          }),
        );
      });

      When(
        "I request page 1 with limit 2 filter role {string} and sort {string}",
        async (_, role: string, sort: string) => {
          response = await mock.handle("GET", "/users", {
            query: { page: "1", limit: "2", "filter[role]": role, sort },
          });
        },
      );

      Then("I should receive {int} items", (_, count: number) => {
        expect(requirePaginatedBody(response).data).toHaveLength(count);
      });

      And("the items should be sorted by name ascending", () => {
        const names = requirePaginatedBody(response).data.map((item) => {
          if (typeof item.name !== "string") {
            throw new Error(
              "Expected each paginated item to have a string name",
            );
          }
          return item.name;
        });
        const sorted = [...names].sort();
        expect(names).toEqual(sorted);
      });

      And("all items should have role {string}", (_, role: string) => {
        for (const item of requirePaginatedBody(response).data) {
          expect(item.role).toBe(role);
        }
      });

      And("the pagination total should reflect filtered count", () => {
        // 11 admins in the dataset
        expect(requirePaginatedBody(response).pagination.total).toBe(11);
      });
    },
  );

  ScenarioOutline(
    "Paginate array response containers without losing metadata",
    ({ Given, When, Then, And }, variables) => {
      Given("I create a mock returning 5 items in a {string} response", () => {
        mock = schmock();
        const headers = { "x-query-source": variables.container };
        if (variables.container === "tuple") {
          mock(
            "GET /items",
            () =>
              [206, generateItems(5), headers] satisfies [
                number,
                unknown,
                Record<string, string>,
              ],
          );
        } else if (variables.container === "structured") {
          mock("GET /items", () => ({
            status: 206,
            body: generateItems(5),
            headers,
          }));
        } else {
          throw new Error(
            `Unsupported query response container: ${variables.container}`,
          );
        }
        mock.pipe(
          queryPlugin({
            pagination: { defaultLimit: 10, maxLimit: 100 },
          }),
        );
      });

      When("I request page 2 with limit 2", async () => {
        response = await mock.handle("GET", "/items", {
          query: { page: "2", limit: "2" },
        });
      });

      Then("the response status should be 206", () => {
        expect(response.status).toBe(206);
      });

      And(
        "response header {string} should be {string}",
        (_, header: string) => {
          expect(response.headers[header]).toBe(variables.container);
        },
      );

      And("I should receive 2 items", () => {
        expect(requirePaginatedBody(response).data).toHaveLength(2);
      });

      And("the pagination total should be 5", () => {
        expect(requirePaginatedBody(response).pagination.total).toBe(5);
      });
    },
  );
});
