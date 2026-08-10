import { request as nodeRequest } from "node:http";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock, toRouteKey } from "../index";

const feature = await loadFeature("../../features/standalone-server.feature");

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance;
  let serverInfo: Schmock.ServerInfo;
  let httpResponse: Response;
  let pendingStart: Promise<Schmock.ServerInfo>;
  let secondListenError: unknown;
  let jsonRouteExecutions = 0;

  AfterEachScenario(() => {
    mock?.close();
  });

  function baseUrl(): string {
    return `http://${serverInfo.hostname}:${serverInfo.port}`;
  }

  function sendChunkedRequest(
    path: string,
    chunks: readonly Uint8Array[],
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      let responseStarted = false;
      const request = nodeRequest(
        {
          hostname: serverInfo.hostname,
          port: serverInfo.port,
          path,
          method: "POST",
          headers: { "content-type": "text/plain" },
        },
        (incoming) => {
          responseStarted = true;
          const responseChunks: Uint8Array[] = [];
          incoming.on("data", (chunk: Uint8Array) => {
            responseChunks.push(chunk);
          });
          incoming.on("error", reject);
          incoming.on("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (typeof value === "string") headers.set(name, value);
              if (Array.isArray(value)) headers.set(name, value.join(", "));
            }
            resolve(
              new Response(Buffer.concat(responseChunks), {
                status: incoming.statusCode ?? 500,
                headers,
              }),
            );
          });
        },
      );
      request.on("error", (error) => {
        if (!responseStarted) reject(error);
      });
      for (const chunk of chunks) request.write(chunk);
      request.end();
    });
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
      await expect(fetch(`${baseUrl()}/hello`)).rejects.toBeDefined();
    });
  });

  Scenario("Handle POST with JSON body", ({ Given, When, Then, And }) => {
    Given("I create a mock echoing POST at {string}", (_, path: string) => {
      mock = schmock();
      mock(toRouteKey("POST", path), ({ body }) => body);
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

  Scenario(
    "Close permits an immediate restart on the same port",
    ({ Given, When, And, Then }) => {
      Given("I create a mock with a GET /hello route", () => {
        mock = schmock();
        mock("GET /hello", { message: "hello" });
      });

      When("I start the server on a random port", async () => {
        serverInfo = await mock.listen(0);
      });

      And("I stop and immediately restart on the same port", async () => {
        const port = serverInfo.port;
        mock.close();
        serverInfo = await mock.listen(port);
      });

      Then(
        "the restarted server should return the hello response",
        async () => {
          const response = await fetch(`${baseUrl()}/hello`);
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ message: "hello" });
        },
      );
    },
  );

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
      await expect(fetch(`${baseUrl()}/hello`)).rejects.toBeDefined();
    });
  });

  Scenario(
    "A pending start reserves the server",
    ({ Given, When, Then, And }) => {
      Given("I create a mock with a GET /hello route", () => {
        mock = schmock();
        mock("GET /hello", { message: "hello" });
      });

      When("I call listen twice before the first call settles", () => {
        pendingStart = mock.listen(0);
        try {
          void mock.listen(0);
        } catch (error) {
          secondListenError = error;
        }
      });

      Then(
        "the second listen call should fail with code {string}",
        (_, expectedCode: string) => {
          expect(secondListenError).toMatchObject({ code: expectedCode });
        },
      );

      And(
        "the pending start should resolve to one reachable server",
        async () => {
          serverInfo = await pendingStart;
          const response = await fetch(`${baseUrl()}/hello`);
          expect(response.status).toBe(200);
        },
      );
    },
  );

  Scenario(
    "Reset cancels a pending server start",
    ({ Given, When, Then, And }) => {
      Given("I create a mock with a GET /hello route", () => {
        mock = schmock();
        mock("GET /hello", { message: "hello" });
      });

      When("I start and immediately reset the server", () => {
        pendingStart = mock.listen(0);
        void pendingStart.catch(() => undefined);
        mock.reset();
      });

      Then(
        "the pending start should reject with code {string}",
        async (_, expectedCode: string) => {
          await expect(pendingStart).rejects.toMatchObject({
            code: expectedCode,
          });
        },
      );

      And(
        "listening again after route registration should succeed",
        async () => {
          mock("GET /hello", { message: "again" });
          serverInfo = await mock.listen(0);
          const response = await fetch(`${baseUrl()}/hello`);
          expect(response.status).toBe(200);
        },
      );
    },
  );

  Scenario(
    "Oversized chunked requests receive a structured client error",
    ({ Given, When, And, Then }) => {
      Given(
        "I create a mock that accepts POST requests at {string}",
        (_, path: string) => {
          mock = schmock();
          const route = toRouteKey("POST", path);
          mock(route, { accepted: true });
          mock("GET /health", { healthy: true });
        },
      );

      When("I start the server on a random port", async () => {
        serverInfo = await mock.listen(0);
      });

      And(
        "I stream an oversized chunked request to {string}",
        async (_, path: string) => {
          const chunk = new Uint8Array(1024 * 1024);
          httpResponse = await sendChunkedRequest(
            path,
            Array.from({ length: 11 }, () => chunk),
          );
        },
      );

      Then("the HTTP response status should be {int}", (_, status: number) => {
        expect(httpResponse.status).toBe(status);
      });

      And(
        "the HTTP response error code should be {string}",
        async (_, code: string) => {
          expect(await httpResponse.json()).toMatchObject({ code });
        },
      );

      And("the server should accept a valid request afterward", async () => {
        const response = await fetch(`${baseUrl()}/health`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ healthy: true });
      });
    },
  );

  Scenario(
    "Malformed JSON is rejected before route execution",
    ({ Given, When, And, Then }) => {
      Given(
        "I create a tracked JSON echo route at {string}",
        (_, path: string) => {
          jsonRouteExecutions = 0;
          mock = schmock();
          const route = toRouteKey("POST", path);
          mock(route, ({ body }) => {
            jsonRouteExecutions += 1;
            return body;
          });
        },
      );

      When("I start the server on a random port", async () => {
        serverInfo = await mock.listen(0);
      });

      And("I send malformed JSON to {string}", async (_, path: string) => {
        httpResponse = await fetch(`${baseUrl()}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"broken":',
        });
      });

      Then("the HTTP response status should be {int}", (_, status: number) => {
        expect(httpResponse.status).toBe(status);
      });

      And(
        "the HTTP response error code should be {string}",
        async (_, code: string) => {
          expect(await httpResponse.json()).toMatchObject({ code });
        },
      );

      And("the JSON route should not have executed or entered history", () => {
        expect(jsonRouteExecutions).toBe(0);
        expect(mock.history()).toHaveLength(0);
      });
    },
  );

  Scenario(
    "JSON media types are matched case-insensitively",
    ({ Given, When, And, Then }) => {
      Given(
        "I create a tracked JSON echo route at {string}",
        (_, path: string) => {
          jsonRouteExecutions = 0;
          mock = schmock();
          const route = toRouteKey("POST", path);
          mock(route, ({ body }) => {
            jsonRouteExecutions += 1;
            return body;
          });
        },
      );

      When("I start the server on a random port", async () => {
        serverInfo = await mock.listen(0);
      });

      And(
        "I send valid JSON with mixed-case media type to {string}",
        async (_, path: string) => {
          httpResponse = await fetch(`${baseUrl()}${path}`, {
            method: "POST",
            headers: { "content-type": "Application/JSON; Charset=UTF-8" },
            body: JSON.stringify({ valid: true }),
          });
        },
      );

      Then(
        "the echoed JSON property {string} should be true",
        async (_, property: string) => {
          expect(await httpResponse.json()).toMatchObject({ [property]: true });
          expect(jsonRouteExecutions).toBe(1);
        },
      );
    },
  );
});
