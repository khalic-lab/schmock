import { describe, expect, it, vi } from "vitest";
import { schmock } from "./index";

describe("plugin system", () => {
  describe("plugin registration", () => {
    it("registers plugins in order", async () => {
      const mock = schmock();
      const executionOrder: string[] = [];

      const plugin1 = {
        name: "first",
        process: (ctx: any, res: any) => {
          executionOrder.push("first");
          return { context: ctx, response: res };
        },
      };

      const plugin2 = {
        name: "second",
        process: (ctx: any, res: any) => {
          executionOrder.push("second");
          return { context: ctx, response: res };
        },
      };

      mock("GET /test", "response").pipe(plugin1).pipe(plugin2);

      await mock.handle("GET", "/test");
      expect(executionOrder).toEqual(["first", "second"]);
    });

    it("stores plugin metadata", async () => {
      const mock = schmock({ debug: true });
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const plugin = {
        name: "test-plugin",
        version: "1.2.3",
        process: (ctx: any, res: any) => ({ context: ctx, response: res }),
      };

      mock.pipe(plugin);

      // Check actual console calls - should have at least plugin registration
      expect(consoleSpy).toHaveBeenCalled();

      // Check that plugin registration was logged
      const pluginCall = consoleSpy.mock.calls.find((call) =>
        call[0].includes("[SCHMOCK:PLUGIN]"),
      );

      expect(pluginCall).toBeDefined();
      expect(pluginCall[0]).toContain("Registered plugin: test-plugin@1.2.3");
      expect(pluginCall[1]).toMatchObject({
        name: "test-plugin",
        version: "1.2.3",
        hasProcess: true,
        hasOnError: false,
      });

      consoleSpy.mockRestore();
    });

    it("handles plugins without version", async () => {
      const mock = schmock({ debug: true });
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const plugin = {
        name: "no-version",
        process: (ctx: any, res: any) => ({ context: ctx, response: res }),
      };

      mock.pipe(plugin);

      // Check that plugin without version was logged
      const pluginCall = consoleSpy.mock.calls.find(
        (call) =>
          call[0].includes("[SCHMOCK:PLUGIN]") &&
          call[0].includes("no-version@unknown"),
      );

      expect(pluginCall).toBeDefined();

      consoleSpy.mockRestore();
    });
  });

  describe("plugin execution pipeline", () => {
    it("runs request guards before the route generator", async () => {
      const mock = schmock();
      const generator = vi.fn(() => ({ created: true }));
      const guard: Schmock.Plugin = {
        name: "guard",
        beforeRequest(context) {
          return {
            context,
            response: [401, { code: "AUTH_REQUIRED" }],
          };
        },
        process: (context, currentResponse) => ({
          context,
          response: currentResponse,
        }),
      };

      mock("POST /guarded", generator).pipe(guard);

      const response = await mock.handle("POST", "/guarded");
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ code: "AUTH_REQUIRED" });
      expect(generator).not.toHaveBeenCalled();
    });

    it("passes pre-request context changes into the generator", async () => {
      const mock = schmock();
      const plugin: Schmock.Plugin = {
        name: "request-transformer",
        beforeRequest(context) {
          return {
            context: {
              ...context,
              headers: { ...context.headers, "x-added": "yes" },
            },
          };
        },
        process: (context, currentResponse) => ({
          context,
          response: currentResponse,
        }),
      };

      mock("GET /context", ({ headers }) => ({
        added: headers["x-added"],
      })).pipe(plugin);

      const response = await mock.handle("GET", "/context");
      expect(response.body).toEqual({ added: "yes" });
    });

    it("passes context between plugins", async () => {
      const mock = schmock();
      let receivedContext: any;

      const plugin1 = {
        name: "setter",
        process: (ctx: any, res: any) => {
          ctx.state.set("modified", "plugin1");
          return { context: ctx, response: res };
        },
      };

      const plugin2 = {
        name: "getter",
        process: (ctx: any, res: any) => {
          receivedContext = ctx;
          return { context: ctx, response: res };
        },
      };

      mock("GET /test", "original").pipe(plugin1).pipe(plugin2);

      await mock.handle("GET", "/test");
      expect(receivedContext.state.get("modified")).toBe("plugin1");
    });

    it("allows first plugin to generate response", async () => {
      const mock = schmock();

      const plugin = {
        name: "generator",
        process: (ctx: any, _res: any) => {
          return { context: ctx, response: "plugin-generated" };
        },
      };

      mock("GET /test", null).pipe(plugin);

      const response = await mock.handle("GET", "/test");
      expect(response.body).toBe("plugin-generated");
    });

    it("allows later plugins to transform response", async () => {
      const mock = schmock();

      const plugin1 = {
        name: "generator",
        process: (ctx: any, res: any) => {
          return { context: ctx, response: res || "initial" };
        },
      };

      const plugin2 = {
        name: "transformer",
        process: (ctx: any, res: any) => {
          return { context: ctx, response: `transformed-${res}` };
        },
      };

      mock("GET /test", "original").pipe(plugin1).pipe(plugin2);

      const response = await mock.handle("GET", "/test");
      expect(response.body).toBe("transformed-original");
    });

    it("preserves response if plugin doesn't modify it", async () => {
      const mock = schmock();

      const plugin = {
        name: "passthrough",
        process: (ctx: any, res: any) => {
          ctx.state.set("processed", true);
          return { context: ctx, response: res };
        },
      };

      mock("GET /test", "unchanged").pipe(plugin);

      const response = await mock.handle("GET", "/test");
      expect(response.body).toBe("unchanged");
    });
  });

  describe("plugin context", () => {
    it("provides complete plugin context", async () => {
      const mock = schmock();
      let pluginContext: any;

      const plugin = {
        name: "inspector",
        process: (ctx: any, res: any) => {
          pluginContext = ctx;
          return { context: ctx, response: res };
        },
      };

      mock("GET /users/:id", "response").pipe(plugin);

      await mock.handle("GET", "/users/123", {
        query: { limit: "10" },
        headers: { authorization: "Bearer token" },
        body: { test: "data" },
      });

      expect(pluginContext).toMatchObject({
        path: "/users/123",
        method: "GET",
        params: { id: "123" },
        query: { limit: "10" },
        headers: { authorization: "Bearer token" },
        body: { test: "data" },
      });
      expect(pluginContext.state).toBeInstanceOf(Map);
      expect(pluginContext.route).toBeDefined();
    });

    it("provides route configuration in context", async () => {
      const mock = schmock();
      let routeConfig: any;

      const plugin = {
        name: "config-reader",
        process: (ctx: any, res: any) => {
          routeConfig = ctx.route;
          return { context: ctx, response: res };
        },
      };

      mock("GET /test", "response", {
        contentType: "text/plain",
        custom: "value",
      }).pipe(plugin);

      await mock.handle("GET", "/test");

      expect(routeConfig).toMatchObject({
        contentType: "text/plain",
        custom: "value",
      });
    });

    it("isolates state between requests", async () => {
      const mock = schmock();
      const states: any[] = [];

      const plugin = {
        name: "state-tracker",
        process: (ctx: any, res: any) => {
          ctx.state.set("requestId", Math.random());
          states.push(ctx.state.get("requestId"));
          return { context: ctx, response: res };
        },
      };

      mock("GET /test", "response").pipe(plugin);

      await mock.handle("GET", "/test");
      await mock.handle("GET", "/test");

      expect(states).toHaveLength(2);
      expect(states[0]).not.toBe(states[1]);
    });
  });

  describe("plugin error handling", () => {
    it("allows a downstream error handler to recover an earlier failure", async () => {
      const mock = schmock();
      const failingPlugin: Schmock.Plugin = {
        name: "failing",
        process() {
          throw new Error("failed");
        },
      };
      const recoveryPlugin: Schmock.Plugin = {
        name: "recovery",
        process: (context, currentResponse) => ({
          context,
          response: currentResponse,
        }),
        onError: () => [503, { code: "RECOVERED" }],
      };

      mock("GET /recover", "original").pipe(failingPlugin).pipe(recoveryPlugin);

      const response = await mock.handle("GET", "/recover");
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ code: "RECOVERED" });
    });

    it("allows a plugin error handler to recover a generator failure", async () => {
      const mock = schmock();
      const recoveryPlugin: Schmock.Plugin = {
        name: "generator-recovery",
        process: (context, currentResponse) => ({
          context,
          response: currentResponse,
        }),
        onError: () => [502, { code: "GENERATOR_RECOVERED" }],
      };

      mock("GET /generator-failure", () => {
        throw new Error("generator failed");
      }).pipe(recoveryPlugin);

      const response = await mock.handle("GET", "/generator-failure");
      expect(response.status).toBe(502);
      expect(response.body).toEqual({ code: "GENERATOR_RECOVERED" });
    });

    it("throws PluginError when plugin process fails", async () => {
      const mock = schmock();

      const plugin = {
        name: "failing-plugin",
        process: () => {
          throw new Error("Plugin failed");
        },
      };

      mock("GET /test", "response").pipe(plugin);

      const response = await mock.handle("GET", "/test");
      expect(response.status).toBe(500);
      expect(response.body.error).toContain('Plugin "failing-plugin" failed');
      expect(response.body.code).toBe("PLUGIN_ERROR");
    });

    it("calls onError hook when plugin fails", async () => {
      const mock = schmock();
      const onErrorSpy = vi.fn();

      const plugin = {
        name: "recoverable-plugin",
        process: () => {
          throw new Error("Initial failure");
        },
        onError: (error: Error, ctx: any) => {
          onErrorSpy(error, ctx);
          return { status: 200, body: "recovered", headers: {} };
        },
      };

      mock("GET /test", "response").pipe(plugin);

      const response = await mock.handle("GET", "/test");

      expect(onErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Initial failure" }),
        expect.any(Object),
      );
      expect(response.status).toBe(200);
      expect(response.body).toBe("recovered");
    });

    it("continues with error propagation if onError doesn't return response", async () => {
      const mock = schmock();

      const plugin = {
        name: "non-recovering-plugin",
        process: () => {
          throw new Error("Plugin failed");
        },
        onError: (_error: Error, _ctx: any) => {
          // Just log, don't return response
          return undefined;
        },
      };

      mock("GET /test", "response").pipe(plugin);

      const response = await mock.handle("GET", "/test");
      expect(response.status).toBe(500);
      expect(response.body.code).toBe("PLUGIN_ERROR");
    });

    it("handles onError hook failures", async () => {
      const mock = schmock({ debug: true });
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const plugin = {
        name: "broken-error-handler",
        process: () => {
          throw new Error("Initial failure");
        },
        onError: () => {
          throw new Error("Error handler failed");
        },
      };

      mock("GET /test", "response").pipe(plugin);

      const response = await mock.handle("GET", "/test");

      // Check that error handler failure was logged
      const errorCall = consoleSpy.mock.calls.find(
        (call) =>
          call[0].includes("[SCHMOCK:PIPELINE]") &&
          call[0].includes("error handler failed"),
      );

      expect(errorCall).toBeDefined();
      expect(response.status).toBe(500);

      consoleSpy.mockRestore();
    });

    it("validates plugin returns proper result structure", async () => {
      const mock = schmock();

      const plugin = {
        name: "invalid-plugin",
        process: () => {
          return { invalidStructure: true }; // Missing context
        },
      };

      mock("GET /test", "response").pipe(plugin);

      const response = await mock.handle("GET", "/test");
      expect(response.status).toBe(500);
      expect(response.body.error).toContain("didn't return valid result");
    });

    it("handles plugin returning null/undefined", async () => {
      const mock = schmock();

      const plugin = {
        name: "null-plugin",
        process: () => null,
      };

      mock("GET /test", "response").pipe(plugin);

      const response = await mock.handle("GET", "/test");
      expect(response.status).toBe(500);
      expect(response.body.error).toContain("didn't return valid result");
    });
  });

  describe("async plugin support", () => {
    it("handles async plugin process methods", async () => {
      const mock = schmock();

      const plugin = {
        name: "async-plugin",
        process: async (ctx: any, res: any) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { context: ctx, response: `async-${res}` };
        },
      };

      mock("GET /test", "response").pipe(plugin);

      const response = await mock.handle("GET", "/test");
      expect(response.body).toBe("async-response");
    });

    it("handles async onError hooks", async () => {
      const mock = schmock();

      const plugin = {
        name: "async-error-plugin",
        process: () => {
          throw new Error("Async failure");
        },
        onError: async (_error: Error, _ctx: any) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { status: 200, body: "async-recovered", headers: {} };
        },
      };

      mock("GET /test", "response").pipe(plugin);

      const response = await mock.handle("GET", "/test");
      expect(response.body).toBe("async-recovered");
    });

    it("preserves cancellation when a plugin replaces its context", async () => {
      const mock = schmock();
      let announceProcessStart = () => {};
      let releaseProcess = () => {};
      const processStarted = new Promise<void>((resolve) => {
        announceProcessStart = resolve;
      });
      const processBarrier = new Promise<void>((resolve) => {
        releaseProcess = resolve;
      });
      mock("GET /replace-context", "response").pipe({
        name: "context-replacer",
        beforeRequest(context) {
          const { signal: _signal, ...replacement } = context;
          return { context: replacement };
        },
        async process(context, response) {
          announceProcessStart();
          await processBarrier;
          return { context, response };
        },
      });
      const controller = new AbortController();

      try {
        const pending = mock.handle("GET", "/replace-context", {
          signal: controller.signal,
        });
        await processStarted;
        controller.abort();

        await expect(
          Promise.race([
            pending,
            new Promise<Schmock.Response>((_, reject) => {
              setTimeout(() => reject(new Error("abort timed out")), 100);
            }),
          ]),
        ).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        releaseProcess();
      }
    });
  });

  describe("plugin install hook", () => {
    it("calls install with a scoped callable instance", () => {
      const mock = schmock();
      let receivedInstance: Schmock.CallableMockInstance | undefined;

      const plugin: Schmock.Plugin = {
        name: "install-test",
        install(instance) {
          receivedInstance = instance;
        },
        process: (ctx: any, res: any) => ({ context: ctx, response: res }),
      };

      mock.pipe(plugin);
      expect(receivedInstance).toBeDefined();
      expect(receivedInstance).not.toBe(mock);
      expect(typeof receivedInstance).toBe("function");
      if (!receivedInstance) throw new Error("Expected an install instance");
      expect(() => receivedInstance("GET /late", "late")).toThrowError(
        expect.objectContaining({ code: "PLUGIN_INSTALL_SCOPE_EXPIRED" }),
      );
    });

    it("rolls back every route when synchronous installation fails", () => {
      const mock = schmock();
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      expect(() =>
        mock.pipe({
          name: "partially-failing-install",
          install(instance) {
            instance("GET /staged", "staged");
            instance("GET /invalid", circular, {
              contentType: "application/json",
            });
          },
          process: (context, response) => ({ context, response }),
        }),
      ).toThrow();

      expect(mock.getRoutes()).toEqual([]);
    });

    it("rolls back routes and expires the facade for async installation", async () => {
      const mock = schmock();
      let capturedInstance: Schmock.CallableMockInstance | undefined;

      expect(() =>
        mock.pipe({
          name: "async-route-install",
          async install(instance) {
            capturedInstance = instance;
            instance("GET /before-await", "before");
            await Promise.resolve();
            instance("GET /after-await", "after");
          },
          process: (context, response) => ({ context, response }),
        }),
      ).toThrowError(
        expect.objectContaining({ code: "PLUGIN_ASYNC_INSTALL_UNSUPPORTED" }),
      );

      await Promise.resolve();
      expect(mock.getRoutes()).toEqual([]);
      if (!capturedInstance) throw new Error("Expected an install instance");
      expect(() => capturedInstance("GET /later", "later")).toThrowError(
        expect.objectContaining({ code: "PLUGIN_INSTALL_SCOPE_EXPIRED" }),
      );
    });

    it("does not expose live mutating methods through the install facade", async () => {
      const mock = schmock();
      let childProcessCount = 0;
      const child: Schmock.Plugin = {
        name: "child",
        process(context, response) {
          childProcessCount += 1;
          return { context, response };
        },
      };

      expect(() =>
        mock.pipe({
          name: "nested-install",
          install(instance) {
            instance.pipe(child);
          },
          process: (context, response) => ({ context, response }),
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "PLUGIN_INSTALL_OPERATION_UNSUPPORTED",
        }),
      );

      expect(() =>
        mock.pipe({
          name: "async-nested-install",
          async install(instance) {
            await Promise.resolve();
            instance.pipe(child);
          },
          process: (context, response) => ({ context, response }),
        }),
      ).toThrowError(
        expect.objectContaining({ code: "PLUGIN_ASYNC_INSTALL_UNSUPPORTED" }),
      );
      await Promise.resolve();

      mock("GET /test", "ok");
      await mock.handle("GET", "/test");
      expect(childProcessCount).toBe(0);
    });

    it("works normally when plugin has no install method", async () => {
      const mock = schmock();

      const plugin: Schmock.Plugin = {
        name: "no-install",
        process: (ctx: any, res: any) => ({ context: ctx, response: res }),
      };

      mock("GET /test", "hello").pipe(plugin);
      const response = await mock.handle("GET", "/test");
      expect(response.body).toBe("hello");
    });

    it("allows install to register routes on the instance", async () => {
      const mock = schmock();

      const plugin: Schmock.Plugin = {
        name: "route-installer",
        install(instance) {
          instance("GET /installed", { message: "from-install" });
        },
        process: (ctx: any, res: any) => ({ context: ctx, response: res }),
      };

      mock.pipe(plugin);

      const response = await mock.handle("GET", "/installed");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: "from-install" });
    });

    it("allows install to register multiple routes", async () => {
      const mock = schmock();

      const plugin: Schmock.Plugin = {
        name: "multi-route-installer",
        install(instance) {
          instance("GET /a", "route-a");
          instance("POST /b", "route-b");
        },
        process: (ctx: any, res: any) => ({ context: ctx, response: res }),
      };

      mock.pipe(plugin);

      const responseA = await mock.handle("GET", "/a");
      expect(responseA.body).toBe("route-a");

      const responseB = await mock.handle("POST", "/b");
      expect(responseB.body).toBe("route-b");
    });

    it("routes registered in install work with generator functions", async () => {
      const mock = schmock();

      const plugin: Schmock.Plugin = {
        name: "generator-installer",
        install(instance) {
          instance("GET /items/:id", (ctx) => ({
            id: ctx.params.id,
            name: "test",
          }));
        },
        process: (ctx: any, res: any) => ({ context: ctx, response: res }),
      };

      mock.pipe(plugin);

      const response = await mock.handle("GET", "/items/42");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ id: "42", name: "test" });
    });

    it("defers uninstall until every admitted request settles", async () => {
      const mock = schmock();
      const releases: Array<() => void> = [];
      const barriers = [
        new Promise<void>((resolve) => releases.push(resolve)),
        new Promise<void>((resolve) => releases.push(resolve)),
      ];
      let enteredCount = 0;
      let announceBothEntered = () => {};
      const bothEntered = new Promise<void>((resolve) => {
        announceBothEntered = resolve;
      });
      const uninstall = vi.fn();

      mock("GET /paused", { ok: true }).pipe({
        name: "leased-plugin",
        async beforeRequest(context) {
          const requestIndex = enteredCount;
          enteredCount += 1;
          if (enteredCount === 2) announceBothEntered();
          await barriers[requestIndex];
          return { context };
        },
        process: (context, response) => ({ context, response }),
        uninstall,
      });

      const first = mock.handle("GET", "/paused");
      const second = mock.handle("GET", "/paused");
      await bothEntered;
      mock.reset();
      expect(uninstall).not.toHaveBeenCalled();

      releases[0]();
      await first;
      expect(uninstall).not.toHaveBeenCalled();

      releases[1]();
      await second;
      expect(uninstall).toHaveBeenCalledOnce();
    });
  });

  describe("debug logging", () => {
    it("logs plugin pipeline execution with debug enabled", async () => {
      const mock = schmock({ debug: true });
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const plugin = {
        name: "logged-plugin",
        process: (ctx: any, res: any) => ({ context: ctx, response: res }),
      };

      mock("GET /test", "response").pipe(plugin);

      await mock.handle("GET", "/test");

      // Check that pipeline execution was logged
      const pipelineCall = consoleSpy.mock.calls.find(
        (call) =>
          call[0].includes("[SCHMOCK:PIPELINE]") &&
          call[0].includes("Running plugin pipeline for 1 plugins"),
      );
      const processingCall = consoleSpy.mock.calls.find(
        (call) =>
          call[0].includes("[SCHMOCK:PIPELINE]") &&
          call[0].includes("Processing plugin: logged-plugin"),
      );

      expect(pipelineCall).toBeDefined();
      expect(processingCall).toBeDefined();

      consoleSpy.mockRestore();
    });

    it("logs plugin response generation", async () => {
      const mock = schmock({ debug: true });
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const plugin = {
        name: "generator-plugin",
        process: (ctx: any, _res: any) => ({
          context: ctx,
          response: "generated",
        }),
      };

      mock("GET /test", null).pipe(plugin);

      await mock.handle("GET", "/test");

      // Check that plugin response generation was logged
      const generatedCall = consoleSpy.mock.calls.find(
        (call) =>
          call[0].includes("[SCHMOCK:PIPELINE]") &&
          call[0].includes("Plugin generator-plugin generated response"),
      );

      expect(generatedCall).toBeDefined();

      consoleSpy.mockRestore();
    });

    it("logs plugin response transformation", async () => {
      const mock = schmock({ debug: true });
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const plugin = {
        name: "transformer-plugin",
        process: (ctx: any, res: any) => ({
          context: ctx,
          response: `transformed-${res}`,
        }),
      };

      mock("GET /test", "original").pipe(plugin);

      await mock.handle("GET", "/test");

      // Check that plugin response transformation was logged
      const transformedCall = consoleSpy.mock.calls.find(
        (call) =>
          call[0].includes("[SCHMOCK:PIPELINE]") &&
          call[0].includes("Plugin transformer-plugin transformed response"),
      );

      expect(transformedCall).toBeDefined();

      consoleSpy.mockRestore();
    });
  });
});
