import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/review-openapi-crud.feature");

const json = (schema: Record<string, unknown>) => ({
  "application/json": { schema },
});

function spec(paths: Record<string, unknown>) {
  return {
    openapi: "3.0.3",
    info: { title: "CRUD review", version: "1.0.0" },
    paths,
  };
}

// ── Prefer ──────────────────────────────────────────────────────────────────

const statusSpec = spec({
  "/status": {
    get: {
      responses: {
        "200": {
          description: "ok",
          content: json({
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean", enum: [true] } },
          }),
        },
        default: {
          description: "error",
          content: json({
            type: "object",
            required: ["message"],
            properties: { message: { type: "string" } },
          }),
        },
      },
    },
  },
});

// ── Item envelopes and delete confirmations ─────────────────────────────────

const pet = {
  type: "object",
  required: ["id", "name"],
  properties: { id: { type: "integer" }, name: { type: "string" } },
};

const petEnvelope = {
  type: "object",
  required: ["data"],
  properties: { data: pet },
};

const envelopedPetsSpec = spec({
  "/pets": {
    get: {
      responses: {
        "200": {
          description: "list",
          content: json({
            type: "object",
            required: ["data"],
            properties: { data: { type: "array", items: pet } },
          }),
        },
      },
    },
    post: {
      requestBody: { content: json(pet) },
      responses: {
        "201": { description: "created", content: json(petEnvelope) },
      },
    },
  },
  "/pets/{petId}": {
    get: {
      responses: { "200": { description: "pet", content: json(petEnvelope) } },
    },
    patch: {
      requestBody: { content: json(pet) },
      responses: {
        "200": { description: "patched", content: json(petEnvelope) },
      },
    },
    delete: {
      responses: {
        "200": { description: "deleted", content: json(petEnvelope) },
      },
    },
  },
});

const petsCollectionPath = envelopedPetsSpec.paths["/pets"];
const petItemPath = envelopedPetsSpec.paths["/pets/{petId}"];

/** The enveloped pets, with the item path declared before the collection. */
const itemFirstPetsSpec = spec({
  "/pets/{petId}": petItemPath,
  "/pets": petsCollectionPath,
});

/** The enveloped pets with no list GET: only the create on the collection. */
const unlistedPetsSpec = spec({
  "/pets": {
    post: {
      requestBody: { content: json(pet) },
      responses: {
        "201": { description: "created", content: json(petEnvelope) },
      },
    },
  },
  "/pets/{petId}": petItemPath,
});

const closedPet = { ...pet, additionalProperties: false };

const closedPetsSpec = spec({
  "/pets": {
    get: {
      responses: {
        "200": {
          description: "list",
          content: json({ type: "array", items: closedPet }),
        },
      },
    },
    post: {
      responses: {
        "201": { description: "created", content: json(closedPet) },
      },
    },
  },
  "/pets/{petId}": {
    get: {
      responses: { "200": { description: "pet", content: json(closedPet) } },
    },
    patch: {
      responses: {
        "200": { description: "patched", content: json(closedPet) },
      },
    },
  },
});

const widget = {
  type: "object",
  required: ["id", "object", "name"],
  properties: {
    id: { type: "string" },
    object: { type: "string", enum: ["widget"] },
    name: { type: "string" },
  },
};

const widgetsSpec = spec({
  "/widgets": {
    get: {
      responses: {
        "200": {
          description: "list",
          content: json({ type: "array", items: widget }),
        },
      },
    },
    post: {
      responses: { "200": { description: "created", content: json(widget) } },
    },
  },
  "/widgets/{id}": {
    get: {
      responses: { "200": { description: "widget", content: json(widget) } },
    },
    delete: {
      responses: {
        "200": {
          description: "deleted",
          content: json({
            type: "object",
            required: ["id", "object", "deleted"],
            properties: {
              id: { type: "string" },
              object: { type: "string", enum: ["widget"] },
              deleted: { type: "boolean", enum: [true] },
            },
          }),
        },
      },
    },
  },
});

