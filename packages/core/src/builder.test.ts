import { describe, expect, it } from "vitest";
import { RouteDefinitionError, schmock } from "./index";

describe("schmock callable API", () => {
  describe("callable instance", () => {
    it("returns callable mock instance from factory", () => {
      const mock = schmock();
      expect(mock).toBeDefined();
      expect(typeof mock).toBe("function");
      expect(mock.handle).toBeTypeOf("function");
      expect(mock.pipe).toBeTypeOf("function");
    });

    it("allows defining routes through function calls", () => {
      const mock = schmock();
      const result = mock("GET /users", () => [], {});

      expect(result).toBe(mock); // Should return same instance for chaining
      expect(result.pipe).toBeTypeOf("function");
    });

    it("supports chaining with pipe method", () => {
      const mock = schmock();
      const result = mock("GET /users", () => [], {}).pipe({
        name: "test-plugin",
        process: (ctx, response) => ({ context: ctx, response }),
      });

      expect(result).toBe(mock); // Should return same instance for chaining
    });
  });

  describe("request handling", () => {
    it("handles simple GET request", async () => {
      const mock = schmock();
      mock("GET /users", () => [{ id: 1, name: "John" }], {});

      const response = await mock.handle("GET", "/users");

      expect(response.status).toBe(200);
      expect(response.body).toEqual([{ id: 1, name: "John" }]);
      expect(response.headers).toEqual({ "content-type": "application/json" });
    });

    it("returns 404 for undefined routes", async () => {
      const mock = schmock();
      mock("GET /users", () => [], {});

      const response = await mock.handle("GET", "/posts");

      expect(response.status).toBe(404);
    });

    it("handles route with parameters", async () => {
      const mock = schmock();
      mock("GET /users/:id", ({ params }) => ({ userId: params.id }), {});

      const response = await mock.handle("GET", "/users/123");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ userId: "123" });
    });

    it("handles custom status codes via tuple", async () => {
      const mock = schmock();
      mock("POST /users", ({ body }) => [201, { id: 1, ...body }], {});

      const response = await mock.handle("POST", "/users", {
        body: { name: "Alice" },
      });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ id: 1, name: "Alice" });
    });

    it("handles custom headers via triple tuple", async () => {
      const mock = schmock();
      mock(
        "POST /users",
        ({ body }) => [201, { id: 1, ...body }, { Location: "/users/1" }],
        {},
      );

      const response = await mock.handle("POST", "/users", {
        body: { name: "Alice" },
      });

      expect(response.status).toBe(201);
      expect(response.headers).toEqual({
        Location: "/users/1",
      });
    });
  });

  describe("state management", () => {
    it("maintains state across requests with global config", async () => {
      const globalState = { count: 0 };
      const mock = schmock({ state: globalState });
      mock(
        "GET /increment",
        ({ state }) => {
          state.count++;
          return { value: state.count };
        },
        {},
      );

      const first = await mock.handle("GET", "/increment");
      const second = await mock.handle("GET", "/increment");

      expect(first.body).toEqual({ value: 1 });
      expect(second.body).toEqual({ value: 2 });
    });

    it("shares state between routes with global config", async () => {
      const globalState = { users: [] as unknown[] };
      const mock = schmock({ state: globalState });

      mock(
        "POST /users",
        ({ body, state }) => {
          const user = { id: Date.now(), ...body };
          state.users.push(user);
          return [201, user];
        },
        {},
      );

      mock("GET /users", ({ state }) => state.users, {});

      await mock.handle("POST", "/users", { body: { name: "John" } });
      const response = await mock.handle("GET", "/users");

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toHaveProperty("name", "John");
    });
  });

  describe("configuration", () => {
    it("applies namespace to all routes", async () => {
      const mock = schmock({ namespace: "/api/v1" });
      mock("GET /users", () => [], {});

      const response = await mock.handle("GET", "/api/v1/users");

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    it("returns 404 without namespace prefix", async () => {
      const mock = schmock({ namespace: "/api/v1" });
      mock("GET /users", () => [], {});

      const response = await mock.handle("GET", "/users");

      expect(response.status).toBe(404);
    });
  });

  describe("request context", () => {
    it("provides query parameters", async () => {
      const mock = schmock();
      mock(
        "GET /search",
        ({ query }) => ({
          results: [],
          query: query.q,
        }),
        {},
      );

      const response = await mock.handle("GET", "/search", {
        query: { q: "test" },
      });

      expect(response.body).toEqual({
        results: [],
        query: "test",
      });
    });

    it("treats a '?' in the path as a path character, not a query string", async () => {
      const mock = schmock();
      mock("GET /q", ({ query }) => ({ query }));

      const inPath = await mock.handle("GET", "/q?a=1");
      expect(inPath.status).toBe(404);
      expect(inPath.body).toMatchObject({
        error: "Route not found: GET /q%3Fa=1",
        code: "ROUTE_NOT_FOUND",
      });

      const asOption = await mock.handle("GET", "/q", { query: { a: "1" } });
      expect(asOption.status).toBe(200);
      expect(asOption.body).toEqual({ query: { a: "1" } });
    });

    it("provides headers", async () => {
      const mock = schmock();
      mock(
        "GET /auth",
        ({ headers }) => ({
          authenticated: headers.authorization === "Bearer token123",
        }),
        {},
      );

      const response = await mock.handle("GET", "/auth", {
        headers: { authorization: "Bearer token123" },
      });

      expect(response.body).toEqual({ authenticated: true });
    });

    it("provides method and path in context", async () => {
      const mock = schmock();
      mock("GET /info", ({ method, path }) => ({ method, path }), {});

      const response = await mock.handle("GET", "/info");

      expect(response.body).toEqual({
        method: "GET",
        path: "/info",
      });
    });
  });

  describe("contentType auto-detection", () => {
    it("defaults to application/json for function generators", async () => {
      const mock = schmock();
      mock("GET /users", () => [{ id: 1 }], {});

      const response = await mock.handle("GET", "/users");
      expect(response.status).toBe(200);
      expect(response.body).toEqual([{ id: 1 }]);
    });

    it("defaults to text/plain for string generators", async () => {
      const mock = schmock();
      mock("GET /text", "Hello World", {});

      const response = await mock.handle("GET", "/text");
      expect(response.status).toBe(200);
      expect(response.body).toBe("Hello World");
    });

    it("defaults to application/json for object generators", async () => {
      const mock = schmock();
      mock("GET /users", [{ id: 1, name: "John" }], {});

      const response = await mock.handle("GET", "/users");
      expect(response.status).toBe(200);
      expect(response.body).toEqual([{ id: 1, name: "John" }]);
    });

    it("allows explicit contentType override", async () => {
      const mock = schmock();
      mock("GET /json", "Hello World", { contentType: "application/json" });

      const response = await mock.handle("GET", "/json");
      expect(response.status).toBe(200);
      expect(response.body).toBe("Hello World");
    });

    it("validates JSON data for application/json contentType", () => {
      const mock = schmock();

      // This should work - valid JSON data
      expect(() => {
        mock("GET /users", [{ id: 1 }], { contentType: "application/json" });
      }).not.toThrow();

      // This should fail - circular reference can't be JSON serialized
      const circular: any = {};
      circular.self = circular;

      expect(() => {
        mock("GET /users", circular, { contentType: "application/json" });
      }).toThrow(
        "Generator data is not valid JSON but contentType is application/json",
      );
    });

    const nestedCycle: Record<string, unknown> = {};
    nestedCycle.self = nestedCycle;

    it.each([
      ["nested undefined", { a: undefined }, "unsupported undefined value"],
      ["function", { f() {} }, "unsupported function value"],
      ["Map", new Map([[1, 2]]), "unsupported object"],
      // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
      ["sparse array", [1, , 3], "unsupported undefined value"],
      ["NaN", { n: Number.NaN }, "non-finite number"],
      ["symbol key", { [Symbol("s")]: 1 }, "enumerable symbol property"],
      ["tuple body cycle", [200, nestedCycle], "not JSON-serializable"],
    ] satisfies Array<[string, unknown, string]>)(
      "rejects static JSON data with a %s when the route is defined",
      (_label, data, reason) => {
        const mock = schmock();
        let thrown: unknown;
        try {
          mock("GET /data", data as Schmock.StaticData);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(RouteDefinitionError);
        expect(thrown instanceof Error ? thrown.message : "").toContain(reason);
        expect(mock.getRoutes()).toEqual([]);
      },
    );

    it.each([
      ["undefined", undefined],
      ["null", null],
      ["binary", new Uint8Array([1, 2])],
      ["tuple with a binary body", [200, new Uint8Array([1])]],
      ["tuple without a body", [204, undefined]],
      ["string", "already text"],
    ] satisfies Array<[string, unknown]>)(
      "accepts static %s data under the JSON content type",
      async (_label, data) => {
        const mock = schmock();

        expect(() => {
          mock("GET /data", data as Schmock.StaticData, {
            contentType: "application/json",
          });
        }).not.toThrow();
        expect((await mock.handle("GET", "/data")).status).toBeLessThan(500);
      },
    );

    it.each([
      ["application/json; charset=utf-8", { a: new Map([[1, 2]]) }],
      ["application/problem+json", { a: new Map([[1, 2]]) }],
      ["Application/JSON", { a: new Map([[1, 2]]) }],
      ["text/plain", { a: new Map([[1, 2]]) }],
      ["text/html", { a: new Map([[1, 2]]) }],
      ["text/plain", [200, Number.NaN]],
      ["text/html", Number.NaN],
      ["application/json", Number.NaN],
    ] satisfies Array<[string, unknown]>)(
      "rejects static data every request would fail to serialize under %s",
      (contentType, data) => {
        const mock = schmock();
        let thrown: unknown;
        try {
          mock("GET /data", data as Schmock.StaticData, { contentType });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(RouteDefinitionError);
        expect(thrown instanceof Error ? thrown.message : "").toContain(
          `contentType is ${contentType}`,
        );
        expect(mock.getRoutes()).toEqual([]);
      },
    );

    it.each([
      ["a number", 42],
      ["NaN", Number.NaN],
      ["a boolean", true],
    ] satisfies Array<[string, unknown]>)(
      "accepts static %s under text/plain, which sends it as text",
      async (_label, data) => {
        const mock = schmock();

        expect(() => {
          mock("GET /data", data as Schmock.StaticData, {
            contentType: "text/plain",
          });
        }).not.toThrow();
        const response = await mock.handle("GET", "/data");
        expect(response.status).toBe(200);
        expect(response.body).toBe(String(data));
      },
    );

    it("names the reason JSON.stringify gave for static data with a cycle", () => {
      const cycle: Record<string, unknown> = { name: "loop" };
      cycle.self = cycle;
      const mock = schmock();
      let thrown: unknown;
      try {
        mock("GET /loop", cycle as Schmock.StaticData);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(RouteDefinitionError);
      const message = thrown instanceof Error ? thrown.message : "";
      expect(message).toContain("not JSON-serializable: ");
      // V8 says "circular structure", JavaScriptCore "cyclic structures".
      expect(message).toMatch(/circular|cyclic/i);
    });
  });

  describe("plugin integration", () => {
    it("supports plugin pipeline with pipe method", async () => {
      const mock = schmock();
      mock("GET /users", [{ id: 1, name: "John" }], {}).pipe({
        name: "test-plugin",
        process: (ctx, pluginResponse) => ({
          context: ctx,
          response: { data: pluginResponse, processed: true },
        }),
      });

      const response = await mock.handle("GET", "/users");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        data: [{ id: 1, name: "John" }],
        processed: true,
      });
    });
  });

  describe("request-spy path filters", () => {
    it("matches the literal path spelling passed to handle()", async () => {
      const mock = schmock();
      mock("GET /users/:name", ({ params }) => ({ name: params.name }), {});

      await mock.handle("GET", "/users/José");

      // history stores the canonical (encoded) form, so the filter must be
      // canonicalized too — otherwise the very string handed to handle()
      // fails to find its own record.
      expect(mock.called("GET", "/users/José")).toBe(true);
      expect(mock.callCount("GET", "/users/José")).toBe(1);
      expect(mock.history("GET", "/users/José")).toHaveLength(1);
      expect(mock.lastRequest("GET", "/users/José")?.path).toBe(
        "/users/Jos%C3%A9",
      );
    });

    it("also matches the already-encoded spelling a transport delivers", async () => {
      const mock = schmock();
      mock("GET /users/:name", ({ params }) => ({ name: params.name }), {});

      await mock.handle("GET", "/users/José");

      expect(mock.called("GET", "/users/Jos%C3%A9")).toBe(true);
      expect(mock.callCount("GET", "/users/Jos%C3%A9")).toBe(1);
      expect(mock.history("GET", "/users/Jos%C3%A9")).toHaveLength(1);
      expect(mock.lastRequest("GET", "/users/Jos%C3%A9")?.path).toBe(
        "/users/Jos%C3%A9",
      );
    });

    it("matches a path containing a space", async () => {
      const mock = schmock();
      mock("GET /my docs", { ok: true }, {});

      await mock.handle("GET", "/my docs");

      expect(mock.called("GET", "/my docs")).toBe(true);
      expect(mock.called("GET", "/my%20docs")).toBe(true);
    });

    it("still discriminates between distinct paths", async () => {
      const mock = schmock();
      mock("GET /a", { a: 1 }, {});
      mock("GET /b", { b: 1 }, {});

      await mock.handle("GET", "/a");

      expect(mock.called("GET", "/b")).toBe(false);
      expect(mock.callCount("GET", "/a")).toBe(1);
    });
  });
});
