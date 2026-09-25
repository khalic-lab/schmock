import { Server } from "node:http";
import { connect } from "node:net";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, expectTypeOf, vi } from "vitest";
import {
  badRequest,
  created,
  isStatusTuple,
  noContent,
  notFound,
  paginate,
  SchmockError,
  schmock,
} from "../index";

const feature = await loadFeature("../../features/review-core-builder.feature");

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeChunked(payload: string): string {
  let decoded = "";
  let rest = payload;
  while (rest.length > 0) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd === -1) break;
    const size = Number.parseInt(rest.slice(0, lineEnd), 16);
    if (!Number.isFinite(size) || size === 0) break;
    decoded += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
  return decoded;
}

function parseRawResponse(raw: string): RawResponse {
  const headEnd = raw.indexOf("\r\n\r\n");
  const head = headEnd === -1 ? raw : raw.slice(0, headEnd);
  const payload = headEnd === -1 ? "" : raw.slice(headEnd + 4);
  const [statusLine = "", ...headerLines] = head.split("\r\n");
  const status = Number(statusLine.split(" ")[1]);
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line
      .slice(separator + 1)
      .trim();
  }
  const body =
    headers["transfer-encoding"] === "chunked"
      ? decodeChunked(payload)
      : payload;
  return { status, headers, body };
}

/**
 * Send raw request bytes. Node's own client normalises or rejects the targets
 * these scenarios need (`//users`, a missing Host, a broken authority), so the
 * request is written to the socket verbatim.
 */
function sendRaw(
  info: Schmock.ServerInfo,
  requestText: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(info.port, info.hostname);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      resolve(parseRawResponse(Buffer.concat(chunks).toString("utf8")));
    });
    socket.write(requestText);
  });
}

function http11(requestLine: string): string {
  return `${requestLine} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`;
}

