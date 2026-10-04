/// <reference path="../../schmock.d.ts" />

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, type Mock, vi } from "vitest";
import { acquireFetchRelay, routeRelayedRequest } from "../adapter.js";
import { schmock } from "../index.js";

const feature = await loadFeature("../../features/fetch-relay.feature");

const USERS = [{ id: 1, name: "Ada" }];

const LIFECYCLE_EVENTS: readonly Schmock.SchmockEvent[] = [
  "request:start",
  "request:match",
  "request:notfound",
  "request:end",
];

/** How the last `routeRelayedRequest()` call settled. */
type RelayOutcome =
  | { readonly settled: false }
  | { readonly settled: true; readonly answer: Response | undefined }
  | { readonly settled: true; readonly error: unknown };

function exchangeObserver(seen: Schmock.Exchange[]): Schmock.Plugin {
  return {
    name: "observer",
    process: (context, response) => ({ context, response }),
    onExchange: (exchange) => {
      seen.push(exchange);
    },
  };
}

/** Splits "GET http://localhost/api/users" into its method and URL. */
function parseRequestLine(line: string): { method: string; url: string } {
  const [method, url] = line.split(" ");
  if (method === undefined || url === undefined) {
    throw new Error(`Not a request line: ${line}`);
  }
  return { method, url };
}

