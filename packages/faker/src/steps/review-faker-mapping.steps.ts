import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import type { JSONSchema7 } from "json-schema";
import { expect } from "vitest";
import { findBestMapping } from "../field-name-matcher";
import { generateFromSchema } from "../index";

const feature = await loadFeature(
  "../../features/review-faker-mapping.feature",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected an object");
  return value;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value;
}

function arrayOf(properties: Record<string, JSONSchema7>): JSONSchema7 {
  return {
    type: "array",
    items: {
      type: "object",
      properties,
      required: Object.keys(properties),
    },
  };
}

async function generateObjects(
  schema: JSONSchema7,
  count: number,
  seed = 42,
): Promise<Record<string, unknown>[]> {
  return asArray(await generateFromSchema({ schema, count, seed })).map(
    asRecord,
  );
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  Scenario(
    "A default on a name-mapped property is returned verbatim",
    ({ Given, When, Then }) => {
      let schema: JSONSchema7;
      const generated: unknown[] = [];

      Given("a schema whose name-mapped properties declare defaults", () => {
        schema = {
          type: "object",
          properties: {
            status: { type: "string", default: "active" },
            active: { type: "boolean", default: false },
            count: { type: "integer", default: 3 },
            version: { type: "string", default: "v1" },
          },
          required: ["status", "active", "count", "version"],
        };
      });

      When("I generate 20 seeded objects from it", async () => {
        for (let seed = 1; seed <= 20; seed++) {
          generated.push(await generateFromSchema({ schema, seed }));
        }
      });

      Then("every object carries exactly the declared defaults", () => {
        for (const value of generated) {
          expect(value).toEqual({
            status: "active",
            active: false,
            count: 3,
            version: "v1",
          });
        }
      });
    },
  );

  Scenario(
    "An explicit schmockTrueProbability wins over the name weighting",
    ({ Given, When, Then }) => {
      let schema: JSONSchema7;
      let items: Record<string, unknown>[] = [];

      Given(
        'a schema where "active" is never true and "deleted" is always true',
        () => {
          schema = arrayOf({
            active: {
              type: "boolean",
              schmockTrueProbability: 0,
            } as JSONSchema7,
            deleted: {
              type: "boolean",
              schmockTrueProbability: 1,
            } as JSONSchema7,
          });
        },
      );

      When("I generate 200 objects from the probability schema", async () => {
        items = await generateObjects(schema, 200);
      });

      Then('"active" is false and "deleted" is true in every object', () => {
        for (const item of items) {
          expect(item.active).toBe(false);
          expect(item.deleted).toBe(true);
        }
      });
    },
  );

  Scenario(
    "Native nullable unions null out at the documented rate",
    ({ Given, When, Then, And }) => {
      let schema: JSONSchema7;
      let items: Record<string, unknown>[] = [];

      Given(
        'a schema with an integer-or-null "version" and a string-or-null "nick"',
        () => {
          schema = arrayOf({
            version: { type: ["integer", "null"] },
            nick: { type: ["string", "null"] },
          });
        },
      );

      When("I generate 200 objects from the nullable schema", async () => {
        items = await generateObjects(schema, 200);
      });

      Then('fewer than 40 "nick" values are null', () => {
        const nulls = items.filter((item) => item.nick === null).length;
        expect(nulls).toBeLessThan(40);
      });

      And('every non-null "version" is an integer', () => {
        const versions = items
          .map((item) => item.version)
          .filter((value) => value !== null);
        expect(versions.length).toBeGreaterThan(160);
        for (const value of versions) {
          expect(Number.isInteger(value)).toBe(true);
        }
      });
    },
  );

  Scenario(
    "Date mappings emit the same ISO timestamps in every time zone",
    ({ Given, When, Then, And }) => {
      let schema: JSONSchema7;
      const runs: Record<string, unknown>[][] = [];
      const fields = ["timestamp", "birthday", "startDate", "dueDate"];

      Given(
        "a schema with timestamp, birthday, startDate and dueDate strings",
        () => {
          schema = arrayOf(
            Object.fromEntries(
              fields.map((field) => [field, { type: "string" }]),
            ),
          );
        },
      );

      When(
        "I generate it with seed {int} under {string} and under {string}",
        async (_, seed: number, first: string, second: string) => {
          const originalTz = process.env.TZ;
          try {
            for (const [zone, offset] of [
              [first, 0],
              [second, -540],
            ] as const) {
              process.env.TZ = zone;
              expect(new Date(0).getTimezoneOffset()).toBe(offset);
              runs.push(await generateObjects(schema, 5, seed));
            }
          } finally {
            if (originalTz === undefined) delete process.env.TZ;
            else process.env.TZ = originalTz;
          }
        },
      );

      Then("both runs are identical", () => {
        expect(runs).toHaveLength(2);
        expect(runs[1]).toEqual(runs[0]);
      });

      And("every date field is an ISO-8601 UTC date-time", () => {
        for (const item of runs[0]) {
          for (const field of fields) {
            expect(item[field], field).toMatch(ISO_DATE_TIME);
          }
        }
      });
    },
  );

  Scenario(
    "Boolean weighting and nullable rolls apply inside allOf",
    ({ Given, When, Then, And }) => {
      let schema: JSONSchema7;
      let items: Record<string, unknown>[] = [];

      Given(
        'an array schema whose items are an allOf over a base with "isDeleted" and a nullable "nick"',
        () => {
          schema = {
            type: "array",
            items: {
              allOf: [
                {
                  type: "object",
                  properties: {
                    isDeleted: { type: "boolean" },
                    nick: {
                      type: "string",
                      schmockNullable: true,
                    } as JSONSchema7,
                  },
                  required: ["isDeleted", "nick"],
                },
                { type: "object", properties: { id: { type: "integer" } } },
              ],
            },
          };
        },
      );

      When("I generate 400 items from the allOf schema", async () => {
        items = await generateObjects(schema, 400, 3);
      });

      Then('"isDeleted" is true in fewer than 20 percent of the items', () => {
        const trues = items.filter((item) => item.isDeleted === true).length;
        expect(trues / items.length).toBeLessThan(0.2);
      });

      And('at least one "nick" is null', () => {
        expect(items.some((item) => item.nick === null)).toBe(true);
      });
    },
  );

  Scenario(
    "A dotted override through an array index edits that item only",
    ({ Given, When, Then, And }) => {
      let schema: JSONSchema7;
      let generated: Record<string, unknown> = {};

      Given('a schema with an "addresses" array of two city objects', () => {
        schema = {
          type: "object",
          properties: {
            addresses: {
              type: "array",
              minItems: 2,
              maxItems: 2,
              items: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
          required: ["addresses"],
        };
      });

      When(
        "I generate it with the override {string} set to {string}",
        async (_, path: string, value: string) => {
          generated = asRecord(
            await generateFromSchema({
              schema,
              seed: 1,
              overrides: { [path]: value },
            }),
          );
        },
      );

      Then('"addresses" is still an array of two items', () => {
        expect(asArray(generated.addresses)).toHaveLength(2);
      });

      And("the first address city is {string}", (_, city: string) => {
        const [first, second] = asArray(generated.addresses).map(asRecord);
        expect(first.city).toBe(city);
        expect(typeof second.city).toBe("string");
        expect(second.city).not.toBe(city);
      });
    },
  );

  ScenarioOutline(
    "Short keywords do not match inside unrelated words",
    ({ Given, When, Then }, variables) => {
      let schema: JSONSchema7;
      let method: string | undefined;

      Given("a {string} property named {string}", () => {
        schema =
          variables.type === "number" ? { type: "number" } : { type: "string" };
      });

      When("the name matcher looks up a mapping for it", () => {
        method = findBestMapping(variables.field, schema)?.mapping.fakerMethod;
      });

      Then("it is not mapped to {string}", () => {
        expect(method).not.toBe(variables.method);
      });
    },
  );

  Scenario(
    "Primitive array items inherit the singular property name",
    ({ Given, When, Then }) => {
      let schema: JSONSchema7;
      let generated: Record<string, unknown> = {};

      Given('a schema with an "emails" array of strings', () => {
        schema = {
          type: "object",
          properties: {
            emails: { type: "array", items: { type: "string" }, minItems: 3 },
          },
          required: ["emails"],
        };
      });

      When("I generate an object from the emails schema", async () => {
        generated = asRecord(await generateFromSchema({ schema, seed: 1 }));
      });

      Then('every "emails" entry looks like an email address', () => {
        const emails = asArray(generated.emails);
        expect(emails.length).toBeGreaterThanOrEqual(3);
        for (const email of emails) {
          expect(email).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
        }
      });
    },
  );
});
