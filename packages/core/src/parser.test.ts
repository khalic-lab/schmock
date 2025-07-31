import { describe, expect, it } from "vitest";
import { parseRouteKey } from "./parser";

describe("parseRouteKey", () => {
  describe("valid route keys", () => {
    it("parses simple GET route", () => {
      const result = parseRouteKey("GET /users");
      expect(result).toEqual({
        method: "GET",
        path: "/users",
        pattern: expect.any(RegExp),
        params: [],
      });
    });

    it("parses route with single parameter", () => {
      const result = parseRouteKey("GET /users/:id");
      expect(result).toEqual({
        method: "GET",
        path: "/users/:id",
        pattern: expect.any(RegExp),
        params: ["id"],
      });
    });

    it("parses route with multiple parameters", () => {
      const result = parseRouteKey(
        "DELETE /api/posts/:postId/comments/:commentId",
      );
      expect(result).toEqual({
        method: "DELETE",
        path: "/api/posts/:postId/comments/:commentId",
        pattern: expect.any(RegExp),
        params: ["postId", "commentId"],
      });
    });

    it("supports all HTTP methods", () => {
      const methods = [
        "GET",
        "POST",
        "PUT",
        "DELETE",
        "PATCH",
        "HEAD",
        "OPTIONS",
      ] as const;

      for (const method of methods) {
        const result = parseRouteKey(`${method} /test`);
        expect(result.method).toBe(method);
      }
    });

    it("handles paths with namespace", () => {
      const result = parseRouteKey("POST /api/v2/users");
      expect(result).toEqual({
        method: "POST",
        path: "/api/v2/users",
        pattern: expect.any(RegExp),
        params: [],
      });
    });

    it("creates correct regex pattern for simple path", () => {
      const result = parseRouteKey("GET /users");
      expect("/users").toMatch(result.pattern);
      expect("/users/123").not.toMatch(result.pattern);
    });

    it("creates correct regex pattern with parameters", () => {
      const result = parseRouteKey("GET /users/:id");
      expect("/users/123").toMatch(result.pattern);
      expect("/users/abc-def").toMatch(result.pattern);
      expect("/users").not.toMatch(result.pattern);
      expect("/users/").not.toMatch(result.pattern);
      expect("/users/123/posts").not.toMatch(result.pattern);
    });
  });

  describe("invalid route keys", () => {
    it("throws on missing method", () => {
      expect(() => parseRouteKey("/users")).toThrow("Invalid route key format");
    });

    it("throws on missing path", () => {
      expect(() => parseRouteKey("GET")).toThrow("Invalid route key format");
    });

    it("throws on invalid method", () => {
      expect(() => parseRouteKey("INVALID /users")).toThrow(
        "Invalid route key format",
      );
    });

    it("throws on lowercase method", () => {
      expect(() => parseRouteKey("get /users")).toThrow(
        "Invalid route key format",
      );
    });

    it("throws on missing space", () => {
      expect(() => parseRouteKey("GET/users")).toThrow(
        "Invalid route key format",
      );
    });

    it("throws on empty string", () => {
      expect(() => parseRouteKey("")).toThrow("Invalid route key format");
    });
  });

  describe("parameter extraction", () => {
    it("extracts matched parameters", () => {
      const route = parseRouteKey("GET /users/:userId/posts/:postId");
      const match = "/users/123/posts/456".match(route.pattern);

      expect(match).toBeTruthy();
      expect(match?.[1]).toBe("123");
      expect(match?.[2]).toBe("456");
    });

    it("handles special characters in parameters", () => {
      const route = parseRouteKey("GET /files/:filename");
      const match = "/files/report-2023.pdf".match(route.pattern);

      expect(match).toBeTruthy();
      expect(match?.[1]).toBe("report-2023.pdf");
    });
  });
});