// ── Composition-only create contracts ───────────────────────────────────────

const bankAccount = {
  type: "object",
  required: ["id", "object", "routing_number"],
  properties: {
    id: { type: "integer" },
    object: { type: "string", enum: ["bank_account"] },
    routing_number: { type: "string" },
  },
};

const card = {
  type: "object",
  required: ["id", "object", "last4"],
  properties: {
    id: { type: "integer" },
    object: { type: "string", enum: ["card"] },
    last4: { type: "string" },
  },
};

const source = { oneOf: [bankAccount, card] };

const sourcesSpec = spec({
  "/sources": {
    get: {
      responses: {
        "200": {
          description: "list",
          content: json({ type: "array", items: source }),
        },
      },
    },
    post: {
      responses: { "201": { description: "created", content: json(source) } },
    },
  },
});

// ── Singletons ──────────────────────────────────────────────────────────────

const dispute = {
  type: "object",
  required: ["id", "object", "amount", "balance_transactions"],
  properties: {
    id: { type: "string" },
    object: { type: "string", enum: ["dispute"] },
    amount: { type: "integer" },
    balance_transactions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "amount"],
        properties: { id: { type: "string" }, amount: { type: "integer" } },
      },
    },
  },
};

const disputeSpec = spec({
  "/charges/{charge}/dispute": {
    get: {
      responses: { "200": { description: "dispute", content: json(dispute) } },
    },
    post: {
      responses: { "200": { description: "dispute", content: json(dispute) } },
    },
  },
});

// ── Form bodies ─────────────────────────────────────────────────────────────

const storedPet = {
  type: "object",
  required: ["id", "name", "age"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    age: { type: "integer" },
  },
};

const multipartPetsSpec = spec({
  "/pets": {
    get: {
      responses: {
        "200": {
          description: "list",
          content: json({ type: "array", items: storedPet }),
        },
      },
    },
    post: {
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                age: { type: "integer" },
                photo: { type: "string", format: "binary" },
              },
            },
          },
        },
      },
      responses: {
        "201": { description: "created", content: json(storedPet) },
      },
    },
  },
  "/pets/{petId}": {
    get: {
      responses: { "200": { description: "pet", content: json(storedPet) } },
    },
  },
});

// ── onSchema on an enveloped create ─────────────────────────────────────────

const metaEnvelopeSpec = spec({
  "/pets": {
    get: {
      responses: {
        "200": {
          description: "list",
          content: json({
            type: "object",
            properties: { data: { type: "array", items: pet } },
          }),
        },
      },
    },
    post: {
      responses: {
        "201": {
          description: "created",
          content: json({
            type: "object",
            required: ["data", "meta"],
            properties: {
              data: pet,
              meta: {
                type: "object",
                required: ["v"],
                properties: { v: { type: "integer" } },
              },
            },
          }),
        },
      },
    },
  },
  "/pets/{petId}": {
    get: {
      responses: { "200": { description: "pet", content: json(pet) } },
    },
  },
});

// ── Resource list overrides ─────────────────────────────────────────────────

const user = {
  type: "object",
  required: ["id", "name"],
  properties: { id: { type: "integer" }, name: { type: "string" } },
};

const usersSpec = spec({
  "/users": {
    get: {
      responses: {
        "200": {
          description: "list",
          content: json({ type: "array", items: user }),
        },
      },
    },
    post: {
      responses: { "201": { description: "created", content: json(user) } },
    },
  },
  "/users/{id}": {
    get: {
      responses: { "200": { description: "user", content: json(user) } },
    },
  },
});

// ── Status-less schema overrides ────────────────────────────────────────────

const upsert = {
  type: "object",
  properties: { id: { type: "integer" }, old: { type: "string" } },
};

