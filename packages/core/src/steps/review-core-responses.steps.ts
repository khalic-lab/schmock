import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { RouteDefinitionError, schmock, toHttpMethod } from "../index";

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

  AfterEachScenario(() => {
    intercept?.restore();
    intercept = undefined;
    mock = undefined;
    fetched = undefined;
    handled = undefined;
    thrown = undefined;
  });

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
