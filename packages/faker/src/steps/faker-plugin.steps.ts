import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { ResourceLimitError, SchemaValidationError } from "@schmock/core";
import { define, generate as generateWithConsumerJsf } from "json-schema-faker";
import { expect, vi } from "vitest";
import { fakerPlugin, generateFromSchema, MAX_STRING_LENGTH } from "../index";
import { isJSONSchema7 } from "../validation";

const feature = await loadFeature("../../features/faker-plugin.feature");

describeFeature(feature, ({ Scenario }) => {
  let generated: unknown;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
  }

  function parseSchema(
    docString: string,
  ): Schmock.SchemaGenerationContext["schema"] {
    const parsed: unknown = JSON.parse(docString);
    if (!isJSONSchema7(parsed)) {
      throw new Error("Expected feature DocString to contain a JSON Schema");
    }
    return parsed;
  }

  Scenario(
    "Generate object from simple schema",
    ({ Given, When, Then, And }) => {
      let schema: Schmock.SchemaGenerationContext["schema"];

      Given("I create a schema plugin with:", (_, docString: string) => {
        schema = parseSchema(docString);
      });

      When("I generate data from the schema", async () => {
        generated = await generateFromSchema({ schema });
      });

      Then(
        "the generated data should have property {string} of type {string}",
        (_, prop: string, type: string) => {
          if (!isRecord(generated)) {
            throw new Error("Expected generated data to be an object");
          }
          expect(generated).toHaveProperty(prop);
          expect(typeof generated[prop]).toBe(type);
        },
      );

      And(
        "the generated data should have property {string} of type {string}",
        (_, prop: string, type: string) => {
          if (!isRecord(generated)) {
            throw new Error("Expected generated data to be an object");
          }
          expect(generated).toHaveProperty(prop);
          expect(typeof generated[prop]).toBe(type);
        },
      );
    },
  );

  Scenario(
    "Generate array of items with explicit count",
    ({ Given, When, Then }) => {
      let schema: Schmock.SchemaGenerationContext["schema"];
      let count: number;

      Given(
        "I create a schema plugin for array with count {int}:",
        (_, cnt: number, docString: string) => {
          schema = parseSchema(docString);
          count = cnt;
        },
      );

      When("I generate data from the schema", async () => {
        generated = await generateFromSchema({ schema, count });
      });

      Then(
        "the generated data should be an array of length {int}",
        (_, length: number) => {
          expect(Array.isArray(generated)).toBe(true);
          expect(generated).toHaveLength(length);
        },
      );
    },
  );

  Scenario(
    "Template preserves string values for mixed templates",
    ({ Given, When, Then }) => {
      let template: string;
      let result: unknown;

      Given(
        "I create a schema plugin with template override {string}",
        (_, tmpl: string) => {
          template = tmpl;
        },
      );

      When(
        "I generate data with param {string} set to {string}",
        async (_, paramName: string, paramValue: string) => {
          const schema = {
            type: "object" as const,
            properties: {
              value: { type: "string" as const },
            },
          };
          result = await generateFromSchema({
            schema,
            overrides: { value: template },
            params: { [paramName]: paramValue },
          });
        },
      );

      Then(
        "the template result should be the string {string}",
        (_, expected: string) => {
          if (!isRecord(result)) {
            throw new Error("Expected generated data to be an object");
          }
          expect(result.value).toBe(expected);
          expect(typeof result.value).toBe("string");
        },
      );
    },
  );

  Scenario(
    "Generate tuple positions from their respective schemas",
    ({ Given, When, Then }) => {
      let schema: Schmock.SchemaGenerationContext["schema"];

      Given(
        "I create a tuple schema with string, integer, and boolean positions",
        () => {
          schema = {
            type: "array",
            items: [
              { type: "string" },
              { type: "integer" },
              { type: "boolean" },
            ],
            minItems: 3,
            maxItems: 3,
          };
        },
      );

      When("I generate data from the schema", async () => {
        generated = await generateFromSchema({ schema, seed: 42 });
      });

      Then(
        "the generated tuple should contain string, number, and boolean values in order",
        () => {
          if (!isUnknownArray(generated)) {
            throw new Error("Expected generated tuple data to be an array");
          }
          expect(generated).toHaveLength(3);
          expect(typeof generated[0]).toBe("string");
          expect(typeof generated[1]).toBe("number");
          expect(typeof generated[2]).toBe("boolean");
        },
      );
    },
  );

  Scenario(
    "Generate a nested tuple through a schema reference",
    ({ Given, When, Then }) => {
      let schema: Schmock.SchemaGenerationContext["schema"];

      Given(
        "I create an object schema whose payload references a tuple definition",
        () => {
          schema = {
            type: "object",
            properties: {
              payload: { $ref: "#/definitions/payloadTuple" },
            },
            required: ["payload"],
            definitions: {
              payloadTuple: {
                type: "array",
                items: [
                  { type: "string" },
                  { type: "integer" },
                  { type: "boolean" },
                ],
                minItems: 3,
                maxItems: 3,
                additionalItems: false,
              },
            },
          };
        },
      );

      When("I generate data from the schema", async () => {
        generated = await generateFromSchema({ schema, seed: 42 });
      });

      Then(
        "the generated payload tuple should contain string, number, and boolean values in order",
        () => {
          if (!isRecord(generated) || !Array.isArray(generated.payload)) {
            throw new Error("Expected generated payload to be a tuple");
          }
          expect(generated.payload).toHaveLength(3);
          expect(typeof generated.payload[0]).toBe("string");
          expect(typeof generated.payload[1]).toBe("number");
          expect(typeof generated.payload[2]).toBe("boolean");
        },
      );
    },
  );

  Scenario(
    "Apply overrides to every generated array item",
    ({ Given, When, Then }) => {
      let schema: Schmock.SchemaGenerationContext["schema"];
      let count = 0;
      let name = "";

      Given(
        "I create an object array schema with count {int} and override name {string}",
        (_, requestedCount: number, overrideName: string) => {
          count = requestedCount;
          name = overrideName;
          schema = {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          };
        },
      );

      When("I generate data from the schema", async () => {
        generated = await generateFromSchema({
          schema,
          count,
          overrides: { name },
          seed: 42,
        });
      });

      Then(
        "every generated array item should have name {string}",
        (_, expectedName: string) => {
          if (!isUnknownArray(generated)) {
            throw new Error(
              "Expected generated collection data to be an array",
            );
          }
          for (const item of generated) {
            expect(item).toMatchObject({ name: expectedName });
          }
        },
      );
    },
  );

  Scenario(
    "Declared constraints win over field name guesses",
    ({ Given, When, Then, And }) => {
      let schema: Schmock.SchemaGenerationContext["schema"];
      let samples: Record<string, unknown>[] = [];

      Given("I create a schema plugin with:", (_, docString: string) => {
        schema = parseSchema(docString);
      });

      When(
        "I generate data from the schema with {int} different seeds",
        async (_, seedCount: number) => {
          samples = [];
          for (let seed = 1; seed <= seedCount; seed++) {
            const sample = await generateFromSchema({ schema, seed });
            if (!isRecord(sample)) {
              throw new Error("Expected generated data to be an object");
            }
            samples.push(sample);
          }
        },
      );

      Then(
        "every generated {string} should be an ISO date-time",
        (_, property: string) => {
          for (const sample of samples) {
            expect(String(sample[property])).toMatch(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            );
          }
        },
      );

      And(
        "every generated {string} should be an IPv4 address",
        (_, property: string) => {
          for (const sample of samples) {
            expect(String(sample[property])).toMatch(/^(\d{1,3}\.){3}\d{1,3}$/);
          }
        },
      );

      And(
        "every generated {string} should be a multiple of {int}",
        (_, property: string, multiple: number) => {
          for (const sample of samples) {
            const value = sample[property];
            expect(typeof value).toBe("number");
            // Math.abs keeps a legitimate negative multiple (-30 % 10 === -0)
            // from tripping Object.is equality against +0.
            expect(Math.abs(Number(value) % multiple)).toBe(0);
          }
        },
      );
    },
  );

  Scenario(
    "Generate useful text for an unconstrained string",
    ({ Given, When, Then }) => {
      let schema: Schmock.SchemaGenerationContext["schema"];

      Given("I create a schema plugin with:", (_, docString: string) => {
        schema = parseSchema(docString);
      });

      When("I generate data from the schema", async () => {
        generated = await generateFromSchema({ schema, seed: 42 });
      });

      Then(
        "the generated data should have a non-empty {string}",
        (_, property: string) => {
          if (!isRecord(generated)) {
            throw new Error("Expected generated data to be an object");
          }
          const value = generated[property];
          expect(typeof value).toBe("string");
          expect(value).not.toBe("");
        },
      );
    },
  );

  Scenario(
    "Seeded generation repeats its dates as the clock advances",
    ({ Given, When, Then }) => {
      let schema: Schmock.SchemaGenerationContext["schema"];
      let earlier: unknown;
      let later: unknown;

      Given("I create a schema plugin with:", (_, docString: string) => {
        schema = parseSchema(docString);
      });

      When(
        "I generate data with seed {int} five years apart",
        async (_, seed: number) => {
          vi.useFakeTimers({ toFake: ["Date"] });
          try {
            vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
            earlier = await generateFromSchema({ schema, seed });
            vi.setSystemTime(new Date("2031-03-01T00:00:00.000Z"));
            later = await generateFromSchema({ schema, seed });
          } finally {
            vi.useRealTimers();
          }
        },
      );

      Then("both generations should hold the same valid date", () => {
        if (!isRecord(earlier) || !isRecord(later)) {
          throw new Error("Expected generated data to be an object");
        }
        const value = earlier.createdAt;
        expect(typeof value).toBe("string");
        expect(Number.isNaN(Date.parse(String(value)))).toBe(false);
        expect(later).toEqual(earlier);
      });
    },
  );

  Scenario(
    "Mutating a generated item leaves later requests untouched",
    ({ Given, When, Then, And }) => {
      let schema: Schmock.SchemaGenerationContext["schema"];
      let items: unknown[];

      Given("I create a schema plugin with:", (_, docString: string) => {
        schema = parseSchema(docString);
      });

      function settingsOf(item: unknown): Record<string, unknown> {
        if (!isRecord(item) || !isRecord(item.settings)) {
          throw new Error("Expected an item carrying a settings object");
        }
        return item.settings;
      }

      When(
        "I generate two items and mutate the first item's settings",
        async () => {
          const result = await generateFromSchema({
            schema,
            count: 2,
            seed: 42,
          });
          if (!isUnknownArray(result)) {
            throw new Error("Expected generated data to be an array");
          }
          items = result;
          settingsOf(items[0]).theme = "MUTATED";
        },
      );

      Then("the second item's settings should be unchanged", () => {
        expect(settingsOf(items[1])).toEqual({ theme: "dark" });
      });

      And(
        "a fresh generation should return the original settings",
        async () => {
          const result = await generateFromSchema({
            schema,
            count: 1,
            seed: 42,
          });
          if (!isUnknownArray(result)) {
            throw new Error("Expected generated data to be an array");
          }
          expect(settingsOf(result[0])).toEqual({ theme: "dark" });
        },
      );
    },
  );

  Scenario(
    "Reject an explicit count whose output exceeds the node budget",
    ({ Given, When, Then }) => {
      let options: Schmock.FakerPluginOptions;
      let failure: unknown;

      Given(
        "I create a {int}-field array schema with count {int}",
        (_context, width: number, count: number) => {
          options = {
            schema: {
              type: "array",
              items: {
                type: "object",
                properties: Object.fromEntries(
                  Array.from({ length: width }, (_, index) => [
                    `field${index}`,
                    { type: "string" },
                  ]),
                ),
              },
            },
            count,
          };
        },
      );

      When("I create the faker plugin", () => {
        try {
          fakerPlugin(options);
        } catch (error: unknown) {
          failure = error;
        }
      });

      Then(
        "plugin creation should fail on the {string} resource",
        (_, resource: string) => {
          expect(failure).toBeInstanceOf(ResourceLimitError);
          if (!(failure instanceof ResourceLimitError)) {
            throw new Error("Expected a resource limit error");
          }
          expect(failure.context).toMatchObject({ resource });
        },
      );
    },
  );

  Scenario(
    "Reject a string length before generation can allocate it",
    ({ Given, When, Then }) => {
      let options: Schmock.FakerPluginOptions;
      let failure: unknown;

      Given(
        "I create a string schema longer than the supported maximum",
        () => {
          options = {
            schema: { type: "string", minLength: Number.MAX_SAFE_INTEGER },
          };
        },
      );

      When("I create the faker plugin", () => {
        try {
          fakerPlugin(options);
        } catch (error: unknown) {
          failure = error;
        }
      });

      Then(
        "plugin creation should fail on the {string} resource",
        (_, resource: string) => {
          expect(failure).toBeInstanceOf(ResourceLimitError);
          if (!(failure instanceof ResourceLimitError)) {
            throw new Error("Expected a resource limit error");
          }
          expect(failure.context).toMatchObject({ resource });
        },
      );
    },
  );

  Scenario(
    "Reject an indirect cycle through a local schema reference",
    ({ Given, When, Then }) => {
      let options: Schmock.FakerPluginOptions;
      let failure: unknown;

      Given(
        "I create a local definition whose child references the same definition",
        () => {
          options = {
            schema: {
              $ref: "#/$defs/node",
              $defs: {
                node: {
                  type: "object",
                  properties: { child: { $ref: "#/$defs/node" } },
                  required: ["child"],
                },
              },
            },
          };
        },
      );

      When("I create the faker plugin", () => {
        try {
          fakerPlugin(options);
        } catch (error: unknown) {
          failure = error;
        }
      });

      Then("plugin creation should fail with a circular schema error", () => {
        expect(failure).toBeInstanceOf(SchemaValidationError);
        if (!(failure instanceof SchemaValidationError)) {
          throw new Error("Expected a schema validation error");
        }
        expect(failure.message).toMatch(/circular/i);
      });
    },
  );

  Scenario(
    "Generate with object-form faker arguments",
    ({ Given, When, Then }) => {
      let schema: Schmock.Schema;

      Given(
        "I create an integer schema using object-form faker arguments from {int} to {int}",
        (_, min: number, max: number) => {
          schema = {
            type: "integer",
            faker: { "number.int": [{ min, max }] },
          };
        },
      );

      When("I generate data from the schema", async () => {
        generated = await generateFromSchema({ schema, seed: 42 });
      });

      Then(
        "the generated integer should be between {int} and {int}",
        (_, min: number, max: number) => {
          expect(generated).toBeTypeOf("number");
          expect(generated).toBeGreaterThanOrEqual(min);
          expect(generated).toBeLessThanOrEqual(max);
        },
      );
    },
  );

  Scenario(
    "Reject malformed object-form faker arguments",
    ({ Given, When, Then }) => {
      let options: Schmock.FakerPluginOptions;
      let failure: unknown;

      Given("I create a faker object with two method keys", () => {
        const schema: Schmock.Schema = {
          type: "integer",
          faker: { "number.int": [], "number.float": [] },
        };
        options = { schema };
      });

      When("I create the faker plugin", () => {
        try {
          fakerPlugin(options);
        } catch (error: unknown) {
          failure = error;
        }
      });

      Then("plugin creation should fail at the faker schema path", () => {
        expect(failure).toBeInstanceOf(SchemaValidationError);
        if (!(failure instanceof SchemaValidationError)) {
          throw new Error("Expected a schema validation error");
        }
        expect(failure.context).toMatchObject({ schemaPath: "$.faker" });
      });
    },
  );

  Scenario(
    "Ignore consumer json-schema-faker extensions",
    ({ Given, When, Then }) => {
      const extensionName = "schmockBddContaminationProbe";
      const contaminatedSchema = {
        type: "integer",
        minimum: 1,
        maximum: 2,
        [extensionName]: true,
      } as const;
      let consumerResult: unknown;
      let schmockResult: unknown;

      Given("a consumer defines a json-schema-faker extension", () => {
        define(extensionName, () => 999_999);
      });

      When(
        "the consumer and Schmock generate from the contaminated schema",
        async () => {
          [consumerResult, schmockResult] = await Promise.all([
            generateWithConsumerJsf(contaminatedSchema, { seed: 42 }),
            generateFromSchema({ schema: contaminatedSchema, seed: 42 }),
          ]);
        },
      );

      Then(
        "only the consumer generation should use its extension",
        async () => {
          expect(consumerResult).toBe(999_999);
          expect(schmockResult).toBeGreaterThanOrEqual(1);
          expect(schmockResult).toBeLessThanOrEqual(2);
          await expect(
            generateWithConsumerJsf(contaminatedSchema, { seed: 43 }),
          ).resolves.toBe(999_999);
        },
      );
    },
  );

  Scenario(
    "Reject a cycle through embedded schema IDs",
    ({ Given, When, Then }) => {
      let options: Schmock.FakerPluginOptions;
      let failure: unknown;

      Given(
        "I create embedded schemas whose relative ID references form a cycle",
        () => {
          options = {
            schema: {
              $id: "https://example.test/schemas/root.json",
              $ref: "nodes/parent.json",
              $defs: {
                parent: {
                  $id: "nodes/parent.json",
                  type: "object",
                  properties: { child: { $ref: "child.json" } },
                },
                child: {
                  $id: "nodes/child.json",
                  type: "object",
                  properties: { parent: { $ref: "parent.json" } },
                },
              },
            },
          };
        },
      );

      When("I create the faker plugin", () => {
        try {
          fakerPlugin(options);
        } catch (error: unknown) {
          failure = error;
        }
      });

      Then("plugin creation should fail with a circular schema error", () => {
        expect(failure).toBeInstanceOf(SchemaValidationError);
        if (!(failure instanceof SchemaValidationError)) {
          throw new Error("Expected a schema validation error");
        }
        expect(failure.message).toMatch(/circular/i);
      });
    },
  );

  Scenario("Reject an oversized fixed string", ({ Given, When, Then }) => {
    let options: Schmock.FakerPluginOptions;
    let failure: unknown;

    Given("I create a string schema with an oversized const value", () => {
      options = {
        schema: {
          type: "string",
          const: "x".repeat(MAX_STRING_LENGTH + 1),
        },
      };
    });

    When("I create the faker plugin", () => {
      try {
        fakerPlugin(options);
      } catch (error: unknown) {
        failure = error;
      }
    });

    Then(
      "plugin creation should fail on the {string} resource",
      (_, resource: string) => {
        expect(failure).toBeInstanceOf(ResourceLimitError);
        if (!(failure instanceof ResourceLimitError)) {
          throw new Error("Expected a resource limit error");
        }
        expect(failure.context).toMatchObject({ resource });
      },
    );
  });

  Scenario(
    "Reject an allocation-bearing faker length argument",
    ({ Given, When, Then }) => {
      let options: Schmock.FakerPluginOptions;
      let failure: unknown;

      Given(
        "I create object-form string faker arguments with an oversized length",
        () => {
          const schema: Schmock.Schema = {
            type: "string",
            faker: {
              "string.alpha": [
                {
                  length: MAX_STRING_LENGTH + 1,
                },
              ],
            },
          };
          options = { schema };
        },
      );

      When("I create the faker plugin", () => {
        try {
          fakerPlugin(options);
        } catch (error: unknown) {
          failure = error;
        }
      });

      Then(
        "plugin creation should fail on the {string} resource",
        (_, resource: string) => {
          expect(failure).toBeInstanceOf(ResourceLimitError);
          if (!(failure instanceof ResourceLimitError)) {
            throw new Error("Expected a resource limit error");
          }
          expect(failure.context).toMatchObject({ resource });
        },
      );
    },
  );

  Scenario(
    "Reject an oversized object cardinality",
    ({ Given, When, Then }) => {
      let options: Schmock.FakerPluginOptions;
      let failure: unknown;

      Given(
        "I create an object schema with an oversized minimum property count",
        () => {
          options = {
            schema: {
              type: "object",
              minProperties: Number.MAX_SAFE_INTEGER,
              additionalProperties: { type: "string" },
            },
          };
        },
      );

      When("I create the faker plugin", () => {
        try {
          fakerPlugin(options);
        } catch (error: unknown) {
          failure = error;
        }
      });

      Then(
        "plugin creation should fail on the {string} resource",
        (_, resource: string) => {
          expect(failure).toBeInstanceOf(ResourceLimitError);
          if (!(failure instanceof ResourceLimitError)) {
            throw new Error("Expected a resource limit error");
          }
          expect(failure.context).toMatchObject({ resource });
        },
      );
    },
  );

  Scenario(
    "Ignore irrelevant string limits on an integer schema",
    ({ Given, When, Then }) => {
      let schema: Schmock.SchemaGenerationContext["schema"];

      Given(
        "I create an integer schema with an irrelevant oversized maxLength",
        () => {
          schema = {
            type: "integer",
            minimum: 1,
            maximum: 2,
            maxLength: Number.MAX_SAFE_INTEGER,
          };
        },
      );

      When("I generate data from the schema", async () => {
        generated = await generateFromSchema({ schema, seed: 42 });
      });

      Then("the generated value should be an integer from 1 to 2", () => {
        expect(Number.isInteger(generated)).toBe(true);
        expect(generated).toBeGreaterThanOrEqual(1);
        expect(generated).toBeLessThanOrEqual(2);
      });
    },
  );

  Scenario(
    "Reject an oversized override after final processing",
    ({ Given, When, Then }) => {
      let generationOptions: Schmock.SchemaGenerationContext;
      let failure: unknown;

      Given(
        "I create a safe object schema with an oversized string override",
        () => {
          generationOptions = {
            schema: {
              type: "object",
              properties: { value: { type: "string" } },
            },
            overrides: { value: "x".repeat(MAX_STRING_LENGTH + 1) },
            seed: 42,
          };
        },
      );

      When("I generate data and capture the failure", async () => {
        try {
          await generateFromSchema(generationOptions);
        } catch (error: unknown) {
          failure = error;
        }
      });

      Then(
        "generation should fail on the {string} resource",
        (_, resource: string) => {
          expect(failure).toBeInstanceOf(ResourceLimitError);
          if (!(failure instanceof ResourceLimitError)) {
            throw new Error("Expected a resource limit error");
          }
          expect(failure.context).toMatchObject({ resource });
        },
      );
    },
  );

  Scenario(
    "Reject allocation-bearing positional faker counts",
    ({ Given, When, Then }) => {
      let options: Schmock.FakerPluginOptions;
      let failure: unknown;

      Given(
        "I create object-form word faker arguments with an oversized positional count",
        () => {
          const schema: Schmock.Schema = {
            type: "string",
            faker: {
              "word.words": [MAX_STRING_LENGTH + 1],
            },
          };
          options = { schema };
        },
      );

      When("I create the faker plugin", () => {
        try {
          fakerPlugin(options);
        } catch (error: unknown) {
          failure = error;
        }
      });

      Then(
        "plugin creation should fail on the {string} resource",
        (_, resource: string) => {
          expect(failure).toBeInstanceOf(ResourceLimitError);
          if (!(failure instanceof ResourceLimitError)) {
            throw new Error("Expected a resource limit error");
          }
          expect(failure.context).toMatchObject({ resource });
        },
      );
    },
  );

  Scenario(
    "Validate schemas forwarded through modern keywords",
    ({ Given, When, Then }) => {
      let options: Schmock.FakerPluginOptions;
      let failure: unknown;

      Given("I hide an invalid faker method inside prefixItems", () => {
        const schema: Schmock.Schema = {};
        Reflect.set(schema, "prefixItems", [
          { type: "string", faker: "notAReal.method" },
        ]);
        options = { schema };
      });

      When("I create the faker plugin", () => {
        try {
          fakerPlugin(options);
        } catch (error: unknown) {
          failure = error;
        }
      });

      Then("plugin creation should fail at the faker schema path", () => {
        expect(failure).toBeInstanceOf(SchemaValidationError);
        if (!(failure instanceof SchemaValidationError)) {
          throw new Error("Expected a schema validation error");
        }
        expect(failure.context).toMatchObject({
          schemaPath: expect.stringContaining(".faker"),
        });
      });
    },
  );

  Scenario(
    "Reject duplicate canonical schema identifiers",
    ({ Given, When, Then }) => {
      let options: Schmock.FakerPluginOptions;
      let failure: unknown;

      Given("I create two embedded schemas with the same canonical ID", () => {
        options = {
          schema: {
            $id: "https://example.test/root.json",
            type: "object",
            $defs: {
              first: { $id: "./shared.json", type: "string" },
              second: {
                $id: "https://example.test/shared.json",
                type: "integer",
              },
            },
          },
        };
      });

      When("I create the faker plugin", () => {
        try {
          fakerPlugin(options);
        } catch (error: unknown) {
          failure = error;
        }
      });

      Then(
        "plugin creation should fail with a duplicate identifier error",
        () => {
          expect(failure).toBeInstanceOf(SchemaValidationError);
          expect(String(failure)).toMatch(/duplicate.*identifier/i);
        },
      );
    },
  );

  Scenario(
    "Snapshot plugin options at factory creation",
    ({ Given, When, Then }) => {
      const context: Schmock.PluginContext = {
        method: "GET",
        path: "/snapshot",
        params: {},
        query: {},
        state: new Map(),
        routeState: {},
        headers: {},
        route: { pattern: "/snapshot" },
      };
      let plugin: ReturnType<typeof fakerPlugin>;
      let baseline: unknown;
      let afterMutation: unknown;

      Given(
        "I create a faker plugin and then mutate all of its source options",
        async () => {
          const valueSchema: Schmock.Schema = { type: "integer" };
          const schema: Schmock.Schema = {
            type: "array",
            items: {
              type: "object",
              properties: {
                value: valueSchema,
                label: { type: "string" },
              },
              required: ["value", "label"],
            },
          };
          const overrides = { label: "captured" };
          const options: Schmock.FakerPluginOptions = {
            schema,
            count: 1,
            overrides,
            seed: 42,
          };
          plugin = fakerPlugin(options);
          baseline = (await plugin.process(context)).response;

          valueSchema.const = 999_999;
          options.count = 2;
          overrides.label = "mutated";
          options.seed = 43;
        },
      );

      When("I process the snapshotted faker plugin", async () => {
        afterMutation = (await plugin.process(context)).response;
      });

      Then(
        "it should use only the original schema count overrides and seed",
        () => {
          expect(afterMutation).toEqual(baseline);
          expect(afterMutation).toMatchObject([{ label: "captured" }]);
        },
      );
    },
  );

  Scenario(
    "Ignore consumer extensions colliding with standard schema keywords",
    ({ Given, When, Then }) => {
      const schema = {
        type: "integer",
        minimum: 1,
        maximum: 2,
      } as const;
      let consumerValue: unknown;
      let schmockValue: unknown;

      Given("a consumer defines the json-schema-faker type keyword", () => {
        define("type", () => 999_999);
      });

      When(
        "the consumer and Schmock generate from the standard schema",
        async () => {
          [consumerValue, schmockValue] = await Promise.all([
            generateWithConsumerJsf(schema, { seed: 42 }),
            generateFromSchema({ schema, seed: 42 }),
          ]);
        },
      );

      Then("only the consumer generation should use its type extension", () => {
        expect(consumerValue).toBe(999_999);
        expect(schmockValue).toEqual(expect.any(Number));
        expect(Number(schmockValue)).toBeGreaterThanOrEqual(1);
        expect(Number(schmockValue)).toBeLessThanOrEqual(2);
      });
    },
  );
});
