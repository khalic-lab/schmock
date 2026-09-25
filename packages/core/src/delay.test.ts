import { afterEach, describe, expect, it, vi } from "vitest";
import { schmock } from "./index";

/**
 * Delay tests assert the delay Schmock SCHEDULES, not the wall-clock time a
 * request took. Elapsed-time upper bounds fail whenever a loaded machine
 * stalls a few tens of milliseconds, and elapsed-time lower bounds of zero
 * cannot tell a delay from its absence. Fake timers make every request settle
 * instantly while the `setTimeout` spy records the millisecond argument, and
 * a stubbed `Math.random` pins where in a range the draw lands.
 */
async function handleWithScheduledDelays(
  mock: Schmock.CallableMockInstance,
  method: Schmock.HttpMethod,
  path: string,
): Promise<{ response: Schmock.Response; delays: number[] }> {
  vi.useFakeTimers();
  const timerSpy = vi.spyOn(globalThis, "setTimeout");
  try {
    const pending = mock.handle(method, path);
    await vi.runAllTimersAsync();
    const response = await pending;
    return {
      response,
      delays: timerSpy.mock.calls.map((call) => call[1] ?? 0),
    };
  } finally {
    timerSpy.mockRestore();
    vi.useRealTimers();
  }
}

function stubRandom(...draws: number[]): void {
  const spy = vi.spyOn(Math, "random");
  for (const draw of draws) spy.mockReturnValueOnce(draw);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("response delay functionality", () => {
  describe("fixed delay", () => {
    it("aborts a pending delay without recording history", async () => {
      const mock = schmock({ delay: 1_000 });
      mock("GET /abort-delay", { completed: true });
      const controller = new AbortController();

      const pending = mock.handle("GET", "/abort-delay", {
        signal: controller.signal,
      });
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(mock.history()).toHaveLength(0);
    });

    it("aborts while an async generator remains pending", async () => {
      const mock = schmock();
      let announceStarted = () => {};
      let releaseGenerator = () => {};
      const started = new Promise<void>((resolve) => {
        announceStarted = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        releaseGenerator = resolve;
      });
      mock("GET /pending-generator", async () => {
        announceStarted();
        await barrier;
        return { completed: true };
      });
      const controller = new AbortController();

      try {
        const pending = mock.handle("GET", "/pending-generator", {
          signal: controller.signal,
        });
        await started;
        controller.abort();

        await expect(
          Promise.race([
            pending,
            new Promise<Schmock.Response>((_, reject) => {
              setTimeout(() => reject(new Error("abort timed out")), 100);
            }),
          ]),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(mock.history()).toHaveLength(0);
      } finally {
        releaseGenerator();
      }
    });

    it("applies fixed delay to responses", async () => {
      vi.useFakeTimers();
      try {
        const mock = schmock({ delay: 100 });
        mock("GET /test", "response");

        const start = Date.now();
        const pending = mock.handle("GET", "/test");
        await vi.runAllTimersAsync();
        const response = await pending;

        expect(response.body).toBe("response");
        expect(Date.now() - start).toBe(100);
      } finally {
        vi.useRealTimers();
      }
    });

    it("applies delay to all routes", async () => {
      const mock = schmock({ delay: 50 });
      mock("GET /route1", "response1");
      mock("POST /route2", "response2");

      const first = await handleWithScheduledDelays(mock, "GET", "/route1");
      const second = await handleWithScheduledDelays(mock, "POST", "/route2");

      expect(first.response.body).toBe("response1");
      expect(second.response.body).toBe("response2");
      expect(first.delays).toEqual([50]);
      expect(second.delays).toEqual([50]);
    });

    it("works with zero delay", async () => {
      const mock = schmock({ delay: 0 });
      mock("GET /test", "response");

      const { response, delays } = await handleWithScheduledDelays(
        mock,
        "GET",
        "/test",
      );

      expect(response.body).toBe("response");
      expect(delays).toEqual([]);
    });
  });

  describe("random delay range", () => {
    it("applies random delay within specified range", async () => {
      const mock = schmock({ delay: [100, 200] });
      mock("GET /test", "response");

      stubRandom(0);
      const low = await handleWithScheduledDelays(mock, "GET", "/test");
      stubRandom(0.999);
      const high = await handleWithScheduledDelays(mock, "GET", "/test");

      expect(low.response.body).toBe("response");
      expect(low.delays).toEqual([100]);
      expect(high.delays[0]).toBeCloseTo(199.9);
    });

    it("generates different delays for multiple requests", async () => {
      const mock = schmock({ delay: [50, 150] });
      mock("GET /test", "response");

      const delays: number[] = [];
      for (const draw of [0, 0.25, 0.5, 0.75, 0.99]) {
        stubRandom(draw);
        delays.push(
          ...(await handleWithScheduledDelays(mock, "GET", "/test")).delays,
        );
      }

      expect(delays).toEqual([50, 75, 100, 125, 149]);
    });

    it("handles reversed range [max, min]", async () => {
      const mock = schmock({ delay: [200, 100] });
      mock("GET /test", "response");

      stubRandom(0);
      const first = await handleWithScheduledDelays(mock, "GET", "/test");
      stubRandom(0.999);
      const second = await handleWithScheduledDelays(mock, "GET", "/test");

      expect(first.response.body).toBe("response");
      // A reversed range still delays: every draw lands inside [100, 200].
      expect(first.delays).toEqual([200]);
      expect(second.delays[0]).toBeCloseTo(100.1);
    });

    it("handles equal min and max values", async () => {
      const mock = schmock({ delay: [100, 100] });
      mock("GET /test", "response");

      const { response, delays } = await handleWithScheduledDelays(
        mock,
        "GET",
        "/test",
      );

      expect(response.body).toBe("response");
      expect(delays).toEqual([100]);
    });
  });

  describe("delay with different response types", () => {
    it("applies delay to function generators", async () => {
      const mock = schmock({ delay: 50 });
      mock("GET /dynamic", () => ({ timestamp: Date.now() }));

      const { response, delays } = await handleWithScheduledDelays(
        mock,
        "GET",
        "/dynamic",
      );

      expect(response.body).toHaveProperty("timestamp");
      expect(delays).toEqual([50]);
    });

    it("applies delay to static responses", async () => {
      const mock = schmock({ delay: 50 });
      mock("GET /static", { data: "static" });

      const { response, delays } = await handleWithScheduledDelays(
        mock,
        "GET",
        "/static",
      );

      expect(response.body).toEqual({ data: "static" });
      expect(delays).toEqual([50]);
    });

    it("applies delay to tuple responses", async () => {
      const mock = schmock({ delay: 50 });
      mock("GET /tuple", () => [201, { created: true }]);

      const { response, delays } = await handleWithScheduledDelays(
        mock,
        "GET",
        "/tuple",
      );

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ created: true });
      expect(delays).toEqual([50]);
    });

    it("applies delay to error responses", async () => {
      const mock = schmock({ delay: 50 });
      mock("GET /error", () => {
        throw new Error("Test error");
      });

      const { response, delays } = await handleWithScheduledDelays(
        mock,
        "GET",
        "/error",
      );

      expect(response.status).toBe(500);
      expect(delays).toEqual([50]);
    });
  });

  describe("delay with plugins", () => {
    it("applies delay after plugin processing", async () => {
      const mock = schmock({ delay: 50 });

      const plugin: Schmock.Plugin = {
        name: "slow-plugin",
        process: async (context, upstream) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { context, response: `processed-${String(upstream)}` };
        },
      };

      mock("GET /test", "original").pipe(plugin);

      const { response, delays } = await handleWithScheduledDelays(
        mock,
        "GET",
        "/test",
      );

      expect(response.body).toBe("processed-original");
      // The plugin's own 30ms wait is scheduled first, the response delay after.
      expect(delays).toEqual([30, 50]);
    });

    it("applies delay even when plugin generates response", async () => {
      const mock = schmock({ delay: 50 });

      const plugin: Schmock.Plugin = {
        name: "generator-plugin",
        process: (context) => ({ context, response: "plugin-generated" }),
      };

      mock("GET /test", null).pipe(plugin);

      const { response, delays } = await handleWithScheduledDelays(
        mock,
        "GET",
        "/test",
      );

      expect(response.body).toBe("plugin-generated");
      expect(delays).toEqual([50]);
    });
  });

  describe("no delay configuration", () => {
    it("doesn't apply delay when not configured", async () => {
      const mock = schmock();
      mock("GET /test", "response");

      const { response, delays } = await handleWithScheduledDelays(
        mock,
        "GET",
        "/test",
      );

      expect(response.body).toBe("response");
      expect(delays).toEqual([]);
    });

    it("doesn't apply delay when delay is undefined", async () => {
      const mock = schmock({ delay: undefined });
      mock("GET /test", "response");

      const { response, delays } = await handleWithScheduledDelays(
        mock,
        "GET",
        "/test",
      );

      expect(response.body).toBe("response");
      expect(delays).toEqual([]);
    });
  });

  describe("delay edge cases", () => {
    it("handles very small delays", async () => {
      const mock = schmock({ delay: 1 });
      mock("GET /test", "response");

      const { response, delays } = await handleWithScheduledDelays(
        mock,
        "GET",
        "/test",
      );

      expect(response.body).toBe("response");
      expect(delays).toEqual([1]);
    });

    it("handles large delays", async () => {
      const mock = schmock({ delay: 500 });
      mock("GET /test", "response");

      const { response, delays } = await handleWithScheduledDelays(
        mock,
        "GET",
        "/test",
      );

      expect(response.body).toBe("response");
      expect(delays).toEqual([500]);
    });

    it("handles negative delays gracefully", async () => {
      const mock = schmock({ delay: -50 });
      mock("GET /test", "response");

      const { response, delays } = await handleWithScheduledDelays(
        mock,
        "GET",
        "/test",
      );

      expect(response.body).toBe("response");
      // A negative delay clamps to zero rather than being passed through.
      expect(delays).toEqual([0]);
    });

    it("handles delay range with negative values", async () => {
      const mock = schmock({ delay: [-10, 50] });
      mock("GET /test", "response");

      stubRandom(0);
      const clamped = await handleWithScheduledDelays(mock, "GET", "/test");
      stubRandom(0.5);
      const positive = await handleWithScheduledDelays(mock, "GET", "/test");

      expect(clamped.response.body).toBe("response");
      expect(clamped.delays).toEqual([0]);
      expect(positive.delays).toEqual([20]);
    });
  });

  describe("concurrent requests with delay", () => {
    it("applies delay to concurrent requests independently", async () => {
      vi.useFakeTimers();
      try {
        const mock = schmock({ delay: 100 });
        mock("GET /test", "response");

        let settled = 0;
        const pending = [1, 2, 3].map(() =>
          mock.handle("GET", "/test").then((response) => {
            settled += 1;
            return response;
          }),
        );

        await vi.advanceTimersByTimeAsync(99);
        expect(settled).toBe(0);
        // Concurrent, not sequential: all three finish at the 100ms mark.
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(3);

        for (const response of await Promise.all(pending)) {
          expect(response.body).toBe("response");
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
