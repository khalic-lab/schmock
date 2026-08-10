import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";

const feature = await loadFeature("../../features/lifecycle-events.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let events: Array<{ type: string; data: unknown }>;
  let removedFired: boolean;

  function collectEvent(type: string) {
    return (data: unknown) => {
      events.push({ type, data });
    };
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function eventData(type: string): Record<string, unknown> {
    const event = events.find((candidate) => candidate.type === type);
    expect(event).toBeDefined();
    if (!event || !isRecord(event.data)) {
      throw new Error(`Expected object payload for ${type}`);
    }
    return event.data;
  }

  Scenario("Events fire at correct times", ({ Given, And, When, Then }) => {
    Given('a mock with a route "GET /items"', () => {
      mock = schmock({ state: {} });
      mock("GET /items", [{ id: 1 }], {});
    });

    And("I register listeners for all events", () => {
      events = [];
      mock.on("request:start", collectEvent("request:start"));
      mock.on("request:match", collectEvent("request:match"));
      mock.on("request:notfound", collectEvent("request:notfound"));
      mock.on("request:end", collectEvent("request:end"));
    });

    When('I request "GET /items"', async () => {
      await mock.handle("GET", "/items");
    });

    Then("the event order should be {string}", (_, expectedOrder: string) => {
      expect(events.map((event) => event.type)).toEqual(
        expectedOrder.split(","),
      );
    });

    And('the "request:match" event fired with routePath "/items"', () => {
      expect(eventData("request:match").routePath).toBe("/items");
    });

    And('the "request:end" event fired with status 200', () => {
      expect(eventData("request:end").status).toBe(200);
    });
  });

  Scenario(
    "Not found event fires for unmatched routes",
    ({ Given, And, When, Then }) => {
      Given('a mock with a route "GET /items"', () => {
        mock = schmock({ state: {} });
        mock("GET /items", [{ id: 1 }], {});
      });

      And("I register listeners for all events", () => {
        events = [];
        mock.on("request:start", collectEvent("request:start"));
        mock.on("request:match", collectEvent("request:match"));
        mock.on("request:notfound", collectEvent("request:notfound"));
        mock.on("request:end", collectEvent("request:end"));
      });

      When('I request "GET /missing"', async () => {
        await mock.handle("GET", "/missing");
      });

      Then("the event order should be {string}", (_, expectedOrder: string) => {
        expect(events.map((event) => event.type)).toEqual(
          expectedOrder.split(","),
        );
      });

      And('the "request:end" event fired with status 404', () => {
        expect(eventData("request:end").status).toBe(404);
      });
    },
  );

  function registerAllListeners() {
    events = [];
    mock.on("request:start", collectEvent("request:start"));
    mock.on("request:match", collectEvent("request:match"));
    mock.on("request:notfound", collectEvent("request:notfound"));
    mock.on("request:end", collectEvent("request:end"));
  }

  function expectEventOrder(expectedOrder: string) {
    expect(events.map((event) => event.type)).toEqual(expectedOrder.split(","));
  }

  function expectEveryEventPath(path: string) {
    expect(
      events.map((event) => (event.data as { path: string }).path),
    ).toEqual(events.map(() => path));
  }

  Scenario(
    "Out-of-namespace requests still report a route miss",
    ({ Given, And, When, Then }) => {
      Given('a namespaced mock with a route "GET /users"', () => {
        mock = schmock({ namespace: "/api" });
        mock("GET /users", [{ id: 1 }]);
      });

      And("I register listeners for all events", registerAllListeners);

      When('I request "GET /other/users"', async () => {
        await mock.handle("GET", "/other/users");
      });

      Then("the event order should be {string}", (_, expectedOrder: string) => {
        expectEventOrder(expectedOrder);
      });

      And("every event carried the path {string}", (_, path: string) => {
        expectEveryEventPath(path);
      });
    },
  );

  Scenario(
    "Namespaced events carry the original request path",
    ({ Given, And, When, Then }) => {
      Given('a namespaced mock with a route "GET /users"', () => {
        mock = schmock({ namespace: "/api" });
        mock("GET /users", [{ id: 1 }]);
      });

      And("I register listeners for all events", registerAllListeners);

      When('I request "GET /api/users"', async () => {
        await mock.handle("GET", "/api/users");
      });

      Then("the event order should be {string}", (_, expectedOrder: string) => {
        expectEventOrder(expectedOrder);
      });

      And("every event carried the path {string}", (_, path: string) => {
        expectEveryEventPath(path);
      });

      And('the "request:match" event fired with routePath "/users"', () => {
        expect(eventData("request:match").routePath).toBe("/users");
      });
    },
  );

  Scenario(
    "A failing request ends with the original path",
    ({ Given, And, When, Then }) => {
      Given('a namespaced mock with a throwing route "GET /boom"', () => {
        mock = schmock({ namespace: "/api" });
        mock("GET /boom", () => {
          throw new Error("generator exploded");
        });
      });

      And("I register listeners for all events", registerAllListeners);

      When('I request "GET /api/boom"', async () => {
        await mock.handle("GET", "/api/boom");
      });

      Then("the event order should be {string}", (_, expectedOrder: string) => {
        expectEventOrder(expectedOrder);
      });

      And("every event carried the path {string}", (_, path: string) => {
        expectEveryEventPath(path);
      });

      And('the "request:end" event fired with status 500', () => {
        expect(eventData("request:end").status).toBe(500);
      });
    },
  );

  Scenario("Off removes listener", ({ Given, And, When, Then }) => {
    Given('a mock with a route "GET /items"', () => {
      mock = schmock({ state: {} });
      mock("GET /items", [{ id: 1 }], {});
    });

    And("I register and remove a listener", () => {
      removedFired = false;
      const listener = () => {
        removedFired = true;
      };
      mock.on("request:start", listener);
      mock.off("request:start", listener);
    });

    When('I request "GET /items"', async () => {
      await mock.handle("GET", "/items");
    });

    Then("the removed listener did not fire", () => {
      expect(removedFired).toBe(false);
    });
  });

  Scenario("Reset clears all listeners", ({ Given, And, When, Then }) => {
    Given('a mock with a route "GET /items"', () => {
      mock = schmock({ state: {} });
      mock("GET /items", [{ id: 1 }], {});
    });

    And("I register listeners for all events", () => {
      events = [];
      mock.on("request:start", collectEvent("request:start"));
      mock.on("request:end", collectEvent("request:end"));
    });

    When("I reset the mock", () => {
      mock.reset();
      events = [];
    });

    And('I add a route "GET /items" again', () => {
      mock("GET /items", [{ id: 1 }], {});
    });

    And('I request "GET /items" after reset', async () => {
      await mock.handle("GET", "/items");
    });

    Then("no events were collected after reset", () => {
      expect(events).toHaveLength(0);
    });
  });

  Scenario(
    "Throwing listeners do not alter request handling",
    ({ Given, When, Then, And }) => {
      let response: Schmock.Response;
      let endCount = 0;
      const healthyEvents: string[] = [];

      Given(
        "a successful route with throwing and healthy lifecycle listeners",
        () => {
          mock = schmock();
          mock("GET /listener-isolation", { ok: true });
          mock.on("request:start", () => {
            throw new Error("start listener failed");
          });
          mock.on("request:start", () => {
            healthyEvents.push("start");
          });
          mock.on("request:end", () => {
            endCount += 1;
            healthyEvents.push("end");
          });
          mock.on("request:end", () => {
            throw new Error("end listener failed");
          });
        },
      );

      When("I request the listener isolation route", async () => {
        response = await mock.handle("GET", "/listener-isolation");
      });

      Then(
        "the listener isolation response status should be {int}",
        (_, status: number) => {
          expect(response.status).toBe(status);
        },
      );

      And("the healthy listeners should still fire in order", () => {
        expect(healthyEvents).toEqual(["start", "end"]);
      });

      And("request end should fire exactly once", () => {
        expect(endCount).toBe(1);
      });
    },
  );

  Scenario(
    "Lifecycle payloads are observational snapshots",
    ({ Given, And, When, Then }) => {
      let response: Schmock.Response;

      Given(
        "a parameterized route that reports its headers and parameters",
        () => {
          mock = schmock();
          mock("GET /observed/:id", ({ headers, params }) => ({
            source: headers["x-source"],
            id: params.id,
          }));
        },
      );

      And(
        "lifecycle listeners attempt to change headers and parameters",
        () => {
          mock.on("request:start", (data) => {
            Reflect.set(data.headers, "x-source", "listener");
          });
          mock.on("request:match", (data) => {
            Reflect.set(data.params, "id", "listener");
          });
        },
      );

      When(
        "I request the observational route with original values",
        async () => {
          response = await mock.handle("GET", "/observed/original", {
            headers: { "x-source": "original" },
          });
        },
      );

      Then(
        "the generator should receive the original header and parameter",
        () => {
          expect(response.body).toEqual({ source: "original", id: "original" });
        },
      );
    },
  );

  Scenario(
    "Listener changes take effect on the next event",
    ({ Given, When, Then }) => {
      let addedListenerCalls = 0;
      let registered = false;

      Given("a listener that registers another start listener", () => {
        mock = schmock();
        mock("GET /listener-snapshot", { ok: true });
        const addedListener = () => {
          addedListenerCalls += 1;
        };
        mock.on("request:start", () => {
          if (!registered) {
            registered = true;
            mock.on("request:start", addedListener);
          }
        });
      });

      When("I request the listener snapshot route twice", async () => {
        await mock.handle("GET", "/listener-snapshot");
        await mock.handle("GET", "/listener-snapshot");
      });

      Then(
        "the added listener should skip the first request and run on the second",
        () => {
          expect(addedListenerCalls).toBe(1);
        },
      );
    },
  );
});
