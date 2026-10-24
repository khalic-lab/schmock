import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import express from "express";
import request from "supertest";
import { expect } from "vitest";
import { toExpress } from "../../../express/src/index";
import { openapi } from "../plugin";

const feature = await loadFeature(
  "../../features/openapi-request-bodies.feature",
);

function uploadSpec(content: Record<string, unknown>) {
  return {
    openapi: "3.0.3",
    info: { title: "request bodies", version: "1.0.0" },
    paths: {
      "/uploads": {
        post: {
          requestBody: { required: true, content },
          responses: {
            "201": {
              description: "stored",
              content: {
                "application/json": { schema: { type: "object" } },
              },
            },
          },
        },
      },
    },
  };
}

const typedFormContent = {
  "application/x-www-form-urlencoded": {
    schema: {
      type: "object",
      properties: {
        qty: { type: "integer" },
        active: { type: "boolean" },
        price: { type: "number" },
      },
    },
  },
};

const URLENCODED = "application/x-www-form-urlencoded";

/**
 * A CRUD notes resource created from an urlencoded form whose `tags` must be
 * an array of at least two strings, so a form read as one value fails.
 */
function notesSpec(tagsEncoding?: Record<string, unknown>) {
  const note = {
    type: "object",
    properties: {
      noteId: { type: "integer" },
      tags: { type: "array", items: { type: "string" } },
    },
  };
  return {
    openapi: "3.0.3",
    info: { title: "notes", version: "1.0.0" },
    paths: {
      "/notes": {
        post: {
          requestBody: {
            required: true,
            content: {
              [URLENCODED]: {
                schema: {
                  type: "object",
                  required: ["tags"],
                  properties: {
                    tags: {
                      type: "array",
                      minItems: 2,
                      items: { type: "string" },
                    },
                  },
                },
                ...(tagsEncoding === undefined
                  ? {}
                  : { encoding: { tags: tagsEncoding } }),
              },
            },
          },
          responses: {
            "201": {
              description: "created",
              content: { "application/json": { schema: note } },
            },
          },
        },
      },
      "/notes/{noteId}": {
        get: {
          parameters: [
            {
              name: "noteId",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": {
              description: "one note",
              content: { "application/json": { schema: note } },
            },
          },
        },
      },
    },
  };
}

