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

  Scenario(
    "Default shared state persists across requests",
    ({ Given, When, Then, And }) => {
      let mock: Schmock.CallableMockInstance;
      let responses: Schmock.Response[];

      Given("a mock with no configured state and an incrementing route", () => {
        mock = schmock();
        mock("GET /counter", ({ state }) => {
          const counter =
            typeof state.counter === "number" ? state.counter + 1 : 1;
          state.counter = counter;
          return { counter };
        });
      });

      When("I request the default-state route twice", async () => {
        responses = [
          await mock.handle("GET", "/counter"),
          await mock.handle("GET", "/counter"),
        ];
      });

      Then("the counter responses should be 1 and 2", () => {
        expect(responses.map((response) => response.body)).toEqual([
          { counter: 1 },
          { counter: 2 },
        ]);
      });

      And("the mock shared counter state should be 2", () => {
        expect(mock.getState().counter).toBe(2);
      });
    },
  );

  Scenario(
    "A matched route whose generator throws is recorded in history",
    ({ Given, When, Then, And }) => {
      let mock: Schmock.CallableMockInstance;
      let failure: Schmock.Response;

      Given(
        "a mock with a healthy route and a route whose generator throws",
        () => {
          mock = schmock();
          mock("GET /ok", { ok: true });
          mock("GET /boom", () => {
            throw new Error("generator exploded");
          });
        },
      );

      When(
        "I request the healthy route and then the throwing route",
        async () => {
          await mock.handle("GET", "/ok");
          failure = await mock.handle("GET", "/boom");
        },
      );

      Then(
        "the throwing request should be recorded in history with status 500",
        () => {
          expect(failure.status).toBe(500);
          const records = mock.history("GET", "/boom");
          expect(records).toHaveLength(1);
          expect(records[0].response.status).toBe(500);
          expect(mock.history()).toHaveLength(2);
        },
      );

      And("the call count for the throwing route should be 1", () => {
        expect(mock.callCount("GET", "/boom")).toBe(1);
      });
    },
  );

  Scenario(
    "A failing route honours its own delay override",
    ({ Given, When, Then }) => {
      let mock: Schmock.CallableMockInstance;
      let response: Schmock.Response;
      let elapsed = 0;

      Given(
        "a mock with a global delay and a slower failing route override",
        () => {
          mock = schmock({ delay: 0 });
          mock(
            "GET /slow-boom",
            () => {
              throw new Error("generator exploded");
            },
            { delay: 120 },
          );
        },
      );

      When("I request the failing route", async () => {
        const started = performance.now();
        response = await mock.handle("GET", "/slow-boom");
        elapsed = performance.now() - started;
      });

      Then("the failing response should be 500 after the route delay", () => {
        expect(response.status).toBe(500);
        expect(elapsed).toBeGreaterThanOrEqual(100);
      });
    },
  );

  Scenario(
    "Resetting state does not replace state on the caller config",
    ({ Given, When, Then, And }) => {
      let config: Schmock.GlobalConfig;
      let externalState: Record<string, unknown>;
      let mock: Schmock.CallableMockInstance;

      Given("a caller config containing external state", () => {
        externalState = { preserved: true };
        config = { state: externalState };
      });

      When("I create a mock from the config and reset its state", () => {
        mock = schmock(config);
        mock.resetState();
      });

      Then(
        "the caller config should still reference the external state",
        () => {
          expect(config.state).toBe(externalState);
        },
      );

      And("the mock internal state is empty after resetState", () => {
        expect(mock.getState()).toEqual({});
      });
    },
  );
});
