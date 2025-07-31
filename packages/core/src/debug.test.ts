import { beforeEach, describe, expect, it, vi } from "vitest";
import { schmock } from "./index";

describe("debug functionality", () => {
  const originalConsole = console.log;
  const originalTime = console.time;
  const originalTimeEnd = console.timeEnd;
  let consoleLogs: any[] = [];

  beforeEach(() => {
    consoleLogs = [];
    console.log = vi.fn((...args) => consoleLogs.push(args));
    console.time = vi.fn();
    console.timeEnd = vi.fn();
  });

  afterEach(() => {
    console.log = originalConsole;
    console.time = originalTime;
    console.timeEnd = originalTimeEnd;
  });

  describe("debug logging", () => {
    it("logs debug messages when debug mode is enabled", async () => {
      const mock = schmock()
        .config({ debug: true })
        .routes({
          "GET /test": {
            response: () => ({ data: "test" }),
          },
        })
        .build();

      await mock.handle("GET", "/test");

      const logMessages = consoleLogs.map(args => args.join(' '));
      expect(logMessages.some(msg => msg.includes("[SCHMOCK:CONFIG] Debug mode enabled"))).toBe(true);
      expect(logMessages.some(msg => msg.includes("[SCHMOCK:BUILD] Building Schmock instance"))).toBe(true);
      expect(logMessages.some(msg => msg.includes("[SCHMOCK:REQUEST]"))).toBe(true);
    });

    it("does not log when debug mode is disabled", async () => {
      const mock = schmock()
        .config({ debug: false })
        .routes({
          "GET /test": {
            response: () => ({ data: "test" }),
          },
        })
        .build();

      await mock.handle("GET", "/test");

      expect(consoleLogs).toHaveLength(0);
    });

    it("defaults to no logging when debug is not configured", async () => {
      const mock = schmock()
        .routes({
          "GET /test": {
            response: () => ({ data: "test" }),
          },
        })
        .build();

      await mock.handle("GET", "/test");

      expect(consoleLogs).toHaveLength(0);
    });

    it("logs plugin registration with debug enabled", () => {
      const plugin = {
        name: "test-plugin",
        version: "1.0.0",
        enforce: "pre" as const,
        beforeRequest: () => {},
        generate: () => {},
      };

      schmock()
        .config({ debug: true })
        .use(plugin)
        .build();

      const logMessages = consoleLogs.map(args => args.join(' '));
      expect(logMessages.some(msg => 
        msg.includes("Registered plugin: test-plugin@1.0.0")
      )).toBe(true);
    });

    it("logs plugin execution during request handling", async () => {
      const plugin = {
        name: "logging-test",
        version: "1.0.0",
        beforeRequest: (ctx: any) => ctx,
        generate: () => ({ data: "generated" }),
      };

      const mock = schmock()
        .config({ debug: true })
        .use(plugin)
        .routes({
          "GET /test": {},
        })
        .build();

      await mock.handle("GET", "/test");

      const logMessages = consoleLogs.map(args => args.join(' '));
      expect(logMessages.some(msg => 
        msg.includes("Executing beforeRequest: logging-test")
      )).toBe(true);
      expect(logMessages.some(msg => 
        msg.includes("Executing generate: logging-test")
      )).toBe(true);
    });

    it("logs response status and timing", async () => {
      const mock = schmock()
        .config({ debug: true })
        .routes({
          "GET /test": {
            response: () => [201, { created: true }],
          },
        })
        .build();

      await mock.handle("GET", "/test");

      const logMessages = consoleLogs.map(args => args.join(' '));
      expect(logMessages.some(msg => 
        msg.includes("Sending response 201")
      )).toBe(true);
      
      expect(console.time).toHaveBeenCalledWith(expect.stringMatching(/\[SCHMOCK\] request-/));
      expect(console.timeEnd).toHaveBeenCalledWith(expect.stringMatching(/\[SCHMOCK\] request-/));
    });

    it("logs route matching information", async () => {
      const mock = schmock()
        .config({ debug: true })
        .routes({
          "GET /users/:id": {
            response: ({ params }) => ({ userId: params.id }),
          },
        })
        .build();

      await mock.handle("GET", "/users/123");

      const logMessages = consoleLogs.map(args => args.join(' '));
      expect(logMessages.some(msg => 
        msg.includes("Matched route:") && msg.includes("^")
      )).toBe(true);
    });

    it("logs 404 errors with debug enabled", async () => {
      const mock = schmock()
        .config({ debug: true })
        .routes({
          "GET /exists": {
            response: () => "OK",
          },
        })
        .build();

      await mock.handle("GET", "/missing");

      const logMessages = consoleLogs.map(args => args.join(' '));
      expect(logMessages.some(msg => 
        msg.includes("No route found for GET /missing")
      )).toBe(true);
    });

    it("logs error details when exceptions occur", async () => {
      const mock = schmock()
        .config({ debug: true })
        .routes({
          "GET /error": {
            response: () => {
              throw new Error("Test error");
            },
          },
        })
        .build();

      await mock.handle("GET", "/error");

      const logMessages = consoleLogs.map(args => args.join(' '));
      expect(logMessages.some(msg => 
        msg.includes("Error processing request: Test error")
      )).toBe(true);
    });

    it("includes request details in debug logs", async () => {
      const mock = schmock()
        .config({ debug: true })
        .routes({
          "POST /data": {
            response: ({ body }) => body,
          },
        })
        .build();

      await mock.handle("POST", "/data", {
        headers: { "content-type": "application/json" },
        body: { test: "data" },
        query: { filter: "active" },
      });

      const logMessages = consoleLogs.map(args => args.join(' '));
      const requestLog = logMessages.find(msg => msg.includes("POST /data"));
      expect(requestLog).toBeDefined();
    });
  });

  describe("performance timing", () => {
    it("times the overall request processing", async () => {
      const mock = schmock()
        .config({ debug: true })
        .routes({
          "GET /test": {
            response: () => "OK",
          },
        })
        .build();

      await mock.handle("GET", "/test");

      expect(console.time).toHaveBeenCalledWith(expect.stringMatching(/\[SCHMOCK\] request-/));
      expect(console.timeEnd).toHaveBeenCalledWith(expect.stringMatching(/\[SCHMOCK\] request-/));
    });

    it("times the build process", () => {
      schmock()
        .config({ debug: true })
        .routes({
          "GET /test": {
            response: () => "OK",
          },
        })
        .build();

      expect(console.time).toHaveBeenCalledWith("[SCHMOCK] build");
      expect(console.timeEnd).toHaveBeenCalledWith("[SCHMOCK] build");
    });
  });

  describe("debug configuration inheritance", () => {
    it("preserves debug setting through chained calls", () => {
      const mock = schmock()
        .config({ debug: true })
        .routes({
          "GET /test": { response: () => "OK" },
        })
        .config({ namespace: "/api" }) // Second config call
        .build();

      expect(consoleLogs.some(args => 
        args.join(' ').includes("Debug mode enabled")
      )).toBe(true);
    });

    it("can disable debug mode with subsequent config", async () => {
      const mock = schmock()
        .config({ debug: true })
        .config({ debug: false })
        .routes({
          "GET /test": { response: () => "OK" },
        })
        .build();

      // Clear logs from build phase
      consoleLogs = [];

      await mock.handle("GET", "/test");

      expect(consoleLogs).toHaveLength(0);
    });
  });
});