const upsertsSpec = spec({
  "/upserts": {
    get: {
      responses: {
        "200": {
          description: "list",
          content: json({ type: "array", items: upsert }),
        },
      },
    },
    post: {
      responses: {
        "200": { description: "existing", content: json(upsert) },
        "201": { description: "created", content: json(upsert) },
      },
    },
  },
  "/upserts/{id}": {
    get: {
      responses: { "200": { description: "upsert", content: json(upsert) } },
    },
  },
});

// ── Callbacks ───────────────────────────────────────────────────────────────

/** A POST /orders operation with one callback at `urlExpression`. */
function ordersSpec(urlExpression: string) {
  return spec({
    "/orders": {
      post: {
        requestBody: {
          content: json({
            type: "object",
            properties: { note: { type: "string" } },
          }),
        },
        responses: {
          "201": {
            description: "created",
            content: json({
              type: "object",
              required: ["id"],
              properties: { id: { type: "integer" } },
            }),
          },
        },
        callbacks: {
          orderPaid: {
            [urlExpression]: {
              post: { responses: { "200": { description: "ok" } } },
            },
          },
        },
      },
    },
  });
}

const petCallbackSpec = spec({
  "/pets": {
    get: {
      responses: {
        "200": {
          description: "list",
          content: json({ type: "array", items: pet }),
        },
      },
    },
    post: {
      responses: { "201": { description: "created", content: json(pet) } },
      callbacks: {
        petCreated: {
          "https://hooks.example/pets": {
            post: { responses: { "200": { description: "ok" } } },
          },
        },
      },
    },
  },
});

const patchCallbackSpec = spec({
  "/pets": {
    get: {
      responses: {
        "200": {
          description: "list",
          content: json({ type: "array", items: pet }),
        },
      },
    },
    post: {
      responses: { "201": { description: "created", content: json(pet) } },
    },
  },
  "/pets/{petId}": {
    patch: {
      responses: { "200": { description: "patched", content: json(pet) } },
      callbacks: {
        petUpdated: {
          "https://hooks.example/updated": {
            post: { responses: { "200": { description: "ok" } } },
          },
        },
      },
    },
  },
});

// ── The resource id in generated bodies ─────────────────────────────────────

/** A pets resource whose list GET answers exactly four pets. */
function examplePetsSpec(
  id: Record<string, unknown>,
  name: Record<string, unknown> = { type: "string" },
) {
  const examplePet = {
    type: "object",
    required: ["id", "name"],
    properties: { id, name },
  };
  return spec({
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "list",
            content: json({
              type: "array",
              minItems: 4,
              maxItems: 4,
              items: examplePet,
            }),
          },
        },
      },
      post: {
        requestBody: { content: json(examplePet) },
        responses: {
          "201": { description: "created", content: json(examplePet) },
        },
      },
    },
  });
}

