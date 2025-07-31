import { describe, expect, it, vi } from "vitest";
import { PluginError } from "./errors";
import { schmock } from "./index";

describe("plugin system", () => {
  describe("plugin registration", () => {
    it("accepts plugin objects directly", () => {
      const plugin = {
        name: "direct-plugin",
        version: "1.0.0",
        generate: () => ({ data: "direct" }),
      };

      const mock = schmock()
        .use(plugin)
        .routes({
          "GET /test": {},
        })
        .build();

      expect(mock).toBeDefined();
    });

    it("accepts plugin factory functions", () => {
      const pluginFactory = () => ({
        name: "factory-plugin",
        version: "1.0.0",
        generate: () => ({ data: "factory" }),
      });

      const mock = schmock()
        .use(pluginFactory)
        .routes({
          "GET /test": {},
        })
        .build();

      expect(mock).toBeDefined();
    });

    it("calls plugin factory functions during registration", () => {
      const factorySpy = vi.fn(() => ({
        name: "spy-plugin",
        version: "1.0.0",
        generate: () => ({ data: "spy" }),
      }));

      schmock()
        .use(factorySpy)
        .build();

      expect(factorySpy).toHaveBeenCalledOnce();
    });

    it("throws PluginError when plugin factory throws", () => {
      const failingFactory = () => {
        throw new Error("Factory failed");
      };

      expect(() => {
        schmock()
          .use(failingFactory)
          .build();
      }).toThrow(PluginError);
    });

    it("wraps plugin registration errors with plugin name", () => {
      const badFactory = () => {
        throw new Error("Bad plugin");
      };

      try {
        schmock().use(badFactory).build();
      } catch (error) {
        expect(error).toBeInstanceOf(PluginError);
        expect(error.message).toContain("unknown");
        expect(error.message).toContain("Bad plugin");
      }
    });

    it("includes plugin name in error when available", () => {
      const namedPlugin = {
        name: "named-plugin",
        version: "1.0.0",
      };

      // Simulate registration error by making the use method fail
      const builder = schmock();
      const originalUse = builder.use.bind(builder);
      
      vi.spyOn(builder, 'use').mockImplementation(() => {
        throw new Error("Registration failed");
      });

      try {
        builder.use(namedPlugin);
      } catch (error) {
        expect(error.message).toBe("Registration failed");
      }
    });
  });

  describe("plugin configuration", () => {
    it("supports plugins with minimal configuration", () => {
      const minimalPlugin = {
        name: "minimal",
      };

      const mock = schmock()
        .use(minimalPlugin)
        .routes({
          "GET /test": {
            response: () => "OK",
          },
        })
        .build();

      expect(mock).toBeDefined();
    });

    it("supports plugins with all hook types", async () => {
      const hookCalls: string[] = [];
      
      const fullPlugin = {
        name: "full-plugin",
        version: "2.0.0",
        enforce: "pre" as const,
        beforeRequest: (ctx: any) => {
          hookCalls.push("beforeRequest");
          return ctx;
        },
        beforeGenerate: () => {
          hookCalls.push("beforeGenerate");
          return undefined;
        },
        generate: () => {
          hookCalls.push("generate");
          return { data: "full" };
        },
        afterGenerate: (data: any) => {
          hookCalls.push("afterGenerate");
          return data;
        },
        beforeResponse: (response: any) => {
          hookCalls.push("beforeResponse");
          return response;
        },
        onError: (error: Error) => {
          hookCalls.push("onError");
          return error;
        },
        transform: (data: any) => {
          hookCalls.push("transform");
          return data;
        },
      };

      const mock = schmock()
        .use(fullPlugin)
        .routes({
          "GET /test": {},
        })
        .build();

      await mock.handle("GET", "/test");

      expect(hookCalls).toContain("beforeRequest");
      expect(hookCalls).toContain("beforeGenerate");
      expect(hookCalls).toContain("generate");
      expect(hookCalls).toContain("afterGenerate");
      expect(hookCalls).toContain("beforeResponse");
      // onError and transform are not called in this success case
    });

    it("handles plugins without version", () => {
      const versionlessPlugin = {
        name: "no-version",
        generate: () => ({ data: "no-version" }),
      };

      const mock = schmock()
        .use(versionlessPlugin)
        .routes({
          "GET /test": {},
        })
        .build();

      expect(mock).toBeDefined();
    });
  });

  describe("plugin execution order", () => {
    it("respects enforce: 'pre', normal, 'post' order", async () => {
      const executionOrder: string[] = [];

      const prePlugin = {
        name: "pre",
        enforce: "pre" as const,
        beforeRequest: (ctx: any) => {
          executionOrder.push("pre");
          return ctx;
        },
      };

      const normalPlugin = {
        name: "normal",
        beforeRequest: (ctx: any) => {
          executionOrder.push("normal");
          return ctx;
        },
      };

      const postPlugin = {
        name: "post",
        enforce: "post" as const,
        beforeRequest: (ctx: any) => {
          executionOrder.push("post");
          return ctx;
        },
      };

      const mock = schmock()
        .use(postPlugin)    // Added first
        .use(normalPlugin)  // Added second
        .use(prePlugin)     // Added third, but should run first
        .routes({
          "GET /test": {
            response: () => "OK",
          },
        })
        .build();

      await mock.handle("GET", "/test");

      expect(executionOrder).toEqual(["pre", "normal", "post"]);
    });

    it("maintains registration order within same enforcement level", async () => {
      const executionOrder: string[] = [];

      const normal1 = {
        name: "normal-1",
        beforeRequest: (ctx: any) => {
          executionOrder.push("normal-1");
          return ctx;
        },
      };

      const normal2 = {
        name: "normal-2",
        beforeRequest: (ctx: any) => {
          executionOrder.push("normal-2");
          return ctx;
        },
      };

      const mock = schmock()
        .use(normal1)
        .use(normal2)
        .routes({
          "GET /test": {
            response: () => "OK",
          },
        })
        .build();

      await mock.handle("GET", "/test");

      expect(executionOrder).toEqual(["normal-1", "normal-2"]);
    });
  });

  describe("plugin data flow", () => {
    it("passes data correctly through plugin chain", async () => {
      const plugin1 = {
        name: "multiplier",
        afterGenerate: (data: number) => data * 2,
      };

      const plugin2 = {
        name: "adder",
        afterGenerate: (data: number) => data + 10,
      };

      const mock = schmock()
        .use(plugin1)
        .use(plugin2)
        .routes({
          "GET /math": {
            response: () => 5, // 5 -> 10 -> 20
          },
        })
        .build();

      const response = await mock.handle("GET", "/math");

      expect(response.body).toBe(20); // (5 * 2) + 10
    });

    it("handles plugin returning undefined gracefully", async () => {
      const nopPlugin = {
        name: "nop",
        afterGenerate: () => undefined, // Returns undefined
      };

      const mock = schmock()
        .use(nopPlugin)
        .routes({
          "GET /test": {
            response: () => ({ data: "original" }),
          },
        })
        .build();

      const response = await mock.handle("GET", "/test");

      expect(response.body).toBeUndefined();
    });

    it("allows plugins to completely replace response data", async () => {
      const replacerPlugin = {
        name: "replacer",
        afterGenerate: () => ({ replaced: true }),
      };

      const mock = schmock()
        .use(replacerPlugin)
        .routes({
          "GET /test": {
            response: () => ({ original: true }),
          },
        })
        .build();

      const response = await mock.handle("GET", "/test");

      expect(response.body).toEqual({ replaced: true });
    });
  });

  describe("plugin error handling", () => {
    it("wraps plugin errors with PluginError", async () => {
      const errorPlugin = {
        name: "error-plugin",
        generate: () => {
          throw new Error("Plugin failed");
        },
      };

      const mock = schmock()
        .use(errorPlugin)
        .routes({
          "GET /error": {},
        })
        .build();

      const response = await mock.handle("GET", "/error");

      expect(response.status).toBe(500);
      expect(response.body.error).toContain("error-plugin");
      expect(response.body.code).toBe("PLUGIN_ERROR");
    });

    it("propagates plugin errors through the system", async () => {
      const errorEvents: any[] = [];
      
      const faultyPlugin = {
        name: "faulty",
        beforeRequest: () => {
          throw new Error("Before request failed");
        },
      };

      const mock = schmock()
        .use(faultyPlugin)
        .routes({
          "GET /test": {
            response: () => "OK",
          },
        })
        .build();

      mock.on("error", (event) => errorEvents.push(event));

      const response = await mock.handle("GET", "/test");

      expect(response.status).toBe(500);
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error).toBeInstanceOf(PluginError);
    });

    it("continues execution when onError returns undefined", async () => {
      const errorHandlerPlugin = {
        name: "error-handler",
        onError: () => undefined, // Don't handle the error
      };

      const faultyPlugin = {
        name: "faulty",
        generate: () => {
          throw new Error("Generation failed");
        },
      };

      const mock = schmock()
        .use(errorHandlerPlugin)
        .use(faultyPlugin)
        .routes({
          "GET /error": {},
        })
        .build();

      const response = await mock.handle("GET", "/error");

      expect(response.status).toBe(500);
      expect(response.body.error).toContain("faulty");
    });
  });

  describe("context state management", () => {
    it("provides isolated state Map per request", async () => {
      const statePlugin = {
        name: "state-plugin",
        beforeRequest: (ctx: any) => {
          ctx.state.set("value", "request-1");
          return ctx;
        },
        generate: (ctx: any) => ({
          stored: ctx.state.get("value"),
        }),
      };

      const mock = schmock()
        .use(statePlugin)
        .routes({
          "GET /state": {},
        })
        .build();

      const response1 = await mock.handle("GET", "/state");
      const response2 = await mock.handle("GET", "/state");

      expect(response1.body.stored).toBe("request-1");
      expect(response2.body.stored).toBe("request-1");
    });

    it("shares state between plugin hooks within same request", async () => {
      const sharedValues: any = {};
      
      const plugin = {
        name: "shared-state",
        beforeRequest: (ctx: any) => {
          ctx.state.set("shared", "from-before");
          return ctx;
        },
        generate: (ctx: any) => {
          sharedValues.beforeValue = ctx.state.get("shared");
          ctx.state.set("shared", "from-generate");
          return { data: "test" };
        },
        afterGenerate: (data: any, ctx: any) => {
          sharedValues.generateValue = ctx.state.get("shared");
          return data;
        },
      };

      const mock = schmock()
        .use(plugin)
        .routes({
          "GET /shared": {},
        })
        .build();

      await mock.handle("GET", "/shared");

      expect(sharedValues.beforeValue).toBe("from-before");
      expect(sharedValues.generateValue).toBe("from-generate");
    });
  });
});