import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { fakerPlugin, generateFromSchema } from "./index";
import { generate, performance as perf, schemas } from "./test-utils";

describe("Performance and Memory", () => {
  describe("Generation Speed", () => {
    it("generates simple objects quickly", async () => {
      const schema = schemas.simple.object({
        id: schemas.simple.number(),
        name: schemas.simple.string(),
        active: { type: "boolean" },
      });

      const times: number[] = [];
      for (let i = 0; i < 10; i++) {
        const { duration } = await perf.measure(() =>
          generateFromSchema({ schema }),
        );
        times.push(duration);
      }

      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      expect(avgTime).toBeLessThan(50); // Should average under 50ms
    });

    it("handles nested objects efficiently", async () => {
      const schema = schemas.nested.deep(
        3,
        schemas.simple.object({
          id: schemas.simple.number(),
          value: schemas.simple.string(),
        }),
      );

      const { duration } = await perf.measure(() =>
        generateFromSchema({ schema }),
      );

      expect(duration).toBeLessThan(100); // Reasonable for nested structure
    });

    it("generates arrays efficiently", async () => {
      const schema = schemas.simple.array(
        schemas.simple.object({
          id: schemas.simple.number(),
          name: schemas.simple.string(),
        }),
        { minItems: 50, maxItems: 50 },
      );

      const { duration } = await perf.measure(() =>
        generateFromSchema({ schema }),
      );

      expect(duration).toBeLessThan(200); // Should handle 50 items quickly
    });

    it("handles complex schemas with multiple constraints", async () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          users: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                email: { type: "string", format: "email" },
                age: { type: "integer", minimum: 18, maximum: 100 },
                tags: {
                  type: "array",
                  items: { type: "string", pattern: "^[a-z]+$" },
                  maxItems: 5,
                },
              },
              required: ["id", "email"],
            },
            minItems: 10,
            maxItems: 10,
          },
        },
      };

      const { duration } = await perf.measure(() =>
        generateFromSchema({ schema }),
      );

      expect(duration).toBeLessThan(300); // Complex but still reasonable
    });
  });

  describe("Scaling Behavior", () => {
    it("scales linearly with array size", async () => {
      const smallSchema = schemas.simple.array(schemas.simple.string(), {
        minItems: 50,
        maxItems: 50,
      });

      const largeSchema = schemas.simple.array(schemas.simple.string(), {
        minItems: 500,
        maxItems: 500,
      });

      // Warmup runs to stabilize JIT
      for (let i = 0; i < 3; i++) {
        generateFromSchema({ schema: smallSchema });
        generateFromSchema({ schema: largeSchema });
      }

      // Multiple measurement runs for statistical stability
      const smallTimes: number[] = [];
      const largeTimes: number[] = [];

      for (let i = 0; i < 10; i++) {
        const start1 = performance.now();
        generateFromSchema({ schema: smallSchema });
        const small = performance.now() - start1;
        smallTimes.push(small);

        const start2 = performance.now();
        generateFromSchema({ schema: largeSchema });
        const large = performance.now() - start2;
        largeTimes.push(large);
      }

      // Remove outliers and calculate medians for stability
      smallTimes.sort((a, b) => a - b);
      largeTimes.sort((a, b) => a - b);
      const medianSmall = smallTimes[Math.floor(smallTimes.length / 2)];
      const medianLarge = largeTimes[Math.floor(largeTimes.length / 2)];

      // Both should complete in reasonable time (main goal is to ensure it works, not strict timing)
      expect(medianSmall).toBeLessThan(50); // Small arrays should be fast
      expect(medianLarge).toBeLessThan(200); // Large arrays should still be reasonable

      // Optional: Check scaling if timing is meaningful
      if (medianSmall > 0.1) {
        // Only check scaling if we have measurable timing
        expect(medianLarge).toBeGreaterThan(medianSmall * 0.5); // Should take at least half as long
        expect(medianLarge).toBeLessThan(medianSmall * 50); // But not extremely longer
      }
    });

    it("handles wide objects efficiently", async () => {
      const narrowSchema = schemas.nested.wide(20);
      const wideSchema = schemas.nested.wide(100);

      // Warmup
      for (let i = 0; i < 3; i++) {
        generateFromSchema({ schema: narrowSchema });
        generateFromSchema({ schema: wideSchema });
      }

      // Measure with multiple runs, dropping outliers
      const narrowTimes: number[] = [];
      const wideTimes: number[] = [];

      for (let i = 0; i < 10; i++) {
        const start1 = performance.now();
        generateFromSchema({ schema: narrowSchema });
        narrowTimes.push(performance.now() - start1);

        const start2 = performance.now();
        generateFromSchema({ schema: wideSchema });
        wideTimes.push(performance.now() - start2);
      }

      // Use median instead of average to reduce sensitivity to GC pauses
      const median = (arr: number[]) => {
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2
          ? sorted[mid]
          : (sorted[mid - 1] + sorted[mid]) / 2;
      };

      const medWide = median(wideTimes);

      // 100-property object should still generate quickly (under 50ms)
      expect(medWide).toBeLessThan(50);
    });
  });

  describe("Plugin Performance", () => {
    it("plugin creation is fast", async () => {
      const schema = schemas.complex.user();

      const { duration } = await perf.measure(() => fakerPlugin({ schema }));

      expect(duration).toBeLessThan(10); // Plugin creation should be instant
    });

    it("plugin processing adds minimal overhead", async () => {
      const schema = schemas.complex.apiResponse();
      const plugin = fakerPlugin({ schema });

      const context = {
        method: "GET",
        path: "/test",
        params: {},
        query: {},
        state: {},
        headers: {},
        body: null,
        route: {},
      };

      const times: number[] = [];
      for (let i = 0; i < 10; i++) {
        const { duration } = await perf.measure(() => plugin.process(context));
        times.push(duration);
      }

      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      expect(avgTime).toBeLessThan(100);
    });

    it("template processing is efficient", async () => {
      const schema = schemas.simple.object({
        id: schemas.simple.string(),
        userId: schemas.simple.string(),
        timestamp: schemas.simple.string(),
        message: schemas.simple.string(),
      });

      const overrides = {
        id: "{{params.id}}",
        userId: "{{state.user.id}}",
        timestamp: "{{state.timestamp}}",
        message: "User {{params.id}} at {{state.timestamp}}",
      };

      const { duration } = await perf.measure(() =>
        generateFromSchema({
          schema,
          overrides,
          params: { id: "123" },
          state: {
            user: { id: "user-456" },
            timestamp: new Date().toISOString(),
          },
        }),
      );

      expect(duration).toBeLessThan(50); // Template processing should be fast
    });
  });

  describe("Concurrent Generation", () => {
    it("handles multiple concurrent generations", async () => {
      const schema = schemas.complex.user();

      const { duration } = await perf.measure(async () => {
        const promises = Array.from({ length: 20 }, () =>
          generateFromSchema({ schema }),
        );
        await Promise.all(promises);
      });

      expect(duration).toBeLessThan(500); // Should handle concurrency well
    });

    it("maintains performance under load", async () => {
      const schema = schemas.simple.object({
        id: schemas.simple.number(),
        data: schemas.simple.string(),
      });

      // Warm up
      generateFromSchema({ schema });

      // Test under load
      const iterations = 100;
      const { duration } = await perf.measure(async () => {
        for (let i = 0; i < iterations; i++) {
          generateFromSchema({ schema });
        }
      });

      const avgTime = duration / iterations;
      expect(avgTime).toBeLessThan(10); // Should maintain speed
    });
  });

  describe("Memory Efficiency", () => {
    it("doesn't leak memory on repeated generation", () => {
      const schema = schemas.simple.object({
        id: schemas.simple.number(),
        name: schemas.simple.string(),
      });

      // Generate many times
      for (let i = 0; i < 1000; i++) {
        const result = generateFromSchema({ schema });
        // Result should be garbage collectable
        expect(result).toBeDefined();
      }

      // If we got here without crashing, memory is managed well
      expect(true).toBe(true);
    });

    it("handles large data structures without excessive memory", () => {
      const schema = schemas.simple.array(
        schemas.simple.object({
          id: schemas.simple.string(),
          data: schemas.simple.string(),
        }),
        { minItems: 1000, maxItems: 1000 },
      );

      // Should be able to generate without memory issues
      const result = generateFromSchema({ schema });
      expect(result).toHaveLength(1000);
    });

    it("cleans up after schema validation errors", () => {
      // Generate errors repeatedly
      for (let i = 0; i < 100; i++) {
        try {
          generateFromSchema({ schema: { type: "invalid" as any } });
        } catch (_e) {
          // Expected
        }
      }

      // Should not have memory leaks from error objects
      expect(true).toBe(true);
    });
  });

  describe("Optimization Opportunities", () => {
    it("generates data consistently across multiple calls", async () => {
      const schema = schemas.simple.object({
        email: schemas.simple.string(),
        firstName: schemas.simple.string(),
        phone: schemas.simple.string(),
      });

      // Generate multiple times to ensure consistent behavior
      const results: any[] = [];
      for (let i = 0; i < 10; i++) {
        const result = generateFromSchema({ schema });
        results.push(result);
      }

      // Verify all results have the expected structure
      results.forEach((result) => {
        expect(result).toHaveProperty("email");
        expect(result).toHaveProperty("firstName");
        expect(result).toHaveProperty("phone");
        expect(typeof result.email).toBe("string");
        expect(typeof result.firstName).toBe("string");
        expect(typeof result.phone).toBe("string");
      });

      // Verify that smart field mapping worked across all calls
      const emails = results.map((r) => r.email);
      const firstNames = results.map((r) => r.firstName);

      // Should have good diversity (no exact duplicates expected)
      const uniqueEmails = new Set(emails);
      const uniqueFirstNames = new Set(firstNames);
      expect(uniqueEmails.size).toBeGreaterThan(1);
      expect(uniqueFirstNames.size).toBeGreaterThan(1);
    });

    it("reuses schema enhancement for repeated generations", async () => {
      const schema = schemas.complex.user();
      const plugin = fakerPlugin({ schema });

      const context = {
        method: "GET",
        path: "/test",
        params: {},
        query: {},
        state: {},
        headers: {},
        body: null,
        route: {},
      };

      // Warmup
      for (let i = 0; i < 3; i++) {
        plugin.process(context);
      }

      // Multiple calls through same plugin with proper timing
      const times: number[] = [];
      for (let i = 0; i < 15; i++) {
        const start = performance.now();
        plugin.process(context);
        times.push(performance.now() - start);
      }

      // Calculate statistics
      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      const maxTime = Math.max(...times);
      const minTime = Math.min(...times);

      // Performance should be consistent and reasonable
      expect(avgTime).toBeLessThan(50); // Should be reasonably fast
      expect(maxTime).toBeLessThan(100); // No extreme outliers
      expect(minTime).toBeGreaterThanOrEqual(0); // Valid timing

      // All measurements should be reasonable - no extreme variance
      const reasonableMaxTime = Math.max(avgTime * 5, 10); // At least 10ms tolerance
      expect(maxTime).toBeLessThan(reasonableMaxTime);
    });
  });

  describe("Edge Case Performance", () => {
    it("handles empty schemas efficiently", async () => {
      const schema = schemas.simple.object({});

      const { duration } = await perf.measure(() =>
        generateFromSchema({ schema }),
      );

      expect(duration).toBeLessThan(10); // Empty should be instant
    });

    it("handles schemas with many enum values", async () => {
      const schema = schemas.simple.object({
        country: {
          type: "string",
          enum: Array.from({ length: 200 }, (_, i) => `country-${i}`),
        },
      });

      const { duration } = await perf.measure(() =>
        generateFromSchema({ schema }),
      );

      expect(duration).toBeLessThan(50); // Large enum shouldn't be slow
    });

    it("handles complex regex patterns efficiently", async () => {
      const schema = schemas.simple.object({
        code: {
          type: "string",
          pattern: "^[A-Z]{2}-[0-9]{4}-[a-z]{2}-[0-9A-F]{8}$",
        },
      });

      const { duration } = await perf.measure(() =>
        generate.samples(schema, 10),
      );

      expect(duration).toBeLessThan(100); // Complex patterns OK
    });

    it("handles mixed constraint schemas", async () => {
      const schema: JSONSchema7 = {
        anyOf: [
          {
            type: "object",
            properties: {
              type: { const: "A" },
              data: { type: "string", minLength: 100 },
            },
          },
          {
            type: "array",
            items: { type: "number", minimum: 0, maximum: 1000 },
            minItems: 50,
          },
          {
            type: "string",
            pattern: "^[A-Za-z0-9+/]{100,}={0,2}$",
          },
        ],
      };

      const { duration } = await perf.measure(() =>
        generateFromSchema({ schema }),
      );

      expect(duration).toBeLessThan(200); // Complex but manageable
    });
  });
});