const scalarGalaxyPath = `${import.meta.dirname}/../__fixtures__/scalar-galaxy.yaml`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The records of a list body: a flat array, or the array under `data`. */
function listEntries(body: unknown): Record<string, unknown>[] {
  const list = isRecord(body) ? body.data : body;
  expect(Array.isArray(list)).toBe(true);
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;
  let responses: Schmock.Response[] = [];

  let dispatched: Schmock.OpenApiCallbackRequest[] = [];

  function storedPets(): unknown {
    return mock.getState()["openapi:collections:/pets"] ?? [];
  }

  async function validatingMock(document: Record<string, unknown>) {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: document, validateResponses: true }));
  }

  async function callbackMock(urlExpression: string) {
    dispatched = [];
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: ordersSpec(urlExpression),
        callbacks: {
          dispatch: (request) => {
            dispatched.push(request);
          },
        },
      }),
    );
  }

  Scenario(
    "A Prefer code outside the HTTP status range falls through to the normal response",
    ({ Given, When, Then }) => {
      Given(
        "a status mock whose operation declares a 200 and a default response",
        async () => {
          mock = schmock();
          mock.pipe(await openapi({ spec: statusSpec }));
        },
      );

      When('I get the status with Prefer header "code=999"', async () => {
        response = await mock.handle("GET", "/status", {
          headers: { prefer: "code=999" },
        });
      });

      Then("the status response is 200 with the declared success body", () => {
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true });
      });
    },
  );

  Scenario(
    "Read, update and delete answer in the item envelope the spec declares",
    ({ Given, When, Then, And }) => {
      Given(
        'a validating pets mock whose item operations declare a "data" envelope',
        async () => {
          await validatingMock(envelopedPetsSpec);
        },
      );

      And('a pet named "rex" has been created', async () => {
        const created = await mock.handle("POST", "/pets", {
          body: { name: "rex" },
        });
        expect(created.status).toBe(201);
      });

      When('I read, patch to "max" and delete pet 1', async () => {
        responses = [
          await mock.handle("GET", "/pets/1"),
          await mock.handle("PATCH", "/pets/1", { body: { name: "max" } }),
          await mock.handle("DELETE", "/pets/1"),
        ];
      });

      Then('each item response is the pet wrapped under "data"', () => {
        expect(responses.map((r) => [r.status, r.body])).toEqual([
          [200, { data: { id: 1, name: "rex" } }],
          [200, { data: { id: 1, name: "max" } }],
          [200, { data: { id: 1, name: "max" } }],
        ]);
      });

      And("the pets list is empty afterwards", async () => {
        const list = await mock.handle("GET", "/pets");
        expect(list.body).toEqual({ data: [] });
      });
    },
  );

  for (const [title, given, document] of [
    [
      "A spec declaring the item path first stores what the item envelope wraps",
      'a validating pets mock whose item path is declared first and answers a "data" envelope',
      itemFirstPetsSpec,
    ],
    [
      "A spec without a list GET stores what the item envelope wraps",
      'a validating pets mock with no list GET whose item path answers a "data" envelope',
      unlistedPetsSpec,
    ],
  ] as const) {
    Scenario(title, ({ Given, When, Then, And }) => {
      Given(given, async () => {
        await validatingMock(document);
      });

      And('a pet named "rex" has been created', async () => {
        const created = await mock.handle("POST", "/pets", {
          body: { name: "rex" },
        });
        expect(created.status).toBe(201);
        expect(created.body).toEqual({ data: { id: 1, name: "rex" } });
      });

      When('I read, patch to "max" and delete pet 1', async () => {
        responses = [
          await mock.handle("GET", "/pets/1"),
          await mock.handle("PATCH", "/pets/1", { body: { name: "max" } }),
          await mock.handle("DELETE", "/pets/1"),
        ];
      });

      Then('each item response is the pet wrapped under "data"', () => {
        expect(responses.map((r) => [r.status, r.body])).toEqual([
          [200, { data: { id: 1, name: "rex" } }],
          [200, { data: { id: 1, name: "max" } }],
          [200, { data: { id: 1, name: "max" } }],
        ]);
      });
    });
  }

  Scenario(
    "A delete that declares a confirmation object answers it around the deleted row",
    ({ Given, When, Then, And }) => {
      Given(
        "a validating widgets mock whose DELETE declares an id, object and deleted confirmation",
        async () => {
          await validatingMock(widgetsSpec);
        },
      );

      And('a widget named "x" has been created', async () => {
        const created = await mock.handle("POST", "/widgets", {
          body: { name: "x" },
        });
        expect(created.status).toBe(200);
      });

      When("I delete widget 1", async () => {
        response = await mock.handle("DELETE", "/widgets/1");
      });

      Then(
        'the delete response is 200 with id "1", object "widget" and deleted true',
        () => {
          expect(response.status).toBe(200);
          expect(response.body).toEqual({
            id: "1",
            object: "widget",
            deleted: true,
          });
        },
      );
    },
  );

  Scenario(
    "An update drops a field its closed contract does not declare",
    ({ Given, When, Then, And }) => {
      Given(
        "a validating pets mock whose pet contract sets additionalProperties false",
        async () => {
          await validatingMock(closedPetsSpec);
        },
      );

      And('a pet named "rex" has been created', async () => {
        const created = await mock.handle("POST", "/pets", {
          body: { name: "rex" },
        });
        expect(created.status).toBe(201);
      });

      When(
        'I patch pet 1 with name "max" and an undeclared field',
        async () => {
          response = await mock.handle("PATCH", "/pets/1", {
            body: { name: "max", undeclared: "stored" },
          });
        },
      );

      Then(
        "the patch response is 200 with only the declared pet fields",
        () => {
          expect(response.status).toBe(200);
          expect(response.body).toEqual({ id: 1, name: "max" });
        },
      );

      And(
        "reading pet 1 answers 200 with only the declared pet fields",
        async () => {
          const read = await mock.handle("GET", "/pets/1");
          expect(read.status).toBe(200);
          expect(read.body).toEqual({ id: 1, name: "max" });
        },
      );
    },
  );

  Scenario(
    "A create whose contract is a oneOf of objects answers a generated branch",
    ({ Given, When, Then }) => {
      Given(
        "a validating sources mock whose create response is a oneOf of bank account and card",
        async () => {
          await validatingMock(sourcesSpec);
        },
      );

      When("I create a source with no body", async () => {
        response = await mock.handle("POST", "/sources");
      });

      Then(
        "the create response is 201 with id 1 and a bank account or card object",
        () => {
          expect(response.status).toBe(201);
          expect(response.body).toMatchObject({ id: 1 });
          const object = (response.body as Record<string, unknown>).object;
          expect(["bank_account", "card"]).toContain(object);
        },
      );
    },
  );

  Scenario(
    "A singleton whose item holds an array answers the declared item",
    ({ Given, When, Then }) => {
      Given(
        "a validating dispute mock with GET and POST on one path and a balance_transactions array",
        async () => {
          await validatingMock(disputeSpec);
        },
      );

      When("I create a dispute and then read it", async () => {
        const created = await mock.handle("POST", "/charges/ch_1/dispute", {
          body: { amount: 5 },
        });
        expect(created.status).toBe(200);
        response = await mock.handle("GET", "/charges/ch_1/dispute");
      });

      Then(
        "the dispute read is 200 with generated balance transactions, not the created dispute",
        () => {
          expect(response.status).toBe(200);
          const body = response.body as Record<string, unknown>;
          expect(body.object).toBe("dispute");
          const transactions = body.balance_transactions;
          expect(Array.isArray(transactions)).toBe(true);
          for (const row of transactions as unknown[]) {
            expect(row).not.toMatchObject({ object: "dispute" });
          }
        },
      );
    },
  );

  Scenario(
    "A multipart create stores its text fields, typed, and not its file",
    ({ Given, When, Then, And }) => {
      let created: { status: number; body: unknown };

      Given(
        "a validating pets mock whose create accepts a multipart name, age and photo",
        async () => {
          await validatingMock(multipartPetsSpec);
        },
      );

      When(
        'I post a multipart pet named "Rex" aged "3" with a photo through the fetch interceptor',
        async () => {
          const form = new FormData();
          form.append("name", "Rex");
          form.append("age", "3");
          form.append("photo", new Blob([new Uint8Array([1, 2, 3])]));
          const handle = mock.intercept({ passthrough: false });
          try {
            const res = await fetch("http://localhost/pets", {
              method: "POST",
              body: form,
            });
            created = { status: res.status, body: await res.json() };
          } finally {
            handle.restore();
          }
        },
      );

      Then(
        'the created pet is 201 with name "Rex" and age 3 and no photo',
        () => {
          expect(created).toEqual({
            status: 201,
            body: { id: 1, name: "Rex", age: 3 },
          });
        },
      );

      And("reading pet 1 answers the same pet", async () => {
        const read = await mock.handle("GET", "/pets/1");
        expect(read.body).toEqual({ id: 1, name: "Rex", age: 3 });
      });
    },
  );

  Scenario(
    "onSchema receives an enveloped create's whole response contract",
    ({ Given, When, Then, And }) => {
      const seen: string[] = [];

      Given(
        "a pets mock whose create answers a data and meta envelope, with an onSchema hook that rewrites meta",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: metaEnvelopeSpec,
              onSchema: (schema, context) => {
                if (context.method !== "POST") return undefined;
                seen.push(Object.keys(schema.properties ?? {}).join(","));
                return {
                  ...schema,
                  properties: {
                    ...schema.properties,
                    meta: {
                      type: "object",
                      required: ["traceId"],
                      properties: { traceId: { type: "string", const: "T-1" } },
                    },
                  },
                };
              },
            }),
          );
        },
      );

      When('I create a pet named "rex"', async () => {
        response = await mock.handle("POST", "/pets", {
          body: { name: "rex" },
        });
      });

      Then(
        'the hook saw the create contract with properties "data,meta"',
        () => {
          expect(seen).toEqual(["data,meta"]);
        },
      );

      And(
        'the created body carries the rewritten meta and the pet under "data"',
        () => {
          expect(response.status).toBe(201);
          expect(response.body).toEqual({
            data: { id: 1, name: "rex" },
            meta: { traceId: "T-1" },
          });
        },
      );
    },
  );

  Scenario(
    "A list override is validated against the shape it serves",
    ({ Given, When, Then, And }) => {
      Given(
        'a validating users mock whose flat list is overridden with listWrapProperty "data"',
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: usersSpec,
              validateResponses: true,
              resources: { users: { listWrapProperty: "data" } },
            }),
          );
        },
      );

      And('a user named "A" has been created', async () => {
        const created = await mock.handle("POST", "/users", {
          body: { name: "A" },
        });
        expect(created.status).toBe(201);
      });

      When("I list the users", async () => {
        response = await mock.handle("GET", "/users");
      });

      Then('the users list is 200 with the user under "data"', () => {
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: [{ id: 1, name: "A" }] });
      });
    },
  );

  Scenario(
    "A status-less schemas key patches the 201 an upsert-shaped create answers with",
    ({ Given, When, Then }) => {
      Given(
        'an upserts mock whose create declares 200 and 201, with a "POST /upserts" schemas override',
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: upsertsSpec,
              schemas: {
                "POST /upserts": {
                  type: "object",
                  required: ["patched"],
                  properties: {
                    id: { type: "integer" },
                    patched: { type: "boolean", const: true },
                  },
                },
              },
            }),
          );
        },
      );

      When("I create an upsert", async () => {
        response = await mock.handle("POST", "/upserts");
      });

      Then("the create response is 201 with the overridden body", () => {
        expect(response.status).toBe(201);
        expect(response.body).toMatchObject({ id: 1, patched: true });
      });
    },
  );

  Scenario(
    "A callback value spliced into a fixed URL stays inside its path segment",
    ({ Given, When, Then }) => {
      Given(
        'an orders mock whose callback URL is "https://hooks.example.com/orders/{$request.body#/note}/paid"',
        async () => {
          await callbackMock(
            "https://hooks.example.com/orders/{$request.body#/note}/paid",
          );
        },
      );

      When('I post an order whose note is "a/../../admin?x=1#"', async () => {
        response = await mock.handle("POST", "/orders", {
          body: { note: "a/../../admin?x=1#" },
        });
      });

      Then(
        'the callback is dispatched to a URL whose path starts with "/orders/" and ends with "/paid"',
        () => {
          expect(dispatched).toHaveLength(1);
          const url = new URL(dispatched[0].url);
          expect(url.pathname.startsWith("/orders/")).toBe(true);
          expect(url.pathname.endsWith("/paid")).toBe(true);
          expect(url.search).toBe("");
          expect(url.hash).toBe("");
        },
      );
    },
  );

  Scenario(
    "A dispatcher that edits its payload leaves the created row alone",
    ({ Given, When, Then, And }) => {
      const received: unknown[] = [];

      Given(
        "a pets mock whose create has a callback with no request body, and a dispatcher that edits its payload",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: petCallbackSpec,
              callbacks: {
                dispatch: (request) => {
                  received.push(structuredClone(request.body));
                  const payload = request.body as Record<string, unknown>;
                  payload.event = "pet.created";
                  delete payload.name;
                },
              },
            }),
          );
        },
      );

      When('I create a pet named "rex"', async () => {
        response = await mock.handle("POST", "/pets", {
          body: { name: "rex" },
        });
      });

      Then('the dispatcher received the pet named "rex"', () => {
        expect(received).toEqual([{ id: 1, name: "rex" }]);
      });

      And('the pets list holds the pet named "rex" unedited', async () => {
        expect(response.body).toEqual({ id: 1, name: "rex" });
        const list = await mock.handle("GET", "/pets");
        expect(list.body).toEqual([{ id: 1, name: "rex" }]);
      });
    },
  );

  Scenario(
    "A PATCH of a missing item dispatches no callback",
    ({ Given, When, Then, And }) => {
      Given(
        "a pets mock whose PATCH has a callback, with a recording dispatcher",
        async () => {
          dispatched = [];
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: patchCallbackSpec,
              callbacks: {
                dispatch: (request) => {
                  dispatched.push(request);
                },
              },
            }),
          );
        },
      );

      When("I patch pet 9, which does not exist", async () => {
        response = await mock.handle("PATCH", "/pets/9", {
          body: { name: "max" },
        });
      });

      Then("the patch response status is 404", () => {
        expect(response.status).toBe(404);
      });

      And("no callback was dispatched", () => {
        expect(dispatched).toEqual([]);
      });
    },
  );

  Scenario(
    "A dispatcher is handed the request's abort signal",
    ({ Given, When, Then, And }) => {
      let outcome: Promise<Schmock.Response>;
      let signal: AbortSignal | undefined;
      let dispatching: Promise<void>;

      Given(
        "a pets mock whose create has a callback, with a dispatcher that waits until its signal aborts",
        async () => {
          let entered: () => void = () => {};
          dispatching = new Promise((resolve) => {
            entered = resolve;
          });
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: petCallbackSpec,
              callbacks: {
                dispatch: (request) => {
                  signal = request.signal;
                  entered();
                  return new Promise<void>((resolve) => {
                    request.signal?.addEventListener("abort", () => resolve());
                  });
                },
              },
            }),
          );
        },
      );

      When(
        'I create a pet named "rex" and abort it while the dispatcher is pending',
        async () => {
          const controller = new AbortController();
          outcome = mock.handle("POST", "/pets", {
            body: { name: "rex" },
            signal: controller.signal,
          });
          // Settle the rejection now, so it is never reported as unhandled.
          outcome.catch(() => undefined);
          await dispatching;
          expect(signal?.aborted).toBe(false);
          controller.abort();
        },
      );

      Then("the create is rejected with an AbortError", async () => {
        await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
      });

      And("the dispatcher's signal has aborted", () => {
        expect(signal?.aborted).toBe(true);
      });
    },
  );

  Scenario(
    "A plugin piped after openapi that answers 500 leaves the collection unchanged",
    ({ Given, When, Then, And }) => {
      Given(
        "a pets mock with a create callback, and a plugin piped after it that answers every request with 500",
        async () => {
          dispatched = [];
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: petCallbackSpec,
              callbacks: {
                dispatch: (request) => {
                  dispatched.push(request);
                },
              },
            }),
          );
          mock.pipe({
            name: "downstream-500",
            process: (context) => ({
              context,
              response: [500, { error: "downstream" }],
            }),
          });
        },
      );

      When('I create a pet named "rex"', async () => {
        response = await mock.handle("POST", "/pets", {
          body: { name: "rex" },
        });
      });

      Then("the create response status is 500", () => {
        expect(response.status).toBe(500);
      });

      And("the pets collection is empty", () => {
        expect(storedPets()).toEqual([]);
      });

      And("no callback was dispatched", () => {
        expect(dispatched).toEqual([]);
      });
    },
  );

  Scenario(
    "A create aborted during its delay stores nothing",
    ({ Given, When, Then, And }) => {
      let outcome: Promise<Schmock.Response>;

      Given("a pets mock with a 1000 ms response delay", async () => {
        mock = schmock({ state: {}, delay: 1000 });
        mock.pipe(await openapi({ spec: petCallbackSpec }));
      });

      When(
        'I create a pet named "rex" and abort it during the delay',
        async () => {
          const controller = new AbortController();
          outcome = mock.handle("POST", "/pets", {
            body: { name: "rex" },
            signal: controller.signal,
          });
          // Settle the rejection now, so it is never reported as unhandled.
          outcome.catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 10));
          controller.abort();
        },
      );

      Then("the create is rejected with an AbortError", async () => {
        await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
      });

      And("the pets collection is empty", () => {
        expect(storedPets()).toEqual([]);
      });
    },
  );
  Scenario(
    "A dynamic Scalar Galaxy planet list has distinct ids",
    ({ Given, When, Then, And }) => {
      Given("the Scalar Galaxy mock with faker seed 42", async () => {
        mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec: scalarGalaxyPath, fakerSeed: 42 }));
      });

      When('I list the planets with Prefer header "dynamic=true"', async () => {
        response = await mock.handle("GET", "/planets", {
          headers: { prefer: "dynamic=true" },
        });
        expect(response.status).toBe(200);
      });

      Then("every planet has a different id", () => {
        const ids = listEntries(response.body).map((planet) => planet.id);
        expect(ids.length).toBeGreaterThan(1);
        expect(new Set(ids).size).toBe(ids.length);
      });

      And("every planet name is one of the spec's examples", () => {
        for (const planet of listEntries(response.body)) {
          expect(["Mars", "Jupiter", "HD 40307g"]).toContain(planet.name);
        }
      });
    },
  );

  Scenario(
    "A dynamic list takes no id from a 3.0 example but keeps the name example",
    ({ Given, When, Then, And }) => {
      Given(
        'a pets mock whose id declares the example 1 and whose name declares the example "Rex"',
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: examplePetsSpec(
                { type: "integer", example: 1 },
                { type: "string", example: "Rex" },
              ),
              fakerSeed: 7,
            }),
          );
        },
      );

      When('I list the pets with Prefer header "dynamic=true"', async () => {
        response = await mock.handle("GET", "/pets", {
          headers: { prefer: "dynamic=true" },
        });
        expect(response.status).toBe(200);
      });

      Then("the 4 listed pets have different ids", () => {
        const ids = listEntries(response.body).map((listed) => listed.id);
        expect(ids).toHaveLength(4);
        expect(new Set(ids).size).toBe(4);
      });

      And('every listed pet is named "Rex"', () => {
        expect(listEntries(response.body).map((listed) => listed.name)).toEqual(
          ["Rex", "Rex", "Rex", "Rex"],
        );
      });
    },
  );

  Scenario(
    "A default the spec declares on the id still pins it in a dynamic list",
    ({ Given, When, Then }) => {
      Given(
        "a pets mock whose id declares the default 5 and the example 1",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: examplePetsSpec({
                type: "integer",
                default: 5,
                example: 1,
              }),
            }),
          );
        },
      );

      When('I list the pets with Prefer header "dynamic=true"', async () => {
        response = await mock.handle("GET", "/pets", {
          headers: { prefer: "dynamic=true" },
        });
        expect(response.status).toBe(200);
      });

      Then("every listed pet has the id 5", () => {
        expect(listEntries(response.body).map((listed) => listed.id)).toEqual([
          5, 5, 5, 5,
        ]);
      });
    },
  );
});
