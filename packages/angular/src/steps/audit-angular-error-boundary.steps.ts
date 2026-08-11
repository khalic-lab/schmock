// Import Angular compiler FIRST before any other imports
import "@angular/compiler";

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import {
  HttpErrorResponse,
  type HttpEvent,
  type HttpHandler,
  HttpRequest,
  HttpResponse,
} from "@angular/common/http";
import type { CallableMockInstance } from "@schmock/core";
import { schmock } from "@schmock/core";
import { of } from "rxjs";
import { expect, vi } from "vitest";
import type { AngularAdapterOptions } from "../index";
import { createSchmockInterceptor } from "../index";

const feature = await loadFeature(
  "../../features/audit-angular-error-boundary.feature",
);

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let interceptorOptions: AngularAdapterOptions | undefined;
  let settled: HttpResponse<unknown> | HttpErrorResponse | undefined;
  let errorFormatter: ReturnType<typeof vi.fn> | undefined;

  const mockNext: HttpHandler = {
    handle: () => of(new HttpResponse({ body: "passthrough" })),
  };

  function makeFormatter() {
    errorFormatter = vi.fn((error: Error) => ({
      customFormat: true,
      errorMessage: error.message,
    }));
    return errorFormatter as unknown as NonNullable<
      AngularAdapterOptions["errorFormatter"]
    >;
  }

  function reset() {
    mock = schmock({ state: {} });
    interceptorOptions = undefined;
    settled = undefined;
    errorFormatter = undefined;
  }

  async function makeRequest(requestSpec: string): Promise<void> {
    const [, path] = requestSpec.split(" ");
    const InterceptorClass = createSchmockInterceptor(mock, interceptorOptions);
    const interceptor = new InterceptorClass();
    // Every boundary scenario issues a GET; the spec string carries the
    // method only so the Gherkin step reads naturally.
    const request = new HttpRequest<unknown>("GET", String(path));

    await new Promise<void>((resolve, reject) => {
      // The Observable must always settle — a hook throwing outside the
      // error boundary would hang this forever.
      const timeout = setTimeout(
        () => reject(new Error("Observable never settled")),
        2_000,
      );
      interceptor.intercept(request, mockNext).subscribe({
        next: (event: HttpEvent<unknown>) => {
          if (event instanceof HttpResponse) settled = event;
        },
        complete: () => {
          clearTimeout(timeout);
          resolve();
        },
        error: (error: unknown) => {
          clearTimeout(timeout);
          settled =
            error instanceof HttpErrorResponse
              ? error
              : new HttpErrorResponse({ error });
          resolve();
        },
      });
    });
  }

  Scenario(
    "A throwing transformRequest yields a formatted HttpErrorResponse",
    ({ Given, When, Then, And }) => {
      Given(
        "an Angular mock with a transformRequest that throws and a custom errorFormatter",
        () => {
          reset();
          mock("GET /api/users", [200, { users: [] }]);
          interceptorOptions = {
            errorFormatter: makeFormatter(),
            transformRequest: () => {
              throw new Error("transform blew up");
            },
          };
        },
      );

      When(
        'I make an Angular boundary request to "GET /api/users"',
        async () => {
          await makeRequest("GET /api/users");
        },
      );

      Then("the Angular boundary result is an HttpErrorResponse", () => {
        expect(settled).toBeInstanceOf(HttpErrorResponse);
      });

      And("the Angular boundary error status is 500", () => {
        expect((settled as HttpErrorResponse).status).toBe(500);
      });

      And(
        "the Angular boundary error body uses the custom error format",
        () => {
          expect((settled as HttpErrorResponse).error).toHaveProperty(
            "customFormat",
            true,
          );
        },
      );
    },
  );

  Scenario(
    "A spread-style transformResponse does not suppress errorFormatter",
    ({ Given, When, Then, And }) => {
      Given(
        "an Angular mock whose route throws and a transformResponse that spreads the response",
        () => {
          reset();
          mock("GET /api/boom", () => {
            throw new Error("route blew up");
          });
          interceptorOptions = {
            errorFormatter: makeFormatter(),
            // The documented hook shape: an object spread drops the
            // non-enumerable provenance symbol.
            transformResponse: (response) => ({
              ...response,
              headers: { ...response.headers, "x-mock": "true" },
            }),
          };
        },
      );

      When(
        'I make an Angular boundary request to "GET /api/boom"',
        async () => {
          await makeRequest("GET /api/boom");
        },
      );

      Then("the Angular boundary result is an HttpErrorResponse", () => {
        expect(settled).toBeInstanceOf(HttpErrorResponse);
      });

      And("the Angular boundary error status is 500", () => {
        expect((settled as HttpErrorResponse).status).toBe(500);
      });

      And(
        "the Angular boundary error body uses the custom error format",
        () => {
          expect((settled as HttpErrorResponse).error).toHaveProperty(
            "customFormat",
            true,
          );
          expect((settled as HttpErrorResponse).error).toHaveProperty(
            "errorMessage",
            "route blew up",
          );
        },
      );
    },
  );

  Scenario(
    "A deliberate domain 500 is never reformatted",
    ({ Given, When, Then, And }) => {
      Given("an Angular mock returning a deliberate 500 domain body", () => {
        reset();
        mock("GET /api/declined", [
          500,
          { error: "domain failure", code: "DOMAIN_DECLINED" },
        ]);
        interceptorOptions = { errorFormatter: makeFormatter() };
      });

      When(
        'I make an Angular boundary request to "GET /api/declined"',
        async () => {
          await makeRequest("GET /api/declined");
        },
      );

      Then("the Angular boundary result is an HttpErrorResponse", () => {
        expect(settled).toBeInstanceOf(HttpErrorResponse);
      });

      And("the Angular boundary error status is 500", () => {
        expect((settled as HttpErrorResponse).status).toBe(500);
      });

      And("the Angular boundary error formatter was not called", () => {
        expect(errorFormatter).not.toHaveBeenCalled();
      });
    },
  );
});
