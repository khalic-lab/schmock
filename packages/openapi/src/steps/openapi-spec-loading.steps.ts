import { resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { SchmockError, schmock } from "@schmock/core";
import { expect, type MockInstance, vi } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature(
  "../../features/openapi-spec-loading.feature",
);

const MARKER = "x-schmock-discriminator-values";

const FIXTURES_DIR = resolve(import.meta.dirname, "../__fixtures__");

/**
 * The BUILT entries, for the scenario comparing them: `scripts/build.ts` swaps
 * the resolver in the browser one, so importing `src/` would compare the Node
 * build with itself.
 */
const BUILT_ENTRIES = {
  node: resolve(import.meta.dirname, "../../dist/index.js"),
  browser: resolve(import.meta.dirname, "../../dist/index.browser.js"),
};

type OpenApiFn = (options: Record<string, unknown>) => Promise<unknown>;

function animal(sound: string): Record<string, unknown> {
  return {
    type: "object",
    required: ["petType", sound],
    properties: { petType: { type: "string" }, [sound]: { type: "boolean" } },
  };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function specWithResponseSchema(schema: object): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: { title: "Loading", version: "1.0.0" },
    paths: {
      "/x": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema } },
            },
          },
        },
      },
    },
  };
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let spec: Record<string, unknown>;
  let failure: unknown;

  AfterEachScenario(() => {
    Reflect.deleteProperty(Object.prototype, MARKER);
    vi.restoreAllMocks();
  });

  const createExpectingFailure = async (): Promise<void> => {
    failure = await failureOf(openapi({ spec }));
  };

  const expectFailureCode = (_: unknown, code: string): void => {
    expect(failure).toBeInstanceOf(SchmockError);
    expect((failure as SchmockError).code).toBe(code);
  };

  Scenario(
    "A $ref through an inherited name is refused",
    ({ Given, When, Then, And }) => {
      Given(
        "a spec whose discriminator is a reference to {string}",
        (_, pointer: string) => {
          // The branch IS the component object, not a `$ref` to it, so the
          // discriminator reaches the resolver as a bare `$ref`.
          const dog = {
            type: "object",
            properties: { petType: { type: "string" } },
          };
          spec = specWithResponseSchema({ type: "object" });
          spec.components = {
            schemas: {
              Dog: dog,
              Pet: { oneOf: [dog], discriminator: { $ref: pointer } },
            },
          };
        },
      );

      When(
        "I create an openapi plugin from the spec expecting a failure",
        createExpectingFailure,
      );
      Then("creating the plugin fails with code {string}", expectFailureCode);
      And("no object in the process gained the discriminator marker", () => {
        expect(Object.hasOwn(Object.prototype, MARKER)).toBe(false);
      });
    },
  );

  Scenario(
    "A $ref pointer with too many tokens is refused",
    ({ Given, When, Then }) => {
      Given(
        "a spec whose response schema is a reference with {int} tokens",
        (_, count: number) => {
          // Three tokens reach `Deep`; the rest walk a chain that really
          // exists, so length is the only thing wrong with the pointer.
          const depth = count - 3;
          let deep: Record<string, unknown> = { type: "string" };
          for (let i = 0; i < depth; i++) deep = { a: deep };
          spec = specWithResponseSchema({
            $ref: `#/components/schemas/Deep${"/a".repeat(depth)}`,
          });
          spec.components = { schemas: { Deep: deep } };
        },
      );
      When(
        "I create an openapi plugin from the spec expecting a failure",
        createExpectingFailure,
      );
      Then("creating the plugin fails with code {string}", expectFailureCode);
    },
  );

  Scenario(
    "A $ref to nothing fails with a coded error",
    ({ Given, When, Then, And }) => {
      Given(
        "a spec whose response schema is a reference to {string}",
        (_, pointer: string) => {
          spec = specWithResponseSchema({ $ref: pointer });
          spec.components = { schemas: {} };
        },
      );
      When(
        "I create an openapi plugin from the spec expecting a failure",
        createExpectingFailure,
      );
      Then("creating the plugin fails with code {string}", expectFailureCode);
      And(
        "the failure names the missing token {string}",
        (_, token: string) => {
          expect((failure as Error).message).toContain(`"${token}"`);
        },
      );
    },
  );

  Scenario(
    "Discriminator branches that are component objects agree across builds",
    ({ Given, When, Then, And }) => {
      const responses: Record<string, { status: number; body: unknown }> = {};

      Given(
        "an inline spec whose discriminator branches are the component objects themselves",
        () => {
          // Shared objects, as a JS-built spec or a YAML alias produces: no
          // branch is a `$ref` that names its component before dereferencing.
          const cat = animal("meow");
          const dog = animal("bark");
          spec = {
            openapi: "3.0.3",
            info: { title: "Loading", version: "1.0.0" },
            paths: {
              "/pets": {
                get: {
                  responses: {
                    "200": {
                      description: "OK",
                      content: {
                        "application/json": {
                          schema: { $ref: "#/components/schemas/Pet" },
                        },
                      },
                    },
                  },
                },
              },
            },
            components: {
              schemas: {
                Pet: {
                  oneOf: [cat, dog],
                  discriminator: { propertyName: "petType" },
                },
                Cat: cat,
                Dog: dog,
              },
            },
          };
        },
      );

      When(
        "I request {string} from a mock made by the Node build and by the browser build",
        async (_, path: string) => {
          for (const [build, entry] of Object.entries(BUILT_ENTRIES)) {
            const { openapi: built } = (await import(entry)) as {
              openapi: OpenApiFn;
            };
            const mock = schmock({ state: {} });
            mock.pipe((await built({ spec, fakerSeed: 424_242 })) as never);
            responses[build] = await mock.handle("GET", path);
          }
        },
      );

      Then("both builds answer with the same pet", () => {
        expect(responses.node.status).toBe(200);
        expect(responses.browser).toEqual(responses.node);
      });

      And("the pet's discriminator names one of the components", () => {
        const pet = responses.node.body as Record<string, unknown>;
        expect(["Cat", "Dog"]).toContain(pet.petType);
      });
    },
  );

  Scenario(
    "A spec URL is not fetched under the default reference policy",
    ({ Given, When, Then, And }) => {
      let fetchSpy: MockInstance<typeof fetch>;

      Given("fetch records every request instead of sending it", () => {
        // ref-parser's built-in http resolver, which used to read the spec
        // URL under this policy, goes through global `fetch`.
        fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockRejectedValue(new Error("no network in this scenario"));
      });

      When(
        "I create an openapi plugin from the spec URL {string} expecting a failure",
        async (_, url: string) => {
          failure = await failureOf(openapi({ spec: url }));
        },
      );

      Then("creating the plugin fails with code {string}", expectFailureCode);

      And("nothing was fetched", () => {
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "A protocol-relative $ref is refused by the reference policy",
    ({ Given, When, Then }) => {
      Given(
        "a spec whose response schema is a reference to {string}",
        (_, ref: string) => {
          spec = specWithResponseSchema({ $ref: ref });
        },
      );

      When(
        "I create an openapi plugin with external references enabled expecting a failure",
        async () => {
          // ref-parser reads `//host/x` as `https://host/x`; the policy has
          // to rule on that, not on a file path spelled with two slashes.
          failure = await failureOf(
            openapi({ spec, refs: { external: true } }),
          );
        },
      );

      Then("creating the plugin fails with code {string}", expectFailureCode);
    },
  );

  Scenario(
    "A seed path that is not a regular file is refused",
    ({ Given, When, Then, And }) => {
      let seed: Record<string, string>;

      Given(
        "the Petstore spec with {string} seeded from {string}",
        (_, resource: string, path: string) => {
          seed = { [resource]: path };
        },
      );

      When(
        "I create the seeded openapi plugin expecting a failure",
        async () => {
          // A device reports a size of 0, so the size cap alone let it
          // stream whatever it produced.
          failure = await failureOf(
            openapi({ spec: `${FIXTURES_DIR}/petstore-swagger2.json`, seed }),
          );
        },
      );

      Then("creating the plugin fails with code {string}", expectFailureCode);

      And("the failure says the seed file is not a regular file", () => {
        expect((failure as Error).message).toContain("not a regular file");
      });
    },
  );
});
