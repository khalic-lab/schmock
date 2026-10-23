import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";
import {
  RouteDefinitionError,
  schmock,
  toHttpMethod,
  toRouteKey,
} from "../index";

const feature = await loadFeature(
  "../../features/review-core-responses.feature",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(request: string): {
  method: Schmock.HttpMethod;
  path: string;
} {
  const [methodText = "", path = ""] = request.split(" ");
  return { method: toHttpMethod(methodText), path };
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance | undefined;
  let intercept: Schmock.InterceptHandle | undefined;
  let fetched: Response | undefined;
  let handled: Schmock.Response | undefined;
  let thrown: unknown;
  let endStatuses: number[] = [];
  let statuses: number[] = [];
  let logCalls: unknown[][] = [];
  let logLines: string[] = [];

  AfterEachScenario(() => {
    intercept?.restore();
    intercept = undefined;
    mock = undefined;
    fetched = undefined;
    handled = undefined;
    thrown = undefined;
    endStatuses = [];
    statuses = [];
    logCalls = [];
    logLines = [];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Keep debug output off the console, recording each console.log call. */
  function captureDebugConsole(): void {
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logCalls.push(args);
      logLines.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "time").mockImplementation(() => {});
    vi.spyOn(console, "timeEnd").mockImplementation(() => {});
  }

  function currentMock(): Schmock.CallableMockInstance {
    if (!mock) throw new Error("scenario did not create a mock");
    return mock;
  }

  function currentResponse(): Response {
    if (!fetched) throw new Error("scenario did not fetch anything");
    return fetched;
  }

  function currentHandled(): Schmock.Response {
    if (!handled) throw new Error("scenario did not handle a request");
    return handled;
  }

  async function handleRequest(request: string): Promise<void> {
    const { method, path } = parseRequest(request);
    handled = await currentMock().handle(method, path);
    statuses.push(handled.status);
  }

  function expectStatusAndCode(status: number, code: string): void {
    const response = currentHandled();
    expect(response.status).toBe(status);
    expect(isRecord(response.body) ? response.body.code : undefined).toBe(code);
  }

  async function fetchThroughIntercept(path: string): Promise<void> {
    intercept = currentMock().intercept({ passthrough: false });
    fetched = await fetch(`http://localhost${path}`);
  }

  // ── Response bodies ────────────────────────────────────────────────────

  Scenario(
    "A route returning a Date sends a JSON string literal",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock whose route "GET /time" returns the Date 1970-01-01T00:00:00.000Z',
        () => {
          mock = schmock();
          mock("GET /time", () => new Date(0));
        },
      );

      When('I fetch "/time" through intercept', async () => {
        await fetchThroughIntercept("/time");
      });

      Then('the response content type is "application/json"', () => {
        expect(currentResponse().headers.get("content-type")).toBe(
          "application/json",
        );
      });

      And(
        'the response body parses as the JSON string "1970-01-01T00:00:00.000Z"',
        async () => {
          const parsed: unknown = JSON.parse(await currentResponse().text());
          expect(parsed).toBe("1970-01-01T00:00:00.000Z");
        },
      );
    },
  );

  Scenario(
    "A plugin that returns a replaced route object sets the response content type",
    ({ Given, And, When, Then }) => {
      Given(
        'a mock whose route "GET /doc" returns an object with a equal to 1',
        () => {
          mock = schmock();
          mock("GET /doc", () => ({ a: 1 }));
        },
      );

      And(
        "a plugin whose process returns a copy of the route with content type {string}",
        (_, contentType: string) => {
          currentMock().pipe({
            name: "route-replacer",
            process: (context, upstream) => ({
              context: { ...context, route: { ...context.route, contentType } },
              response: upstream,
            }),
          });
        },
      );

      When("I request {string}", async (_, request: string) => {
        await handleRequest(request);
      });

      Then(
        "the response content type header is {string}",
        (_, contentType: string) => {
          expect(currentHandled().headers["content-type"]).toBe(contentType);
        },
      );

      And("the response body is that object's JSON text", () => {
        expect(currentHandled().body).toBe(JSON.stringify({ a: 1 }));
      });
    },
  );

  Scenario(
    "A text/plain route rejects an object body a JSON route would reject",
    ({ Given, When, Then }) => {
      Given(
        'a mock whose text/plain route "GET /note" returns an object with an undefined field',
        () => {
          mock = schmock();
          mock("GET /note", () => ({ title: "draft", author: undefined }), {
            contentType: "text/plain",
          });
        },
      );

      When("I request {string}", async (_, request: string) => {
        await handleRequest(request);
      });

      Then(
        "I receive status {int} with code {string}",
        (_, status: number, code: string) => {
          expectStatusAndCode(status, code);
        },
      );
    },
  );

  // ── Error paths ────────────────────────────────────────────────────────

  Scenario(
    "A route throwing an Error without a string message still answers a JSON 500",
    ({ Given, And, When, Then }) => {
      Given(
        'a mock whose route "GET /broken" throws an Error whose message is undefined',
        () => {
          mock = schmock();
          mock("GET /broken", () => {
            const error = new Error("replaced");
            Object.defineProperty(error, "message", { value: undefined });
            throw error;
          });
        },
      );

      And("a request:end listener", () => {
        currentMock().on("request:end", (event) => {
          endStatuses.push(event.status);
        });
      });

      When("I request {string}", async (_, request: string) => {
        await handleRequest(request);
      });

      Then(
        "I receive status {int} with code {string}",
        (_, status: number, code: string) => {
          expectStatusAndCode(status, code);
        },
      );

      And("the response error is the string {string}", (_, message: string) => {
        const { body } = currentHandled();
        expect(isRecord(body) ? body.error : undefined).toBe(message);
      });

      And(
        "exactly one request:end with status {int} was emitted",
        (_, status: number) => {
          expect(endStatuses).toEqual([status]);
        },
      );
    },
  );

  Scenario(
    "An error formatter can read a non-Error value a route threw",
    ({ Given, And, When, Then }) => {
      Given(
        'a mock whose route "GET /quota" throws a plain object with reason {string}',
        (_, reason: string) => {
          mock = schmock();
          mock("GET /quota", () => {
            throw { reason };
          });
        },
      );

      And(
        "an intercept with an error formatter that returns the error's cause",
        () => {
          intercept = currentMock().intercept({
            passthrough: false,
            errorFormatter: (error) => error.cause,
          });
        },
      );

      When('I fetch "/quota" through that intercept', async () => {
        fetched = await fetch("http://localhost/quota");
      });

      Then("the fetched status is {int}", (_, status: number) => {
        expect(currentResponse().status).toBe(status);
      });

      And(
        "the fetched body is the thrown object with reason {string}",
        async (_, reason: string) => {
          expect(await currentResponse().json()).toEqual({ reason });
        },
      );
    },
  );

  // ── Fetch interception ─────────────────────────────────────────────────

  Scenario(
    "An AbortError a hook throws on a live request reaches the error formatter",
    ({ Given, And, When, Then }) => {
      Given("a mock with a route {string}", (_, route: string) => {
        const { method, path } = parseRequest(route);
        mock = schmock();
        mock(toRouteKey(method, path), [{ id: 1 }]);
      });

      And(
        "an intercept whose beforeRequest throws its own AbortError {string} and whose error formatter returns the message",
        (_, message: string) => {
          intercept = currentMock().intercept({
            passthrough: false,
            beforeRequest: () => {
              throw new DOMException(message, "AbortError");
            },
            errorFormatter: (error) => ({ formatted: error.message }),
          });
        },
      );

      When(
        "I fetch {string} through that intercept",
        async (_, path: string) => {
          fetched = await fetch(`http://localhost${path}`);
        },
      );

      Then("the fetched status is {int}", (_, status: number) => {
        expect(currentResponse().status).toBe(status);
      });

      And(
        "the fetched body carries the formatted message {string}",
        async (_, message: string) => {
          expect(await currentResponse().json()).toEqual({
            formatted: message,
          });
        },
      );
    },
  );

  Scenario(
    "An intercepted JSON body nested past 256 levels is refused like the Node ingress refuses it",
    ({ Given, And, When, Then }) => {
      let routeRuns = 0;

      Given(
        'a mock whose route "POST /items" stores the body it receives',
        () => {
          routeRuns = 0;
          const stored: unknown[] = [];
          mock = schmock();
          mock("POST /items", ({ body }) => {
            routeRuns += 1;
            stored.push(body);
            return [201, { stored: stored.length }];
          });
        },
      );

      And("an intercept with passthrough off", () => {
        intercept = currentMock().intercept({ passthrough: false });
      });

      When(
        "I POST a JSON array nested {int} levels deep to {string} through that intercept",
        async (_, depth: number, path: string) => {
          fetched = await fetch(`http://localhost${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: `${"[".repeat(depth)}${"]".repeat(depth)}`,
          });
        },
      );

      Then("the fetched status is {int}", (_, status: number) => {
        expect(currentResponse().status).toBe(status);
      });

      And(
        "the fetched body is the error {string} with code {string}",
        async (_, error: string, code: string) => {
          expect(await currentResponse().json()).toEqual({ error, code });
        },
      );

      And("the route never ran and history is empty", () => {
        expect(routeRuns).toBe(0);
        expect(currentMock().history()).toEqual([]);
      });
    },
  );

  // ── Debug mode ─────────────────────────────────────────────────────────

  Scenario(
    "Debug mode answers requests where crypto.randomUUID is unavailable",
    ({ Given, And, When, Then }) => {
      Given(
        "a runtime whose Web Crypto has getRandomValues but no randomUUID",
        () => {
          const webCrypto = globalThis.crypto;
          vi.stubGlobal("crypto", {
            getRandomValues: (array: Uint8Array<ArrayBuffer>) =>
              webCrypto.getRandomValues(array),
          });
        },
      );

      And('a debug mock with a route "GET /users"', () => {
        captureDebugConsole();
        mock = schmock({ debug: true });
        mock("GET /users", [{ id: 1 }]);
      });

      When("I request {string}", async (_, request: string) => {
        await handleRequest(request);
      });

      And("I request {string}", async (_, request: string) => {
        await handleRequest(request);
      });

      Then("the two statuses are 200 and 404", () => {
        expect(statuses).toEqual([200, 404]);
      });

      And("the request log carries a v4 request id", () => {
        const requestLine = logLines.find((line) =>
          line.includes("[SCHMOCK:REQUEST]"),
        );
        expect(requestLine).toMatch(
          /\[[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\] GET \/users/,
        );
      });
    },
  );

  Scenario(
    "The debug request log masks query parameters named like credentials",
    ({ Given, When, Then, And }) => {
      const sentQuery = { api_key: "QK-1", access_token: "AT-2", limit: "10" };
      let routeQuery: Record<string, string> = {};

      Given('a debug mock with a route "GET /pets"', () => {
        captureDebugConsole();
        mock = schmock({ debug: true });
        mock("GET /pets", ({ query }) => {
          routeQuery = { ...query };
          return [];
        });
      });

      When(
        'I request "GET /pets" with query api_key "QK-1", access_token "AT-2" and limit "10"',
        async () => {
          handled = await currentMock().handle("GET", "/pets", {
            query: sentQuery,
          });
        },
      );

      Then(
        'the request log shows api_key and access_token as "[redacted]" and limit as "10"',
        () => {
          const requestCall = logCalls.find((args) =>
            String(args[0]).includes("[SCHMOCK:REQUEST]"),
          );
          const data = requestCall?.[1];
          expect(isRecord(data) ? data.query : undefined).toEqual({
            api_key: "[redacted]",
            access_token: "[redacted]",
            limit: "10",
          });
        },
      );

      And("neither credential value appears in any log line", () => {
        const lines = logCalls.map((args) =>
          args.map((arg) => JSON.stringify(arg) ?? String(arg)).join(" "),
        );
        expect(lines.some((line) => line.includes("QK-1"))).toBe(false);
        expect(lines.some((line) => line.includes("AT-2"))).toBe(false);
      });

      And("the route and history still see the real query values", () => {
        expect(routeQuery).toEqual(sentQuery);
        expect(currentMock().lastRequest()?.query).toEqual(sentQuery);
      });
    },
  );

  Scenario(
    "Static JSON data every request would reject fails when the route is defined",
    ({ Given, When, Then, And }) => {
      Given("an empty mock", () => {
        mock = schmock();
      });

      When('I define "GET /profile" with static data holding a Map', () => {
        try {
          currentMock()("GET /profile", {
            tags: new Map([["a", 1]]),
          });
        } catch (error) {
          thrown = error;
        }
      });

      Then(
        "the definition throws a RouteDefinitionError mentioning {string}",
        (_, reason: string) => {
          expect(thrown).toBeInstanceOf(RouteDefinitionError);
          expect(thrown instanceof Error ? thrown.message : "").toContain(
            reason,
          );
        },
      );

      And("the mock has no routes", () => {
        expect(currentMock().getRoutes()).toEqual([]);
      });
    },
  );
});
