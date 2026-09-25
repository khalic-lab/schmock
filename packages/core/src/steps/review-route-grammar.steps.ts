import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { isHttpMethod, SchmockError, schmock, toRouteKey } from "../index";

const feature = await loadFeature(
  "../../features/review-route-grammar.feature",
);

interface ParsedRequest {
  method: Schmock.HttpMethod;
  path: string;
}

interface ParamRow {
  name: string;
  value: string;
}

/** Split `"METHOD /path"` without casting, so a typo fails loudly. */
function parseRequest(text: string): ParsedRequest {
  const space = text.indexOf(" ");
  const method = text.slice(0, space);
  if (space < 0 || !isHttpMethod(method)) {
    throw new Error(`Expected "METHOD /path", got ${JSON.stringify(text)}`);
  }
  return { method, path: text.slice(space + 1) };
}

function routeKeyOf(text: string): Schmock.RouteKey {
  const { method, path } = parseRequest(text);
  return toRouteKey(method, path);
}

function requireParamTable(table: unknown): ParamRow[] {
  if (!Array.isArray(table)) {
    throw new Error("Expected a params table");
  }
  return table.map((row: unknown) => {
    if (
      typeof row !== "object" ||
      row === null ||
      !("name" in row) ||
      !("value" in row) ||
      typeof row.name !== "string" ||
      typeof row.value !== "string"
    ) {
      throw new Error("Expected params table rows with name and value");
    }
    return { name: row.name, value: row.value };
  });
}

function echoParams(mock: Schmock.CallableMockInstance, key: string): void {
  mock(routeKeyOf(key), ({ params }) => ({ params: { ...params } }));
}

function answering(
  mock: Schmock.CallableMockInstance,
  key: string,
  answer: string,
): void {
  mock(routeKeyOf(key), ({ params }) => ({ answer, params: { ...params } }));
}

function bodyRecord(response: Schmock.Response): Record<string, unknown> {
  const { body } = response;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(`Expected an object body, got ${JSON.stringify(body)}`);
  }
  return Object.fromEntries(Object.entries(body));
}

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;

  const request = async (text: string): Promise<Schmock.Response> => {
    const { method, path } = parseRequest(text);
    return mock.handle(method, path);
  };

  const expectEchoedParams = (table: unknown) => {
    const expected = Object.fromEntries(
      requireParamTable(table).map((row) => [row.name, row.value]),
    );
    expect(bodyRecord(response).params).toEqual(expected);
  };

  for (const title of [
    "A hyphen between two parameters is a literal separator",
    "A hyphen inside a parameter name still belongs to the name",
    "A single parameter before a literal suffix still matches greedily",
    "Hyphen-joined date parameters split at each separator",
    "A quoted parameter name may contain characters outside the plain grammar",
  ]) {
    Scenario(title, ({ Given, When, Then, And }) => {
      Given("a mock with route {string} echoing its params", (_, key) => {
        mock = schmock();
        echoParams(mock, key);
      });

      When("I request {string}", async (_, text) => {
        response = await request(text);
      });

      Then("the response status is {int}", (_, status) => {
        expect(response.status).toBe(status);
      });

      And("the echoed params are:", (_, table: unknown) => {
        expectEchoedParams(table);
      });
    });
  }

  Scenario(
    "Two parameters with nothing between them are rejected at registration",
    ({ Given, When, Then }) => {
      let thrown: unknown;

      Given("a fresh mock", () => {
        mock = schmock();
      });

      When("I register the route {string}", (_, key) => {
        thrown = undefined;
        try {
          echoParams(mock, key);
        } catch (error) {
          thrown = error;
        }
      });

      Then(
        "registration fails with code {string} mentioning {string}",
        (_, code, fragment) => {
          expect(thrown).toBeInstanceOf(SchmockError);
          if (!(thrown instanceof SchmockError)) return;
          expect(thrown.code).toBe(code);
          expect(thrown.message).toContain(fragment);
          expect(mock.getRoutes()).toEqual([]);
        },
      );
    },
  );

  Scenario(
    "An escaped colon is a literal, so custom methods route to their own handler",
    ({ Given, When, Then, And }) => {
      Given("a mock with route {string} answering {string}", (_, key, text) => {
        mock = schmock();
        answering(mock, key, text);
      });

      And(
        "the same mock with route {string} answering {string}",
        (_, key, text) => {
          answering(mock, key, text);
        },
      );

      When("I request {string}", async (_, text) => {
        response = await request(text);
      });

      Then("the response status is {int}", (_, status) => {
        expect(response.status).toBe(status);
      });

      And(
        "the answer is {string} with param {string} equal to {string}",
        (_, answer, name, value) => {
          const body = bodyRecord(response);
          expect(body.answer).toBe(answer);
          expect(body.params).toEqual({ [name]: value });
        },
      );

      And("requesting {string} returns {int}", async (_, text, status) => {
        expect((await request(text)).status).toBe(status);
      });

      And(
        "the registered paths are {string} and {string}",
        (_, first, second) => {
          expect(mock.getRoutes().map((route) => route.path)).toEqual([
            first,
            second,
          ]);
        },
      );
    },
  );

  Scenario(
    "A route whose only colon is escaped is a static route",
    ({ Given, When, Then, And }) => {
      Given("a mock with route {string} answering {string}", (_, key, text) => {
        mock = schmock();
        answering(mock, key, text);
      });

      When("I request {string}", async (_, text) => {
        response = await request(text);
      });

      Then("the response status is {int}", (_, status) => {
        expect(response.status).toBe(status);
        expect(bodyRecord(response).answer).toBe("batch");
      });

      And("requesting {string} returns {int}", async (_, text, status) => {
        expect((await request(text)).status).toBe(status);
      });
    },
  );

  ScenarioOutline(
    "Several parameters in one segment do not backtrack on a long URL",
    ({ Given, When, Then, And }, variables) => {
      let elapsed = 0;

      Given("a mock with route {string} echoing its params", () => {
        mock = schmock();
        echoParams(mock, variables.route);
      });

      When(
        "I request a path of {string} followed by {string} repetitions of {string} and {string}",
        async () => {
          const path = `${variables.prefix}${variables.unit.repeat(
            Number(variables.count),
          )}/x`;
          const start = performance.now();
          response = await mock.handle("GET", path);
          elapsed = performance.now() - start;
        },
      );

      Then("the response status is {int}", (_, status) => {
        expect(response.status).toBe(status);
      });

      And("the request took less than {int} milliseconds", (_, limit) => {
        expect(elapsed).toBeLessThan(limit);
      });
    },
  );
});
