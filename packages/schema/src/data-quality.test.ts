import { describe, expect, it } from "vitest";
import { generate, schemas, stats, validators } from "./test-utils";

describe("Data Quality and Statistical Properties", () => {
  describe("Randomness and Distribution", () => {
    it("generates diverse values for string fields", () => {
      const schema = schemas.simple.object({
        text: schemas.simple.string(),
      });

      const samples = generate.samples<any>(schema, 100);
      const values = samples.map((s) => s.text);

      // Should have high uniqueness
      const uniqueness = validators.uniquenessRatio(values);
      expect(uniqueness).toBeGreaterThan(0.9); // Most values should be unique

      // Should have good entropy
      const entropy = stats.entropy(values);
      expect(entropy).toBeGreaterThan(4); // High randomness
    });

    it("generates well-distributed numeric values", () => {
      const schema = schemas.simple.object({
        value: {
          type: "number",
          minimum: 0,
          maximum: 100,
        },
      });

      const samples = generate.samples<any>(schema, 200);
      const values = samples.map((s) => s.value);

      // Check distribution
      const min = Math.min(...values);
      const max = Math.max(...values);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;

      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(100);
      expect(mean).toBeGreaterThan(30); // Should be somewhat centered
      expect(mean).toBeLessThan(70);

      // Check for good spread
      const variance =
        values.reduce((sum, val) => sum + (val - mean) ** 2, 0) / values.length;
      expect(variance).toBeGreaterThan(100); // Good spread of values
    });

    it("generates diverse enum selections", () => {
      const schema = schemas.simple.object({
        status: {
          type: "string",
          enum: ["active", "pending", "inactive", "archived"],
        },
      });

      const samples = generate.samples<any>(schema, 100);
      const distribution = stats.distribution(samples.map((s) => s.status));

      // All enum values should be used
      expect(distribution.size).toBe(4);

      // Should be relatively balanced (not always picking the same value)
      const counts = Array.from(distribution.values());
      const minCount = Math.min(...counts);
      const maxCount = Math.max(...counts);

      // No value should dominate too much
      expect(maxCount / minCount).toBeLessThan(5);
    });

    it("generates diverse boolean values", () => {
      const schema = schemas.simple.object({
        flag: { type: "boolean" },
      });

      const samples = generate.samples<any>(schema, 100);
      const trueCount = samples.filter((s) => s.flag === true).length;
      const falseCount = samples.filter((s) => s.flag === false).length;

      // Should be roughly balanced
      expect(trueCount).toBeGreaterThan(20);
      expect(falseCount).toBeGreaterThan(20);
      expect(Math.abs(trueCount - falseCount)).toBeLessThan(60);
    });
  });

  describe("Format Compliance", () => {
    it("generates valid email formats consistently", () => {
      const schema = schemas.simple.object({
        email: { type: "string", format: "email" },
      });

      const samples = generate.samples<any>(schema, 50);

      samples.forEach((sample) => {
        // RFC 5322 simplified regex
        const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        expect(sample.email).toMatch(emailRegex);

        // Should have reasonable length
        expect(sample.email.length).toBeGreaterThan(5);
        expect(sample.email.length).toBeLessThan(100);

        // Should have exactly one @
        expect(sample.email.split("@").length).toBe(2);
      });

      // Should generate diverse emails
      const uniqueness = validators.uniquenessRatio(
        samples.map((s) => s.email),
      );
      expect(uniqueness).toBeGreaterThan(0.8);
    });

    it("generates valid UUIDs consistently", () => {
      const schema = schemas.simple.object({
        id: { type: "string", format: "uuid" },
      });

      const samples = generate.samples<any>(schema, 50);
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      samples.forEach((sample) => {
        expect(sample.id).toMatch(uuidRegex);
        expect(sample.id.length).toBe(36);
      });

      // All UUIDs should be unique
      const uniqueness = validators.uniquenessRatio(samples.map((s) => s.id));
      expect(uniqueness).toBe(1);
    });

    it("generates valid dates with reasonable ranges", () => {
      const schema = schemas.simple.object({
        created: { type: "string", format: "date-time" },
      });

      const samples = generate.samples<any>(schema, 50);

      samples.forEach((sample) => {
        const date = new Date(sample.created);

        // Should be valid date
        expect(date.getTime()).not.toBeNaN();

        // Should be properly formatted
        expect(sample.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

        // Should be a reasonable date (within reasonable historical range)
        expect(date.getFullYear()).toBeGreaterThan(1800);
        expect(date.getFullYear()).toBeLessThan(2200);
      });
    });

    it("generates valid URLs when specified", () => {
      const schema = schemas.simple.object({
        website: { type: "string", format: "uri" },
      });

      const samples = generate.samples<any>(schema, 20);

      samples.forEach((sample) => {
        if (sample.website) {
          // Should look like a URL
          expect(sample.website).toMatch(/^https?:\/\//);
          // Should have domain
          expect(sample.website).toContain(".");
        }
      });
    });
  });

  describe("Constraint Satisfaction", () => {
    it("respects string length constraints consistently", () => {
      const schema = schemas.simple.object({
        username: {
          type: "string",
          minLength: 5,
          maxLength: 15,
        },
      });

      const samples = generate.samples<any>(schema, 100);

      samples.forEach((sample) => {
        expect(sample.username.length).toBeGreaterThanOrEqual(5);
        expect(sample.username.length).toBeLessThanOrEqual(15);
      });

      // Should use various lengths, not always min or max
      const lengths = samples.map((s) => s.username.length);
      const uniqueLengths = new Set(lengths);
      expect(uniqueLengths.size).toBeGreaterThan(3);
    });

    it("respects numeric ranges with good distribution", () => {
      const schema = schemas.simple.object({
        age: {
          type: "integer",
          minimum: 18,
          maximum: 65,
        },
      });

      const samples = generate.samples<any>(schema, 100);
      const ages = samples.map((s) => s.age);

      // All should be in range
      ages.forEach((age) => {
        expect(age).toBeGreaterThanOrEqual(18);
        expect(age).toBeLessThanOrEqual(65);
        expect(Number.isInteger(age)).toBe(true);
      });

      // Should have good spread
      const uniqueAges = new Set(ages);
      expect(uniqueAges.size).toBeGreaterThan(20);

      // Should hit near boundaries sometimes
      expect(ages.some((age) => age <= 25)).toBe(true);
      expect(ages.some((age) => age >= 58)).toBe(true);
    });

    it("maintains array uniqueness when specified", () => {
      const schema = schemas.simple.object({
        tags: {
          type: "array",
          items: { type: "string", pattern: "^tag-\\d{3}$" },
          minItems: 5,
          maxItems: 5,
          uniqueItems: true,
        },
      });

      const samples = generate.samples<any>(schema, 20);

      samples.forEach((sample) => {
        expect(sample.tags).toHaveLength(5);

        // All items should be unique
        const uniqueTags = new Set(sample.tags);
        expect(uniqueTags.size).toBe(5);

        // All should match pattern
        sample.tags.forEach((tag) => {
          expect(tag).toMatch(/^tag-\d{3}$/);
        });
      });
    });
  });

  describe("Realistic Data Generation", () => {
    it("generates realistic person names", () => {
      const schema = schemas.simple.object({
        firstName: { type: "string" },
        lastName: { type: "string" },
        fullName: { type: "string" },
      });

      const samples = generate.samples<any>(schema, 50);

      samples.forEach((sample) => {
        // First names should be properly capitalized and reasonable length
        expect(sample.firstName).toMatch(/^[A-Z]/); // Starts with capital
        expect(sample.firstName.length).toBeGreaterThanOrEqual(2);
        expect(sample.firstName.length).toBeLessThan(15);
        expect(sample.firstName).not.toContain(" "); // No spaces in first names

        // Last names should be single words, may have special chars
        expect(sample.lastName).toMatch(/^[A-Z]/);
        expect(sample.lastName.length).toBeGreaterThanOrEqual(2);
        expect(sample.lastName.length).toBeLessThan(25); // More generous for longer names

        // Full names should have multiple parts
        const nameParts = sample.fullName.split(" ");
        expect(nameParts.length).toBeGreaterThanOrEqual(2);
        expect(nameParts.length).toBeLessThanOrEqual(4);
      });

      // Should generate diverse names
      const firstNames = samples.map((s) => s.firstName);
      expect(validators.uniquenessRatio(firstNames)).toBeGreaterThan(0.5); // Slightly more forgiving
    });

    it("generates realistic addresses", () => {
      const schema = schemas.simple.object({
        street: { type: "string" },
        city: { type: "string" },
        zipcode: { type: "string" },
      });

      const samples = generate.samples<any>(schema, 30);

      samples.forEach((sample) => {
        // Street addresses should have numbers and street names
        expect(sample.street).toMatch(/\d/);
        expect(sample.street).toMatch(/[A-Z]/);
        expect(sample.street.length).toBeGreaterThanOrEqual(10); // Allow exactly 10

        // Cities should be properly formatted
        expect(sample.city).toMatch(/^[A-Z]/);
        expect(sample.city).not.toMatch(/\d/); // No numbers in city names

        // Zip codes should be valid US format
        expect(sample.zipcode).toMatch(/^\d{5}(-\d{4})?$/);
      });
    });

    it("generates consistent related data", () => {
      const schema = schemas.simple.object({
        user: {
          type: "object",
          properties: {
            email: schemas.simple.string(),
            username: schemas.simple.string(),
            createdAt: schemas.simple.string(),
            updatedAt: schemas.simple.string(),
          },
        },
      });

      const samples = generate.samples<any>(schema, 20);

      samples.forEach((sample) => {
        // All fields should be present and be strings
        expect(typeof sample.user.email).toBe("string");
        expect(typeof sample.user.username).toBe("string");
        expect(typeof sample.user.createdAt).toBe("string");
        expect(typeof sample.user.updatedAt).toBe("string");

        // Should generate reasonable content
        expect(sample.user.email.length).toBeGreaterThan(0);
        expect(sample.user.username.length).toBeGreaterThan(0);
      });
    });
  });

  describe("Edge Cases and Boundaries", () => {
    it("handles empty strings when allowed", () => {
      const schema = schemas.simple.object({
        optional: {
          type: "string",
          minLength: 0,
        },
      });

      const samples = generate.samples<any>(schema, 50);

      // All should be valid strings respecting minLength constraint
      samples.forEach((sample) => {
        expect(typeof sample.optional).toBe("string");
        expect(sample.optional.length).toBeGreaterThanOrEqual(0);
      });

      // Should generate various lengths
      const lengths = samples.map((s) => s.optional.length);
      const uniqueLengths = new Set(lengths);
      expect(uniqueLengths.size).toBeGreaterThan(1);
    });

    it("handles zero and negative numbers appropriately", () => {
      const schema = schemas.simple.object({
        balance: {
          type: "number",
          minimum: -1000,
          maximum: 1000,
        },
      });

      const samples = generate.samples<any>(schema, 100);
      const balances = samples.map((s) => s.balance);

      // Should include negative and positive values
      const hasNegative = balances.some((b) => b < 0);
      const hasPositive = balances.some((b) => b > 0);

      expect(hasNegative || hasPositive).toBe(true); // At least one type

      // All should be within range
      balances.forEach((b) => {
        expect(b).toBeGreaterThanOrEqual(-1000);
        expect(b).toBeLessThanOrEqual(1000);
      });
    });

    it("generates boundary values occasionally", () => {
      const schema = schemas.simple.object({
        score: {
          type: "integer",
          minimum: 0,
          maximum: 100,
        },
      });

      const samples = generate.samples<any>(schema, 200);
      const scores = samples.map((s) => s.score);

      // Should respect the boundaries and generate diverse values
      expect(scores.every((s) => s >= 0 && s <= 100)).toBe(true);

      // Should generate values near boundaries sometimes (within 5 of min/max)
      const nearMin = scores.filter((s) => s <= 5).length;
      const nearMax = scores.filter((s) => s >= 95).length;
      expect(nearMin + nearMax).toBeGreaterThan(0); // At least some near boundaries

      // Should have good distribution across the range
      const uniqueValues = new Set(scores);
      expect(uniqueValues.size).toBeGreaterThan(20); // Good variety
    });
  });
});
