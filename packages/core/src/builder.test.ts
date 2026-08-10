import { describe, expect, it } from "vitest";
import { schmock } from "./index";

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
