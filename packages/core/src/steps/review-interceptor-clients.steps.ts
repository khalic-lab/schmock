/// <reference path="../../schmock.d.ts" />

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, type Mock, vi } from "vitest";
import { schmock } from "../index.js";

const feature = await loadFeature(
  "../../features/review-interceptor-clients.feature",
);

const NETWORK_BODY = "network backend";

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance;
  let handles: Schmock.InterceptHandle[] = [];
  let originalFetch: typeof globalThis.fetch;
  let networkFetch: Mock<typeof globalThis.fetch>;
  let response: Response | undefined;
  let events: string[] = [];
  let routeBodies: unknown[] = [];

  function setup(): void {
    originalFetch = globalThis.fetch;
    networkFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response(NETWORK_BODY));
    globalThis.fetch = networkFetch;
    mock = schmock();
    handles = [];
    response = undefined;
    events = [];
    routeBodies = [];
    const lifecycle: Schmock.SchmockEvent[] = [
      "request:start",
      "request:notfound",
      "request:end",
    ];
    for (const event of lifecycle) {
      mock.on(event, () => {
        events.push(event);
      });
    }
  }

  function intercept(options?: Schmock.InterceptOptions): void {
    handles.push(mock.intercept(options));
  }

  AfterEachScenario(() => {
    for (const handle of handles.reverse()) {
      handle.restore();
    }
    handles = [];
    globalThis.fetch = originalFetch;
  });

  const stripApi = (request: Schmock.AdapterRequest) => ({
    ...request,
    path: request.path.replace(/^\/api/, ""),
  });

  const addRoleHeader = (request: Schmock.AdapterRequest) => ({
    ...request,
    headers: { ...request.headers, "x-role": "admin" },
  });

  function givenOuterStrippingLease(): void {
    setup();
    mock("GET /admin/users", [{ id: 1 }]);
    intercept({ baseUrl: "/api", beforeRequest: stripApi });
  }

  async function fetchNested(): Promise<void> {
    response = await fetch("http://localhost/api/admin/users");
  }

  async function expectMockedUsers(): Promise<void> {
    expect(networkFetch).not.toHaveBeenCalled();
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual([{ id: 1 }]);
  }

  async function expectErrorCode(status: number, code: string): Promise<void> {
    expect(response?.status).toBe(status);
    const body: unknown = await response?.json();
    expect(body).toMatchObject({ code });
  }

  async function expectNetworkAnswer(): Promise<void> {
    expect(networkFetch).toHaveBeenCalledOnce();
    expect(await response?.text()).toBe(NETWORK_BODY);
  }

  // ── Finding 2: lease de-duplication keys on the effective request ─────────

  Scenario(
    "An older lease whose hook rewrites the request still serves it",
    ({ Given, When, And, Then }) => {
      Given(
        'a mock with route "GET /admin/users" and an outer lease that strips "/api"',
        givenOuterStrippingLease,
      );

      When(
        'an inner lease on the same mock adds a header under "/api/admin"',
        () => {
          intercept({ baseUrl: "/api/admin", beforeRequest: addRoleHeader });
        },
      );

      And('I fetch "/api/admin/users" through the nested leases', fetchNested);

      Then("the nested fetch should be served by the mock", expectMockedUsers);

      And(
        "the mock should have been consulted once per distinct effective request",
        () => {
          // The inner lease asked for /api/admin/users (a miss); the outer
          // lease asked for /admin/users (a hit). Each distinct request is one
          // consultation — never one per lease.
          expect(events).toEqual([
            "request:start",
            "request:notfound",
            "request:end",
            "request:start",
            "request:end",
          ]);
        },
      );
    },
  );

  Scenario(
    "An option-less inner lease does not shadow an outer rewriting lease",
    ({ Given, When, And, Then }) => {
      Given(
        'a mock with route "GET /admin/users" and an outer lease that strips "/api"',
        givenOuterStrippingLease,
      );

      When("an inner lease on the same mock has no options", () => {
        intercept();
      });

      And('I fetch "/api/admin/users" through the nested leases', fetchNested);

      Then("the nested fetch should be served by the mock", expectMockedUsers);
    },
  );

  Scenario(
    "Identical leases of one mock still consult it once",
    ({ Given, When, Then }) => {
      Given(
        'a mock with route "GET /admin/users" and two option-less leases',
        () => {
          setup();
          mock("GET /admin/users", [{ id: 1 }]);
          intercept();
          intercept();
        },
      );

      When(
        'I fetch the unmatched path "/missing" through both leases',
        async () => {
          response = await fetch("http://localhost/missing");
        },
      );

      Then(
        "the mock should report exactly one start, notfound and end event",
        async () => {
          expect(events).toEqual([
            "request:start",
            "request:notfound",
            "request:end",
          ]);
          await expectNetworkAnswer();
        },
      );
    },
  );

  // ── Finding 46: non-standard HTTP methods ─────────────────────────────────

  Scenario(
    "A non-standard method passes through by default",
    ({ Given, When, Then }) => {
      Given(
        "an intercepting mock with default options and a network backend",
        () => {
          setup();
          intercept();
        },
      );

      When(
        'I fetch "https://dav.example.com/files/" with method "PROPFIND"',
        async () => {
          response = await fetch("https://dav.example.com/files/", {
            method: "PROPFIND",
          });
        },
      );

      Then(
        "the network backend should answer the request",
        expectNetworkAnswer,
      );
    },
  );

  Scenario(
    "A non-standard method is a route miss under passthrough false",
    ({ Given, When, Then, And }) => {
      Given(
        "an intercepting mock with passthrough disabled and a network backend",
        () => {
          setup();
          intercept({ passthrough: false });
        },
      );

      When(
        'I fetch "https://dav.example.com/files/" with method "PROPFIND"',
        async () => {
          response = await fetch("https://dav.example.com/files/", {
            method: "PROPFIND",
          });
        },
      );

      Then('the fetch should answer 404 with code "ROUTE_NOT_FOUND"', () =>
        expectErrorCode(404, "ROUTE_NOT_FOUND"),
      );

      And("the network backend should not have been called", () => {
        expect(networkFetch).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "A hook that produces a non-standard method passes through",
    ({ Given, When, Then }) => {
      Given(
        'an intercepting mock whose beforeRequest rewrites the method to "PURGE"',
        () => {
          setup();
          intercept({
            beforeRequest: (request) => ({ ...request, method: "PURGE" }),
          });
        },
      );

      When(
        'I fetch "https://cdn.example.com/asset" with method "GET"',
        async () => {
          response = await fetch("https://cdn.example.com/asset");
        },
      );

      Then(
        "the network backend should answer the request",
        expectNetworkAnswer,
      );
    },
  );

  // ── Finding 47: JSON ingress parity with the Node server ──────────────────

  function givenRecordingRoute(): void {
    setup();
    mock("POST /api/items", ({ body }) => {
      routeBodies.push(body);
      return [201, { stored: true }];
    });
    intercept({ passthrough: false });
  }

  async function postJson(body: string): Promise<void> {
    response = await fetch("http://localhost/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  Scenario(
    "Malformed JSON is a 400 when the mock owns every request",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with a recording "POST /api/items" route and passthrough disabled',
        givenRecordingRoute,
      );

      When(`I post the JSON body '{"name": "x",}' to "/api/items"`, () =>
        postJson('{"name": "x",}'),
      );

      Then('the fetch should answer 400 with code "MALFORMED_JSON"', () =>
        expectErrorCode(400, "MALFORMED_JSON"),
      );

      And("the recording route should not have run", () => {
        expect(routeBodies).toEqual([]);
      });

      And("the mock history should be empty", () => {
        expect(mock.history()).toHaveLength(0);
      });
    },
  );

  Scenario(
    "An empty JSON body reaches the route as undefined",
    ({ Given, When, Then }) => {
      Given(
        'a mock with a recording "POST /api/items" route and passthrough disabled',
        givenRecordingRoute,
      );

      When(`I post the JSON body '' to "/api/items"`, () => postJson(""));

      Then("the recording route should have received an undefined body", () => {
        expect(response?.status).toBe(201);
        expect(routeBodies).toEqual([undefined]);
      });
    },
  );

  // ── Finding 49: Response.url ──────────────────────────────────────────────

  Scenario(
    "A mocked response reports the request URL",
    ({ Given, When, Then }) => {
      Given('an intercepting mock with route "GET /api/page"', () => {
        setup();
        mock("GET /api/page", { page: 2 });
        intercept();
      });

      When('I fetch "http://localhost/api/page?cursor=2#top"', async () => {
        response = await fetch("http://localhost/api/page?cursor=2#top");
      });

      Then(
        'the response url should be "http://localhost/api/page?cursor=2"',
        () => {
          expect(response?.url).toBe("http://localhost/api/page?cursor=2");
        },
      );
    },
  );

  // ── Finding 50: hook-throw formatter output that cannot be serialized ─────

  Scenario(
    "A hook throw with an unserializable formatter body falls back",
    ({ Given, When, Then }) => {
      Given(
        "an intercepting mock whose beforeRequest throws and whose errorFormatter returns a bigint",
        () => {
          setup();
          mock("GET /api/boom", { ok: true });
          intercept({
            beforeRequest: () => {
              throw new Error("hook failed");
            },
            errorFormatter: (error) => ({ code: 1n, message: error.message }),
          });
        },
      );

      When('I fetch "/api/boom" through the throwing hook', async () => {
        response = await fetch("http://localhost/api/boom");
      });

      Then('the fetch should answer 500 with code "INTERNAL_ERROR"', () =>
        expectErrorCode(500, "INTERNAL_ERROR"),
      );
    },
  );

  // ── Cold review: nested leases claim before answering ─────────────────────

  const givenNestedPassthroughLeases =
    'a mock with a route "POST /api/items" held by an older passthrough-disabled lease and a newer default lease';

  function givenOlderStrictLease(): void {
    setup();
    mock("POST /api/items", { stored: true });
    intercept({ passthrough: false });
    intercept();
  }

  async function postJsonTo(path: string, body: string): Promise<void> {
    response = await fetch(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  Scenario(
    "An older passthrough-false lease leaves an unmocked malformed-JSON request to the network",
    ({ Given, When, Then, And }) => {
      Given(givenNestedPassthroughLeases, givenOlderStrictLease);

      When(
        `I post the JSON body '{bad' to "/unmocked" through the nested leases`,
        () => postJsonTo("/unmocked", "{bad"),
      );

      Then(
        "the network backend should answer the request",
        expectNetworkAnswer,
      );

      And(
        "the mock should report exactly one start, notfound and end event",
        () => {
          expect(events).toEqual([
            "request:start",
            "request:notfound",
            "request:end",
          ]);
        },
      );
    },
  );

  Scenario(
    "An older passthrough-false lease leaves an unmocked valid-JSON request to the network",
    ({ Given, When, Then }) => {
      Given(givenNestedPassthroughLeases, givenOlderStrictLease);

      When(
        `I post the JSON body '{}' to "/unmocked" through the nested leases`,
        () => postJsonTo("/unmocked", "{}"),
      );

      Then(
        "the network backend should answer the request",
        expectNetworkAnswer,
      );
    },
  );

  Scenario(
    "An older passthrough-false lease leaves a non-standard method to the network",
    ({ Given, When, Then }) => {
      Given(givenNestedPassthroughLeases, givenOlderStrictLease);

      When(
        'I fetch "https://dav.example.com/files/" with method "PROPFIND"',
        async () => {
          response = await fetch("https://dav.example.com/files/", {
            method: "PROPFIND",
          });
        },
      );

      Then(
        "the network backend should answer the request",
        expectNetworkAnswer,
      );
    },
  );

  // ── Finding 51: path-form baseUrl without a leading slash ─────────────────

  Scenario(
    "A path baseUrl without a leading slash still scopes the lease",
    ({ Given, When, Then, And }) => {
      Given(
        'an intercepting mock with route "GET /api/x" and baseUrl "api" with passthrough disabled',
        () => {
          setup();
          mock("GET /api/x", { scoped: true });
          intercept({ baseUrl: "api", passthrough: false });
        },
      );

      When('I fetch "/api/x" through the scoped lease', async () => {
        response = await fetch("http://localhost/api/x");
      });

      Then("the scoped fetch should be served by the mock", async () => {
        expect(response?.status).toBe(200);
        expect(await response?.json()).toEqual({ scoped: true });
      });

      And("the network backend should not have been called", () => {
        expect(networkFetch).not.toHaveBeenCalled();
      });
    },
  );

  // ── Release notes: a hooked lease still owns the malformed-JSON 400 ───────

  Scenario(
    "A passthrough-false lease with a beforeRequest hook answers malformed JSON with 400 before its hook runs",
    ({ Given, When, Then, And }) => {
      const hook = vi.fn((request: Schmock.AdapterRequest) => request);

      Given(
        'a mock with a recording "POST /api/items" route and a passthrough-disabled lease with a beforeRequest hook',
        () => {
          setup();
          mock("POST /api/items", ({ body }) => {
            routeBodies.push(body);
            return [201, { stored: true }];
          });
          intercept({ passthrough: false, beforeRequest: hook });
        },
      );

      When(`I post the JSON body '{"name": "x",}' to "/api/items"`, () =>
        postJson('{"name": "x",}'),
      );

      Then('the fetch should answer 400 with code "MALFORMED_JSON"', () =>
        expectErrorCode(400, "MALFORMED_JSON"),
      );

      And("the beforeRequest hook should not have run", () => {
        expect(hook).not.toHaveBeenCalled();
      });

      And("the recording route should not have run", () => {
        expect(routeBodies).toEqual([]);
      });
    },
  );

  // ── Release notes: a null body from beforeResponse is labelled JSON ───────

  Scenario(
    "A beforeResponse that returns a null body is labelled JSON",
    ({ Given, When, Then }) => {
      Given(
        'an intercepting mock with route "GET /api/empty" whose beforeResponse returns a null body',
        () => {
          setup();
          mock("GET /api/empty", { replaced: false });
          intercept({
            beforeResponse: () => ({ status: 200, body: null, headers: {} }),
          });
        },
      );

      When('I fetch "/api/empty" through the rewriting lease', async () => {
        response = await fetch("http://localhost/api/empty");
      });

      Then('the response content-type should be "application/json"', () => {
        expect(response?.status).toBe(200);
        expect(response?.headers.get("content-type")).toBe("application/json");
      });
    },
  );
});
