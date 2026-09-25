import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { ResourceLimitError, SchemaValidationError } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { expect } from "vitest";
import { fakerPlugin, generateFromSchema } from "../index";

const feature = await loadFeature(
  "../../features/review-faker-generation.feature",
);

/** ajv-formats' `byte` format: padded base64. */
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function context(): Schmock.PluginContext {
  return {
    method: "GET",
    path: "/review",
    params: {},
    query: {},
    state: new Map(),
    routeState: {},
    headers: {},
    route: { pattern: "/review" },
  };
}

async function generateWithSeeds(
  schema: JSONSchema7,
  seeds: number,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let seed = 1; seed <= seeds; seed += 1) {
    results.push(await generateFromSchema({ schema, seed }));
  }
  return results;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function nonGeneratingSchema(name: string): JSONSchema7 {
  switch (name) {
    case "not-min-length":
      return { type: "string", maxLength: 20, not: { minLength: 70_000 } };
    case "if-min-items":
      return {
        type: "array",
        items: { type: "integer" },
        maxItems: 5,
        if: { minItems: 20_000 },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
        then: { maxItems: 5 },
      };
    case "unreferenced-defs":
      return {
        type: "object",
        properties: { a: { type: "integer" } },
        required: ["a"],
        $defs: {
          big: { type: "array", items: { type: "integer" }, minItems: 50_000 },
          text: { type: "string", minLength: 70_000 },
        },
      };
    case "referenced-defs":
      return {
        type: "object",
        properties: { a: { $ref: "#/$defs/big" } },
        required: ["a"],
        $defs: {
          big: { type: "array", items: { type: "integer" }, minItems: 50_000 },
        },
      };
    default:
      throw new Error(`Unknown schema case: ${name}`);
  }
}

/** An `if` merged into its `then`, whose own bounds nothing caps. */
function conditionalSchema(name: string): JSONSchema7 {
  switch (name) {
    case "if-uncapped-items":
      return {
        type: "object",
        properties: {
          a: {
            if: {
              type: "array",
              minItems: 3_000_000,
              maxItems: 3_000_000,
              items: { type: "integer" },
            },
            // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
            then: { type: "array", items: { type: "integer" } },
          },
        },
      };
    case "if-uncapped-length":
      return {
        type: "object",
        properties: {
          a: {
            if: { type: "string", minLength: 5_000_000 },
            // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
            then: { type: "string" },
          },
        },
      };
    default:
      throw new Error(`Unknown schema case: ${name}`);
  }
}

/**
 * A schema whose only route to a 3000 x 3000 integer array (9M nodes) is
 * `keyword`: every per-node limit passes, only the node budget catches it.
 */
function nestedArrayThrough(keyword: string): JSONSchema7 {
  const big: JSONSchema7 = {
    type: "array",
    minItems: 3000,
    maxItems: 3000,
    items: {
      type: "array",
      minItems: 3000,
      maxItems: 3000,
      items: { type: "integer" },
    },
  };
  const oneItem: JSONSchema7 = {
    type: "array",
    items: { type: "integer" },
    maxItems: 1,
  };
  switch (keyword) {
    case "prefixItems":
    case "containsAll":
      Reflect.set(oneItem, keyword, [big]);
      return { type: "object", properties: { a: oneItem } };
    case "contains":
      return {
        type: "object",
        properties: { a: { ...oneItem, contains: big } },
      };
    case "dependentSchemas": {
      const schema: JSONSchema7 = {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      };
      Reflect.set(schema, "dependentSchemas", {
        a: { properties: { b: big }, required: ["b"] },
      });
      return schema;
    }
    default:
      throw new Error(`Unknown keyword: ${keyword}`);
  }
}

