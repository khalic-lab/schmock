import { describe, expect, it } from "vitest";
import { schmock } from "./index";

describe("schmock builder", () => {
  describe("fluent API", () => {
    it("returns builder instance from factory", () => {
      const builder = schmock();
      expect(builder).toBeDefined();
      expect(builder.config).toBeTypeOf("function");
      expect(builder.routes).toBeTypeOf("function");
      expect(builder.state).toBeTypeOf("function");
      expect(builder.use).toBeTypeOf("function");
      expect(builder.build).toBeTypeOf("function");
    });

    it("chains method calls fluently", () => {
      const builder = schmock()
        .config({ namespace: "/api" })
        .routes({
          "GET /users": {
            response: () => [],
          },
        })
        .state({ count: 0 });

      expect(builder).toBeDefined();
      expect(builder.build).toBeTypeOf("function");
    });

    it("builds mock instance", () => {
      const mock = schmock()
        .routes({
          "GET /users": {
            response: () => [],
          },
        })
        .build();

      expect(mock).toBeDefined();
      expect(mock.handle).toBeTypeOf("function");
    });
  });

  describe("request handling", () => {
    it("handles simple GET request", async () => {
      const mock = schmock()
        .routes({
          "GET /users": {
            response: () => [{ id: 1, name: "John" }],
          },
        })
        .build();

      const response = await mock.handle("GET", "/users");

      expect(response.status).toBe(200);
      expect(response.body).toEqual([{ id: 1, name: "John" }]);
      expect(response.headers).toEqual({});
    });

    it("returns 404 for undefined routes", async () => {
      const mock = schmock()
        .routes({
          "GET /users": {
            response: () => [],
          },
        })
        .build();

      const response = await mock.handle("GET", "/posts");

      expect(response.status).toBe(404);
    });

    it("handles route with parameters", async () => {
      const mock = schmock()
        .routes({
          "GET /users/:id": {
            response: ({ params }) => ({ userId: params.id }),
          },
        })
        .build();

      const response = await mock.handle("GET", "/users/123");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ userId: "123" });
    });

    it("handles custom status codes via tuple", async () => {
      const mock = schmock()
        .routes({
          "POST /users": {
            response: ({ body }) => [201, { id: 1, ...body }],
          },
        })
        .build();

      const response = await mock.handle("POST", "/users", {
        body: { name: "Alice" },
      });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ id: 1, name: "Alice" });
    });

    it("handles custom headers via triple tuple", async () => {
      const mock = schmock()
        .routes({
          "POST /users": {
            response: ({ body }) => [
              201,
              { id: 1, ...body },
              { Location: "/users/1" },
            ],
          },
        })
        .build();

      const response = await mock.handle("POST", "/users", {
        body: { name: "Alice" },
      });

      expect(response.status).toBe(201);
      expect(response.headers).toEqual({ Location: "/users/1" });
    });
  });

  describe("state management", () => {
    it("maintains state across requests", async () => {
      const mock = schmock()
        .state({ count: 0 })
        .routes({
          "GET /increment": {
            response: ({ state }) => {
              state.count++;
              return { value: state.count };
            },
          },
        })
        .build();

      const first = await mock.handle("GET", "/increment");
      const second = await mock.handle("GET", "/increment");

      expect(first.body).toEqual({ value: 1 });
      expect(second.body).toEqual({ value: 2 });
    });

    it("shares state between routes", async () => {
      const mock = schmock()
        .state({ users: [] as unknown[] })
        .routes({
          "POST /users": {
            response: ({ body, state }) => {
              const user = { id: Date.now(), ...body };
              state.users.push(user);
              return [201, user];
            },
          },
          "GET /users": {
            response: ({ state }) => state.users,
          },
        })
        .build();

      await mock.handle("POST", "/users", { body: { name: "John" } });
      const response = await mock.handle("GET", "/users");

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toHaveProperty("name", "John");
    });
  });

  describe("configuration", () => {
    it("applies namespace to all routes", async () => {
      const mock = schmock()
        .config({ namespace: "/api/v1" })
        .routes({
          "GET /users": {
            response: () => [],
          },
        })
        .build();

      const response = await mock.handle("GET", "/api/v1/users");

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    it("returns 404 without namespace prefix", async () => {
      const mock = schmock()
        .config({ namespace: "/api/v1" })
        .routes({
          "GET /users": {
            response: () => [],
          },
        })
        .build();

      const response = await mock.handle("GET", "/users");

      expect(response.status).toBe(404);
    });
  });

  describe("request context", () => {
    it("provides query parameters", async () => {
      const mock = schmock()
        .routes({
          "GET /search": {
            response: ({ query }) => ({
              results: [],
              query: query.q,
            }),
          },
        })
        .build();

      const response = await mock.handle("GET", "/search", {
        query: { q: "test" },
      });

      expect(response.body).toEqual({
        results: [],
        query: "test",
      });
    });

    it("provides headers", async () => {
      const mock = schmock()
        .routes({
          "GET /auth": {
            response: ({ headers }) => ({
              authenticated: headers.authorization === "Bearer token123",
            }),
          },
        })
        .build();

      const response = await mock.handle("GET", "/auth", {
        headers: { authorization: "Bearer token123" },
      });

      expect(response.body).toEqual({ authenticated: true });
    });

    it("provides method and path in context", async () => {
      const mock = schmock()
        .routes({
          "GET /info": {
            response: ({ method, path }) => ({ method, path }),
          },
        })
        .build();

      const response = await mock.handle("GET", "/info");

      expect(response.body).toEqual({
        method: "GET",
        path: "/info",
      });
    });
  });
});
