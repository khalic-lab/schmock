import { describe, expect, it } from "vitest";
import {
  HttpIngressError,
  parseFormBody,
  parseJsonBody,
  requestBodyKindOf,
} from "./request-body.js";

describe("request body decoding", () => {
  describe("requestBodyKindOf", () => {
    it.each([
      ["application/json", "json"],
      ["Application/JSON; charset=utf-8", "json"],
      ["application/problem+json", "json"],
      ["application/x-www-form-urlencoded", "form"],
      ["text/plain;charset=UTF-8", "text"],
      ["text/csv", "text"],
      ["multipart/form-data; boundary=x", "multipart"],
      ["Multipart/Form-Data", "multipart"],
      ["multipart/mixed; boundary=x", "binary"],
      ['multipart/related; type="application/json"; boundary=x', "binary"],
      ["multipart/form-data-x; boundary=x", "binary"],
      ["multipart/form-datax", "binary"],
      ["application/octet-stream", "binary"],
      ["", "binary"],
      [null, "binary"],
      [undefined, "binary"],
    ] as const)("reads %s as %s", (contentType, kind) => {
      expect(requestBodyKindOf(contentType)).toBe(kind);
    });
  });

  describe("parseJsonBody", () => {
    function refusal(text: string): HttpIngressError {
      try {
        parseJsonBody(text);
      } catch (error) {
        if (error instanceof HttpIngressError) return error;
        throw error;
      }
      throw new Error("Expected an HttpIngressError");
    }

    it("parses a JSON value", () => {
      expect(parseJsonBody('{"a":[1,2]}')).toEqual({ a: [1, 2] });
    });

    it("refuses text that does not parse with MALFORMED_JSON", () => {
      const error = refusal("{broken");
      expect(error.status).toBe(400);
      expect(error.code).toBe("MALFORMED_JSON");
    });

    it("accepts 256 levels of nesting and refuses 257 with JSON_TOO_DEEP", () => {
      expect(
        parseJsonBody(`${"[".repeat(256)}${"]".repeat(256)}`),
      ).toBeInstanceOf(Array);
      const error = refusal(`${"[".repeat(257)}${"]".repeat(257)}`);
      expect(error.status).toBe(400);
      expect(error.code).toBe("JSON_TOO_DEEP");
      expect(error.message).toBe(
        "JSON request body nests deeper than 256 levels",
      );
    });
  });

  it("keeps the last value of a repeated form field", () => {
    expect(parseFormBody("a=1&b=2&a=3")).toEqual({ a: "3", b: "2" });
  });
});