/** The shape each non-generating case must still produce. */
function expectFitsNonGeneratingCase(name: string, value: unknown): void {
  switch (name) {
    case "not-min-length":
      expect(typeof value).toBe("string");
      if (typeof value === "string")
        expect(value.length).toBeLessThanOrEqual(20);
      return;
    case "if-min-items":
      expect(Array.isArray(value)).toBe(true);
      if (!Array.isArray(value)) return;
      expect(value.length).toBeLessThanOrEqual(5);
      for (const item of value) expect(Number.isInteger(item)).toBe(true);
      return;
    case "unreferenced-defs":
      expect(isRecord(value)).toBe(true);
      if (isRecord(value)) expect(Number.isInteger(value.a)).toBe(true);
      return;
    default:
      throw new Error(`Unknown schema case: ${name}`);
  }
}

function expectResourceFailure(
  error: unknown,
  resource: string,
  path?: string,
): void {
  expect(error).toBeInstanceOf(ResourceLimitError);
  if (!(error instanceof ResourceLimitError)) return;
  expect(error.context).toMatchObject({ resource });
  if (path !== undefined) {
    expect(error.context).toMatchObject({ path });
    expect(error.message).toContain(path);
  }
}

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  let schema: JSONSchema7;
  let results: unknown[] = [];
  let plugin: Schmock.Plugin | undefined;
  let creationError: unknown;
  let response: unknown;
  let count: number | undefined;

  function createPlugin(): void {
    plugin = undefined;
    creationError = undefined;
    try {
      plugin = fakerPlugin({ schema, count, seed: 7 });
    } catch (error) {
      creationError = error;
    }
  }

  async function runPlugin(): Promise<void> {
    if (!plugin) throw new Error(`plugin was not created: ${creationError}`);
    response = (await plugin.process(context())).response;
  }

  Scenario(
    "A byte-format string is valid padded base64",
    ({ Given, When, Then }) => {
      Given(
        'a response schema with byte-format fields "payload" and "thumbnail"',
        () => {
          schema = {
            type: "object",
            properties: {
              payload: { type: "string", format: "byte" },
              thumbnail: { type: "string", format: "byte" },
            },
            required: ["payload", "thumbnail"],
          };
        },
      );
      When("I generate it with {int} different seeds", async (_, seeds) => {
        results = await generateWithSeeds(schema, seeds);
      });
      Then(
        "every {string} and {string} value is valid padded base64",
        (_, first: string, second: string) => {
          for (const result of results) {
            if (!isRecord(result)) throw new Error("expected an object");
            expect(result[first]).toMatch(BASE64);
            expect(result[second]).toMatch(BASE64);
          }
        },
      );
    },
  );

  ScenarioOutline(
    "A lone numeric bound outside json-schema-faker's default range is honoured",
    ({ Given, When, Then }, variables) => {
      Given("an integer schema with only {string} set to {string}", () => {
        schema = { type: "integer" };
        Reflect.set(schema, variables.keyword, Number(variables.bound));
      });
      When("I generate it with {int} different seeds", async (_, seeds) => {
        results = await generateWithSeeds(schema, seeds);
      });
      Then("every generated number satisfies {string} {string}", () => {
        const bound = Number(variables.bound);
        for (const value of results) {
          expect(typeof value).toBe("number");
          const number = Number(value);
          switch (variables.keyword) {
            case "minimum":
              expect(number).toBeGreaterThanOrEqual(bound);
              break;
            case "exclusiveMinimum":
              expect(number).toBeGreaterThan(bound);
              break;
            case "maximum":
              expect(number).toBeLessThanOrEqual(bound);
              break;
            case "exclusiveMaximum":
              expect(number).toBeLessThan(bound);
              break;
            default:
              throw new Error(`Unknown keyword ${variables.keyword}`);
          }
        }
      });
    },
  );

  Scenario(
    "An explicit count above 100 over a three-level item schema is accepted",
    ({ Given, When, Then }) => {
      Given(
        "a faker plugin over a list of users with a nested address and geo point and count {int}",
        (_, itemCount: number) => {
          count = itemCount;
          schema = {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" },
                name: { type: "string" },
                address: {
                  type: "object",
                  properties: {
                    city: { type: "string" },
                    geo: {
                      type: "object",
                      properties: {
                        lat: { type: "number" },
                        lng: { type: "number" },
                      },
                    },
                  },
                },
              },
            },
          };
          createPlugin();
        },
      );
      When("the plugin generates a response", runPlugin);
      Then("the response is a list of {int} users", (_, itemCount: number) => {
        expect(Array.isArray(response)).toBe(true);
        expect(response).toHaveLength(itemCount);
        count = undefined;
      });
    },
  );

  Scenario(
    "A 100-item array nested three levels deep is accepted",
    ({ Given, When, Then }) => {
      Given(
        "a faker plugin over an object whose third level holds a 100-item integer array",
        () => {
          count = undefined;
          schema = {
            type: "object",
            properties: {
              a: {
                type: "object",
                properties: {
                  b: {
                    type: "object",
                    properties: {
                      tags: {
                        type: "array",
                        maxItems: 100,
                        minItems: 100,
                        items: { type: "integer" },
                      },
                    },
                    required: ["tags"],
                  },
                },
                required: ["b"],
              },
            },
            required: ["a"],
          };
          createPlugin();
        },
      );
      When("the plugin generates a response", runPlugin);
      Then("the nested array holds {int} integers", (_, size: number) => {
        const tags = Reflect.get(
          Reflect.get(Reflect.get(Object(response), "a"), "b"),
          "tags",
        );
        expect(Array.isArray(tags)).toBe(true);
        expect(tags).toHaveLength(size);
      });
    },
  );

  Scenario(
    "Pattern properties fill minProperties with keys that match the pattern",
    ({ Given, When, Then, And }) => {
      Given(
        "an object schema with property {string}, pattern {string} of integers, no additional properties and minProperties {int}",
        (_, property: string, pattern: string, minProperties: number) => {
          schema = {
            type: "object",
            properties: { [property]: { type: "string" } },
            required: [property],
            patternProperties: { [pattern]: { type: "integer" } },
            additionalProperties: false,
            minProperties,
          };
        },
      );
      When("I generate it with {int} different seeds", async (_, seeds) => {
        results = await generateWithSeeds(schema, seeds);
      });
      Then(
        "every generated object has at least {int} keys",
        (_, minimum: number) => {
          for (const result of results) {
            expect(Object.keys(Object(result)).length).toBeGreaterThanOrEqual(
              minimum,
            );
          }
        },
      );
      And(
        "every key other than {string} matches {string} and holds an integer",
        (_, property: string, pattern: string) => {
          for (const result of results) {
            if (!isRecord(result)) throw new Error("expected an object");
            for (const [key, value] of Object.entries(result)) {
              if (key === property) continue;
              expect(key).toMatch(new RegExp(pattern));
              expect(Number.isInteger(value)).toBe(true);
            }
          }
        },
      );
    },
  );

  Scenario(
    "A pattern-keyed map is not generated empty",
    ({ Given, When, Then, And }) => {
      Given(
        "an object schema whose only keys match {string} and hold strings",
        (_, pattern: string) => {
          schema = {
            type: "object",
            patternProperties: { [pattern]: { type: "string" } },
          };
        },
      );
      When("I generate it with {int} different seeds", async (_, seeds) => {
        results = await generateWithSeeds(schema, seeds);
      });
      Then(
        "every generated object has at least {int} key",
        (_, minimum: number) => {
          for (const result of results) {
            expect(Object.keys(Object(result)).length).toBeGreaterThanOrEqual(
              minimum,
            );
          }
        },
      );
      And(
        "every key matches {string} and holds a string",
        (_, pattern: string) => {
          for (const result of results) {
            if (!isRecord(result)) throw new Error("expected an object");
            for (const [key, value] of Object.entries(result)) {
              expect(key).toMatch(new RegExp(pattern));
              expect(typeof value).toBe("string");
            }
          }
        },
      );
    },
  );

  Scenario(
    "A schema whose strings add up past the character budget is rejected at construction",
    ({ Given, When, Then }) => {
      Given(
        "an array schema of {int} strings that each have minLength {int}",
        (_, size: number, length: number) => {
          count = undefined;
          schema = {
            type: "array",
            minItems: size,
            maxItems: size,
            items: { type: "string", minLength: length, maxLength: length },
          };
        },
      );
      When("I create a faker plugin for it", createPlugin);
      Then(
        "plugin creation fails with resource {string}",
        (_, resource: string) => {
          expectResourceFailure(creationError, resource);
        },
      );
    },
  );

  ScenarioOutline(
    "A faker allocation argument that cannot fit in one string is rejected at construction",
    ({ Given, When, Then }, variables) => {
      Given("a string schema whose faker is {string}", () => {
        count = undefined;
        const faker = parseJson(
          variables.faker.replace("__LONG__", "y".repeat(30_000)),
        );
        schema = { type: "string" };
        Reflect.set(schema, "faker", faker);
      });
      When("I create a faker plugin for it", createPlugin);
      Then(
        "plugin creation fails with resource {string}",
        (_, resource: string) => {
          expectResourceFailure(creationError, resource);
        },
      );
    },
  );

  Scenario(
    "A pattern whose quantifier cannot fit in one string is rejected at construction",
    ({ Given, When, Then }) => {
      Given("a string schema with pattern {string}", (_, pattern: string) => {
        count = undefined;
        schema = { type: "string", pattern };
      });
      When("I create a faker plugin for it", createPlugin);
      Then(
        "plugin creation fails with resource {string}",
        (_, resource: string) => {
          expectResourceFailure(creationError, resource);
        },
      );
    },
  );

  ScenarioOutline(
    "Limits inside a subschema that never generates do not reject the schema",
    ({ Given, When, Then, And }, variables) => {
      Given("the non-generating schema {string}", () => {
        count = undefined;
        schema = nonGeneratingSchema(variables.case);
      });
      When("I create a faker plugin for it", createPlugin);
      Then("plugin creation succeeds", () => {
        expect(creationError).toBeUndefined();
      });
      And("the plugin generates a response that fits {string}", async () => {
        await runPlugin();
        expectFitsNonGeneratingCase(variables.case, response);
      });
    },
  );

  Scenario(
    "Limits inside a referenced definition still apply",
    ({ Given, When, Then }) => {
      Given("the non-generating schema {string}", (_, name: string) => {
        count = undefined;
        schema = nonGeneratingSchema(name);
      });
      When("I create a faker plugin for it", createPlugin);
      Then(
        "plugin creation fails with resource {string}",
        (_, resource: string) => {
          expectResourceFailure(creationError, resource);
        },
      );
    },
  );

  ScenarioOutline(
    "Limits inside an if beside a then reject the schema at construction",
    ({ Given, When, Then }, variables) => {
      Given("the conditional schema {string}", () => {
        count = undefined;
        schema = conditionalSchema(variables.case);
      });
      When("I create a faker plugin for it", createPlugin);
      Then(
        "plugin creation fails with resource {string} at path {string}",
        (_, _resource: string, path: string) => {
          expectResourceFailure(creationError, variables.resource, path);
        },
      );
    },
  );

  ScenarioOutline(
    "Nested arrays reached through an item keyword count against the node budget",
    ({ Given, When, Then }, variables) => {
      Given(
        "a 3000 by 3000 integer array reached only through {string}",
        () => {
          count = undefined;
          schema = nestedArrayThrough(variables.keyword);
        },
      );
      When("I create a faker plugin for it", createPlugin);
      Then(
        "plugin creation fails with resource {string}",
        (_, resource: string) => {
          expectResourceFailure(creationError, resource);
        },
      );
    },
  );

  Scenario(
    "A nested resource-limit breach names the offending schema path",
    ({ Given, When, Then }) => {
      Given(
        'an object schema whose property "a.b" declares minItems {int}',
        (_, minItems: number) => {
          count = undefined;
          schema = {
            type: "object",
            properties: {
              a: {
                type: "object",
                properties: {
                  b: { type: "array", items: { type: "integer" }, minItems },
                },
              },
            },
          };
        },
      );
      When("I create a faker plugin for it", createPlugin);
      Then(
        "plugin creation fails with resource {string} at path {string}",
        (_, resource: string, path: string) => {
          expectResourceFailure(creationError, resource, path);
        },
      );
    },
  );

  Scenario(
    "A nested faker argument breach names the faker path",
    ({ Given, When, Then }) => {
      Given(
        'an object schema whose property "a" uses faker {string} with length {int}',
        (_, method: string, length: number) => {
          count = undefined;
          const property: JSONSchema7 = { type: "string" };
          Reflect.set(property, "faker", { [method]: [{ length }] });
          schema = { type: "object", properties: { a: property } };
        },
      );
      When("I create a faker plugin for it", createPlugin);
      Then(
        "plugin creation fails with resource {string} at path {string}",
        (_, resource: string, path: string) => {
          expectResourceFailure(creationError, resource, path);
        },
      );
    },
  );

  Scenario(
    "A typo inside a union type is rejected at construction",
    ({ Given, When, Then }) => {
      Given(
        'an object schema whose property "a" has the union type {string} or {string}',
        (_, first: string, second: string) => {
          count = undefined;
          const property: JSONSchema7 = {};
          Reflect.set(property, "type", [first, second]);
          schema = { type: "object", properties: { a: property } };
        },
      );
      When("I create a faker plugin for it", createPlugin);
      Then(
        "plugin creation fails with a schema validation error at {string}",
        (_, path: string) => {
          expect(creationError).toBeInstanceOf(SchemaValidationError);
          expect(creationError).toMatchObject({
            context: { schemaPath: path },
          });
        },
      );
    },
  );

  Scenario(
    "A nullable array without items is rejected like a plain array without items",
    ({ Given, When, Then }) => {
      Given(
        'an object schema whose property "tags" has the union type {string} or {string} and no items',
        (_, first: string, second: string) => {
          count = undefined;
          const property: JSONSchema7 = {};
          Reflect.set(property, "type", [first, second]);
          schema = { type: "object", properties: { tags: property } };
        },
      );
      When("I create a faker plugin for it", createPlugin);
      Then(
        "plugin creation fails with a schema validation error at {string}",
        (_, path: string) => {
          expect(creationError).toBeInstanceOf(SchemaValidationError);
          expect(creationError).toMatchObject({
            context: { schemaPath: path },
          });
        },
      );
    },
  );

  Scenario(
    "The chance keyword is rejected at construction with its path",
    ({ Given, When, Then }) => {
      Given(
        'an object schema whose property "bio" is a string with chance {string}',
        (_, method: string) => {
          count = undefined;
          const bio: JSONSchema7 = { type: "string" };
          Reflect.set(bio, "chance", method);
          schema = { type: "object", properties: { bio } };
        },
      );
      When("I create a faker plugin for it", createPlugin);
      Then(
        "plugin creation fails with a schema validation error at {string}",
        (_, path: string) => {
          expect(creationError).toBeInstanceOf(SchemaValidationError);
          expect(creationError).toMatchObject({
            context: { schemaPath: path },
          });
        },
      );
    },
  );

  ScenarioOutline(
    "An Object.prototype member is not accepted as a faker method",
    ({ Given, When, Then }, variables) => {
      Given(
        'an object schema whose property "a" uses faker method {string}',
        () => {
          count = undefined;
          const property: JSONSchema7 = { type: "string" };
          Reflect.set(property, "faker", variables.method);
          schema = { type: "object", properties: { a: property } };
        },
      );
      When("I create a faker plugin for it", createPlugin);
      Then(
        "plugin creation fails with a schema validation error at {string}",
        (_, path: string) => {
          expect(creationError).toBeInstanceOf(SchemaValidationError);
          expect(creationError).toMatchObject({
            context: { schemaPath: path },
          });
        },
      );
    },
  );
});
