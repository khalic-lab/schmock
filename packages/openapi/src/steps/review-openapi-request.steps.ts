import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { SchmockError, schmock } from "@schmock/core";
import { expect, expectTypeOf, type MockInstance, vi } from "vitest";
import type {
  CrudOperationMeta,
  OnSchemaCallback,
  OnSchemaContext,
  OpenApiOptions,
  OpenApiRefPolicy,
  ResourceOverride,
  SeedConfig,
  SeedSource,
} from "../index";
import { openapi } from "../plugin";
import type { RefPolicy } from "../ref-policy";
import { isRecord } from "../utils";

const feature = await loadFeature(
  "../../features/review-openapi-request.feature",
);

const petSchema = {
  type: "object",
  required: ["id", "name"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
  },
};

const petExample = { id: 42, name: "Example" };

const petContent = {
  "application/json": {
    schema: petSchema,
    examples: { sample: { value: petExample } },
  },
};

const errorContent = {
  "application/json": {
    schema: {
      type: "object",
      properties: { error: { type: "string" } },
    },
  },
};

interface CrudSpecOptions {
  /** Callback URL expression attached to `POST /pets`, when given. */
  callbackUrl?: string;
  /** Declare `200` next to `201` on `POST /pets`. */
  createAlsoDeclares200?: boolean;
}

function crudPetSpec(options: CrudSpecOptions = {}) {
  const createResponses: Record<string, unknown> = {
    "201": { description: "Created", content: petContent },
    "400": { description: "Bad request", content: errorContent },
  };
  if (options.createAlsoDeclares200) {
    createResponses["200"] = {
      description: "Already existed",
      content: petContent,
    };
  }

  const create: Record<string, unknown> = { responses: createResponses };
  if (options.callbackUrl) {
    create.callbacks = {
      petCreated: {
        [options.callbackUrl]: {
          post: { responses: { "200": { description: "OK" } } },
        },
      },
    };
  }

  return {
    openapi: "3.0.3",
    info: { title: "Review pets", version: "1.0.0" },
    paths: {
      "/pets": {
        get: {
          responses: {
            "200": {
              description: "List",
              content: {
                "application/json": {
                  schema: { type: "array", items: petSchema },
                },
              },
            },
          },
        },
        post: create,
      },
      "/pets/{id}": {
        get: {
          responses: {
            "200": { description: "OK", content: petContent },
            "404": { description: "Not found", content: errorContent },
          },
        },
        put: {
          responses: { "200": { description: "Updated", content: petContent } },
        },
        delete: {
          responses: { "204": { description: "Deleted" } },
        },
      },
    },
  };
}

const seededBuddy: SeedConfig = { pets: [{ id: 1, name: "Buddy" }] };

function bodyName(response: Schmock.Response): unknown {
  return isRecord(response.body) ? response.body.name : undefined;
}

