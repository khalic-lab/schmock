import { describe, expect, it } from "vitest";
import { schmock } from "./index";

describe("response parsing", () => {
  describe("tuple response formats", () => {
    it("handles status-only tuple [status]", async () => {
      const mock = schmock();
      mock("GET /status-only", () => [204] as [number]);

      const response = await mock.handle("GET", "/status-only");

      expect(response.status).toBe(204);
      expect(response.body).toBeUndefined();
      expect(response.headers).toEqual({});
    });

    it("handles [status, body] tuple", async () => {
      const mock = schmock();
      mock("POST /create", () => [201, { id: 123, created: true }]);

      const response = await mock.handle("POST", "/create");

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ id: 123, created: true });
      expect(response.headers).toEqual({});
    });

    it("handles [status, body, headers] tuple", async () => {
      const mock = schmock();
      mock(
        "POST /upload",
        () =>
          [
            201,
            { fileId: "abc123" },
            {
              Location: "/files/abc123",
              "Content-Type": "application/json",
            },
          ] as [number, any, Record<string, string>],
      );

      const response = await mock.handle("POST", "/upload");

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ fileId: "abc123" });
      expect(response.headers).toEqual({
        Location: "/files/abc123",
        "Content-Type": "application/json",
      });
    });

    it("handles empty headers object in tuple", async () => {
      const mock = schmock();
      mock("GET /test", () => [200, "OK", {}]);

      const response = await mock.handle("GET", "/test");

      expect(response.status).toBe(200);
      expect(response.body).toBe("OK");
      expect(response.headers).toEqual({});
    });

    it("ignores extra tuple elements beyond [status, body, headers]", async () => {
      const mock = schmock();
      mock(
        "GET /extra",
        () => [200, "data", {}, "ignored", "also-ignored"] as any,
      );

      const response = await mock.handle("GET", "/extra");

      expect(response.status).toBe(200);
      expect(response.body).toBe("data");
      expect(response.headers).toEqual({});
    });

    it("treats non-numeric first element as body, not status", async () => {
      const mock = schmock();
      mock("GET /array-body", () => ["item1", "item2", "item3"]);

      const response = await mock.handle("GET", "/array-body");

      expect(response.status).toBe(200);
      expect(response.body).toEqual(["item1", "item2", "item3"]);
      expect(response.headers).toEqual({ "content-type": "application/json" });
    });
  });

  describe("various response types", () => {
    it("handles string responses", async () => {
      const mock = schmock();
      mock("GET /text", () => "Simple text response");

      const response = await mock.handle("GET", "/text");

      expect(response.status).toBe(200);
      expect(response.body).toBe("Simple text response");
      expect(response.headers).toEqual({ "content-type": "application/json" });
    });

    it("handles number responses", async () => {
      const mock = schmock();
      mock("GET /number", () => 42);

      const response = await mock.handle("GET", "/number");

      expect(response.status).toBe(200);
      expect(response.body).toBe(42);
      expect(response.headers).toEqual({ "content-type": "application/json" });
    });

    it("handles boolean responses", async () => {
      const mock = schmock();
      mock("GET /bool", () => true);

      const response = await mock.handle("GET", "/bool");

      expect(response.status).toBe(200);
      expect(response.body).toBe(true);
      expect(response.headers).toEqual({ "content-type": "application/json" });
    });

    it("handles null responses", async () => {
      const mock = schmock();
      mock("GET /null", () => null);

      const response = await mock.handle("GET", "/null");

      expect(response.status).toBe(204);
      expect(response.body).toBeUndefined();
      expect(response.headers).toEqual({ "content-type": "application/json" });
    });

    it("handles undefined responses", async () => {
      const mock = schmock();
      mock("GET /undefined", () => undefined);

      const response = await mock.handle("GET", "/undefined");

      expect(response.status).toBe(204);
      expect(response.body).toBeUndefined();
      expect(response.headers).toEqual({ "content-type": "application/json" });
    });

    it("handles complex object responses", async () => {
      const complexObject = {
        data: {
          users: [
            { id: 1, name: "Alice", tags: ["admin", "active"] },
            { id: 2, name: "Bob", meta: { lastLogin: "2023-01-01" } },
          ],
          pagination: {
            page: 1,
            limit: 10,
            total: 2,
          },
        },
        timestamp: new Date("2023-01-01T00:00:00Z"),
      };

      const mock = schmock();
      mock("GET /complex", () => complexObject);

      const response = await mock.handle("GET", "/complex");

      expect(response.status).toBe(200);
      expect(response.body).toEqual(complexObject);
      expect(response.headers).toEqual({ "content-type": "application/json" });
    });

    it("handles empty array responses", async () => {
      const mock = schmock();
      mock("GET /empty-array", () => []);

      const response = await mock.handle("GET", "/empty-array");

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
      expect(response.headers).toEqual({ "content-type": "application/json" });
    });

    it("handles empty object responses", async () => {
      const mock = schmock();
      mock("GET /empty-object", () => ({}));

      const response = await mock.handle("GET", "/empty-object");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
      expect(response.headers).toEqual({ "content-type": "application/json" });
    });
  });

  describe("async response functions", () => {
    it("handles async response functions", async () => {
      const mock = schmock();
      mock("GET /async", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { async: true };
      });

      const response = await mock.handle("GET", "/async");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ async: true });
    });

    it("handles async tuple responses", async () => {
      const mock = schmock();
      mock("POST /async-create", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return [201, { created: true }, { "X-Async": "true" }];
      });

      const response = await mock.handle("POST", "/async-create");

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ created: true });
      expect(response.headers).toEqual({ "X-Async": "true" });
    });
  });

  describe("edge cases", () => {
    it("handles response with circular references gracefully", async () => {
      const mock = schmock();
      mock("GET /circular", () => {
        const obj: any = { name: "test" };
        obj.self = obj; // Create circular reference
        return obj;
      });

      const response = await mock.handle("GET", "/circular");

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("name", "test");
      expect(response.body).toHaveProperty("self");
    });

    it("preserves functions in response objects", async () => {
      const mock = schmock();
      mock("GET /with-functions", () => ({
        data: "test",
        fn: () => "function result",
      }));

      const response = await mock.handle("GET", "/with-functions");

      expect(response.status).toBe(200);
      expect(response.body.data).toBe("test");
      expect(typeof response.body.fn).toBe("function");
      expect(response.body.fn()).toBe("function result");
    });
  });
});
