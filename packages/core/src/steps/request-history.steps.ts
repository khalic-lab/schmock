import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock, toHttpMethod } from "../index";
import type { CallableMockInstance } from "../types";

const feature = await loadFeature("../../features/request-history.feature");

interface HistoryTableRow {
  field: string;
  value: string;
}

function parseRequest(request: string): {
  method: Schmock.HttpMethod;
  path: string;
} {
  const separator = request.indexOf(" ");
  const methodText = request.slice(0, separator);
  const path = request.slice(separator + 1);
  if (separator <= 0 || !path.startsWith("/")) {
    throw new Error(`Expected request in METHOD /path format, got: ${request}`);
  }
  return { method: toHttpMethod(methodText), path };
}

function requireRecord(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${description} to be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function requireStringRecord(
  value: unknown,
  description: string,
): Record<string, string> {
  const record = requireRecord(value, description);
  const strings: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") {
      throw new Error(`Expected ${description}.${key} to be a string`);
    }
    strings[key] = entry;
  }
  return strings;
}

function parseJson(docString: string): unknown {
  const parsed: unknown = JSON.parse(docString);
  return parsed;
}

function parseRequestOptions(docString: string): Schmock.RequestOptions {
  const parsed = requireRecord(parseJson(docString), "request options");
  const options: Schmock.RequestOptions = {};
  if (parsed.headers !== undefined) {
    options.headers = requireStringRecord(parsed.headers, "request headers");
  }
  if (parsed.query !== undefined) {
    options.query = requireStringRecord(parsed.query, "request query");
  }
  if ("body" in parsed) {
    options.body = parsed.body;
  }
  return options;
}

function requireHistoryTable(table: unknown): HistoryTableRow[] {
  if (!Array.isArray(table)) {
    throw new Error("Expected request history table rows");
  }
  return table.map((candidate) => {
    const row = requireRecord(candidate, "request history table row");
    if (typeof row.field !== "string" || typeof row.value !== "string") {
      throw new Error("Expected request history table field and value strings");
    }
    return { field: row.field, value: row.value };
  });
}

