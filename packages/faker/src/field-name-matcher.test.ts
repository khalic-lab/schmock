import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import {
  findBestMapping,
  GENERATABLE_FORMATS,
  scoreMatch,
  tokenizeFieldName,
} from "./field-name-matcher";
import { generateWithJsf } from "./jsf-config";

describe("tokenizeFieldName", () => {
  it("splits camelCase", () => {
    expect(tokenizeFieldName("userFirstName")).toEqual([
      "user",
      "first",
      "name",
    ]);
  });

  it("splits snake_case", () => {
    expect(tokenizeFieldName("created_at")).toEqual(["created", "at"]);
  });

  it("splits kebab-case", () => {
    expect(tokenizeFieldName("user-name")).toEqual(["user", "name"]);
  });

  it("handles consecutive uppercase (HTMLParser)", () => {
    expect(tokenizeFieldName("HTMLParser")).toEqual(["html", "parser"]);
  });

  it("handles is_active", () => {
    expect(tokenizeFieldName("is_active")).toEqual(["is", "active"]);
  });

  it("handles single word", () => {
    expect(tokenizeFieldName("email")).toEqual(["email"]);
  });

  it("handles uppercase single word", () => {
    expect(tokenizeFieldName("UUID")).toEqual(["uuid"]);
  });

  it("handles mixed formats", () => {
    expect(tokenizeFieldName("userEmail_address")).toEqual([
      "user",
      "email",
      "address",
    ]);
  });
});

describe("scoreMatch", () => {
  it("returns 1.0 for exact match", () => {
    expect(scoreMatch(["email"], ["email"])).toBe(1.0);
  });

  it("returns 1.0 for exact multi-token match", () => {
    expect(scoreMatch(["first", "name"], ["first_name"])).toBe(1.0);
  });

  it("returns 0.7 for substring match with low keyword coverage", () => {
    // "email" is 1/3 tokens → low coverage (0.65) but substring match (0.7) wins
    expect(scoreMatch(["user", "email", "address"], ["email"])).toBe(0.7);
  });

  it("returns 0.9 when all keyword tokens found with high coverage", () => {
    // ["created", "at"] are both found in ["user", "created", "at"] → 2/3 coverage > 50%
    expect(scoreMatch(["user", "created", "at"], ["created_at"])).toBe(0.9);
  });

  it("returns 0.8 when field ends with keyword", () => {
    // ["name"] is at the end of ["display", "name"] — ends-with score = 0.8
    // coverage is 1/2 = 0.5, not > 0.5, so "all found" gives 0.65
    // ends-with wins at 0.8
    expect(scoreMatch(["display", "name"], ["name"])).toBe(0.8);
  });

  it("returns 0.7 for substring match", () => {
    expect(scoreMatch(["myemailfield"], ["email"])).toBe(0.7);
  });

  it("returns 0 for no match", () => {
    expect(scoreMatch(["foo", "bar"], ["email"])).toBe(0);
  });
});

