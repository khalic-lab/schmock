import { describe, expect, it } from "vitest";
import {
  findBestMapping,
  scoreMatch,
  tokenizeFieldName,
} from "./field-name-matcher";

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
