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
  badRequest,
  created,
  createSchmockInterceptor,
  forbidden,
  noContent,
  notFound,
  paginate,
  serverError,
  unauthorized,
} from "../index";

const feature = await loadFeature("../../features/angular-adapter.feature");

describeFeature(feature, ({ Scenario }) => {
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

  Scenario(
    "Auto-convert 404 status to HttpErrorResponse",
    ({ Given, When, Then, And }) => {
      Given("I create an Angular mock with:", () => {
        resetState();
        mock("GET /api/users/999", [404, { message: "User not found" }]);
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
    "Auto-convert 400 status to HttpErrorResponse",
    ({ Given, When, Then, And }) => {
      Given("I create an Angular mock with:", () => {
        resetState();
        mock("GET /api/invalid", [400, { error: "Bad request" }]);
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
    },
  );

  Scenario(
    "Auto-convert 500 status to HttpErrorResponse",
    ({ Given, When, Then, And }) => {
      Given("I create an Angular mock with:", () => {
        resetState();
        mock("GET /api/error", [500, { error: "Internal server error" }]);
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

  // Helper Function Scenarios

  Scenario("Use notFound helper", ({ Given, When, Then, And }) => {
    Given("I create an Angular mock using helpers:", () => {
      resetState();
      mock("GET /api/users/999", notFound("User not found"));
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
  });

  Scenario("Use badRequest helper", ({ Given, When, Then, And }) => {
    Given("I create an Angular mock using helpers:", () => {
      resetState();
      mock("POST /api/users", badRequest("Invalid email format"));
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
  });

  Scenario("Use unauthorized helper", ({ Given, When, Then, And }) => {
    Given("I create an Angular mock using helpers:", () => {
      resetState();
      mock("GET /api/protected", unauthorized("Token expired"));
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
  });

  Scenario("Use forbidden helper", ({ Given, When, Then, And }) => {
    Given("I create an Angular mock using helpers:", () => {
      resetState();
      mock("GET /api/admin", forbidden("Admin access required"));
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
  });

  Scenario("Use serverError helper", ({ Given, When, Then, And }) => {
    Given("I create an Angular mock using helpers:", () => {
      resetState();
      mock("GET /api/broken", serverError("Database connection failed"));
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
  });

  Scenario("Use created helper", ({ Given, When, Then, And }) => {
    Given("I create an Angular mock using helpers:", () => {
      resetState();
      mock("POST /api/users", created({ id: 1, name: "John" }));
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

  Scenario("Use noContent helper", ({ Given, When, Then, And }) => {
    Given("I create an Angular mock using helpers:", () => {
      resetState();
      mock("DELETE /api/users/1", noContent());
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

  Scenario("Use paginate helper", ({ Given, When, Then, And }) => {
    Given("I create an Angular mock with pagination:", () => {
      resetState();
      const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
      mock("GET /api/items", ({ query }: { query: Record<string, string> }) =>
        paginate(items, {
          page: Number.parseInt(query.page || "1", 10),
          pageSize: Number.parseInt(query.pageSize || "2", 10),
        }),
      );
    });

    When(
      "I make an Angular request to {string}",
      async (_, request: string) => {
        const [method, urlWithQuery] = request.split(" ");
        await makeRequest(method, urlWithQuery);
      },
    );

    Then("the response should be an HttpResponse", () => {
      expect(response).toBeInstanceOf(HttpResponse);
    });

    And(
      "the response body should have {int} items in data",
      (_, count: number) => {
        expect(response?.body.data).toHaveLength(count);
      },
    );

    And("the response should have total {int}", (_, total: number) => {
      expect(response?.body.total).toBe(total);
    });

    And(
      "the response should have totalPages {int}",
      (_, totalPages: number) => {
        expect(response?.body.totalPages).toBe(totalPages);
      },
    );
  });

  // Adapter Configuration Options Scenarios

  Scenario(
    "Use baseUrl to filter intercepted requests",
    ({ Given, When, Then, And }) => {
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

      Then("the response should be an HttpResponse", () => {
        expect(response).toBeInstanceOf(HttpResponse);
      });

      And("the status should be {int}", (_, status: number) => {
        expect(response?.status).toBe(status);
      });
    },
  );

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

  Scenario(
    "Handle full URLs with protocol and host",
    ({ Given, When, Then, And }) => {
      Given("I create an Angular mock with:", () => {
        resetState();
        mock("GET /api/users", [200, { users: [] }]);
      });

      When(
        "I make an Angular request to {string}",
        async (_, request: string) => {
          const [method, url] = request.split(" ", 2);
          await makeRequest(method, url);
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

  Scenario(
    "Extract query parameters from URL",
    ({ Given, When, Then, And }) => {
      Given("I create an Angular mock with query handling:", () => {
        resetState();
        mock("GET /api/search", ({ query }) => [
          200,
          { q: query.q, page: query.page },
        ]);
      });

      When(
        "I make an Angular request to {string}",
        async (_, request: string) => {
          const [method, urlWithQuery] = request.split(" ", 2);
          await makeRequest(method, urlWithQuery);
        },
      );

      Then("the response should be an HttpResponse", () => {
        expect(response).toBeInstanceOf(HttpResponse);
      });

      And("the response body should contain both query parameters", () => {
        expect(response?.body).toHaveProperty("q", "typescript");
        expect(response?.body).toHaveProperty("page", "2");
      });
    },
  );
});