interface UploadResult {
  status: number;
  body: unknown;
}

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let result: UploadResult;

  async function validatingMock(content: Record<string, unknown>) {
    mock = schmock();
    mock.pipe(
      await openapi({ spec: uploadSpec(content), validateRequests: true }),
    );
  }

  async function interceptedPost(init: RequestInit): Promise<void> {
    const handle = mock.intercept({ passthrough: false });
    try {
      const response = await fetch("http://localhost/uploads", {
        method: "POST",
        ...init,
      });
      const text = await response.text();
      result = {
        status: response.status,
        body: text ? JSON.parse(text) : undefined,
      };
    } finally {
      handle.restore();
    }
  }

  function expectErrorAt(path: string) {
    expect(result.body).toMatchObject({
      code: "VALIDATION_ERROR",
      details: [expect.objectContaining({ path })],
    });
  }

  async function notesMock(tagsEncoding?: Record<string, unknown>) {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({ spec: notesSpec(tagsEncoding), validateRequests: true }),
    );
  }

  async function interceptedCreate(form: string): Promise<void> {
    const handle = mock.intercept({ passthrough: false });
    try {
      const response = await fetch("http://localhost/notes", {
        method: "POST",
        body: new URLSearchParams(form),
      });
      result = { status: response.status, body: await response.json() };
    } finally {
      handle.restore();
    }
  }

  async function expressCreate(form: string): Promise<void> {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(toExpress(mock));
    const response = await request(app).post("/notes").type("form").send(form);
    result = { status: response.status, body: response.body };
  }

  async function expectStoredTags(first: string, second: string) {
    expect(result.body).toMatchObject({ tags: [first, second] });
    const stored = await mock.handle("GET", "/notes/1");
    expect(stored.body).toEqual({ noteId: 1, tags: [first, second] });
  }

  Scenario(
    "A nullable binary upload schema accepts the bytes every transport delivers",
    ({ Given, When, Then }) => {
      Given(
        "a validating upload mock whose octet-stream body is a nullable binary string",
        async () => {
          await validatingMock({
            "application/octet-stream": {
              schema: { type: "string", format: "binary", nullable: true },
            },
          });
        },
      );

      When(
        'I post three bytes as "application/octet-stream" through the fetch interceptor',
        async () => {
          await interceptedPost({
            body: new Uint8Array([1, 2, 3]),
            headers: { "content-type": "application/octet-stream" },
          });
        },
      );

      Then("the upload response status is 201", () => {
        expect(result.status).toBe(201);
      });
    },
  );

  Scenario(
    "A multipart upload with a text field and a file is accepted",
    ({ Given, When, Then }) => {
      Given(
        "a validating upload mock whose multipart body requires a name and a binary file",
        async () => {
          await validatingMock({
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["name", "file"],
                properties: {
                  name: { type: "string" },
                  file: { type: "string", format: "binary" },
                },
              },
            },
          });
        },
      );

      When(
        "I post a multipart form with name {string} and a file through the fetch interceptor",
        async (_, name: string) => {
          const form = new FormData();
          form.append("name", name);
          form.append("file", new Blob([new Uint8Array([1, 2])]), "pet.bin");
          await interceptedPost({ body: form });
        },
      );

      Then("the upload response status is 201", () => {
        expect(result.status).toBe(201);
      });
    },
  );

  Scenario(
    "A multipart field that breaks its schema is rejected when nothing is required",
    ({ Given, When, Then, And }) => {
      Given(
        "a validating upload mock whose multipart body has an optional integer count",
        async () => {
          await validatingMock({
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: { count: { type: "integer" } },
              },
            },
          });
        },
      );

      When(
        "I post a multipart form with count {string} through the fetch interceptor",
        async (_, count: string) => {
          const form = new FormData();
          form.append("count", count);
          await interceptedPost({ body: form });
        },
      );

      Then("the upload response status is 400", () => {
        expect(result.status).toBe(400);
      });

      And("the upload validation error points at {string}", (_, path) => {
        expectErrorAt(path);
      });
    },
  );

  Scenario(
    "Typed urlencoded fields are read as the types their schema declares",
    ({ Given, When, Then }) => {
      Given(
        "a validating upload mock whose urlencoded body has integer, boolean and number fields",
        async () => {
          await validatingMock(typedFormContent);
        },
      );

      When(
        "I post the urlencoded form {string} through the fetch interceptor",
        async (_, form: string) => {
          await interceptedPost({ body: new URLSearchParams(form) });
        },
      );

      Then("the upload response status is 201", () => {
        expect(result.status).toBe(201);
      });
    },
  );

  Scenario(
    "An urlencoded integer field must be written in plain decimal notation",
    ({ Given, When, Then, And }) => {
      Given(
        "a validating upload mock whose urlencoded body has integer, boolean and number fields",
        async () => {
          await validatingMock(typedFormContent);
        },
      );

      When(
        "I post the urlencoded form {string} through the fetch interceptor",
        async (_, form: string) => {
          await interceptedPost({ body: new URLSearchParams(form) });
        },
      );

      Then("the upload response status is 400", () => {
        expect(result.status).toBe(400);
      });

      And("the upload validation error points at {string}", (_, path) => {
        expectErrorAt(path);
      });
    },
  );

  Scenario(
    "Bracketed urlencoded keys nest under the object property they name",
    ({ Given, When, Then }) => {
      Given(
        "a validating upload mock whose urlencoded body declares only a metadata object",
        async () => {
          await validatingMock({
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  metadata: {
                    type: "object",
                    additionalProperties: { type: "string" },
                  },
                },
              },
            },
          });
        },
      );

      When(
        "I post the urlencoded form {string} through the fetch interceptor",
        async (_, form: string) => {
          await interceptedPost({ body: new URLSearchParams(form) });
        },
      );

      Then("the upload response status is 201", () => {
        expect(result.status).toBe(201);
      });
    },
  );

  Scenario(
    "A repeated urlencoded name fills an array property through the fetch interceptor",
    ({ Given, When, Then, And }) => {
      Given(
        "a validating notes mock whose urlencoded tags are an array of at least two strings",
        async () => {
          await notesMock();
        },
      );

      When(
        "I create a note with the urlencoded form {string} through the fetch interceptor",
        async (_, form: string) => {
          await interceptedCreate(form);
        },
      );

      Then("the upload response status is 201", () => {
        expect(result.status).toBe(201);
      });

      And(
        "the stored note has the tags {string} and {string}",
        async (_, first: string, second: string) => {
          await expectStoredTags(first, second);
        },
      );
    },
  );

  Scenario(
    "A repeated urlencoded name fills an array property through Express",
    ({ Given, When, Then, And }) => {
      Given(
        "a validating notes mock whose urlencoded tags are an array of at least two strings",
        async () => {
          await notesMock();
        },
      );

      When(
        "I create a note with the urlencoded form {string} through Express",
        async (_, form: string) => {
          await expressCreate(form);
        },
      );

      Then("the upload response status is 201", () => {
        expect(result.status).toBe(201);
      });

      And(
        "the stored note has the tags {string} and {string}",
        async (_, first: string, second: string) => {
          await expectStoredTags(first, second);
        },
      );
    },
  );

  Scenario(
    "A comma-separated value fills an array property whose encoding does not explode",
    ({ Given, When, Then, And }) => {
      Given(
        "a validating notes mock whose urlencoded tags are encoded as form with explode false",
        async () => {
          await notesMock({ style: "form", explode: false });
        },
      );

      When(
        "I create a note with the urlencoded form {string} through the fetch interceptor",
        async (_, form: string) => {
          await interceptedCreate(form);
        },
      );

      Then("the upload response status is 201", () => {
        expect(result.status).toBe(201);
      });

      And(
        "the stored note has the tags {string} and {string}",
        async (_, first: string, second: string) => {
          await expectStoredTags(first, second);
        },
      );
    },
  );

  Scenario(
    "An XML body is not validated against its object schema",
    ({ Given, When, Then }) => {
      Given(
        "a validating upload mock whose XML body requires a name",
        async () => {
          await validatingMock({
            "application/xml": {
              schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" } },
              },
            },
          });
        },
      );

      When(
        "I post an XML pet named {string} through the fetch interceptor",
        async (_, name: string) => {
          await interceptedPost({
            body: `<pet><name>${name}</name></pet>`,
            headers: { "content-type": "application/xml" },
          });
        },
      );

      Then("the upload response status is 201", () => {
        expect(result.status).toBe(201);
      });
    },
  );
});
