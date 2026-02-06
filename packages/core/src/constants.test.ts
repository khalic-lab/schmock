import { describe, expect, it } from "vitest";
import {
  HTTP_METHODS,
  isHttpMethod,
  ROUTE_NOT_FOUND_CODE,
  toHttpMethod,
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
