import { describe, expect, it } from "vitest";
import { ALL_FIELD_MAPPINGS } from "./field-mappings";
import { findBestMapping } from "./field-name-matcher";
import { generateFromSchema } from "./index";

/**
 * Generate a value for a field by placing it inside an object schema
 * and calling generateFromSchema. Returns the generated value.
 */
async function generateField(
  fieldName: string,
  schemaType: string,
): Promise<unknown> {
  const schema = {
    type: "object" as const,
    properties: {
      [fieldName]: { type: schemaType as "string" | "number" | "boolean" },
    },
  };
  const result = await generateFromSchema({ schema });
  return result[fieldName];
}

// ─── Matcher coverage: every mapping's first keyword resolves ───────

describe("Field mapping matcher coverage", () => {
  for (const mapping of ALL_FIELD_MAPPINGS) {
    const keyword = mapping.keywords[0];
    const type = mapping.schemaType ?? "string";

    it(`"${keyword}" → ${mapping.fakerMethod}`, () => {
      const match = findBestMapping(keyword, {
        type: type as "string" | "number" | "boolean",
      });
      expect(match).toBeDefined();
      expect(match?.mapping.fakerMethod).toBe(mapping.fakerMethod);
    });
  }
});

// ─── Generation: every mapping produces a value of the right type ──

describe("Field mapping generation", () => {
  // Group mappings by category for readable output
  const stringMappings = ALL_FIELD_MAPPINGS.filter(
    (m) => !m.schemaType || m.schemaType === "string",
  );
  const numberMappings = ALL_FIELD_MAPPINGS.filter(
    (m) => m.schemaType === "number",
  );
  const booleanMappings = ALL_FIELD_MAPPINGS.filter(
    (m) => m.schemaType === "boolean",
  );

  describe("string fields", () => {
    for (const mapping of stringMappings) {
      const keyword = mapping.keywords[0];

      it(`"${keyword}" generates a non-empty string`, async () => {
        const value = await generateField(keyword, "string");
        expect(typeof value).toBe("string");
        expect((value as string).length).toBeGreaterThan(0);
      });
    }
  });

  describe("number fields", () => {
    for (const mapping of numberMappings) {
      const keyword = mapping.keywords[0];

      it(`"${keyword}" generates a number`, async () => {
        const value = await generateField(keyword, "number");
        expect(typeof value).toBe("number");
        expect(Number.isFinite(value as number)).toBe(true);
      });
    }
  });

  describe("boolean fields", () => {
    for (const mapping of booleanMappings) {
      const keyword = mapping.keywords[0];

      it(`"${keyword}" generates a boolean`, async () => {
        const value = await generateField(keyword, "boolean");
        expect(typeof value).toBe("boolean");
      });
    }
  });
});

// ─── All keyword variants resolve to the same faker method ─────────

describe("All keyword variants match", () => {
  for (const mapping of ALL_FIELD_MAPPINGS) {
    if (mapping.keywords.length <= 1) continue;

    describe(`${mapping.fakerMethod}`, () => {
      for (const keyword of mapping.keywords) {
        it(`"${keyword}" matches`, () => {
          const match = findBestMapping(keyword, {
            type: (mapping.schemaType ?? "string") as
              | "string"
              | "number"
              | "boolean",
          });
          expect(match).toBeDefined();
          expect(match?.mapping.fakerMethod).toBe(mapping.fakerMethod);
        });
      }
    });
  }
});

// ─── Category-specific quality checks ──────────────────────────────

