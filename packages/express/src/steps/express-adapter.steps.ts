import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import type { CallableMockInstance } from "@schmock/core";
import { schmock } from "@schmock/core";
import type { ErrorRequestHandler, Express, RequestHandler } from "express";
import express from "express";
import request from "supertest";
import { expect } from "vitest";
import type { ExpressAdapterOptions } from "../index.js";
import { toExpress } from "../index.js";

const feature = await loadFeature("../../features/express-adapter.feature");

type HttpResponse = request.Response;

function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRequest(requestSpec: string): { method: string; path: string } {
  const separator = requestSpec.indexOf(" ");
  if (separator <= 0 || separator === requestSpec.length - 1) {
    throw new Error(`Invalid request specification: ${requestSpec}`);
  }

  return {
    method: requestSpec.slice(0, separator),
    path: requestSpec.slice(separator + 1),
  };
}

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  let app: Express | undefined;
  let httpResponse: HttpResponse | undefined;
  let fallbackCalls = 0;
  let errorHandlerCalls = 0;
  let errorFormatterCalls = 0;
  let errorHandlerMessage: string | undefined;
  let requestDeadlineMs: number | undefined;

  function mount(
    mock: CallableMockInstance,
    options: ExpressAdapterOptions = {},
  ): void {
    const expressApp = express();
    fallbackCalls = 0;
    errorHandlerCalls = 0;
    errorFormatterCalls = 0;
    errorHandlerMessage = undefined;
    requestDeadlineMs = undefined;
    httpResponse = undefined;

    expressApp.use(express.json());
    expressApp.use(toExpress(mock, options));

    const fallbackMiddleware: RequestHandler = (_req, res) => {
      fallbackCalls += 1;
      res.status(418).json({ source: "express-fallback" });
    };
    expressApp.use(fallbackMiddleware);

    const errorMiddleware: ErrorRequestHandler = (error, _req, res, _next) => {
      errorHandlerCalls += 1;
      errorHandlerMessage = errorMessage(error);
      if (res.headersSent) {
        res.end();
        return;
      }
      res.status(598).json({
        source: "express-error-handler",
        message: errorHandlerMessage,
      });
    };
    expressApp.use(errorMiddleware);

    app = expressApp;
  }

  function currentApp(): Express {
    if (!app) throw new Error("Express app has not been mounted");
    return app;
  }

  function currentResponse(): HttpResponse {
    if (!httpResponse) throw new Error("HTTP request has not completed");
    return httpResponse;
  }

  async function makeRequest(
    requestSpec: string,
    header?: { name: string; value: string },
  ): Promise<void> {
    const { method, path } = parseRequest(requestSpec);
    const client = request(currentApp());
    let pendingRequest: request.Test;

    if (method === "GET") {
      pendingRequest = client.get(path);
    } else if (method === "POST") {
      pendingRequest = client.post(path);
    } else {
      throw new Error(`Unsupported BDD request method: ${method}`);
    }

    if (header) {
      pendingRequest.set(header.name, header.value);
    }
    if (requestDeadlineMs !== undefined) {
      pendingRequest.timeout({ deadline: requestDeadlineMs });
    }

    httpResponse = await pendingRequest;
  }

  Scenario(
    "Matched route returns Schmock response",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Express middleware with a GET /users route returning users",
        () => {
          const mock = schmock();
          mock("GET /users", [{ id: 1, name: "John" }]);
          mount(mock);
        },
      );

      When("a request is made to {string}", async (_, requestSpec: string) => {
        await makeRequest(requestSpec);
      });

      Then(
        "the Express response should have status {int}",
        (_, status: number) => {
          expect(currentResponse().status).toBe(status);
        },
      );

      And("the Express response body should be:", (_, docString: string) => {
        expect(parseJson(currentResponse().text)).toEqual(parseJson(docString));
      });

      And("the fallback middleware should not have handled the request", () => {
        expect(fallbackCalls).toBe(0);
      });
    },
  );

  Scenario(
    "Unmatched route reaches Express fallback middleware",
    ({ Given, When, Then }) => {
      Given(
        "I create an Express middleware with a GET /users route for passthrough testing",
        () => {
          const mock = schmock();
          mock("GET /users", [{ id: 1 }]);
          mount(mock);
        },
      );

      When("a request is made to {string}", async (_, requestSpec: string) => {
        await makeRequest(requestSpec);
      });

      Then(
        "the Express fallback should return status {int}",
        (_, status: number) => {
          expect(currentResponse().status).toBe(status);
          expect(parseJson(currentResponse().text)).toEqual({
            source: "express-fallback",
          });
          expect(fallbackCalls).toBe(1);
        },
      );
    },
  );

  Scenario(
    "Unmatched HTTP method reaches Express fallback middleware",
    ({ Given, When, Then }) => {
      Given(
        "I create an Express middleware with only a GET /users route",
        () => {
          const mock = schmock();
          mock("GET /users", [{ id: 1 }]);
          mount(mock);
        },
      );

      When("a request is made to {string}", async (_, requestSpec: string) => {
        await makeRequest(requestSpec);
      });

      Then(
        "the Express fallback should return status {int}",
        (_, status: number) => {
          expect(currentResponse().status).toBe(status);
          expect(parseJson(currentResponse().text)).toEqual({
            source: "express-fallback",
          });
          expect(fallbackCalls).toBe(1);
        },
      );
    },
  );

  Scenario(
    "Error status codes are sent as responses not passthrough",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Express middleware with a route returning status 500",
        () => {
          const mock = schmock();
          mock("GET /error", () => [500, { error: "Server Error" }]);
          mount(mock);
        },
      );

      When("a request is made to {string}", async (_, requestSpec: string) => {
        await makeRequest(requestSpec);
      });

      Then(
        "the Express response should have status {int}",
        (_, status: number) => {
          expect(currentResponse().status).toBe(status);
        },
      );

      And("the fallback middleware should not have handled the request", () => {
        expect(fallbackCalls).toBe(0);
      });
    },
  );

  Scenario(
    "Generator errors return 500 response",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Express middleware with a route that throws an error",
        () => {
          const mock = schmock();
          mock("GET /fail", () => {
            throw new Error("Generator exploded");
          });
          mount(mock);
        },
      );

      When("a request is made to {string}", async (_, requestSpec: string) => {
        await makeRequest(requestSpec);
      });

      Then(
        "the Express response should have status {int}",
        (_, status: number) => {
          expect(currentResponse().status).toBe(status);
        },
      );

      And("the fallback middleware should not have handled the request", () => {
        expect(fallbackCalls).toBe(0);
      });
    },
  );

  Scenario(
    "Response headers are forwarded to Express",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Express middleware with a route returning custom headers",
        () => {
          const mock = schmock();
          mock("GET /custom", () => [
            200,
            { ok: true },
            { "x-custom": "value" },
          ]);
          mount(mock);
        },
      );

      When("a request is made to {string}", async (_, requestSpec: string) => {
        await makeRequest(requestSpec);
      });

      Then(
        "the Express response should have status {int}",
        (_, status: number) => {
          expect(currentResponse().status).toBe(status);
        },
      );

      And(
        "the Express response should have header {string} with value {string}",
        (_, header: string, value: string) => {
          expect(currentResponse().get(header)).toBe(value);
        },
      );
    },
  );

  ScenarioOutline(
    "Dynamic and tuple binary responses remain bytes across the Express boundary",
    ({ Given, When, Then, And }, variables) => {
      Given(
        "I create an Express middleware with a route returning a {string} binary value",
        () => {
          const mock = schmock();
          const bytes = new Uint8Array([1, 2, 3]);
          if (variables.form === "dynamic") {
            mock("GET /binary", () => bytes.buffer);
          } else if (variables.form === "tuple") {
            mock(
              "GET /binary",
              () =>
                [206, new DataView(bytes.buffer)] satisfies [number, unknown],
            );
          } else {
            throw new Error(
              `Unsupported binary response form: ${variables.form}`,
            );
          }
          mount(mock);
        },
      );

      When("a request is made to {string}", async () => {
        await makeRequest("GET /binary");
      });

      Then("the Express response should have status {string}", () => {
        expect(currentResponse().status).toBe(Number(variables.status));
      });

      And(
        "the Express response should have header {string} with value {string}",
        () => {
          expect(currentResponse().get("content-type")).toBe(
            "application/octet-stream",
          );
        },
      );

      And("the Express response bytes should be 1, 2, 3", () => {
        const responseBody: unknown = currentResponse().body;
        if (!Buffer.isBuffer(responseBody)) {
          throw new Error("Expected Supertest to return a Buffer body");
        }
        expect([...responseBody]).toEqual([1, 2, 3]);
      });
    },
  );

  Scenario(
    "errorFormatter fires for non-SchmockError generator errors",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Express middleware with errorFormatter and a generator that throws a plain Error",
        () => {
          const mock = schmock();
          mock("GET /boom", () => {
            throw new Error("kaboom");
          });
          mount(mock, {
            errorFormatter: (error) => ({
              formatted: true,
              message: error.message,
            }),
          });
        },
      );

      When("a request is made to {string}", async (_, requestSpec: string) => {
        await makeRequest(requestSpec);
      });

      Then(
        "the Express response should have status {int}",
        (_, status: number) => {
          expect(currentResponse().status).toBe(status);
        },
      );

      And("the Express response body should be the formatter output", () => {
        expect(parseJson(currentResponse().text)).toEqual({
          formatted: true,
          message: "kaboom",
        });
      });
    },
  );

  Scenario(
    "Custom header and query transforms cross the Express boundary",
    ({ Given, When, Then }) => {
      Given(
        "I create an Express middleware with custom header and query transforms",
        () => {
          const mock = schmock();
          mock("GET /inspect", ({ headers, query }) => ({
            header: headers["x-transformed"],
            query: query.normalized,
          }));
          mount(mock, {
            transformHeaders: (headers) => {
              const rawHeader = headers["x-raw"];
              const value = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
              return {
                "x-transformed": `header:${value ?? "missing"}`,
              };
            },
            transformQuery: (query) => ({
              normalized:
                typeof query.raw === "string"
                  ? query.raw.toUpperCase()
                  : "missing",
            }),
          });
        },
      );

      When(
        "a request is made to {string} with header {string} set to {string}",
        async (
          _,
          requestSpec: string,
          headerName: string,
          headerValue: string,
        ) => {
          await makeRequest(requestSpec, {
            name: headerName,
            value: headerValue,
          });
        },
      );

      Then("the Express response body should be:", (_, docString: string) => {
        expect(parseJson(currentResponse().text)).toEqual(parseJson(docString));
      });
    },
  );

  Scenario(
    "beforeRequest can rewrite the request before route matching",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Express middleware whose beforeRequest rewrites the request",
        () => {
          const mock = schmock();
          mock("POST /rewritten", ({ method, headers, body, query }) => [
            201,
            {
              method,
              header: headers["x-source"],
              body: typeof body === "string" ? body : "missing",
              query: query.source,
            },
          ]);
          mount(mock, {
            beforeRequest: (req) => {
              const sourceHeader = req.headers["x-source"];
              const source = Array.isArray(sourceHeader)
                ? sourceHeader[0]
                : sourceHeader;
              return {
                method: "POST",
                path: "/rewritten",
                headers: { "x-source": source ?? "missing" },
                body: "hook-body",
                query: { source: "hook-query" },
              };
            },
          });
        },
      );

      When(
        "a request is made to {string} with header {string} set to {string}",
        async (
          _,
          requestSpec: string,
          headerName: string,
          headerValue: string,
        ) => {
          await makeRequest(requestSpec, {
            name: headerName,
            value: headerValue,
          });
        },
      );

      Then(
        "the Express response should have status {int}",
        (_, status: number) => {
          expect(currentResponse().status).toBe(status);
        },
      );

      And("the Express response body should be:", (_, docString: string) => {
        expect(parseJson(currentResponse().text)).toEqual(parseJson(docString));
      });
    },
  );

  Scenario(
    "beforeResponse can replace the outgoing response",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Express middleware whose beforeResponse replaces the response",
        () => {
          const mock = schmock();
          mock("GET /source", { value: "original" });
          mount(mock, {
            beforeResponse: () => ({
              status: 202,
              body: { value: "modified" },
              headers: { "x-before-response": "yes" },
            }),
          });
        },
      );

      When("a request is made to {string}", async (_, requestSpec: string) => {
        await makeRequest(requestSpec);
      });

      Then(
        "the Express response should have status {int}",
        (_, status: number) => {
          expect(currentResponse().status).toBe(status);
        },
      );

      And("the Express response body should be:", (_, docString: string) => {
        expect(parseJson(currentResponse().text)).toEqual(parseJson(docString));
      });

      And(
        "the Express response should have header {string} with value {string}",
        (_, header: string, value: string) => {
          expect(currentResponse().get(header)).toBe(value);
        },
      );
    },
  );

  Scenario(
    "passErrorsToNext sends adapter failures to Express error middleware",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Express middleware whose beforeRequest fails with passErrorsToNext enabled",
        () => {
          const mock = schmock();
          mount(mock, {
            passErrorsToNext: true,
            beforeRequest: () => {
              throw new Error("request hook exploded");
            },
          });
        },
      );

      When("a request is made to {string}", async (_, requestSpec: string) => {
        await makeRequest(requestSpec);
      });

      Then(
        "the Express error middleware should return status {int}",
        (_, status: number) => {
          expect(currentResponse().status).toBe(status);
          expect(errorHandlerCalls).toBe(1);
        },
      );

      And("the Express response body should be:", (_, docString: string) => {
        expect(parseJson(currentResponse().text)).toEqual(parseJson(docString));
      });
    },
  );

  Scenario(
    "Disabling passErrorsToNext returns the adapter error response",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Express middleware whose beforeRequest fails with passErrorsToNext disabled",
        () => {
          const mock = schmock();
          mount(mock, {
            passErrorsToNext: false,
            beforeRequest: () => {
              throw new Error("request hook exploded");
            },
          });
        },
      );

      When("a request is made to {string}", async (_, requestSpec: string) => {
        await makeRequest(requestSpec);
      });

      Then(
        "the Express response should have status {int}",
        (_, status: number) => {
          expect(currentResponse().status).toBe(status);
        },
      );

      And("the Express response body should be:", (_, docString: string) => {
        expect(parseJson(currentResponse().text)).toEqual(parseJson(docString));
      });

      And(
        "the Express error middleware should not have handled the request",
        () => {
          expect(errorHandlerCalls).toBe(0);
        },
      );
    },
  );

  Scenario(
    "A committed hook failure settles through Express error middleware",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Express middleware whose beforeRequest writes before failing",
        () => {
          const mock = schmock();
          mock("GET /partial-failure", { generated: true });
          mount(mock, {
            errorFormatter: () => {
              errorFormatterCalls += 1;
              return { formatted: true };
            },
            beforeRequest: (_req, res) => {
              res.status(207);
              res.setHeader("content-type", "text/plain");
              res.write("partial");
              throw new Error("request hook exploded after write");
            },
          });
          requestDeadlineMs = 2_000;
        },
      );

      When("a request is made to {string}", async (_, requestSpec: string) => {
        await makeRequest(requestSpec);
      });

      Then(
        "the committed Express response should complete with status {int} and body {string}",
        (_, status: number, body: string) => {
          expect(currentResponse().status).toBe(status);
          expect(currentResponse().text).toBe(body);
        },
      );

      And(
        "the Express error middleware should observe {string}",
        (_, message: string) => {
          expect(errorHandlerCalls).toBe(1);
          expect(errorHandlerMessage).toBe(message);
        },
      );

      And(
        "the Express error formatter should not have handled the error",
        () => {
          expect(errorFormatterCalls).toBe(0);
        },
      );
    },
  );
});