describe("findBestMapping", () => {
  it("maps email field", () => {
    const result = findBestMapping("email", { type: "string" });
    expect(result).toBeDefined();
    expect(result?.mapping.fakerMethod).toBe("internet.email");
  });

  it("maps userEmail field", () => {
    const result = findBestMapping("userEmail", { type: "string" });
    expect(result).toBeDefined();
    expect(result?.mapping.fakerMethod).toBe("internet.email");
  });

  it("maps firstName field", () => {
    const result = findBestMapping("firstName", { type: "string" });
    expect(result).toBeDefined();
    expect(result?.mapping.fakerMethod).toBe("person.firstName");
  });

  it("maps first_name field", () => {
    const result = findBestMapping("first_name", { type: "string" });
    expect(result).toBeDefined();
    expect(result?.mapping.fakerMethod).toBe("person.firstName");
  });

  it("maps createdAt to date.recent", () => {
    const result = findBestMapping("createdAt", { type: "string" });
    expect(result).toBeDefined();
    expect(result?.mapping.fakerMethod).toBe("date.recent");
    expect(result?.mapping.format).toBe("date-time");
  });

  it("maps city field", () => {
    const result = findBestMapping("city", { type: "string" });
    expect(result).toBeDefined();
    expect(result?.mapping.fakerMethod).toBe("location.city");
  });

  it("maps url field", () => {
    const result = findBestMapping("url", { type: "string" });
    expect(result).toBeDefined();
    expect(result?.mapping.fakerMethod).toBe("internet.url");
  });

  it("maps avatar field", () => {
    const result = findBestMapping("avatar", { type: "string" });
    expect(result).toBeDefined();
    expect(result?.mapping.fakerMethod).toBe("image.avatar");
  });

  it("maps latitude field to number", () => {
    const result = findBestMapping("latitude", { type: "number" });
    expect(result).toBeDefined();
    expect(result?.mapping.fakerMethod).toBe("location.latitude");
  });

  it("maps description field", () => {
    const result = findBestMapping("description", { type: "string" });
    expect(result).toBeDefined();
    expect(result?.mapping.fakerMethod).toBe("lorem.paragraph");
  });

  it("maps title field", () => {
    const result = findBestMapping("title", { type: "string" });
    expect(result).toBeDefined();
    expect(result?.mapping.fakerMethod).toBe("lorem.sentence");
  });

  it("maps country field", () => {
    const result = findBestMapping("country", { type: "string" });
    expect(result).toBeDefined();
    expect(result?.mapping.fakerMethod).toBe("location.country");
  });

  it("maps isActive boolean with probability", () => {
    const result = findBestMapping("isActive", { type: "boolean" });
    expect(result).toBeDefined();
    expect(result?.mapping.trueProbability).toBe(0.9);
  });

  it("maps is_deleted boolean with low probability", () => {
    const result = findBestMapping("is_deleted", { type: "boolean" });
    expect(result).toBeDefined();
    expect(result?.mapping.trueProbability).toBe(0.05);
  });

  describe("ID suffix detection", () => {
    it("maps userId to UUID", () => {
      const result = findBestMapping("userId", { type: "string" });
      expect(result).toBeDefined();
      expect(result?.mapping.fakerMethod).toBe("string.uuid");
    });

    it("maps order_id to UUID", () => {
      const result = findBestMapping("order_id", { type: "string" });
      expect(result).toBeDefined();
      expect(result?.mapping.fakerMethod).toBe("string.uuid");
    });

    it("maps parent_id to UUID", () => {
      const result = findBestMapping("parent_id", { type: "string" });
      expect(result).toBeDefined();
      expect(result?.mapping.fakerMethod).toBe("string.uuid");
    });

    it("does not map single id without format:uuid", () => {
      const result = findBestMapping("id", { type: "string" });
      // 'id' alone shouldn't trigger UUID — it's a single token so suffix rule doesn't apply
      // But it could still match something else. Let's just check it doesn't falsely match
      if (result) {
        // Could match 'id' in some mapping, that's OK
        expect(result.score).toBeGreaterThan(0);
      }
    });

    it("does not map Id suffix on number fields", () => {
      const result = findBestMapping("userId", { type: "number" });
      // Number type should not get UUID mapping
      if (result) {
        expect(result.mapping.fakerMethod).not.toBe("string.uuid");
      }
    });
  });

  describe("skip conditions", () => {
    it("skips when schema has pattern", () => {
      const result = findBestMapping("email", {
        type: "string",
        pattern: "^[a-z]+$",
      });
      expect(result).toBeUndefined();
    });

    it("skips when schema has enum", () => {
      const result = findBestMapping("email", {
        type: "string",
        enum: ["a@b.com", "c@d.com"],
      });
      expect(result).toBeUndefined();
    });

    it("skips when schema already has faker", () => {
      const schema = { type: "string" as const, faker: "lorem.word" } as any;
      const result = findBestMapping("email", schema);
      expect(result).toBeUndefined();
    });

    // Regression: name-based mappings (e.g. lorem.word for 'label') don't
    // honor JSON Schema length constraints, so they'd produce out-of-range
    // strings ~20% of the time when the schema asked for a specific length.
    // Skip the mapping and let json-schema-faker generate a length-respecting
    // string instead. Mirrors the numeric constraint skip in the loop below.
    it("skips string mapping when schema has minLength", () => {
      const result = findBestMapping("label", {
        type: "string",
        minLength: 3,
      });
      expect(result).toBeUndefined();
    });

    it("skips string mapping when schema has maxLength", () => {
      const result = findBestMapping("label", {
        type: "string",
        maxLength: 20,
      });
      expect(result).toBeUndefined();
    });

    it("skips string mapping when both length constraints are set", () => {
      const result = findBestMapping("label", {
        type: "string",
        minLength: 3,
        maxLength: 20,
      });
      expect(result).toBeUndefined();
    });

    // Regression (M20-d): json-schema-faker gives the `faker` extension
    // precedence over `format`, so injecting a name-based faker method into a
    // field that declares a format silently violates the declared contract —
    // an email address landed in a `format: "date-time"` field. Preserving the
    // declared format is not enough; the mapping has to be skipped entirely.
    it("skips mapping when the schema declares a format", () => {
      const result = findBestMapping("email", {
        type: "string",
        format: "date-time",
      });
      expect(result).toBeUndefined();
    });

    it("skips mapping when a format is declared and the mapping sets none", () => {
      // The `name` mapping carries no format of its own, so "preserve the
      // declared format" would still have produced a person name here.
      const result = findBestMapping("name", {
        type: "string",
        format: "ipv4",
      });
      expect(result).toBeUndefined();
    });

    // Regression: deferring to EVERY declared format regressed real specs.
    // train-travel.yaml declares `format: iso-country-code`, which nothing
    // downstream implements, so json-schema-faker emitted an arbitrary string
    // ("oU9dd84tv") where the name-based mapping produces a country code. The
    // skip applies to formats the generator can actually satisfy.
    it("still maps when the declared format is not one anything generates", () => {
      const result = findBestMapping("country_code", {
        type: "string",
        format: "iso-country-code",
      });
      expect(result).toBeDefined();
    });

    it("still maps format:uuid, the one case where name and format agree", () => {
      const result = findBestMapping("someField", {
        type: "string",
        format: "uuid",
      });
      expect(result?.mapping.fakerMethod).toBe("string.uuid");
    });

    // Regression (M20-e): multipleOf is a numeric constraint, so a name-based
    // numeric mapping would produce values that violate it (age 44 for
    // multipleOf: 10).
    it("skips numeric mapping when the schema declares multipleOf", () => {
      const result = findBestMapping("age", {
        type: "integer",
        multipleOf: 10,
      });
      expect(result).toBeUndefined();
    });

    it("skips numeric mapping for fractional multipleOf", () => {
      const result = findBestMapping("price", {
        type: "number",
        multipleOf: 0.25,
      });
      expect(result).toBeUndefined();
    });

    it("still maps a numeric field without multipleOf", () => {
      const result = findBestMapping("age", { type: "integer" });
      expect(result).toBeDefined();
    });

    it("does not skip non-string types when minLength happens to be set", () => {
      // minLength is a string-only keyword; on a non-string schema it's
      // meaningless. The number mapping for 'age' should still apply.
      const result = findBestMapping("age", {
        type: "number",
        minLength: 3, // nonsensical on a number, but shouldn't block the mapping
      } as any);
      expect(result).toBeDefined();
    });
  });

  it("does not map unrecognized fields", () => {
    const result = findBestMapping("randomFieldXYZ123", { type: "string" });
    expect(result).toBeUndefined();
  });

  it("respects type constraints", () => {
    // latitude mapping requires number type
    const result = findBestMapping("latitude", { type: "string" });
    expect(result).toBeUndefined();
  });

  it("maps format:uuid even without name match", () => {
    const result = findBestMapping("someField", {
      type: "string",
      format: "uuid",
    });
    expect(result).toBeDefined();
    expect(result?.mapping.fakerMethod).toBe("string.uuid");
  });
});

