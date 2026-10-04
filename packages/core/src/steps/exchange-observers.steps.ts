/// <reference path="../../schmock.d.ts" />

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, type Mock, vi } from "vitest";
import { SchmockError, schmock } from "../index.js";

const feature = await loadFeature("../../features/exchange-observers.feature");

const USERS = [{ id: 1, name: "Ada" }];

type Outcome = Schmock.Exchange["outcome"];
type ExchangeWith<O extends Outcome> = Extract<
  Schmock.Exchange,
  { outcome: O }
>;

interface ObservedMock {
  mock: Schmock.CallableMockInstance;
  seen: Schmock.Exchange[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function passThrough(
  context: Schmock.PluginContext,
  response?: unknown,
): Schmock.PluginResult {
  return { context, response };
}

function exchangeObserver(seen: Schmock.Exchange[]): Schmock.Plugin {
  return {
    name: "observer",
    process: passThrough,
    onExchange: (exchange) => {
      seen.push(exchange);
    },
  };
}

function throwingObserver(message: string): Schmock.Plugin {
  return {
    name: "thrower",
    process: passThrough,
    onExchange: () => {
      throw new Error(message);
    },
  };
}

function renameUser(value: unknown): void {
  if (isRecord(value)) Reflect.set(value, "name", "Mallory");
}

function renamingObserver(): Schmock.Plugin {
  return {
    name: "renamer",
    process: passThrough,
    onExchange: (exchange) => {
      renameUser(exchange.request.body);
      if (exchange.outcome === "answered") renameUser(exchange.response.body);
    },
  };
}

function hasOutcome<O extends Outcome>(
  exchange: Schmock.Exchange,
  outcome: O,
): exchange is ExchangeWith<O> {
  return exchange.outcome === outcome;
}

/** The single exchange a fetch produced; asserts there is exactly one. */
function onlyExchange(seen: readonly Schmock.Exchange[]): Schmock.Exchange {
  expect(seen).toHaveLength(1);
  return seen[0];
}

function onlyExchangeWith<O extends Outcome>(
  seen: readonly Schmock.Exchange[],
  outcome: O,
): ExchangeWith<O> {
  const exchange = onlyExchange(seen);
  expect(exchange.outcome).toBe(outcome);
  if (!hasOutcome(exchange, outcome)) {
    throw new Error(`Expected an ${outcome} exchange`);
  }
  return exchange;
}

/** Resolves once the route started, or once the fetch settled without it. */
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
  let networkFetch: Mock<typeof globalThis.fetch>;
  let mock: Schmock.CallableMockInstance;
  let seen: Schmock.Exchange[] = [];
  let namedMocks = new Map<string, ObservedMock>();
  let handles: Schmock.InterceptHandle[] = [];
  let fetchResponse: Response | undefined;
  let fetchError: unknown;
  let release = () => {};
  let routeStarted: Promise<void> = Promise.resolve();

  function setup() {
    networkFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("network"));
    globalThis.fetch = networkFetch;
    mock = schmock();
    seen = [];
    namedMocks = new Map();
    handles = [];
    fetchResponse = undefined;
    fetchError = undefined;
  }

  AfterEachScenario(() => {
    release();
    for (const handle of handles) {
      handle.restore();
    }
    handles = [];
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    performance.clearMeasures();
  });

