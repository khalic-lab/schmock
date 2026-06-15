import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";

const feature = await loadFeature("../../features/audit-core-builder.feature");

describeFeature(feature, ({ Scenario }) => {
  // ── FIX 1.2: defineRoute must shallow-clone the config ───────────────────

  Scenario(
    "defineRoute does not mutate the caller's config object",
    ({ Given, When, Then }) => {
      let sharedConfig: Schmock.RouteConfig;
      let mock: Schmock.CallableMockInstance;

      Given("a shared config object with no contentType", () => {
        sharedConfig = {};
      });

      When("I register two routes with the same config object", () => {
        mock = schmock();
        mock("GET /route1", { name: "route1" }, sharedConfig);
        mock("GET /route2", { name: "route2" }, sharedConfig);
      });

      Then(
        "the shared config object remains unchanged after registration",
        () => {
          expect(Object.keys(sharedConfig)).toHaveLength(0);
        },
      );
    },
  );

  Scenario(
    "Mutating a returned config does not affect the registered route",
    ({ Given, When, Then, And }) => {
      let singleConfig: Schmock.RouteConfig;
      let mock: Schmock.CallableMockInstance;

      Given("a single config object with no contentType", () => {
        singleConfig = {};
      });

      When("I register one route with that config object", () => {
        mock = schmock();
        mock("GET /item", { value: 99 }, singleConfig);
      });

      And("I mutate the config object after registration", () => {
        singleConfig.status = 503;
        singleConfig.contentType = "text/html";
      });

      Then(
        "the registered route still responds with application/json content type",
        async () => {
          const response = await mock.handle("GET", "/item");
          expect(response.status).toBe(200);
          const ct =
            response.headers?.["content-type"] ??
            response.headers?.["Content-Type"];
          expect(ct).toContain("application/json");
        },
      );
    },
  );

  // ── FIX 2.2: duplicate route detection must normalize trailing slash ──────

  Scenario(
    "Trailing-slash path is treated as duplicate",
    ({ Given, And, Then }) => {
      let mock: Schmock.CallableMockInstance;

      Given("a fresh mock instance", () => {
        mock = schmock();
      });

      And("I register GET /users without trailing slash", () => {
        mock("GET /users", [{ id: 1 }], {});
      });

      And("I register GET /users with trailing slash", () => {
        mock("GET /users/", [{ id: 2 }], {});
      });

      Then("only one route exists for GET /users", () => {
        const routes = mock.getRoutes();
        const userRoutes = routes.filter(
          (r) =>
            r.method === "GET" && (r.path === "/users" || r.path === "/users/"),
        );
        expect(userRoutes).toHaveLength(1);
      });
    },
  );

  // ── FIX 3.3: reset()/resetState() must not mutate caller's state ─────────

  Scenario(
    "reset() does not mutate the caller's state object",
    ({ Given, When, Then, And }) => {
      let externalState: Record<string, unknown>;
      let mock: Schmock.CallableMockInstance;

      Given('a mock with external state containing key "a" equal to 1', () => {
        externalState = { a: 1 };
        mock = schmock({ state: externalState });
      });

      When("I call mock reset", () => {
        mock.reset();
      });

      Then('the external state still has key "a" equal to 1', () => {
        expect(externalState).toEqual({ a: 1 });
      });

      And("the mock internal state is empty", () => {
        expect(mock.getState()).toEqual({});
      });
    },
  );

  Scenario(
    "resetState() does not mutate the caller's state object",
    ({ Given, When, Then, And }) => {
      let externalState: Record<string, unknown>;
      let mock: Schmock.CallableMockInstance;

      Given('a mock with external state containing key "b" equal to 2', () => {
        externalState = { b: 2 };
        mock = schmock({ state: externalState });
      });

      When("I call mock resetState", () => {
        mock.resetState();
      });

      Then('the external state still has key "b" equal to 2', () => {
        expect(externalState).toEqual({ b: 2 });
      });

      And("the mock internal state is empty after resetState", () => {
        expect(mock.getState()).toEqual({});
      });
    },
  );

  // ── FIX 2.3: history()/lastRequest() must return deep clones ─────────────

  Scenario(
    "history() returns deep clones of request records",
    ({ Given, When, Then, And }) => {
      let mock: Schmock.CallableMockInstance;

      Given("a fresh mock with a route returning a nested body", () => {
        mock = schmock();
        mock("GET /data", { nested: { value: "original" } }, {});
      });

      When("I handle that route once", async () => {
        await mock.handle("GET", "/data");
      });

      And("I mutate the response body of the first history record", () => {
        const records = mock.history();
        expect(records).toHaveLength(1);
        const body = records[0].response.body as { nested: { value: string } };
        body.nested.value = "MUTATED";
      });

      Then("history returns the original body unchanged", () => {
        const records = mock.history();
        const body = records[0].response.body as { nested: { value: string } };
        expect(body.nested.value).toBe("original");
      });

      And("lastRequest returns the original body unchanged", () => {
        const last = mock.lastRequest();
        if (!last) throw new Error("expected a record");
        const body = last.response.body as { nested: { value: string } };
        expect(body.nested.value).toBe("original");
      });
    },
  );
});
