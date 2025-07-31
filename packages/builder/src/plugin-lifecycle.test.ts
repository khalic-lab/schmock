import { describe, it, expect, vi, beforeEach } from "vitest";
import { schmock } from "./index";

describe("Plugin Lifecycle", () => {
  let mock: any;
  let hookCalls: string[] = [];

  beforeEach(() => {
    hookCalls = [];
  });

  describe("hook execution order", () => {
    it("calls all hooks in the correct order for successful requests", async () => {
      const plugin = {
        name: "test-plugin",
        beforeRequest: vi.fn((ctx) => {
          hookCalls.push("beforeRequest");
          return ctx;
        }),
        beforeGenerate: vi.fn(() => {
          hookCalls.push("beforeGenerate");
          return undefined;
        }),
        generate: vi.fn(() => {
          hookCalls.push("generate");
          return { data: "test" };
        }),
        afterGenerate: vi.fn((data) => {
          hookCalls.push("afterGenerate");
          return data;
        }),
        beforeResponse: vi.fn((response) => {
          hookCalls.push("beforeResponse");
          return response;
        })
      };

      mock = schmock()
        .use(plugin)
        .routes({
          "GET /test": {}
        })
        .build();

      await mock.handle("GET", "/test");

      expect(hookCalls).toEqual([
        "beforeRequest",
        "beforeGenerate",
        "generate",
        "afterGenerate",
        "beforeResponse"
      ]);
    });

    it("calls onError hook when an error occurs", async () => {
      const plugin = {
        name: "test-plugin",
        generate: vi.fn(() => {
          throw new Error("Test error");
        }),
        onError: vi.fn((error) => {
          hookCalls.push("onError");
          return error;
        })
      };

      mock = schmock()
        .use(plugin)
        .routes({
          "GET /error": {}
        })
        .build();

      const response = await mock.handle("GET", "/error");

      expect(hookCalls).toContain("onError");
      expect(response.status).toBe(500);
    });
  });

  describe("plugin ordering with enforce", () => {
    it("executes pre plugins before normal plugins", async () => {
      const executionOrder: string[] = [];

      const prePlugin = {
        name: "pre-plugin",
        enforce: "pre" as const,
        generate: () => {
          executionOrder.push("pre");
          return undefined;
        }
      };

      const normalPlugin = {
        name: "normal-plugin",
        generate: () => {
          executionOrder.push("normal");
          return { data: "test" };
        }
      };

      mock = schmock()
        .use(normalPlugin)
        .use(prePlugin) // Added after, but should run first
        .routes({
          "GET /test": {}
        })
        .build();

      await mock.handle("GET", "/test");

      expect(executionOrder).toEqual(["pre", "normal"]);
    });

    it("executes post plugins after normal plugins", async () => {
      const executionOrder: string[] = [];

      const normalPlugin = {
        name: "normal-plugin",
        afterGenerate: (data: any) => {
          executionOrder.push("normal");
          return data;
        }
      };

      const postPlugin = {
        name: "post-plugin",
        enforce: "post" as const,
        afterGenerate: (data: any) => {
          executionOrder.push("post");
          return data;
        }
      };

      mock = schmock()
        .use(postPlugin) // Added first, but should run last
        .use(normalPlugin)
        .routes({
          "GET /test": {
            response: () => ({ data: "test" })
          }
        })
        .build();

      await mock.handle("GET", "/test");

      expect(executionOrder).toEqual(["normal", "post"]);
    });
  });

  describe("context modification", () => {
    it("beforeRequest can modify the context", async () => {
      const plugin = {
        name: "context-modifier",
        beforeRequest: (ctx: any) => {
          return {
            ...ctx,
            headers: {
              ...ctx.headers,
              "X-Modified": "true"
            }
          };
        }
      };

      mock = schmock()
        .use(plugin)
        .routes({
          "GET /test": {
            response: (ctx) => ({ headers: ctx.headers })
          }
        })
        .build();

      const response = await mock.handle("GET", "/test");
      expect(response.body.headers["X-Modified"]).toBe("true");
    });

    it("plugin state is shared across hooks", async () => {
      const stateValues: any = {};

      const plugin = {
        name: "stateful",
        beforeRequest: (ctx: any) => {
          ctx.state.set("value", "initial");
          return ctx;
        },
        generate: (ctx: any) => {
          stateValues.generate = ctx.state.get("value");
          ctx.state.set("value", "modified");
          return { data: "test" };
        },
        afterGenerate: (data: any, ctx: any) => {
          stateValues.afterGenerate = ctx.state.get("value");
          return data;
        }
      };

      mock = schmock()
        .use(plugin)
        .routes({
          "GET /test": {}
        })
        .build();

      await mock.handle("GET", "/test");

      expect(stateValues.generate).toBe("initial");
      expect(stateValues.afterGenerate).toBe("modified");
    });
  });

  describe("early returns and short-circuits", () => {
    it("beforeGenerate can return early response", async () => {
      const generateCalled = vi.fn();

      const plugin = {
        name: "early-return",
        beforeGenerate: () => {
          return { early: true };
        },
        generate: generateCalled
      };

      mock = schmock()
        .use(plugin)
        .routes({
          "GET /test": {}
        })
        .build();

      const response = await mock.handle("GET", "/test");

      expect(response.body).toEqual({ early: true });
      expect(generateCalled).not.toHaveBeenCalled();
    });

    it("onError can return a custom response", async () => {
      const plugin = {
        name: "error-handler",
        onError: () => {
          return {
            status: 503,
            body: { custom: "error" },
            headers: { "X-Custom": "true" }
          };
        }
      };

      mock = schmock()
        .use(plugin)
        .routes({
          "GET /error": {
            response: () => {
              throw new Error("Test error");
            }
          }
        })
        .build();

      const response = await mock.handle("GET", "/error");

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ custom: "error" });
      expect(response.headers["X-Custom"]).toBe("true");
    });
  });

  describe("data transformation", () => {
    it("afterGenerate transforms generated data", async () => {
      const plugin = {
        name: "transformer",
        afterGenerate: (data: any) => {
          return { ...data, transformed: true };
        }
      };

      mock = schmock()
        .use(plugin)
        .routes({
          "GET /test": {
            response: () => ({ original: true })
          }
        })
        .build();

      const response = await mock.handle("GET", "/test");

      expect(response.body).toEqual({
        original: true,
        transformed: true
      });
    });

    it("multiple plugins compose transformations", async () => {
      const plugin1 = {
        name: "uppercase",
        afterGenerate: (data: string) => data.toUpperCase()
      };

      const plugin2 = {
        name: "exclaim",
        afterGenerate: (data: string) => data + "!"
      };

      mock = schmock()
        .use(plugin1)
        .use(plugin2)
        .routes({
          "GET /test": {
            response: () => "hello"
          }
        })
        .build();

      const response = await mock.handle("GET", "/test");

      expect(response.body).toBe("HELLO!");
    });

    it("beforeResponse modifies the final response", async () => {
      const plugin = {
        name: "response-modifier",
        beforeResponse: (response: any) => {
          return {
            ...response,
            status: 201,
            headers: {
              ...response.headers,
              "X-Modified": "true"
            }
          };
        }
      };

      mock = schmock()
        .use(plugin)
        .routes({
          "GET /test": {
            response: () => ({ data: "test" })
          }
        })
        .build();

      const response = await mock.handle("GET", "/test");

      expect(response.status).toBe(201);
      expect(response.headers["X-Modified"]).toBe("true");
    });
  });

  describe("error handling", () => {
    it("wraps plugin errors correctly", async () => {
      const plugin = {
        name: "failing-plugin",
        generate: () => {
          throw new Error("Plugin error");
        }
      };

      mock = schmock()
        .use(plugin)
        .routes({
          "GET /test": {}
        })
        .build();

      const response = await mock.handle("GET", "/test");

      expect(response.status).toBe(500);
      expect(response.body.error).toContain("failing-plugin");
      expect(response.body.code).toBe("PLUGIN_ERROR");
    });

    it("handles errors in lifecycle hooks", async () => {
      const plugin = {
        name: "error-in-hook",
        beforeRequest: () => {
          throw new Error("Hook error");
        }
      };

      mock = schmock()
        .use(plugin)
        .routes({
          "GET /test": {
            response: () => ({ data: "test" })
          }
        })
        .build();

      const response = await mock.handle("GET", "/test");

      expect(response.status).toBe(500);
      expect(response.body.error).toContain("error-in-hook");
    });

    it("onError hook errors are handled", async () => {
      const plugin = {
        name: "error-in-error-handler",
        generate: () => {
          throw new Error("Original error");
        },
        onError: () => {
          throw new Error("Error handler error");
        }
      };

      mock = schmock()
        .use(plugin)
        .routes({
          "GET /test": {}
        })
        .build();

      const response = await mock.handle("GET", "/test");

      expect(response.status).toBe(500);
      expect(response.body.error).toContain("error-in-error-handler");
    });
  });
});