/** Resolves once the route started, or once routing settled without it. */
async function startedOrSettled(
  started: Promise<void>,
  pending: Promise<unknown>,
): Promise<void> {
  await Promise.race([
    started,
    pending.then(
      () => undefined,
      () => undefined,
    ),
  ]);
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  const originalFetch = globalThis.fetch;
  let network: Mock<typeof globalThis.fetch>;
  let mock: Schmock.CallableMockInstance;
  let handles: Schmock.InterceptHandle[] = [];
  let holds: Schmock.FetchRelay[] = [];
  let events: string[] = [];
  let endStatuses: number[] = [];
  let seen: Schmock.Exchange[] = [];
  let outcome: RelayOutcome = { settled: false };
  let appInput = "";
  let appInit: RequestInit | undefined;
  let fetchResponse: Response | undefined;
  let release = () => {};
  let routeStarted: Promise<void> = Promise.resolve();

  /** Installs the recording network, then a mock that records its lifecycle. */
  function setup() {
    network = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response("network"));
    globalThis.fetch = network;
    mock = schmock();
    handles = [];
    events = [];
    endStatuses = [];
    seen = [];
    outcome = { settled: false };
    appInput = "";
    appInit = undefined;
    fetchResponse = undefined;
    for (const event of LIFECYCLE_EVENTS) {
      mock.on(event, () => {
        events.push(event);
      });
    }
  }

  AfterEachScenario(() => {
    release();
    release = () => {};
    for (const hold of holds) {
      hold.release();
    }
    holds = [];
    for (const handle of handles.reverse()) {
      handle.restore();
    }
    handles = [];
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    performance.clearMeasures();
  });

  function intercept(options?: Schmock.InterceptOptions) {
    handles.push(mock.intercept(options));
  }

  function givenUsersMock(options?: Schmock.InterceptOptions) {
    setup();
    mock("GET /api/users", USERS);
    intercept(options);
  }

  /** Registers "GET /api/slow", which runs until the steps call release(). */
  function defineWaitingRoute() {
    let announceStart = () => {};
    routeStarted = new Promise<void>((resolve) => {
      announceStart = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock("GET /api/slow", async () => {
      announceStart();
      await gate;
      return USERS;
    });
  }

  function holdRelay() {
    holds.push(acquireFetchRelay());
  }

  async function appFetches(input: string, init?: RequestInit) {
    appInput = input;
    appInit = init;
    fetchResponse = await globalThis.fetch(input, init);
  }

  async function settle(pending: Promise<Response | undefined>) {
    try {
      outcome = { settled: true, answer: await pending };
    } catch (error) {
      outcome = { settled: true, error };
    }
  }

  async function relayRoutes(
    line: string,
    init: Omit<RequestInit, "method" | "signal"> = {},
  ) {
    const { method, url } = parseRequestLine(line);
    const controller = new AbortController();
    await settle(
      routeRelayedRequest(
        new Request(url, { ...init, method, signal: controller.signal }),
      ),
    );
  }

  async function relayRoutesAndAborts(line: string, reason?: unknown) {
    const { method, url } = parseRequestLine(line);
    const controller = new AbortController();
    const pending = routeRelayedRequest(
      new Request(url, { method, signal: controller.signal }),
    );
    await startedOrSettled(routeStarted, pending);
    controller.abort(reason);
    await settle(pending);
    release();
  }

  /** What routing resolved with; rethrows when routing rejected instead. */
  function relayAnswer(): Response | undefined {
    if (!outcome.settled) throw new Error("The relay never routed a request");
    if ("error" in outcome) throw outcome.error;
    return outcome.answer;
  }

  function answeredResponse(): Response {
    const answer = relayAnswer();
    if (answer === undefined) {
      throw new Error("The relay answered nothing; a response was expected");
    }
    return answer;
  }

  function routingError(): unknown {
    if (!outcome.settled) throw new Error("The relay never routed a request");
    if (!("error" in outcome)) {
      throw new Error("Routing resolved; a rejection was expected");
    }
    return outcome.error;
  }

  async function expectAnsweredUsers() {
    const response = answeredResponse();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(USERS);
  }

  /** Leases a second mock answering `GET /api/users` with `body`; returns its lifecycle log. */
  function interceptNewerMock(body: string): string[] {
    const newer = schmock();
    const newerEvents: string[] = [];
    for (const event of LIFECYCLE_EVENTS) {
      newer.on(event, () => {
        newerEvents.push(event);
      });
    }
    newer("GET /api/users", body);
    handles.push(newer.intercept());
    return newerEvents;
  }

  function expectNetworkGotOriginalArguments() {
    expect(network).toHaveBeenCalledOnce();
    const [input, init] = network.mock.calls[0];
    expect(input).toBe(appInput);
    expect(init).toBe(appInit);
  }

  Scenario(
    "A held relay forwards the page's fetches to the network unchanged",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users that intercepts fetch over a recording network',
        () => givenUsersMock(),
      );

      And("a fetch relay is held", () => holdRelay());

      When(
        'the app fetches "http://localhost/api/users" with header "x-trace" set to "abc"',
        async () => {
          await appFetches("http://localhost/api/users", {
            headers: { "x-trace": "abc" },
          });
        },
      );

      Then(
        "the recording network received the fetch with its original arguments",
        () => {
          expectNetworkGotOriginalArguments();
        },
      );

      And("the mock emitted no lifecycle events", () => {
        expect(events).toEqual([]);
      });
    },
  );

  Scenario(
    "A relayed request is answered by the interception leases",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users that intercepts fetch over a recording network',
        () => givenUsersMock(),
      );

      And("a fetch relay is held", () => holdRelay());

      When('the relay routes "GET http://localhost/api/users"', async () => {
        await relayRoutes("GET http://localhost/api/users");
      });

      Then("the relay answered status 200 with the mocked users", async () => {
        await expectAnsweredUsers();
      });

      And('the mock emitted "request:start,request:match,request:end"', () => {
        expect(events).toEqual([
          "request:start",
          "request:match",
          "request:end",
        ]);
      });

      And("the recording network received nothing", () => {
        expect(network).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "A relayed request no lease answers is left to the network",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users that intercepts fetch over a recording network',
        () => givenUsersMock(),
      );

      And("a fetch relay is held", () => holdRelay());

      When('the relay routes "GET http://localhost/api/other"', async () => {
        await relayRoutes("GET http://localhost/api/other");
      });

      Then("the relay answered nothing", () => {
        expect(relayAnswer()).toBeUndefined();
      });

      And("the recording network received nothing", () => {
        expect(network).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "A relayed request is left to the network when no lease is held",
    ({ Given, When, Then }) => {
      Given("no fetch interception lease is held", () => {
        setup();
        // No lease ever patched fetch: the recording network is still in place.
        expect(globalThis.fetch).toBe(network);
      });

      When('the relay routes "GET http://localhost/api/users"', async () => {
        await relayRoutes("GET http://localhost/api/users");
      });

      Then("the relay answered nothing", () => {
        expect(relayAnswer()).toBeUndefined();
      });
    },
  );

  Scenario(
    "Releasing the relay hands fetch back to the page",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users that intercepts fetch over a recording network',
        () => givenUsersMock(),
      );

      And("a fetch relay is held", () => holdRelay());

      When("the relay is released", () => {
        for (const hold of holds) {
          hold.release();
        }
      });

      And('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then(
        "the fetch caller received status 200 with the mocked users",
        async () => {
          expect(fetchResponse?.status).toBe(200);
          expect(await fetchResponse?.json()).toEqual(USERS);
        },
      );

      And("the recording network received nothing", () => {
        expect(network).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "Leases taken while a relay is held are routed by it",
    ({ Given, When, Then, And }) => {
      Given("a fetch relay is held", () => holdRelay());

      And(
        'a mock with route "GET /api/users" returning users that intercepts fetch over a recording network',
        () => givenUsersMock(),
      );

      When('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      And('the relay routes "GET http://localhost/api/users"', async () => {
        await relayRoutes("GET http://localhost/api/users");
      });

      Then(
        "the recording network received the fetch with its original arguments",
        () => {
          expectNetworkGotOriginalArguments();
        },
      );

      And("the relay answered status 200 with the mocked users", async () => {
        await expectAnsweredUsers();
      });
    },
  );

  Scenario(
    "Lease options apply to relayed requests",
    ({ Given, When, Then }) => {
      Given(
        'a mock with route "GET /api/users" returning users that intercepts fetch with baseUrl "/api" and a beforeResponse hook that sets header "x-hooked" to "yes"',
        () =>
          givenUsersMock({
            baseUrl: "/api",
            beforeResponse: (response) => ({
              ...response,
              headers: { ...response.headers, "x-hooked": "yes" },
            }),
          }),
      );

      When('the relay routes "GET http://localhost/api/users"', async () => {
        await relayRoutes("GET http://localhost/api/users");
      });

      Then(
        'the relay answered status 200 with header "x-hooked" set to "yes"',
        () => {
          const response = answeredResponse();
          expect(response.status).toBe(200);
          expect(response.headers.get("x-hooked")).toBe("yes");
        },
      );
    },
  );

  Scenario(
    "A relayed request matches an origin-form baseUrl naming its own origin",
    ({ Given, When, Then }) => {
      Given(
        'a mock with route "GET /api/users" returning users that intercepts fetch with baseUrl "http://localhost/api"',
        () => givenUsersMock({ baseUrl: "http://localhost/api" }),
      );

      When('the relay routes "GET http://localhost/api/users"', async () => {
        await relayRoutes("GET http://localhost/api/users");
      });

      Then("the relay answered status 200 with the mocked users", async () => {
        await expectAnsweredUsers();
      });
    },
  );

  Scenario(
    "Two leases of one mock are consulted once for a relayed request",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users that intercepts fetch twice over a recording network',
        () => {
          givenUsersMock();
          intercept();
        },
      );

      When('the relay routes "GET http://localhost/api/missing"', async () => {
        await relayRoutes("GET http://localhost/api/missing");
      });

      Then("the relay answered nothing", () => {
        expect(relayAnswer()).toBeUndefined();
      });

      And(
        'the mock emitted "request:start,request:notfound,request:end"',
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

  Scenario("A relayed JSON body reaches the route", ({ Given, When, Then }) => {
    Given(
      'a mock with route "POST /api/echo" echoing the body that intercepts fetch over a recording network',
      () => {
        setup();
        mock("POST /api/echo", ({ body }) => body);
        intercept();
      },
    );

    When(
      'the relay routes "POST http://localhost/api/echo" with the JSON body:',
      async (_, docString: string) => {
        await relayRoutes("POST http://localhost/api/echo", {
          headers: { "content-type": "application/json" },
          body: docString,
        });
      },
    );

    Then(
      "the relay answered status 200 with the JSON:",
      async (_, docString: string) => {
        const response = answeredResponse();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(JSON.parse(docString));
      },
    );
  });

  Scenario(
    "Aborting a relayed request cancels it in the mock",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/slow" that waits until released and intercepts fetch over a recording network',
        () => {
          setup();
          defineWaitingRoute();
          intercept();
        },
      );

      And("the mock records its request:end statuses", () => {
        mock.on("request:end", (event) => {
          endStatuses.push(event.status);
        });
      });

      When(
        'the relay routes "GET http://localhost/api/slow" and the request is aborted while the route runs',
        async () => {
          await relayRoutesAndAborts("GET http://localhost/api/slow");
        },
      );

      Then("routing rejected with an AbortError", () => {
        expect(routingError()).toMatchObject({ name: "AbortError" });
      });

      And("the mock ended the request with status 499", async () => {
        // The mock reports the cancellation from its own abort path, which can
        // settle after routing already rejected.
        await vi.waitFor(() => {
          expect(endStatuses).toEqual([499]);
        });
      });
    },
  );

  Scenario(
    "A relayed request rejects as the fetch would",
    ({ Given, When, Then }) => {
      let hookError: Error | undefined;

      Given(
        'a mock with route "GET /api/users" returning users that intercepts fetch with a beforeResponse hook that throws "hook failed"',
        () => {
          hookError = new Error("hook failed");
          const thrown = hookError;
          givenUsersMock({
            beforeResponse: () => {
              throw thrown;
            },
          });
        },
      );

      When('the relay routes "GET http://localhost/api/users"', async () => {
        await relayRoutes("GET http://localhost/api/users");
      });

      Then('routing rejected with the message "hook failed"', () => {
        const error = routingError();
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ message: "hook failed" });
        // As in fetch mode: the hook's own error, not a wrapper or a 500.
        expect(error).toBe(hookError);
      });
    },
  );

  Scenario(
    "A relayed exchange is observed like an intercepted one",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and an exchange observer that intercepts fetch over a recording network',
        () => {
          setup();
          mock("GET /api/users", USERS);
          mock.pipe(exchangeObserver(seen));
          intercept();
        },
      );

      When('the relay routes "GET http://localhost/api/users"', async () => {
        await relayRoutes("GET http://localhost/api/users");
      });

      Then("the number of observed exchanges is 1", () => {
        // A rejected routing would leave nothing to observe; surface it.
        relayAnswer();
        expect(seen).toHaveLength(1);
      });

      And("the observed exchange was answered with status 200", () => {
        expect(seen[0]).toMatchObject({
          outcome: "answered",
          response: { status: 200 },
        });
      });
    },
  );

  Scenario(
    "Fetch stays forwarded until every relay hold is released",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users that intercepts fetch over a recording network',
        () => givenUsersMock(),
      );

      And("two fetch relays are held", () => {
        holdRelay();
        holdRelay();
      });

      Then("both relay holds are active", () => {
        expect(holds.map((hold) => hold.active)).toEqual([true, true]);
      });

      When("the first relay hold is released twice", () => {
        holds[0].release();
        holds[0].release();
      });

      Then(
        "the first relay hold is inactive and the second is still active",
        () => {
          expect(holds.map((hold) => hold.active)).toEqual([false, true]);
        },
      );

      When(
        'the app fetches "http://localhost/api/users" while the second hold is in force',
        async () => {
          await appFetches("http://localhost/api/users");
        },
      );

      Then(
        "the recording network received the fetch with its original arguments",
        () => {
          expectNetworkGotOriginalArguments();
        },
      );

      And("the mock emitted no lifecycle events", () => {
        expect(events).toEqual([]);
      });

      When("the second relay hold is released", () => {
        holds[1].release();
      });

      Then("no relay hold is active", () => {
        expect(holds.map((hold) => hold.active)).toEqual([false, false]);
      });

      When('the app fetches "http://localhost/api/users" again', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then(
        "the fetch caller received status 200 with the mocked users",
        async () => {
          expect(fetchResponse?.status).toBe(200);
          expect(await fetchResponse?.json()).toEqual(USERS);
        },
      );

      And("the recording network received only the earlier fetch", () => {
        expect(network).toHaveBeenCalledOnce();
      });
    },
  );

  Scenario(
    "A relayed request is answered by the newest lease first",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users that intercepts fetch over a recording network',
        () => givenUsersMock(),
      );

      And(
        'a newer mock with route "GET /api/users" returning "newer" that intercepts fetch',
        () => {
          interceptNewerMock("newer");
        },
      );

      When('the relay routes "GET http://localhost/api/users"', async () => {
        await relayRoutes("GET http://localhost/api/users");
      });

      Then('the relay answered status 200 with "newer"', async () => {
        const response = answeredResponse();
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("newer");
      });

      And("the older mock emitted no lifecycle events", () => {
        expect(events).toEqual([]);
      });
    },
  );

  Scenario(
    "A relayed miss is answered with a 404 when passthrough is off",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users that intercepts fetch with passthrough off',
        () => givenUsersMock({ passthrough: false }),
      );

      When('the relay routes "GET http://localhost/api/other"', async () => {
        await relayRoutes("GET http://localhost/api/other");
      });

      Then(
        'the relay answered status 404 with code "ROUTE_NOT_FOUND"',
        async () => {
          const response = answeredResponse();
          expect(response.status).toBe(404);
          expect(await response.json()).toMatchObject({
            code: "ROUTE_NOT_FOUND",
          });
        },
      );

      And("the recording network received nothing", () => {
        expect(network).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "A relayed request rejects with the reason its signal was aborted with",
    ({ Given, When, Then }) => {
      const reason = { why: "the page navigated away" };

      Given(
        'a mock with route "GET /api/slow" that waits until released and intercepts fetch over a recording network',
        () => {
          setup();
          defineWaitingRoute();
          intercept();
        },
      );

      When(
        'the relay routes "GET http://localhost/api/slow" and the request is aborted with a custom reason while the route runs',
        async () => {
          await relayRoutesAndAborts("GET http://localhost/api/slow", reason);
        },
      );

      Then("routing rejected with that same abort reason", () => {
        expect(routingError()).toBe(reason);
      });
    },
  );

  Scenario(
    "A relayed request outside the lease's baseUrl is left unanswered",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with routes "GET /api/users" and "GET /admin/users" that intercepts fetch with baseUrl "/api"',
        () => {
          setup();
          mock("GET /api/users", USERS);
          mock("GET /admin/users", USERS);
          intercept({ baseUrl: "/api" });
        },
      );

      When('the relay routes "GET http://localhost/admin/users"', async () => {
        await relayRoutes("GET http://localhost/admin/users");
      });

      Then("the relay answered nothing", () => {
        expect(relayAnswer()).toBeUndefined();
      });

      And("the mock emitted no lifecycle events", () => {
        expect(events).toEqual([]);
      });

      When('the relay routes "GET http://localhost/api/users"', async () => {
        await relayRoutes("GET http://localhost/api/users");
      });

      Then("the relay answered status 200 with the mocked users", async () => {
        await expectAnsweredUsers();
      });
    },
  );

  Scenario(
    "A fetch dispatcher captured by a third-party wrapper obeys a relay hold",
    ({ Given, When, Then, And }) => {
      let wrapper: Mock<typeof globalThis.fetch>;
      let newerEvents: string[] = [];

      Given(
        'a mock with route "GET /api/users" returning users that intercepts fetch over a recording network',
        () => givenUsersMock(),
      );

      And(
        "a third-party wrapper captured the fetch dispatcher and replaced fetch",
        () => {
          const captured = globalThis.fetch;
          wrapper = vi
            .fn<typeof globalThis.fetch>()
            .mockImplementation((input, init) => captured(input, init));
          globalThis.fetch = wrapper;
        },
      );

      And(
        'a newer mock with route "GET /api/users" returning "newer" that intercepts fetch on top of the wrapper',
        () => {
          newerEvents = interceptNewerMock("newer");
          expect(globalThis.fetch).not.toBe(wrapper);
        },
      );

      And("a fetch relay is held", () => holdRelay());

      When('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then(
        "the recording network received the fetch with its original arguments",
        () => {
          expectNetworkGotOriginalArguments();
        },
      );

      And("the wrapper forwarded the fetch once", () => {
        expect(wrapper).toHaveBeenCalledOnce();
      });

      And("the older mock emitted no lifecycle events", () => {
        expect(events).toEqual([]);
      });

      And("the newer mock emitted no lifecycle events", () => {
        expect(newerEvents).toEqual([]);
      });
    },
  );
});
