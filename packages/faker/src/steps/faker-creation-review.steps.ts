import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { ResourceLimitError } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { expect } from "vitest";
import { fakerPlugin } from "../index";

const feature = await loadFeature(
  "../../features/faker-creation-review.feature",
);

function context(): Schmock.PluginContext {
  return {
    method: "GET",
    path: "/creation",
    params: {},
    query: {},
    state: new Map(),
    routeState: {},
    headers: {},
    route: { pattern: "/creation" },
  };
}

function withKeywords(
  schema: JSONSchema7,
  keywords: Record<string, unknown>,
): JSONSchema7 {
  for (const [keyword, value] of Object.entries(keywords)) {
    Reflect.set(schema, keyword, value);
  }
  return schema;
}

/** An object whose `rows` property holds `count` copies of `item`. */
function rowsOf(item: JSONSchema7, count: number): JSONSchema7 {
  return {
    type: "object",
    properties: {
      rows: { type: "array", minItems: count, maxItems: count, items: item },
    },
    required: ["rows"],
  };
}

/** A string schema that `source` alone makes `length` characters long. */
function stringOfLength(source: string, length: number): JSONSchema7 {
  switch (source) {
    case "minLength":
      return { type: "string", minLength: length };
    case "pattern":
      return { type: "string", pattern: `^[a-z]{${length}}$` };
    case "string.alpha":
      return withKeywords(
        { type: "string" },
        { faker: { "string.alpha": [{ length }] } },
      );
    default:
      throw new Error(`Unknown length source: ${source}`);
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
  let plugin: Schmock.Plugin | undefined;
  let creationError: unknown;

  function createPlugin(): void {
    plugin = undefined;
    creationError = undefined;
    try {
      plugin = fakerPlugin({ schema, seed: 7 });
    } catch (error) {
      creationError = error;
    }
  }

  async function generate(): Promise<unknown> {
    if (!plugin) throw new Error(`plugin was not created: ${creationError}`);
    return (await plugin.process(context())).response;
  }

  ScenarioOutline(
    "A contains bound above the array limit is rejected at construction",
    ({ Given, When, Then }, variables) => {
      Given(
        "an array schema of at most {int} integers whose contains sets {string} to {int}",
        (_, maxItems: number, _keyword: string, bound: number) => {
          schema = withKeywords(
            {
              type: "array",
              items: { type: "integer" },
              contains: { type: "integer" },
              maxItems,
            },
            { [variables.keyword]: bound },
          );
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
    "Small contains bounds are accepted and generate within maxItems",
    ({ Given, When, Then }) => {
      Given(
        "an array schema of at most {int} integers whose contains allows {int} to {int} matches",
        (_, maxItems: number, minContains: number, maxContains: number) => {
          schema = withKeywords(
            {
              type: "array",
              items: { type: "integer" },
              contains: { type: "integer", minimum: 5, maximum: 9 },
              minItems: 2,
              maxItems,
            },
            { minContains, maxContains },
          );
        },
      );
      When("I create a faker plugin for it", createPlugin);
      Then(
        "the plugin generates an array of at most {int} items",
        async (_, maxItems: number) => {
          expect(creationError).toBeUndefined();
          const response = await generate();
          expect(Array.isArray(response)).toBe(true);
          if (!Array.isArray(response)) return;
          expect(response.length).toBeLessThanOrEqual(maxItems);
        },
      );
    },
  );

  ScenarioOutline(
    "Strings whose certain lengths add up past the character budget are rejected at construction",
    ({ Given, When, Then }, variables) => {
      Given(
        "an object holding {int} strings that each get {int} characters from {string}",
        (_, count: number, length: number) => {
          schema = rowsOf(stringOfLength(variables.source, length), count);
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
    "A pattern that maxLength truncates is charged only up to maxLength",
    ({ Given, When, Then }) => {
      Given(
        "an object holding {int} strings whose pattern needs {int} characters but whose maxLength is {int}",
        (_, count: number, length: number, maxLength: number) => {
          schema = rowsOf(
            { type: "string", pattern: `^[a-z]{${length}}$`, maxLength },
            count,
          );
        },
      );
      When("I create a faker plugin for it", createPlugin);
      Then("plugin creation succeeds", () => {
        expect(creationError).toBeUndefined();
        expect(plugin).toBeDefined();
      });
    },
  );
});