describeFeature(feature, ({ Scenario, ScenarioOutline, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;
  let dispatchedUrls: string[];
  let warnSpy: MockInstance<typeof console.warn>;
  let onSchemaContexts: Array<Record<string, unknown>>;
  let buildError: unknown;

  // Per scenario, not per step: vitest runs each step as its own test, so a
  // plain afterEach would drop the console spy before the When step logs.
  AfterEachScenario(() => {
    vi.restoreAllMocks();
  });

  async function buildMock(options: Omit<OpenApiOptions, "spec">) {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: crudPetSpec(), fakerSeed: 7, ...options }));
  }

  async function buildCallbackMock(callbackUrl: string, debug = false) {
    dispatchedUrls = [];
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: crudPetSpec({ callbackUrl }),
        debug,
        callbacks: {
          dispatch(request) {
            dispatchedUrls.push(request.url);
          },
        },
      }),
    );
  }

  async function captureBuildError(options: OpenApiOptions): Promise<void> {
    buildError = undefined;
    try {
      await openapi(options);
    } catch (error) {
      buildError = error;
    }
  }

  function createWithPrefer(name: string, prefer: string) {
    return mock.handle("POST", "/pets", {
      body: { name },
      headers: { prefer },
    });
  }

  function readSeededWithPrefer(prefer: string) {
    return mock.handle("GET", "/pets/1", { headers: { prefer } });
  }

  // ── Prefer is a pure simulation on CRUD mutations ───────────────────────

  Scenario(
    "A Prefer code override on a create returns the simulated body and stores nothing",
    ({ Given, When, Then }) => {
      Given("a review mock with a CRUD pet spec", async () => {
        await buildMock({});
      });
      When(
        'I create a review pet named "Alice" with Prefer "code=201"',
        async () => {
          response = await createWithPrefer("Alice", "code=201");
        },
      );
      Then("the review response status is 201", () => {
        expect(response.status).toBe(201);
      });
      When("I list the review pets", async () => {
        response = await mock.handle("GET", "/pets");
      });
      Then("the review pet list is empty", () => {
        expect(response.body).toEqual([]);
      });
    },
  );

  Scenario(
    "A Prefer dynamic create stores nothing",
    ({ Given, When, Then }) => {
      Given("a review mock with a CRUD pet spec", async () => {
        await buildMock({});
      });
      When(
        'I create a review pet named "Alice" with Prefer "dynamic=true"',
        async () => {
          response = await createWithPrefer("Alice", "dynamic=true");
        },
      );
      Then("the review response status is 201", () => {
        expect(response.status).toBe(201);
      });
      When("I list the review pets", async () => {
        response = await mock.handle("GET", "/pets");
      });
      Then("the review pet list is empty", () => {
        expect(response.body).toEqual([]);
      });
    },
  );

  Scenario(
    "A Prefer example create returns the example and stores nothing",
    ({ Given, When, Then, And }) => {
      Given("a review mock with a CRUD pet spec", async () => {
        await buildMock({});
      });
      When(
        'I create a review pet named "Alice" with Prefer "example=sample"',
        async () => {
          response = await createWithPrefer("Alice", "example=sample");
        },
      );
      Then("the review response status is 201", () => {
        expect(response.status).toBe(201);
      });
      And('the review response body name is "Example"', () => {
        expect(bodyName(response)).toBe("Example");
      });
      When("I list the review pets", async () => {
        response = await mock.handle("GET", "/pets");
      });
      Then("the review pet list is empty", () => {
        expect(response.body).toEqual([]);
      });
    },
  );

  Scenario(
    "A Prefer code override on an update leaves the stored item unchanged",
    ({ Given, When, Then }) => {
      Given(
        'a review mock with a CRUD pet spec seeded with "Buddy"',
        async () => {
          await buildMock({ seed: seededBuddy });
        },
      );
      When(
        'I rename the seeded review pet to "Renamed" with Prefer "code=200"',
        async () => {
          response = await mock.handle("PUT", "/pets/1", {
            body: { name: "Renamed" },
            headers: { prefer: "code=200" },
          });
        },
      );
      Then("the review response status is 200", () => {
        expect(response.status).toBe(200);
      });
      When("I read the seeded review pet", async () => {
        response = await mock.handle("GET", "/pets/1");
      });
      Then('the review response body name is "Buddy"', () => {
        expect(bodyName(response)).toBe("Buddy");
      });
    },
  );

  Scenario(
    "A Prefer code override on a delete keeps the stored item",
    ({ Given, When, Then }) => {
      Given(
        'a review mock with a CRUD pet spec seeded with "Buddy"',
        async () => {
          await buildMock({ seed: seededBuddy });
        },
      );
      When(
        'I delete the seeded review pet with Prefer "code=204"',
        async () => {
          response = await mock.handle("DELETE", "/pets/1", {
            headers: { prefer: "code=204" },
          });
        },
      );
      Then("the review response status is 204", () => {
        expect(response.status).toBe(204);
      });
      When("I read the seeded review pet", async () => {
        response = await mock.handle("GET", "/pets/1");
      });
      Then("the review response status is 200", () => {
        expect(response.status).toBe(200);
      });
    },
  );

  Scenario(
    "A Prefer header with no mock directive still commits the create",
    ({ Given, When, Then }) => {
      Given("a review mock with a CRUD pet spec", async () => {
        await buildMock({});
      });
      When(
        'I create a review pet named "Alice" with Prefer "return=representation"',
        async () => {
          response = await createWithPrefer("Alice", "return=representation");
        },
      );
      Then("the review response status is 201", () => {
        expect(response.status).toBe(201);
      });
      When("I list the review pets", async () => {
        response = await mock.handle("GET", "/pets");
      });
      Then('the review pet list holds one pet named "Alice"', () => {
        expect(response.body).toEqual([{ id: 1, name: "Alice" }]);
      });
    },
  );

  // ── Prefer parsing follows RFC 7240 ──────────────────────────────────────

  ScenarioOutline(
    "RFC 7240 spellings of a Prefer example are honoured",
    ({ Given, When, Then }, variables) => {
      Given(
        'a review mock with a CRUD pet spec seeded with "Buddy"',
        async () => {
          await buildMock({ seed: seededBuddy });
        },
      );
      When("I read the seeded review pet with Prefer <prefer>", async () => {
        response = await readSeededWithPrefer(variables.prefer);
      });
      Then('the review response body name is "Example"', () => {
        expect(bodyName(response)).toBe("Example");
      });
    },
  );

  Scenario(
    "An uppercase Prefer code token is honoured",
    ({ Given, When, Then }) => {
      Given(
        'a review mock with a CRUD pet spec seeded with "Buddy"',
        async () => {
          await buildMock({ seed: seededBuddy });
        },
      );
      When('I read the seeded review pet with Prefer "CODE=404"', async () => {
        response = await readSeededWithPrefer("CODE=404");
      });
      Then("the review response status is 404", () => {
        expect(response.status).toBe(404);
      });
    },
  );

  Scenario(
    "The bare Prefer dynamic token regenerates from the schema",
    ({ Given, When, Then, And }) => {
      Given(
        'a review mock with a CRUD pet spec seeded with "Buddy"',
        async () => {
          await buildMock({ seed: seededBuddy });
        },
      );
      When('I read the seeded review pet with Prefer "dynamic"', async () => {
        response = await readSeededWithPrefer("dynamic");
      });
      Then("the review response status is 200", () => {
        expect(response.status).toBe(200);
      });
      And('the review response body name is not "Buddy"', () => {
        expect(typeof bodyName(response)).toBe("string");
        expect(bodyName(response)).not.toBe("Buddy");
      });
    },
  );

  // ── onSchema sees one path shape ─────────────────────────────────────────

  Scenario(
    "onSchema receives the template path when Prefer regenerates the body",
    ({ Given, When, Then, And }) => {
      Given("a review mock recording onSchema contexts", async () => {
        onSchemaContexts = [];
        const onSchema: OnSchemaCallback = (_schema, context) => {
          onSchemaContexts.push({ ...context });
          return undefined;
        };
        await buildMock({ seed: seededBuddy, onSchema });
      });
      When('I read the seeded review pet with Prefer "code=200"', async () => {
        response = await readSeededWithPrefer("code=200");
      });
      Then('every recorded onSchema path is "/pets/:id"', () => {
        expect(onSchemaContexts.length).toBeGreaterThan(0);
        for (const context of onSchemaContexts) {
          expect(context.path).toBe("/pets/:id");
        }
      });
      And(
        "every recorded onSchema context has only the documented keys",
        () => {
          for (const context of onSchemaContexts) {
            expect(Object.keys(context).sort()).toEqual([
              "headers",
              "method",
              "params",
              "path",
              "query",
            ]);
            expect(context.params).toEqual({ id: "1" });
          }
        },
      );
    },
  );

  // ── Callback URL expressions ─────────────────────────────────────────────

  Scenario(
    "A callback URL embeds an integer id from the response body",
    ({ Given, When, Then }) => {
      Given(
        'a review mock with a callback URL "{$request.body#/callbackUrl}/pets/{$response.body#/id}"',
        async () => {
          await buildCallbackMock(
            "{$request.body#/callbackUrl}/pets/{$response.body#/id}",
          );
        },
      );
      When(
        'I create a review pet with callback URL "https://hooks.example"',
        async () => {
          response = await mock.handle("POST", "/pets", {
            body: { name: "Rex", callbackUrl: "https://hooks.example" },
          });
        },
      );
      Then(
        'the review callback was dispatched to "https://hooks.example/pets/1"',
        () => {
          expect(dispatchedUrls).toEqual(["https://hooks.example/pets/1"]);
        },
      );
    },
  );

  Scenario(
    "A callback header expression matches a mixed-case request header",
    ({ Given, When, Then }) => {
      Given(
        'a review mock with a callback URL "{$request.header.X-Hook}/events"',
        async () => {
          await buildCallbackMock("{$request.header.X-Hook}/events");
        },
      );
      When(
        'I create a review pet sending header "X-Hook" as "https://hooks.example"',
        async () => {
          response = await mock.handle("POST", "/pets", {
            body: { name: "Rex" },
            headers: { "X-Hook": "https://hooks.example" },
          });
        },
      );
      Then(
        'the review callback was dispatched to "https://hooks.example/events"',
        () => {
          expect(dispatchedUrls).toEqual(["https://hooks.example/events"]);
        },
      );
    },
  );

  Scenario(
    "A callback URL with an unresolvable expression is skipped and debug mode says why",
    ({ Given, When, Then, And }) => {
      Given(
        'a review mock in debug mode with a callback URL "{$request.body#/callbackUrl}/pets/{$request.body#/missing}"',
        async () => {
          await buildCallbackMock(
            "{$request.body#/callbackUrl}/pets/{$request.body#/missing}",
            true,
          );
        },
      );
      When(
        'I create a review pet with callback URL "https://hooks.example"',
        async () => {
          response = await mock.handle("POST", "/pets", {
            body: { name: "Rex", callbackUrl: "https://hooks.example" },
          });
        },
      );
      Then("no review callback was dispatched", () => {
        expect(response.status).toBe(201);
        expect(dispatchedUrls).toEqual([]);
      });
      And(
        'a warning names the unresolved expression "$request.body#/missing"',
        () => {
          const messages = warnSpy.mock.calls.map((call) =>
            call.map(String).join(" "),
          );
          expect(
            messages.some((message) =>
              message.includes("$request.body#/missing"),
            ),
          ).toBe(true);
        },
      );
    },
  );

  Scenario(
    "A callback the client did not opt into is skipped quietly",
    ({ Given, When, Then, And }) => {
      Given(
        'a review mock with a callback URL "{$request.body#/callbackUrl}/pets/{$response.body#/id}"',
        async () => {
          await buildCallbackMock(
            "{$request.body#/callbackUrl}/pets/{$response.body#/id}",
          );
        },
      );
      When("I create a review pet without a callback URL", async () => {
        response = await mock.handle("POST", "/pets", {
          body: { name: "Rex" },
        });
      });
      Then("no review callback was dispatched", () => {
        expect(response.status).toBe(201);
        expect(dispatchedUrls).toEqual([]);
      });
      And("no warning was logged", () => {
        expect(warnSpy).not.toHaveBeenCalled();
      });
    },
  );

  // ── Seed configuration is validated ──────────────────────────────────────

  Scenario(
    "A seed key naming no resource is rejected",
    ({ When, Then, And }) => {
      When(
        'I build a review mock seeding the key "petz" with an inline array',
        async () => {
          await captureBuildError({
            spec: crudPetSpec(),
            seed: { petz: [{ id: 1, name: "Typo" }] },
          });
        },
      );
      Then(
        'the review build fails with code "OPENAPI_UNKNOWN_SEED_RESOURCE"',
        () => {
          expect(buildError).toBeInstanceOf(SchmockError);
          expect(buildError).toMatchObject({
            code: "OPENAPI_UNKNOWN_SEED_RESOURCE",
          });
        },
      );
      And('the review build error lists the resource "pets"', () => {
        expect(buildError).toBeInstanceOf(Error);
        expect(String(buildError)).toContain('"pets"');
      });
    },
  );

  Scenario(
    "A count seed key naming no resource is rejected the same way",
    ({ When, Then }) => {
      When(
        'I build a review mock seeding the key "petz" with a count of 2',
        async () => {
          await captureBuildError({
            spec: crudPetSpec(),
            seed: { petz: { count: 2 } },
          });
        },
      );
      Then(
        'the review build fails with code "OPENAPI_UNKNOWN_SEED_RESOURCE"',
        () => {
          expect(buildError).toMatchObject({
            code: "OPENAPI_UNKNOWN_SEED_RESOURCE",
          });
        },
      );
    },
  );

  Scenario(
    "A numeric seed is rejected with a pointer to fakerSeed",
    ({ When, Then, And }) => {
      When("I build a review mock with a numeric seed of 42", async () => {
        // A JS caller, or a loosely typed config object, can hand openapi() a
        // number where TypeScript would demand a SeedConfig.
        const options: OpenApiOptions = { spec: crudPetSpec() };
        Reflect.set(options, "seed", 42);
        await captureBuildError(options);
      });
      Then('the review build fails with code "OPENAPI_INVALID_OPTION"', () => {
        expect(buildError).toMatchObject({ code: "OPENAPI_INVALID_OPTION" });
      });
      And('the review build error mentions "fakerSeed"', () => {
        expect(String(buildError)).toContain("fakerSeed");
      });
    },
  );

  Scenario("A seed entry of an unknown shape is rejected", ({ When, Then }) => {
    When(
      'I build a review mock seeding "pets" with a "counts" object',
      async () => {
        const seed: SeedConfig = {};
        Reflect.set(seed, "pets", { counts: 3 });
        await captureBuildError({ spec: crudPetSpec(), seed });
      },
    );
    Then('the review build fails with code "OPENAPI_INVALID_OPTION"', () => {
      expect(buildError).toMatchObject({ code: "OPENAPI_INVALID_OPTION" });
    });
  });

  Scenario(
    "A resources override key naming no resource is rejected",
    ({ When, Then, And }) => {
      When('I build a review mock overriding the resource "petz"', async () => {
        await captureBuildError({
          spec: crudPetSpec(),
          resources: { petz: { listFlat: true } },
        });
      });
      Then(
        'the review build fails with code "OPENAPI_UNKNOWN_RESOURCE_OVERRIDE"',
        () => {
          expect(buildError).toBeInstanceOf(SchmockError);
          expect(buildError).toMatchObject({
            code: "OPENAPI_UNKNOWN_RESOURCE_OVERRIDE",
            context: { key: "petz", resources: ["pets"] },
          });
        },
      );
      And('the review build error lists the resource "pets"', () => {
        expect(String(buildError)).toContain('"pets"');
      });
    },
  );

  Scenario(
    "A resources override keyed by a resource's pre-rename name points at its new name",
    ({ When, Then, And }) => {
      When(
        'I build a review mock of "/repos/{owner}/{repo}" overriding the resource ":owner"',
        async () => {
          await captureBuildError({
            spec: {
              openapi: "3.0.3",
              info: { title: "Repos", version: "1.0.0" },
              paths: {
                "/repos/{owner}/{repo}": {
                  get: {
                    responses: {
                      "200": { description: "Repo", content: petContent },
                    },
                  },
                  delete: { responses: { "204": { description: "Deleted" } } },
                },
              },
            },
            resources: {
              ":owner": { errorSchema: { type: "object" } },
            },
          });
        },
      );
      Then(
        'the review build fails with code "OPENAPI_UNKNOWN_RESOURCE_OVERRIDE"',
        () => {
          expect(buildError).toMatchObject({
            code: "OPENAPI_UNKNOWN_RESOURCE_OVERRIDE",
            context: { key: ":owner", resources: ["repos"] },
          });
        },
      );
      And('the review build error names "repos" as the key to use', () => {
        expect(String(buildError)).toContain('use "repos"');
      });
    },
  );

  // ── Create status selection ──────────────────────────────────────────────

  Scenario(
    "A create declaring both 201 and 200 answers 201",
    ({ Given, When, Then }) => {
      Given(
        "a review mock whose create declares both 201 and 200",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: crudPetSpec({ createAlsoDeclares200: true }),
            }),
          );
        },
      );
      When('I create a review pet named "Alice"', async () => {
        response = await mock.handle("POST", "/pets", {
          body: { name: "Alice" },
        });
      });
      Then("the review response status is 201", () => {
        expect(response.status).toBe(201);
      });
    },
  );

  // Type-level only: this file is compiled by `typecheck:bdd`
  // (tsconfig.tests.json), so a hand-mirrored type that drifts from the
  // ambient one fails the build. A `*.test.ts` file is never type-checked.
  Scenario(
    "The exported option types alias the ambient Schmock types",
    ({ Given, Then }) => {
      Given("the option types the openapi package exports", () => {});
      Then("each one is exactly the ambient Schmock type it names", () => {
        expectTypeOf<RefPolicy>().toEqualTypeOf<Schmock.OpenApiRefPolicy>();
        expectTypeOf<OpenApiRefPolicy>().toEqualTypeOf<Schmock.OpenApiRefPolicy>();
        expectTypeOf<SeedSource>().toEqualTypeOf<Schmock.SeedSource>();
        expectTypeOf<SeedConfig>().toEqualTypeOf<Schmock.SeedConfig>();
        expectTypeOf<OnSchemaCallback>().toEqualTypeOf<Schmock.OnSchemaCallback>();
        expectTypeOf<OnSchemaContext>().toEqualTypeOf<Schmock.OnSchemaContext>();
        expectTypeOf<ResourceOverride>().toEqualTypeOf<Schmock.ResourceOverride>();
        expectTypeOf<CrudOperationMeta>().toEqualTypeOf<Schmock.CrudOperationMeta>();
        expectTypeOf<
          NonNullable<Schmock.OpenApiOptions["onSchema"]>
        >().toEqualTypeOf<OnSchemaCallback>();
      });
    },
  );
});
