import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import type { CallableMockInstance } from "@schmock/core";
import { schmock } from "@schmock/core";
import type { Express } from "express";
import express from "express";
import request from "supertest";
import { expect, vi } from "vitest";
import type { ExpressAdapterOptions } from "../index.js";
import { toExpress } from "../index.js";

const feature = await loadFeature(
  "../../features/audit-express-error-provenance.feature",
);

const FORMATTED = { formatted: true, source: "errorFormatter" } as const;

describeFeature(feature, ({ Scenario }) => {
  let app: Express | undefined;
  let httpResponse: request.Response | undefined;
  let errorFormatter: ReturnType<typeof vi.fn> | undefined;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function mount(
    mock: CallableMockInstance,
    options: ExpressAdapterOptions = {},
  ): void {
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use(toExpress(mock, options));
    app = expressApp;
    httpResponse = undefined;
  }

  function throwingMock(): CallableMockInstance {
    const mock = schmock({ state: {} });
    mock("GET /api/boom", () => {
      throw new Error("route blew up");
    });
    return mock;
  }

  function makeFormatter() {
    errorFormatter = vi.fn(() => ({ ...FORMATTED }));
    return errorFormatter as unknown as NonNullable<
      ExpressAdapterOptions["errorFormatter"]
    >;
  }

  async function send(requestSpec: string): Promise<void> {
    if (!app) throw new Error("Express app has not been mounted");
    const separator = requestSpec.indexOf(" ");
    const path = requestSpec.slice(separator + 1);
    httpResponse = await request(app).get(path);
  }

  function currentResponse(): request.Response {
    if (!httpResponse) throw new Error("HTTP request has not completed");
    return httpResponse;
  }

  Scenario(
    "A spread-style beforeResponse does not suppress errorFormatter",
    ({ Given, When, Then, And }) => {
      Given(
        "an Express mock whose route throws and a beforeResponse that spreads the response",
        () => {
          mount(throwingMock(), {
            errorFormatter: makeFormatter(),
            // The exact pattern documented at docs/express.md — an object
            // spread drops the non-enumerable provenance symbol.
            beforeResponse: (response) => ({
              ...response,
              headers: { ...response.headers, "cache-control": "no-cache" },
            }),
          });
        },
      );

      When('I send an Express request to "GET /api/boom"', async () => {
        await send("GET /api/boom");
      });

      Then("the Express response status is 500", () => {
        expect(currentResponse().status).toBe(500);
      });

      And("the Express response body is the formatted error", () => {
        expect(currentResponse().body).toEqual({ ...FORMATTED });
      });

      And("the Express response body is not the raw core error body", () => {
        const body: unknown = currentResponse().body;
        expect(isRecord(body) && "code" in body).toBe(false);
      });
    },
  );

  Scenario(
    "Response headers survive onto the formatted error",
    ({ Given, When, Then, And }) => {
      Given(
        "an Express mock whose route throws and a beforeResponse that adds a retry-after header",
        () => {
          mount(throwingMock(), {
            errorFormatter: makeFormatter(),
            // Mutates in place, so the non-enumerable provenance symbol
            // survives and the formatter is reached either way — this
            // scenario isolates header preservation.
            beforeResponse: (response) => {
              response.headers = {
                ...response.headers,
                "retry-after": "30",
              };
              return response;
            },
          });
        },
      );

      When('I send an Express request to "GET /api/boom"', async () => {
        await send("GET /api/boom");
      });

      Then("the Express response status is 500", () => {
        expect(currentResponse().status).toBe(500);
      });

      And("the Express response body is the formatted error", () => {
        expect(currentResponse().body).toEqual({ ...FORMATTED });
      });

      And('the Express response header "retry-after" is "30"', () => {
        expect(currentResponse().headers["retry-after"]).toBe("30");
      });

      And(
        'the Express response header "content-type" starts with "application/json"',
        () => {
          expect(currentResponse().headers["content-type"]).toMatch(
            /^application\/json/,
          );
        },
      );
    },
  );

  Scenario(
    "A beforeResponse that rewrites the status is respected",
    ({ Given, When, Then, And }) => {
      Given(
        "an Express mock whose route throws and a beforeResponse that rewrites the status to 503",
        () => {
          mount(throwingMock(), {
            errorFormatter: makeFormatter(),
            // Mutates in place so provenance survives: the post-hook status
            // gate — not a lost symbol — is what must suppress the formatter.
            beforeResponse: (response) => {
              response.status = 503;
              response.body = { error: "try later" };
              return response;
            },
          });
        },
      );

      When('I send an Express request to "GET /api/boom"', async () => {
        await send("GET /api/boom");
      });

      Then("the Express response status is 503", () => {
        expect(currentResponse().status).toBe(503);
      });

      And("the Express error formatter was not called", () => {
        expect(errorFormatter).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "A deliberate domain 500 is never reformatted",
    ({ Given, When, Then, And }) => {
      Given("an Express mock returning a deliberate 500 domain body", () => {
        const mock = schmock({ state: {} });
        mock("GET /api/declined", [
          500,
          { error: "domain failure", code: "DOMAIN_DECLINED" },
        ]);
        mount(mock, { errorFormatter: makeFormatter() });
      });

      When('I send an Express request to "GET /api/declined"', async () => {
        await send("GET /api/declined");
      });

      Then("the Express response status is 500", () => {
        expect(currentResponse().status).toBe(500);
      });

      And("the Express error formatter was not called", () => {
        expect(errorFormatter).not.toHaveBeenCalled();
      });

      And("the Express response body is the raw domain body", () => {
        expect(currentResponse().body).toEqual({
          error: "domain failure",
          code: "DOMAIN_DECLINED",
        });
      });
    },
  );
});
