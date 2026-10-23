import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { ResourceLimitError, SchemaValidationError } from "@schmock/core";
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

/** An object whose `property` reaches a uuid definition through `kind`. */
function referenceSchema(property: string, kind: string): JSONSchema7 {
  const uuid: JSONSchema7 = { type: "string", format: "uuid" };
  const reachedThrough = (
    reference: JSONSchema7,
    definitions: Pick<JSONSchema7, "$defs" | "definitions" | "$id">,
  ): JSONSchema7 => ({
    type: "object",
    properties: { [property]: reference },
    required: [property],
    ...definitions,
  });
  switch (kind) {
    case "anchor-ref":
      return reachedThrough(
        { $ref: "#sid" },
        { $defs: { S: withKeywords({ ...uuid }, { $anchor: "sid" }) } },
      );
    case "dynamic-anchor-ref":
      return reachedThrough(
        { $ref: "#sid" },
        { $defs: { S: withKeywords({ ...uuid }, { $dynamicAnchor: "sid" }) } },
      );
    case "dynamic-ref":
      return reachedThrough(withKeywords({}, { $dynamicRef: "#sid" }), {
        $defs: { S: withKeywords({ ...uuid }, { $dynamicAnchor: "sid" }) },
      });
    case "unanchored-dynamic-ref":
      return reachedThrough(withKeywords({}, { $dynamicRef: "#sid" }), {
        $defs: { S: uuid },
      });
    case "plain-name-id":
      return reachedThrough(
        { $ref: "#sid" },
        { definitions: { S: { $id: "#sid", ...uuid } } },
      );
    case "embedded-id":
      return reachedThrough(
        { $ref: "s.json" },
        { definitions: { S: { $id: "s.json", ...uuid } } },
      );
    case "uri-against-root-id":
      return reachedThrough(
        { $ref: "https://example.test/s.json" },
        {
          $id: "https://example.test/root.json",
          $defs: { S: { $id: "s.json", ...uuid } },
        },
      );
    case "pointer":
      return reachedThrough({ $ref: "#/$defs/S" }, { $defs: { S: uuid } });
    default:
      throw new Error(`Unknown reference kind: ${kind}`);
  }
}

/** A root that reaches an integer array through `wrapper`. */
function wrappedArraySchema(wrapper: string): JSONSchema7 {
  const list: JSONSchema7 = { type: "array", items: { type: "integer" } };
  switch (wrapper) {
    case "ref":
      return { $ref: "#/$defs/List", $defs: { List: list } };
    case "allof":
      return {
        description: "A wrapped list",
        allOf: [{ $ref: "#/$defs/List" }],
        $defs: { List: list },
      };
    case "anyof-null":
      return { anyOf: [list, { type: "null" }] };
    default:
      throw new Error(`Unknown root wrapper: ${wrapper}`);
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

  function createPluginWith(count: number | undefined): void {
    plugin = undefined;
    creationError = undefined;
    try {
      plugin = fakerPlugin({ schema, seed: 7, count });
    } catch (error) {
      creationError = error;
    }
  }

  function createPlugin(): void {
    createPluginWith(undefined);
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

  ScenarioOutline(
    "A faker method reached through the faker back-reference is rejected at construction",
    ({ Given, When, Then }, variables) => {
      Given("a string schema whose faker is {string}", () => {
        const faker: unknown = variables.faker.startsWith("{")
          ? JSON.parse(variables.faker)
          : variables.faker;
        schema = withKeywords({ type: "string" }, { faker });
      });
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
    "A helpers.fake template of module.method placeholders still generates",
    ({ Given, When, Then }) => {
      Given(
        "a string schema whose helpers.fake template calls string.alpha with {int} and then person.firstName",
        (_, length: number) => {
          schema = withKeywords(
            { type: "string" },
            {
              faker: {
                "helpers.fake": [
                  `{{string.alpha(${length})}}-{{person.firstName}}`,
                ],
              },
            },
          );
        },
      );
      When("I create a faker plugin for it", createPlugin);
      Then(
        "the plugin generates {int} letters, a dash and a name",
        async (_, length: number) => {
          expect(creationError).toBeUndefined();
          const response = await generate();
          expect(response).toEqual(expect.any(String));
          expect(String(response)).toMatch(
            new RegExp(`^[A-Za-z]{${length}}-\\S+`),
          );
        },
      );
    },
  );

  async function expectUuidFor(property: string): Promise<void> {
    expect(creationError).toBeUndefined();
    const response = await generate();
    expect(response).toMatchObject({
      [property]: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    });
  }

  ScenarioOutline(
    "A reference json-schema-faker cannot follow itself generates its target",
    ({ Given, When, Then }, variables) => {
      Given(
        "an object whose property {string} reaches a uuid definition through {string}",
        (_, property: string) => {
          schema = referenceSchema(property, variables.reference);
        },
      );
      When("I create a faker plugin for it", createPlugin);
      Then(
        "the plugin generates a uuid for {string}",
        async (_, property: string) => {
          await expectUuidFor(property);
        },
      );
    },
  );

  Scenario(
    "A JSON Pointer to the same definition still generates",
    ({ Given, When, Then }) => {
      Given(
        "an object whose property {string} reaches a uuid definition through {string}",
        (_, property: string, kind: string) => {
          schema = referenceSchema(property, kind);
        },
      );
      When("I create a faker plugin for it", createPlugin);
      Then(
        "the plugin generates a uuid for {string}",
        async (_, property: string) => {
          await expectUuidFor(property);
        },
      );
    },
  );

  Scenario(
    "A $dynamicRef that resolves to nothing is rejected at construction",
    ({ Given, When, Then }) => {
      Given(
        "an object whose property {string} reaches a uuid definition through {string}",
        (_, property: string, kind: string) => {
          schema = referenceSchema(property, kind);
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
    "A count above the array limit through a wrapping root is rejected at construction",
    ({ Given, When, Then }, variables) => {
      Given("a root that reaches an integer array through {string}", () => {
        schema = wrappedArraySchema(variables.wrapper);
      });
      When(
        "I create a faker plugin for it with count {int}",
        (_, count: number) => {
          createPluginWith(count);
        },
      );
      Then(
        "plugin creation fails with resource {string}",
        (_, resource: string) => {
          expectResourceFailure(creationError, resource);
        },
      );
    },
  );
});