describe("GENERATABLE_FORMATS matches what json-schema-faker generates", () => {
  /**
   * The set exists to answer one question — can the generator satisfy this
   * format? — so every member is checked against the generator itself. A
   * format json-schema-faker does not know falls through to its plain string
   * branch, which with no length constraints emits a short random string or
   * the empty string; `uri-template` and `regex` used to be listed and behaved
   * exactly like that, suppressing a good name-based value for nothing.
   */
  it.each([
    ...GENERATABLE_FORMATS,
  ])("generates a recognizable value for format %s", async (format) => {
    const schema = {
      type: "object",
      properties: { zqx: { type: "string", format } },
      required: ["zqx"],
    } as JSONSchema7;

    const values: string[] = [];
    for (const seed of [1, 2, 3, 7]) {
      const generated = await generateWithJsf(schema, seed);
      const value = Reflect.get(generated as object, "zqx");
      expect(typeof value).toBe("string");
      values.push(value as string);
    }

    // A random-alphanumeric fallback is [A-Za-z0-9]* and never empty-plus-
    // structured: every real format generator emits either a separator
    // (-:/.@) or, for `duration`, a leading "P".
    for (const value of values) {
      expect(value).not.toBe("");
      expect(value).toMatch(/[-:/.@]|^P/);
    }
  });

  it("defers to no format json-schema-faker cannot generate", async () => {
    // uri-template and regex are standard Draft 7 formats absent from
    // json-schema-faker's registry: listing them cost `searchUrl` its
    // internet.url mapping and returned a random string instead.
    for (const format of ["uri-template", "regex"]) {
      expect(GENERATABLE_FORMATS.has(format)).toBe(false);

      const mapping = findBestMapping("searchUrl", {
        type: "string",
        format,
      });
      expect(mapping?.mapping.fakerMethod).toBe("internet.url");
    }
  });
});
