import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type {
  FakerPluginOptions,
  OnSchemaCallback,
  OpenApiRefPolicy,
  PaginatedResponse,
  PathPrefix,
  RequestEndEvent,
  SchmockEventMap,
  ServeNodeResponseContext,
} from "../index";
import {
  InvalidHttpMethodError,
  matchPathPrefix,
  paginate,
  parsePathPrefix,
  SchmockError,
  schmock,
  serveNodeRequest,
  toHttpMethod,
} from "../index";

const feature = await loadFeature(
  "../../features/review-core-primitives.feature",
);

// ── Compile-time checks (typecheck:bdd) ─────────────────────────────────────
//
// `Plugin.install`/`uninstall` return `void | undefined`: an async hook no
// longer type-checks, while every synchronous hook, annotated or inferred,
// still does. These aliases resolve to `true` only while that holds.
type InstallHook = NonNullable<Schmock.Plugin["install"]>;
type UninstallHook = NonNullable<Schmock.Plugin["uninstall"]>;
type AsyncHook = (instance: Schmock.CallableMockInstance) => Promise<void>;
type SyncHook = (instance: Schmock.CallableMockInstance) => void;
type AsyncInstallRejected = AsyncHook extends InstallHook ? false : true;
type AsyncUninstallRejected = AsyncHook extends UninstallHook ? false : true;
type SyncInstallAccepted = SyncHook extends InstallHook ? true : false;
type SyncUninstallAccepted = SyncHook extends UninstallHook ? true : false;
const hookTypeChecks: [
  AsyncInstallRejected,
  AsyncUninstallRejected,
  SyncInstallAccepted,
  SyncUninstallAccepted,
] = [true, true, true, true];

// Faker options take a `Schema`, so an inline literal may use the Schmock
// keywords without being hoisted into a typed constant first.
const inlineFakerOptions: FakerPluginOptions = {
  schema: {
    type: "object",
    properties: {
      name: { type: "string", faker: "person.fullName" },
      nickname: { type: ["string", "null"], schmockNullable: true },
    },
  },
};

// Types from public signatures are importable by name from the root entry.
const pageOfOne: PaginatedResponse<number> = paginate([1]);
const endEvent: SchmockEventMap["request:end"] | RequestEndEvent | undefined =
  undefined;
const refPolicy: OpenApiRefPolicy = { external: false };
const keepSchema: OnSchemaCallback = () => undefined;

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function parseRawResponse(raw: string): RawResponse {
  const headEnd = raw.indexOf("\r\n\r\n");
  const head = headEnd === -1 ? raw : raw.slice(0, headEnd);
  const body = headEnd === -1 ? "" : raw.slice(headEnd + 4);
  const [statusLine = "", ...headerLines] = head.split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line
      .slice(separator + 1)
      .trim();
  }
  return { status: Number(statusLine.split(" ")[1]), headers, body };
}

/**
 * Send raw request bytes: Node's own client rejects or rewrites the malformed
 * requests (a broken Host, a missing Host, an unknown verb) these need.
 */
function sendRaw(port: number, requestText: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      resolve(parseRawResponse(Buffer.concat(chunks).toString("utf8")));
    });
    socket.write(requestText);
  });
}

