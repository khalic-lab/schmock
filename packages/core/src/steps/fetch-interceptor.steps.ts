/// <reference path="../../schmock.d.ts" />

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, type Mock, vi } from "vitest";
import { schmock } from "../index.js";

const feature = await loadFeature("../../features/fetch-interceptor.feature");

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance;
  let handle: Schmock.InterceptHandle | undefined;
  let originalFetch: typeof globalThis.fetch;
  let savedFetch: Mock<typeof globalThis.fetch>;
  let fetchResponse: Response | undefined;
  let additionalHandles: Schmock.InterceptHandle[] = [];

  function setup() {
    originalFetch = globalThis.fetch;
    savedFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("real backend"));
    globalThis.fetch = savedFetch;
    mock = schmock();
    fetchResponse = undefined;
    additionalHandles = [];
  }

  AfterEachScenario(() => {
    handle?.restore();
    for (const additionalHandle of additionalHandles) {
      additionalHandle.restore();
    }
    handle = undefined;
    additionalHandles = [];
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  Scenario(
    "Intercept a matched fetch request",
    ({ Given, When, Then, And }) => {
      Given(
        'a Schmock instance with route "GET /api/users" returning users',
        () => {
          setup();
          mock("GET /api/users", [{ id: 1, name: "Alice" }]);
        },
      );

      And("fetch is intercepted", () => {
        handle = mock.intercept();
      });

      When('I fetch "/api/users"', async () => {
        fetchResponse = await fetch("http://localhost/api/users");
      });

      Then("the fetch response status should be 200", () => {
        expect(fetchResponse?.status).toBe(200);
      });

      And("the fetch response body should be the mocked users", async () => {
        const body = await fetchResponse?.json();
        expect(body).toEqual([{ id: 1, name: "Alice" }]);
      });
    },
  );

  Scenario(
    "A lowercase percent-encoded route matches a literal Unicode URL",
    ({ Given, When, Then, And }) => {
      Given("a Schmock route using lowercase percent escapes for café", () => {
        setup();
        mock("GET /caf%c3%a9/:name", ({ params }) => ({
          name: params.name,
        }));
      });

      And("fetch is intercepted with passthrough enabled", () => {
        handle = mock.intercept({ passthrough: true });
      });

      When("I fetch the equivalent literal Unicode URL", async () => {
        fetchResponse = await fetch("http://localhost/café/Ana Lía");
      });

      Then(
        "the Unicode fetch response should be 200 with the decoded captured name",
        async () => {
          expect(fetchResponse?.status).toBe(200);
          expect(await fetchResponse?.json()).toEqual({ name: "Ana Lía" });
        },
      );

      And("the original fetch should not have been called", () => {
        expect(savedFetch).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "A Unicode path-form baseUrl matches an equivalent encoded path",
    ({ Given, When, Then, And }) => {
      Given(
        'a Schmock instance with route "GET /café/users" returning users',
        () => {
          setup();
          mock("GET /café/users", [{ id: 1 }]);
        },
      );

      And('fetch is intercepted with Unicode path-form baseUrl "/café"', () => {
        handle = mock.intercept({ baseUrl: "/café" });
      });

      When("I fetch the lowercase percent-encoded Unicode path", async () => {
        fetchResponse = await fetch("http://localhost/caf%c3%a9/users");
      });

      Then(
        "the Unicode baseUrl response body should be the mocked users",
        async () => {
          expect(await fetchResponse?.json()).toEqual([{ id: 1 }]);
        },
      );

      And("the original fetch should not have been called", () => {
        expect(savedFetch).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "A Unicode origin-form baseUrl matches an equivalent literal path",
    ({ Given, When, Then, And }) => {
      Given(
        'a Schmock instance with route "GET /café/users" returning users',
        () => {
          setup();
          mock("GET /café/users", [{ id: 1 }]);
        },
      );

      And(
        'fetch is intercepted with origin-form baseUrl "https://api.example.com/caf%c3%a9"',
        () => {
          handle = mock.intercept({
            baseUrl: "https://api.example.com/caf%c3%a9",
          });
        },
      );

      When(
        "I fetch the literal Unicode URL on the configured origin",
        async () => {
          fetchResponse = await fetch("https://api.example.com/café/users");
        },
      );

      Then(
        "the Unicode baseUrl response body should be the mocked users",
        async () => {
          expect(await fetchResponse?.json()).toEqual([{ id: 1 }]);
        },
      );

      And("the original fetch should not have been called", () => {
        expect(savedFetch).not.toHaveBeenCalled();
      });
    },
  );

  Scenario("Passthrough for unmatched routes", ({ Given, When, Then, And }) => {
    Given(
      'a Schmock instance with route "GET /api/users" returning users',
      () => {
        setup();
        mock("GET /api/users", [{ id: 1 }]);
      },
    );

    And("fetch is intercepted with passthrough enabled", () => {
      handle = mock.intercept({ passthrough: true });
    });

    When('I fetch "/api/other"', async () => {
      fetchResponse = await fetch("http://localhost/api/other");
    });

    Then("the original fetch should have been called", () => {
      expect(savedFetch).toHaveBeenCalled();
    });
  });

  Scenario("Passthrough disabled returns 404", ({ Given, When, Then, And }) => {
    Given(
      'a Schmock instance with route "GET /api/users" returning users',
      () => {
        setup();
        mock("GET /api/users", [{ id: 1 }]);
      },
    );

    And("fetch is intercepted with passthrough disabled", () => {
      handle = mock.intercept({ passthrough: false });
    });

    When('I fetch "/api/other"', async () => {
      fetchResponse = await fetch("http://localhost/api/other");
    });

    Then("the fetch response status should be 404", () => {
      expect(fetchResponse?.status).toBe(404);
    });
  });

  Scenario("Restore puts original fetch back", ({ Given, When, Then, And }) => {
    let savedRef: typeof globalThis.fetch;

    Given(
      'a Schmock instance with route "GET /api/users" returning users',
      () => {
        setup();
        mock("GET /api/users", [{ id: 1 }]);
      },
    );

    And("fetch is intercepted", () => {
      savedRef = globalThis.fetch;
      handle = mock.intercept();
    });

    When("I restore the interceptor", () => {
      handle?.restore();
    });

    Then("globalThis.fetch should be the original function", () => {
      expect(globalThis.fetch).toBe(savedRef);
    });
  });

  Scenario(
    "BaseUrl filters which requests are intercepted",
    ({ Given, When, Then, And }) => {
      Given(
        'a Schmock instance with route "GET /api/users" returning users',
        () => {
          setup();
          mock("GET /api/users", [{ id: 1 }]);
        },
      );

      And('fetch is intercepted with baseUrl "/api"', () => {
        handle = mock.intercept({ baseUrl: "/api" });
      });

      When('I fetch "/other/endpoint"', async () => {
        await fetch("http://localhost/other/endpoint");
      });

      Then("the original fetch should have been called", () => {
        expect(savedFetch).toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "Origin-form baseUrl intercepts matching origin only",
    ({ Given, When, Then, And }) => {
      Given(
        'a Schmock instance with route "GET /api/users" returning users',
        () => {
          setup();
          mock("GET /api/users", [{ id: 1 }]);
        },
      );

      And('fetch is intercepted with baseUrl "https://api.example.com"', () => {
        handle = mock.intercept({ baseUrl: "https://api.example.com" });
      });

      When('I fetch "https://api.example.com/api/users"', async () => {
        fetchResponse = await fetch("https://api.example.com/api/users");
      });

      Then("the response status should be {int}", (_, status: number) => {
        expect(fetchResponse?.status).toBe(status);
      });

      And("the fetch response body should be the mocked users", async () => {
        expect(await fetchResponse?.json()).toEqual([{ id: 1 }]);
      });

      And("the original fetch should not have been called", () => {
        expect(savedFetch).not.toHaveBeenCalled();
      });

      When('I fetch "https://other.example.com/api/users"', async () => {
        await fetch("https://other.example.com/api/users");
      });

      Then(
        "the original fetch should have been called exactly once for {string}",
        (_, url: string) => {
          expect(savedFetch).toHaveBeenCalledOnce();
          const [input, ...remainingArguments] = savedFetch.mock.calls[0];
          expect(remainingArguments).toEqual([]);
          expect(input).toBeInstanceOf(Request);
          if (!(input instanceof Request)) {
            throw new Error("Expected passthrough to receive a Request");
          }
          expect(input.url).toBe(url);
        },
      );
    },
  );

  Scenario(
    "Origin-form baseUrl with a path prefix requires both to match",
    ({ Given, When, Then, And }) => {
      Given(
        'a Schmock instance with route "GET /v1/users" returning users',
        () => {
          setup();
          mock("GET /v1/users", [{ id: 1 }]);
        },
      );

      And(
        'fetch is intercepted with baseUrl "https://api.example.com/v1"',
        () => {
          handle = mock.intercept({ baseUrl: "https://api.example.com/v1" });
        },
      );

      When('I fetch "https://api.example.com/v1/users"', async () => {
        fetchResponse = await fetch("https://api.example.com/v1/users");
      });

      Then("the response status should be {int}", (_, status: number) => {
        expect(fetchResponse?.status).toBe(status);
      });

      And("the fetch response body should be the mocked users", async () => {
        expect(await fetchResponse?.json()).toEqual([{ id: 1 }]);
      });

      And("the original fetch should not have been called", () => {
        expect(savedFetch).not.toHaveBeenCalled();
      });

      When('I fetch "https://api.example.com/users"', async () => {
        await fetch("https://api.example.com/users");
      });

      Then(
        "the original fetch should have been called exactly once for {string}",
        (_, url: string) => {
          expect(savedFetch).toHaveBeenCalledOnce();
          const [input, ...remainingArguments] = savedFetch.mock.calls[0];
          expect(remainingArguments).toEqual([]);
          expect(input).toBeInstanceOf(Request);
          if (!(input instanceof Request)) {
            throw new Error("Expected passthrough to receive a Request");
          }
          expect(input.url).toBe(url);
        },
      );
    },
  );

  Scenario(
    "beforeRequest hook modifies the request",
    ({ Given, When, Then, And }) => {
      Given(
        'a Schmock instance with route "GET /api/users" that reads headers',
        () => {
          setup();
          mock("GET /api/users", ({ headers }) => [
            200,
            { token: headers["x-token"] },
          ]);
        },
      );

      And(
        "fetch is intercepted with a beforeRequest hook that adds a header",
        () => {
          handle = mock.intercept({
            beforeRequest: (req) => ({
              ...req,
              headers: { ...req.headers, "x-token": "injected" },
            }),
          });
        },
      );

      When('I fetch "/api/users"', async () => {
        fetchResponse = await fetch("http://localhost/api/users");
      });

      Then(
        "the response should contain the injected header value",
        async () => {
          const body = await fetchResponse?.json();
          expect(body).toEqual({ token: "injected" });
        },
      );
    },
  );

  Scenario(
    "beforeResponse hook modifies the response",
    ({ Given, When, Then, And }) => {
      Given(
        'a Schmock instance with route "GET /api/users" returning users',
        () => {
          setup();
          mock("GET /api/users", [{ id: 1 }]);
        },
      );

      And(
        "fetch is intercepted with a beforeResponse hook that adds a header",
        () => {
          handle = mock.intercept({
            beforeResponse: (res) => ({
              ...res,
              headers: { ...res.headers, "x-mock": "true" },
            }),
          });
        },
      );

      When('I fetch "/api/users"', async () => {
        fetchResponse = await fetch("http://localhost/api/users");
      });

      Then("the fetch response should have the injected header", () => {
        expect(fetchResponse?.headers.get("x-mock")).toBe("true");
      });
    },
  );

  Scenario(
    "One mock holds two concurrent leases",
    ({ Given, When, Then, And }) => {
      let olderLease: Schmock.InterceptHandle | undefined;
      let newerLease: Schmock.InterceptHandle | undefined;
      let olderResponse: Response | undefined;
      let newerResponse: Response | undefined;

      Given(
        "a Schmock instance with a route under each of two base URLs",
        () => {
          setup();
          mock("GET /alpha/ping", { lease: "alpha" });
          mock("GET /beta/ping", { lease: "beta" });
        },
      );

      And(
        "the same mock intercepts fetch twice with different base URLs",
        () => {
          olderLease = mock.intercept({ baseUrl: "/alpha" });
          newerLease = mock.intercept({ baseUrl: "/beta" });
          additionalHandles.push(olderLease, newerLease);
        },
      );

      When("I fetch through each lease", async () => {
        olderResponse = await fetch("http://localhost/alpha/ping");
        newerResponse = await fetch("http://localhost/beta/ping");
      });

      Then("each lease should serve its own base URL", async () => {
        expect(await olderResponse?.json()).toEqual({ lease: "alpha" });
        expect(await newerResponse?.json()).toEqual({ lease: "beta" });
        expect(savedFetch).not.toHaveBeenCalled();
      });

      When("I restore the newer lease", () => {
        newerLease?.restore();
      });

      Then("the older lease should still serve its own base URL", async () => {
        expect(olderLease?.active).toBe(true);
        expect(newerLease?.active).toBe(false);
        const response = await fetch("http://localhost/alpha/ping");
        expect(await response.json()).toEqual({ lease: "alpha" });
      });

      When("I restore the older lease", () => {
        olderLease?.restore();
      });

      Then("globalThis.fetch should be the original function", () => {
        expect(globalThis.fetch).toBe(savedFetch);
      });
    },
  );

  Scenario(
    "Two leases of one mock report a single unmatched request",
    ({ Given, When, Then, And }) => {
      let lifecycleEvents: string[] = [];

      Given("a Schmock instance with lifecycle listeners and a route", () => {
        setup();
        mock("GET /api/hit", { hit: true });
        lifecycleEvents = [];
        mock.on("request:start", () => {
          lifecycleEvents.push("request:start");
        });
        mock.on("request:notfound", () => {
          lifecycleEvents.push("request:notfound");
        });
        mock.on("request:end", () => {
          lifecycleEvents.push("request:end");
        });
      });

      And("the same mock intercepts fetch twice", () => {
        additionalHandles.push(mock.intercept(), mock.intercept());
      });

      When("I fetch an unmatched route", async () => {
        await fetch("http://localhost/api/miss");
      });

      Then("the lifecycle events should fire exactly once", () => {
        expect(lifecycleEvents).toEqual([
          "request:start",
          "request:notfound",
          "request:end",
        ]);
        expect(savedFetch).toHaveBeenCalledOnce();
      });
    },
  );

  Scenario(
    "Updating lease options preserves stack position",
    ({ Given, When, Then, And }) => {
      let newerMock: Schmock.CallableMockInstance;
      let newerHandle: Schmock.InterceptHandle | undefined;

      Given(
        'an older mock and a newer mock both serving "GET /api/shared"',
        () => {
          setup();
          const echoLease = ({ headers }: Schmock.RequestContext) => ({
            source: "older",
            marker: headers["x-lease"] ?? null,
          });
          mock("GET /api/shared", echoLease);
          mock("GET /api/older", echoLease);
          newerMock = schmock();
          newerMock("GET /api/shared", { source: "newer" });
          handle = mock.intercept();
          newerHandle = newerMock.intercept();
          additionalHandles.push(newerHandle);
        },
      );

      When("the older lease updates its options in place", () => {
        handle?.update({
          beforeRequest: (request) => ({
            ...request,
            headers: { ...request.headers, "x-lease": "updated" },
          }),
        });
      });

      Then("the newer mock should still win the shared route", async () => {
        const response = await fetch("http://localhost/api/shared");
        expect(await response.json()).toEqual({ source: "newer" });
      });

      And("the older lease should apply its updated options", async () => {
        const response = await fetch("http://localhost/api/older");
        expect(await response.json()).toEqual({
          source: "older",
          marker: "updated",
        });
      });
    },
  );

  Scenario(
    "Multiple mocks compose from newest to oldest",
    ({ Given, When, Then, And }) => {
      let newerMock: Schmock.CallableMockInstance;
      let newerHandle: Schmock.InterceptHandle | undefined;
      let sharedResponse: Response | undefined;
      let olderResponse: Response | undefined;

      Given(
        'an older mock for both routes and a newer mock for "GET /api/shared"',
        () => {
          setup();
          mock("GET /api/older", { source: "older" });
          mock("GET /api/shared", { source: "older" });
          newerMock = schmock();
          newerMock("GET /api/shared", { source: "newer" });
        },
      );

      And("both mocks intercept fetch in that order", () => {
        handle = mock.intercept();
        newerHandle = newerMock.intercept();
        additionalHandles.push(newerHandle);
      });

      When("I fetch the shared and older routes", async () => {
        sharedResponse = await fetch("http://localhost/api/shared");
        olderResponse = await fetch("http://localhost/api/older");
      });

      Then("the shared route should use the newer mock", async () => {
        expect(await sharedResponse?.json()).toEqual({ source: "newer" });
      });

      And("the older route should fall through to the older mock", async () => {
        expect(await olderResponse?.json()).toEqual({ source: "older" });
      });
    },
  );

  Scenario(
    "Interceptors can be restored out of order",
    ({ Given, When, Then }) => {
      let newerMock: Schmock.CallableMockInstance;
      let newerHandle: Schmock.InterceptHandle | undefined;
      let newerResponse: Response | undefined;

      Given("an older mock and a newer mock both intercepting fetch", () => {
        setup();
        mock("GET /api/older", { source: "older" });
        newerMock = schmock();
        newerMock("GET /api/newer", { source: "newer" });
        handle = mock.intercept();
        newerHandle = newerMock.intercept();
        additionalHandles.push(newerHandle);
      });

      When("I restore the older interceptor first", () => {
        handle?.restore();
      });

      Then("the newer interceptor should remain active", async () => {
        newerResponse = await fetch("http://localhost/api/newer");
        expect(newerHandle?.active).toBe(true);
        expect(await newerResponse.json()).toEqual({ source: "newer" });
      });

      When("I restore the newer interceptor", () => {
        newerHandle?.restore();
      });

      Then("globalThis.fetch should be the original function", () => {
        expect(globalThis.fetch).toBe(savedFetch);
      });
    },
  );

  Scenario(
    "Restore preserves a third-party fetch replacement",
    ({ Given, When, Then, And }) => {
      let replacementFetch: Mock<typeof globalThis.fetch>;

      Given("fetch is intercepted", () => {
        setup();
        handle = mock.intercept();
      });

      When("another library replaces globalThis.fetch", () => {
        replacementFetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(new Response("third-party backend"));
        globalThis.fetch = replacementFetch;
      });

      And("I restore the interceptor", () => {
        handle?.restore();
      });

      Then("the third-party fetch replacement should remain installed", () => {
        expect(globalThis.fetch).toBe(replacementFetch);
      });
    },
  );

  Scenario(
    "RequestInit overrides the input Request",
    ({ Given, When, Then }) => {
      Given(
        "an intercepted route that reports the effective fetch request",
        () => {
          setup();
          mock("PATCH /effective", ({ method, headers, body }) => ({
            method,
            source: headers["x-source"],
            body,
          }));
          handle = mock.intercept({ passthrough: false });
        },
      );

      When(
        "I fetch a Request with overriding method headers and body",
        async () => {
          const input = new Request("http://localhost/effective", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-source": "input",
            },
            body: JSON.stringify({ source: "input" }),
          });
          fetchResponse = await fetch(input, {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-source": "override",
            },
            body: JSON.stringify({ source: "override" }),
          });
        },
      );

      Then(
        "the route should receive the overriding request values",
        async () => {
          expect(await fetchResponse?.json()).toEqual({
            method: "PATCH",
            source: "override",
            body: { source: "override" },
          });
        },
      );
    },
  );

  Scenario(
    "Relative URL fragments do not affect routing",
    ({ Given, When, Then }) => {
      Given('an intercepted route at "/fragmented"', () => {
        setup();
        mock("GET /fragmented", { fragmented: false });
        handle = mock.intercept({ passthrough: false });
      });

      When(
        "I fetch the relative URL {string}",
        async (_, relativeUrl: string) => {
          fetchResponse = await fetch(relativeUrl);
        },
      );

      Then(
        "the fragmented route should return the mocked response",
        async () => {
          expect(await fetchResponse?.json()).toEqual({ fragmented: false });
        },
      );
    },
  );

  Scenario(
    "Text request bodies are not parsed as JSON",
    ({ Given, When, Then }) => {
      Given("an intercepted route that reports its request body type", () => {
        setup();
        mock("POST /text-body", ({ body }) => ({
          bodyType: typeof body,
          body,
        }));
        handle = mock.intercept({ passthrough: false });
      });

      When("I fetch it with a JSON-looking text body", async () => {
        fetchResponse = await fetch("http://localhost/text-body", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: '{"looks":"json"}',
        });
      });

      Then("the route should receive a string body", async () => {
        expect(await fetchResponse?.json()).toEqual({
          bodyType: "string",
          body: '{"looks":"json"}',
        });
      });
    },
  );

  Scenario(
    "Pre-aborted requests do not enter the mock",
    ({ Given, When, Then, And }) => {
      let fetchError: unknown;
      let generatorExecutions = 0;

      Given("an intercepted route that records generator executions", () => {
        setup();
        mock("GET /aborted", () => {
          generatorExecutions += 1;
          return { completed: true };
        });
        handle = mock.intercept({ passthrough: false });
      });

      When("I fetch it with a pre-aborted signal", async () => {
        const controller = new AbortController();
        controller.abort();
        try {
          await fetch("http://localhost/aborted", {
            signal: controller.signal,
          });
        } catch (error) {
          fetchError = error;
        }
      });

      Then("fetch should reject with an abort error", () => {
        expect(fetchError).toMatchObject({ name: "AbortError" });
      });

      And("the aborted request should not execute or enter history", () => {
        expect(generatorExecutions).toBe(0);
        expect(mock.history()).toHaveLength(0);
      });
    },
  );

  Scenario(
    "Reset preserves an explicitly acquired interceptor",
    ({ Given, When, Then, And }) => {
      Given("an intercepted route returning the first generation", () => {
        setup();
        mock("GET /generation", { generation: "first" });
        handle = mock.intercept({ passthrough: false });
      });

      When("I reset and re-register the intercepted route", () => {
        mock.reset();
        mock("GET /generation", { generation: "second" });
      });

      Then("the interceptor handle should remain active", () => {
        expect(handle?.active).toBe(true);
      });

      And("a fetch should return the second generation", async () => {
        fetchResponse = await fetch("http://localhost/generation");
        expect(await fetchResponse.json()).toEqual({ generation: "second" });
        expect(savedFetch).not.toHaveBeenCalled();
      });

      When("I restore the surviving interceptor", () => {
        handle?.restore();
      });

      Then("globalThis.fetch should be the original function", () => {
        expect(globalThis.fetch).toBe(savedFetch);
      });
    },
  );

  Scenario(
    "Relative URLs use the browser base URI",
    ({ Given, When, Then }) => {
      Given("a browser base URI and an intercepted route beneath it", () => {
        setup();
        vi.stubGlobal("document", {
          baseURI: "https://app.example.test/app/page.html",
        });
        mock("GET /app/users", { matched: true });
        handle = mock.intercept({ passthrough: false });
      });

      When("I fetch a document-relative route", async () => {
        fetchResponse = await fetch("users");
      });

      Then("the route beneath the browser base should respond", async () => {
        expect(await fetchResponse?.json()).toEqual({ matched: true });
      });
    },
  );

  Scenario(
    "Malformed JSON can pass through unchanged",
    ({ Given, When, Then, And }) => {
      let errorFormatter: Mock<(error: Error) => unknown>;

      Given(
        "an unmatched intercepted JSON request with a passthrough backend",
        () => {
          setup();
          savedFetch = vi.fn(async (input: RequestInfo | URL) => {
            if (!(input instanceof Request)) {
              throw new Error("Expected a Request snapshot");
            }
            return new Response(await input.text());
          });
          globalThis.fetch = savedFetch;
          errorFormatter = vi.fn(() => ({ formatted: true }));
          mock("POST /matched", { matched: true });
          handle = mock.intercept({ passthrough: true, errorFormatter });
        },
      );

      When("I fetch malformed JSON for the unmatched route", async () => {
        fetchResponse = await fetch("http://localhost/unmatched", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not-json-{broken",
        });
      });

      Then(
        "the passthrough backend should receive the exact malformed body",
        async () => {
          expect(await fetchResponse?.text()).toBe("not-json-{broken");
        },
      );

      And(
        "the malformed passthrough should not be formatted or recorded",
        () => {
          expect(errorFormatter).not.toHaveBeenCalled();
          expect(mock.history()).toHaveLength(0);
        },
      );
    },
  );

  Scenario(
    "Abort settles while an interceptor hook remains pending",
    ({ Given, When, Then }) => {
      let controller: AbortController;
      let requestError: unknown;
      let announceHookStart = () => {};
      let hookStarted: Promise<void>;

      Given("an intercepted request paused in an async hook", () => {
        setup();
        hookStarted = new Promise<void>((resolve) => {
          announceHookStart = resolve;
        });
        mock("GET /pending-hook", { completed: true });
        handle = mock.intercept({
          passthrough: false,
          async beforeRequest() {
            announceHookStart();
            await new Promise<void>(() => {});
          },
        });
      });

      When("I abort the request without releasing the hook", async () => {
        controller = new AbortController();
        const pending = fetch("http://localhost/pending-hook", {
          signal: controller.signal,
        });
        await hookStarted;
        controller.abort();
        try {
          await Promise.race([
            pending,
            new Promise<Response>((_, reject) => {
              setTimeout(() => reject(new Error("abort timed out")), 100);
            }),
          ]);
        } catch (error) {
          requestError = error;
        }
      });

      Then(
        "fetch should settle with an abort error before the hook is released",
        () => {
          expect(requestError).toMatchObject({ name: "AbortError" });
          expect(mock.history()).toHaveLength(0);
        },
      );
    },
  );

  Scenario(
    "Passthrough uses the admitted request snapshot",
    ({ Given, When, Then }) => {
      let headers: Headers;
      let announceHookStart = () => {};
      let releaseHook = () => {};
      let hookStarted: Promise<void>;
      let pendingFetch: Promise<Response>;

      Given("an unmatched request paused before passthrough", () => {
        setup();
        hookStarted = new Promise<void>((resolve) => {
          announceHookStart = resolve;
        });
        const hookBarrier = new Promise<void>((resolve) => {
          releaseHook = resolve;
        });
        headers = new Headers({ "x-snapshot": "original" });
        handle = mock.intercept({
          passthrough: true,
          async beforeRequest(request) {
            announceHookStart();
            await hookBarrier;
            return request;
          },
        });
      });

      When(
        "I mutate its caller-owned headers before releasing it",
        async () => {
          pendingFetch = fetch("http://localhost/unmatched", { headers });
          await hookStarted;
          headers.set("x-snapshot", "mutated");
          releaseHook();
          await pendingFetch;
        },
      );

      Then("passthrough should receive the original header snapshot", () => {
        const [input, ...remainingArguments] = savedFetch.mock.calls[0];
        expect(remainingArguments).toEqual([]);
        if (!(input instanceof Request)) {
          throw new Error("Expected passthrough to receive a Request snapshot");
        }
        expect(input.headers.get("x-snapshot")).toBe("original");
      });
    },
  );

  Scenario(
    "Strict unmatched HEAD responses are bodyless",
    ({ Given, When, Then, And }) => {
      Given("fetch is intercepted with passthrough disabled", () => {
        setup();
        handle = mock.intercept({ passthrough: false });
      });

      When("I fetch an unmatched HEAD route", async () => {
        fetchResponse = await fetch("http://localhost/missing", {
          method: "HEAD",
        });
      });

      Then("the fetch response status should be 404", () => {
        expect(fetchResponse?.status).toBe(404);
      });

      And("the unmatched HEAD response body should be empty", async () => {
        expect(await fetchResponse?.text()).toBe("");
      });
    },
  );

  Scenario(
    "A generator exception reaches the error formatter",
    ({ Given, When, Then, And }) => {
      let errorFormatter: Mock<(error: Error) => unknown>;

      Given("an intercepted route whose generator throws", () => {
        setup();
        errorFormatter = vi.fn((error: Error) => ({
          formatted: true,
          message: error.message,
        }));
        mock("GET /boom", () => {
          throw new Error("kaboom");
        });
        handle = mock.intercept({ passthrough: false, errorFormatter });
      });

      When("I fetch the throwing route", async () => {
        fetchResponse = await fetch("http://localhost/boom");
      });

      Then("the fetch response status should be 500", () => {
        expect(fetchResponse?.status).toBe(500);
      });

      And("the formatted error body should be returned", async () => {
        expect(await fetchResponse?.json()).toEqual({
          formatted: true,
          message: "kaboom",
        });
      });

      And("the error formatter should have been called once", () => {
        expect(errorFormatter).toHaveBeenCalledTimes(1);
      });
    },
  );

  Scenario(
    "A cloning beforeResponse hook keeps exception provenance",
    ({ Given, When, Then, And }) => {
      let errorFormatter: Mock<(error: Error) => unknown>;

      Given(
        "an intercepted throwing route with a spreading beforeResponse hook",
        () => {
          setup();
          errorFormatter = vi.fn((error: Error) => ({
            formatted: true,
            message: error.message,
          }));
          mock("GET /boom", () => {
            throw new Error("kaboom");
          });
          handle = mock.intercept({
            passthrough: false,
            errorFormatter,
            // The documented clone pattern: it copies own enumerable
            // properties only, dropping the non-enumerable provenance mark.
            beforeResponse: (response) => ({ ...response }),
          });
        },
      );

      When("I fetch the throwing route", async () => {
        fetchResponse = await fetch("http://localhost/boom");
      });

      Then("the fetch response status should be 500", () => {
        expect(fetchResponse?.status).toBe(500);
      });

      And("the formatted error body should be returned", async () => {
        expect(await fetchResponse?.json()).toEqual({
          formatted: true,
          message: "kaboom",
        });
      });
    },
  );

  Scenario(
    "An ordinary 500 route response is not reformatted",
    ({ Given, When, Then, And }) => {
      let errorFormatter: Mock<(error: Error) => unknown>;

      Given("an intercepted route returning a plain 500 error body", () => {
        setup();
        errorFormatter = vi.fn(() => ({ formatted: true }));
        mock("GET /domain-error", () => [
          500,
          { error: "upstream unavailable", code: "UPSTREAM_DOWN" },
        ]);
        handle = mock.intercept({ passthrough: false, errorFormatter });
      });

      When("I fetch the plain error route", async () => {
        fetchResponse = await fetch("http://localhost/domain-error");
      });

      Then("the fetch response status should be 500", () => {
        expect(fetchResponse?.status).toBe(500);
      });

      And("the plain error body should be returned unchanged", async () => {
        expect(await fetchResponse?.json()).toEqual({
          error: "upstream unavailable",
          code: "UPSTREAM_DOWN",
        });
      });

      And("the error formatter should not have been called", () => {
        expect(errorFormatter).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "A beforeResponse hook that rewrites an exception status is honoured",
    ({ Given, When, Then, And }) => {
      let errorFormatter: Mock<(error: Error) => unknown>;

      Given(
        "an intercepted throwing route with a beforeResponse hook that rewrites the status",
        () => {
          setup();
          errorFormatter = vi.fn(() => ({ formatted: true }));
          mock("GET /boom", () => {
            throw new Error("kaboom");
          });
          handle = mock.intercept({
            passthrough: false,
            errorFormatter,
            beforeResponse: (response) => ({ ...response, status: 503 }),
          });
        },
      );

      When("I fetch the throwing route", async () => {
        fetchResponse = await fetch("http://localhost/boom");
      });

      Then("the fetch response status should be 503", () => {
        expect(fetchResponse?.status).toBe(503);
      });

      And("the error formatter should not have been called", () => {
        expect(errorFormatter).not.toHaveBeenCalled();
      });
    },
  );
});
