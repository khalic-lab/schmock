import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { generateFromSchema } from "../index";
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
});