function rawRequest(requestLine: string, host = "127.0.0.1"): string {
  return `${requestLine} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
}

function bodyCode(response: RawResponse): unknown {
  if (response.body === "") return undefined;
  const parsed: unknown = JSON.parse(response.body);
  return typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    "code" in parsed
    ? parsed.code
    : undefined;
}

/** Requests whose answers must not depend on which Node server gets them. */
const PARITY_REQUESTS = [
  rawRequest("GET /users"),
  rawRequest("GET /missing"),
  rawRequest("GET //users"),
  rawRequest("PROPFIND /users"),
  rawRequest("GET /users", "bad host["),
  "GET /users HTTP/1.0\r\n\r\n",
  rawRequest("GET http://[::1/users"),
  "POST /users HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n" +
    "Content-Type: application/json\r\nContent-Length: 5\r\n\r\n{oops",
];

function listenOn(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance | undefined;
  let listenPort = 0;
  let bridgeServer: Server | undefined;
  let bridgePort = 0;
  let rawResponses: RawResponse[] = [];

  AfterEachScenario(async () => {
    mock?.close();
    mock = undefined;
    rawResponses = [];
    const server = bridgeServer;
    bridgeServer = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  function currentMock(): Schmock.CallableMockInstance {
    if (!mock) throw new Error("scenario did not create a mock");
    return mock;
  }

  async function listeningMock(): Promise<void> {
    const instance = schmock();
    instance("GET /users", [{ id: 1 }]);
    instance("POST /users", ({ body }) => [201, body]);
    mock = instance;
    listenPort = (await instance.listen(0)).port;
  }

  async function startBridge(
    extraHeaders?: (
      context: ServeNodeResponseContext,
    ) => Record<string, string>,
  ): Promise<void> {
    const served = currentMock();
    const server = createServer((req, res) => {
      void serveNodeRequest(req, res, {
        handle: served.handle,
        maxBodySize: 10 * 1024 * 1024,
        extraHeaders,
      });
    });
    bridgeServer = server;
    bridgePort = await listenOn(server);
  }

  // ── One trailing-slash rule ────────────────────────────────────────────

  Scenario(
    "A namespace with a trailing slash behaves exactly like one without",
    ({ Given, When, Then }) => {
      const mocks: Schmock.CallableMockInstance[] = [];
      const statuses: number[][] = [];

      Given(
        'a mock with namespace "/api" and a mock with namespace "/api/", each with routes "GET /" and "GET /users"',
        () => {
          for (const namespace of ["/api", "/api/"]) {
            const instance = schmock({ namespace });
            instance("GET /", { root: true });
            instance("GET /users", [{ id: 1 }]);
            mocks.push(instance);
          }
        },
      );

      When(
        'I request "/api", "/api/", "/api/users", "/api//users" and "/apiv2/users" from both mocks',
        async () => {
          const paths = [
            "/api",
            "/api/",
            "/api/users",
            "/api//users",
            "/apiv2/users",
          ];
          for (const instance of mocks) {
            const answered: number[] = [];
            for (const path of paths) {
              answered.push((await instance.handle("GET", path)).status);
            }
            statuses.push(answered);
          }
        },
      );

      Then("both mocks answer 200, 200, 200, 404 and 404", () => {
        expect(statuses).toEqual([
          [200, 200, 200, 404, 404],
          [200, 200, 200, 404, 404],
        ]);
      });
    },
  );

  Scenario(
    "The namespace and the interceptor baseUrl share one prefix rule",
    ({ Given, Then, And }) => {
      let prefix: PathPrefix = { origin: null, path: "" };

      Given('the path prefix parsed from "/api/"', () => {
        prefix = parsePathPrefix("/api/");
      });

      Then('it equals the path prefix parsed from "/api"', () => {
        expect(prefix).toEqual(parsePathPrefix("/api"));
      });

      And('it matches "/api" and "/api/users" but not "/apiv2" or "/"', () => {
        expect(
          ["/api", "/api/users", "/apiv2", "/"].map((path) =>
            matchPathPrefix(prefix, path),
          ),
        ).toEqual([true, true, false, false]);
      });
    },
  );

  // ── toHttpMethod ───────────────────────────────────────────────────────

  Scenario(
    "toHttpMethod rejects an unknown verb with a SchmockError",
    ({ When, Then, And }) => {
      let thrown: unknown;

      When('I convert the method "PROPFIND" with toHttpMethod', () => {
        try {
          toHttpMethod("PROPFIND");
        } catch (error) {
          thrown = error;
        }
      });

      Then(
        'it throws an InvalidHttpMethodError with code "INVALID_HTTP_METHOD"',
        () => {
          expect(thrown).toBeInstanceOf(InvalidHttpMethodError);
          expect(thrown).toMatchObject({ code: "INVALID_HTTP_METHOD" });
        },
      );

      And("the error is a SchmockError whose message names the verb", () => {
        expect(thrown).toBeInstanceOf(SchmockError);
        expect(thrown).toMatchObject({
          message: 'Invalid HTTP method: "PROPFIND"',
        });
      });
    },
  );

  // ── listen() / serveNodeRequest parity ─────────────────────────────────

  Scenario(
    "mock.listen() answers an unsupported method with 405 and Allow",
    ({ Given, When, Then, And }) => {
      Given('a listening mock with a route "GET /users"', listeningMock);

      When(
        'a raw client sends "PROPFIND /users" with Host "127.0.0.1"',
        async () => {
          rawResponses.push(
            await sendRaw(listenPort, rawRequest("PROPFIND /users")),
          );
        },
      );

      Then(
        'the raw response status is 405 with code "METHOD_NOT_ALLOWED"',
        () => {
          expect(rawResponses[0]?.status).toBe(405);
          expect(bodyCode(rawResponses[0])).toBe("METHOD_NOT_ALLOWED");
        },
      );

      And(
        'the raw response Allow header is "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS"',
        () => {
          expect(rawResponses[0]?.headers.allow).toBe(
            "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
          );
        },
      );
    },
  );

  Scenario(
    "mock.listen() answers a malformed Host header with 400",
    ({ Given, When, Then }) => {
      Given('a listening mock with a route "GET /users"', listeningMock);

      When(
        'a raw client sends "GET /users" with a Host header that has an unclosed bracket',
        async () => {
          rawResponses.push(
            await sendRaw(listenPort, rawRequest("GET /users", "bad host[")),
          );
        },
      );

      Then('the raw response status is 400 with code "BAD_REQUEST"', () => {
        expect(rawResponses[0]?.status).toBe(400);
        expect(bodyCode(rawResponses[0])).toBe("BAD_REQUEST");
        expect(currentMock().history()).toEqual([]);
      });
    },
  );

  Scenario(
    "A server built on serveNodeRequest answers every request like mock.listen()",
    ({ Given, When, Then, And }) => {
      const answers: Array<{ listen: RawResponse; bridge: RawResponse }> = [];

      Given('a listening mock with a route "GET /users"', listeningMock);

      And(
        "a Node server that serves the same mock through serveNodeRequest",
        () => startBridge(),
      );

      When("the same raw requests are sent to both servers", async () => {
        for (const request of PARITY_REQUESTS) {
          answers.push({
            listen: await sendRaw(listenPort, request),
            bridge: await sendRaw(bridgePort, request),
          });
        }
      });

      Then(
        "both servers answer each request with the same status and code",
        () => {
          const summarize = (response: RawResponse) => ({
            status: response.status,
            code: bodyCode(response),
            allow: response.headers.allow,
          });
          expect(answers.map(({ bridge }) => summarize(bridge))).toEqual(
            answers.map(({ listen }) => summarize(listen)),
          );
          expect(answers.map(({ listen }) => listen.status)).toEqual([
            200, 404, 404, 405, 400, 400, 400, 400,
          ]);
        },
      );
    },
  );

  Scenario(
    "serveNodeRequest writes extra headers on success and error answers",
    ({ Given, When, Then, And }) => {
      const contexts: ServeNodeResponseContext[] = [];

      Given('a listening mock with a route "GET /users"', listeningMock);

      And(
        'a Node server that serves the same mock through serveNodeRequest with an "x-served-by" extra header',
        () =>
          startBridge((context) => {
            contexts.push(context);
            return { "x-served-by": "schmock" };
          }),
      );

      When(
        'a raw client sends "GET /users" and then "PROPFIND /users" to that server',
        async () => {
          rawResponses.push(
            await sendRaw(bridgePort, rawRequest("GET /users")),
          );
          rawResponses.push(
            await sendRaw(bridgePort, rawRequest("PROPFIND /users")),
          );
        },
      );

      Then('both raw responses carry the "x-served-by" header', () => {
        expect(rawResponses.map((response) => response.status)).toEqual([
          200, 405,
        ]);
        expect(
          rawResponses.map((response) => response.headers["x-served-by"]),
        ).toEqual(["schmock", "schmock"]);
      });

      And(
        "the extra-headers hook saw a success answer and then an error answer",
        () => {
          expect(contexts).toEqual([
            { isError: false, path: "/users" },
            { isError: true, path: "/users" },
          ]);
        },
      );
    },
  );

  // ── Plugin hook types ──────────────────────────────────────────────────

  Scenario(
    "A plugin whose synchronous hooks are not annotated still pipes and uninstalls",
    ({ Given, When, Then }) => {
      const ran: string[] = [];
      // Deliberately not annotated `Schmock.Plugin`: the hooks' return types
      // are inferred as `void`, which `void | undefined` must still accept.
      const plugin = {
        name: "unannotated",
        install(instance: Schmock.CallableMockInstance) {
          instance("GET /installed", { installed: true });
          ran.push("install");
        },
        uninstall() {
          ran.push("uninstall");
        },
        process(context: Schmock.PluginContext, response?: unknown) {
          return { context, response };
        },
      };

      Given(
        "a plugin object literal with unannotated install and uninstall hooks",
        () => {
          expect(hookTypeChecks).toEqual([true, true, true, true]);
          expect(inlineFakerOptions.schema.type).toBe("object");
          expect(pageOfOne.data).toEqual([1]);
          expect([endEvent, refPolicy.external, keepSchema.length]).toEqual([
            undefined,
            false,
            0,
          ]);
        },
      );

      When("I pipe it into a mock and reset the mock", async () => {
        const instance = schmock();
        instance.pipe(plugin);
        expect((await instance.handle("GET", "/installed")).status).toBe(200);
        instance.reset();
      });

      Then("its install and uninstall hooks both ran", () => {
        expect(ran).toEqual(["install", "uninstall"]);
      });
    },
  );
});
