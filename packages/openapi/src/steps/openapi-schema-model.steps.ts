import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature(
  "../../features/openapi-schema-model.feature",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(schema: object) {
  return { "application/json": { schema } };
}

function specWith(
  paths: object,
  schemas: object = {},
  version = "3.0.3",
): Record<string, unknown> {
  return {
    openapi: version,
    info: { title: "Schema model", version: "1.0.0" },
    paths,
    components: { schemas },
  };
}

const reviewSpec = specWith(
  {
    "/reviews": {
      post: {
        requestBody: {
          required: true,
          content: json({
            type: "object",
            properties: {
              author: { $ref: "#/components/schemas/User" },
              reviewer: {
                $ref: "#/components/schemas/User",
                description: "The reviewer",
              },
            },
          }),
        },
        responses: { "201": { description: "Created" } },
      },
    },
  },
  {
    User: {
      type: "object",
      required: ["id", "name"],
      properties: {
        id: { type: "integer", readOnly: true },
        name: { type: "string" },
      },
    },
  },
  "3.1.0",
);

const timestampPet = { $ref: "#/components/schemas/Pet" };
const timestampPetsSpec = specWith(
  {
    "/pets": {
      post: {
        requestBody: { content: json(timestampPet) },
        responses: {
          "201": { description: "Created", content: json(timestampPet) },
        },
      },
      get: {
        responses: {
          "200": {
            description: "OK",
            content: json({ type: "array", items: timestampPet }),
          },
        },
      },
    },
  },
  {
    Timestamp: { type: "string", format: "date-time", readOnly: true },
    Pet: {
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        createdAt: { $ref: "#/components/schemas/Timestamp" },
        updatedAt: { $ref: "#/components/schemas/Timestamp" },
      },
    },
  },
);

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;

  async function build(options: Schmock.OpenApiOptions): Promise<void> {
    mock = schmock({ state: {} });
    mock.pipe(await openapi(options));
  }

  Scenario(
    "A described copy of a component drops its readOnly id from the request contract",
    ({ Given, When, Then }) => {
      Given(
        "a request-validating mock whose review body references User plainly and with a description",
        async () => {
          await build({ spec: reviewSpec, validateRequests: true });
        },
      );

      When(
        "I post a review whose author and reviewer carry only a name",
        async () => {
          response = await mock.handle("POST", "/reviews", {
            body: { author: { name: "Ada" }, reviewer: { name: "Grace" } },
          });
        },
      );

      Then("the review response has status 201", () => {
        expect(response.status).toBe(201);
      });
    },
  );

  Scenario(
    "Every property that references a shared readOnly component ignores client values",
    ({ Given, When, Then, And }) => {
      Given(
        "a pets mock whose createdAt and updatedAt reference one readOnly Timestamp component",
        async () => {
          await build({ spec: timestampPetsSpec });
        },
      );

      When(
        'I create a pet sending createdAt and updatedAt "1999-01-01T00:00:00Z"',
        async () => {
          response = await mock.handle("POST", "/pets", {
            body: {
              name: "Rex",
              createdAt: "1999-01-01T00:00:00Z",
              updatedAt: "1999-01-01T00:00:00Z",
            },
          });
        },
      );

      Then("the created pet has status 201", () => {
        expect(response.status).toBe(201);
      });

      And(
        'neither timestamp of the created pet is "1999-01-01T00:00:00Z"',
        () => {
          expect(isRecord(response.body)).toBe(true);
          const body = isRecord(response.body) ? response.body : {};
          expect(body.createdAt).not.toBe("1999-01-01T00:00:00Z");
          expect(body.updatedAt).not.toBe("1999-01-01T00:00:00Z");
        },
      );
    },
  );
});
