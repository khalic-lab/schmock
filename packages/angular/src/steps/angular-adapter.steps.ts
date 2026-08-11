// Import Angular compiler FIRST before any other imports
import "@angular/compiler";

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import {
  HttpErrorResponse,
  type HttpEvent,
  type HttpHandler,
  HttpHeaders,
  type HttpInterceptor,
  HttpParams,
  HttpRequest,
  HttpResponse,
} from "@angular/common/http";
import type { CallableMockInstance } from "@schmock/core";
import { isHttpMethod, schmock, toRouteKey } from "@schmock/core";
import { of } from "rxjs";
import { expect } from "vitest";
import type { AngularAdapterOptions } from "../index";
import {
  createSchmockInterceptor,
  createSchmockInterceptorFromSpec,
} from "../index";

const feature = await loadFeature("../../features/angular-adapter.feature");

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  let mock: CallableMockInstance;
  let response: HttpResponse<unknown> | null = null;
  let errorResponse: HttpErrorResponse | null = null;
  let interceptorOptions: AngularAdapterOptions | undefined;

  const mockNext: HttpHandler = {
    handle: () => of(new HttpResponse({ body: "passthrough" })),
  };

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function resetState() {
    mock = schmock();
    response = null;
    errorResponse = null;
    interceptorOptions = undefined;
  }

  async function makeRequest(
    method: string,
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
    extras?: {
      responseType?: "arraybuffer" | "blob" | "json" | "text";
      params?: Record<string, string>;
    },
  ) {
    const InterceptorClass = createSchmockInterceptor(mock, interceptorOptions);
    const interceptor = new InterceptorClass();

    const request = new HttpRequest<unknown>(method, url, body, {
      headers: new HttpHeaders(headers),
      ...(extras?.responseType ? { responseType: extras.responseType } : {}),
      ...(extras?.params
        ? { params: new HttpParams({ fromObject: extras.params }) }
        : {}),
    });

    return new Promise<void>((resolve) => {
      interceptor.intercept(request, mockNext).subscribe({
        next: (event: HttpEvent<unknown>) => {
          if (event instanceof HttpResponse) {
            response = event;
          }
          resolve();
        },
        error: (error: unknown) => {
          errorResponse =
            error instanceof HttpErrorResponse
              ? error
              : new HttpErrorResponse({ error });
          resolve();
        },
      });
    });
  }

  // Error Status Handling Scenarios

  ScenarioOutline(
    "Auto-convert error status to HttpErrorResponse",
    ({ Given, When, Then, And }, variables) => {
      Given(
        "I create an Angular error mock for {string} with status {string}",
        () => {
          resetState();
          const [method, path] = variables.route.split(" ");
          const status = Number(variables.status);
          const normalizedMethod = method.toUpperCase();
          if (!isHttpMethod(normalizedMethod)) {
            throw new Error(`Unsupported scenario method: ${method}`);
          }
          mock(toRouteKey(normalizedMethod, path), [
            status,
            { error: `Error ${status}` },
          ]);
        },
      );

      When("I make an Angular request to {string}", async () => {
        const [method, path] = variables.route.split(" ");
        await makeRequest(method, path);
      });

      Then("the response should be an HttpErrorResponse", () => {
        expect(errorResponse).toBeInstanceOf(HttpErrorResponse);
      });

      And("the error status should be {string}", () => {
        expect(errorResponse?.status).toBe(Number(variables.status));
      });
    },
  );

  Scenario(
    "Success status returns HttpResponse",
    ({ Given, When, Then, And }) => {
      Given("I create an Angular mock with:", () => {
        resetState();
        mock("GET /api/users", [200, { users: [] }]);
      });

      When(
        "I make an Angular request to {string}",
        async (_, request: string) => {
          const [method, path] = request.split(" ");
          await makeRequest(method, path);
        },
      );

      Then("the response should be an HttpResponse", () => {
        expect(response).toBeInstanceOf(HttpResponse);
      });

      And("the status should be {int}", (_, status: number) => {
        expect(response?.status).toBe(status);
      });
    },
  );

  Scenario("201 Created returns HttpResponse", ({ Given, When, Then, And }) => {
    Given("I create an Angular mock with:", () => {
      resetState();
      mock("POST /api/users", [201, { id: 1, name: "John" }]);
    });

    When(
      "I make an Angular request to {string}",
      async (_, request: string) => {
        const [method, path] = request.split(" ");
        await makeRequest(method, path);
      },
    );

    Then("the response should be an HttpResponse", () => {
      expect(response).toBeInstanceOf(HttpResponse);
    });

    And("the status should be {int}", (_, status: number) => {
      expect(response?.status).toBe(status);
    });
  });

  Scenario(
    "304 Not Modified returns an empty HttpErrorResponse",
    ({ Given, When, Then, And }) => {
      Given("I create an Angular mock returning 304 with a body", () => {
        resetState();
        mock("GET /api/cached", [304, { forbidden: true }]);
      });

      When(
        "I make an Angular request to {string}",
        async (_, request: string) => {
          const [method, path] = request.split(" ");
          await makeRequest(method, path);
        },
      );

      Then("the response should be an HttpErrorResponse", () => {
        expect(errorResponse).toBeInstanceOf(HttpErrorResponse);
      });

      And("the error status should be {int}", (_, status: number) => {
        expect(errorResponse?.status).toBe(status);
      });

      And("the Angular error body should be empty", () => {
        expect(errorResponse?.error).toBeNull();
      });
    },
  );

  // Adapter Configuration Options Scenarios

  Scenario(
    "Requests outside baseUrl are passed through",
    ({ Given, When, Then }) => {
      Given(
        "I create an Angular mock with baseUrl {string}:",
        (_, baseUrl: string) => {
          resetState();
          interceptorOptions = { baseUrl };
          mock("GET /api/users", [200, { users: [] }]);
        },
      );

      When(
        "I make an Angular request to {string}",
        async (_, request: string) => {
          const [method, path] = request.split(" ");
          await makeRequest(method, path);
        },
      );

      Then("the request should pass through to the real backend", () => {
        expect(response?.body).toBe("passthrough");
      });
    },
  );

  Scenario(
    "Base URL only matches an exact path segment",
    ({ Given, When, Then }) => {
      Given(
        "I create a strict Angular mock with baseUrl {string}",
        (_, baseUrl: string) => {
          resetState();
          interceptorOptions = { baseUrl, passthrough: false };
          mock("GET /users", [200, { source: "mock" }]);
        },
      );

      When(
        "I make an Angular request to {string}",
        async (_, request: string) => {
          const [method, path] = request.split(" ");
          await makeRequest(method, path);
        },
      );

      Then("the request should pass through to the real backend", () => {
        expect(response?.body).toBe("passthrough");
      });
    },
  );

  Scenario(
    "Unsupported HTTP methods are passed through",
    ({ Given, When, Then }) => {
      Given(
        "I create a strict Angular mock for {string}",
        (_, route: string) => {
          resetState();
          interceptorOptions = { passthrough: false };
          if (route === "GET /api/users") {
            mock("GET /api/users", [200, { source: "mock" }]);
          }
        },
      );

      When(
        "I make an Angular request to {string}",
        async (_, request: string) => {
          const [method, path] = request.split(" ");
          await makeRequest(method, path);
        },
      );

      Then("the request should pass through to the real backend", () => {
        expect(response?.body).toBe("passthrough");
      });
    },
  );

  Scenario(
    "Use passthrough option to handle unmatched routes",
    ({ Given, When, Then }) => {
      Given("I create an Angular mock with passthrough enabled:", () => {
        resetState();
        interceptorOptions = { passthrough: true };
        mock("GET /api/users", [200, { users: [] }]);
      });

      When(
        "I make an Angular request to {string}",
        async (_, request: string) => {
          const [method, path] = request.split(" ");
          await makeRequest(method, path);
        },
      );

      Then("the request should pass through to the real backend", () => {
        expect(response?.body).toBe("passthrough");
      });
    },
  );

  Scenario(
    "Disable passthrough for strict mocking",
    ({ Given, When, Then, And }) => {
      Given("I create an Angular mock with passthrough disabled:", () => {
        resetState();
        interceptorOptions = { passthrough: false };
        mock("GET /api/users", [200, { users: [] }]);
      });

      When(
        "I make an Angular request to {string}",
        async (_, request: string) => {
          const [method, path] = request.split(" ");
          await makeRequest(method, path);
        },
      );

      Then("the response should be an HttpErrorResponse", () => {
        expect(errorResponse).toBeInstanceOf(HttpErrorResponse);
      });

      And("the error status should be {int}", (_, status: number) => {
        expect(errorResponse?.status).toBe(status);
      });

      And("the error body should contain {string}", (_, text: string) => {
        expect(JSON.stringify(errorResponse?.error)).toContain(text);
      });
    },
  );

  Scenario(
    "Use transformRequest to modify request before mocking",
    ({ Given, When, Then, And }) => {
      Given("I create an Angular mock with transformRequest:", () => {
        resetState();
        interceptorOptions = {
          transformRequest: (req) => {
            const headers: Record<string, string> = {};
            req.headers.keys().forEach((key) => {
              const value = req.headers.get(key);
              if (value) headers[key] = value;
            });
            return { headers };
          },
        };
        mock("GET /api/users", ({ headers }) => [
          200,
          { auth: headers.authorization || "none" },
        ]);
      });

      When(
        "I make an Angular request to {string} with custom headers",
        async (_, request: string) => {
          const [method, path] = request.split(" ");
          await makeRequest(method, path, undefined, {
            authorization: "Bearer token123",
          });
        },
      );

      Then("the response should be an HttpResponse", () => {
        expect(response).toBeInstanceOf(HttpResponse);
      });

      And(
        "the response body should contain the transformed authorization header",
        () => {
          expect(response?.body).toHaveProperty("auth");
          if (!isRecord(response?.body)) {
            throw new Error("Expected response body to be an object");
          }
          expect(response.body.auth).not.toBe("none");
        },
      );
    },
  );

  Scenario(
    "Use transformResponse to modify response before returning",
    ({ Given, When, Then, And }) => {
      Given("I create an Angular mock with transformResponse:", () => {
        resetState();
        interceptorOptions = {
          transformResponse: (schmockResponse) => ({
            ...schmockResponse,
            body: {
              ...(isRecord(schmockResponse.body) ? schmockResponse.body : {}),
              transformed: true,
            },
          }),
        };
        mock("GET /api/users", [200, { users: [] }]);
      });

      When(
        "I make an Angular request to {string}",
        async (_, request: string) => {
          const [method, path] = request.split(" ");
          await makeRequest(method, path);
        },
      );

      Then("the response should be an HttpResponse", () => {
        expect(response).toBeInstanceOf(HttpResponse);
      });

      And("the response body should contain the transformed data", () => {
        expect(response?.body).toHaveProperty("transformed", true);
      });
    },
  );

  Scenario(
    "Use custom errorFormatter for error responses",
    ({ Given, When, Then, And }) => {
      Given("I create an Angular mock with custom errorFormatter:", () => {
        resetState();
        interceptorOptions = {
          errorFormatter: (error) => ({
            customFormat: true,
            errorMessage: error.message,
            timestamp: new Date().toISOString(),
          }),
        };
        mock("GET /api/error", () => {
          throw new Error("Custom error");
        });
      });

      When(
        "I make an Angular request to {string}",
        async (_, request: string) => {
          const [method, path] = request.split(" ");
          await makeRequest(method, path);
        },
      );

      Then("the response should be an HttpErrorResponse", () => {
        expect(errorResponse).toBeInstanceOf(HttpErrorResponse);
      });

      And("the error status should be {int}", (_, status: number) => {
        expect(errorResponse?.status).toBe(status);
      });

      And("the error body should use the custom error format", () => {
        expect(errorResponse?.error).toHaveProperty("customFormat", true);
        expect(errorResponse?.error).toHaveProperty(
          "errorMessage",
          "Custom error",
        );
        expect(errorResponse?.error).toHaveProperty("timestamp");
      });
    },
  );

  // Request and Response Shaping

  Scenario(
    "Request header names are lowercased for handlers",
    ({ Given, When, Then, And }) => {
      Given(
        "I create an Angular mock that echoes the authorization header",
        () => {
          resetState();
          mock("GET /api/whoami", ({ headers }) => [
            200,
            { auth: headers.authorization ?? "none" },
          ]);
        },
      );

      When(
        'I make an Angular request to "GET /api/whoami" with a capitalized Authorization header',
        async () => {
          await makeRequest("GET", "/api/whoami", undefined, {
            Authorization: "Bearer token123",
          });
        },
      );

      Then("the response should be an HttpResponse", () => {
        expect(response).toBeInstanceOf(HttpResponse);
      });

      And('the echoed authorization header should be "Bearer token123"', () => {
        if (!isRecord(response?.body)) {
          throw new Error("Expected response body to be an object");
        }
        expect(response.body.auth).toBe("Bearer token123");
      });
    },
  );

  Scenario(
    "A repeated request header reaches the mock as a combined value",
    ({ Given, When, Then, And }) => {
      Given("I create an Angular mock that echoes the x-tag header", () => {
        resetState();
        mock("GET /api/tagged", ({ headers }) => [
          200,
          { tag: headers["x-tag"] ?? "none" },
        ]);
      });

      When(
        'I make an Angular request to "GET /api/tagged" with the x-tag header appended twice',
        async () => {
          const InterceptorClass = createSchmockInterceptor(
            mock,
            interceptorOptions,
          );
          const interceptor = new InterceptorClass();
          const request = new HttpRequest<unknown>("GET", "/api/tagged", {
            headers: new HttpHeaders()
              .append("x-tag", "a")
              .append("x-tag", "b"),
          });

          await new Promise<void>((resolve) => {
            interceptor.intercept(request, mockNext).subscribe({
              next: (event: HttpEvent<unknown>) => {
                if (event instanceof HttpResponse) {
                  response = event;
                }
                resolve();
              },
              error: (error: unknown) => {
                errorResponse =
                  error instanceof HttpErrorResponse
                    ? error
                    : new HttpErrorResponse({ error });
                resolve();
              },
            });
          });
        },
      );

      Then("the response should be an HttpResponse", () => {
        expect(response).toBeInstanceOf(HttpResponse);
      });

      And('the echoed x-tag header should be "a, b"', () => {
        if (!isRecord(response?.body)) {
          throw new Error("Expected response body to be an object");
        }
        expect(response.body.tag).toBe("a, b");
      });
    },
  );

  Scenario(
    "responseType text yields a string body",
    ({ Given, When, Then, And }) => {
      Given(
        'I create an Angular mock returning an object for "GET /api/users"',
        () => {
          resetState();
          mock("GET /api/users", [200, { users: [] }]);
        },
      );

      When(
        'I make an Angular request to "GET /api/users" with responseType "text"',
        async () => {
          await makeRequest("GET", "/api/users", undefined, undefined, {
            responseType: "text",
          });
        },
      );

      Then("the response should be an HttpResponse", () => {
        expect(response).toBeInstanceOf(HttpResponse);
      });

      And("the response body should be the string '{\"users\":[]}'", () => {
        expect(response?.body).toBe('{"users":[]}');
      });
    },
  );

  Scenario(
    "Emitted responses report the URL with params",
    ({ Given, When, Then, And }) => {
      Given(
        'I create an Angular mock returning an object for "GET /api/users"',
        () => {
          resetState();
          mock("GET /api/users", [200, { users: [] }]);
        },
      );

      When(
        'I make an Angular request to "GET /api/users" with query params',
        async () => {
          await makeRequest("GET", "/api/users", undefined, undefined, {
            params: { page: "2" },
          });
        },
      );

      Then("the response should be an HttpResponse", () => {
        expect(response).toBeInstanceOf(HttpResponse);
      });

      And('the response url should be "/api/users?page=2"', () => {
        expect(response?.url).toBe("/api/users?page=2");
      });
    },
  );

  // OpenAPI Spec with Angular Adapter Options

  const inlineSpec = {
    openapi: "3.0.3",
    info: { title: "Test", version: "1.0.0" },
    paths: {
      "/items": {
        get: {
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        name: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  Scenario(
    "Auto-created interceptor respects baseUrl option",
    ({ Given, When, Then }) => {
      let InterceptorClass: new () => HttpInterceptor;

      Given(
        "I create an Angular interceptor from spec with baseUrl {string}",
        async (_, baseUrl: string) => {
          response = null;
          errorResponse = null;
          InterceptorClass = await createSchmockInterceptorFromSpec(
            { spec: inlineSpec },
            { baseUrl },
          );
        },
      );

      When(
        "I make an Angular request to {string}",
        async (_, request: string) => {
          const [method, path] = request.split(" ");
          if (!method || !path || !isHttpMethod(method)) {
            throw new Error(
              `Expected a supported METHOD /path request, got: ${request}`,
            );
          }
          const interceptor = new InterceptorClass();
          const req = new HttpRequest(method, path, null);
          await new Promise<void>((resolve) => {
            interceptor.intercept(req, mockNext).subscribe({
              next: (event: HttpEvent<unknown>) => {
                if (event instanceof HttpResponse) {
                  response = event;
                }
                resolve();
              },
              error: (error: unknown) => {
                errorResponse =
                  error instanceof HttpErrorResponse
                    ? error
                    : new HttpErrorResponse({ error });
                resolve();
              },
            });
          });
        },
      );

      Then("the request should pass through to the real backend", () => {
        expect(response?.body).toBe("passthrough");
      });
    },
  );
});
