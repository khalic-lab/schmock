/// <reference path="../../../core/schmock.d.ts" />

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { SchmockError, schmock } from "@schmock/core";
import { expect, type Mock, vi } from "vitest";
import { type DevtoolsPluginOptions, devtoolsPlugin } from "../index.js";

const feature = await loadFeature("../../features/devtools-reporter.feature");

const USERS = [{ id: 1, name: "Ada" }];

interface TrackEntry {
  name: string;
  startTime: number;
  duration: number;
  devtools: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDevtoolsOptions(value: unknown): value is DevtoolsPluginOptions {
  if (!isRecord(value)) return false;
  const flagsOk = [value.console, value.performance].every(
    (flag) => flag === undefined || typeof flag === "boolean",
  );
  const namesOk = [value.track, value.trackGroup].every(
    (name) => name === undefined || typeof name === "string",
  );
  return flagsOk && namesOk;
}

function parseOptions(docString: string): DevtoolsPluginOptions {
  const parsed: unknown = JSON.parse(docString);
  if (!isDevtoolsOptions(parsed)) {
    throw new Error(`Not a devtools options object: ${docString}`);
  }
  return parsed;
}

function exchangeObserver(seen: Schmock.Exchange[]): Schmock.Plugin {
  return {
    name: "observer",
    process: (context, response) => ({ context, response }),
    onExchange: (exchange) => {
      seen.push(exchange);
    },
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Render console format args as a console shows them: `%c` takes an argument
 * and prints nothing, `%s` prints `String(arg)`, leftover arguments follow
 * after a space. Only the format string is scanned, never substituted text.
 */
function renderConsole(args: readonly unknown[]): string {
  const [format, ...rest] = args;
  if (typeof format !== "string") return args.map(String).join(" ");
  const text = format.replace(/%[cs]/g, (directive) => {
    if (rest.length === 0) return directive;
    const arg = rest.shift();
    return directive === "%c" ? "" : String(arg);
  });
  return [text, ...rest.map(String)].join(" ");
}

/** The Performance-panel track entries recorded so far, as real Node measures. */
function trackEntries(): TrackEntry[] {
  return performance.getEntriesByType("measure").flatMap((entry) => {
    const detail: unknown = Reflect.get(entry, "detail");
    const devtools = isRecord(detail) ? detail.devtools : undefined;
    if (!isRecord(devtools) || devtools.dataType !== "track-entry") return [];
    const { name, startTime, duration } = entry;
    return [{ name, startTime, duration, devtools }];
  });
}

function onlyTrackEntry(): TrackEntry {
  const entries = trackEntries();
  expect(entries).toHaveLength(1);
  return entries[0];
}

function spyOnConsole() {
  return {
    groupCollapsed: vi
      .spyOn(console, "groupCollapsed")
      .mockImplementation(() => {}),
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    groupEnd: vi.spyOn(console, "groupEnd").mockImplementation(() => {}),
  };
}

type ConsoleSpies = ReturnType<typeof spyOnConsole>;

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
  let spies: ConsoleSpies;
  let mock: Schmock.CallableMockInstance;
  let namedMocks = new Map<string, Schmock.CallableMockInstance>();
  let seen: Schmock.Exchange[] = [];
  let handles: Schmock.InterceptHandle[] = [];
  let fetchResponse: Response | undefined;
  let release = () => {};
  let routeStarted: Promise<void> = Promise.resolve();

  // Leaves stubbed globals alone: "the page is served from" runs before it.
  function setup() {
    networkFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("network"));
    globalThis.fetch = networkFetch;
    spies = spyOnConsole();
    mock = schmock();
    namedMocks = new Map();
    seen = [];
    handles = [];
    fetchResponse = undefined;
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

  function givenUsersMock(options?: DevtoolsPluginOptions) {
    setup();
    mock("GET /api/users", USERS);
    mock.pipe(devtoolsPlugin(options));
  }

  function givenWaitingMock() {
    setup();
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
    mock.pipe(devtoolsPlugin());
  }

  function addNamedMock(name: string, withUsersRoute: boolean) {
    const instance = schmock();
    if (withUsersRoute) instance("GET /api/users", USERS);
    namedMocks.set(name, instance);
    instance.pipe(devtoolsPlugin());
  }

  function namedMock(name: string): Schmock.CallableMockInstance {
    const instance = namedMocks.get(name);
    if (!instance) throw new Error(`No mock named "${name}"`);
    return instance;
  }

  function intercept(
    target: Schmock.CallableMockInstance,
    options?: Schmock.InterceptOptions,
  ) {
    handles.push(target.intercept(options));
  }

  async function appFetches(input: string) {
    fetchResponse = await fetch(input);
  }

  // These scenarios read the report, not the rejection itself.
  async function appFetchesExpectingRejection(input: string) {
    fetchResponse = await fetch(input).catch(() => undefined);
  }

  function onlyExchange(): Schmock.Exchange {
    expect(seen).toHaveLength(1);
    return seen[0];
  }

  function expectOneClosedGroup() {
    expect(spies.groupCollapsed).toHaveBeenCalledTimes(1);
    expect(spies.groupEnd).toHaveBeenCalledTimes(1);
    expect(spies.groupEnd.mock.invocationCallOrder[0]).toBeGreaterThan(
      spies.groupCollapsed.mock.invocationCallOrder[0],
    );
  }

  /** The group title as the console renders it, then a "(1.4 ms)" duration. */
  function expectGroupTitle(text: string) {
    expect(spies.groupCollapsed).toHaveBeenCalledTimes(1);
    const args: readonly unknown[] = spies.groupCollapsed.mock.calls[0];
    expect(typeof args[0]).toBe("string");
    expect(renderConsole(args)).toMatch(
      new RegExp(`^${escapeRegExp(text)} \\(\\d+\\.\\d ms\\)$`),
    );
  }

  /** The arguments of the first matching call, asserted to sit inside the one group. */
  function callInsideGroup(
    spy: ConsoleSpies["log"] | ConsoleSpies["error"],
    matches: (args: readonly unknown[]) => boolean,
  ): readonly unknown[] {
    expectOneClosedGroup();
    const index = spy.mock.calls.findIndex(matches);
    expect(index).toBeGreaterThanOrEqual(0);
    const order = spy.mock.invocationCallOrder[index];
    expect(order).toBeGreaterThan(
      spies.groupCollapsed.mock.invocationCallOrder[0],
    );
    expect(order).toBeLessThan(spies.groupEnd.mock.invocationCallOrder[0]);
    return spy.mock.calls[index];
  }

  function expectGroupLogsRequest(method: string, url: string) {
    const [, request] = callInsideGroup(
      spies.log,
      ([label]) => label === "Request",
    );
    expect(request).toMatchObject({ method, url });
  }

  function expectTrackEntry(track: string, color: string) {
    expect(onlyTrackEntry().devtools).toMatchObject({
      dataType: "track-entry",
      track,
      color,
    });
  }

  function expectMeasuresNamed(name: string) {
    expect(trackEntries().map((entry) => entry.name)).toEqual([name]);
  }

  Scenario(
    "A mocked fetch is logged as one collapsed console group",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and the devtools plugin',
        () => givenUsersMock(),
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then("exactly 1 collapsed console group was opened and closed", () => {
        expectOneClosedGroup();
      });

      And(
        'the group title reads "Schmock GET http://localhost/api/users → 200" followed by the duration',
        () => {
          expectGroupTitle("Schmock GET http://localhost/api/users → 200");
        },
      );

      And('the group logs the request "GET http://localhost/api/users"', () => {
        expectGroupLogsRequest("GET", "http://localhost/api/users");
      });

      And(
        "the group logs the response status 200 with the mocked users",
        () => {
          const [, response] = callInsideGroup(
            spies.log,
            ([label]) => label === "Response",
          );
          expect(response).toMatchObject({ status: 200, body: USERS });
        },
      );
    },
  );

  Scenario(
    "A same-origin request is labelled by its path and query",
    ({ Given, When, Then, And }) => {
      Given('the page is served from "http://localhost"', () => {
        vi.stubGlobal("location", new URL("http://localhost/"));
      });

      And(
        'a mock with route "GET /api/users" returning users and the devtools plugin',
        () => givenUsersMock(),
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When('the app fetches "/api/users?page=2"', async () => {
        await appFetches("/api/users?page=2");
      });

      Then(
        'the group title reads "Schmock GET /api/users?page=2 → 200" followed by the duration',
        () => {
          expectGroupTitle("Schmock GET /api/users?page=2 → 200");
        },
      );

      And(
        'exactly 1 performance measure named "GET /api/users?page=2" was recorded',
        () => {
          expectMeasuresNamed("GET /api/users?page=2");
        },
      );
    },
  );

  Scenario(
    "A mocked fetch adds an entry to the Schmock performance track",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and the devtools plugin',
        () => givenUsersMock(),
      );

      And("an exchange observer piped into the mock", () => {
        mock.pipe(exchangeObserver(seen));
      });

      And("the mock intercepts fetch", () => intercept(mock));

      When('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then(
        'exactly 1 performance measure named "GET http://localhost/api/users" was recorded',
        () => {
          expectMeasuresNamed("GET http://localhost/api/users");
        },
      );

      And(
        'the measure is a track entry on track "Schmock" colored "primary"',
        () => {
          expectTrackEntry("Schmock", "primary");
        },
      );

      And('the measure lists the property "Outcome" as "200"', () => {
        expect(onlyTrackEntry().devtools.properties).toContainEqual([
          "Outcome",
          "200",
        ]);
      });

      And("the measure spans the observed exchange", () => {
        const entry = onlyTrackEntry();
        const exchange = onlyExchange();
        expect(entry.startTime).toBeCloseTo(exchange.startTime, 3);
        expect(entry.duration).toBeCloseTo(
          exchange.endTime - exchange.startTime,
          3,
        );
      });
    },
  );

