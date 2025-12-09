import { describe, expect, it } from "vitest";
import { schmock } from "./index";

describe("schmock factory function", () => {
  describe("factory behavior", () => {
    it("creates callable mock instance with no config", () => {
      const mock = schmock();

      expect(typeof mock).toBe("function");
      expect(typeof mock.handle).toBe("function");
      expect(typeof mock.pipe).toBe("function");
    });

    it("creates callable mock instance with config", () => {
      const config = { debug: true, namespace: "/api" };
      const mock = schmock(config);

      expect(typeof mock).toBe("function");
      expect(typeof mock.handle).toBe("function");
      expect(typeof mock.pipe).toBe("function");
    });

    it("supports method chaining from factory call", () => {
      const mock = schmock();
      const result = mock("GET /test", "response");

      expect(result).toBe(mock); // Should return same instance for chaining
    });

    it("supports plugin chaining", () => {
      const mock = schmock();
      const plugin = {
        name: "test",
        process: (ctx: any, res: any) => ({ context: ctx, response: res }),
      };
      const result = mock.pipe(plugin);

      expect(result).toBe(mock); // Should return same instance for chaining
    });
  });

  describe("callable instance behavior", () => {
    it("defines routes when called as function", async () => {
      const mock = schmock();
      mock("GET /test", "hello");

      const response = await mock.handle("GET", "/test");
      expect(response.body).toBe("hello");
    });

    it("allows method chaining after route definition", async () => {
      const mock = schmock();
      const plugin = {
        name: "test",
        process: (ctx: any, res: any) => ({ context: ctx, response: res }),
      };

      mock("GET /test", "hello").pipe(plugin);

      const response = await mock.handle("GET", "/test");
      expect(response.body).toBe("hello");
    });

    it("passes config to route definition", async () => {
      const mock = schmock();
      mock("GET /test", { data: "test" }, { contentType: "text/plain" });

      const response = await mock.handle("GET", "/test");
      expect(response.headers["content-type"]).toBe("text/plain");
      expect(response.body).toBe('{"data":"test"}'); // Stringified because contentType is text/plain
    });
  });

  describe("binding and method preservation", () => {
    it("preserves handle method binding", async () => {
      const mock = schmock();
      mock("GET /test", "response");

      const handleMethod = mock.handle;
      const response = await handleMethod("GET", "/test");

      expect(response.body).toBe("response");
    });

    it("allows destructuring of methods", async () => {
      const mock = schmock();
      mock("GET /test", "response");

      const { handle } = mock;
      const response = await handle("GET", "/test");

      expect(response.body).toBe("response");
    });

    it("pipes maintain chain references", () => {
      const mock = schmock();
      const plugin1 = {
        name: "plugin1",
        process: (ctx: any, res: any) => ({ context: ctx, response: res }),
      };
      const plugin2 = {
        name: "plugin2",
        process: (ctx: any, res: any) => ({ context: ctx, response: res }),
      };

      const chain = mock.pipe(plugin1).pipe(plugin2);

      expect(chain).toBe(mock);
    });
  });

  describe("type compatibility", () => {
    it("works with TypeScript function signature", () => {
      // Test that the factory function matches expected TypeScript types
      const mock = schmock({ debug: false });
      mock("GET /users", () => [{ id: 1 }], {
        contentType: "application/json",
      });

      expect(typeof mock).toBe("function");
    });

    it("handles optional config parameter", () => {
      const mock1 = schmock();
      const mock2 = schmock({});
      const mock3 = schmock({ debug: true });

      expect(typeof mock1).toBe("function");
      expect(typeof mock2).toBe("function");
      expect(typeof mock3).toBe("function");
    });
  });
});
