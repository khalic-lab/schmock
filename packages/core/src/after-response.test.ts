import { afterEach, describe, expect, it, vi } from "vitest";
import { schmock } from "./index";
import { assertValidPlugin } from "./plugin-hooks";

const STAGED = "test:staged-writes";

const passThrough: Schmock.Plugin["process"] = (context, response) => ({
  context,
  response,
});

/**
 * A store plugin in the shape @schmock/openapi uses: the route stages a write
 * in `pluginState`, and `afterResponse` commits it only when the final
 * response succeeded.
 */
function stagingStore() {
  const rows: string[] = [];
  const seen: Array<{ status: number; body: unknown }> = [];
  const plugin: Schmock.Plugin = {
    name: "staging-store",
    process: passThrough,
    afterResponse(context, response) {
      seen.push({ status: response.status, body: response.body });
      const staged = context.state.get(STAGED);
      context.state.delete(STAGED);
      if (response.status >= 400 || !Array.isArray(staged)) return;
      for (const row of staged) rows.push(String(row));
    },
  };
  const create: Schmock.GeneratorFunction = ({ body, pluginState }) => {
    pluginState?.set(STAGED, [String(body)]);
    return [201, { name: body }];
  };
  return { rows, seen, plugin, create };
}

function failingPlugin(): Schmock.Plugin {
  return {
    name: "downstream-failure",
    process: (context) => ({
      context,
      response: [500, { error: "downstream" }],
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Plugin.afterResponse", () => {
  describe("settling staged work by the final status", () => {
    it("commits a staged write when the final response succeeds", async () => {
      const store = stagingStore();
      const mock = schmock();
      mock("POST /pets", store.create).pipe(store.plugin);

      const response = await mock.handle("POST", "/pets", { body: "rex" });

      expect(response.status).toBe(201);
      expect(store.rows).toEqual(["rex"]);
      expect(store.seen).toEqual([{ status: 201, body: { name: "rex" } }]);
    });

    it("drops a staged write when a plugin piped later turns it into a 500", async () => {
      const store = stagingStore();
      const mock = schmock();
      mock("POST /pets", store.create).pipe(store.plugin).pipe(failingPlugin());

      const response = await mock.handle("POST", "/pets", { body: "rex" });

      expect(response.status).toBe(500);
      expect(store.rows).toEqual([]);
      expect(store.seen).toEqual([
        { status: 500, body: { error: "downstream" } },
      ]);
    });

    it("sees the 500 a throwing route was answered with", async () => {
      const store = stagingStore();
      const mock = schmock();
      mock("POST /pets", (ctx) => {
        ctx.pluginState?.set(STAGED, ["half-written"]);
        throw new Error("generator failed");
      }).pipe(store.plugin);

      const response = await mock.handle("POST", "/pets");

      expect(response.status).toBe(500);
      expect(store.rows).toEqual([]);
      expect(store.seen[0]).toMatchObject({
        status: 500,
        body: { error: "generator failed", code: "INTERNAL_ERROR" },
      });
    });

    it("sees the 500 of a plugin that throws in process", async () => {
      const store = stagingStore();
      const mock = schmock();
      mock("POST /pets", store.create)
        .pipe(store.plugin)
        .pipe({
          name: "thrower",
          process: () => {
            throw new Error("plugin failed");
          },
        });

      const response = await mock.handle("POST", "/pets", { body: "rex" });

      expect(response.status).toBe(500);
      expect(store.rows).toEqual([]);
    });

    it("commits through the fetch interceptor before the fetch resolves", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("network"));
      const store = stagingStore();
      const mock = schmock();
      mock("POST /pets", store.create).pipe(store.plugin);
      const handle = mock.intercept({ passthrough: false });

      try {
        const response = await fetch("http://localhost/pets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify("rex"),
        });
        expect(response.status).toBe(201);
        expect(store.rows).toEqual(["rex"]);
      } finally {
        handle.restore();
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("when it runs", () => {
    it("runs in pipe order, after the delay and before history and request:end", async () => {
      const order: string[] = [];
      const mock = schmock();
      mock("GET /ping", () => {
        order.push("route");
        return { ok: true };
      });
      for (const name of ["first", "second"]) {
        mock.pipe({
          name,
          process: passThrough,
          afterResponse: async () => {
            await Promise.resolve();
            order.push(`${name}:${mock.callCount()}`);
          },
        });
      }
      mock.on("request:end", () => order.push(`end:${mock.callCount()}`));

      await mock.handle("GET", "/ping");
      order.push("resolved");

      expect(order).toEqual([
        "route",
        "first:0",
        "second:0",
        "end:1",
        "resolved",
      ]);
    });

    it("is not called for a route miss", async () => {
      const afterResponse = vi.fn();
      const mock = schmock();
      mock("GET /known", { ok: true }).pipe({
        name: "settler",
        process: passThrough,
        afterResponse,
      });

      const response = await mock.handle("GET", "/unknown");

      expect(response.status).toBe(404);
      expect(afterResponse).not.toHaveBeenCalled();
    });

    it("is not called for a request aborted during its delay", async () => {
      const afterResponse = vi.fn();
      const ends: number[] = [];
      const mock = schmock();
      mock("POST /pets", { ok: true }, { delay: 1_000 }).pipe({
        name: "settler",
        process: passThrough,
        afterResponse,
      });
      mock.on("request:end", (event) => ends.push(event.status));
      const controller = new AbortController();

      const pending = mock.handle("POST", "/pets", {
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(afterResponse).not.toHaveBeenCalled();
      expect(ends).toEqual([499]);
      expect(mock.history()).toHaveLength(0);
    });

    it("rejects handle() with the abort reason when the request aborts during a pending hook", async () => {
      let started: () => void = () => {};
      const hookStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const ends: number[] = [];
      const mock = schmock();
      mock("GET /slow-settle", { ok: true }).pipe({
        name: "slow-settler",
        process: passThrough,
        afterResponse: () => {
          started();
          return new Promise(() => {});
        },
      });
      mock.on("request:end", (event) => ends.push(event.status));
      const controller = new AbortController();

      const pending = mock.handle("GET", "/slow-settle", {
        signal: controller.signal,
      });
      await hookStarted;
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(ends).toEqual([499]);
      expect(mock.history()).toHaveLength(0);
    });
  });

  describe("in isolation", () => {
    it("never changes the response when it throws or rejects, and later hooks still run", async () => {
      const later = vi.fn();
      const mock = schmock();
      mock("GET /stable", { ok: true })
        .pipe({
          name: "sync-thrower",
          process: passThrough,
          afterResponse: () => {
            throw new Error("settle failed");
          },
        })
        .pipe({
          name: "async-rejecter",
          process: passThrough,
          afterResponse: async () => {
            throw new Error("async settle failed");
          },
        })
        .pipe({
          name: "later",
          process: passThrough,
          afterResponse: later,
        });

      const response = await mock.handle("GET", "/stable");

      expect(response).toEqual({
        status: 200,
        body: { ok: true },
        headers: { "content-type": "application/json" },
      });
      expect(later).toHaveBeenCalledOnce();
      expect(mock.callCount()).toBe(1);
    });

    it("logs a failing hook under the plugin debug category", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "time").mockImplementation(() => {});
      vi.spyOn(console, "timeEnd").mockImplementation(() => {});
      const mock = schmock({ debug: true });
      mock("GET /stable", { ok: true }).pipe({
        name: "sync-thrower",
        process: passThrough,
        afterResponse: () => {
          throw new Error("settle failed");
        },
      });

      await mock.handle("GET", "/stable");

      expect(
        log.mock.calls.some(
          ([line]) =>
            String(line).includes("[SCHMOCK:PLUGIN]") &&
            String(line).includes(
              "Plugin sync-thrower afterResponse failed: settle failed",
            ),
        ),
      ).toBe(true);
    });

    it("hands each hook its own read-only copy of the response", async () => {
      const mock = schmock();
      mock("GET /items", () => ({ items: [1, 2] })).pipe({
        name: "tamperer",
        process: passThrough,
        afterResponse: (_context, settled) => {
          expect(Object.isFrozen(settled)).toBe(true);
          expect(Object.isFrozen(settled.headers)).toBe(true);
          const { body } = settled;
          if (typeof body === "object" && body !== null && "items" in body) {
            const { items } = body;
            if (Array.isArray(items)) items.push(3);
          }
        },
      });

      const response = await mock.handle("GET", "/items");

      expect(response.body).toEqual({ items: [1, 2] });
      expect(mock.lastRequest()?.response.body).toEqual({ items: [1, 2] });
    });

    it("is rejected as PLUGIN_INVALID when set to a truthy non-function", () => {
      const invalid: unknown = {
        name: "bad-settler",
        process: (context: Schmock.PluginContext, response?: unknown) => ({
          context,
          response,
        }),
        afterResponse: "commit",
      };

      expect(() => assertValidPlugin(invalid)).toThrow(
        expect.objectContaining({
          code: "PLUGIN_INVALID",
          message:
            'Invalid plugin "bad-settler": afterResponse must be a function when set',
        }),
      );
    });
  });
});