function bodyCode(response: RawResponse): unknown {
  const parsed: unknown = JSON.parse(response.body);
  return isRecord(parsed) ? parsed.code : undefined;
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance | undefined;
  let serverInfo: Schmock.ServerInfo;
  let rawResponses: RawResponse[] = [];

  AfterEachScenario(() => {
    mock?.close();
    mock = undefined;
    rawResponses = [];
    vi.restoreAllMocks();
  });

  function currentMock(): Schmock.CallableMockInstance {
    if (!mock) throw new Error("scenario did not create a mock");
    return mock;
  }

  async function listeningMock(): Promise<void> {
    const instance = schmock();
    instance("GET /", { root: true });
    instance("GET /bar", { bar: true });
    instance("GET /users", { users: true });
    mock = instance;
    serverInfo = await instance.listen(0);
  }

  // ── Standalone server ingress ──────────────────────────────────────────

  Scenario(
    "A double-slash request target is not read as a protocol-relative URL",
    ({ Given, When, And, Then }) => {
      Given(
        'a listening mock with routes "GET /", "GET /bar" and "GET /users"',
        listeningMock,
      );

      When('a raw client sends "GET //users"', async () => {
        rawResponses.push(await sendRaw(serverInfo, http11("GET //users")));
      });

      And('a raw client sends "GET //foo/bar"', async () => {
        rawResponses.push(await sendRaw(serverInfo, http11("GET //foo/bar")));
      });

      Then("both raw responses have status 404", () => {
        expect(rawResponses.map((response) => response.status)).toEqual([
          404, 404,
        ]);
      });

      And("the mock history is empty", () => {
        expect(currentMock().history()).toEqual([]);
      });
    },
  );

  Scenario(
    "The standalone server answers an unsupported method with 405",
    ({ Given, When, Then, And }) => {
      Given(
        'a listening mock with routes "GET /", "GET /bar" and "GET /users"',
        listeningMock,
      );

      When('a raw client sends "PROPFIND /users"', async () => {
        rawResponses.push(await sendRaw(serverInfo, http11("PROPFIND /users")));
      });

      Then(
        'the raw response status is 405 with code "METHOD_NOT_ALLOWED"',
        () => {
          expect(rawResponses[0]?.status).toBe(405);
          expect(bodyCode(rawResponses[0])).toBe("METHOD_NOT_ALLOWED");
        },
      );

      And(
        'the raw response Allow header lists "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS"',
        () => {
          expect(rawResponses[0]?.headers.allow).toBe(
            "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
          );
        },
      );
    },
  );

  Scenario(
    "The standalone server answers a request without a Host header with 400",
    ({ Given, When, Then }) => {
      Given(
        'a listening mock with routes "GET /", "GET /bar" and "GET /users"',
        listeningMock,
      );

      When(
        'a raw HTTP/1.0 client sends "GET /users" without a Host header',
        async () => {
          rawResponses.push(
            await sendRaw(serverInfo, "GET /users HTTP/1.0\r\n\r\n"),
          );
        },
      );

      Then('the raw response status is 400 with code "BAD_REQUEST"', () => {
        expect(rawResponses[0]?.status).toBe(400);
        expect(bodyCode(rawResponses[0])).toBe("BAD_REQUEST");
      });
    },
  );

  Scenario(
    "The standalone server answers a malformed absolute request target with 400",
    ({ Given, When, Then }) => {
      Given(
        'a listening mock with routes "GET /", "GET /bar" and "GET /users"',
        listeningMock,
      );

      When(
        "a raw client sends a GET whose absolute target has an unclosed IPv6 bracket",
        async () => {
          rawResponses.push(
            await sendRaw(serverInfo, http11("GET http://[::1/users")),
          );
        },
      );

      Then('the raw response status is 400 with code "BAD_REQUEST"', () => {
        expect(rawResponses[0]?.status).toBe(400);
        expect(bodyCode(rawResponses[0])).toBe("BAD_REQUEST");
      });
    },
  );

  Scenario(
    "A server error after startup is reported instead of crashing the process",
    ({ Given, When, Then, And }) => {
      let capturedServer: Server | undefined;
      let emitResult: boolean | undefined;
      let emitError: unknown;

      Given("a listening mock whose http server is captured", async () => {
        const listenSpy = vi.spyOn(Server.prototype, "listen");
        const instance = schmock();
        instance("GET /alive", { alive: true });
        mock = instance;
        serverInfo = await instance.listen(0);
        const context = listenSpy.mock.contexts.at(-1);
        capturedServer = context instanceof Server ? context : undefined;
        listenSpy.mockRestore();
        expect(capturedServer).toBeInstanceOf(Server);
      });

      When("the captured server emits an error after startup", () => {
        const acceptError = Object.assign(new Error("accept EMFILE"), {
          code: "EMFILE",
        });
        try {
          emitResult = capturedServer?.emit("error", acceptError);
        } catch (error) {
          emitError = error;
        }
      });

      Then("the error is handled by a listener", () => {
        expect(emitError).toBeUndefined();
        expect(emitResult).toBe(true);
      });

      And('the server still answers "GET /alive" with status 200', async () => {
        const response = await sendRaw(serverInfo, http11("GET /alive"));
        expect(response.status).toBe(200);
      });
    },
  );

  // ── Request handling ───────────────────────────────────────────────────

  Scenario(
    "History records the request exactly as the client sent it",
    ({ Given, When, Then }) => {
      Given(
        "a mock whose POST route mutates the request body, query and headers",
        () => {
          const instance = schmock();
          instance("POST /users", ({ body, query, headers, state }) => {
            if (isRecord(body)) body.id = 42;
            query.injected = "yes";
            headers["x-added"] = "1";
            state.lastUser = body;
            return [201, body];
          });
          mock = instance;
        },
      );

      When(
        'I send a POST with body name "Ann", query a "1" and header h "v"',
        async () => {
          const response = await currentMock().handle("POST", "/users", {
            body: { name: "Ann" },
            query: { a: "1" },
            headers: { h: "v" },
          });
          expect(response.status).toBe(201);
        },
      );

      Then(
        "the last history record shows the body, query and headers the client sent",
        () => {
          const record = currentMock().lastRequest("POST", "/users");
          expect(record?.body).toEqual({ name: "Ann" });
          expect(record?.query).toEqual({ a: "1" });
          expect(record?.headers).toEqual({ h: "v" });
          expect(record?.response.body).toEqual({ name: "Ann", id: 42 });
        },
      );
    },
  );

  Scenario(
    "A plugin editing static route data in place does not change later responses",
    ({ Given, When, Then }) => {
      const bodies: unknown[] = [];

      Given(
        "a mock with a static list route and a plugin that pushes into the response in place",
        () => {
          const instance = schmock();
          instance("GET /list", { items: [1] }).pipe({
            name: "pusher",
            process: (context, response) => {
              if (isRecord(response) && Array.isArray(response.items)) {
                response.items.push(response.items.length + 1);
              }
              return { context, response };
            },
          });
          mock = instance;
        },
      );

      When("I request the static list route three times", async () => {
        for (let index = 0; index < 3; index += 1) {
          bodies.push((await currentMock().handle("GET", "/list")).body);
        }
      });

      Then("every response contains exactly one pushed item", () => {
        expect(bodies).toEqual([
          { items: [1, 2] },
          { items: [1, 2] },
          { items: [1, 2] },
        ]);
      });
    },
  );

  Scenario(
    "A plugin editing the route config in place does not change later requests",
    ({ Given, When, Then }) => {
      const contentTypes: Array<string | undefined> = [];

      Given(
        "a mock with a static route and a plugin that sets the route content type on the first request only",
        () => {
          let firstRequest = true;
          const instance = schmock();
          instance("GET /ok", { ok: 1 }).pipe({
            name: "route-editor",
            process: (context, response) => {
              if (firstRequest) {
                firstRequest = false;
                context.route.contentType = "text/plain";
              }
              return { context, response };
            },
          });
          mock = instance;
        },
      );

      When("I request the static route twice", async () => {
        for (let index = 0; index < 2; index += 1) {
          const response = await currentMock().handle("GET", "/ok");
          contentTypes.push(response.headers["content-type"]);
        }
      });

      Then(
        'the first response is "text/plain" and the second is "application/json"',
        () => {
          expect(contentTypes).toEqual(["text/plain", "application/json"]);
        },
      );
    },
  );

  Scenario(
    "A namespace configured with a trailing slash still serves its bare root",
    ({ Given, When, Then }) => {
      const statuses: number[] = [];

      Given('a mock with namespace "/api/" and a route "GET /"', () => {
        const instance = schmock({ namespace: "/api/" });
        instance("GET /", { root: true });
        mock = instance;
      });

      When('I request "/api", "/api/" and "/api/users"', async () => {
        for (const path of ["/api", "/api/", "/api/users"]) {
          statuses.push((await currentMock().handle("GET", path)).status);
        }
      });

      Then("the statuses are 200, 200 and 404", () => {
        expect(statuses).toEqual([200, 200, 404]);
      });
    },
  );

  // ── Lifecycle events ───────────────────────────────────────────────────

  Scenario(
    "Aborting a request during its route delay emits one request:end with status 499",
    ({ Given, When, Then, And }) => {
      const ends: Schmock.RequestEndEvent[] = [];
      let outcome: unknown;

      Given("a mock with a delayed route and a request:end listener", () => {
        const instance = schmock();
        instance("GET /slow", { ok: true }, { delay: 200 });
        instance.on("request:end", (event) => ends.push(event));
        mock = instance;
      });

      When(
        "I abort a request to the delayed route while it waits",
        async () => {
          const controller = new AbortController();
          const pending = currentMock().handle("GET", "/slow", {
            signal: controller.signal,
          });
          setTimeout(() => controller.abort(), 20);
          outcome = await pending.catch((error: unknown) => error);
        },
      );

      Then("the request rejects with an AbortError", () => {
        expect(outcome).toMatchObject({ name: "AbortError" });
      });

      And("exactly one request:end event with status 499 was emitted", () => {
        expect(ends.map((event) => event.status)).toEqual([499]);
        expect(ends[0]).toMatchObject({ method: "GET", path: "/slow" });
      });
    },
  );

  Scenario(
    "Aborting a failing request during its delay emits one request:end with status 499",
    ({ Given, When, Then, And }) => {
      const ends: Schmock.RequestEndEvent[] = [];
      let outcome: unknown;

      Given(
        "a mock with a delayed failing route and a request:end listener",
        () => {
          const instance = schmock();
          instance(
            "GET /broken",
            () => {
              throw new Error("generator failed");
            },
            { delay: 200 },
          );
          instance.on("request:end", (event) => ends.push(event));
          mock = instance;
        },
      );

      When(
        "I abort a request to the delayed failing route while it waits",
        async () => {
          const controller = new AbortController();
          const pending = currentMock().handle("GET", "/broken", {
            signal: controller.signal,
          });
          setTimeout(() => controller.abort(), 20);
          outcome = await pending.catch((error: unknown) => error);
        },
      );

      Then("the request rejects with an AbortError", () => {
        expect(outcome).toMatchObject({ name: "AbortError" });
      });

      And("exactly one request:end event with status 499 was emitted", () => {
        expect(ends.map((event) => event.status)).toEqual([499]);
        expect(currentMock().history()).toEqual([]);
      });
    },
  );

  // ── Route registration ─────────────────────────────────────────────────

  Scenario(
    "A route with the same shape as an existing one is reported as a duplicate",
    ({ Given, When, Then, And }) => {
      const logLines: string[] = [];

      Given('a debug mock with "GET /users/:id" registered', () => {
        vi.spyOn(console, "log").mockImplementation((message: unknown) => {
          logLines.push(String(message));
        });
        const instance = schmock({ debug: true });
        instance("GET /users/:id", ({ params }) => ({ first: params }));
        mock = instance;
      });

      When('I register "GET /users/:userId"', () => {
        currentMock()("GET /users/:userId", ({ params }) => ({
          second: params,
        }));
      });

      Then("a duplicate route warning is logged", () => {
        expect(
          logLines.some(
            (line) =>
              line.includes("Duplicate route") &&
              line.includes("GET /users/:userId"),
          ),
        ).toBe(true);
      });

      And('getRoutes lists only "GET /users/:id"', () => {
        expect(currentMock().getRoutes()).toEqual([
          { method: "GET", path: "/users/:id", hasParams: true },
        ]);
      });

      And(
        'a request to "/users/7" reaches the first route with id "7"',
        async () => {
          const response = await currentMock().handle("GET", "/users/7");
          expect(response.body).toEqual({ first: { id: "7" } });
        },
      );
    },
  );

  // ── Plugin lifecycle ───────────────────────────────────────────────────

  Scenario(
    "pipe() rejects a plugin without a process hook",
    ({ Given, When, Then, And }) => {
      let pipeError: unknown;

      Given("a fresh mock for plugin validation", () => {
        const instance = schmock();
        instance("GET /x", { ok: true });
        mock = instance;
      });

      When('I pipe a plugin named "noproc" without a process hook', () => {
        const invalidPlugin: unknown = { name: "noproc" };
        try {
          Reflect.apply(currentMock().pipe, currentMock(), [invalidPlugin]);
        } catch (error) {
          pipeError = error;
        }
      });

      Then('pipe throws a SchmockError with code "PLUGIN_INVALID"', () => {
        expect(pipeError).toBeInstanceOf(SchmockError);
        expect(pipeError).toMatchObject({ code: "PLUGIN_INVALID" });
      });

      And("the mock still answers its route with status 200", async () => {
        const response = await currentMock().handle("GET", "/x");
        expect(response.status).toBe(200);
      });
    },
  );

  Scenario(
    "Piping the same plugin object twice installs and runs it once",
    ({ Given, When, Then, And }) => {
      let pipeError: unknown;
      let installs = 0;
      let processCalls = 0;
      const logLines: string[] = [];

      Given("a fresh debug mock for plugin validation", () => {
        vi.spyOn(console, "log").mockImplementation((message: unknown) => {
          logLines.push(String(message));
        });
        const instance = schmock({ debug: true });
        instance("GET /x", { ok: true });
        mock = instance;
      });

      When("I pipe the same plugin object twice", () => {
        const plugin: Schmock.Plugin = {
          name: "counted",
          install: () => {
            installs += 1;
          },
          process: (context, response) => {
            processCalls += 1;
            return { context, response };
          },
        };
        try {
          currentMock().pipe(plugin).pipe(plugin);
        } catch (error) {
          pipeError = error;
        }
      });

      Then("the second pipe is ignored with a duplicate plugin warning", () => {
        expect(pipeError).toBeUndefined();
        expect(
          logLines.some((line) =>
            line.includes("Plugin counted is already piped"),
          ),
        ).toBe(true);
      });

      And(
        "the plugin was installed once and processes each request once",
        async () => {
          await currentMock().handle("GET", "/x");
          expect(installs).toBe(1);
          expect(processCalls).toBe(1);
        },
      );
    },
  );

  function leakyUninstallPlugin(uninstallErrors: unknown[]): Schmock.Plugin {
    const ghost: Schmock.Plugin = {
      name: "ghost",
      process: (context, response) => ({
        context,
        response: { ghost: true, was: response },
      }),
    };
    return {
      name: "leaky",
      process: (context, response) => ({ context, response }),
      uninstall(instance) {
        try {
          instance.pipe(ghost);
        } catch (error) {
          uninstallErrors.push(error);
        }
        try {
          instance("GET /leftover", { leftover: true });
        } catch (error) {
          uninstallErrors.push(error);
        }
      },
    };
  }

  Scenario(
    "uninstall() cannot pipe plugins or register routes into the reset mock",
    ({ Given, When, And, Then }) => {
      const uninstallErrors: unknown[] = [];
      let freshBody: unknown;

      Given(
        'a mock with a plugin whose uninstall pipes a plugin and registers "GET /leftover"',
        () => {
          const instance = schmock();
          instance.pipe(leakyUninstallPlugin(uninstallErrors));
          mock = instance;
        },
      );

      When("I reset the mock with no request in flight", () => {
        currentMock().reset();
      });

      And('I register "GET /fresh" and request it', async () => {
        currentMock()("GET /fresh", { fresh: 1 });
        freshBody = (await currentMock().handle("GET", "/fresh")).body;
      });

      Then("the fresh response is untouched by any leftover plugin", () => {
        expect(freshBody).toEqual({ fresh: 1 });
      });

      And('"GET /leftover" is not registered', () => {
        expect(currentMock().getRoutes()).toEqual([
          { method: "GET", path: "/fresh", hasParams: false },
        ]);
      });

      And(
        'the uninstall hook saw its pipe() rejected with code "PLUGIN_UNINSTALL_OPERATION_UNSUPPORTED"',
        () => {
          expect(uninstallErrors[0]).toBeInstanceOf(SchmockError);
          expect(uninstallErrors[0]).toMatchObject({
            code: "PLUGIN_UNINSTALL_OPERATION_UNSUPPORTED",
          });
        },
      );
    },
  );

  Scenario(
    "A deferred uninstall cannot register routes into the reset mock",
    ({ Given, And, When, Then }) => {
      const uninstallErrors: unknown[] = [];
      const slowGate = deferred();
      let slowRequest: Promise<Schmock.Response> | undefined;

      Given(
        'a mock with a plugin whose uninstall pipes a plugin and registers "GET /leftover"',
        () => {
          const instance = schmock();
          instance("GET /slow", async () => {
            await slowGate.promise;
            return { slow: true };
          });
          instance.pipe(leakyUninstallPlugin(uninstallErrors));
          mock = instance;
        },
      );

      And("a slow request is in flight", () => {
        slowRequest = currentMock().handle("GET", "/slow");
      });

      When("I reset the mock", () => {
        currentMock().reset();
      });

      And('I register "GET /fresh"', () => {
        currentMock()("GET /fresh", { fresh: 1 });
      });

      And("the slow request settles", async () => {
        slowGate.release();
        await slowRequest;
      });

      Then(
        "the fresh response is untouched by any leftover plugin",
        async () => {
          const response = await currentMock().handle("GET", "/fresh");
          expect(response.body).toEqual({ fresh: 1 });
        },
      );

      And('"GET /leftover" is not registered', () => {
        expect(currentMock().getRoutes()).toEqual([
          { method: "GET", path: "/fresh", hasParams: false },
        ]);
      });
    },
  );

  Scenario(
    "Re-piping a plugin after reset runs its pending uninstall before the new install",
    ({ Given, When, And, Then }) => {
      const lifecycle: string[] = [];
      const slowGate = deferred();
      let slowRequest: Promise<Schmock.Response> | undefined;
      let live = false;
      const counting: Schmock.Plugin = {
        name: "counting",
        install: () => {
          lifecycle.push("install");
          live = true;
        },
        uninstall: () => {
          lifecycle.push("uninstall");
          live = false;
        },
        process: (context, response) => ({ context, response }),
      };

      Given(
        "a mock with a counting plugin and a slow request in flight",
        () => {
          const instance = schmock();
          instance("GET /slow", async () => {
            await slowGate.promise;
            return { slow: true };
          });
          instance.pipe(counting);
          mock = instance;
          slowRequest = instance.handle("GET", "/slow");
        },
      );

      When("I reset the mock", () => {
        currentMock().reset();
      });

      And("I pipe the same counting plugin again", () => {
        currentMock().pipe(counting);
      });

      Then(
        "the plugin was uninstalled once before being installed again",
        () => {
          expect(lifecycle).toEqual(["install", "uninstall", "install"]);
        },
      );

      When("the slow request settles", async () => {
        slowGate.release();
        await slowRequest;
      });

      Then(
        "the counting plugin is still live with 2 installs and 1 uninstall",
        () => {
          expect(lifecycle).toEqual(["install", "uninstall", "install"]);
          expect(live).toBe(true);
        },
      );
    },
  );

  // ── Types ──────────────────────────────────────────────────────────────

  Scenario(
    "isStatusTuple does not promise string-record headers",
    ({ Given, When, Then }) => {
      let candidate: unknown;
      let narrowedHeaders: unknown = "not narrowed";

      Given("a three-element tuple whose headers are null", () => {
        candidate = [200, { ok: 1 }, null];
      });

      When("I narrow it with isStatusTuple", () => {
        if (isStatusTuple(candidate) && candidate.length === 3) {
          const headers = candidate[2];
          // Compile-time half of the scenario: `typecheck:bdd` fails if the
          // guard claims a string record it never checked.
          expectTypeOf(headers).toEqualTypeOf<unknown>();
          narrowedHeaders = headers;
        }
      });

      Then(
        "the narrowed headers element is typed unknown and is null at runtime",
        () => {
          expect(narrowedHeaders).toBeNull();
        },
      );
    },
  );

  Scenario(
    "Response helpers carry literal statuses and paginate accepts readonly arrays",
    ({ Given, When, Then, And }) => {
      let list: readonly number[] = [];
      let page: Schmock.PaginatedResponse<number> | undefined;

      Given("a readonly list of 12 numbers", () => {
        list = Object.freeze(
          Array.from({ length: 12 }, (_, index) => index + 1),
        );
      });

      When("I paginate it with page 2 and page size 5", () => {
        page = paginate(list, { page: 2, pageSize: 5 });
      });

      Then("the page holds 5 items starting at 6", () => {
        expect(page?.data).toEqual([6, 7, 8, 9, 10]);
        expect(page?.totalPages).toBe(3);
      });

      And(
        "notFound, badRequest, created and noContent return their literal statuses",
        () => {
          const missing: [404, object] = notFound();
          const invalid: [400, object] = badRequest();
          const made: [201, object] = created({ id: 1 });
          const empty: [204, null] = noContent();
          expectTypeOf(notFound).returns.toEqualTypeOf<[404, object]>();
          expect([missing[0], invalid[0], made[0], empty[0]]).toEqual([
            404, 400, 201, 204,
          ]);
        },
      );
    },
  );
});
