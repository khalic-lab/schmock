import { resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";

const feature = await loadFeature(
  "../../features/openapi-browser-build.feature",
);

/**
 * These exercise the BUILT browser entry, not `src/`.
 *
 * `dist/index.browser.js` is a different module graph from the one every other
 * test imports: `scripts/build.ts` swaps `resolver.ts` and `seed-file.ts` for
 * their `.browser` siblings, so the thing an app actually loads is only ever
 * this file. Importing the source instead would test the Node resolver and
 * report success for a browser build that cannot boot.
 */
const browserEntry = resolve(import.meta.dirname, "../../dist/index.browser.js");

type OpenApiFn = (options: Record<string, unknown>) => Promise<unknown>;

const petSchema = {
  type: "object",
  required: ["id", "name"],
  properties: { id: { type: "integer" }, name: { type: "string" } },
};

/** A spec whose only `$ref` points inside itself — the reported case. */
function specWithInternalRef(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: { title: "Browser", version: "1.0.0" },
    paths: {
      "/pets": {
        get: {
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Pet" },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: { Pet: petSchema } },
  };
}

describeFeature(feature, ({ Scenario }) => {
  let openapi: OpenApiFn;
  let response: { status: number; body: unknown } | undefined;
  let failure: unknown;

  const build = async (
    options: Record<string, unknown>,
    path = "/pets",
  ): Promise<void> => {
    response = undefined;
    failure = undefined;
    try {
      const mock = schmock({ state: {} });
      mock.pipe((await openapi(options)) as never);
      response = await mock.handle("GET", path);
    } catch (error) {
      failure = error;
    }
  };

  const failureWith = (): { code?: string; message: string } => {
    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error & { code?: string };
    return { code: error.code, message: error.message };
  };

  Scenario(
    "An inline spec whose references point inside itself is served",
    ({ Given, When, Then, And }) => {
      Given("the browser build of the OpenAPI plugin", async () => {
        ({ openapi } = (await import(browserEntry)) as { openapi: OpenApiFn });
      });
      When("I create a mock from an inline spec with an internal reference", async () => {
        await build({ spec: specWithInternalRef() });
      });
      Then("the browser mock answers the route with 200", () => {
        expect(failure).toBeUndefined();
        expect(response?.status).toBe(200);
      });
      And("every item matches the referenced schema", () => {
        const body = response?.body as Array<Record<string, unknown>>;
        expect(Array.isArray(body)).toBe(true);
        for (const pet of body) {
          expect(typeof pet.id).toBe("number");
          expect(typeof pet.name).toBe("string");
        }
      });
    },
  );

  Scenario(
    "A reference used in two places resolves to one shared object",
    ({ Given, When, Then, And }) => {
      Given("the browser build of the OpenAPI plugin", async () => {
        ({ openapi } = (await import(browserEntry)) as { openapi: OpenApiFn });
      });
      When("I create a mock from an inline spec reusing one component twice", async () => {
        const spec = specWithInternalRef();
        (spec.paths as Record<string, unknown>)["/favourites"] = {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Pet" },
                    },
                  },
                },
              },
            },
          },
        };
        await build({ spec }, "/favourites");
      });
      Then("the browser mock answers the route with 200", () => {
        expect(failure).toBeUndefined();
        expect(response?.status).toBe(200);
      });
      And("both uses of the component produce the same fields", () => {
        const body = response?.body as Array<Record<string, unknown>>;
        for (const pet of body) {
          expect(Object.keys(pet).sort()).toEqual(["id", "name"]);
        }
      });
    },
  );

  Scenario(
    "A spec given as a file path says so instead of failing silently",
    ({ Given, When, Then, And }) => {
      Given("the browser build of the OpenAPI plugin", async () => {
        ({ openapi } = (await import(browserEntry)) as { openapi: OpenApiFn });
      });
      When("I create a mock from a spec file path", async () => {
        await build({ spec: "./petstore.yaml" });
      });
      Then("creating the mock fails with code OPENAPI_NODE_ONLY", () => {
        expect(failureWith().code).toBe("OPENAPI_NODE_ONLY");
      });
      And("the failure explains to pass the spec as an object", () => {
        expect(failureWith().message).toContain("as an object");
      });
    },
  );

  Scenario(
    "Strict validation says so instead of validating nothing",
    ({ Given, When, Then, And }) => {
      Given("the browser build of the OpenAPI plugin", async () => {
        ({ openapi } = (await import(browserEntry)) as { openapi: OpenApiFn });
      });
      When("I create a mock from an inline spec with strict validation", async () => {
        await build({ spec: specWithInternalRef(), strict: true });
      });
      Then("creating the mock fails with code OPENAPI_NODE_ONLY", () => {
        expect(failureWith().code).toBe("OPENAPI_NODE_ONLY");
      });
      And("the failure mentions strict", () => {
        expect(failureWith().message).toContain("strict");
      });
    },
  );

  Scenario(
    "External references say so instead of resolving to nothing",
    ({ Given, When, Then, And }) => {
      Given("the browser build of the OpenAPI plugin", async () => {
        ({ openapi } = (await import(browserEntry)) as { openapi: OpenApiFn });
      });
      When(
        "I create a mock from an inline spec with external references enabled",
        async () => {
          await build({
            spec: specWithInternalRef(),
            refs: { external: true },
          });
        },
      );
      Then("creating the mock fails with code OPENAPI_NODE_ONLY", () => {
        expect(failureWith().code).toBe("OPENAPI_NODE_ONLY");
      });
      And("the failure mentions external", () => {
        expect(failureWith().message).toContain("external");
      });
    },
  );

  Scenario(
    "A seed file path says so instead of seeding an empty collection",
    ({ Given, When, Then, And }) => {
      Given("the browser build of the OpenAPI plugin", async () => {
        ({ openapi } = (await import(browserEntry)) as { openapi: OpenApiFn });
      });
      When("I create a mock seeded from a file path", async () => {
        await build({
          spec: specWithInternalRef(),
          seed: { pets: "./pets.json" },
        });
      });
      Then("creating the mock fails with code OPENAPI_NODE_ONLY", () => {
        expect(failureWith().code).toBe("OPENAPI_NODE_ONLY");
      });
      And("the failure explains to pass the seed inline", () => {
        expect(failureWith().message).toContain("inline array");
      });
    },
  );

  Scenario(
    "The reference policy still rules before the browser build gives up",
    ({ Given, When, Then }) => {
      Given("the browser build of the OpenAPI plugin", async () => {
        ({ openapi } = (await import(browserEntry)) as { openapi: OpenApiFn });
      });
      When(
        "I create a mock from an inline spec with an unenabled external reference",
        async () => {
          const spec = specWithInternalRef();
          (
            (spec.components as Record<string, Record<string, unknown>>)
              .schemas as Record<string, unknown>
          ).Pet = { $ref: "./pet.json" };
          await build({ spec });
        },
      );
      // Not OPENAPI_NODE_ONLY: the ref policy decides before anything tries to
      // resolve, so a browser gets the same verdict Node gives, for the same
      // reason. Moving the seam ahead of the policy would replace an actionable
      // "enable external refs" message with "not available in a browser".
      Then("creating the mock fails with code OPENAPI_EXTERNAL_REF_BLOCKED", () => {
        expect(failureWith().code).toBe("OPENAPI_EXTERNAL_REF_BLOCKED");
      });
    },
  );

  Scenario(
    "An unresolvable reference is reported rather than dropped",
    ({ Given, When, Then }) => {
      Given("the browser build of the OpenAPI plugin", async () => {
        ({ openapi } = (await import(browserEntry)) as { openapi: OpenApiFn });
      });
      When(
        "I create a mock from an inline spec with a reference to nothing",
        async () => {
          const spec = specWithInternalRef();
          delete (spec.components as Record<string, unknown>).schemas;
          await build({ spec });
        },
      );
      Then("creating the mock fails", () => {
        expect(failure).toBeInstanceOf(Error);
      });
    },
  );
});
