// Import Angular compiler FIRST before any other imports
import "@angular/compiler";

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import {
  HttpErrorResponse,
  type HttpHandler,
  HttpRequest,
  HttpResponse,
} from "@angular/common/http";
import type { CallableMockInstance } from "@schmock/core";
import { schmock } from "@schmock/core";
import { of } from "rxjs";
import { expect } from "vitest";
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

  const mockNext: HttpHandler = {
    handle: () => of(new HttpResponse({ body: "passthrough" })),
  };

  function resetState() {
    mock = schmock();
    response = null;
    errorResponse = null;
  }

  async function makeRequest(method: string, url: string, body?: any) {
    const InterceptorClass = createSchmockInterceptor(mock);
    const interceptor = new InterceptorClass();

    const request = new HttpRequest(method, url, body);

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
});
