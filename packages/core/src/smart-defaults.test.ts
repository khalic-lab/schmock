import { describe, expect, it } from "vitest";
import { schmock } from "./index";

describe("smart content-type defaults", () => {
  describe("primitive values", () => {
    it("converts numbers to strings with text/plain", async () => {
      const mock = schmock();
      mock("GET /number", 42);

      const response = await mock.handle("GET", "/number");

      expect(response.status).toBe(200);
      expect(response.body).toBe("42");
      expect(response.headers["content-type"]).toBe("text/plain");
    });

    it("converts booleans to strings with text/plain", async () => {
      const mock = schmock();
      mock("GET /bool", true);

      const response = await mock.handle("GET", "/bool");

      expect(response.status).toBe(200);
      expect(response.body).toBe("true");
      expect(response.headers["content-type"]).toBe("text/plain");
    });

    it("handles strings as text/plain", async () => {
      const mock = schmock();
      mock("GET /string", "Hello World");

      const response = await mock.handle("GET", "/string");

      expect(response.status).toBe(200);
      expect(response.body).toBe("Hello World");
      expect(response.headers["content-type"]).toBe("text/plain");
    });

    it("handles empty string as text/plain", async () => {
      const mock = schmock();
      mock("GET /empty", "");

      const response = await mock.handle("GET", "/empty");

      expect(response.status).toBe(200);
      expect(response.body).toBe("");
      expect(response.headers["content-type"]).toBe("text/plain");
    });
  });

  describe("objects and arrays", () => {
    it("handles objects as application/json", async () => {
      const mock = schmock();
      mock("GET /object", { id: 1, name: "John" });

      const response = await mock.handle("GET", "/object");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ id: 1, name: "John" });
      expect(response.headers["content-type"]).toBe("application/json");
    });

    it("handles arrays as application/json", async () => {
      const mock = schmock();
      mock("GET /array", ["one", "two", "three"]);

      const response = await mock.handle("GET", "/array");

      expect(response.status).toBe(200);
      expect(response.body).toEqual(["one", "two", "three"]);
      expect(response.headers["content-type"]).toBe("application/json");
    });

    it("handles empty arrays as application/json", async () => {
      const mock = schmock();
      mock("GET /empty-array", []);

      const response = await mock.handle("GET", "/empty-array");

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
      expect(response.headers["content-type"]).toBe("application/json");
    });

    it("handles empty objects as application/json", async () => {
      const mock = schmock();
      mock("GET /empty-object", {});

      const response = await mock.handle("GET", "/empty-object");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
      expect(response.headers["content-type"]).toBe("application/json");
    });
  });

  describe("null and undefined values", () => {
    it("handles null with 204 No Content", async () => {
      const mock = schmock();
      mock("GET /null", null);

      const response = await mock.handle("GET", "/null");

      expect(response.status).toBe(204);
      expect(response.body).toBeUndefined();
      expect(response.headers["content-type"]).toBe("application/json");
    });

    it("handles undefined with 204 No Content", async () => {
      const mock = schmock();
      mock("GET /undefined", undefined);

      const response = await mock.handle("GET", "/undefined");

      expect(response.status).toBe(204);
      expect(response.body).toBeUndefined();
      expect(response.headers["content-type"]).toBe("application/json");
    });
  });

  describe("Buffer responses", () => {
    it("handles Buffers as application/octet-stream", async () => {
      const mock = schmock();
      const buffer = Buffer.from("binary data");
      mock("GET /binary", buffer);

      const response = await mock.handle("GET", "/binary");

      expect(response.status).toBe(200);
      expect(response.body).toBe(buffer);
      expect(response.headers["content-type"]).toBe("application/octet-stream");
    });
  });

  describe("function generators", () => {
    it("function returning string gets application/json by default", async () => {
      const mock = schmock();
      mock("GET /func-string", () => "Hello");

      const response = await mock.handle("GET", "/func-string");

      expect(response.status).toBe(200);
      expect(response.body).toBe("Hello");
      expect(response.headers["content-type"]).toBe("application/json");
    });

    it("function returning number gets application/json by default", async () => {
      const mock = schmock();
      mock("GET /func-number", () => 42);

      const response = await mock.handle("GET", "/func-number");

      expect(response.status).toBe(200);
      expect(response.body).toBe(42);
      expect(response.headers["content-type"]).toBe("application/json");
    });

    it("function returning object gets application/json by default", async () => {
      const mock = schmock();
      mock("GET /func-object", () => ({ id: 1 }));

      const response = await mock.handle("GET", "/func-object");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ id: 1 });
      expect(response.headers["content-type"]).toBe("application/json");
    });

    it("function returning null gets 204 status", async () => {
      const mock = schmock();
      mock("GET /func-null", () => null);

      const response = await mock.handle("GET", "/func-null");

      expect(response.status).toBe(204);
      expect(response.body).toBeUndefined();
      expect(response.headers["content-type"]).toBe("application/json");
    });
  });

  describe("explicit contentType overrides", () => {
    it("overrides object to text/plain and stringifies", async () => {
      const mock = schmock();
      mock("GET /override", { foo: "bar" }, { contentType: "text/plain" });

      const response = await mock.handle("GET", "/override");

      expect(response.status).toBe(200);
      expect(response.body).toBe('{"foo":"bar"}');
      expect(response.headers["content-type"]).toBe("text/plain");
    });

    it("overrides number to text/plain and converts to string", async () => {
      const mock = schmock();
      mock("GET /override-number", 123, { contentType: "text/plain" });

      const response = await mock.handle("GET", "/override-number");

      expect(response.status).toBe(200);
      expect(response.body).toBe("123");
      expect(response.headers["content-type"]).toBe("text/plain");
    });

    it("overrides string to application/json", async () => {
      const mock = schmock();
      mock("GET /override-string", "hello", {
        contentType: "application/json",
      });

      const response = await mock.handle("GET", "/override-string");

      expect(response.status).toBe(200);
      expect(response.body).toBe("hello");
      expect(response.headers["content-type"]).toBe("application/json");
    });

    it("sets custom content-type", async () => {
      const mock = schmock();
      mock("GET /custom", "<h1>Hello</h1>", { contentType: "text/html" });

      const response = await mock.handle("GET", "/custom");

      expect(response.status).toBe(200);
      expect(response.body).toBe("<h1>Hello</h1>");
      expect(response.headers["content-type"]).toBe("text/html");
    });
  });

  describe("tuple responses preserve explicit control", () => {
    it("tuple responses don't get automatic content-type", async () => {
      const mock = schmock();
      mock("GET /tuple", () => [200, { id: 1 }]);

      const response = await mock.handle("GET", "/tuple");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ id: 1 });
      expect(response.headers).toEqual({});
    });

    it("tuple with explicit headers keeps them", async () => {
      const mock = schmock();
      mock("GET /tuple-headers", () => [
        201,
        { created: true },
        { "X-Custom": "value" },
      ]);

      const response = await mock.handle("GET", "/tuple-headers");

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ created: true });
      expect(response.headers).toEqual({ "X-Custom": "value" });
    });

    it("tuple with null body gets 204 status override", async () => {
      const mock = schmock();
      mock("GET /tuple-null", () => [200, null]);

      const response = await mock.handle("GET", "/tuple-null");

      expect(response.status).toBe(204); // 204 overrides 200 for null body
      expect(response.body).toBeUndefined();
      expect(response.headers).toEqual({});
    });

    it("tuple with 204 status and null body", async () => {
      const mock = schmock();
      mock("GET /tuple-204", () => [204, null]);

      const response = await mock.handle("GET", "/tuple-204");

      expect(response.status).toBe(204);
      expect(response.body).toBeUndefined();
      expect(response.headers).toEqual({});
    });
  });

  describe("edge cases", () => {
    it("handles zero as text/plain", async () => {
      const mock = schmock();
      mock("GET /zero", 0);

      const response = await mock.handle("GET", "/zero");

      expect(response.status).toBe(200);
      expect(response.body).toBe("0");
      expect(response.headers["content-type"]).toBe("text/plain");
    });

    it("handles false as text/plain", async () => {
      const mock = schmock();
      mock("GET /false", false);

      const response = await mock.handle("GET", "/false");

      expect(response.status).toBe(200);
      expect(response.body).toBe("false");
      expect(response.headers["content-type"]).toBe("text/plain");
    });

    it("handles nested objects as application/json", async () => {
      const mock = schmock();
      const nested = {
        user: { id: 1, profile: { name: "John", settings: { theme: "dark" } } },
      };
      mock("GET /nested", nested);

      const response = await mock.handle("GET", "/nested");

      expect(response.status).toBe(200);
      expect(response.body).toEqual(nested);
      expect(response.headers["content-type"]).toBe("application/json");
    });

    it("handles arrays with mixed types as application/json", async () => {
      const mock = schmock();
      mock("GET /mixed", ["first", 2, { id: 1 }, ["nested", "array"]]);

      const response = await mock.handle("GET", "/mixed");

      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        "first",
        2,
        { id: 1 },
        ["nested", "array"],
      ]);
      expect(response.headers["content-type"]).toBe("application/json");
    });
  });

  describe("consistency with existing auto-detection", () => {
    it("static string gets text/plain", async () => {
      const mock = schmock();
      mock("GET /static-string", "Hello World");

      const response = await mock.handle("GET", "/static-string");

      expect(response.headers["content-type"]).toBe("text/plain");
    });

    it("static object gets application/json", async () => {
      const mock = schmock();
      mock("GET /static-object", { id: 1 });

      const response = await mock.handle("GET", "/static-object");

      expect(response.headers["content-type"]).toBe("application/json");
    });

    it("function generator gets application/json by default", async () => {
      const mock = schmock();
      mock("GET /func", () => "anything");

      const response = await mock.handle("GET", "/func");

      expect(response.headers["content-type"]).toBe("application/json");
    });
  });
});
