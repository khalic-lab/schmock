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

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;
  let responses: Schmock.Response[] = [];

  async function validatingMock(document: Record<string, unknown>) {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: document, validateResponses: true }));
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
});
