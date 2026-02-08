import { createServer } from "node:http";
import type { Server } from "node:http";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/callback-mocking.feature");

function makeCallbackSpec(receiverPort: number): object {
  return {
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
          responses: { "201": { description: "Created" } },
          callbacks: {
            orderStatus: {
              "{$request.body#/callbackUrl}": {
                post: {
                  requestBody: {
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            status: { type: "string" },
                          },
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
    },
  };
}

// No-port version for the "missing callback URL" scenario
const specNoPort = {
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
        responses: { "201": { description: "Created" } },
        callbacks: {
          orderStatus: {
            "{$request.body#/callbackUrl}": {
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
  Scenario("Callback fires after resource creation", ({ Given, When, Then, And }) => {
    let mock: Schmock.CallableMockInstance;
    let receiver: Server;
    let receiverPort: number;
    let receivedCallback: boolean;

    Given("a mock with a spec defining a callback on POST", () => {
      receivedCallback = false;
    });

    And("a callback receiver is listening", async () => {
      await new Promise<void>((resolve) => {
        receiver = createServer((req, res) => {
          if (req.method === "POST") {
            receivedCallback = true;
          }
          res.writeHead(200);
          res.end();
        });
        receiver.listen(0, "127.0.0.1", () => {
          const addr = receiver.address();
          receiverPort = typeof addr === "object" && addr !== null ? addr.port : 0;
          resolve();
        });
      });

      mock = schmock({ state: {} });
      const spec = makeCallbackSpec(receiverPort);
      mock.pipe(await openapi({ spec }));
    });

    When("I create a resource with a callback URL", async () => {
      await mock.handle("POST", "/orders", {
        body: {
          item: "widget",
          callbackUrl: `http://127.0.0.1:${receiverPort}/webhook`,
        },
        headers: { "content-type": "application/json" },
      });
      // Wait a bit for fire-and-forget callback to arrive
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    Then("the callback receiver gets a POST request", () => {
      receiver.close();
      expect(receivedCallback).toBe(true);
    });
  });

  Scenario("Missing callback URL is silently skipped", ({ Given, When, Then }) => {
    let mock: Schmock.CallableMockInstance;
    let response: Schmock.Response;

    Given("a mock with a spec defining a callback on POST", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: specNoPort }));
    });

    When("I create a resource without a callback URL", async () => {
      response = await mock.handle("POST", "/orders", {
        body: { item: "widget" },
        headers: { "content-type": "application/json" },
      });
    });

    Then("no error is raised", () => {
      // Should not throw, and status should not be 500
      expect(response.status).not.toBe(500);
    });
  });
});
