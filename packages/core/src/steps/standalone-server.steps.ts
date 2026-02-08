import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";

const feature = await loadFeature("../../features/standalone-server.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let serverInfo: Schmock.ServerInfo;
  let httpResponse: Response;

  function baseUrl(): string {
    return `http://${serverInfo.hostname}:${serverInfo.port}`;
  }

  Scenario("Start and stop a simple server", ({ Given, When, Then, And }) => {
    Given("I create a mock with a GET /hello route", () => {
      mock = schmock();
      mock("GET /hello", { message: "hello" });
    });

    When("I start the server on a random port", async () => {
      serverInfo = await mock.listen(0);
    });

    Then("the server should be running", () => {
      expect(serverInfo.port).toBeGreaterThan(0);
    });

    When("I fetch {string} from the server", async (_, route: string) => {
      const [, path] = route.split(" ");
      httpResponse = await fetch(`${baseUrl()}${path}`);
    });

    Then("the HTTP response status should be {int}", (_, status: number) => {
      expect(httpResponse.status).toBe(status);
    });

    And(
      "the HTTP response body should have {string} equal to {string}",
      async (_, key: string, value: string) => {
        const body = await httpResponse.json();
        expect(body[key]).toBe(value);
      },
    );

    When("I stop the server", () => {
      mock.close();
    });

    Then("the server should not be running", async () => {
      try {
        await fetch(`${baseUrl()}/hello`);
        expect.unreachable("Should not be able to connect");
      } catch {
        // Connection refused — server is down
      }
    });
  });

  Scenario("Handle POST with JSON body", ({ Given, When, Then, And }) => {
    Given("I create a mock echoing POST at {string}", (_, path: string) => {
      mock = schmock();
      mock(`POST ${path}`, ({ body }) => body);
    });

    When("I start the server on a random port", async () => {
      serverInfo = await mock.listen(0);
    });

    And(
      "I fetch {string} with JSON body:",
      async (_, route: string, docString: string) => {
        const [method, path] = route.split(" ");
        httpResponse = await fetch(`${baseUrl()}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: docString,
        });
      },
    );

    Then(
      "the response status from POST should be {int}",
      (_, status: number) => {
        expect(httpResponse.status).toBe(status);
      },
    );

    And(
      "the response body from POST should have {string} equal to {string}",
      async (_, key: string, value: string) => {
        const body = await httpResponse.json();
        expect(body[key]).toBe(value);
      },
    );

    When("I stop the server", () => {
      mock.close();
    });
  });

  Scenario(
    "Return 404 for unregistered routes",
    ({ Given, When, And, Then }) => {
      Given("I create a mock with a GET /hello route", () => {
        mock = schmock();
        mock("GET /hello", { message: "hello" });
      });

      When("I start the server on a random port", async () => {
        serverInfo = await mock.listen(0);
      });

      And("I fetch {string} from the server", async (_, route: string) => {
        const [, path] = route.split(" ");
        httpResponse = await fetch(`${baseUrl()}${path}`);
      });

      Then("the HTTP response status should be {int}", (_, status: number) => {
        expect(httpResponse.status).toBe(status);
      });

      When("I stop the server", () => {
        mock.close();
      });
    },
  );

  Scenario("Query parameters are forwarded", ({ Given, When, And, Then }) => {
    let parsedBody: Record<string, string>;

    Given(
      "I create a mock reflecting query params at {string}",
      (_, route: string) => {
        const [method, path] = route.split(" ");
        mock = schmock();
        mock(`${method} ${path}` as Schmock.RouteKey, ({ query }) => query);
      },
    );

    When("I start the server on a random port", async () => {
      serverInfo = await mock.listen(0);
    });

    And("I fetch {string} from the server", async (_, route: string) => {
      const [, pathWithQuery] = route.split(" ");
      httpResponse = await fetch(`${baseUrl()}${pathWithQuery}`);
      parsedBody = await httpResponse.json();
    });

    Then("the HTTP response status should be {int}", (_, status: number) => {
      expect(httpResponse.status).toBe(status);
    });

    And(
      "the HTTP response body should have {string} equal to {string}",
      (_, key: string, value: string) => {
        expect(parsedBody[key]).toBe(value);
      },
    );

    And(
      "the query param {string} should equal {string}",
      (_, key: string, value: string) => {
        expect(parsedBody[key]).toBe(value);
      },
    );

    When("I stop the server", () => {
      mock.close();
    });
  });

  Scenario("Double listen throws an error", ({ Given, When, Then }) => {
    Given("I create a mock with a GET /hello route", () => {
      mock = schmock();
      mock("GET /hello", { message: "hello" });
    });

    When("I start the server on a random port", async () => {
      serverInfo = await mock.listen(0);
    });

    Then("starting the server again should throw", () => {
      expect(() => mock.listen(0)).toThrow("Server is already running");
      mock.close();
    });
  });

  Scenario("Close is idempotent", ({ Given, When, And, Then }) => {
    Given("I create a mock with a GET /hello route", () => {
      mock = schmock();
      mock("GET /hello", { message: "hello" });
    });

    When("I start the server on a random port", async () => {
      serverInfo = await mock.listen(0);
    });

    And("I stop the server", () => {
      mock.close();
    });

    Then("stopping the server again should not throw", () => {
      expect(() => mock.close()).not.toThrow();
    });
  });

  Scenario("Reset stops the server", ({ Given, When, And, Then }) => {
    Given("I create a mock with a GET /hello route", () => {
      mock = schmock();
      mock("GET /hello", { message: "hello" });
    });

    When("I start the server on a random port", async () => {
      serverInfo = await mock.listen(0);
    });

    And("I reset the mock", () => {
      mock.reset();
    });

    Then("the server should not be running", async () => {
      try {
        await fetch(`${baseUrl()}/hello`);
        expect.unreachable("Should not be able to connect");
      } catch {
        // Connection refused — server is down
      }
    });
  });
});
