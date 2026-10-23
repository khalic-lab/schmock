import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
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
});
