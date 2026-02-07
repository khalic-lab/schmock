import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { generateFromSchema, schemaPlugin } from "../index";

const feature = await loadFeature("../../features/schema-plugin.feature");

describeFeature(feature, ({ Scenario }) => {
  let generated: any;
  let error: Error | null = null;

  Scenario("Generate object from simple schema", ({ Given, When, Then, And }) => {
    let schema: any;

    Given("I create a schema plugin with:", (_, docString: string) => {
      schema = JSON.parse(docString);
    });

    When("I generate data from the schema", () => {
      generated = generateFromSchema({ schema });
    });

    Then("the generated data should have property {string} of type {string}", (_, prop: string, type: string) => {
      expect(generated).toHaveProperty(prop);
      expect(typeof generated[prop]).toBe(type);
    });

    And("the generated data should have property {string} of type {string}", (_, prop: string, type: string) => {
      expect(generated).toHaveProperty(prop);
      expect(typeof generated[prop]).toBe(type);
    });
  });

  Scenario("Generate array of items with explicit count", ({ Given, When, Then }) => {
    let schema: any;
    let count: number;

    Given("I create a schema plugin for array with count {int}:", (_, cnt: number, docString: string) => {
      schema = JSON.parse(docString);
      count = cnt;
    });

    When("I generate data from the schema", () => {
      generated = generateFromSchema({ schema, count });
    });

    Then("the generated data should be an array of length {int}", (_, length: number) => {
      expect(Array.isArray(generated)).toBe(true);
      expect(generated).toHaveLength(length);
    });
  });

  Scenario("Template preserves string values for mixed templates", ({ Given, When, Then }) => {
    let template: string;
    let result: any;

    Given("I create a schema plugin with template override {string}", (_, tmpl: string) => {
      template = tmpl;
    });

    When("I generate data with param {string} set to {string}", (_, paramName: string, paramValue: string) => {
      const schema = {
        type: "object" as const,
        properties: {
          value: { type: "string" as const },
        },
      };
      result = generateFromSchema({
        schema,
        overrides: { value: template },
        params: { [paramName]: paramValue },
      });
    });

    Then("the template result should be the string {string}", (_, expected: string) => {
      expect(result.value).toBe(expected);
      expect(typeof result.value).toBe("string");
    });
  });

  Scenario("Multiple schema plugin instances do not share state", ({ Given, When, Then }) => {
    let plugin1: any;
    let plugin2: any;
    let data1: any;
    let data2: any;

    Given("I create two separate schema plugin instances", () => {
      const schema = {
        type: "object" as const,
        properties: {
          name: { type: "string" as const },
        },
        required: ["name"],
      };
      plugin1 = schemaPlugin({ schema });
      plugin2 = schemaPlugin({ schema });
    });

    When("I generate data from both instances", async () => {
      const ctx = {
        path: "/test",
        route: {},
        method: "GET" as const,
        params: {},
        query: {},
        headers: {},
        state: new Map(),
      };
      const result1 = await plugin1.process(ctx);
      const result2 = await plugin2.process(ctx);
      data1 = result1.response;
      data2 = result2.response;
    });

    Then("the data from each instance should be independently generated", () => {
      expect(data1).toBeDefined();
      expect(data2).toBeDefined();
      expect(typeof data1.name).toBe("string");
      expect(typeof data2.name).toBe("string");
    });
  });

  Scenario("Invalid schema is rejected at plugin creation time", ({ Given, Then }) => {
    Given("I attempt to create a schema plugin with invalid schema", () => {
      error = null;
      try {
        schemaPlugin({ schema: {} as any });
      } catch (e) {
        error = e as Error;
      }
    });

    Then("it should throw a SchemaValidationError", () => {
      expect(error).not.toBeNull();
      expect(error!.name).toBe("SchemaValidationError");
    });
  });

  Scenario("Faker method validation checks actual method existence", ({ Given, Then }) => {
    Given("I attempt to create a schema with faker method {string}", (_, fakerMethod: string) => {
      error = null;
      try {
        const schema = {
          type: "object" as const,
          properties: {
            field: { type: "string" as const, faker: fakerMethod },
          },
        };
        schemaPlugin({ schema: schema as any });
      } catch (e) {
        error = e as Error;
      }
    });

    Then("it should throw a SchemaValidationError with message {string}", (_, message: string) => {
      expect(error).not.toBeNull();
      expect(error!.name).toBe("SchemaValidationError");
      expect(error!.message).toContain(message);
    });
  });
});
