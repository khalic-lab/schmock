import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyOverrides, determineArrayCount } from "./overrides";

describe("applyOverrides — property-based tests", () => {
  it("never adds keys not in data or overrides (shape preservation)", () => {
    // Use simple alphanumeric keys to avoid dot-path splitting edge cases,
    // since keys containing "." are treated as nested paths by applyOverrides.
    const safeKey = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,9}$/);

    fc.assert(
      fc.property(
        fc.dictionary(safeKey, fc.jsonValue()),
        fc.dictionary(safeKey, fc.jsonValue()),
        (data, overrides) => {
          const result = applyOverrides(data, overrides) as Record<
            string,
            unknown
          >;

          const allowedKeys = new Set([
            ...Object.keys(data),
            ...Object.keys(overrides),
          ]);
          for (const key of Object.keys(result)) {
            expect(allowedKeys.has(key)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("with empty overrides returns structuredClone of data", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.jsonValue()),
        (data) => {
          const result = applyOverrides(data, {});

          // Should be deep-equal but not the same reference
          expect(result).toEqual(data);
          if (Object.keys(data).length > 0) {
            expect(result).not.toBe(data);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("processTemplate idempotency: processing an already-resolved template is a no-op", () => {
    // Resolved values contain no {{ }} markers, so re-applying overrides
    // with the same non-template values should be idempotent
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string().filter((s) => !s.includes("{{")),
          age: fc.integer({ min: 0, max: 200 }),
        }),
        (data) => {
          const overrides = { name: "Alice", age: 42 };

          const first = applyOverrides(data, overrides);
          const second = applyOverrides(first as Record<string, unknown>, overrides);

          expect(second).toEqual(first);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("DANGEROUS_KEYS (__proto__, constructor, prototype) are always rejected in setNestedProperty", () => {
    const dangerousKeys = ["__proto__", "constructor", "prototype"];

    for (const dangerous of dangerousKeys) {
      // Flat key — dangerous key is skipped entirely, so no own property is set
      const flatResult = applyOverrides(
        { safe: "value" },
        { [dangerous]: "injected" },
      ) as Record<string, unknown>;
      expect(Object.hasOwn(flatResult, dangerous)).toBe(false);

      // Nested path with dangerous key at start — entire path is skipped
      const nestedStartResult = applyOverrides(
        { safe: "value" },
        { [`${dangerous}.nested`]: "injected" },
      ) as Record<string, unknown>;
      expect(Object.hasOwn(nestedStartResult, dangerous)).toBe(false);

      // Nested path with dangerous key in middle — traversal aborts
      const nestedMiddleResult = applyOverrides(
        { a: { b: "original" } },
        { [`a.${dangerous}.c`]: "injected" },
      ) as Record<string, unknown>;
      const inner = nestedMiddleResult.a as Record<string, unknown>;
      expect(Object.hasOwn(inner, dangerous)).toBe(false);

      // Nested path with dangerous key at end — final key set is blocked
      const nestedEndResult = applyOverrides(
        { a: { b: "original" } },
        { [`a.${dangerous}`]: "injected" },
      ) as Record<string, unknown>;
      const innerEnd = nestedEndResult.a as Record<string, unknown>;
      expect(Object.hasOwn(innerEnd, dangerous)).toBe(false);
    }
  });
});

describe("applyOverrides — edge cases", () => {
  it("deeply nested path 'a.b.c.d.e' creates intermediate objects", () => {
    const data = { existing: "value" };
    const result = applyOverrides(data, {
      "a.b.c.d.e": "deep",
    }) as Record<string, unknown>;

    expect(result.existing).toBe("value");
    const a = result.a as Record<string, unknown>;
    const b = a.b as Record<string, unknown>;
    const c = b.c as Record<string, unknown>;
    const d = c.d as Record<string, unknown>;
    expect(d.e).toBe("deep");
  });

  it("template '{{params.id}}' resolves correctly", () => {
    const data = { userId: "placeholder" };
    const result = applyOverrides(
      data,
      { userId: "{{params.id}}" },
      { id: "abc-123" },
    ) as Record<string, unknown>;

    expect(result.userId).toBe("abc-123");
  });

  it("mixed template 'Hello {{params.name}}!' resolves to string", () => {
    const data = { greeting: "placeholder" };
    const result = applyOverrides(
      data,
      { greeting: "Hello {{params.name}}!" },
      { name: "World" },
    ) as Record<string, unknown>;

    expect(result.greeting).toBe("Hello World!");
    expect(typeof result.greeting).toBe("string");
  });

  it("on non-object data (null) returns data unchanged", () => {
    expect(applyOverrides(null, { key: "value" })).toBe(null);
  });

  it("on non-object data (string) returns data unchanged", () => {
    expect(applyOverrides("hello", { key: "value" })).toBe("hello");
  });

  it("on non-object data (number) returns data unchanged", () => {
    expect(applyOverrides(42, { key: "value" })).toBe(42);
  });
});

describe("determineArrayCount — edge cases", () => {
  it("with explicitCount=0 returns 0", () => {
    expect(determineArrayCount({}, 0)).toBe(0);
  });

  it("with negative explicitCount returns 0", () => {
    expect(determineArrayCount({}, -1)).toBe(0);
    expect(determineArrayCount({}, -100)).toBe(0);
    expect(determineArrayCount({}, -Infinity)).toBe(0);
  });
});
