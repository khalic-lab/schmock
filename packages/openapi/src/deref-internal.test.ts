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

  it("still returns the same object when the root is not a $ref", () => {
    const document = { a: { $ref: "#/b" }, b: { y: 2 } };

    const result = dereferenceInternal(document);

    // In-place mutation is what every real spec relies on: the parity fixtures
    // assert object identity across shared components.
    expect(result).toBe(document);
    expect(result.a).toEqual({ y: 2 });
  });
});
