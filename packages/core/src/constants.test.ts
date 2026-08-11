import { describe, expect, it } from "vitest";
import {
  canonicalizePath,
  HTTP_METHODS,
  isHttpMethod,
  isRouteNotFound,
  ROUTE_NOT_FOUND_CODE,
  toHttpMethod,
  toRouteKey,
} from "./constants";

describe("constants", () => {
  it("exports ROUTE_NOT_FOUND_CODE", () => {
    expect(ROUTE_NOT_FOUND_CODE).toBe("ROUTE_NOT_FOUND");
  });

  it("exports all HTTP methods", () => {
    expect(HTTP_METHODS).toEqual([
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "PATCH",
      "HEAD",
      "OPTIONS",
    ]);
  });
});

describe("isHttpMethod", () => {
  it("returns true for valid HTTP methods", () => {
    for (const method of HTTP_METHODS) {
      expect(isHttpMethod(method)).toBe(true);
    }
  });

  it("returns false for invalid methods", () => {
    expect(isHttpMethod("INVALID")).toBe(false);
    expect(isHttpMethod("")).toBe(false);
    expect(isHttpMethod("get")).toBe(false);
  });
});

describe("toHttpMethod", () => {
  it("converts lowercase to uppercase", () => {
    expect(toHttpMethod("get")).toBe("GET");
    expect(toHttpMethod("post")).toBe("POST");
    expect(toHttpMethod("delete")).toBe("DELETE");
  });

  it("returns already uppercase methods", () => {
    expect(toHttpMethod("GET")).toBe("GET");
    expect(toHttpMethod("PATCH")).toBe("PATCH");
  });

  it("throws for invalid methods", () => {
    expect(() => toHttpMethod("INVALID")).toThrow(
      'Invalid HTTP method: "INVALID"',
    );
    expect(() => toHttpMethod("")).toThrow('Invalid HTTP method: ""');
  });
});

describe("isRouteNotFound", () => {
  it("returns true for a route-not-found response", () => {
    const response = {
      status: 404,
      body: { error: "Route not found", code: ROUTE_NOT_FOUND_CODE },
      headers: {},
    };
    expect(isRouteNotFound(response)).toBe(true);
  });

  it("returns false for a regular 404 response", () => {
    const response = {
      status: 404,
      body: { message: "User not found" },
      headers: {},
    };
    expect(isRouteNotFound(response)).toBe(false);
  });

  it("returns false for a non-404 response", () => {
    const response = {
      status: 200,
      body: { code: ROUTE_NOT_FOUND_CODE },
      headers: {},
    };
    expect(isRouteNotFound(response)).toBe(false);
  });

  it("returns false when body is null", () => {
    const response = { status: 404, body: null, headers: {} };
    expect(isRouteNotFound(response)).toBe(false);
  });

  it("returns false when body is a string", () => {
    const response = { status: 404, body: "not found", headers: {} };
    expect(isRouteNotFound(response)).toBe(false);
  });
});

describe("toRouteKey", () => {
  it("joins a method and an absolute path", () => {
    expect(toRouteKey("GET", "/users/:id")).toBe("GET /users/:id");
  });

  it("adds the leading slash a RouteKey requires", () => {
    expect(toRouteKey("POST", "users")).toBe("POST /users");
  });
});

describe("canonicalizePath", () => {
  const cases: Array<[string, string]> = [
    ["/users", "/users"],
    ["/users/:id", "/users/:id"],
    ["/café", "/caf%C3%A9"],
    ["/caf%C3%A9", "/caf%C3%A9"],
    ["/a b", "/a%20b"],
    ["/a%20b", "/a%20b"],
    ["/a%2Fb", "/a%2Fb"],
    ["/😀", "/%F0%9F%98%80"],
    ["/", "/"],
  ];

  it.each(cases)("canonicalizes %s", (input, expected) => {
    expect(canonicalizePath(input)).toBe(expected);
  });

  it("normalizes valid percent escapes to uppercase", () => {
    expect(canonicalizePath("/caf%c3%a9/%2f")).toBe("/caf%C3%A9/%2F");
  });

  it("agrees with the URL parser on reachable paths", () => {
    for (const [input] of cases) {
      expect(canonicalizePath(input)).toBe(
        new URL(input, "http://x.test").pathname,
      );
    }
  });

  it("is idempotent", () => {
    for (const input of [
      ...cases.map(([value]) => value),
      "/a%zz",
      "/a%",
      "/a?b",
      "/a#b",
      "/a\tb",
      "/..%2f",
      "/%2e%2e",
      "/a\u{1F600}%2Fb",
    ]) {
      const once = canonicalizePath(input);
      expect(canonicalizePath(once)).toBe(once);
    }
  });

  it("leaves a malformed percent sequence alone", () => {
    expect(canonicalizePath("/a%zz")).toBe("/a%zz");
    expect(canonicalizePath("/a%")).toBe("/a%");
  });

  it("never throws on a lone surrogate", () => {
    expect(() => canonicalizePath("/a\uD800b")).not.toThrow();
  });
});
