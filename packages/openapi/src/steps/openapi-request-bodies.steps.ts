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
});