  function givenUsersMockWithObserver() {
    setup();
    mock("GET /api/users", USERS);
    mock.pipe(exchangeObserver(seen));
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

  function addNamedMock(name: string, withUsersRoute: boolean) {
    const instance = schmock();
    if (withUsersRoute) instance("GET /api/users", USERS);
    const namedSeen: Schmock.Exchange[] = [];
    instance.pipe(exchangeObserver(namedSeen));
    namedMocks.set(name, { mock: instance, seen: namedSeen });
  }

  function namedMock(name: string): ObservedMock {
    const entry = namedMocks.get(name);
    if (!entry) throw new Error(`No mock named "${name}"`);
    return entry;
  }

  function intercept(
    target: Schmock.CallableMockInstance,
    options?: Schmock.InterceptOptions,
  ) {
    handles.push(target.intercept(options));
  }

  async function appFetches(input: string, init?: RequestInit) {
    fetchResponse = await fetch(input, init);
  }

  async function appFetchesExpectingRejection(input: string) {
    try {
      fetchResponse = await fetch(input);
    } catch (error) {
      fetchError = error;
    }
  }

  async function appFetchesAndAborts(input: string, ready: Promise<void>) {
    const controller = new AbortController();
    const pending = fetch(input, { signal: controller.signal });
    await startedOrSettled(ready, pending);
    controller.abort();
    try {
      fetchResponse = await pending;
    } catch (error) {
      fetchError = error;
    }
    release();
  }

  function postJson(body: string): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    };
  }

  function expectAbortRejection() {
    expect(fetchError).toMatchObject({ name: "AbortError" });
  }

  Scenario(
    "An observer sees the request and the response the fetch caller received",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and an exchange observer',
        () => givenUsersMockWithObserver(),
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When(
        'the app fetches "http://localhost/api/users?page=2#top" with header "x-trace" set to "abc"',
        async () => {
          await appFetches("http://localhost/api/users?page=2#top", {
            headers: { "x-trace": "abc" },
          });
        },
      );

      Then("the number of observed exchanges is 1", () => {
        expect(seen).toHaveLength(1);
      });

      And("the observed exchange was answered with status 200", () => {
        expect(onlyExchangeWith(seen, "answered").response.status).toBe(200);
      });

      And(
        'the observed request is "GET http://localhost/api/users?page=2"',
        () => {
          const { request } = onlyExchange(seen);
          expect(`${request.method} ${request.url}`).toBe(
            "GET http://localhost/api/users?page=2",
          );
        },
      );

      And('the observed request header "x-trace" is "abc"', () => {
        expect(onlyExchange(seen).request.headers["x-trace"]).toBe("abc");
      });

      And(
        'the observed response header "content-type" is "application/json"',
        () => {
          const { response } = onlyExchangeWith(seen, "answered");
          expect(response.headers["content-type"]).toBe("application/json");
        },
      );

      And("the observed response body is the mocked users", () => {
        expect(onlyExchangeWith(seen, "answered").response.body).toEqual(USERS);
      });

      And("the observed exchange ended no earlier than it started", () => {
        const exchange = onlyExchange(seen);
        expect(exchange.endTime).toBeGreaterThanOrEqual(exchange.startTime);
      });
    },
  );

  Scenario(
    "The observed response is the one beforeResponse produced",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and an exchange observer',
        () => givenUsersMockWithObserver(),
      );

      And(
        'the mock intercepts fetch with a beforeResponse hook that answers 202 with header "x-hooked" set to "yes"',
        () => {
          intercept(mock, {
            beforeResponse: (response) => ({
              ...response,
              status: 202,
              headers: { ...response.headers, "x-hooked": "yes" },
            }),
          });
        },
      );

      When('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then("the observed exchange was answered with status 202", () => {
        expect(onlyExchangeWith(seen, "answered").response.status).toBe(202);
      });

      And('the observed response header "x-hooked" is "yes"', () => {
        const { response } = onlyExchangeWith(seen, "answered");
        expect(response.headers["x-hooked"]).toBe("yes");
      });

      And("the fetch caller received status 202", () => {
        expect(fetchResponse?.status).toBe(202);
      });
    },
  );

  Scenario(
    "The observed response is the one errorFormatter produced",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock whose route "GET /api/fail" throws "boom" and an exchange observer',
        () => {
          setup();
          mock("GET /api/fail", () => {
            throw new Error("boom");
          });
          mock.pipe(exchangeObserver(seen));
        },
      );

      And(
        "the mock intercepts fetch with an errorFormatter that returns:",
        (_, docString: string) => {
          const formatted: unknown = JSON.parse(docString);
          intercept(mock, { errorFormatter: () => formatted });
        },
      );

      When('the app fetches "http://localhost/api/fail"', async () => {
        await appFetches("http://localhost/api/fail");
      });

      Then("the observed exchange was answered with status 500", () => {
        expect(onlyExchangeWith(seen, "answered").response.status).toBe(500);
      });

      And("the observed response body is:", (_, docString: string) => {
        const expected: unknown = JSON.parse(docString);
        expect(onlyExchangeWith(seen, "answered").response.body).toEqual(
          expected,
        );
      });
    },
  );

  Scenario(
    "An unrouted request answered with 404 is observed",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and an exchange observer',
        () => givenUsersMockWithObserver(),
      );

      And("the mock intercepts fetch with passthrough disabled", () => {
        intercept(mock, { passthrough: false });
      });

      When('the app fetches "http://localhost/api/missing"', async () => {
        await appFetches("http://localhost/api/missing");
      });

      Then("the number of observed exchanges is 1", () => {
        expect(seen).toHaveLength(1);
      });

      And("the observed exchange was answered with status 404", () => {
        expect(onlyExchangeWith(seen, "answered").response.status).toBe(404);
      });

      And('the observed response body has code "ROUTE_NOT_FOUND"', () => {
        expect(onlyExchangeWith(seen, "answered").response.body).toMatchObject({
          code: "ROUTE_NOT_FOUND",
        });
      });
    },
  );

  Scenario(
    "A malformed JSON body answered with 400 is observed with its raw text",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "POST /api/users" echoing the body and an exchange observer',
        () => {
          setup();
          mock("POST /api/users", ({ body }) => body);
          mock.pipe(exchangeObserver(seen));
        },
      );

      And("the mock intercepts fetch with passthrough disabled", () => {
        intercept(mock, { passthrough: false });
      });

      When(
        'the app posts the JSON text "{oops" to "http://localhost/api/users"',
        async () => {
          await appFetches("http://localhost/api/users", postJson("{oops"));
        },
      );

      Then("the observed exchange was answered with status 400", () => {
        expect(onlyExchangeWith(seen, "answered").response.status).toBe(400);
      });

      And('the observed request body is the text "{oops"', () => {
        expect(onlyExchange(seen).request.body).toBe("{oops");
      });

      And('the observed response body has code "MALFORMED_JSON"', () => {
        expect(onlyExchangeWith(seen, "answered").response.body).toMatchObject({
          code: "MALFORMED_JSON",
        });
      });
    },
  );

  Scenario(
    "A request passed on to the network is not observed",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and an exchange observer',
        () => givenUsersMockWithObserver(),
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When('the app fetches "http://localhost/api/other"', async () => {
        await appFetches("http://localhost/api/other");
      });

      Then("the network answered the fetch", async () => {
        expect(networkFetch).toHaveBeenCalledTimes(1);
        expect(await fetchResponse?.text()).toBe("network");
      });

      And("the number of observed exchanges is 0", () => {
        expect(seen).toHaveLength(0);
      });
    },
  );

  Scenario(
    "Only the mock that answered observes the exchange",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock "answering" with route "GET /api/users" returning users and an exchange observer',
        () => {
          setup();
          addNamedMock("answering", true);
        },
      );

      And('a mock "missing" with no routes and an exchange observer', () => {
        addNamedMock("missing", false);
      });

      And('mock "answering" intercepts fetch', () => {
        intercept(namedMock("answering").mock);
      });

      And('mock "missing" intercepts fetch', () => {
        intercept(namedMock("missing").mock);
      });

      When('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then('the number of exchanges mock "answering" observed is 1', () => {
        expect(namedMock("answering").seen).toHaveLength(1);
      });

      And('the number of exchanges mock "missing" observed is 0', () => {
        expect(namedMock("missing").seen).toHaveLength(0);
      });
    },
  );

  Scenario(
    "Nested leases of one mock produce one observation",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and an exchange observer',
        () => givenUsersMockWithObserver(),
      );

      And("the mock intercepts fetch twice", () => {
        intercept(mock);
        intercept(mock);
      });

      When('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then("the number of observed exchanges is 1", () => {
        expect(seen).toHaveLength(1);
      });
    },
  );

  Scenario(
    "A rejected fetch is observed as failed with the same error",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and an exchange observer',
        () => givenUsersMockWithObserver(),
      );

      And(
        'the mock intercepts fetch with a beforeResponse hook that throws "hook failed"',
        () => {
          intercept(mock, {
            beforeResponse: () => {
              throw new Error("hook failed");
            },
          });
        },
      );

      When(
        'the app fetches "http://localhost/api/users" expecting a rejection',
        async () => {
          await appFetchesExpectingRejection("http://localhost/api/users");
        },
      );

      Then('the fetch rejected with the message "hook failed"', () => {
        expect(fetchError).toBeInstanceOf(Error);
        expect(fetchError).toMatchObject({ message: "hook failed" });
      });

      And(
        "the observed exchange failed with the error the fetch rejected with",
        () => {
          expect(onlyExchangeWith(seen, "failed").error).toBe(fetchError);
        },
      );
    },
  );

  Scenario(
    "A hook error is observed as failed even when the caller aborts right after it",
    ({ Given, When, Then, And }) => {
      const controller = new AbortController();
      let abortedWhenObserved: boolean | undefined;

      Given(
        'a mock with route "GET /api/users" returning users and an exchange observer',
        () => givenUsersMockWithObserver(),
      );

      And(
        'the mock intercepts fetch with a beforeResponse hook that throws "hook failed" and aborts the fetch one microtask later',
        () => {
          mock.pipe({
            name: "abort-probe",
            process: (context, response) => ({ context, response }),
            onExchange: () => {
              abortedWhenObserved = controller.signal.aborted;
            },
          });
          intercept(mock, {
            beforeResponse: () => {
              // Lands after the lease rejected but before routing resumes.
              void Promise.resolve()
                .then(() => {})
                .then(() => controller.abort());
              throw new Error("hook failed");
            },
          });
        },
      );

      When(
        'the app fetches "http://localhost/api/users" with that abort signal expecting a rejection',
        async () => {
          try {
            await globalThis.fetch("http://localhost/api/users", {
              signal: controller.signal,
            });
          } catch (error) {
            fetchError = error;
          }
        },
      );

      Then('the fetch rejected with the message "hook failed"', () => {
        expect(fetchError).toBeInstanceOf(Error);
        expect(fetchError).toMatchObject({ message: "hook failed" });
      });

      And(
        "the observed exchange failed with the error the fetch rejected with",
        () => {
          // The abort must land before observation, or this proves nothing.
          expect(abortedWhenObserved).toBe(true);
          expect(onlyExchangeWith(seen, "failed").error).toBe(fetchError);
        },
      );
    },
  );

  Scenario(
    "Aborting a request the mock is answering is observed as aborted",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/slow" that waits until released and an exchange observer',
        () => {
          setup();
          defineWaitingRoute();
          mock.pipe(exchangeObserver(seen));
        },
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When(
        'the app fetches "http://localhost/api/slow" and aborts it while the route runs',
        async () => {
          await appFetchesAndAborts("http://localhost/api/slow", routeStarted);
        },
      );

      Then("the fetch rejected with an AbortError", () => {
        expectAbortRejection();
      });

      And("the observed exchange was aborted", () => {
        onlyExchangeWith(seen, "aborted");
      });
    },
  );

  Scenario(
    "An abort while another mock is still deciding is not observed",
    ({ Given, When, Then, And }) => {
      let hookStarted: Promise<void> = Promise.resolve();

      Given(
        'a mock "answering" with route "GET /api/users" returning users and an exchange observer',
        () => {
          setup();
          addNamedMock("answering", true);
        },
      );

      And('a mock "deciding" with no routes and an exchange observer', () => {
        addNamedMock("deciding", false);
      });

      And('mock "answering" intercepts fetch', () => {
        intercept(namedMock("answering").mock);
      });

      And(
        'mock "deciding" intercepts fetch with a beforeRequest hook that never settles',
        () => {
          let announceHookStart = () => {};
          hookStarted = new Promise<void>((resolve) => {
            announceHookStart = resolve;
          });
          intercept(namedMock("deciding").mock, {
            beforeRequest: async () => {
              announceHookStart();
              await new Promise<void>(() => {});
            },
          });
        },
      );

      When(
        'the app fetches "http://localhost/api/users" and aborts it while the hook is pending',
        async () => {
          await appFetchesAndAborts("http://localhost/api/users", hookStarted);
        },
      );

      Then("the fetch rejected with an AbortError", () => {
        expectAbortRejection();
      });

      And('the number of exchanges mock "answering" observed is 0', () => {
        expect(namedMock("answering").seen).toHaveLength(0);
      });

      And('the number of exchanges mock "deciding" observed is 0', () => {
        expect(namedMock("deciding").seen).toHaveLength(0);
      });
    },
  );

  Scenario(
    "A throwing observer changes neither the response nor other observers",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users, an observer that throws "observer failed" and an exchange observer',
        () => {
          setup();
          mock("GET /api/users", USERS);
          mock.pipe(throwingObserver("observer failed"));
          mock.pipe(exchangeObserver(seen));
        },
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then("the fetch caller received status 200", () => {
        expect(fetchResponse?.status).toBe(200);
      });

      And("the number of observed exchanges is 1", () => {
        expect(seen).toHaveLength(1);
      });
    },
  );

  Scenario(
    "Each observer receives its own frozen copy of the exchange",
    ({ Given, When, Then, And }) => {
      let storedUser: unknown;

      Given(
        'a mock whose route "POST /api/users" stores the posted user, an observer that renames the observed user to "Mallory" and an exchange observer',
        () => {
          setup();
          storedUser = undefined;
          mock("POST /api/users", ({ body }) => {
            storedUser = body;
            return body;
          });
          mock.pipe(renamingObserver());
          mock.pipe(exchangeObserver(seen));
        },
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When(
        'the app posts the JSON user "Ada" to "http://localhost/api/users"',
        async () => {
          await appFetches(
            "http://localhost/api/users",
            postJson(JSON.stringify({ name: "Ada" })),
          );
        },
      );

      Then('the stored user is still named "Ada"', () => {
        expect(storedUser).toMatchObject({ name: "Ada" });
      });

      And('the exchange observer saw the user named "Ada"', () => {
        const exchange = onlyExchangeWith(seen, "answered");
        expect(exchange.request.body).toMatchObject({ name: "Ada" });
        expect(exchange.response.body).toMatchObject({ name: "Ada" });
      });

      And(
        "the observed exchange, its request headers and its response headers are frozen",
        () => {
          const exchange = onlyExchangeWith(seen, "answered");
          for (const part of [
            exchange,
            exchange.request,
            exchange.request.headers,
            exchange.response,
            exchange.response.headers,
          ]) {
            expect(Object.isFrozen(part)).toBe(true);
          }
        },
      );
    },
  );

  Scenario(
    "Requests handled directly through mock.handle are not observed",
    ({ Given, When, Then }) => {
      Given(
        'a mock with route "GET /api/users" returning users and an exchange observer',
        () => givenUsersMockWithObserver(),
      );

      When('the test calls handle for "GET /api/users"', async () => {
        await mock.handle("GET", "/api/users");
      });

      Then("the number of observed exchanges is 0", () => {
        expect(seen).toHaveLength(0);
      });
    },
  );

  Scenario(
    "Observation stops after reset while the interception lease remains",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and an exchange observer',
        () => givenUsersMockWithObserver(),
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When("the mock is reset and its route is defined again", () => {
        mock.reset();
        mock("GET /api/users", USERS);
      });

      And('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then("the fetch caller received status 200", () => {
        expect(fetchResponse?.status).toBe(200);
      });

      And("the number of observed exchanges is 0", () => {
        expect(seen).toHaveLength(0);
      });
    },
  );

  Scenario(
    "An exchange in flight across a reset is not observed",
    ({ Given, When, Then, And }) => {
      let freshSeen: Schmock.Exchange[] = [];

      Given(
        'a mock with route "GET /api/slow" that waits until released and an exchange observer',
        () => {
          setup();
          defineWaitingRoute();
          mock.pipe(exchangeObserver(seen));
        },
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When(
        'the app fetches "http://localhost/api/slow" and the mock is reset and given a fresh exchange observer before the route is released',
        async () => {
          freshSeen = [];
          const pending = fetch("http://localhost/api/slow");
          await startedOrSettled(routeStarted, pending);
          mock.reset();
          mock("GET /api/slow", USERS);
          mock.pipe(exchangeObserver(freshSeen));
          release();
          fetchResponse = await pending;
        },
      );

      Then("the in-flight fetch still answered status 200", () => {
        expect(fetchResponse?.status).toBe(200);
      });

      And("neither observer saw an exchange", () => {
        expect(seen).toHaveLength(0);
        expect(freshSeen).toHaveLength(0);
      });
    },
  );

  Scenario(
    "An observer piped after a request arrived does not see it",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/slow" that waits until released',
        () => {
          setup();
          defineWaitingRoute();
        },
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When(
        'the app fetches "http://localhost/api/slow" and an exchange observer is piped before the route is released',
        async () => {
          const pending = fetch("http://localhost/api/slow");
          await startedOrSettled(routeStarted, pending);
          mock.pipe(exchangeObserver(seen));
          release();
          fetchResponse = await pending;
        },
      );

      Then("the fetch caller received status 200", () => {
        expect(fetchResponse?.status).toBe(200);
      });

      And("the number of observed exchanges is 0", () => {
        expect(seen).toHaveLength(0);
      });
    },
  );

  Scenario(
    "The observed exchange spans the route's delay",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/slow" delayed by 50 ms and an exchange observer',
        () => {
          setup();
          mock("GET /api/slow", USERS, { delay: 50 });
          mock.pipe(exchangeObserver(seen));
        },
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When('the app fetches "http://localhost/api/slow"', async () => {
        await appFetches("http://localhost/api/slow");
      });

      Then("the observed exchange lasted at least 40 ms", () => {
        const exchange = onlyExchange(seen);
        expect(exchange.endTime - exchange.startTime).toBeGreaterThanOrEqual(
          40,
        );
      });
    },
  );

  Scenario(
    "pipe rejects an onExchange that is not a function",
    ({ When, Then }) => {
      let pipeError: unknown;

      When(
        'a plugin with a process function and an onExchange set to the string "yes" is piped',
        () => {
          setup();
          pipeError = undefined;
          const plugin: unknown = {
            name: "bad",
            process: passThrough,
            onExchange: "yes",
          };
          try {
            Reflect.apply(mock.pipe, mock, [plugin]);
          } catch (error) {
            pipeError = error;
          }
        },
      );

      Then(
        'pipe throws a SchmockError with code "PLUGIN_INVALID" and reason "onExchange must be a function when set"',
        () => {
          expect(pipeError).toBeInstanceOf(SchmockError);
          expect(pipeError).toMatchObject({
            code: "PLUGIN_INVALID",
            context: { reason: "onExchange must be a function when set" },
          });
        },
      );
    },
  );
});
