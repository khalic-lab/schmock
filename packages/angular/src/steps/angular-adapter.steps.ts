// Import Angular compiler FIRST before any other imports
import "@angular/compiler";

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import {
  HttpErrorResponse,
  type HttpHandler,
  HttpHeaders,
  HttpRequest,
  HttpResponse,
} from "@angular/common/http";
import type { CallableMockInstance } from "@schmock/core";
import { schmock } from "@schmock/core";
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
  let response: HttpResponse<any> | null = null;
  let errorResponse: HttpErrorResponse | null = null;
  let interceptorOptions: AngularAdapterOptions | undefined;

  const mockNext: HttpHandler = {
    handle: () => of(new HttpResponse({ body: "passthrough" })),
  };

  function resetState() {
    mock = schmock();
    response = null;
    errorResponse = null;
    interceptorOptions = undefined;
  }

  async function makeRequest(
    method: string,
    url: string,
    body?: any,
    headers?: Record<string, string>,
  ) {
    const InterceptorClass = createSchmockInterceptor(mock, interceptorOptions);
    const interceptor = new InterceptorClass();

    const requestOptions: any = {};
    if (headers) {
      requestOptions.headers = new HttpHeaders(headers);
    }

    const request = new HttpRequest(method, url, body, requestOptions);

    return new Promise<void>((resolve) => {
      interceptor.intercept(request, mockNext).subscribe({
        next: (res: any) => {
          response = res;
          resolve();
        },
        error: (err: any) => {
          errorResponse = err;
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
          mock(`${method} ${path}` as any, [
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
          expect(response?.body.auth).not.toBe("none");
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
          transformResponse: (response) => ({
            ...response,
            body: { ...response.body, transformed: true },
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
      let InterceptorClass: new () => any;

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
          const interceptor = new InterceptorClass();
          const req = new HttpRequest(method, path);
          await new Promise<void>((resolve) => {
            interceptor.intercept(req, mockNext).subscribe({
              next: (res: any) => {
                response = res;
                resolve();
              },
              error: (err: any) => {
                errorResponse = err;
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
