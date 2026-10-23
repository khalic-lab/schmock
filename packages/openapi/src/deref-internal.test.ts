import { SchmockError } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { dereferenceInternal } from "./deref-internal";

/**
 * Direct assertions about `dereferenceInternal` for documents swagger-parser
 * will not accept, so `deref-parity.test.ts` structurally cannot cover them.
 *
 * A document whose ROOT is a `$ref` is the case that matters here: swagger-parser
 * rejects it outright ("is not a valid Openapi API definition"), so it can never
 * become a parity fixture — but the browser resolver calls this function on
 * whatever document it is handed, with nothing in front of it that would reject
 * such a document first. Do not migrate these cases into the parity file.
 */
describe("dereferenceInternal on documents outside the parity corpus", () => {
  it("dereferences a document whose root is a $ref", () => {
    const document = { $ref: "#/target", target: { value: 1 } };

    const result = dereferenceInternal(document);

    // `crawl` mutates in place everywhere EXCEPT the root, which resolves to a
    // different object. Returning the original `document` here would hand the
    // caller back an undereferenced spec.
    expect(result).toEqual({ value: 1, target: { value: 1 } });
    // The root is resolved, not reported as a cycle: no `$ref` marker survives.
    expect(result).not.toHaveProperty("$ref");
  });

  it("follows a chain of refs from the root", () => {
    const document = {
      $ref: "#/first",
      first: { $ref: "#/second" },
      second: { value: 2 },
    };

    const result = dereferenceInternal(document) as { value?: number };

    expect(result.value).toBe(2);
  });

  it("refuses a pointer through an inherited name instead of following it", () => {
    // ref-parser reads `value[token]`, so the parity corpus cannot pin this:
    // both would have handed back `Object.prototype` itself.
    for (const pointer of ["#/__proto__", "#/a/constructor/prototype"]) {
      const document = { a: { b: 1 }, use: { $ref: pointer } };
      let thrown: unknown;
      try {
        dereferenceInternal(document);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, pointer).toBeInstanceOf(SchmockError);
      expect((thrown as SchmockError).code, pointer).toBe(
        "OPENAPI_INVALID_REF",
      );
    }
  });

  it("still follows a key the document itself holds under an inherited name", () => {
    const document = {
      defs: { constructor: { type: "string" } },
      use: { $ref: "#/defs/constructor" },
    };

    const result = dereferenceInternal(document);

    expect(result.use).toEqual({ type: "string" });
  });

  it("re-joins slash-split keys without trying every run of tokens", () => {
    // `depth` nested `"a/a"` keys, reached by a pointer that leaves every
    // slash unescaped: 2 * depth tokens, each pair re-joined into one key.
    // Trying every run from the longest down took about three seconds here.
    const depth = 1000;
    let target: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < depth; i++) target = { "a/a": target };
    const document = {
      deep: target,
      use: { $ref: `#/deep${"/a/a".repeat(depth)}` },
    };

    const started = performance.now();
    const result = dereferenceInternal(document);
    const elapsed = performance.now() - started;

    expect(result.use).toEqual({ leaf: true });
    expect(elapsed).toBeLessThan(500);
  });

  it("re-joins many pointers into one slash-keyed container in linear time", () => {
    // Each pointer misses on "a" and re-joins "a/<i>". Scanning the
    // container's keys on every miss made this quadratic: about four seconds
    // here at this size, against a fraction of one.
    const count = 50_000;
    const keyed: Record<string, unknown> = {};
    const refs: Array<{ $ref: string }> = [];
    for (let i = 0; i < count; i++) {
      keyed[`a/${i}`] = { const: i };
      refs.push({ $ref: `#/keyed/a/${i}` });
    }
    const document = { keyed, refs };

    const started = performance.now();
    const result = dereferenceInternal(document);
    const elapsed = performance.now() - started;

    expect(result.refs[count - 1]).toEqual({ const: count - 1 });
    expect(elapsed).toBeLessThan(1500);
  });

  it("still returns the same object when the root is not a $ref", () => {
    const document = { a: { $ref: "#/b" }, b: { y: 2 } };

    const result = dereferenceInternal(document);

    // In-place mutation is what every real spec relies on: the parity fixtures
    // assert object identity across shared components.
    expect(result).toBe(document);
    expect(result.a).toEqual({ y: 2 });
  });
});
