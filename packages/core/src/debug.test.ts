import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      const mock = schmock({ debug: true });
      mock("GET /test", () => ({ data: "test" }));

      await mock.handle("GET", "/test");

      const logMessages = consoleLogs.map((args) => args.join(" "));
      expect(
        logMessages.some((msg) => msg.includes("Debug mode enabled")),
      ).toBe(true);
      expect(logMessages.some((msg) => msg.includes("[SCHMOCK:REQUEST]"))).toBe(
        true,
      );
    });

    it("does not log when debug mode is disabled", async () => {
      const mock = schmock({ debug: false });
      mock("GET /test", () => ({ data: "test" }));

      await mock.handle("GET", "/test");

      expect(consoleLogs).toHaveLength(0);
    });

    it("defaults to no logging when debug is not configured", async () => {
      const mock = schmock();
      mock("GET /test", () => ({ data: "test" }));

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

      const mock = schmock({ debug: true });
      mock.pipe(plugin);

      const logMessages = consoleLogs.map((args) => args.join(" "));
      expect(
        logMessages.some((msg) =>
          msg.includes("Registered plugin: test-plugin@1.0.0"),
        ),
      ).toBe(true);
    });

    it("logs plugin execution during request handling", async () => {
      const plugin = {
        name: "logging-test",
        version: "1.0.0",
        process: (ctx: any, response: any) => ({
          context: ctx,
          response: response || { data: "generated" },
        }),
      };

      const mock = schmock({ debug: true });
      mock.pipe(plugin);
      mock("GET /test", undefined);

      await mock.handle("GET", "/test");

      const logMessages = consoleLogs.map((args) => args.join(" "));
      expect(
        logMessages.some((msg) =>
          msg.includes("Processing plugin: logging-test"),
        ),
      ).toBe(true);
      expect(
        logMessages.some((msg) =>
          msg.includes("Plugin logging-test generated response"),
        ),
      ).toBe(true);
    });

    it("logs response status and timing", async () => {
      const mock = schmock({ debug: true });
      mock("GET /test", () => [201, { created: true }]);

      await mock.handle("GET", "/test");

      const logMessages = consoleLogs.map((args) => args.join(" "));
      expect(
        logMessages.some((msg) => msg.includes("Sending response 201")),
      ).toBe(true);

      expect(console.time).toHaveBeenCalledWith(
        expect.stringMatching(/\[SCHMOCK\] request-/),
      );
      expect(console.timeEnd).toHaveBeenCalledWith(
        expect.stringMatching(/\[SCHMOCK\] request-/),
      );
    });

    it("logs route matching information", async () => {
      const mock = schmock({ debug: true });
      mock("GET /users/:id", ({ params }) => ({ userId: params.id }));

      await mock.handle("GET", "/users/123");

      const logMessages = consoleLogs.map((args) => args.join(" "));
      expect(
        logMessages.some(
          (msg) =>
            msg.includes("Matched route:") || msg.includes("GET /users/123"),
        ),
      ).toBe(true);
    });

    it("logs 404 errors with debug enabled", async () => {
      const mock = schmock({ debug: true });
      mock("GET /exists", () => "OK");

      await mock.handle("GET", "/missing");

      const logMessages = consoleLogs.map((args) => args.join(" "));
      expect(
        logMessages.some((msg) =>
          msg.includes("No route found for GET /missing"),
        ),
      ).toBe(true);
    });

    it("logs error details when exceptions occur", async () => {
      const mock = schmock({ debug: true });
      mock("GET /error", () => {
        throw new Error("Test error");
      });

      await mock.handle("GET", "/error");

      const logMessages = consoleLogs.map((args) => args.join(" "));
      expect(
        logMessages.some((msg) =>
          msg.includes("Error processing request: Test error"),
        ),
      ).toBe(true);
    });

    it("includes request details in debug logs", async () => {
      const mock = schmock({ debug: true });
      mock("POST /data", ({ body }) => body);

      await mock.handle("POST", "/data", {
        headers: { "content-type": "application/json" },
        body: { test: "data" },
        query: { filter: "active" },
      });

      const logMessages = consoleLogs.map((args) => args.join(" "));
      const requestLog = logMessages.find((msg) => msg.includes("POST /data"));
      expect(requestLog).toBeDefined();
    });
  });

  describe("performance timing", () => {
    it("times the overall request processing", async () => {
      const mock = schmock({ debug: true });
      mock("GET /test", () => "OK");

      await mock.handle("GET", "/test");

      expect(console.time).toHaveBeenCalledWith(
        expect.stringMatching(/\[SCHMOCK\] request-/),
      );
      expect(console.timeEnd).toHaveBeenCalledWith(
        expect.stringMatching(/\[SCHMOCK\] request-/),
      );
    });

    it("times the request processing", async () => {
      const mock = schmock({ debug: true });
      mock("GET /test", () => "OK");

      await mock.handle("GET", "/test");

      expect(console.time).toHaveBeenCalledWith(
        expect.stringMatching(/\[SCHMOCK\] request-/),
      );
      expect(console.timeEnd).toHaveBeenCalledWith(
        expect.stringMatching(/\[SCHMOCK\] request-/),
      );
    });
  });

  describe("credential redaction", () => {
    function serializedLogs(): string {
      return consoleLogs
        .map((args) =>
          args
            .map((arg: unknown) => JSON.stringify(arg) ?? String(arg))
            .join(" "),
        )
        .join("\n");
    }

    it("redacts credential request headers while keeping the header name", async () => {
      const mock = schmock({ debug: true });
      mock("GET /secure", () => "ok");

      await mock.handle("GET", "/secure", {
        headers: {
          Authorization: "Bearer SUPER-SECRET-TOKEN",
          cookie: "session=abc123",
          "X-API-Key": "KEY-42",
          "x-schmock-admin-token": "ADMIN-TOKEN",
          "content-type": "application/json",
        },
      });

      const logs = serializedLogs();
      expect(logs).not.toContain("SUPER-SECRET-TOKEN");
      expect(logs).not.toContain("session=abc123");
      expect(logs).not.toContain("KEY-42");
      expect(logs).not.toContain("ADMIN-TOKEN");
      expect(logs).toContain("Authorization");
      expect(logs).toContain("[redacted]");
      expect(logs).toContain("application/json");
    });

    it("redacts credential response headers", async () => {
      const mock = schmock({ debug: true });
      mock("GET /login", () => [
        200,
        "ok",
        { "set-cookie": "session=SECRET-SESSION" },
      ]);

      await mock.handle("GET", "/login");

      const logs = serializedLogs();
      expect(logs).not.toContain("SECRET-SESSION");
      expect(logs).toContain("set-cookie");
      expect(logs).toContain("[redacted]");
    });

    it("does not mutate the headers handed to generators and history", async () => {
      const mock = schmock({ debug: true });
      let seen: Record<string, string> = {};
      mock("GET /secure", ({ headers }) => {
        seen = headers;
        return "ok";
      });

      await mock.handle("GET", "/secure", {
        headers: { authorization: "Bearer KEEP-ME" },
      });

      expect(seen.authorization).toBe("Bearer KEEP-ME");
      expect(mock.lastRequest()?.headers.authorization).toBe("Bearer KEEP-ME");
    });

    it("reports the real type of falsy request bodies", async () => {
      const mock = schmock({ debug: true });
      mock("POST /echo", () => "ok");

      for (const body of ["", 0, false]) {
        consoleLogs = [];
        await mock.handle("POST", "/echo", { body });
        const requestLog = consoleLogs.find((args) =>
          String(args[0]).includes("[SCHMOCK:REQUEST]"),
        );
        expect(requestLog?.[1]).toMatchObject({ bodyType: typeof body });
      }

      consoleLogs = [];
      await mock.handle("POST", "/echo");
      const missingLog = consoleLogs.find((args) =>
        String(args[0]).includes("[SCHMOCK:REQUEST]"),
      );
      expect(missingLog?.[1]).toMatchObject({ bodyType: "none" });
    });
  });

  describe("debug configuration inheritance", () => {
    it("preserves debug setting through chained calls", () => {
      // Create mock with debug enabled, then configure namespace
      const mock = schmock({ debug: true, namespace: "/api" });
      mock("GET /test", () => "OK");

      expect(
        consoleLogs.some((args) =>
          args.join(" ").includes("Debug mode enabled"),
        ),
      ).toBe(true);
    });

    it("can disable debug mode with subsequent config", async () => {
      const mock = schmock({ debug: false });
      mock("GET /test", () => "OK");

      // Clear logs from build phase
      consoleLogs = [];

      await mock.handle("GET", "/test");

      expect(consoleLogs).toHaveLength(0);
    });
  });
});