describe("Category quality checks", () => {
  async function samples(
    fieldName: string,
    type: string,
    count = 10,
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    for (let i = 0; i < count; i++) {
      results.push(await generateField(fieldName, type));
    }
    return results;
  }

  describe("Identity & Auth", () => {
    it("email contains @ and .", async () => {
      for (const v of await samples("email", "string")) {
        expect(v).toMatch(/@.*\./);
      }
    });

    it("username is a non-empty string", async () => {
      for (const v of await samples("username", "string")) {
        expect(typeof v).toBe("string");
        expect((v as string).length).toBeGreaterThan(0);
      }
    });
  });

  describe("Person", () => {
    it("firstName starts with uppercase", async () => {
      for (const v of await samples("firstName", "string")) {
        expect(v).toMatch(/^[A-Z]/);
      }
    });

    it("lastName starts with uppercase", async () => {
      for (const v of await samples("lastName", "string")) {
        expect(v).toMatch(/^[A-Z]/);
      }
    });

    it("name (fullName) contains a space", async () => {
      for (const v of await samples("name", "string")) {
        expect(v).toContain(" ");
      }
    });
  });

  describe("Contact", () => {
    it("phone contains digits", async () => {
      for (const v of await samples("phone", "string")) {
        expect(v).toMatch(/\d/);
      }
    });
  });

  describe("Address", () => {
    it("city is a capitalized string", async () => {
      for (const v of await samples("city", "string")) {
        expect(v).toMatch(/^[A-Z]/);
      }
    });

    it("zipcode matches US format", async () => {
      for (const v of await samples("zipcode", "string")) {
        expect(v).toMatch(/^\d{5}/);
      }
    });

    it("latitude is a valid number", async () => {
      for (const v of await samples("latitude", "number")) {
        expect(typeof v).toBe("number");
      }
    });

    it("longitude is a valid number", async () => {
      for (const v of await samples("longitude", "number")) {
        expect(typeof v).toBe("number");
      }
    });
  });

  describe("Internet", () => {
    it("url starts with http", async () => {
      for (const v of await samples("url", "string")) {
        expect(v).toMatch(/^https?:\/\//);
      }
    });

    it("ip_address looks like an IP", async () => {
      for (const v of await samples("ip_address", "string")) {
        expect(v).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
      }
    });
  });

  describe("IDs", () => {
    it("uuid matches UUID pattern", async () => {
      for (const v of await samples("uuid", "string")) {
        expect(v).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      }
    });

    it("userId (suffix rule) generates UUID", async () => {
      for (const v of await samples("userId", "string")) {
        expect(v).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      }
    });

    it("order_id (suffix rule) generates UUID", async () => {
      for (const v of await samples("order_id", "string")) {
        expect(v).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      }
    });
  });

  describe("Text/Content", () => {
    it("description is a paragraph (> 20 chars)", async () => {
      for (const v of await samples("description", "string")) {
        expect((v as string).length).toBeGreaterThan(20);
      }
    });

    it("title is sentence-length", async () => {
      for (const v of await samples("title", "string")) {
        expect((v as string).length).toBeGreaterThan(5);
      }
    });
  });

  describe("Business", () => {
    it("company generates a non-empty string", async () => {
      for (const v of await samples("company", "string")) {
        expect((v as string).length).toBeGreaterThan(0);
      }
    });
  });

  describe("Date/Time", () => {
    it("createdAt generates parseable dates", async () => {
      for (const v of await samples("createdAt", "string")) {
        expect(Date.parse(v as string)).not.toBeNaN();
      }
    });

    it("updatedAt generates parseable dates", async () => {
      for (const v of await samples("updatedAt", "string")) {
        expect(Date.parse(v as string)).not.toBeNaN();
      }
    });

    it("expires_at generates parseable dates", async () => {
      for (const v of await samples("expires_at", "string")) {
        expect(Date.parse(v as string)).not.toBeNaN();
      }
    });
  });

  describe("Boolean weighting", () => {
    it("isActive is mostly true (~90%)", async () => {
      const values = (await samples("isActive", "boolean", 200)) as boolean[];
      const trueCount = values.filter(Boolean).length;
      // With p=0.9 and n=200, expect 160-200 trues
      expect(trueCount).toBeGreaterThan(140);
    });

    it("isDeleted is mostly false (~5% true)", async () => {
      const values = (await samples("isDeleted", "boolean", 200)) as boolean[];
      const trueCount = values.filter(Boolean).length;
      // With p=0.05 and n=200, expect 0-30 trues
      expect(trueCount).toBeLessThan(40);
    });

    it("isVerified is mostly true (~80%)", async () => {
      const values = (await samples("isVerified", "boolean", 200)) as boolean[];
      const trueCount = values.filter(Boolean).length;
      expect(trueCount).toBeGreaterThan(120);
    });
  });

  describe("Nullable post-processing", () => {
    it("schmockNullable fields are null ~5% of the time", async () => {
      const schema = {
        type: "object" as const,
        properties: {
          value: {
            type: "string" as const,
            schmockNullable: true,
          } as any,
        },
      };

      let nullCount = 0;
      const total = 500;
      for (let i = 0; i < total; i++) {
        const result = await generateFromSchema({ schema });
        if (result.value === null) nullCount++;
      }

      // With p=0.05 and n=500, expect 10-45 nulls (generous bounds)
      expect(nullCount).toBeGreaterThan(5);
      expect(nullCount).toBeLessThan(60);
    });
  });

  describe("Composition recursion", () => {
    it("enhances fields inside allOf branches", async () => {
      const schema = {
        type: "object" as const,
        properties: {
          data: {
            allOf: [
              {
                type: "object" as const,
                properties: {
                  email: { type: "string" as const },
                  city: { type: "string" as const },
                },
              },
            ],
          },
        },
      };

      const result = await generateFromSchema({ schema });
      expect(result.data.email).toMatch(/@/);
      expect(result.data.city).toMatch(/^[A-Z]/);
    });
  });
});
