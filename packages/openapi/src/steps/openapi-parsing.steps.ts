import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { SchmockError, schmock } from "@schmock/core";
import { expect, type MockInstance, vi } from "vitest";
import type { ParsedSpec } from "../parser";
import { parseSpec } from "../parser";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/openapi-parsing.feature");
const fixturesDir = resolve(import.meta.dirname, "../__fixtures__");
const externalDir = `${fixturesDir}/external`;

describeFeature(feature, ({ Scenario }) => {
  let parsedSpec: ParsedSpec;
  let mock: Schmock.CallableMockInstance;

  Scenario("Parse Swagger 2.0 spec", ({ Given, When, Then, And }) => {
    Given("a Swagger 2.0 Petstore spec", () => {
      // Spec will be loaded in the When step
    });

    When("I create an openapi plugin from the spec", async () => {
      parsedSpec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);
    });

    Then("the parsed spec has title {string}", (_, title: string) => {
      expect(parsedSpec.title).toBe(title);
    });

    And("the parsed spec has version {string}", (_, version: string) => {
      expect(parsedSpec.version).toBe(version);
    });
  });

  // Pins the decision the removed `basePath` assertion used to hide: the field
  // was computed and never applied, so routes live at the spec's own path
  // templates. Mount a mock under a prefix with an adapter's `baseUrl` instead.
  Scenario(
    "Swagger 2.0 basePath does not prefix registered routes",
    ({ Given, When, Then, And }) => {
      let atRoot: Schmock.Response;
      let atBasePath: Schmock.Response;

      Given(
        "a Swagger 2.0 Petstore spec declaring basePath {string}",
        async (_, basePath: string) => {
          const raw = JSON.parse(
            await readFile(`${fixturesDir}/petstore-swagger2.json`, "utf8"),
          );
          expect(raw.basePath).toBe(basePath);
        },
      );

      When("I create a mock from the Swagger 2.0 spec", async () => {
        mock = schmock({ state: {} });
        mock.pipe(
          await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
        );
        atRoot = await mock.handle("GET", "/pets");
        atBasePath = await mock.handle("GET", "/api/pets");
      });

      Then("a request to {string} succeeds", (_, path: string) => {
        expect(path).toBe("/pets");
        expect(atRoot.status).toBe(200);
      });

      And("a request to {string} is not found", (_, path: string) => {
        expect(path).toBe("/api/pets");
        expect(atBasePath.status).toBe(404);
      });
    },
  );

  Scenario(
    "External file references resolve relative to the spec file",
    ({ Given, When, Then, And }) => {
      // `refs.external` alone must not switch the http resolver on: a file
      // ref is read from disk, never handed to `fetch`.
      let fetchSpy: MockInstance<typeof globalThis.fetch>;

      Given(
        "a spec in a subdirectory referencing a sibling schema file",
        () => {
          // packages/openapi/src/__fixtures__/external/spec.json refs
          // ./models.json, which is unreachable from the test process cwd.
          fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockRejectedValue(new Error("network access is not allowed here"));
        },
      );

      When("I parse it with external references enabled", async () => {
        parsedSpec = await parseSpec(`${externalDir}/spec.json`, {
          refs: { external: true },
        });
      });

      Then("the referenced schema is inlined", () => {
        expect(parsedSpec.paths[0].responses.get(200)?.schema).toMatchObject({
          type: "object",
          properties: { label: { type: "string" } },
        });
      });

      And("no network request was attempted", () => {
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      });
    },
  );

  Scenario(
    "External references are rejected by default",
    ({ Given, When, Then }) => {
      let failure: unknown;

      Given(
        "a spec in a subdirectory referencing a sibling schema file",
        () => {
          // Same fixture, no refs option.
        },
      );

      When("I parse it with default reference settings", async () => {
        failure = await parseSpec(`${externalDir}/spec.json`).catch(
          (error: unknown) => error,
        );
      });

      Then("parsing fails with code {string}", (_, code: string) => {
        expect(failure).toBeInstanceOf(SchmockError);
        expect((failure as SchmockError).code).toBe(code);
      });
    },
  );

  Scenario("Parse OpenAPI 3.0 spec", ({ Given, When, Then, And }) => {
    Given("an OpenAPI 3.0 Petstore spec", () => {
      // Spec will be loaded in the When step
    });

    When("I create an openapi plugin from the spec", async () => {
      parsedSpec = await parseSpec(`${fixturesDir}/petstore-openapi3.json`);
      mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-openapi3.json` }),
      );
    });

    Then("the parsed spec has title {string}", (_, title: string) => {
      expect(parsedSpec.title).toBe(title);
    });

    And("the parsed spec has version {string}", (_, version: string) => {
      expect(parsedSpec.version).toBe(version);
    });

    And("routes are auto-registered from the spec", async () => {
      const response = await mock.handle("GET", "/pets");
      expect(response.status).toBe(200);
    });
  });

  Scenario(
    "Route metadata carries operationId and tags",
    ({ Given, When, Then, And }) => {
      let seenOperationId: unknown;
      let seenTags: unknown;

      Given(
        "an OpenAPI 3.0 spec with operationId {string} and tag {string}",
        async (_, operationId: string, tag: string) => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: {
                openapi: "3.0.3",
                info: { title: "Metadata", version: "1.0.0" },
                paths: {
                  "/pets": {
                    get: {
                      operationId,
                      tags: [tag],
                      responses: {
                        "200": {
                          description: "OK",
                          content: {
                            "application/json": {
                              schema: {
                                type: "object",
                                properties: { ok: { type: "boolean" } },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            }),
          );
        },
      );

      When("I handle a request through a metadata probe plugin", async () => {
        const probe: Schmock.Plugin = {
          name: "metadata-probe",
          beforeRequest(context) {
            seenOperationId = context.route["openapi:operationId"];
            seenTags = context.route["openapi:tags"];
            return undefined;
          },
          process(context, response) {
            return { context, response };
          },
        };
        mock.pipe(probe);
        await mock.handle("GET", "/pets");
      });

      Then(
        "the route metadata has operationId {string}",
        (_, operationId: string) => {
          expect(seenOperationId).toBe(operationId);
        },
      );

      And("the route metadata has tag {string}", (_, tag: string) => {
        expect(Array.isArray(seenTags)).toBe(true);
        expect(seenTags as string[]).toContain(tag);
      });
    },
  );

  Scenario("Parse inline spec object", ({ Given, When, Then }) => {
    Given("an inline OpenAPI spec object", () => {
      // Inline spec prepared in When step
    });

    When("I create an openapi plugin from the inline spec", async () => {
      mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: {
            openapi: "3.0.3",
            info: { title: "Inline", version: "1.0.0" },
            paths: {
              "/hello": {
                get: {
                  responses: {
                    "200": {
                      description: "Hello",
                      content: {
                        "application/json": {
                          schema: {
                            type: "object",
                            properties: { msg: { type: "string" } },
                          },
                        },
                      },
                    },
                  },
                },
                post: {
                  responses: {
                    "201": { description: "Created" },
                  },
                },
              },
            },
          },
        }),
      );
    });

    Then("routes are registered from the inline spec", async () => {
      const response = await mock.handle("GET", "/hello");
      expect(response.status).toBe(200);
    });
  });

  // Regression pin for the normalizer's cycle guard: `$ref` dereference makes
  // two references to one component the SAME object, and the old non-backtracked
  // WeakSet blanked the second occurrence to `{}` — which then emptied the whole
  // response body. Only a real dereference exercises this path.
  Scenario(
    "A component schema referenced twice populates both properties",
    ({ Given, When, Then, And }) => {
      let response: Schmock.Response;

      Given(
        "a spec whose response references one component from two properties",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              fakerSeed: 42,
              spec: {
                openapi: "3.0.3",
                info: { title: "Shared component", version: "1.0.0" },
                paths: {
                  "/report": {
                    get: {
                      responses: {
                        "200": {
                          description: "OK",
                          content: {
                            "application/json": {
                              schema: {
                                type: "object",
                                required: ["primary", "secondary"],
                                properties: {
                                  primary: {
                                    $ref: "#/components/schemas/Tag",
                                  },
                                  secondary: {
                                    $ref: "#/components/schemas/Tag",
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
                components: {
                  schemas: {
                    Tag: {
                      type: "object",
                      required: ["label"],
                      properties: { label: { type: "string" } },
                    },
                  },
                },
              },
            }),
          );
        },
      );

      When("I request the endpoint with dynamic generation", async () => {
        response = await mock.handle("GET", "/report", {
          headers: { accept: "application/json", prefer: "dynamic=true" },
        });
      });

      Then("both referenced properties are present", () => {
        expect(response.status).toBe(200);
        const body = response.body as Record<string, unknown>;
        expect(body).toHaveProperty("primary");
        expect(body).toHaveProperty("secondary");
      });

      And("each referenced property carries its required label", () => {
        const body = response.body as Record<string, Record<string, unknown>>;
        expect(typeof body.primary.label).toBe("string");
        expect(typeof body.secondary.label).toBe("string");
      });
    },
  );
});
