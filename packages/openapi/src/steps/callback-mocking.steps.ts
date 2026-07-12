import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { afterEach, expect, vi } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/callback-mocking.feature");

const callbackSpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/orders": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  item: { type: "string" },
                  callbackUrl: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { result: { type: "string" } },
                  required: ["result"],
                },
              },
            },
          },
        },
        callbacks: {
          orderStatus: {
            "{$request.body#/callbackUrl}": {
              post: {
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { status: { type: "string" } },
                      },
                    },
                  },
                },
                responses: { "200": { description: "OK" } },
              },
            },
          },
        },
      },
    },
    "/nested-orders": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object" },
            },
          },
        },
        responses: { "201": { description: "Created" } },
        callbacks: {
          orderStatus: {
            "{$request.body#/targets/0/callback~0~1url}": {
              post: {
                responses: { "200": { description: "OK" } },
              },
            },
          },
        },
      },
    },
  },
};

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;
  let dispatchedRequests: Schmock.OpenApiCallbackRequest[];
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  Scenario(
    "Callback dispatches after resource creation when explicitly enabled",
    ({ Given, When, Then, And }) => {
      Given("a mock with a spec defining a callback on POST", () => {
        mock = schmock({ state: {} });
        dispatchedRequests = [];
        fetchSpy = vi.spyOn(globalThis, "fetch");
      });

      And("an application callback dispatcher is configured", async () => {
        mock.pipe(
          await openapi({
            spec: callbackSpec,
            callbacks: {
              dispatch(request) {
                dispatchedRequests.push(request);
              },
            },
          }),
        );
      });

      When("I create a resource with a callback URL", async () => {
        response = await mock.handle("POST", "/orders", {
          body: {
            item: "widget",
            callbackUrl: "https://callbacks.example.test/order",
          },
          headers: { "content-type": "application/json" },
        });
      });

      Then("the dispatcher gets a POST callback request", () => {
        expect(dispatchedRequests).toHaveLength(1);
        expect(dispatchedRequests[0]).toMatchObject({
          url: "https://callbacks.example.test/order",
          method: "POST",
        });
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "Callbacks are disabled by default",
    ({ Given, When, Then, And }) => {
      Given("a mock with a spec defining a callback on POST", () => {
        mock = schmock({ state: {} });
        dispatchedRequests = [];
        fetchSpy = vi.spyOn(globalThis, "fetch");
      });

      And("no application callback dispatcher is configured", async () => {
        mock.pipe(await openapi({ spec: callbackSpec }));
      });

      When("I create a resource with a callback URL", async () => {
        response = await mock.handle("POST", "/orders", {
          body: {
            item: "widget",
            callbackUrl: "http://127.0.0.1/internal-target",
          },
          headers: { "content-type": "application/json" },
        });
      });

      Then("no callback request is dispatched", () => {
        expect(response.status).toBe(201);
        expect(dispatchedRequests).toEqual([]);
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "Invalid responses do not dispatch callbacks",
    ({ Given, When, Then, And }) => {
      Given("a mock with a callback and response validation enabled", () => {
        mock = schmock({ state: {} });
        dispatchedRequests = [];
        fetchSpy = vi.spyOn(globalThis, "fetch");
      });

      And("an application callback dispatcher is configured", async () => {
        mock.pipe(
          await openapi({
            spec: callbackSpec,
            validateResponses: true,
            onSchema: () => ({ type: "string", const: "invalid" }),
            callbacks: {
              dispatch(request) {
                dispatchedRequests.push(request);
              },
            },
          }),
        );
      });

      When("I create a resource with a callback URL", async () => {
        response = await mock.handle("POST", "/orders", {
          body: {
            item: "widget",
            callbackUrl: "https://callbacks.example.test/order",
          },
          headers: { "content-type": "application/json" },
        });
      });

      Then("the response status is 500", () => {
        expect(response.status).toBe(500);
      });

      And("no callback request is dispatched", () => {
        expect(dispatchedRequests).toEqual([]);
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "Missing callback URL is silently skipped",
    ({ Given, When, Then, And }) => {
      Given("a mock with a spec defining a callback on POST", () => {
        mock = schmock({ state: {} });
        dispatchedRequests = [];
        fetchSpy = vi.spyOn(globalThis, "fetch");
      });

      And("an application callback dispatcher is configured", async () => {
        mock.pipe(
          await openapi({
            spec: callbackSpec,
            callbacks: {
              dispatch(request) {
                dispatchedRequests.push(request);
              },
            },
          }),
        );
      });

      When("I create a resource without a callback URL", async () => {
        response = await mock.handle("POST", "/orders", {
          body: { item: "widget" },
          headers: { "content-type": "application/json" },
        });
      });

      Then("the response status is 201", () => {
        expect(response.status).toBe(201);
      });

      And("no callback request is dispatched", () => {
        expect(dispatchedRequests).toEqual([]);
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "Callback expressions follow JSON Pointer escaping and array indexes",
    ({ Given, When, Then, And }) => {
      Given("a mock with a spec defining a callback on POST", () => {
        mock = schmock({ state: {} });
        dispatchedRequests = [];
        fetchSpy = vi.spyOn(globalThis, "fetch");
      });

      And("an application callback dispatcher is configured", async () => {
        mock.pipe(
          await openapi({
            spec: callbackSpec,
            callbacks: {
              dispatch(request) {
                dispatchedRequests.push(request);
              },
            },
          }),
        );
      });

      When(
        "I create a resource with a callback URL under an escaped array key",
        async () => {
          response = await mock.handle("POST", "/nested-orders", {
            body: {
              targets: [
                {
                  "callback~/url": "https://callbacks.example.test/nested",
                },
              ],
            },
            headers: { "content-type": "application/json" },
          });
        },
      );

      Then(
        "the dispatcher gets callback URL {string}",
        (_, expectedUrl: string) => {
          expect(response.status).toBe(201);
          expect(dispatchedRequests).toHaveLength(1);
          expect(dispatchedRequests[0]?.url).toBe(expectedUrl);
          expect(fetchSpy).not.toHaveBeenCalled();
        },
      );
    },
  );
});
