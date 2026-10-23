import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { SchmockError } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature(
  "../../features/openapi-spec-loading.feature",
);

const MARKER = "x-schmock-discriminator-values";

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
});
