import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock, toHttpMethod } from "../index";

const feature = await loadFeature(
  "../../features/plugin-after-response.feature",
);

const STAGED = "feature:staged-rows";

const passThrough: Schmock.Plugin["process"] = (context, response) => ({
  context,
  response,
});

function parseRequest(request: string): {
  method: Schmock.HttpMethod;
  path: string;
} {
  const [methodText = "", path = ""] = request.split(" ");
  return { method: toHttpMethod(methodText), path };
}

function stageBody(ctx: Schmock.RequestContext): void {
  ctx.pluginState?.set(STAGED, [String(ctx.body)]);
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance = schmock();
  let rows: string[] = [];
  let settledStatuses: number[] = [];
  let response: Schmock.Response | undefined;
  let rejection: unknown;

  AfterEachScenario(() => {
    mock = schmock();
    rows = [];
    settledStatuses = [];
    response = undefined;
    rejection = undefined;
  });

  function pipeStore(): void {
    mock = schmock();
    mock.pipe({
      name: "staging-store",
      process: passThrough,
      afterResponse(context, settled) {
        settledStatuses.push(settled.status);
        const staged = context.state.get(STAGED);
        context.state.delete(STAGED);
        if (settled.status >= 400 || !Array.isArray(staged)) return;
        for (const row of staged) rows.push(String(row));
      },
    });
  }

  function stagingCreateRoute(): void {
    mock("POST /pets", (ctx) => {
      stageBody(ctx);
      return [201, { name: ctx.body }];
    });
  }

  async function requestWithBody(request: string, body: string): Promise<void> {
    const { method, path } = parseRequest(request);
    response = await mock.handle(method, path, { body });
  }

  function currentResponse(): Schmock.Response {
    if (!response) throw new Error("scenario did not handle a request");
    return response;
  }

  Scenario(
    "A staged write is committed when the final response succeeds",
    ({ Given, And, When, Then }) => {
      Given(
        "a store plugin that commits staged rows in afterResponse when the status is below 400",
        pipeStore,
      );

      And(
        'a route "POST /pets" that stages the request body as a row and answers 201',
        stagingCreateRoute,
      );

      When(
        "I request {string} with body {string}",
        async (_, request: string, body: string) => {
          await requestWithBody(request, body);
        },
      );

      Then("the response status is {int}", (_, status: number) => {
        expect(currentResponse().status).toBe(status);
      });

      And("the store holds the rows {string}", (_, row: string) => {
        expect(rows).toEqual([row]);
      });
    },
  );

  Scenario(
    "A staged write is dropped when a plugin piped later answers 500",
    ({ Given, And, When, Then }) => {
      Given(
        "a store plugin that commits staged rows in afterResponse when the status is below 400",
        pipeStore,
      );

      And(
        'a route "POST /pets" that stages the request body as a row and answers 201',
        stagingCreateRoute,
      );

      And(
        "a plugin piped after the store that answers every request with 500",
        () => {
          mock.pipe({
            name: "downstream-failure",
            process: (context) => ({
              context,
              response: [500, { error: "downstream" }],
            }),
          });
        },
      );

      When(
        "I request {string} with body {string}",
        async (_, request: string, body: string) => {
          await requestWithBody(request, body);
        },
      );

      Then("the response status is {int}", (_, status: number) => {
        expect(currentResponse().status).toBe(status);
      });

      And("the store holds no rows", () => {
        expect(rows).toEqual([]);
      });

      And("afterResponse saw the final status {int}", (_, status: number) => {
        expect(settledStatuses).toEqual([status]);
      });
    },
  );

  Scenario(
    "afterResponse sees the 500 a throwing route was answered with",
    ({ Given, And, When, Then }) => {
      Given(
        "a store plugin that commits staged rows in afterResponse when the status is below 400",
        pipeStore,
      );

      And('a route "POST /pets" that stages a row and then throws', () => {
        mock("POST /pets", (ctx) => {
          stageBody(ctx);
          throw new Error("write failed half way");
        });
      });

      When(
        "I request {string} with body {string}",
        async (_, request: string, body: string) => {
          await requestWithBody(request, body);
        },
      );

      Then("the response status is {int}", (_, status: number) => {
        expect(currentResponse().status).toBe(status);
      });

      And("the store holds no rows", () => {
        expect(rows).toEqual([]);
      });

      And("afterResponse saw the final status {int}", (_, status: number) => {
        expect(settledStatuses).toEqual([status]);
      });
    },
  );

  Scenario(
    "afterResponse is skipped for a request aborted during its delay",
    ({ Given, And, When, Then }) => {
      Given(
        "a store plugin that commits staged rows in afterResponse when the status is below 400",
        pipeStore,
      );

      And(
        'a route "POST /pets" with a {int} ms delay that stages the request body as a row',
        (_, delay: number) => {
          mock(
            "POST /pets",
            (ctx) => {
              stageBody(ctx);
              return [201, { name: ctx.body }];
            },
            { delay },
          );
        },
      );

      When(
        "I abort a {string} request with body {string} while it waits",
        async (_, request: string, body: string) => {
          const { method, path } = parseRequest(request);
          const controller = new AbortController();
          const pending = mock.handle(method, path, {
            body,
            signal: controller.signal,
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.abort();
          try {
            await pending;
          } catch (error) {
            rejection = error;
          }
        },
      );

      Then("the request rejects with an AbortError", () => {
        expect(rejection).toMatchObject({ name: "AbortError" });
      });

      And("the store holds no rows", () => {
        expect(rows).toEqual([]);
      });

      And("afterResponse never ran", () => {
        expect(settledStatuses).toEqual([]);
      });
    },
  );

  Scenario(
    "A throwing afterResponse never changes the response",
    ({ Given, And, When, Then }) => {
      Given('a route "GET /health" that answers ok', () => {
        mock = schmock();
        mock("GET /health", { ok: true });
      });

      And("a plugin whose afterResponse throws", () => {
        mock.pipe({
          name: "broken-settler",
          process: passThrough,
          afterResponse: () => {
            throw new Error("settle failed");
          },
        });
      });

      When("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      Then("the response status is {int}", (_, status: number) => {
        expect(currentResponse().status).toBe(status);
      });

      And("the request is recorded in history", () => {
        expect(mock.callCount("GET", "/health")).toBe(1);
      });
    },
  );
});
