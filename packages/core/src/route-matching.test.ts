import { describe, expect, it } from "vitest";
import { schmock } from "./index";

describe("route matching", () => {
  describe("static routes", () => {
    it("matches exact static routes", async () => {
      const mock = schmock();
      mock("GET /users", "users");
      mock("GET /posts", "posts");

      const users = await mock.handle("GET", "/users");
      const posts = await mock.handle("GET", "/posts");

      expect(users.body).toBe("users");
      expect(posts.body).toBe("posts");
    });

    it("differentiates between HTTP methods", async () => {
      const mock = schmock();
      mock("GET /resource", "get-response");
      mock("POST /resource", "post-response");
      mock("PUT /resource", "put-response");
      mock("DELETE /resource", "delete-response");

      const getRes = await mock.handle("GET", "/resource");
      const postRes = await mock.handle("POST", "/resource");
      const putRes = await mock.handle("PUT", "/resource");
      const deleteRes = await mock.handle("DELETE", "/resource");

      expect(getRes.body).toBe("get-response");
      expect(postRes.body).toBe("post-response");
      expect(putRes.body).toBe("put-response");
      expect(deleteRes.body).toBe("delete-response");
    });

    it("handles root path correctly", async () => {
      const mock = schmock();
      mock("GET /", "root");

      const response = await mock.handle("GET", "/");
      expect(response.body).toBe("root");
    });

    it("case sensitive path matching", async () => {
      const mock = schmock();
      mock("GET /Users", "capital-users");

      const response1 = await mock.handle("GET", "/Users");
      const response2 = await mock.handle("GET", "/users");

      expect(response1.body).toBe("capital-users");
      expect(response2.status).toBe(404);
    });
  });

  describe("parameterized routes", () => {
    it("matches single parameter routes", async () => {
      const mock = schmock();
      mock("GET /users/:id", ({ params }) => ({ userId: params.id }));

      const response = await mock.handle("GET", "/users/123");

      expect(response.body).toEqual({ userId: "123" });
    });

    it("matches multiple parameter routes", async () => {
      const mock = schmock();
      mock("GET /users/:userId/posts/:postId", ({ params }) => ({
        user: params.userId,
        post: params.postId,
      }));

      const response = await mock.handle("GET", "/users/456/posts/789");

      expect(response.body).toEqual({ user: "456", post: "789" });
    });

    it("handles parameters with special characters", async () => {
      const mock = schmock();
      mock("GET /files/:filename", ({ params }) => ({ file: params.filename }));

      const response = await mock.handle("GET", "/files/test-file.txt");

      expect(response.body).toEqual({ file: "test-file.txt" });
    });

    it("handles parameters with numbers", async () => {
      const mock = schmock();
      mock("GET /items/:id", ({ params }) => ({ itemId: params.id }));

      const response = await mock.handle("GET", "/items/12345");

      expect(response.body).toEqual({ itemId: "12345" });
    });

    it("handles parameters with underscores and hyphens", async () => {
      const mock = schmock();
      mock("GET /api/:snake_case/:kebab-case", ({ params }) => params);

      const response = await mock.handle(
        "GET",
        "/api/test_value/another-value",
      );

      expect(response.body).toEqual({
        snake_case: "test_value",
        "kebab-case": "another-value",
      });
    });

    it("doesn't match if parameter segment is empty", async () => {
      const mock = schmock();
      mock("GET /users/:id", "found");

      const response = await mock.handle("GET", "/users/");

      expect(response.status).toBe(404);
    });

    it("doesn't match parameters across path segments", async () => {
      const mock = schmock();
      mock("GET /users/:id", "found");

      const response = await mock.handle("GET", "/users/123/extra");

      expect(response.status).toBe(404);
    });
  });

  describe("route precedence and conflicts", () => {
    it("matches most recently defined route when patterns overlap", async () => {
      const mock = schmock();
      mock("GET /users/:id", "parameterized");
      mock("GET /users/special", "static");

      const paramResponse = await mock.handle("GET", "/users/123");
      const staticResponse = await mock.handle("GET", "/users/special");

      // The static route should be matched since it was defined later
      expect(paramResponse.body).toBe("parameterized");
      expect(staticResponse.body).toBe("static");
    });

    it("handles exact vs parameterized route conflicts", async () => {
      const mock = schmock();
      mock("GET /api/:version/users", "versioned");
      mock("GET /api/v1/users", "v1-specific");

      const versionedResponse = await mock.handle("GET", "/api/v2/users");
      const v1Response = await mock.handle("GET", "/api/v1/users");

      expect(versionedResponse.body).toBe("versioned");
      expect(v1Response.body).toBe("v1-specific");
    });

    it("matches first matching route in definition order", async () => {
      const mock = schmock();
      mock("GET /:type/items", "first");
      mock("GET /shop/:category", "second");

      const response = await mock.handle("GET", "/shop/items");

      // Both routes match, but with reverse order search, the second route should win
      // /:type/items matches with type="shop"
      // /shop/:category matches with category="items"
      // Since we search in reverse, /shop/:category (more specific) should match
      expect(response.body).toBe("second");
    });
  });

  describe("complex path patterns", () => {
    it("handles deeply nested parameterized routes", async () => {
      const mock = schmock();
      mock(
        "GET /api/:version/users/:userId/posts/:postId/comments/:commentId",
        ({ params }) => params,
      );

      const response = await mock.handle(
        "GET",
        "/api/v1/users/123/posts/456/comments/789",
      );

      expect(response.body).toEqual({
        version: "v1",
        userId: "123",
        postId: "456",
        commentId: "789",
      });
    });

    it("handles mixed static and parameterized segments", async () => {
      const mock = schmock();
      mock(
        "GET /api/v1/users/:userId/profile/settings/:setting",
        ({ params }) => params,
      );

      const response = await mock.handle(
        "GET",
        "/api/v1/users/789/profile/settings/privacy",
      );

      expect(response.body).toEqual({
        userId: "789",
        setting: "privacy",
      });
    });

    it("handles paths with similar prefixes", async () => {
      const mock = schmock();
      mock("GET /user", "single-user");
      mock("GET /users", "all-users");
      mock("GET /users/:id", "specific-user");

      const singleResponse = await mock.handle("GET", "/user");
      const allResponse = await mock.handle("GET", "/users");
      const specificResponse = await mock.handle("GET", "/users/123");

      expect(singleResponse.body).toBe("single-user");
      expect(allResponse.body).toBe("all-users");
      expect(specificResponse.body).toBe("specific-user");
    });
  });

  describe("edge cases", () => {
    it("handles empty parameter values correctly", async () => {
      const mock = schmock();
      mock("GET /search/:query", ({ params }) => ({ query: params.query }));

      // This should not match because parameter is empty
      const response = await mock.handle("GET", "/search/");

      expect(response.status).toBe(404);
    });

    it("handles special characters in paths", async () => {
      const mock = schmock();
      mock("GET /files/:filename", ({ params }) => ({ file: params.filename }));

      const response = await mock.handle("GET", "/files/my-file.test.json");

      expect(response.body).toEqual({ file: "my-file.test.json" });
    });

    it("handles URL encoded characters in parameters", async () => {
      const mock = schmock();
      mock("GET /search/:query", ({ params }) => ({ query: params.query }));

      // Note: This tests the raw parameter, URL decoding would happen at HTTP layer
      const response = await mock.handle("GET", "/search/hello%20world");

      expect(response.body).toEqual({ query: "hello%20world" });
    });

    it("handles very long parameter values", async () => {
      const mock = schmock();
      mock("GET /data/:id", ({ params }) => ({ length: params.id.length }));

      const longId = "a".repeat(1000);
      const response = await mock.handle("GET", `/data/${longId}`);

      expect(response.body).toEqual({ length: 1000 });
    });

    it("handles numeric parameter values", async () => {
      const mock = schmock();
      mock("GET /items/:id", ({ params }) => ({
        id: params.id,
        type: typeof params.id,
        parsed: Number.parseInt(params.id),
      }));

      const response = await mock.handle("GET", "/items/12345");

      expect(response.body).toEqual({
        id: "12345",
        type: "string",
        parsed: 12345,
      });
    });
  });

  describe("no route found scenarios", () => {
    it("returns 404 for completely unmatched paths", async () => {
      const mock = schmock();
      mock("GET /existing", "found");

      const response = await mock.handle("GET", "/nonexistent");

      expect(response.status).toBe(404);
      expect(response.body.error).toContain("Route not found");
      expect(response.body.code).toBe("ROUTE_NOT_FOUND");
    });

    it("returns 404 for wrong HTTP method", async () => {
      const mock = schmock();
      mock("GET /resource", "get-only");

      const response = await mock.handle("POST", "/resource");

      expect(response.status).toBe(404);
      expect(response.body.error).toContain("POST /resource");
    });

    it("returns 404 for partial path matches", async () => {
      const mock = schmock();
      mock("GET /api/users", "found");

      const response1 = await mock.handle("GET", "/api");
      const response2 = await mock.handle("GET", "/api/users/extra");

      expect(response1.status).toBe(404);
      expect(response2.status).toBe(404);
    });
  });

  describe("regex pattern validation", () => {
    it("escapes special regex characters in static paths", async () => {
      const mock = schmock();
      mock("GET /api/test.json", "json-file");
      mock("GET /api/test*json", "wildcard-file");

      const jsonResponse = await mock.handle("GET", "/api/test.json");
      const wildcardResponse = await mock.handle("GET", "/api/test*json");
      const dotResponse = await mock.handle("GET", "/api/testXjson"); // Should not match

      expect(jsonResponse.body).toBe("json-file");
      expect(wildcardResponse.body).toBe("wildcard-file");
      expect(dotResponse.status).toBe(404);
    });

    it("handles paths with parentheses", async () => {
      const mock = schmock();
      mock("GET /api/(v1)/users", "versioned");

      const response = await mock.handle("GET", "/api/(v1)/users");

      expect(response.body).toBe("versioned");
    });

    it("handles paths with square brackets", async () => {
      const mock = schmock();
      mock("GET /api/[admin]/users", "admin-users");

      const response = await mock.handle("GET", "/api/[admin]/users");

      expect(response.body).toBe("admin-users");
    });
  });
});