function requestRecordField(
  record: Schmock.RequestRecord,
  field: string,
): unknown {
  switch (field) {
    case "method":
      return record.method;
    case "path":
      return record.path;
    case "params":
      return record.params;
    case "query":
      return record.query;
    case "headers":
      return record.headers;
    case "body":
      return record.body;
    case "timestamp":
      return record.timestamp;
    case "response":
      return record.response;
    default:
      throw new Error(`Unknown request record field: ${field}`);
  }
}

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let response: Schmock.Response;

  Scenario("Record multiple requests", ({ Given, When, And, Then }) => {
    Given("I create a mock with GET and POST user routes", () => {
      mock = schmock();
      mock("GET /users", [{ id: 1 }]);
      mock("POST /users", ({ body }) => [201, body]);
    });

    When("I request {string}", async (_, request: string) => {
      const { method, path } = parseRequest(request);
      response = await mock.handle(method, path);
    });

    And(
      "I request {string} with body:",
      async (_, request: string, docString: string) => {
        const { method, path } = parseRequest(request);
        const body = parseJson(docString);
        response = await mock.handle(method, path, { body });
      },
    );

    And("I request {string}", async (_, request: string) => {
      const { method, path } = parseRequest(request);
      response = await mock.handle(method, path);
    });

    Then("the call count should be 3", () => {
      expect(mock.callCount()).toBe(3);
    });

    And(
      "the call count for {string} should be {int}",
      (_, route: string, count: number) => {
        const { method, path } = parseRequest(route);
        expect(mock.callCount(method, path)).toBe(count);
      },
    );

    And(
      "the call count for {string} should be {int} request",
      (_, route: string, count: number) => {
        const { method, path } = parseRequest(route);
        expect(mock.callCount(method, path)).toBe(count);
      },
    );
  });

  Scenario(
    "Filter history by method and path",
    ({ Given, When, And, Then }) => {
      Given("I create a mock with users and posts routes", () => {
        mock = schmock();
        mock("GET /users", []);
        mock("POST /users", ({ body }) => [201, body]);
        mock("GET /posts", []);
      });

      When("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      And(
        "I request {string} with body:",
        async (_, request: string, docString: string) => {
          const { method, path } = parseRequest(request);
          const body = parseJson(docString);
          response = await mock.handle(method, path, { body });
        },
      );

      And("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      Then(
        "the history for {string} should have {int} record",
        (_, route: string, count: number) => {
          const { method, path } = parseRequest(route);
          expect(mock.history(method, path)).toHaveLength(count);
        },
      );

      And(
        "the history for {string} should have {int} record",
        (_, route: string, count: number) => {
          const { method, path } = parseRequest(route);
          expect(mock.history(method, path)).toHaveLength(count);
        },
      );

      And(
        "the history for {string} should have {int} entry",
        (_, route: string, count: number) => {
          const { method, path } = parseRequest(route);
          expect(mock.history(method, path)).toHaveLength(count);
        },
      );

      And(
        "the history for {string} should have {int} entries",
        (_, route: string, count: number) => {
          const { method, path } = parseRequest(route);
          expect(mock.history(method, path)).toHaveLength(count);
        },
      );
    },
  );

  Scenario(
    "Check if specific route was called",
    ({ Given, When, Then, And }) => {
      Given("I create a mock with users and posts list routes", () => {
        mock = schmock();
        mock("GET /users", []);
        mock("GET /posts", []);
      });

      When("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      Then("{string} should have been called", (_, route: string) => {
        const { method, path } = parseRequest(route);
        expect(mock.called(method, path)).toBe(true);
      });

      And("{string} should not have been called", (_, route: string) => {
        const { method, path } = parseRequest(route);
        expect(mock.called(method, path)).toBe(false);
      });
    },
  );

  Scenario(
    "Request record captures full details",
    ({ Given, When, Then, And }) => {
      Given("I create a mock with a parameterized POST route", () => {
        mock = schmock();
        mock("POST /users/:id", ({ params, body }) => {
          const requestBody = requireRecord(body, "request body");
          return [200, { ...requestBody, id: params.id }];
        });
      });

      When(
        "I request {string} with headers and body:",
        async (_, request: string, docString: string) => {
          const { method, path } = parseRequest(request);
          const options = parseRequestOptions(docString);
          response = await mock.handle(method, path, options);
        },
      );

      Then("the last request should have:", (_, table: unknown) => {
        const record = mock.lastRequest();
        if (!record) {
          throw new Error("Expected a recorded request");
        }
        for (const row of requireHistoryTable(table)) {
          expect(requestRecordField(record, row.field)).toBe(row.value);
        }
      });

      And(
        "the last request params should include {string} = {string}",
        (_, key: string, value: string) => {
          expect(mock.lastRequest()?.params[key]).toBe(value);
        },
      );

      And(
        "the last request headers should include {string} = {string}",
        (_, key: string, value: string) => {
          expect(mock.lastRequest()?.headers[key]).toBe(value);
        },
      );

      And(
        "the last request body should have property {string} with value {string}",
        (_, prop: string, value: string) => {
          const record = mock.lastRequest();
          if (!record) {
            throw new Error("Expected a recorded request");
          }
          expect(requireRecord(record.body, "request body")[prop]).toBe(value);
        },
      );

      And("the last request should have a timestamp", () => {
        const record = mock.lastRequest();
        if (!record) {
          throw new Error("Expected a recorded request");
        }
        expect(typeof record.timestamp).toBe("number");
        expect(record.timestamp).toBeGreaterThan(0);
      });

      And(
        "the last request response status should be {int}",
        (_, status: number) => {
          expect(mock.lastRequest()?.response.status).toBe(status);
        },
      );
    },
  );

  Scenario(
    "Get last request for a specific route",
    ({ Given, When, And, Then }) => {
      Given(
        "I create a mock echoing POST body at {string}",
        (_, path: string) => {
          mock = schmock();
          mock(`POST ${path}`, ({ body }) => [201, body]);
        },
      );

      When(
        "I request {string} with body:",
        async (_, request: string, docString: string) => {
          const { method, path } = parseRequest(request);
          const body = parseJson(docString);
          response = await mock.handle(method, path, { body });
        },
      );

      And(
        "I request {string} with body:",
        async (_, request: string, docString: string) => {
          const { method, path } = parseRequest(request);
          const body = parseJson(docString);
          response = await mock.handle(method, path, { body });
        },
      );

      Then(
        "the last request for {string} body should have property {string} with value {string}",
        (_, route: string, prop: string, value: string) => {
          const { method, path } = parseRequest(route);
          const record = mock.lastRequest(method, path);
          if (!record) {
            throw new Error(`Expected a recorded request for ${route}`);
          }
          expect(requireRecord(record.body, "request body")[prop]).toBe(value);
        },
      );
    },
  );

  Scenario(
    "404 requests are not recorded in history",
    ({ Given, When, Then, And }) => {
      Given("I create a mock with only a users route", () => {
        mock = schmock();
        mock("GET /users", []);
      });

      When("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      Then("the mock should not have been called", () => {
        expect(mock.called()).toBe(false);
      });

      And("the call count should be 0", () => {
        expect(mock.callCount()).toBe(0);
      });
    },
  );

  Scenario(
    "maxHistorySize bounds the history with FIFO eviction",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock with maxHistorySize {int} and a users route",
        (_, maxHistorySize: number) => {
          mock = schmock({ maxHistorySize });
          mock("GET /users", []);
        },
      );

      When(
        "I issue {int} sequenced requests to {string}",
        async (_, count: number, request: string) => {
          const { method, path } = parseRequest(request);
          for (let i = 0; i < count; i++) {
            await mock.handle(method, path, {
              query: { sequence: String(i + 1) },
            });
          }
        },
      );

      Then("the call count should be {int}", (_, expected: number) => {
        expect(mock.callCount()).toBe(expected);
      });

      And(
        "the retained request sequence should be {string}",
        (_, sequence: string) => {
          expect(mock.history().map((record) => record.query.sequence)).toEqual(
            sequence.split(","),
          );
        },
      );
    },
  );

  Scenario(
    "Resetting history preserves routes and shared state",
    ({ Given, When, Then, And }) => {
      Given("I create a stateful mock and record a request", async () => {
        mock = schmock({ state: { marker: "preserved" } });
        mock("GET /stateful", ({ state }) => ({ marker: state.marker }));
        await mock.handle("GET", "/stateful");
        expect(mock.callCount()).toBe(1);
      });

      When("I reset only the request history", () => {
        mock.resetHistory();
      });

      Then("the call count should be {int}", (_, expected: number) => {
        expect(mock.callCount()).toBe(expected);
      });

      And("the registered route should still respond", async () => {
        response = await mock.handle("GET", "/stateful");
        expect(response.status).toBe(200);
      });

      And(
        "the shared state marker should still be {string}",
        (_, marker: string) => {
          expect(mock.getState().marker).toBe(marker);
        },
      );
    },
  );

  Scenario(
    "Full reset prevents stale requests from entering new history",
    ({ Given, When, And, Then }) => {
      let releaseRequest = () => {};
      let requestEntered: Promise<void>;
      let pendingRequest: Promise<Schmock.Response>;
      let admittedResponse: Schmock.Response;

      Given("an admitted request is paused before completion", () => {
        let markEntered = () => {};
        requestEntered = new Promise((resolve) => {
          markEntered = resolve;
        });
        const release = new Promise<void>((resolve) => {
          releaseRequest = resolve;
        });
        mock = schmock();
        mock("GET /generation", async () => {
          markEntered();
          await release;
          return { generation: "old" };
        });
      });

      When("I reset and complete a request in the new generation", async () => {
        pendingRequest = mock.handle("GET", "/generation");
        await requestEntered;
        mock.reset();
        mock("GET /generation", { generation: "new" });
        await mock.handle("GET", "/generation");
      });

      And("I release the admitted request", async () => {
        releaseRequest();
        admittedResponse = await pendingRequest;
      });

      Then("the admitted caller should receive its original response", () => {
        expect(admittedResponse.body).toEqual({ generation: "old" });
      });

      And("history should contain only the new generation request", () => {
        expect(mock.history().map((record) => record.response.body)).toEqual([
          { generation: "new" },
        ]);
      });
    },
  );

  Scenario(
    "Resetting history is a barrier for pending commits",
    ({ Given, When, And, Then }) => {
      let releaseRequest = () => {};
      let requestEntered: Promise<void>;
      let pendingRequest: Promise<Schmock.Response>;

      Given("an admitted request is paused before completion", () => {
        let markEntered = () => {};
        requestEntered = new Promise((resolve) => {
          markEntered = resolve;
        });
        const release = new Promise<void>((resolve) => {
          releaseRequest = resolve;
        });
        mock = schmock();
        mock("GET /pending-history", async () => {
          markEntered();
          await release;
          return { completed: true };
        });
      });

      When("I reset history before releasing the request", async () => {
        pendingRequest = mock.handle("GET", "/pending-history");
        await requestEntered;
        mock.resetHistory();
      });

      And("I release the admitted request", async () => {
        releaseRequest();
        await pendingRequest;
      });

      Then("request history should remain empty", () => {
        expect(mock.history()).toHaveLength(0);
      });
    },
  );

  Scenario(
    "History snapshots request and response sources when recorded",
    ({ Given, When, Then }) => {
      let options: Schmock.RequestOptions;
      let returnedResponse: Schmock.Response;

      Given("a route and mutable nested request options", () => {
        const generatedBody = { nested: { value: "response-original" } };
        options = {
          headers: { "x-source": "header-original" },
          query: { source: "query-original" },
          body: { nested: { value: "request-original" } },
        };
        mock = schmock();
        mock("POST /snapshots", () => generatedBody);
      });

      When(
        "I handle the mutable request and then mutate its sources",
        async () => {
          returnedResponse = await mock.handle("POST", "/snapshots", options);
          if (options.headers) options.headers["x-source"] = "header-mutated";
          if (options.query) options.query.source = "query-mutated";
          const requestBody = requireRecord(options.body, "request body");
          const nestedRequest = requireRecord(
            requestBody.nested,
            "nested request body",
          );
          nestedRequest.value = "request-mutated";
          const responseBody = requireRecord(
            returnedResponse.body,
            "response body",
          );
          const nestedResponse = requireRecord(
            responseBody.nested,
            "nested response body",
          );
          nestedResponse.value = "response-mutated";
        },
      );

      Then(
        "history should retain the original nested request and response values",
        () => {
          const record = mock.lastRequest();
          expect(record).toBeDefined();
          if (!record) return;
          expect(record.headers["x-source"]).toBe("header-original");
          expect(record.query.source).toBe("query-original");
          expect(record.body).toEqual({
            nested: { value: "request-original" },
          });
          expect(record.response.body).toEqual({
            nested: { value: "response-original" },
          });
        },
      );
    },
  );

  Scenario(
    "Shared memory is copied into isolated history snapshots",
    ({ Given, When, Then }) => {
      let sourceBytes: Uint8Array;

      Given("a route and a nested shared-memory request body", () => {
        const shared = new SharedArrayBuffer(4);
        sourceBytes = new Uint8Array(shared);
        sourceBytes.set([1, 2, 3, 4]);
        mock = schmock();
        mock("POST /shared-history", { accepted: true });
      });

      When(
        "I handle the shared-memory request and mutate its source and first history result",
        async () => {
          await mock.handle("POST", "/shared-history", {
            body: {
              raw: sourceBytes.buffer,
              view: new Uint8Array(sourceBytes.buffer, 1, 2),
            },
          });
          sourceBytes.fill(9);

          const firstBody = requireRecord(
            mock.lastRequest()?.body,
            "first shared history body",
          );
          if (!(firstBody.raw instanceof ArrayBuffer)) {
            throw new Error("Expected an ordinary ArrayBuffer snapshot");
          }
          if (!(firstBody.view instanceof Uint8Array)) {
            throw new Error("Expected a Uint8Array snapshot");
          }
          new Uint8Array(firstBody.raw).fill(8);
          firstBody.view.fill(7);
        },
      );

      Then(
        "a later history result should contain the original bytes in ordinary memory",
        () => {
          const body = requireRecord(
            mock.lastRequest()?.body,
            "later shared history body",
          );
          expect(body.raw).toBeInstanceOf(ArrayBuffer);
          expect(body.raw).not.toBeInstanceOf(SharedArrayBuffer);
          expect(body.view).toBeInstanceOf(Uint8Array);
          if (!(body.raw instanceof ArrayBuffer)) {
            throw new Error("Expected an ordinary ArrayBuffer snapshot");
          }
          if (!(body.view instanceof Uint8Array)) {
            throw new Error("Expected a Uint8Array snapshot");
          }
          expect([...new Uint8Array(body.raw)]).toEqual([1, 2, 3, 4]);
          expect(body.view.buffer).toBeInstanceOf(ArrayBuffer);
          expect([...body.view]).toEqual([2, 3]);
        },
      );
    },
  );
});
