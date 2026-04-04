import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { generateFromSchema } from "../index";

const feature = await loadFeature("../../features/faker-plugin.feature");

describeFeature(feature, ({ Scenario }) => {
  let generated: any;

  Scenario(
    "Generate object from simple schema",
    ({ Given, When, Then, And }) => {
      let schema: any;

      Given("I create a schema plugin with:", (_, docString: string) => {
        schema = JSON.parse(docString);
      });

      When("I generate data from the schema", async () => {
        generated = await generateFromSchema({ schema });
      });

      Then(
        "the generated data should have property {string} of type {string}",
        (_, prop: string, type: string) => {
          expect(generated).toHaveProperty(prop);
          expect(typeof generated[prop]).toBe(type);
        },
      );

      And(
        "the generated data should have property {string} of type {string}",
        (_, prop: string, type: string) => {
          expect(generated).toHaveProperty(prop);
          expect(typeof generated[prop]).toBe(type);
        },
      );
    },
  );

  Scenario(
    "Generate array of items with explicit count",
    ({ Given, When, Then }) => {
      let schema: any;
      let count: number;

      Given(
        "I create a schema plugin for array with count {int}:",
        (_, cnt: number, docString: string) => {
          schema = JSON.parse(docString);
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
      let result: any;

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
          expect(result.value).toBe(expected);
          expect(typeof result.value).toBe("string");
        },
      );
    },
  );

});
