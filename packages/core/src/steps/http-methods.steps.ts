import { connect } from "node:net";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { isRouteNotFound, schmock } from "../index";
import type { CallableMockInstance, Plugin } from "../types";

const feature = await loadFeature("../../features/http-methods.feature");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RawHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Read a response off the wire rather than through a fetch client: framing and
 * connection headers are exactly what this exercises, and a client normalizes
 * them away. Resolves as soon as the response head is complete, so a rejection
 * that deliberately lingers (413) does not stall the scenario.
 */
function sendRawHttpRequest(
  port: number,
  request: string,
): Promise<RawHttpResponse> {
  return new Promise((resolveResponse, rejectResponse) => {
    const socket = connect(port, "127.0.0.1");
    let rawResponse = "";
    let settled = false;

    const settle = (): void => {
      if (settled) return;
      const separator = rawResponse.indexOf("\r\n\r\n");
      if (separator === -1 && !socket.destroyed) return;
      settled = true;
      const head =
        separator === -1 ? rawResponse : rawResponse.slice(0, separator);
      const body = separator === -1 ? "" : rawResponse.slice(separator + 4);
      const [statusLine = "", ...headerLines] = head.split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const headerSeparator = line.indexOf(":");
        if (headerSeparator === -1) continue;
        headers[line.slice(0, headerSeparator).toLowerCase()] = line
          .slice(headerSeparator + 1)
          .trim();
      }
      socket.destroy();
      resolveResponse({
        status: Number(statusLine.split(" ")[1]),
        headers,
        body,
      });
    };

    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => {
      socket.destroy(new Error("Timed out waiting for a raw response"));
    });
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk: string) => {
      rawResponse += chunk;
      settle();
    });
    socket.on("error", (error) => {
      if (!settled) rejectResponse(error);
    });
    socket.on("close", settle);
  });
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: CallableMockInstance;
  let response: any;
  let responses: any[] = [];
  let listeningPort = 0;
  let listening = false;

  function closeListeningMock(): void {
    if (!listening) return;
    listening = false;
    mock.close();
  }

  // A scenario that fails mid-way must not leave the port bound for the rest
  // of the suite.
  AfterEachScenario(() => {
    closeListeningMock();
  });

  Scenario("GET method with query parameters", ({ Given, When, Then }) => {
    Given("I create a mock with a GET search endpoint", () => {
      mock = schmock();
      mock("GET /search", ({ query }) => ({
        results: [],
        query: query.q,
        page: Number.parseInt(query.page || "1", 10),
        limit: Number.parseInt(query.limit || "10", 10),
      }));
    });

    When("I make a GET request to {string}", async (_, path: string) => {
      const [pathname, queryString] = path.split("?");
      const query: Record<string, string> = {};
      if (queryString) {
        queryString.split("&").forEach((param) => {
          const [key, value] = param.split("=");
          query[key] = value;
        });
      }
      response = await mock.handle("GET", pathname, { query });
    });

    Then("I should receive GET method response:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("POST method with JSON body", ({ Given, When, Then, And }) => {
    Given("I create a mock with a POST users endpoint", () => {
      mock = schmock();
      mock("POST /users", ({ body }) => [
        201,
        {
          id: 123,
          ...(body as Record<string, unknown>),
          createdAt: "2023-01-01T00:00:00Z",
        },
      ]);
    });

    When(
      "I make a POST request to {string} with JSON body:",
      async (_, path: string, docString: string) => {
        const body = JSON.parse(docString);
        response = await mock.handle("POST", path, { body });
      },
    );

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("I should receive POST method response:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("PUT method for resource updates", ({ Given, When, Then }) => {
    Given("I create a mock with a PUT users endpoint", () => {
      mock = schmock();
      mock("PUT /users/:id", ({ params, body }) => ({
        id: Number.parseInt(params.id, 10),
        ...(body as Record<string, unknown>),
        updatedAt: "2023-01-01T00:00:00Z",
      }));
    });

    When(
      "I make a PUT request to {string} with JSON body:",
      async (_, path: string, docString: string) => {
        const body = JSON.parse(docString);
        response = await mock.handle("PUT", path, { body });
      },
    );

    Then("I should receive PUT method response:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("DELETE method with confirmation", ({ Given, When, Then, And }) => {
    Given("I create a mock with a DELETE users endpoint", () => {
      mock = schmock();
      mock("DELETE /users/:id", () => [204, null]);
    });

    When("I make a DELETE request to {string}", async (_, path: string) => {
      response = await mock.handle("DELETE", path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the DELETE response body should be empty", () => {
      expect(response.body).toBeUndefined();
    });
  });

  Scenario("PATCH method for partial updates", ({ Given, When, Then }) => {
    Given("I create a mock with a PATCH users endpoint", () => {
      mock = schmock();
      mock("PATCH /users/:id", ({ params, body }) => ({
        id: Number.parseInt(params.id, 10),
        email: "existing@example.com",
        ...(body as Record<string, unknown>),
        updatedAt: "2023-01-01T00:00:00Z",
      }));
    });

    When(
      "I make a PATCH request to {string} with JSON body:",
      async (_, path: string, docString: string) => {
        const body = JSON.parse(docString);
        response = await mock.handle("PATCH", path, { body });
      },
    );

    Then("I should receive PATCH method response:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("HEAD method returns headers only", ({ Given, When, Then, And }) => {
    Given("I create a mock with a HEAD users endpoint", () => {
      mock = schmock();
      mock("HEAD /users/:id", () => [
        200,
        null,
        {
          "Content-Type": "application/json",
          "Last-Modified": "Wed, 01 Jan 2023 00:00:00 GMT",
          "Content-Length": "156",
        },
      ]);
    });

    When("I make a HEAD request to {string}", async (_, path: string) => {
      response = await mock.handle("HEAD", path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the HEAD response body should be empty", () => {
      expect(response.body).toBeUndefined();
    });

    And("the HEAD response should have proper headers set", () => {
      expect(response.headers?.["Content-Type"]).toBe("application/json");
      expect(response.headers?.["Last-Modified"]).toBe(
        "Wed, 01 Jan 2023 00:00:00 GMT",
      );
      expect(response.headers?.["Content-Length"]).toBe("156");
    });
  });

  Scenario(
    "OPTIONS method for CORS preflight",
    ({ Given, When, Then, And }) => {
      Given("I create a mock with an OPTIONS users endpoint", () => {
        mock = schmock();
        mock("OPTIONS /api/users", () => [
          200,
          null,
          {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods":
              "GET, POST, PUT, DELETE, PATCH, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        ]);
      });

      When("I make an OPTIONS request to {string}", async (_, path: string) => {
        response = await mock.handle("OPTIONS", path);
      });

      Then("I should receive status {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And("the OPTIONS response body should be empty", () => {
        expect(response.body).toBeUndefined();
      });

      And(
        "the OPTIONS response should have header {string} with value {string}",
        (_, headerName: string, headerValue: string) => {
          expect(response.headers?.[headerName]).toBe(headerValue);
        },
      );
    },
  );

  Scenario("Multiple methods on same path", ({ Given, When, Then, And }) => {
    Given(
      "I create a mock with GET, POST, PUT, and DELETE on the same path",
      () => {
        mock = schmock();
        mock("GET /resource", { action: "read" });
        mock("POST /resource", { action: "create" });
        mock("PUT /resource", { action: "update" });
        mock("DELETE /resource", { action: "delete" });
      },
    );

    When("I test all methods on {string}", async (_, path: string) => {
      responses = [];
      responses.push(await mock.handle("GET", path));
      responses.push(await mock.handle("POST", path));
      responses.push(await mock.handle("PUT", path));
      responses.push(await mock.handle("DELETE", path));
    });

    Then("the GET method should return:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[0].body).toEqual(expected);
    });

    And("the POST method should return:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[1].body).toEqual(expected);
    });

    And("the PUT method should return:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[2].body).toEqual(expected);
    });

    And("the DELETE method should return:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[3].body).toEqual(expected);
    });
  });

  Scenario("Method-specific content types", ({ Given, When, Then, And }) => {
    Given("I create a mock with JSON, XML, text, and upload endpoints", () => {
      mock = schmock();
      mock("GET /data.json", { data: "json" });
      mock("GET /data.xml", "<data>xml</data>", {
        contentType: "application/xml",
      });
      mock("GET /data.txt", "plain text data");
      mock("POST /upload", "File uploaded successfully", {
        contentType: "text/plain",
      });
    });

    When("I test method-specific content types", async () => {
      responses = [];
      responses.push(await mock.handle("GET", "/data.json"));
      responses.push(await mock.handle("GET", "/data.xml"));
      responses.push(await mock.handle("GET", "/data.txt"));
      responses.push(await mock.handle("POST", "/upload"));
    });

    Then(
      "the JSON endpoint should have content-type {string}",
      (_, contentType: string) => {
        expect(responses[0].headers?.["content-type"]).toBe(contentType);
      },
    );

    And(
      "the XML endpoint should have content-type {string}",
      (_, contentType: string) => {
        expect(responses[1].headers?.["content-type"]).toBe(contentType);
      },
    );

    And(
      "the text endpoint should have content-type {string}",
      (_, contentType: string) => {
        expect(responses[2].headers?.["content-type"]).toBe(contentType);
      },
    );

    And(
      "the upload endpoint should have content-type {string}",
      (_, contentType: string) => {
        expect(responses[3].headers?.["content-type"]).toBe(contentType);
      },
    );
  });

  Scenario(
    "Method with request headers validation",
    ({ Given, When, Then, And }) => {
      Given("I create a mock with authorization header checking", () => {
        mock = schmock();
        mock("POST /secure", ({ headers, body }) => {
          if (headers.authorization !== "Bearer valid-token") {
            return [401, { error: "Unauthorized" }];
          }
          return [200, { message: "Success", data: body }];
        });
      });

      When("I make a POST request with valid headers", async () => {
        response = await mock.handle("POST", "/secure", {
          headers: { authorization: "Bearer valid-token" },
          body: { test: true },
        });
      });

      Then("I should receive authorized response:", (_, docString: string) => {
        const expected = JSON.parse(docString);
        expect(response.body).toEqual(expected);
      });

      When("I make a POST request with invalid headers", async () => {
        response = await mock.handle("POST", "/secure", {
          headers: { authorization: "Bearer invalid-token" },
          body: { test: true },
        });
      });

      Then("I should receive status {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And("I should receive unauthorized response:", (_, docString: string) => {
        const expected = JSON.parse(docString);
        expect(response.body).toEqual(expected);
      });
    },
  );

  Scenario("Method chaining with plugins", ({ Given, When, Then, And }) => {
    Given("I create a mock with a logger plugin on GET and POST", () => {
      mock = schmock();
      const loggerPlugin: Plugin = {
        name: "method-logger",
        process: (ctx, pluginResponse) => {
          if (!isRecord(pluginResponse)) {
            throw new Error(
              "Expected the logger plugin response to be an object",
            );
          }
          return {
            context: ctx,
            response: {
              ...pluginResponse,
              method: ctx.method,
              logged: true,
            },
          };
        },
      };
      mock("GET /logged", { data: "get" }).pipe(loggerPlugin);
      mock("POST /logged", { data: "post" }).pipe(loggerPlugin);
    });

    When("I test method chaining with plugins", async () => {
      responses = [];
      responses.push(await mock.handle("GET", "/logged"));
      responses.push(await mock.handle("POST", "/logged"));
    });

    Then("the GET with plugin should return:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[0].body).toEqual(expected);
    });

    And("the POST with plugin should return:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[1].body).toEqual(expected);
    });
  });

  Scenario(
    "Body-forbidden responses are normalized before adapters",
    ({ Given, When, Then, And }) => {
      let normalizedResponses: Schmock.Response[];

      Given(
        "I create routes with bodies for HEAD and no-content statuses",
        () => {
          mock = schmock();
          const framingHeaders = {
            "Content-Length": "7",
            Trailer: "x-checksum",
            "Transfer-Encoding": "chunked",
          };
          mock("HEAD /head-body", () => [
            200,
            { forbidden: true },
            framingHeaders,
          ]);
          mock("GET /no-content", () => [
            204,
            { forbidden: true },
            framingHeaders,
          ]);
          mock("GET /reset-content", () => [
            205,
            { forbidden: true },
            framingHeaders,
          ]);
          mock("GET /not-modified", () => [
            304,
            { forbidden: true },
            framingHeaders,
          ]);
        },
      );

      When("I request every body-forbidden route", async () => {
        normalizedResponses = await Promise.all([
          mock.handle("HEAD", "/head-body"),
          mock.handle("GET", "/no-content"),
          mock.handle("GET", "/reset-content"),
          mock.handle("GET", "/not-modified"),
        ]);
      });

      Then("every body-forbidden response should have no body", () => {
        expect(normalizedResponses.map((entry) => entry.body)).toEqual([
          undefined,
          undefined,
          undefined,
          undefined,
        ]);
      });

      And("bodyless response framing headers should be transport-safe", () => {
        expect(normalizedResponses[0].headers).toEqual({
          "Content-Length": "7",
        });
        expect(normalizedResponses[1].headers).toEqual({});
        expect(normalizedResponses[2].headers).toEqual({});
        // A 304 keeps its entity Content-Length (RFC 9110) but must lose
        // Trailer and Transfer-Encoding: Node's writeHead throws on them
        // for bodyless responses, killing the socket.
        expect(normalizedResponses[3].headers).toEqual({
          "Content-Length": "7",
        });
      });
    },
  );

  Scenario(
    "Hop-by-hop headers never reach a transport",
    ({ Given, When, Then }) => {
      let hopResponses: Schmock.Response[];

      Given("I create routes that return hop-by-hop headers", () => {
        mock = schmock();
        const hopHeaders = {
          Connection: "close",
          "Keep-Alive": "timeout=5",
          Upgrade: "websocket",
          TE: "trailers",
          "Proxy-Authenticate": 'Basic realm="proxy"',
          "Proxy-Authorization": "Basic Zm9v",
          "X-Kept": "yes",
        };
        mock("GET /hop", () => [200, { ok: true }, hopHeaders]);
        mock("HEAD /hop-head", () => [200, { ok: true }, hopHeaders]);
        mock("GET /hop-not-modified", () => [304, { ok: true }, hopHeaders]);
      });

      When("I request every hop-by-hop route", async () => {
        hopResponses = await Promise.all([
          mock.handle("GET", "/hop"),
          mock.handle("HEAD", "/hop-head"),
          mock.handle("GET", "/hop-not-modified"),
        ]);
      });

      // Unconditional, unlike Content-Length: a hop-by-hop header belongs to
      // the connection the transport owns, never to a route's response, so
      // there is no HEAD or 304 case where keeping one would be correct.
      Then("no normalized response should carry a hop-by-hop header", () => {
        expect(hopResponses.map((entry) => entry.headers)).toEqual([
          { "X-Kept": "yes" },
          { "X-Kept": "yes" },
          { "X-Kept": "yes" },
        ]);
      });
    },
  );

  Scenario(
    "Ingress failures on the listening server still close the connection",
    ({ Given, When, Then }) => {
      let ingressResponses: RawHttpResponse[];

      Given("I start a listening mock with a JSON route", async () => {
        mock = schmock();
        mock("POST /ingress", ({ body }) => ({ received: body }));
        listeningPort = (await mock.listen(0)).port;
        listening = true;
      });

      When(
        "I send a malformed body and an oversized declared body to it",
        async () => {
          // Sequential, not parallel: the 413 response lingers deliberately
          // while the client may still be uploading, and overlapping reads
          // make the failure mode hard to attribute.
          const malformed = await sendRawHttpRequest(
            listeningPort,
            "POST /ingress HTTP/1.1\r\n" +
              "Host: 127.0.0.1\r\n" +
              "Content-Type: application/json\r\n" +
              "Content-Length: 5\r\n" +
              "\r\n" +
              "{oops",
          );
          const oversized = await sendRawHttpRequest(
            listeningPort,
            "POST /ingress HTTP/1.1\r\n" +
              "Host: 127.0.0.1\r\n" +
              "Content-Type: application/json\r\n" +
              `Content-Length: ${11 * 1024 * 1024}\r\n` +
              "\r\n",
          );
          ingressResponses = [malformed, oversized];
        },
      );

      // The header is the only thing that puts `Connection: close` on the
      // wire — `shouldKeepAlive = false` alone emits nothing — so this is the
      // regression guard for routing it through the adapter's extra headers
      // once the normalizer strips hop-by-hop headers from responses.
      Then("both ingress failures should close the connection", () => {
        expect(ingressResponses.map((entry) => entry.status)).toEqual([
          400, 413,
        ]);
        expect(
          ingressResponses.map((entry) => entry.headers.connection),
        ).toEqual(["close", "close"]);
      });

      When("I stop the listening mock", () => {
        closeListeningMock();
      });
    },
  );

  Scenario(
    "Generated HEAD failures retain semantics without bodies",
    ({ Given, When, Then, And }) => {
      let unmatched: Schmock.Response;
      let thrown: Schmock.Response;

      Given("I create a throwing HEAD route", () => {
        mock = schmock();
        mock("HEAD /throws", () => {
          throw new Error("HEAD failed");
        });
      });

      When("I request unmatched and throwing HEAD routes", async () => {
        [unmatched, thrown] = await Promise.all([
          mock.handle("HEAD", "/missing"),
          mock.handle("HEAD", "/throws"),
        ]);
      });

      Then("both generated HEAD responses should have no body", () => {
        expect(unmatched.body).toBeUndefined();
        expect(thrown.body).toBeUndefined();
      });

      And("only the unmatched HEAD response should be a route miss", () => {
        expect(isRouteNotFound(unmatched)).toBe(true);
        expect(isRouteNotFound(thrown)).toBe(false);
      });
    },
  );

  Scenario(
    "Invalid response status becomes a structured server error",
    ({ Given, When, Then }) => {
      let invalidResponse: Schmock.Response;

      Given("I create a route with a fractional response status", () => {
        mock = schmock();
        mock(
          "GET /invalid-status",
          () => [200.5, { invalid: true }] satisfies [number, unknown],
        );
      });

      When("I request the invalid-status route", async () => {
        invalidResponse = await mock.handle("GET", "/invalid-status");
      });

      Then(
        "the invalid response status should return {int} with code {string}",
        (_, status: number, code: string) => {
          expect(invalidResponse.status).toBe(status);
          expect(invalidResponse.body).toMatchObject({ code });
        },
      );
    },
  );
});
