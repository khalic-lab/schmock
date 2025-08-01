import { describe, expect, it } from "vitest";
import { schmock } from "./index";

describe("namespace functionality", () => {
  describe("basic namespace behavior", () => {
    it("applies namespace to all routes", async () => {
      const mock = schmock({ namespace: "/api" });
      mock("GET /users", "users");
      mock("POST /users", "create-user");

      const getResponse = await mock.handle("GET", "/api/users");
      const postResponse = await mock.handle("POST", "/api/users");

      expect(getResponse.body).toBe("users");
      expect(postResponse.body).toBe("create-user");
    });

    it("returns 404 for requests without namespace prefix", async () => {
      const mock = schmock({ namespace: "/api" });
      mock("GET /users", "users");

      const response = await mock.handle("GET", "/users");

      expect(response.status).toBe(404);
      expect(response.body.error).toContain("Route not found: GET /users");
    });

    it("handles nested namespaces", async () => {
      const mock = schmock({ namespace: "/api/v1" });
      mock("GET /users", "v1-users");

      const response = await mock.handle("GET", "/api/v1/users");

      expect(response.body).toBe("v1-users");
    });

    it("works with root namespace", async () => {
      const mock = schmock({ namespace: "/" });
      mock("GET /users", "users");

      const response = await mock.handle("GET", "/users");

      expect(response.body).toBe("users");
    });
  });

  describe("namespace with parameters", () => {
    it("works with parameterized routes under namespace", async () => {
      const mock = schmock({ namespace: "/api" });
      mock("GET /users/:id", ({ params }) => ({ userId: params.id }));

      const response = await mock.handle("GET", "/api/users/123");

      expect(response.body).toEqual({ userId: "123" });
    });

    it("extracts parameters correctly after namespace removal", async () => {
      const mock = schmock({ namespace: "/api/v1" });
      mock("GET /users/:userId/posts/:postId", ({ params, path }) => ({
        params,
        processedPath: path,
      }));

      const response = await mock.handle("GET", "/api/v1/users/456/posts/789");

      expect(response.body).toEqual({
        params: { userId: "456", postId: "789" },
        processedPath: "/users/456/posts/789",
      });
    });

    it("passes correct path to context after namespace stripping", async () => {
      const mock = schmock({ namespace: "/api" });
      mock("GET /test/:param", ({ path, params }) => ({
        contextPath: path,
        params,
      }));

      const response = await mock.handle("GET", "/api/test/value");

      expect(response.body).toEqual({
        contextPath: "/test/value",
        params: { param: "value" },
      });
    });
  });

  describe("namespace edge cases", () => {
    it("handles namespace with trailing slash", async () => {
      const mock = schmock({ namespace: "/api/" });
      mock("GET /users", "users");

      // Should work with or without the trailing slash in the request
      const response1 = await mock.handle("GET", "/api/users");
      const response2 = await mock.handle("GET", "/api//users");

      expect(response1.body).toBe("users");
      // This might not match depending on implementation
      expect(response2.status).toBe(404);
    });

    it("handles empty namespace", async () => {
      const mock = schmock({ namespace: "" });
      mock("GET /users", "users");

      const response = await mock.handle("GET", "/users");

      expect(response.body).toBe("users");
    });

    it("handles namespace without leading slash", async () => {
      const mock = schmock({ namespace: "api" });
      mock("GET /users", "users");

      const response = await mock.handle("GET", "api/users");

      expect(response.body).toBe("users");
    });

    it("rejects requests that partially match namespace", async () => {
      const mock = schmock({ namespace: "/api" });
      mock("GET /users", "users");

      const response1 = await mock.handle("GET", "/ap/users");
      const response2 = await mock.handle("GET", "/apiextra/users");

      expect(response1.status).toBe(404);
      expect(response2.status).toBe(404);
    });

    it("handles very long namespaces", async () => {
      const longNamespace =
        "/api/v1/internal/microservice/health/monitoring/endpoints";
      const mock = schmock({ namespace: longNamespace });
      mock("GET /status", "healthy");

      const response = await mock.handle("GET", `${longNamespace}/status`);

      expect(response.body).toBe("healthy");
    });
  });

  describe("namespace without routes", () => {
    it("returns 404 when no routes defined", async () => {
      const mock = schmock({ namespace: "/api" });

      const response = await mock.handle("GET", "/api/anything");

      expect(response.status).toBe(404);
    });

    it("returns 404 for namespace root when no root route", async () => {
      const mock = schmock({ namespace: "/api" });
      mock("GET /users", "users");

      const response = await mock.handle("GET", "/api");

      expect(response.status).toBe(404);
    });

    it("supports root route under namespace", async () => {
      const mock = schmock({ namespace: "/api" });
      mock("GET /", "api-root");

      const response = await mock.handle("GET", "/api/");

      expect(response.body).toBe("api-root");
    });
  });

  describe("namespace with global state", () => {
    it("maintains global state across namespaced routes", async () => {
      const mock = schmock({
        namespace: "/api",
        state: { counter: 0 },
      });

      mock("POST /increment", ({ state }) => {
        state.counter++;
        return { counter: state.counter };
      });

      mock("GET /count", ({ state }) => ({ counter: state.counter }));

      await mock.handle("POST", "/api/increment");
      await mock.handle("POST", "/api/increment");
      const response = await mock.handle("GET", "/api/count");

      expect(response.body).toEqual({ counter: 2 });
    });
  });

  describe("namespace with plugins", () => {
    it("works correctly with plugin pipeline", async () => {
      const mock = schmock({ namespace: "/api" });

      const plugin = {
        name: "namespace-plugin",
        process: (ctx: any, res: any) => {
          return {
            context: ctx,
            response: {
              ...res,
              namespacedPath: ctx.path,
            },
          };
        },
      };

      mock("GET /users", { users: [] }).pipe(plugin);

      const response = await mock.handle("GET", "/api/users");

      expect(response.body).toEqual({
        users: [],
        namespacedPath: "/users", // Should be the path after namespace removal
      });
    });
  });

  describe("special characters in namespace", () => {
    it("handles namespace with special characters", async () => {
      const mock = schmock({ namespace: "/api-v1.2" });
      mock("GET /users", "users");

      const response = await mock.handle("GET", "/api-v1.2/users");

      expect(response.body).toBe("users");
    });

    it("handles namespace with underscores", async () => {
      const mock = schmock({ namespace: "/my_api" });
      mock("GET /test", "test");

      const response = await mock.handle("GET", "/my_api/test");

      expect(response.body).toBe("test");
    });

    it("handles namespace with numbers", async () => {
      const mock = schmock({ namespace: "/api2" });
      mock("GET /version", "v2");

      const response = await mock.handle("GET", "/api2/version");

      expect(response.body).toBe("v2");
    });
  });

  describe("namespace error messages", () => {
    it("provides clear error message for namespace mismatch", async () => {
      const mock = schmock({ namespace: "/api/v1" });
      mock("GET /users", "users");

      const response = await mock.handle("GET", "/api/v2/users");

      expect(response.status).toBe(404);
      expect(response.body.error).toContain(
        "Route not found: GET /api/v2/users",
      );
      expect(response.body.code).toBe("ROUTE_NOT_FOUND");
    });

    it("includes original requested path in error", async () => {
      const mock = schmock({ namespace: "/api" });
      mock("GET /users", "users");

      const response = await mock.handle("GET", "/wrong/path");

      expect(response.body.error).toContain("/wrong/path");
    });
  });
});