  Scenario(
    "A client error is colored as a warning",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and the devtools plugin',
        () => givenUsersMock(),
      );

      And("the mock intercepts fetch with passthrough disabled", () => {
        intercept(mock, { passthrough: false });
      });

      When('the app fetches "http://localhost/api/missing"', async () => {
        await appFetches("http://localhost/api/missing");
      });

      Then(
        'the group title reads "Schmock GET http://localhost/api/missing → 404" followed by the duration',
        () => {
          expectGroupTitle("Schmock GET http://localhost/api/missing → 404");
        },
      );

      And(
        'the measure is a track entry on track "Schmock" colored "tertiary"',
        () => {
          expectTrackEntry("Schmock", "tertiary");
        },
      );
    },
  );

  Scenario(
    "A server error is colored as an error",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/fail" answering status 503 and the devtools plugin',
        () => {
          setup();
          mock("GET /api/fail", [503, { error: "Service unavailable" }]);
          mock.pipe(devtoolsPlugin());
        },
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When('the app fetches "http://localhost/api/fail"', async () => {
        await appFetches("http://localhost/api/fail");
      });

      Then(
        'the group title reads "Schmock GET http://localhost/api/fail → 503" followed by the duration',
        () => {
          expectGroupTitle("Schmock GET http://localhost/api/fail → 503");
        },
      );

      And(
        'the measure is a track entry on track "Schmock" colored "error"',
        () => {
          expectTrackEntry("Schmock", "error");
        },
      );
    },
  );

  Scenario(
    "A failed fetch logs its error inside the group",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and the devtools plugin',
        () => givenUsersMock(),
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

      Then(
        'the group title reads "Schmock GET http://localhost/api/users → failed: hook failed" followed by the duration',
        () => {
          expectGroupTitle(
            "Schmock GET http://localhost/api/users → failed: hook failed",
          );
        },
      );

      And('the group logs the error "hook failed"', () => {
        const [error] = callInsideGroup(spies.error, () => true);
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ message: "hook failed" });
      });

      And(
        'the measure is a track entry on track "Schmock" colored "error"',
        () => {
          expectTrackEntry("Schmock", "error");
        },
      );
    },
  );

  Scenario(
    "An aborted fetch is labelled aborted",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/slow" that waits until released and the devtools plugin',
        () => givenWaitingMock(),
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When(
        'the app fetches "http://localhost/api/slow" and aborts it while the route runs',
        async () => {
          const controller = new AbortController();
          const pending = fetch("http://localhost/api/slow", {
            signal: controller.signal,
          });
          await startedOrSettled(routeStarted, pending);
          controller.abort();
          fetchResponse = await pending.catch(() => undefined);
          release();
        },
      );

      Then(
        'the group title reads "Schmock GET http://localhost/api/slow → aborted" followed by the duration',
        () => {
          expectGroupTitle("Schmock GET http://localhost/api/slow → aborted");
        },
      );

      And(
        'the measure is a track entry on track "Schmock" colored "secondary"',
        () => {
          expectTrackEntry("Schmock", "secondary");
        },
      );
    },
  );

  Scenario(
    "A request passed on to the network is not reported",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and the devtools plugin',
        () => givenUsersMock(),
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When('the app fetches "http://localhost/api/other"', async () => {
        await appFetches("http://localhost/api/other");
      });

      Then("no console group was opened", () => {
        expect(spies.groupCollapsed).not.toHaveBeenCalled();
      });

      And("no performance measure was recorded", () => {
        expect(trackEntries()).toHaveLength(0);
      });
    },
  );

  Scenario(
    "One fetch is reported once even when another mock misses it first",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock "answering" with route "GET /api/users" returning users and the devtools plugin',
        () => {
          setup();
          addNamedMock("answering", true);
        },
      );

      And('a mock "missing" with no routes and the devtools plugin', () => {
        addNamedMock("missing", false);
      });

      And('mock "answering" intercepts fetch', () => {
        intercept(namedMock("answering"));
      });

      And('mock "missing" intercepts fetch', () => {
        intercept(namedMock("missing"));
      });

      When('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then("exactly 1 collapsed console group was opened and closed", () => {
        expectOneClosedGroup();
      });

      And(
        'exactly 1 performance measure named "GET http://localhost/api/users" was recorded',
        () => {
          expectMeasuresNamed("GET http://localhost/api/users");
        },
      );
    },
  );

  Scenario(
    "The track name and group label both outputs",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and the devtools plugin configured with:',
        (_, docString: string) => givenUsersMock(parseOptions(docString)),
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then(
        'the group title reads "Users API GET http://localhost/api/users → 200" followed by the duration',
        () => {
          expectGroupTitle("Users API GET http://localhost/api/users → 200");
        },
      );

      And(
        'the measure is a track entry on track "Users API" colored "primary"',
        () => {
          expectTrackEntry("Users API", "primary");
        },
      );

      And('the measure belongs to the track group "My app"', () => {
        expect(onlyTrackEntry().devtools.trackGroup).toBe("My app");
      });
    },
  );

  Scenario(
    "Console reporting can be turned off",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and the devtools plugin configured with:',
        (_, docString: string) => givenUsersMock(parseOptions(docString)),
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then("no console group was opened", () => {
        expect(spies.groupCollapsed).not.toHaveBeenCalled();
      });

      And(
        'exactly 1 performance measure named "GET http://localhost/api/users" was recorded',
        () => {
          expectMeasuresNamed("GET http://localhost/api/users");
        },
      );
    },
  );

  Scenario(
    "Performance reporting can be turned off",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and the devtools plugin configured with:',
        (_, docString: string) => givenUsersMock(parseOptions(docString)),
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then("exactly 1 collapsed console group was opened and closed", () => {
        expectOneClosedGroup();
      });

      And("no performance measure was recorded", () => {
        expect(trackEntries()).toHaveLength(0);
      });
    },
  );

  Scenario(
    "A failing performance API does not stop console reporting",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and the devtools plugin',
        () => givenUsersMock(),
      );

      And("performance.measure throws", () => {
        vi.spyOn(performance, "measure").mockImplementation(() => {
          throw new Error("unsupported");
        });
      });

      And("the mock intercepts fetch", () => intercept(mock));

      When('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then("exactly 1 collapsed console group was opened and closed", () => {
        expectOneClosedGroup();
      });

      And("the fetch caller received status 200", () => {
        expect(fetchResponse?.status).toBe(200);
      });
    },
  );

  Scenario(
    "The plugin leaves mocked responses unchanged",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with route "GET /api/users" returning users and the devtools plugin',
        () => givenUsersMock(),
      );

      And("the mock intercepts fetch", () => intercept(mock));

      When('the app fetches "http://localhost/api/users"', async () => {
        await appFetches("http://localhost/api/users");
      });

      Then(
        "the fetch caller received status 200 with the mocked users",
        async () => {
          expect(fetchResponse?.status).toBe(200);
          expect(await fetchResponse?.json()).toEqual(USERS);
        },
      );
    },
  );

  Scenario(
    "Invalid options are rejected when the plugin is created",
    ({ When, Then }) => {
      let createError: unknown;

      When("the devtools plugin is created with:", (_, docString: string) => {
        createError = undefined;
        const options = parseOptions(docString);
        try {
          devtoolsPlugin(options);
        } catch (error) {
          createError = error;
        }
      });

      Then(
        'creating the plugin throws a SchmockError with code "DEVTOOLS_CONFIG_INVALID"',
        () => {
          expect(createError).toBeInstanceOf(SchmockError);
          expect(createError).toMatchObject({
            code: "DEVTOOLS_CONFIG_INVALID",
          });
        },
      );
    },
  );
});
