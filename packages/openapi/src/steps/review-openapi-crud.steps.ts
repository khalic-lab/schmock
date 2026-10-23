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
});
