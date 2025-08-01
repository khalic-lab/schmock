import { describe, expect, it } from "vitest";
import { schmock } from "./index";

describe("response delay functionality", () => {
  describe("fixed delay", () => {
    it("applies fixed delay to responses", async () => {
      const mock = schmock({ delay: 100 });
      mock("GET /test", "response");

      const start = Date.now();
      const response = await mock.handle("GET", "/test");
      const duration = Date.now() - start;

      expect(response.body).toBe("response");
      expect(duration).toBeGreaterThanOrEqual(95); // Allow some tolerance
      expect(duration).toBeLessThan(150);
    });

    it("applies delay to all routes", async () => {
      const mock = schmock({ delay: 50 });
      mock("GET /route1", "response1");
      mock("POST /route2", "response2");

      const start1 = Date.now();
      const response1 = await mock.handle("GET", "/route1");
      const duration1 = Date.now() - start1;

      const start2 = Date.now();
      const response2 = await mock.handle("POST", "/route2");
      const duration2 = Date.now() - start2;

      expect(response1.body).toBe("response1");
      expect(response2.body).toBe("response2");
      expect(duration1).toBeGreaterThanOrEqual(45);
      expect(duration2).toBeGreaterThanOrEqual(45);
    });

    it("works with zero delay", async () => {
      const mock = schmock({ delay: 0 });
      mock("GET /test", "response");

      const start = Date.now();
      const response = await mock.handle("GET", "/test");
      const duration = Date.now() - start;

      expect(response.body).toBe("response");
      expect(duration).toBeLessThan(50); // Should be very fast
    });
  });

  describe("random delay range", () => {
    it("applies random delay within specified range", async () => {
      const mock = schmock({ delay: [100, 200] });
      mock("GET /test", "response");

      const start = Date.now();
      const response = await mock.handle("GET", "/test");
      const duration = Date.now() - start;

      expect(response.body).toBe("response");
      expect(duration).toBeGreaterThanOrEqual(95); // Allow some tolerance for timer precision
      expect(duration).toBeLessThan(250);
    });

    it("generates different delays for multiple requests", async () => {
      const mock = schmock({ delay: [50, 150] });
      mock("GET /test", "response");

      const durations: number[] = [];

      for (let i = 0; i < 5; i++) {
        const start = Date.now();
        await mock.handle("GET", "/test");
        durations.push(Date.now() - start);
      }

      // Check that we got some variation in delays
      const minDuration = Math.min(...durations);
      const maxDuration = Math.max(...durations);

      expect(minDuration).toBeGreaterThanOrEqual(45);
      expect(maxDuration).toBeLessThan(200);
      // There should be some variation (not all identical)
      expect(maxDuration - minDuration).toBeGreaterThan(10);
    });

    it("handles reversed range [max, min]", async () => {
      const mock = schmock({ delay: [200, 100] });
      mock("GET /test", "response");

      const start = Date.now();
      const response = await mock.handle("GET", "/test");
      const duration = Date.now() - start;

      expect(response.body).toBe("response");
      // Should still work, treating it as [100, 200]
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(duration).toBeLessThan(300);
    });

    it("handles equal min and max values", async () => {
      const mock = schmock({ delay: [100, 100] });
      mock("GET /test", "response");

      const start = Date.now();
      const response = await mock.handle("GET", "/test");
      const duration = Date.now() - start;

      expect(response.body).toBe("response");
      expect(duration).toBeGreaterThanOrEqual(95);
      expect(duration).toBeLessThan(150);
    });
  });

  describe("delay with different response types", () => {
    it("applies delay to function generators", async () => {
      const mock = schmock({ delay: 50 });
      mock("GET /dynamic", () => ({ timestamp: Date.now() }));

      const start = Date.now();
      const response = await mock.handle("GET", "/dynamic");
      const duration = Date.now() - start;

      expect(response.body).toHaveProperty("timestamp");
      expect(duration).toBeGreaterThanOrEqual(45);
    });

    it("applies delay to static responses", async () => {
      const mock = schmock({ delay: 50 });
      mock("GET /static", { data: "static" });

      const start = Date.now();
      const response = await mock.handle("GET", "/static");
      const duration = Date.now() - start;

      expect(response.body).toEqual({ data: "static" });
      expect(duration).toBeGreaterThanOrEqual(45);
    });

    it("applies delay to tuple responses", async () => {
      const mock = schmock({ delay: 50 });
      mock("GET /tuple", () => [201, { created: true }]);

      const start = Date.now();
      const response = await mock.handle("GET", "/tuple");
      const duration = Date.now() - start;

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ created: true });
      expect(duration).toBeGreaterThanOrEqual(45);
    });

    it("applies delay to error responses", async () => {
      const mock = schmock({ delay: 50 });
      mock("GET /error", () => {
        throw new Error("Test error");
      });

      const start = Date.now();
      const response = await mock.handle("GET", "/error");
      const duration = Date.now() - start;

      expect(response.status).toBe(500);
      expect(duration).toBeGreaterThanOrEqual(45);
    });
  });

  describe("delay with plugins", () => {
    it("applies delay after plugin processing", async () => {
      const mock = schmock({ delay: 50 });

      const plugin = {
        name: "slow-plugin",
        process: async (ctx: any, res: any) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { context: ctx, response: `processed-${res}` };
        },
      };

      mock("GET /test", "original").pipe(plugin);

      const start = Date.now();
      const response = await mock.handle("GET", "/test");
      const duration = Date.now() - start;

      expect(response.body).toBe("processed-original");
      expect(duration).toBeGreaterThanOrEqual(75); // Plugin delay + response delay
    });

    it("applies delay even when plugin generates response", async () => {
      const mock = schmock({ delay: 50 });

      const plugin = {
        name: "generator-plugin",
        process: (ctx: any, _res: any) => {
          return { context: ctx, response: "plugin-generated" };
        },
      };

      mock("GET /test", null).pipe(plugin);

      const start = Date.now();
      const response = await mock.handle("GET", "/test");
      const duration = Date.now() - start;

      expect(response.body).toBe("plugin-generated");
      expect(duration).toBeGreaterThanOrEqual(45);
    });
  });

  describe("no delay configuration", () => {
    it("doesn't apply delay when not configured", async () => {
      const mock = schmock();
      mock("GET /test", "response");

      const start = Date.now();
      const response = await mock.handle("GET", "/test");
      const duration = Date.now() - start;

      expect(response.body).toBe("response");
      expect(duration).toBeLessThan(30); // Should be very fast without delay
    });

    it("doesn't apply delay when delay is undefined", async () => {
      const mock = schmock({ delay: undefined });
      mock("GET /test", "response");

      const start = Date.now();
      const response = await mock.handle("GET", "/test");
      const duration = Date.now() - start;

      expect(response.body).toBe("response");
      expect(duration).toBeLessThan(30);
    });
  });

  describe("delay edge cases", () => {
    it("handles very small delays", async () => {
      const mock = schmock({ delay: 1 });
      mock("GET /test", "response");

      const start = Date.now();
      const response = await mock.handle("GET", "/test");
      const duration = Date.now() - start;

      expect(response.body).toBe("response");
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(duration).toBeLessThan(50);
    });

    it("handles large delays", async () => {
      const mock = schmock({ delay: 500 });
      mock("GET /test", "response");

      const start = Date.now();
      const response = await mock.handle("GET", "/test");
      const duration = Date.now() - start;

      expect(response.body).toBe("response");
      expect(duration).toBeGreaterThanOrEqual(490);
      expect(duration).toBeLessThan(600);
    }, 1000); // Increase test timeout

    it("handles negative delays gracefully", async () => {
      const mock = schmock({ delay: -50 });
      mock("GET /test", "response");

      const start = Date.now();
      const response = await mock.handle("GET", "/test");
      const duration = Date.now() - start;

      expect(response.body).toBe("response");
      // Should not crash, and should be fast
      expect(duration).toBeLessThan(50);
    });

    it("handles delay range with negative values", async () => {
      const mock = schmock({ delay: [-10, 50] });
      mock("GET /test", "response");

      const start = Date.now();
      const response = await mock.handle("GET", "/test");
      const duration = Date.now() - start;

      expect(response.body).toBe("response");
      // Should handle gracefully
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(duration).toBeLessThan(100);
    });
  });

  describe("concurrent requests with delay", () => {
    it("applies delay to concurrent requests independently", async () => {
      const mock = schmock({ delay: 100 });
      mock("GET /test", "response");

      const start = Date.now();

      // Start multiple requests concurrently
      const promises = [
        mock.handle("GET", "/test"),
        mock.handle("GET", "/test"),
        mock.handle("GET", "/test"),
      ];

      const responses = await Promise.all(promises);
      const duration = Date.now() - start;

      // All should succeed
      responses.forEach((response) => {
        expect(response.body).toBe("response");
      });

      // Should take about 100ms, not 300ms (concurrent, not sequential)
      expect(duration).toBeGreaterThanOrEqual(95);
      expect(duration).toBeLessThan(200);
    });
  });
});
